import { join } from 'node:path';
import { IncidentMonitor, type ConnectionFinding, type WatchableClient } from '@sameernair/krepis/connections';
import { countersBetween, judge, latecomerResult, phase, recoveryTimes, type CounterSample, type OpRecord } from './judge.ts';
import { DockerReplicaSet, DockerServer, secret, sleep } from './rig.ts';
import {
  REPLICA_SET_SCENARIOS,
  SCENARIO_NAMES,
  type DrillTopology,
  type DrillConfig,
  type DrillContext,
  type DrillFinding,
  type DrillReport,
  type RunDrillOptions,
  type ScenarioName,
  type ScenarioResult,
  type ScenarioSpec,
} from './types.ts';

/** Identity helper that types a drill config file. */
export function defineDrill<C>(config: DrillConfig<C>): DrillConfig<C> {
  return config;
}

const DATABASE = 'krepis_drill';
const MAX_IN_FLIGHT = 20;
/** The start of warm-up is connection setup, not steady state, so it is left out of the baseline. */
const WARMUP_EXCLUDED_MS = 5_000;

const DEFAULT_SCENARIO: Record<ScenarioName, Required<Omit<ScenarioSpec, 'name'>>> = {
  'credential-rotation': { propagationMs: 15_000, durationMs: 0, blockMs: 0 },
  'auth-outage': { propagationMs: 0, durationMs: 20_000, blockMs: 0 },
  restart: { propagationMs: 0, durationMs: 0, blockMs: 0 },
  'slow-node': { propagationMs: 0, durationMs: 20_000, blockMs: 5_000 },
  overload: { propagationMs: 0, durationMs: 20_000, blockMs: 0 },
  'overload-keep': { propagationMs: 0, durationMs: 20_000, blockMs: 0 },
  'network-blip': { propagationMs: 0, durationMs: 5_000, blockMs: 0 },
  idle: { propagationMs: 0, durationMs: 90_000, blockMs: 0 },
  stepdown: { propagationMs: 0, durationMs: 0, blockMs: 0 },
  'primary-crash': { propagationMs: 0, durationMs: 0, blockMs: 0 },
  'rolling-restart': { propagationMs: 0, durationMs: 0, blockMs: 0 },
};

type DrillServer = DockerServer | DockerReplicaSet;

export function topologyOf(name: ScenarioName): DrillTopology {
  return REPLICA_SET_SCENARIOS.includes(name) ? 'replicaSet' : 'standalone';
}

export function resolveScenarios(config: DrillConfig<unknown>, only?: readonly string[]): Required<ScenarioSpec>[] {
  const specs = (config.scenarios ?? SCENARIO_NAMES).map((s) => (typeof s === 'string' ? { name: s } : s));
  for (const s of specs) if (!SCENARIO_NAMES.includes(s.name)) throw new Error(`unknown drill scenario "${s.name}" (known: ${SCENARIO_NAMES.join(', ')})`);
  if (only) for (const n of only) if (!SCENARIO_NAMES.includes(n as ScenarioName)) throw new Error(`unknown drill scenario "${n}" (known: ${SCENARIO_NAMES.join(', ')})`);
  const picked = only ? specs.filter((s) => only.includes(s.name)) : specs;
  if (only && picked.length === 0) throw new Error(`none of ${only.join(', ')} is in the config's scenarios`);
  return picked.map((s) => ({ ...DEFAULT_SCENARIO[s.name], ...s }) as Required<ScenarioSpec>);
}

function defaultClientOf(value: unknown): WatchableClient | undefined {
  const v = value as { getClient?: () => unknown; on?: unknown; connect?: unknown; client?: { on?: unknown } } | null;
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.getClient === 'function') return defaultClientOf(v.getClient());
  if (typeof v.on === 'function' && typeof v.connect === 'function') return v as unknown as WatchableClient;
  if (v.client && typeof v.client.on === 'function') return v.client as unknown as WatchableClient;
  return undefined;
}

function defaultOp(client: unknown, _tenant: string, ctx: DrillContext): Promise<unknown> {
  const c = client as { db?: (name: string) => unknown; collection?: unknown };
  const db = (typeof c?.db === 'function' ? c.db(ctx.database) : c) as { collection?: (n: string) => { findOne(q: object): Promise<unknown> } };
  if (typeof db?.collection !== 'function') throw new Error('krepis drill: the default op needs a MongoClient or Db; pass `op` in the drill config.');
  return db.collection('drill').findOne({});
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('krepis drill: operation timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('***').split(encodeURIComponent(s)).join('***');
  }
  return out;
}

