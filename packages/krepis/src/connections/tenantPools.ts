import type { IncidentMonitor } from './incidents.ts';
import { createHash } from 'node:crypto';
import * as mongodb from 'mongodb';
import { isAuthFailure, isNetworkError } from './classify.ts';
import { clusterKey, equalJitter, TokenBucket } from './governor.ts';
import { checkConnectionOptions } from './preflight.ts';
import { ConnectionWatcher, type WatchableClient, type WatchOptions } from './watcher.ts';
import type { ClientOptionsLike, ConnectionFinding } from './types.ts';

export type ClientOptions = Record<string, unknown>;

/** Where and how to connect for one tenant. Resolved on open, on every breaker half-open, and periodically. */
export interface TenantTarget {
  uri: string;
  options?: ClientOptions;
  /** Identifies the credentials, to notice rotation. Default: a hash of the URI and `options.auth`. */
  fingerprint?: string;
}

export interface BreakerOptions {
  /** `enforce` closes the tenant's client and fails fast; `observe` only reports. Default `enforce`. */
  mode?: 'enforce' | 'observe' | 'off';
  /** Failed logins within `windowMs` that trip the breaker. Default 3. */
  threshold?: number;
  windowMs?: number;
  /** Cooldown doubles per consecutive trip, from base to max, with equal jitter. Defaults 5 s and 300 s. */
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  /** Govern a cluster's tenants together when many fail logins at once; `false` disables. */
  storm?: StormOptions | false;
  /** Re-resolve an open breaker's target this often, so new credentials end the cooldown at once. 0 disables. Default 5 s. */
  credentialPollMs?: number;
  /** Half-open probes per second per cluster (and the burst), so a mass release is not a herd. Default 10. */
  probesPerSecond?: number;
}

export interface StormOptions {
  /** Distinct tenants of one cluster failing a login within `windowMs` that make a storm. Default 3. */
  minTenants?: number;
  windowMs?: number;
  /** The storm ends after this long without an auth failure in the cluster. Default 30 s. */
  quietMs?: number;
  /** Ceiling of the canary's doubling schedule (from `baseCooldownMs`). Default 15 s. */
  canaryMaxMs?: number;
}

/** Shedding new connections from a cluster that is refusing them. */
export interface OverloadOptions {
  /** `enforce` sheds; `observe` only reports. Default `enforce`. */
  mode?: 'enforce' | 'observe';
  /** Distinct tenants of one cluster failing to establish a connection within `windowMs` that make an overload. Default 3. */
  minTenants?: number;
  windowMs?: number;
  /** The overload ends after this long without a failed establishment in the cluster. Default 10 s. */
  quietMs?: number;
  /** While overloaded, tenants per second (and the burst) admitted to try for a connection. Default 2. */
  admitPerSecond?: number;
  /** While overloaded, the most tenants without an established connection that may hold a client; the rest are closed until admitted. Default 2. */
  maxColdTenants?: number;
}

export type TenantPoolEvent =
  | { type: 'opened'; key: string }
  | { type: 'retired'; key: string; reason: 'idle' | 'lru' | 'credentials' | 'breaker' | 'overload' }
  | { type: 'credentialsChanged'; key: string }
  | { type: 'breakerOpen'; key: string; failures: number; attempt: number; cooldownMs: number; mode: 'enforce' | 'observe'; storm: boolean }
  | { type: 'breakerClosed'; key: string }
  | { type: 'stormStarted'; cluster: string; tenants: number }
  | { type: 'stormEnded'; cluster: string; reason: 'quiet' | 'canary' }
  | { type: 'canary'; key: string; cluster: string; ok: boolean }
  | { type: 'overloadStarted'; cluster: string; tenants: number; nodes: string[]; mode: 'enforce' | 'observe' }
  | { type: 'overloadEnded'; cluster: string; shed: number; parked: number }
  | { type: 'finding'; key: string; finding: ConnectionFinding };

export interface TenantPoolsOptions<H> {
  /** Set on every client, so Atlas can attribute connections and failed logins. Required. */
  appName: string;
  resolve(key: string): TenantTarget | Promise<TenantTarget>;
  /** Options for every tenant, under each target's own options. Safe defaults sit under both. */
  clientOptions?: ClientOptions;
  /** Open a handle (default: a driver `MongoClient`, connected). For Mongoose: `createConnection(uri, o).asPromise()`. */
  open?(uri: string, options: ClientOptions): Promise<H>;
  /** The driver client behind a handle (default: the handle). For Mongoose: `(c) => c.getClient()`. */
  clientOf?(handle: H): WatchableClient;
  close?(handle: H): Promise<unknown>;
  /** Driver module for the default `open` and for feature detection. Default: the `mongodb` this package resolves. */
  driver?: { MongoClient: new (uri: string, options?: never) => unknown; MongoErrorLabel?: Record<string, string> };
  /** Live clients per process; the least recently used is retired beyond it. Default 100. */
  maxPools?: number;
  /** Retire a tenant's client after this long unused. Default 10 min. */
  evictIdleMs?: number;
  /** Retired clients close after this delay, so in-flight operations finish. Default 30 s. */
  retireGraceMs?: number;
  /** Re-resolve a live tenant's target at most this often, to notice rotated credentials. Default 5 min. */
  credentialCheckMs?: number;
  breaker?: BreakerOptions;
  /** Shed new connections from a cluster that is refusing them; `false` disables. */
  overload?: OverloadOptions | false;
  /** Runtime detection on every tenant client (KR-C rules), reported as `finding` events. Default on. */
  watch?: boolean | WatchOptions;
  /** Watch every tenant client under this monitor (KR-I001/I002, flight recorder), labelled with its tenant key. Tenant keys appear in findings and dumps, so they must not be secrets. */
  monitor?: IncidentMonitor;
  /** Open clients even when the preflight reports an error (e.g. KR-C008). Default false. */
  allowUnsafeOptions?: boolean;
  onEvent?(event: TenantPoolEvent): void;
  random?: () => number;
  now?: () => number;
}

