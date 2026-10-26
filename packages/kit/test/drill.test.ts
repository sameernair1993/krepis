import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MongoClient } from 'mongodb';
import { countersBetween, judge, latecomerResult, phase, recoveryTimes, settleAllowance, type CounterSample, type JudgeInput, type OpRecord } from '../src/drill/judge.ts';
import { redact, resolveScenarios } from '../src/drill/runner.ts';
import { defineDrill, formatDrillReport, runDrill, SCENARIO_NAMES, topologyOf, type DrillReport, type ScenarioResult } from '../src/drill/index.ts';

const sample = (t: number, received: number, successful: number, created = 0, rejected = 0, queued = 0): CounterSample => ({ t, received, successful, created, rejected, queued });
const zero = { logins: 0, failedLogins: 0, created: 0, rejected: 0, peakQueued: 0 };

function input(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    scenario: 'restart', tenants: 2, eligible: 2, recoveryMs: { t1: 1_000, t2: 2_000 },
    baseline: { ...zero, durationMs: 10_000 }, fault: { ...zero, durationMs: 5_000 }, settle: { ...zero }, settleMs: 10_000,
    total: { ...zero }, amplification: 0, budgets: {}, ...over,
  };
}

const verdict = (vs: ReturnType<typeof judge>, name: string) => vs.find((v) => v.name === name);

describe('drill: server counters', () => {
  it('attributes deltas to the later sample and splits failed from successful logins', () => {
    const s = [sample(0, 10, 10, 5), sample(1_000, 14, 12, 8, 1, 3), sample(2_000, 20, 12, 9, 1, 0)];
    assert.deepEqual(countersBetween(s, 0, 1_000), { logins: 2, failedLogins: 2, created: 3, rejected: 1, peakQueued: 3 });
    assert.deepEqual(countersBetween(s, 1_000, 2_000), { logins: 0, failedLogins: 6, created: 1, rejected: 0, peakQueued: 0 });
  });

  it('treats a decrease as a restart that counts from zero', () => {
    const s = [sample(0, 100, 100, 50), sample(1_000, 3, 2, 4)];
    assert.deepEqual(countersBetween(s, 0, 1_000), { logins: 2, failedLogins: 1, created: 4, rejected: 0, peakQueued: 0 });
  });

  it('counts operations by when they ended', () => {
    const ops: OpRecord[] = [{ tenant: 'a', start: 0, end: 500, ok: true }, { tenant: 'a', start: 900, end: 1_500, ok: false }];
    const p = phase([sample(0, 0, 0)], ops, 0, 1_000);
    assert.equal(p.opsOk, 1);
    assert.equal(p.opsFailed, 0);
    assert.equal(p.durationMs, 1_000);
  });
});

describe('drill: recovery', () => {
  const ops: OpRecord[] = [
    { tenant: 'a', start: 100, end: 200, ok: true },
    { tenant: 'b', start: 100, end: 200, ok: true },
    { tenant: 'a', start: 4_000, end: 6_500, ok: true }, // started before the heal: not evidence of recovery
    { tenant: 'a', start: 5_100, end: 5_900, ok: true },
    { tenant: 'b', start: 5_100, end: 5_300, ok: false },
    { tenant: 'c', start: 100, end: 200, ok: true },
    { tenant: 'c', start: 4_900, end: 5_200, ok: true }, // in flight across the heal: the server it reached was the faulty one
  ];

  it('needs an operation started after the heal, and is measured from the heal', () => {
    const r = recoveryTimes(ops, ['a', 'b', 'c'], 0, 1_000, 5_000);
    assert.deepEqual(r.eligible, ['a', 'b', 'c']);
    assert.deepEqual(r.recoveryMs, { a: 900, b: null, c: null });
  });

  it('excludes tenants that never worked during warm-up', () => {
    assert.deepEqual(recoveryTimes(ops, ['a', 'b', 'c'], 0, 50, 5_000).eligible, []);
  });
});