interface Tenant {
  key: string;
  user: string;
  published: string;
  inFlight: number;
}

export async function runDrill<C>(config: DrillConfig<C>, options: RunDrillOptions = {}): Promise<DrillReport> {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const scenarios = resolveScenarios(config as DrillConfig<unknown>, options.only);
  const tenantCount = config.tenants ?? 10;
  if (!Number.isInteger(tenantCount) || tenantCount < 1) throw new Error('krepis drill: `tenants` must be a positive integer.');
  const latecomerCount = config.latecomers ?? 3;
  if (!Number.isInteger(latecomerCount) || latecomerCount < 0) throw new Error('krepis drill: `latecomers` must be a whole number.');
  const opsPerSecond = config.opsPerSecond ?? 1;
  if (!(opsPerSecond > 0)) throw new Error('krepis drill: `opsPerSecond` must be positive.');
  const timing = { baselineMs: 15_000, recoveryMs: 30_000, settleMs: 10_000, opTimeoutMs: 10_000, latecomerDelayMs: 3_000, ...config.timing };
  if (timing.settleMs > timing.recoveryMs) throw new Error('krepis drill: `timing.settleMs` cannot exceed `timing.recoveryMs`.');
  const image = options.image ?? config.server?.image ?? 'mongo:8.0';
  const rateLimitPerSec = config.server?.rateLimitPerSec ?? 15;
  const secrets = new Set<string>();
  // Replica-set scenarios need their own server, so they run after the standalone ones and the rig is switched once.
  const ordered = [...scenarios.filter((s) => topologyOf(s.name) === 'standalone'), ...scenarios.filter((s) => topologyOf(s.name) === 'replicaSet')];

  const width = String(tenantCount).length;
  const tenants: Tenant[] = [];
  for (let i = 1; i <= tenantCount; i++) {
    const key = `t${String(i).padStart(width, '0')}`;
    const t: Tenant = { key, user: `krepis_drill_${key}`, published: secret(), inFlight: 0 };
    secrets.add(t.published);
    tenants.push(t);
  }
  const latecomers: Tenant[] = [];
  for (let i = 1; i <= latecomerCount; i++) {
    const key = `late${i}`;
    const t: Tenant = { key, user: `krepis_drill_${key}`, published: secret(), inFlight: 0 };
    secrets.add(t.published);
    latecomers.push(t);
  }
  const byKey = new Map([...tenants, ...latecomers].map((t) => [t.key, t]));
  let server: DrillServer | undefined;
  let topology: DrillTopology | undefined;
  const ctx: DrillContext = {
    uri: (key) => {
      const t = byKey.get(key);
      if (!t) throw new Error(`krepis drill: unknown tenant "${key}"`);
      if (!server) throw new Error('krepis drill: no server is running');
      return server.uri(t.user, t.published);
    },
    tenants: tenants.map((t) => t.key),
    latecomers: latecomers.map((t) => t.key),
    database: DATABASE,
  };
  const results: ScenarioResult[] = [];
  try {
    for (const spec of ordered) {
      options.signal?.throwIfAborted();
      const needed = topologyOf(spec.name);
      if (needed !== topology) {
        if (server) await server.stop();
        server = undefined;
        const rigOptions = { image, rateLimitPerSec, log, signal: options.signal };
        server = needed === 'replicaSet'
          ? await DockerReplicaSet.start({ ...rigOptions, cpus: config.server?.cpus ?? 2 })
          : await DockerServer.start({ ...rigOptions, cpus: config.server?.cpus ?? 1 });
        topology = needed;
        secrets.add(server.adminPassword);
        for (const t of [...tenants, ...latecomers]) await server.createUser(t.user, t.published, DATABASE);
      }
      if (!server) throw new Error('krepis drill: no server is running');
      log(`scenario ${spec.name}`);
      const result = await runScenario(spec, { config, ctx, tenants, latecomers, server, topology: needed, timing, opsPerSecond, secrets, dumpDir: options.dumpDir, signal: options.signal, log });
      if (options.signal?.aborted) {
        log(`scenario ${spec.name}: interrupted`);
        break;
      }
      log(`scenario ${spec.name}: ${result.pass ? 'PASS' : 'FAIL'}`);
      results.push(result);
    }
  } finally {
    await server?.stop(!options.keep);
    if (server && options.keep) log(`kept ${server.name} on 127.0.0.1:${server.port}`);
  }
  return { pass: results.every((r) => r.pass), image, tenants: tenantCount, rateLimitPerSec, scenarios: results, durationMs: Date.now() - started };
}

