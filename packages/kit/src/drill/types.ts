import type { ConnectionFinding, WatchableClient } from '@sameernair/krepis/connections';

export type ScenarioName =
  | 'credential-rotation' | 'auth-outage' | 'restart' | 'slow-node' | 'overload' | 'overload-keep' | 'network-blip' | 'idle'
  | 'stepdown' | 'primary-crash' | 'rolling-restart';

export const SCENARIO_NAMES: readonly ScenarioName[] = [
  'credential-rotation', 'auth-outage', 'restart', 'slow-node', 'overload', 'overload-keep', 'network-blip', 'idle',
  'stepdown', 'primary-crash', 'rolling-restart',
];

/** Scenarios that need a replica set. They run after the others, on their own three-member set. */
export const REPLICA_SET_SCENARIOS: readonly ScenarioName[] = ['stepdown', 'primary-crash', 'rolling-restart'];

export type DrillTopology = 'standalone' | 'replicaSet';

export interface ScenarioSpec {
  name: ScenarioName;
  /** credential-rotation: how long new credentials take to reach the application. Default 15 s. */
  propagationMs?: number;
  /** auth-outage, slow-node, overload, overload-keep, network-blip, idle: how long the fault lasts. Defaults 20 s, 20 s, 20 s, 20 s, 5 s, 90 s. */
  durationMs?: number;
  /** slow-node: how long each faulted command blocks. Default 5 s. */
  blockMs?: number;
}

export interface DrillContext {
  /** The tenant's currently published connection string. After a rotation it lags the server by `propagationMs`. */
  uri(tenant: string): string;
  tenants: readonly string[];
  /** Tenants the drill first asks for during the fault (see `DrillConfig.latecomers`). Not in `tenants`. */
  latecomers: readonly string[];
  /** The database each tenant user can read and write. */
  database: string;
}

export interface DrillApp<C> {
  /** The application's client for a tenant, built the way production builds it. */
  client(tenant: string): C | Promise<C>;
  close(): unknown;
}

export interface DrillTiming {
  /** Warm-up before the fault, also the baseline for `settled`. Default 15 s. */
  baselineMs?: number;
  /** Observation after the heal. Default 30 s. */
  recoveryMs?: number;
  /** The tail of recovery that must look like baseline. Default 10 s. */
  settleMs?: number;
  /** An operation outliving this counts as failed. Default 10 s. */
  opTimeoutMs?: number;
  /** How long after the fault begins the latecomers first ask for a client. Default 3 s. */
  latecomerDelayMs?: number;
}

export interface DrillBudgets {
  /** Every tenant must succeed again within this long after the heal. Default 30 s. */
  recoveryMs?: number;
  /** idle: logins allowed per tenant per minute of idleness. Default 1. */
  idleLoginsPerTenantPerMinute?: number;
  /** Per scenario, across all phases. Unlimited by default. */
  maxFailedLogins?: number;
  maxLogins?: number;
  maxConnectionsCreated?: number;
  /** Fail on any KR-I001 during fault or recovery. Default false. */
  noAmplification?: boolean;
}

export interface DrillServerOptions {
  /** Default `mongo:8.0`. */
  image?: string;
  /** Ingress connection-establishment rate limit per second; 0 disables. Default 15. */
  rateLimitPerSec?: number;
  /** CPUs given to the container. Default 1 for the standalone server, 2 for the replica set (three mongod). */
  cpus?: number;
}

export interface DrillConfig<C = unknown> {
  /** Number of tenants, each with its own user. Default 10. */
  tenants?: number;
  /** Operations per second per tenant. Default 1. */
  opsPerSecond?: number;
  /**
   * Extra tenants whose first request comes during the fault, to show whether a tenant new to the process is served
   * then. Their operations are reported apart and judge nothing. Not used in `idle`. Default 3; 0 disables.
   */
  latecomers?: number;
  setup(ctx: DrillContext): DrillApp<C> | Promise<DrillApp<C>>;
  /** One unit of the application's work. Default: `client.db(ctx.database).collection('drill').findOne({})`. */
  op?(client: C, tenant: string, ctx: DrillContext): Promise<unknown>;
  /** The driver client behind what `client()` returns, for watching. Default: the value itself, its `.client`, or `.getClient()`. */
  clientOf?(client: C): WatchableClient | undefined;
  scenarios?: (ScenarioName | ScenarioSpec)[];
  timing?: DrillTiming;
  budgets?: DrillBudgets;
  server?: DrillServerOptions;
}

export interface ServerCounters {
  logins: number;
  failedLogins: number;
  created: number;
  rejected: number;
  peakQueued: number;
}

export interface PhaseResult extends ServerCounters {
  opsOk: number;
  opsFailed: number;
  durationMs: number;
}

export interface Verdict {
  name: 'recovered' | 'settled' | 'quiet' | 'maxFailedLogins' | 'maxLogins' | 'maxConnectionsCreated' | 'noAmplification';
  pass: boolean;
  detail: string;
}

export interface DrillFinding {
  phase: 'baseline' | 'fault' | 'recovery';
  /** Milliseconds since the fault began (negative: before). */
  atMs: number;
  finding: ConnectionFinding;
}

export interface ScenarioResult {
  name: ScenarioName;
  topology: DrillTopology;
  /** Replica-set scenarios: the primary before and after the fault, and how long after the fault began a new one was writable. */
  primary?: { before: string; after: string; electedAfterMs: number };
  pass: boolean;
  verdicts: Verdict[];
  phases: { baseline: PhaseResult; fault: PhaseResult; recovery: PhaseResult; settle: ServerCounters };
  /** Tenants that succeeded during warm-up and again after the heal, within the budget. */
  recovered: number;
  /** Tenants that succeeded during warm-up. */
  eligible: number;
  /** Per tenant: ms from heal to the first success of an operation started after it; null if none. */
  recoveryMs: Record<string, number | null>;
  slowestRecoveryMs: number | null;
  findings: DrillFinding[];
  dumps: string[];
  /** Clients the application handed back and the drill watched. */
  clients: number;
  /** Tenants first asked for during the fault; absent when there were none or the scenario ended before they arrived. */
  latecomers?: LatecomerResult;
  error?: string;
}

export interface LatecomerResult {
  /** When they first asked for a client, in ms since the fault began. */
  arrivedAtMs: number;
  /** Per latecomer: ms from arrival to its first successful operation (null if none), and the operations that failed before it. */
  tenants: Record<string, { firstOkMs: number | null; failedBefore: number }>;
}

export interface DrillReport {
  pass: boolean;
  image: string;
  tenants: number;
  rateLimitPerSec: number;
  scenarios: ScenarioResult[];
  durationMs: number;
}

export interface RunDrillOptions {
  /** Only these scenarios, in config order. */
  only?: ScenarioName[];
  /** Leave the container running afterwards. */
  keep?: boolean;
  /** Overrides `server.image`. */
  image?: string;
  /** Write flight-recorder dumps here, one subdirectory per scenario. */
  dumpDir?: string;
  /** Progress lines (to stderr in the CLI). */
  log?: (line: string) => void;
  /** Aborts the run; the container is still removed. */
  signal?: AbortSignal;
}