describe('drill: latecomers', () => {
  it('times each latecomer from its arrival to its first success, counting the failures before it', () => {
    const ops: OpRecord[] = [
      { tenant: 'late1', start: 3_000, end: 3_400, ok: false },
      { tenant: 'late1', start: 4_000, end: 4_600, ok: true },
      { tenant: 'late1', start: 5_000, end: 5_100, ok: false },
      { tenant: 'late2', start: 3_000, end: 3_100, ok: true },
      { tenant: 'late3', start: 3_000, end: 9_000, ok: false },
    ];
    assert.deepEqual(latecomerResult(ops, ['late1', 'late2', 'late3'], 3_000, 0), {
      arrivedAtMs: 3_000,
      tenants: { late1: { firstOkMs: 1_600, failedBefore: 1 }, late2: { firstOkMs: 100, failedBefore: 0 }, late3: { firstOkMs: null, failedBefore: 1 } },
    });
  });

  it('orders by completion, not start, so a slow failure does not hide an earlier success', () => {
    const ops: OpRecord[] = [{ tenant: 'late1', start: 3_000, end: 9_000, ok: false }, { tenant: 'late1', start: 4_000, end: 4_200, ok: true }];
    assert.deepEqual(latecomerResult(ops, ['late1'], 3_000, 1_000).tenants, { late1: { firstOkMs: 1_200, failedBefore: 0 } });
  });
});

describe('drill: verdicts', () => {
  it('passes a scenario that recovered and went quiet', () => {
    const vs = judge(input());
    assert.deepEqual(vs.map((v) => [v.name, v.pass]), [['recovered', true], ['settled', true]]);
  });

  it('fails recovery when a tenant never succeeds again or is too slow', () => {
    assert.equal(verdict(judge(input({ recoveryMs: { t1: 1_000, t2: null } })), 'recovered')!.pass, false);
    assert.equal(verdict(judge(input({ recoveryMs: { t1: 1_000, t2: 31_000 } })), 'recovered')!.pass, false);
    assert.equal(verdict(judge(input({ recoveryMs: { t1: 1_000, t2: 31_000 }, budgets: { recoveryMs: 40_000 } })), 'recovered')!.pass, true);
  });

  it('cannot pass recovery with nobody eligible', () => {
    const r = verdict(judge(input({ eligible: 0, recoveryMs: {} })), 'recovered')!;
    assert.equal(r.pass, false);
    assert.match(r.detail, /warm-up/);
  });

  it('fails settled on any failed login, or on logins above twice the baseline rate', () => {
    assert.equal(verdict(judge(input({ settle: { ...zero, failedLogins: 1 } })), 'settled')!.pass, false);
    assert.equal(settleAllowance(0, 10_000, 10_000), 2);
    assert.equal(settleAllowance(10, 10_000, 10_000), 22);
    assert.equal(verdict(judge(input({ baseline: { ...zero, logins: 10, durationMs: 10_000 }, settle: { ...zero, logins: 22 } })), 'settled')!.pass, true);
    assert.equal(verdict(judge(input({ baseline: { ...zero, logins: 10, durationMs: 10_000 }, settle: { ...zero, logins: 23 } })), 'settled')!.pass, false);
  });

  it('judges idleness per tenant per minute, only for the idle scenario', () => {
    const idle = (logins: number) => verdict(judge(input({ scenario: 'idle', tenants: 10, fault: { ...zero, logins, durationMs: 90_000 } })), 'quiet')!;
    assert.equal(idle(15).pass, true);
    assert.equal(idle(16).pass, false);
    assert.equal(verdict(judge(input({ fault: { ...zero, logins: 99, durationMs: 90_000 } })), 'quiet'), undefined);
  });

  it('applies user budgets only when set', () => {
    const vs = judge(input({ total: { ...zero, failedLogins: 5, logins: 50, created: 60 }, amplification: 1, budgets: { maxFailedLogins: 4, maxLogins: 50, maxConnectionsCreated: 59, noAmplification: true } }));
    assert.deepEqual(vs.slice(2).map((v) => [v.name, v.pass]), [['maxFailedLogins', false], ['maxLogins', true], ['maxConnectionsCreated', false], ['noAmplification', false]]);
  });
});