interface ScenarioEnv<C> {
  config: DrillConfig<C>;
  ctx: DrillContext;
  tenants: Tenant[];
  latecomers: Tenant[];
  server: DrillServer;
  topology: DrillTopology;
  timing: { baselineMs: number; recoveryMs: number; settleMs: number; opTimeoutMs: number; latecomerDelayMs: number };
  opsPerSecond: number;
  secrets: Set<string>;
  dumpDir?: string;
  signal?: AbortSignal;
  log: (line: string) => void;
}

async function runScenario<C>(spec: Required<ScenarioSpec>, env: ScenarioEnv<C>): Promise<ScenarioResult> {
  const { config, ctx, tenants, server, timing, signal } = env;
  const rawFindings: { at: number; finding: ConnectionFinding }[] = [];
  const dumps: string[] = [];
  const monitor = new IncidentMonitor({
    onFinding: (finding) => rawFindings.push({ at: Date.now(), finding }),
    recorder: { dumpDir: env.dumpDir ? join(env.dumpDir, spec.name) : undefined, onDump: (d) => dumps.push(d.reason) },
  });
  const clientOf = config.clientOf ?? (defaultClientOf as (c: C) => WatchableClient | undefined);
  const op = config.op ?? (defaultOp as (c: C, t: string, x: DrillContext) => Promise<unknown>);
  const watched = new WeakSet<object>();
  let clients = 0;
  const ops: OpRecord[] = [];
  // Kept apart so every verdict and phase count is about the regular tenants only.
  const lateOps: OpRecord[] = [];
  let lateAt: number | undefined;
  const samples: CounterSample[] = [];
  const pending = new Set<Promise<unknown>>();
  let paused = false;
  let running = true;
  let error: string | undefined;
  const timers: NodeJS.Timeout[] = [];

  let primary: ScenarioResult['primary'];
  // The previous scenario may have left a member restarting. If the set never recovers, this scenario fails; the run goes on.
  let unhealthy: unknown;
  if (server instanceof DockerReplicaSet) await server.waitHealthy(180_000, signal).catch((e: unknown) => (unhealthy = e));
  const first = await server.sample();
  if (first) samples.push(first);
  // One sample at a time. A sample can take seconds while a node is down; overlapping ones can resolve out of order,
  // and an older reading after a newer one looks like a counter reset, which the judge counts as a whole history of activity.
  let sampling: Promise<void> | undefined;
  const sampler = setInterval(() => {
    sampling ??= server.sample().then((s) => void (s && samples.push(s))).catch(() => {}).finally(() => (sampling = undefined));
  }, 1_000);

  let app: Awaited<ReturnType<DrillConfig<C>['setup']>> | undefined;
  const t0 = Date.now();
  let faultAt = t0;
  let healAt = t0;
  let end = t0;
  try {
    if (unhealthy) throw unhealthy;
    app = await config.setup(ctx);
    const theApp = app;
    const runOp = (t: Tenant, sink: OpRecord[] = ops) => {
      if (!running || paused || t.inFlight >= MAX_IN_FLIGHT) return;
      t.inFlight++;
      const start = Date.now();
      const work = (async () => {
        const client = await theApp.client(t.key);
        const w = clientOf(client);
        if (w && !watched.has(w as object)) {
          watched.add(w as object);
          clients++;
          monitor.watch(w, { label: t.key });
        }
        return op(client, t.key, ctx);
      })();
      const tracked = withTimeout(work, timing.opTimeoutMs).then(
        () => sink.push({ tenant: t.key, start, end: Date.now(), ok: true }),
        () => sink.push({ tenant: t.key, start, end: Date.now(), ok: false }),
      );
      const settled = work.catch(() => {}).finally(() => {
        t.inFlight--;
        pending.delete(settled);
      });
      pending.add(settled);
      void tracked;
    };
    const period = 1000 / env.opsPerSecond;
    tenants.forEach((t, i) => {
      const offset = setTimeout(() => {
        runOp(t);
        timers.push(setInterval(() => runOp(t), period));
      }, (i * period) / tenants.length);
      timers.push(offset);
    });

    await sleep(timing.baselineMs, signal);
    faultAt = Date.now();
    env.log(`  fault: ${spec.name}`);
    if (spec.name !== 'idle' && env.latecomers.length) {
      timers.push(setTimeout(() => {
        lateAt = Date.now();
        env.latecomers.forEach((t, i) => {
          runOp(t, lateOps);
          timers.push(setTimeout(() => {
            runOp(t, lateOps);
            timers.push(setInterval(() => runOp(t, lateOps), period));
          }, period - (i * period) / env.latecomers.length));
        });
      }, timing.latecomerDelayMs));
    }
    healAt = await inject(spec, env, (p) => (paused = p), (p) => (primary = p));
    env.log(`  healed after ${Math.round((healAt - faultAt) / 1000)} s; observing recovery`);
    await sleep(timing.recoveryMs - (Date.now() - healAt), signal);
    end = Date.now();
  } catch (e) {
    error = redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e), env.secrets);
    end = Date.now();
    if (faultAt === t0) faultAt = end;
    if (healAt === t0) healAt = end;
  } finally {
    running = false;
    for (const t of timers) clearTimeout(t);
    await server.failpoint('off').catch(() => {});
    if (spec.name === 'overload' || spec.name === 'overload-keep') await server.admission('normal').catch(() => {});
    await Promise.race([Promise.allSettled([...pending]), sleep(timing.opTimeoutMs)]);
    clearInterval(sampler);
    await sampling;
    const last = await server.sample();
    if (last) samples.push(last);
    await Promise.resolve(app?.close()).catch(() => {});
    monitor.stop();
  }

  const warmFrom = t0 + Math.min(WARMUP_EXCLUDED_MS, timing.baselineMs / 3);
  const baseline = phase(samples, ops, warmFrom, faultAt);
  const fault = phase(samples, ops, faultAt, healAt);
  const recovery = phase(samples, ops, healAt, end);
  const settle = countersBetween(samples, end - timing.settleMs, end);
  const total = countersBetween(samples, t0, Infinity);
  const { eligible, recoveryMs } = recoveryTimes(ops, ctx.tenants, t0, faultAt, healAt);
  const findings: DrillFinding[] = rawFindings.map(({ at, finding }) => ({
    phase: at < faultAt ? 'baseline' : at < healAt ? 'fault' : 'recovery',
    atMs: at - faultAt,
    finding,
  }));
  const amplification = findings.filter((f) => f.phase !== 'baseline' && f.finding.rule === 'KR-I001').length;
  const budgets = config.budgets ?? {};
  const verdicts = error
    ? [{ name: 'recovered' as const, pass: false, detail: `the scenario did not complete: ${error}` }]
    : judge({ scenario: spec.name, tenants: tenants.length, eligible: eligible.length, recoveryMs, baseline, fault, settle, settleMs: timing.settleMs, total, amplification, budgets });
  const budgetMs = budgets.recoveryMs ?? 30_000;
  const times = Object.values(recoveryMs).filter((ms): ms is number => ms !== null);
  return {
    name: spec.name,
    topology: env.topology,
    ...(primary ? { primary } : {}),
    pass: verdicts.every((v) => v.pass),
    verdicts,
    phases: { baseline, fault, recovery, settle },
    recovered: times.filter((ms) => ms <= budgetMs).length,
    eligible: eligible.length,
    recoveryMs,
    slowestRecoveryMs: times.length === eligible.length && times.length > 0 ? Math.max(...times) : null,
    findings,
    dumps,
    clients,
    ...(lateAt !== undefined ? { latecomers: latecomerResult(lateOps, env.latecomers.map((t) => t.key), lateAt, faultAt) } : {}),
    ...(error ? { error } : {}),
  };
}