/** Applied under caller options: connections follow demand, idle ones retire, one monitoring socket per node. */
export const SAFE_CLIENT_OPTIONS: Readonly<ClientOptions> = Object.freeze({
  minPoolSize: 0,
  maxPoolSize: 10,
  maxIdleTimeMS: 300_000,
  serverMonitoringMode: 'poll',
});

/** "Name: message." for an error message, without doubling the full stop. */
function describeError(error: unknown): string {
  if (error === undefined || error === null) return 'none recorded.';
  const e = error as { name?: unknown; message?: unknown };
  const text = typeof e.message === 'string' ? `${String(e.name ?? 'Error')}: ${e.message}` : String(error);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

const inSeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * The tenant's logins keep failing, so Krepis stopped trying them for `retryAfterMs`: a login loop is what
 * turned failed logins into an incident. `cause` is the driver's own error.
 */
export class TenantLoginsFailingError extends Error {
  readonly code = 'MONGODB_TENANT_LOGINS_FAILING';
  readonly source = 'krepis';
  readonly key: string;
  readonly cluster: string | undefined;
  readonly retryAfterMs: number;
  /** Several tenants of the cluster were failing at once, so the cause is probably shared. */
  readonly storm: boolean;
  constructor(key: string, retryAfterMs: number, detail: { cluster?: string; storm?: boolean; cause?: unknown } = {}) {
    const where = detail.cluster ? ` on cluster ${detail.cluster}` : '';
    const shared = detail.storm ? ' Other tenants of this cluster are failing to log in too, so the cause is probably shared.' : '';
    super(
      `MongoDB logins for tenant "${key}" are failing${where}. Last error: ${describeError(detail.cause)}${shared} ` +
        `Krepis is not retrying them for ${inSeconds(retryAfterMs)} s, so failed logins do not pile up on the cluster.`,
      detail.cause === undefined ? undefined : { cause: detail.cause },
    );
    this.name = 'TenantLoginsFailingError';
    this.key = key;
    this.cluster = detail.cluster;
    this.retryAfterMs = retryAfterMs;
    this.storm = detail.storm ?? false;
  }
}

/**
 * The tenant's cluster is refusing new connections, so Krepis is not opening one for this tenant for
 * `retryAfterMs`. `cause` is the latest driver error that showed a refusal; `nodes` are the members that refused.
 */
export class ClusterRefusingConnectionsError extends Error {
  readonly code = 'MONGODB_CLUSTER_REFUSING_CONNECTIONS';
  readonly source = 'krepis';
  readonly key: string;
  readonly cluster: string;
  readonly retryAfterMs: number;
  /** Members that refused an establishment within the window; empty when the only evidence was a failed open. */
  readonly nodes: string[];
  /** Distinct tenants refused within the window. */
  readonly refusedTenants: number;
  /** When the cluster was found to be refusing (epoch ms). */
  readonly since: number;
  constructor(key: string, retryAfterMs: number, detail: { cluster: string; nodes: string[]; refusedTenants: number; since: number; windowMs: number; cause?: unknown }) {
    const by = detail.nodes.length ? `, by ${detail.nodes.join(', ')}` : '';
    super(
      `MongoDB cluster ${detail.cluster} is refusing new connections: ${detail.refusedTenants} tenants were refused in the last ${inSeconds(detail.windowMs)} s${by}. ` +
        `Last error: ${describeError(detail.cause)} Krepis is holding tenant "${key}" back for ${inSeconds(retryAfterMs)} s so as not to add to the load.`,
      detail.cause === undefined ? undefined : { cause: detail.cause },
    );
    this.name = 'ClusterRefusingConnectionsError';
    this.key = key;
    this.cluster = detail.cluster;
    this.retryAfterMs = retryAfterMs;
    this.nodes = detail.nodes;
    this.refusedTenants = detail.refusedTenants;
    this.since = detail.since;
  }
}

export class KrepisConnectionConfigError extends Error {
  readonly code = 'KREPIS_CONNECTION_CONFIG';
  readonly key: string;
  readonly findings: ConnectionFinding[];
  constructor(key: string, findings: ConnectionFinding[]) {
    super(`krepis: refusing to open a client for tenant "${key}": ${findings.map((f) => `${f.rule} ${f.title}`).join('; ')}. Pass allowUnsafeOptions to override.`);
    this.name = 'KrepisConnectionConfigError';
    this.key = key;
    this.findings = findings;
  }
}

interface Entry<H> {
  handle: H;
  fingerprint: string;
  lastUsed: number;
  checkedAt: number;
  stale: boolean;
  /** Connections of its pool that are established and not yet closed. */
  ready: number;
  detach: () => void;
}

interface Breaker {
  failures: number[];
  attempt: number;
  open: boolean;
  openUntil: number;
  /** The credentials that were failing when it tripped; a probe with the same ones during a storm waits for the canary. */
  failedFingerprint: string | undefined;
  nextPollAt: number;
  polling: boolean;
  /** The driver error of the latest failed login. */
  lastError: unknown;
  storm: boolean;
}

interface Cluster {
  /** Tenant → time of its latest auth failure, within the storm window. */
  failing: Map<string, number>;
  lastFailureAt: number;
  storm: boolean;
  canaryKey: string | undefined;
  canaryAttempt: number;
  canaryAt: number;
  probes: TokenBucket;
  /** Tenant → time of its latest failed establishment, within the overload window. */
  refused: Map<string, number>;
  /** Member → time it last refused an establishment, within the overload window. */
  refusedNodes: Map<string, number>;
  /**
   * Member → when it last refused, and when it last answered after refusing (0: not since). A refusal counts only
   * from a member that is answering: one at its limit still serves what it has, a dead one answers nothing.
   */
  nodes: Map<string, { refusedAt: number; answeredAt: number }>;
  lastRefusal: unknown;
  lastRefusedAt: number;
  overloaded: boolean;
  overloadSince: number;
  admit: TokenBucket;
  /** Cold tenants admitted to hold a client while overloaded, by admission time. */
  trials: Map<string, number>;
  shed: number;
  parked: number;
}

type ResolvedOverload = Required<OverloadOptions>;

interface ResolvedBreaker {
  mode: 'enforce' | 'observe' | 'off';
  threshold: number;
  windowMs: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
  storm: Required<StormOptions> | false;
  credentialPollMs: number;
  probesPerSecond: number;
}

const URI_OPTION_KEYS: Record<string, keyof ClientOptionsLike> = {
  minpoolsize: 'minPoolSize', maxpoolsize: 'maxPoolSize', maxidletimems: 'maxIdleTimeMS',
  sockettimeoutms: 'socketTimeoutMS', appname: 'appName', servermonitoringmode: 'serverMonitoringMode',
};

/** Pool options carried in the connection string, which the driver applies too. */
export function uriPoolOptions(uri: string): ClientOptionsLike {
  const q = uri.indexOf('?');
  const out: Record<string, string | number> = {};
  if (q < 0) return out as ClientOptionsLike;
  for (const [k, v] of new URLSearchParams(uri.slice(q + 1))) {
    const key = URI_OPTION_KEYS[k.toLowerCase()];
    if (key) out[key] = key === 'appName' || key === 'serverMonitoringMode' ? v : Number(v);
  }
  return out as ClientOptionsLike;
}

/** Members a server-selection error reports as failing; none for other errors. */
function refusingServers(error: unknown): string[] {
  const servers = (error as { reason?: { servers?: unknown } } | null)?.reason?.servers;
  if (!(servers instanceof Map)) return [];
  return [...servers].filter(([, d]) => (d as { error?: unknown } | null)?.error).map(([host]) => String(host));
}

/** A connection the node did not let us establish: refused, reset, or no server reachable to establish it with. */
function isEstablishmentFailure(error: unknown): boolean {
  return isNetworkError(error) || (error as { name?: unknown } | null)?.name === 'MongoServerSelectionError';
}

function defaultFingerprint(target: TenantTarget): string {
  return createHash('sha256').update(target.uri).update('\0').update(JSON.stringify(target.options?.auth ?? null)).digest('hex').slice(0, 16);
}

/**
 * One driver client per tenant, opened on demand, with the connection-incident mechanisms designed out:
 * no idle re-login churn, failed logins stop instead of looping, rotated credentials are picked up without a restart,
 * and idle tenants hold no connections.
 */
export class TenantPools<H = mongodb.MongoClient> {
  private readonly o: TenantPoolsOptions<H>;
  private readonly breakerOpts: ResolvedBreaker;
  private readonly overloadOpts: ResolvedOverload | false;
  private readonly entries = new Map<string, Entry<H>>();
  private readonly opening = new Map<string, Promise<H>>();
  private readonly breakers = new Map<string, Breaker>();
  private readonly clusters = new Map<string, Cluster>();
  /** The latest resolved cluster per tenant. */
  private readonly clusterOf = new Map<string, string>();
  private readonly retiring = new Set<Promise<unknown>>();
  /** Retirements waiting out their grace period: timer → close now. */
  private readonly graceTimers = new Map<NodeJS.Timeout, () => void>();
  private readonly reportedRules = new Set<string>();
  private sweeper: NodeJS.Timeout | undefined;
  private governor: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: TenantPoolsOptions<H>) {
    if (!options.appName) throw new TypeError('krepis: TenantPools needs an appName (KR-C011).');
    this.o = options;
    const b = options.breaker ?? {};
    const storm = b.storm === false ? false : { minTenants: 3, windowMs: 10_000, quietMs: 30_000, canaryMaxMs: 15_000, ...b.storm };
    if (storm && !(storm.minTenants >= 2)) throw new TypeError('krepis: breaker.storm.minTenants must be at least 2; one tenant failing is not a storm.');
    const probesPerSecond = b.probesPerSecond ?? 10;
    if (!(probesPerSecond > 0)) throw new TypeError('krepis: breaker.probesPerSecond must be positive.');
    this.breakerOpts = {
      mode: b.mode ?? 'enforce', threshold: b.threshold ?? 3, windowMs: b.windowMs ?? 60_000,
      baseCooldownMs: b.baseCooldownMs ?? 5_000, maxCooldownMs: b.maxCooldownMs ?? 300_000,
      storm, credentialPollMs: b.credentialPollMs ?? 5_000, probesPerSecond,
    };
    const overload = options.overload === false ? false : { mode: 'enforce' as const, minTenants: 3, windowMs: 10_000, quietMs: 10_000, admitPerSecond: 2, maxColdTenants: 2, ...options.overload };
    if (overload && !(overload.minTenants >= 2)) throw new TypeError('krepis: overload.minTenants must be at least 2; one tenant failing to connect is not an overload.');
    if (overload && !(overload.admitPerSecond > 0)) throw new TypeError('krepis: overload.admitPerSecond must be positive.');
    if (overload && !(Number.isInteger(overload.maxColdTenants) && overload.maxColdTenants >= 1)) throw new TypeError('krepis: overload.maxColdTenants must be a whole number of at least 1.');
    this.overloadOpts = overload;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private random(): number {
    return (this.o.random ?? Math.random)();
  }

  /** The tenant's handle, opening it if needed. Throws `TenantLoginsFailingError` while its logins are known to fail. */
  async get(key: string): Promise<H> {
    if (this.closed) throw new Error('krepis: TenantPools is closed.');
    const now = this.now();
    const breaker = this.breakers.get(key);
    if (breaker?.open && now < breaker.openUntil) throw this.loginsFailing(key, breaker, breaker.openUntil - now);
    const entry = this.entries.get(key);
    if (entry && !entry.stale) {
      // A tenant with an established connection asks nothing new of the node; one without would.
      if (entry.ready === 0) this.admitNew(key, this.clusterOf.get(key), now);
      entry.lastUsed = now;
      this.maybeRecheck(key, entry, now);
      return entry.handle;
    }
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.openTenant(key).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  /** Forget a tenant's client (e.g. after an out-of-band credential change); the next `get` re-resolves. */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.retire(key, entry, 'credentials');
  }

  stats(): { pools: number; retiring: number; openBreakers: string[]; storms: string[]; overloaded: string[] } {
    const now = this.now();
    return {
      pools: this.entries.size,
      retiring: this.retiring.size,
      openBreakers: [...this.breakers].filter(([, b]) => b.open && now < b.openUntil).map(([k]) => k),
      storms: [...this.clusters].filter(([, c]) => c.storm).map(([k]) => k),
      overloaded: [...this.clusters].filter(([, c]) => c.overloaded).map(([k]) => k),
    };
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.governor) clearInterval(this.governor);
    this.governor = undefined;
    for (const [timer, closeNow] of this.graceTimers) {
      clearTimeout(timer);
      closeNow();
    }
    this.graceTimers.clear();
    await Promise.allSettled([...this.opening.values()]);
    const closing = [...this.entries.values()].map((e) => {
      e.detach();
      return this.closeHandle(e.handle);
    });
    this.entries.clear();
    await Promise.allSettled([...closing, ...this.retiring]);
  }

  private async openTenant(key: string): Promise<H> {
    const target = await this.o.resolve(key);
    const fingerprint = target.fingerprint ?? defaultFingerprint(target);
    const cluster = clusterKey(target.uri);
    this.clusterOf.set(key, cluster);
    const options: ClientOptions = { ...SAFE_CLIENT_OPTIONS, ...this.o.clientOptions, ...target.options, appName: this.o.appName };
    const findings = checkConnectionOptions({ options: { ...uriPoolOptions(target.uri), ...(options as ClientOptionsLike) }, driver: this.o.driver ?? mongodb });
    const errors = findings.filter((f) => f.severity === 'error');
    if (errors.length && !this.o.allowUnsafeOptions) throw new KrepisConnectionConfigError(key, errors);
    for (const f of findings) this.report(key, f, true);

    this.admitNew(key, cluster, this.now());
    const canary = this.admitProbe(key, fingerprint, cluster);
    let handle: H;
    try {
      handle = await this.openHandle(target.uri, options);
    } catch (error) {
      const auth = isAuthFailure(error);
      if (canary) this.canaryDone(key, cluster, canary, auth ? false : undefined);
      // A trial whose open failed holds no client, so it must not hold a slot either.
      this.clusters.get(cluster)?.trials.delete(key);
      if (auth) this.authFailure(key, fingerprint, error);
      else if (isEstablishmentFailure(error)) this.refused(key, this.now(), error, refusingServers(error));
      throw error;
    }
    if (canary) this.canaryDone(key, cluster, canary, true);
    if (this.closed) {
      await this.closeHandle(handle);
      throw new Error('krepis: TenantPools is closed.');
    }
    const breaker = this.breakers.get(key);
    if (breaker?.open) {
      breaker.open = false;
      breaker.attempt = 0;
      breaker.failures.length = 0;
      breaker.failedFingerprint = undefined;
      this.emit({ type: 'breakerClosed', key });
    }
    const previous = this.entries.get(key);
    if (previous) this.retire(key, previous, 'credentials');
    else this.enforceCap();
    const now = this.now();
    const entry: Entry<H> = { handle, fingerprint, lastUsed: now, checkedAt: now, stale: false, ready: 0, detach: () => {} };
    entry.detach = this.attach(key, entry);
    this.entries.set(key, entry);
    this.startSweeper();
    this.emit({ type: 'opened', key });
    return handle;
  }

  /**
   * Gate a half-open probe. Returns the cluster when this probe is its canary. Throws `TenantLoginsFailingError`
   * when the probe must wait: for the canary (unchanged credentials during a storm) or for the cluster's probe budget.
   */
  private admitProbe(key: string, fingerprint: string, clusterId: string): Cluster | undefined {
    const b = this.breakers.get(key);
    if (!b?.open || this.breakerOpts.mode !== 'enforce') return undefined;
    const now = this.now();
    const c = this.cluster(clusterId, now);
    this.expireStorm(clusterId, c, now);
    const waitForCanary = c.storm && fingerprint === b.failedFingerprint;
    if (waitForCanary && (c.canaryKey !== undefined || now < c.canaryAt)) {
      const until = Math.max(c.canaryAt, now + 1_000);
      b.openUntil = until;
      throw this.loginsFailing(key, b, until - now);
    }
    const wait = c.probes.take(now);
    if (wait > 0) {
      b.openUntil = now + wait;
      throw this.loginsFailing(key, b, wait);
    }
    if (!waitForCanary) return undefined;
    c.canaryKey = key;
    return c;
  }

  /** `ok` undefined: the canary failed for a reason other than authentication, which says nothing either way. */
  private canaryDone(key: string, clusterId: string, c: Cluster, ok: boolean | undefined): void {
    if (c.canaryKey === key) c.canaryKey = undefined;
    if (ok === undefined) return;
    this.emit({ type: 'canary', key, cluster: clusterId, ok });
    const now = this.now();
    if (!ok) {
      c.canaryAttempt++;
      const storm = this.breakerOpts.storm;
      const ceiling = storm ? Math.min(storm.canaryMaxMs, this.breakerOpts.baseCooldownMs * 2 ** c.canaryAttempt) : 0;
      c.canaryAt = now + equalJitter(ceiling, () => this.random());
      return;
    }
    // Unchanged credentials logged in: the shared failure is over. Release the cluster's tripped tenants; the probe
    // budget spreads their reconnects.
    for (const [k, b] of this.breakers) {
      if (k !== key && b.open && this.clusterOf.get(k) === clusterId) b.openUntil = Math.min(b.openUntil, now);
    }
    this.endStorm(clusterId, c, 'canary');
  }

  private async openHandle(uri: string, options: ClientOptions): Promise<H> {
    if (this.o.open) return this.o.open(uri, options);
    const Driver = (this.o.driver ?? mongodb).MongoClient as unknown as new (u: string, o: ClientOptions) => mongodb.MongoClient;
    const client = new Driver(uri, options);
    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    return client as unknown as H;
  }

  private closeHandle(handle: H): Promise<unknown> {
    const close = this.o.close ? this.o.close(handle) : (handle as unknown as { close(): Promise<unknown> }).close();
    return Promise.resolve(close).catch(() => {});
  }

  private attach(key: string, entry: Entry<H>): () => void {
    const { handle, fingerprint } = entry;
    const client = this.o.clientOf ? this.o.clientOf(handle) : (handle as unknown as WatchableClient);
    // Connections in establishment, and established ones, by id; a close before ready is a failed establishment.
    const pending = new Set<string>();
    const ready = new Set<string>();
    const idOf = (e: never) => {
      const ev = e as { address?: unknown; connectionId?: unknown };
      return `${String(ev.address)}#${String(ev.connectionId)}`;
    };
    const onCreated = (e: never) => void pending.add(idOf(e));
    const established = (e: never) => {
      const id = idOf(e);
      pending.delete(id);
      ready.add(id);
      entry.ready = ready.size;
      this.warmed(key);
    };
    const onReady = (e: never) => {
      established(e);
      const ev = e as { address?: unknown };
      if (ev.address !== undefined) this.answered(key, String(ev.address));
    };
    // The driver pings inside connect() (7.x always, older majors with credentials), so a tenant's first connection is
    // established before attach and its created/ready events are missed. Checking out an unseen id shows it exists.
    // It is not an answer: it says when the connection was checked out, not when the node accepted it.
    const onCheckedOut = (e: never) => {
      if (!ready.has(idOf(e))) established(e);
    };
    const onHeartbeatSucceeded = (e: never) => {
      const ev = e as { connectionId?: unknown };
      if (ev.connectionId !== undefined) this.answered(key, String(ev.connectionId));
    };
    // A failed heartbeat is the monitor failing to (re)establish its connection; monitors never authenticate.
    const onHeartbeatFailed = (e: never) => {
      const ev = e as { failure?: unknown; connectionId?: unknown };
      if (isEstablishmentFailure(ev.failure) && !isAuthFailure(ev.failure)) this.refused(key, this.now(), ev.failure, ev.connectionId === undefined ? [] : [String(ev.connectionId)]);
    };
    const onClosed = (e: never) => {
      const ev = e as { reason?: string; error?: unknown; address?: unknown };
      const id = idOf(e);
      const auth = ev.reason === 'error' && isAuthFailure(ev.error);
      if (auth) this.authFailure(key, fingerprint, ev.error);
      if (pending.delete(id) && ev.reason === 'error' && !auth) this.refused(key, this.now(), ev.error, ev.address === undefined ? [] : [String(ev.address)]);
      if (ready.delete(id)) entry.ready = ready.size;
    };
    const events: [string, (e: never) => void][] = [['connectionCreated', onCreated], ['connectionReady', onReady], ['connectionCheckedOut', onCheckedOut], ['connectionClosed', onClosed], ['serverHeartbeatFailed', onHeartbeatFailed], ['serverHeartbeatSucceeded', onHeartbeatSucceeded]];
    for (const [name, fn] of events) client.on(name as 'connectionClosed', fn);
    const off = () => {
      for (const [name, fn] of events) (client.off ?? client.removeListener)?.call(client, name as 'connectionClosed', fn);
    };
    const watchOpts = this.o.watch === false ? undefined : this.o.watch === true || this.o.watch === undefined ? {} : this.o.watch;
    if (this.o.monitor) {
      const handle = this.o.monitor.watch(client, { label: key, rules: watchOpts ?? false, onFinding: (f) => this.report(key, f, false) });
      return () => {
        off();
        handle.stop();
      };
    }
    const watcher = watchOpts
      ? new ConnectionWatcher(client, { ...watchOpts, onFinding: (f) => { watchOpts.onFinding?.(f); this.report(key, f, false); } })
      : undefined;
    return () => {
      off();
      watcher?.stop();
    };
  }

  private authFailure(key: string, fingerprint: string, error: unknown): void {
    const opts = this.breakerOpts;
    if (opts.mode === 'off') return;
    const now = this.now();
    const b = this.breaker(key);
    b.lastError = error;
    if (b.open && now < b.openUntil) return;
    const halfOpen = b.open;
    b.failures.push(now);
    b.failedFingerprint = fingerprint;
    while (b.failures.length && b.failures[0]! < now - opts.windowMs) b.failures.shift();
    const storm = this.noteClusterFailure(key, now);
    if (!halfOpen && b.failures.length < (storm ? 1 : opts.threshold)) return;
    this.trip(key, b, now, fingerprint, storm);
  }

  private breaker(key: string): Breaker {
    let b = this.breakers.get(key);
    if (!b) {
      b = { failures: [], attempt: 0, open: false, openUntil: 0, failedFingerprint: undefined, nextPollAt: 0, polling: false, lastError: undefined, storm: false };
      this.breakers.set(key, b);
    }
    return b;
  }

  private trip(key: string, b: Breaker, now: number, fingerprint: string, storm: boolean): void {
    const opts = this.breakerOpts;
    b.attempt++;
    const ceiling = Math.min(opts.maxCooldownMs, opts.baseCooldownMs * 2 ** (b.attempt - 1));
    const cooldownMs = equalJitter(ceiling, () => this.random());
    const failures = b.failures.length;
    b.failures.length = 0;
    if (opts.mode === 'observe') {
      this.emit({ type: 'breakerOpen', key, failures, attempt: b.attempt, cooldownMs, mode: 'observe', storm });
      return;
    }
    b.open = true;
    b.openUntil = now + cooldownMs;
    b.failedFingerprint = fingerprint;
    b.storm = storm;
    if (opts.credentialPollMs > 0) b.nextPollAt = now + equalJitter(opts.credentialPollMs, () => this.random());
    this.emit({ type: 'breakerOpen', key, failures, attempt: b.attempt, cooldownMs, mode: 'enforce', storm });
    // Closing, not just failing fast: rejecting operations would not stop the pool's own refills or the monitors.
    const entry = this.entries.get(key);
    if (entry) this.retire(key, entry, 'breaker', 0);
    this.startGovernor();
  }

  private loginsFailing(key: string, b: Breaker, retryAfterMs: number): TenantLoginsFailingError {
    return new TenantLoginsFailingError(key, retryAfterMs, { cluster: this.clusterOf.get(key), storm: b.storm, cause: b.lastError });
  }

  private cluster(id: string, now: number): Cluster {
    let c = this.clusters.get(id);
    if (!c) {
      c = {
        failing: new Map(), lastFailureAt: 0, storm: false, canaryKey: undefined, canaryAttempt: 0, canaryAt: 0, probes: new TokenBucket(this.breakerOpts.probesPerSecond, now),
        refused: new Map(), refusedNodes: new Map(), nodes: new Map(), lastRefusal: undefined, lastRefusedAt: 0, overloaded: false, overloadSince: 0, admit: new TokenBucket(this.overloadOpts ? this.overloadOpts.admitPerSecond : Infinity, now), trials: new Map(), shed: 0, parked: 0,
      };
      this.clusters.set(id, c);
    }
    return c;
  }

  /** Records an auth failure against the tenant's cluster; returns whether the cluster is in a storm. */
  private noteClusterFailure(key: string, now: number): boolean {
    const storm = this.breakerOpts.storm;
    const id = this.clusterOf.get(key);
    if (!storm || id === undefined) return false;
    const c = this.cluster(id, now);
    this.expireStorm(id, c, now);
    c.lastFailureAt = now;
    c.failing.set(key, now);
    for (const [k, at] of c.failing) if (at < now - storm.windowMs) c.failing.delete(k);
    if (c.storm) return true;
    if (c.failing.size < storm.minTenants) return false;
    c.storm = true;
    c.canaryAttempt = 0;
    c.canaryAt = now + equalJitter(this.breakerOpts.baseCooldownMs, () => this.random());
    this.emit({ type: 'stormStarted', cluster: id, tenants: c.failing.size });
    // The shared cause is now evident: tenants that already failed once stop here instead of paying the full threshold.
    for (const k of c.failing.keys()) {
      if (k === key) continue;
      const b = this.breakers.get(k);
      if (b && !b.open && b.failures.length > 0 && b.failedFingerprint !== undefined) this.trip(k, b, now, b.failedFingerprint, true);
    }
    this.startGovernor();
    return true;
  }

  /**
   * Records a failed establishment against the tenant's cluster; enough distinct tenants make an overload.
   * It counts only if a member it names has answered since it began refusing, or, naming none, if any member
   * of the cluster is answering; otherwise the member is down, not saturated, and shedding would only delay recovery.
   */
  private refused(key: string, now: number, cause: unknown, nodes: string[]): void {
    const o = this.overloadOpts;
    const id = this.clusterOf.get(key);
    if (!o || id === undefined) return;
    const c = this.cluster(id, now);
    this.expireOverload(id, c, now);
    this.pruneRefusals(c, now);
    for (const n of nodes) {
      const s = c.nodes.get(n);
      if (s) s.refusedAt = now;
      else c.nodes.set(n, { refusedAt: now, answeredAt: 0 });
    }
    const answering = (n: string) => {
      const s = c.nodes.get(n);
      return s !== undefined && s.answeredAt > 0 && now - s.answeredAt <= o.windowMs;
    };
    const live = nodes.filter(answering);
    if (nodes.length ? live.length === 0 : ![...c.nodes.keys()].some(answering)) return;
    c.lastRefusedAt = now;
    c.lastRefusal = cause;
    c.refused.set(key, now);
    for (const n of live) c.refusedNodes.set(n, now);
    if (c.overloaded) {
      if (o.mode === 'enforce') this.pruneTrials(c, now, key);
      return;
    }
    if (c.refused.size < o.minTenants) return;
    c.overloaded = true;
    c.overloadSince = now;
    c.shed = 0;
    c.parked = 0;
    this.emit({ type: 'overloadStarted', cluster: id, tenants: c.refused.size, nodes: [...c.refusedNodes.keys()].sort(), mode: o.mode });
    if (o.mode === 'enforce') for (const [k, e] of [...this.entries]) if (e.ready === 0 && this.clusterOf.get(k) === id) this.park(k, c);
    this.startGovernor();
  }

  private pruneRefusals(c: Cluster, now: number): void {
    const o = this.overloadOpts;
    if (!o) return;
    for (const [k, at] of c.refused) if (at < now - o.windowMs) c.refused.delete(k);
    for (const [n, at] of c.refusedNodes) if (at < now - o.windowMs) c.refusedNodes.delete(n);
    for (const [n, s] of c.nodes) if (Math.max(s.refusedAt, s.answeredAt) < now - o.windowMs) c.nodes.delete(n);
  }

  /** A member answered (a heartbeat or an established connection). It counts only after the member refused, within the window. */
  private answered(key: string, node: string): void {
    const o = this.overloadOpts;
    const id = this.clusterOf.get(key);
    if (!o || id === undefined) return;
    const s = this.clusters.get(id)?.nodes.get(node);
    if (!s) return;
    const now = this.now();
    if (now - s.refusedAt <= o.windowMs) s.answeredAt = now;
  }

  /**
   * Gate a tenant without an established connection in an overloaded cluster. Its client would keep asking the
   * node for connections (pool and monitor), so it may hold one only as one of `maxColdTenants` admitted trials.
   */
  private admitNew(key: string, id: string | undefined, now: number): void {
    const o = this.overloadOpts;
    if (!o || o.mode !== 'enforce' || id === undefined) return;
    const c = this.clusters.get(id);
    if (!c) return;
    this.expireOverload(id, c, now);
    if (!c.overloaded) return;
    this.pruneTrials(c, now);
    if (c.trials.has(key)) return;
    const wait = c.trials.size >= o.maxColdTenants ? Math.ceil(1000 / o.admitPerSecond) : c.admit.take(now);
    if (wait <= 0) {
      c.trials.set(key, now);
      return;
    }
    c.shed++;
    this.park(key, c);
    this.pruneRefusals(c, now);
    throw new ClusterRefusingConnectionsError(key, wait, {
      cluster: id, nodes: [...c.refusedNodes.keys()].sort(), refusedTenants: c.refused.size, since: c.overloadSince, windowMs: o.windowMs, cause: c.lastRefusal,
    });
  }

  /** Trials that stayed cold for a whole window give up their slot (and their client); `refusedKey` loses a lapsed or absent one. */
  private pruneTrials(c: Cluster, now: number, refusedKey?: string): void {
    const o = this.overloadOpts;
    if (!o) return;
    for (const [k, at] of c.trials) {
      if (now - at < o.windowMs) continue;
      c.trials.delete(k);
      this.park(k, c);
    }
    if (refusedKey !== undefined && !c.trials.has(refusedKey)) this.park(refusedKey, c);
  }

  /** Close a cold tenant's client now: its monitor and pool stop asking the node for connections. */
  private park(key: string, c: Cluster): void {
    const entry = this.entries.get(key);
    if (!entry || entry.ready > 0) return;
    c.parked++;
    this.retire(key, entry, 'overload', 0);
  }

  /** A tenant established a connection: it no longer needs a trial slot. */
  private warmed(key: string): void {
    const id = this.clusterOf.get(key);
    if (id !== undefined) this.clusters.get(id)?.trials.delete(key);
  }

  private expireOverload(id: string, c: Cluster, now: number): void {
    const o = this.overloadOpts;
    if (!c.overloaded || !o || now - c.lastRefusedAt < o.quietMs) return;
    c.overloaded = false;
    c.refused.clear();
    c.refusedNodes.clear();
    c.lastRefusal = undefined;
    c.trials.clear();
    this.emit({ type: 'overloadEnded', cluster: id, shed: c.shed, parked: c.parked });
  }

  private expireStorm(id: string, c: Cluster, now: number): void {
    const storm = this.breakerOpts.storm;
    if (c.storm && storm && now - c.lastFailureAt >= storm.quietMs) this.endStorm(id, c, 'quiet');
  }

  private endStorm(id: string, c: Cluster, reason: 'quiet' | 'canary'): void {
    if (!c.storm) return;
    c.storm = false;
    c.failing.clear();
    c.canaryKey = undefined;
    this.emit({ type: 'stormEnded', cluster: id, reason });
  }

  /** Polls open breakers for new credentials and ends quiet storms; runs only while there is something to do. */
  private startGovernor(): void {
    if (this.governor || this.closed) return;
    const poll = this.breakerOpts.credentialPollMs;
    this.governor = setInterval(() => this.governorTick(), poll > 0 ? Math.max(100, Math.min(1_000, poll / 4)) : 1_000);
    this.governor.unref();
  }

  private governorTick(): void {
    const now = this.now();
    let busy = false;
    for (const [id, c] of this.clusters) {
      this.expireStorm(id, c, now);
      this.expireOverload(id, c, now);
      if (c.storm || c.overloaded) busy = true;
    }
    const poll = this.breakerOpts.credentialPollMs;
    for (const [key, b] of this.breakers) {
      if (!b.open || now >= b.openUntil || poll <= 0) continue;
      busy = true;
      if (b.polling || now < b.nextPollAt) continue;
      b.polling = true;
      Promise.resolve()
        .then(() => this.o.resolve(key))
        .then((target) => {
          this.clusterOf.set(key, clusterKey(target.uri));
          const fp = target.fingerprint ?? defaultFingerprint(target);
          if (!b.open || fp === b.failedFingerprint) return;
          b.openUntil = Math.min(b.openUntil, this.now());
          this.emit({ type: 'credentialsChanged', key });
        })
        .catch(() => {})
        .finally(() => {
          b.polling = false;
          b.nextPollAt = this.now() + equalJitter(poll, () => this.random());
        });
    }
    if (!busy && this.governor) {
      clearInterval(this.governor);
      this.governor = undefined;
    }
  }

  private maybeRecheck(key: string, entry: Entry<H>, now: number): void {
    if (now - entry.checkedAt < (this.o.credentialCheckMs ?? 300_000)) return;
    entry.checkedAt = now;
    Promise.resolve()
      .then(() => this.o.resolve(key))
      .then((target) => {
        if (this.entries.get(key) !== entry) return;
        if ((target.fingerprint ?? defaultFingerprint(target)) === entry.fingerprint) return;
        entry.stale = true;
        this.emit({ type: 'credentialsChanged', key });
      })
      .catch(() => {});
  }

  private enforceCap(): void {
    const max = this.o.maxPools ?? 100;
    while (this.entries.size >= max) {
      let oldest: [string, Entry<H>] | undefined;
      for (const kv of this.entries) if (!oldest || kv[1].lastUsed < oldest[1].lastUsed) oldest = kv;
      if (!oldest) return;
      this.retire(oldest[0], oldest[1], 'lru');
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    const idle = this.o.evictIdleMs ?? 600_000;
    this.sweeper = setInterval(() => {
      const cutoff = this.now() - idle;
      for (const [key, entry] of this.entries) if (entry.lastUsed < cutoff) this.retire(key, entry, 'idle');
    }, Math.max(250, Math.min(idle / 2, 60_000)));
    this.sweeper.unref();
  }

  private retire(key: string, entry: Entry<H>, reason: 'idle' | 'lru' | 'credentials' | 'breaker' | 'overload', graceMs = this.o.retireGraceMs ?? 30_000): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.detach();
    this.emit({ type: 'retired', key, reason });
    const done = new Promise<unknown>((resolve) => {
      const close = () => void this.closeHandle(entry.handle).then(resolve);
      if (graceMs <= 0) return close();
      const timer = setTimeout(() => {
        this.graceTimers.delete(timer);
        close();
      }, graceMs);
      timer.unref();
      this.graceTimers.set(timer, close);
    });
    this.retiring.add(done);
    void done.then(() => this.retiring.delete(done));
  }

  private report(key: string, finding: ConnectionFinding, once: boolean): void {
    if (once) {
      if (this.reportedRules.has(finding.rule)) return;
      this.reportedRules.add(finding.rule);
    }
    this.emit({ type: 'finding', key, finding });
  }

  private emit(event: TenantPoolEvent): void {
    try {
      this.o.onEvent?.(event);
    } catch {
      // A throwing listener must not break connection handling.
    }
  }
}