describe('drill: config', () => {
  it('fills scenario defaults and keeps overrides', () => {
    const s = resolveScenarios({ setup: () => ({ client: () => 0, close: () => {} }), scenarios: ['idle', { name: 'slow-node', blockMs: 100 }] });
    assert.equal(s[0]!.durationMs, 90_000);
    assert.deepEqual([s[1]!.durationMs, s[1]!.blockMs], [20_000, 100]);
  });

  it('defaults to every scenario, filters with only, and rejects unknown names', () => {
    const config = { setup: () => ({ client: () => 0, close: () => {} }) };
    assert.deepEqual(resolveScenarios(config).map((s) => s.name), ['credential-rotation', 'auth-outage', 'restart', 'slow-node', 'overload', 'overload-keep', 'network-blip', 'idle', 'stepdown', 'primary-crash', 'rolling-restart']);
    assert.deepEqual(resolveScenarios(config, ['idle', 'restart']).map((s) => s.name), ['restart', 'idle']);
    assert.throws(() => resolveScenarios(config, ['reboot']), /unknown drill scenario "reboot"/);
    assert.throws(() => resolveScenarios({ ...config, scenarios: ['restart'] }, ['idle']), /none of idle/);
  });

  it('puts the replica-set faults on their own topology', () => {
    assert.deepEqual(SCENARIO_NAMES.filter((n) => topologyOf(n) === 'replicaSet'), ['stepdown', 'primary-crash', 'rolling-restart']);
    assert.equal(topologyOf('restart'), 'standalone');
  });

  it('defineDrill is the identity', () => {
    const config = { setup: () => ({ client: () => 0, close: () => {} }) };
    assert.equal(defineDrill(config), config);
  });

  it('rejects a latecomer count that is not a whole number', async () => {
    const config = { setup: () => ({ client: () => 0, close: () => {} }) };
    await assert.rejects(runDrill({ ...config, latecomers: -1 }), /`latecomers` must be a whole number/);
    await assert.rejects(runDrill({ ...config, latecomers: 1.5 }), /`latecomers` must be a whole number/);
  });

  it('redacts secrets, raw and URI-encoded', () => {
    assert.equal(redact('mongodb://u:a%2Fb@h and a/b', ['a/b']), 'mongodb://u:***@h and ***');
  });
});

describe('drill: report', () => {
  const scenario = (over: Partial<ScenarioResult>): ScenarioResult => ({
    name: 'restart', topology: 'standalone', pass: true, verdicts: [], recovered: 2, eligible: 2, recoveryMs: {}, slowestRecoveryMs: 1_500, findings: [], dumps: [], clients: 2,
    phases: { baseline: { ...zero, opsOk: 1, opsFailed: 0, durationMs: 1 }, fault: { ...zero, logins: 3, opsOk: 0, opsFailed: 0, durationMs: 1 }, recovery: { ...zero, opsOk: 0, opsFailed: 0, durationMs: 1 }, settle: { ...zero } },
    ...over,
  });

  it('tabulates scenarios, summarises findings by rule and mechanism, and lists failing verdicts', () => {
    const finding = (client: string, phaseName: 'baseline' | 'fault') => ({
      phase: phaseName, atMs: 0,
      finding: { rule: 'KR-I001' as const, severity: 'error' as const, title: '', message: '', fix: '', client, evidence: { mechanism: 'auth-failure' } },
    });
    const report: DrillReport = {
      pass: false, image: 'mongo:8.0', tenants: 2, rateLimitPerSec: 15, durationMs: 61_000,
      scenarios: [
        scenario({}),
        scenario({
          name: 'stepdown', topology: 'replicaSet', primary: { before: '127.0.0.1:41001', after: '127.0.0.1:41003', electedAfterMs: 2_300 },
          latecomers: { arrivedAtMs: 3_000, tenants: { late1: { firstOkMs: 120, failedBefore: 0 }, late2: { firstOkMs: 2_400, failedBefore: 2 }, late3: { firstOkMs: null, failedBefore: 4 } } },
        }),
        scenario({
          name: 'credential-rotation', pass: false, recovered: 0, slowestRecoveryMs: null,
          verdicts: [{ name: 'recovered', pass: false, detail: '0/2 tenants' }, { name: 'settled', pass: true, detail: 'ok' }],
          findings: [finding('*', 'fault'), finding('t1', 'fault'), finding('t2', 'fault'), finding('t1', 'baseline')],
        }),
      ],
    };
    const text = formatDrillReport(report);
    assert.match(text, /restart\s+PASS\s+2\/2\s+1\.5 s\s+0\/3\/0/);
    assert.match(text, /credential-rotation\s+FAIL\s+0\/2\s+—/);
    assert.match(text, /KR-I001 auth-failure fleet, KR-I001 auth-failure ×2/);
    assert.match(text, /✗ credential-rotation · recovered: 0\/2 tenants/);
    assert.doesNotMatch(text, /settled: ok/);
    assert.match(text, /stepdown · primary 127\.0\.0\.1:41001 → 127\.0\.0\.1:41003, writable 2\.3 s after the fault began/);
    assert.match(text, /stepdown · latecomers arrived 3\.0 s into the fault; first success after 0\.1 s, 2\.4 s, never \(6 operations failed first\)/);
    assert.doesNotMatch(text, /restart · latecomers/);
    assert.match(text, /FAIL: 2\/3 scenarios in 61 s/);
  });
});