/** Applies the fault and returns the moment it healed. */
async function inject<C>(
  spec: Required<ScenarioSpec>,
  env: ScenarioEnv<C>,
  setPaused: (p: boolean) => void,
  setPrimary: (p: NonNullable<ScenarioResult['primary']>) => void,
): Promise<number> {
  const { server, tenants, signal } = env;
  const faultAt = Date.now();
  if (server instanceof DockerReplicaSet) return injectReplicaSet(spec.name, server, faultAt, setPrimary, signal);
  switch (spec.name) {
    case 'credential-rotation': {
      const next = new Map<Tenant, string>();
      try {
        for (const t of tenants) {
          const pw = secret();
          env.secrets.add(pw);
          await server.setPassword(t.user, pw);
          next.set(t, pw);
        }
        // A rotation leaves authenticated connections alone; it bites when connections are re-established.
        await server.failpoint('alwaysOn', { closeConnection: true });
        await sleep(1_500, signal);
        await server.failpoint('off');
        await sleep(spec.propagationMs - (Date.now() - faultAt), signal);
      } finally {
        // Whatever the server now holds is published, so later scenarios start from working credentials.
        for (const [t, pw] of next) t.published = pw;
      }
      return Date.now();
    }
    case 'auth-outage': {
      // The server rejects the published credentials for a while, then accepts them again; nothing is republished.
      // This is an authentication-path outage, which re-reading credentials cannot fix.
      try {
        for (const t of tenants) {
          const pw = secret();
          env.secrets.add(pw);
          await server.setPassword(t.user, pw);
        }
        await server.failpoint('alwaysOn', { closeConnection: true });
        await sleep(1_500, signal);
        await server.failpoint('off');
        await sleep(spec.durationMs - (Date.now() - faultAt), signal);
      } finally {
        for (const t of tenants) await server.setPassword(t.user, t.published).catch(() => {});
      }
      return Date.now();
    }
    case 'restart':
      await (server as DockerServer).restart(signal);
      return Date.now();
    case 'slow-node':
      await server.failpoint('alwaysOn', { blockConnection: true, blockTimeMS: spec.blockMs });
      await sleep(spec.durationMs, signal);
      await server.failpoint('off');
      return Date.now();
    case 'overload': {
      // The node refuses most new connections, as at its connection limit, after dropping the application's.
      await server.warmAdmin();
      try {
        await server.admission('overload');
        await server.failpoint('alwaysOn', { closeConnection: true });
        await sleep(1_500, signal);
        await server.failpoint('off');
        await sleep(spec.durationMs - (Date.now() - faultAt), signal);
      } finally {
        await server.admission('normal');
      }
      return Date.now();
    }
    case 'overload-keep':
      // The node refuses most new connections but keeps serving the ones it has, as an Atlas node at its limit does.
      await server.warmAdmin();
      try {
        await server.admission('overload');
        await sleep(spec.durationMs, signal);
      } finally {
        await server.admission('normal');
      }
      return Date.now();
    case 'network-blip':
      await server.failpoint('alwaysOn', { closeConnection: true });
      await sleep(spec.durationMs, signal);
      await server.failpoint('off');
      return Date.now();
    case 'idle':
      setPaused(true);
      await sleep(spec.durationMs, signal);
      setPaused(false);
      return Date.now();
    default:
      throw new Error(`krepis drill: ${spec.name} needs a replica set`);
  }
}

