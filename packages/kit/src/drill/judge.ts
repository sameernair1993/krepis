import type { DrillBudgets, LatecomerResult, PhaseResult, ServerCounters, Verdict } from './types.ts';

/** One `serverStatus` reading. Counters are cumulative since the server started. */
export interface CounterSample {
  t: number;
  received: number;
  successful: number;
  created: number;
  rejected: number;
  queued: number;
}

export interface OpRecord {
  tenant: string;
  start: number;
  end: number;
  ok: boolean;
}

/** Δ of a cumulative counter; a decrease means the server restarted and counts from zero again. */
const delta = (prev: number, next: number): number => (next >= prev ? next - prev : next);

/** Server activity between consecutive samples, attributed to the later sample's time, for samples in (from, to]. */
export function countersBetween(samples: readonly CounterSample[], from: number, to: number): ServerCounters {
  const out: ServerCounters = { logins: 0, failedLogins: 0, created: 0, rejected: 0, peakQueued: 0 };
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.t <= from || s.t > to) continue;
    const p = samples[i - 1]!;
    const received = delta(p.received, s.received);
    const successful = delta(p.successful, s.successful);
    out.logins += successful;
    out.failedLogins += Math.max(0, received - successful);
    out.created += delta(p.created, s.created);
    out.rejected += delta(p.rejected, s.rejected);
    out.peakQueued = Math.max(out.peakQueued, s.queued);
  }
  return out;
}

export function phase(samples: readonly CounterSample[], ops: readonly OpRecord[], from: number, to: number): PhaseResult {
  let opsOk = 0;
  let opsFailed = 0;
  for (const o of ops) {
    if (o.end <= from || o.end > to) continue;
    if (o.ok) opsOk++;
    else opsFailed++;
  }
  return { ...countersBetween(samples, from, to), opsOk, opsFailed, durationMs: Math.max(0, Math.round(to - from)) };
}

/** Per tenant: ms from the heal to the end of the first successful operation started at or after it. */
/** Per latecomer, the first operation to complete successfully after its arrival, and the failures that completed before it. */
export function latecomerResult(ops: readonly OpRecord[], keys: readonly string[], arrivedAt: number, faultAt: number): LatecomerResult {
  const tenants: LatecomerResult['tenants'] = {};
  for (const key of keys) {
    const mine = ops.filter((o) => o.tenant === key && o.start >= arrivedAt).sort((a, b) => a.end - b.end);
    const first = mine.find((o) => o.ok);
    tenants[key] = {
      firstOkMs: first ? first.end - arrivedAt : null,
      failedBefore: mine.filter((o) => !o.ok && (!first || o.end <= first.end)).length,
    };
  }
  return { arrivedAtMs: arrivedAt - faultAt, tenants };
}

export function recoveryTimes(ops: readonly OpRecord[], tenants: readonly string[], warmFrom: number, faultAt: number, healAt: number): {
  eligible: string[];
  recoveryMs: Record<string, number | null>;
} {
  const eligible = new Set<string>();
  const first = new Map<string, number>();
  for (const o of ops) {
    if (!o.ok) continue;
    if (o.end > warmFrom && o.end <= faultAt) eligible.add(o.tenant);
    if (o.start >= healAt) {
      const ms = o.end - healAt;
      const prev = first.get(o.tenant);
      if (prev === undefined || ms < prev) first.set(o.tenant, ms);
    }
  }
  const recoveryMs: Record<string, number | null> = {};
  for (const t of tenants) if (eligible.has(t)) recoveryMs[t] = first.has(t) ? Math.round(first.get(t)!) : null;
  return { eligible: tenants.filter((t) => eligible.has(t)), recoveryMs };
}

export interface JudgeInput {
  scenario: string;
  tenants: number;
  eligible: number;
  recoveryMs: Record<string, number | null>;
  baseline: ServerCounters & { durationMs: number };
  fault: ServerCounters & { durationMs: number };
  settle: ServerCounters;
  settleMs: number;
  total: ServerCounters;
  amplification: number;
  budgets: DrillBudgets;
}

export const DEFAULT_RECOVERY_BUDGET_MS = 30_000;
export const DEFAULT_IDLE_LOGINS_PER_TENANT_PER_MINUTE = 1;

/** Logins the settle window may contain: twice the baseline rate, plus 2 for the drill's own connection. */
export function settleAllowance(baselineLogins: number, baselineMs: number, settleMs: number): number {
  const rate = baselineMs > 0 ? baselineLogins / baselineMs : 0;
  return Math.floor(2 * rate * settleMs) + 2;
}

export function judge(i: JudgeInput): Verdict[] {
  const verdicts: Verdict[] = [];
  const budgetMs = i.budgets.recoveryMs ?? DEFAULT_RECOVERY_BUDGET_MS;
  const times = Object.values(i.recoveryMs);
  const recovered = times.filter((ms) => ms !== null && ms <= budgetMs).length;
  verdicts.push({
    name: 'recovered',
    pass: i.eligible > 0 && recovered === i.eligible,
    detail: i.eligible === 0
      ? 'no tenant completed an operation during warm-up, so recovery cannot be judged'
      : `${recovered}/${i.eligible} tenants completed an operation within ${budgetMs / 1000} s of the heal`,
  });

  const allowed = settleAllowance(i.baseline.logins, i.baseline.durationMs, i.settleMs);
  const settled = i.settle.failedLogins === 0 && i.settle.logins <= allowed;
  verdicts.push({
    name: 'settled',
    pass: settled,
    detail: `last ${i.settleMs / 1000} s of recovery: ${i.settle.failedLogins} failed logins (allowed 0), ${i.settle.logins} logins (allowed ${allowed})`,
  });

  if (i.scenario === 'idle') {
    const perMin = i.budgets.idleLoginsPerTenantPerMinute ?? DEFAULT_IDLE_LOGINS_PER_TENANT_PER_MINUTE;
    const cap = Math.floor(perMin * i.tenants * (i.fault.durationMs / 60_000));
    verdicts.push({
      name: 'quiet',
      pass: i.fault.logins <= cap,
      detail: `${i.fault.logins} logins while idle for ${Math.round(i.fault.durationMs / 1000)} s (allowed ${cap}: ${perMin}/tenant/min)`,
    });
  }

  const cap = (name: 'maxFailedLogins' | 'maxLogins' | 'maxConnectionsCreated', value: number, what: string) => {
    const limit = i.budgets[name];
    if (limit === undefined) return;
    verdicts.push({ name, pass: value <= limit, detail: `${value} ${what} (budget ${limit})` });
  };
  cap('maxFailedLogins', i.total.failedLogins, 'failed logins');
  cap('maxLogins', i.total.logins, 'logins');
  cap('maxConnectionsCreated', i.total.created, 'connections created');
  if (i.budgets.noAmplification) {
    verdicts.push({ name: 'noAmplification', pass: i.amplification === 0, detail: `${i.amplification} KR-I001 findings during fault or recovery` });
  }
  return verdicts;
}