// Live: needs docker. About a minute; run with KREPIS_DRILL_DOCKER=1.
describe('drill: live', { skip: process.env['KREPIS_DRILL_DOCKER'] !== '1' }, () => {
  it('fails a client that never re-reads credentials and passes it through a network blip', async () => {
    let seen: { tenants: string[]; latecomers: string[] } | undefined;
    const drill = defineDrill<MongoClient>({
      tenants: 2,
      timing: { baselineMs: 4_000, recoveryMs: 8_000, settleMs: 4_000, opTimeoutMs: 5_000 },
      scenarios: [{ name: 'network-blip', durationMs: 2_000 }, { name: 'credential-rotation', propagationMs: 3_000 }],
      setup(ctx) {
        seen = { tenants: [...ctx.tenants], latecomers: [...ctx.latecomers] };
        const cache = new Map<string, MongoClient>();
        return {
          client(t) {
            let c = cache.get(t);
            if (!c) cache.set(t, (c = new MongoClient(ctx.uri(t), { minPoolSize: 1, serverSelectionTimeoutMS: 3_000 })));
            return c;
          },
          close: () => Promise.all([...cache.values()].map((c) => c.close())),
        };
      },
    });
    const report = await runDrill(drill);
    const [blip, rotation] = report.scenarios;
    assert.equal(blip!.pass, true, JSON.stringify(blip!.verdicts));
    assert.equal(blip!.clients, 2 + 3);
    // A setup that warms ctx.tenants must not warm the latecomers, or they stop measuring a cold arrival.
    assert.equal(seen!.tenants.length, 2);
    assert.deepEqual(seen!.latecomers, ['late1', 'late2', 'late3']);
    assert.deepEqual(Object.keys(blip!.latecomers!.tenants), ['late1', 'late2', 'late3']);
    assert.ok(Object.values(blip!.latecomers!.tenants).every((l) => l.firstOkMs !== null), JSON.stringify(blip!.latecomers));
    assert.equal(rotation!.pass, false);
    assert.equal(rotation!.recovered, 0);
    assert.ok(rotation!.phases.fault.failedLogins + rotation!.phases.recovery.failedLogins > 0);
    assert.equal(report.pass, false);
  });

  it('runs replica-set faults on their own rig, after the standalone ones, and records the election', async () => {
    const drill = defineDrill<MongoClient>({
      tenants: 2,
      timing: { baselineMs: 4_000, recoveryMs: 8_000, settleMs: 4_000, opTimeoutMs: 5_000 },
      scenarios: ['stepdown', { name: 'network-blip', durationMs: 2_000 }],
      setup(ctx) {
        const cache = new Map<string, MongoClient>();
        return {
          client(t) {
            let c = cache.get(t);
            if (!c) cache.set(t, (c = new MongoClient(ctx.uri(t), { minPoolSize: 1, serverSelectionTimeoutMS: 5_000 })));
            return c;
          },
          close: () => Promise.all([...cache.values()].map((c) => c.close())),
        };
      },
    });
    const report = await runDrill(drill);
    assert.deepEqual(report.scenarios.map((r) => [r.name, r.topology]), [['network-blip', 'standalone'], ['stepdown', 'replicaSet']]);
    const stepdown = report.scenarios[1]!;
    assert.equal(stepdown.pass, true, JSON.stringify(stepdown.verdicts));
    assert.ok(stepdown.primary && stepdown.primary.before !== stepdown.primary.after, JSON.stringify(stepdown.primary));
    assert.equal(stepdown.phases.fault.failedLogins + stepdown.phases.recovery.failedLogins, 0);
    assert.ok(stepdown.latecomers && stepdown.latecomers.arrivedAtMs >= 3_000, JSON.stringify(stepdown.latecomers));
    assert.ok(Object.values(stepdown.latecomers.tenants).every((l) => l.firstOkMs !== null), JSON.stringify(stepdown.latecomers));
  });
});