/** Replica-set faults. The heal is the moment the set again has a writable primary (and, for a rolling restart, every member is back). */
async function injectReplicaSet(
  name: ScenarioName,
  rs: DockerReplicaSet,
  faultAt: number,
  setPrimary: (p: NonNullable<ScenarioResult['primary']>) => void,
  signal?: AbortSignal,
): Promise<number> {
  const before = await rs.waitPrimary(30_000, signal);
  const elect = async () => {
    const after = await rs.waitPrimary(60_000, signal, before);
    setPrimary({ before, after, electedAfterMs: Date.now() - faultAt });
  };
  switch (name) {
    case 'stepdown':
      // Graceful handover, as in Atlas maintenance: the primary hands over to a caught-up secondary.
      await rs.stepDown(before);
      await elect();
      return Date.now();
    case 'primary-crash': {
      // The primary dies without warning; the others notice after electionTimeoutMillis (10 s) and elect.
      const i = rs.indexOf(before);
      await rs.kill(i, 'KILL');
      await elect();
      const healAt = Date.now();
      await rs.startMember(i);
      return healAt;
    }
    case 'rolling-restart': {
      // The pattern Atlas uses to scale or patch a cluster: secondaries one at a time, then a step-down and the old primary.
      const old = rs.indexOf(before);
      for (let i = 0; i < rs.ports.length; i++) if (i !== old) await rs.restartMember(i, signal);
      await rs.stepDown(before);
      await elect();
      await rs.restartMember(old, signal);
      return Date.now();
    }
    default:
      throw new Error(`krepis drill: ${name} needs a standalone server`);
  }
}
