import { isAuthFailure, isNetworkError, errorCode } from './classify.ts';
import { resolveLimits, type DeploymentLimits } from './limits.ts';
import type { ClientOptionsLike, ConnectionFinding, ConnectionRuleId } from './types.ts';

/** The client surface the watcher needs; a driver `MongoClient` (any major) or `mongoose.Connection.getClient()`. */
export interface WatchableClient {
  options?: ClientOptionsLike;
  on(event: string, listener: (e: never) => void): unknown;
  off?(event: string, listener: (e: never) => void): unknown;
  removeListener?(event: string, listener: (e: never) => void): unknown;
}

export interface WatchOptions {
  /** Sliding window for rates and thresholds. Default 60 s. */
  windowMs?: number;
  /** Failed logins per address per window that raise KR-C009. Default 3. */
  authFailureThreshold?: number;
  /** Idle closures per address per window (with minPoolSize > 0) that raise KR-C008. Default 3. */
  idleChurnThreshold?: number;
  /** In-use closures at the socket timeout per address per window that raise KR-C010. Default 3. */
  timeoutCloseThreshold?: number;
  /** For KR-C004: limits, and how many instances run this configuration. */
  deployment?: DeploymentLimits;
  instances?: number;
  /** Fraction of the rate limit the projected fleet rate must reach to raise KR-C004. Default 0.5. */
  churnFraction?: number;
  onFinding?: (finding: ConnectionFinding) => void;
  now?: () => number;
}

interface PoolEvent { address: string; connectionId?: number; reason?: string; error?: unknown }

interface AddressState {
  created: number[];
  idleClosed: number[];
  authFailed: number[];
  timeoutClosed: number[];
  lastNetworkEstablishFailure: number;
  lastUse: Map<number, { start: number; end: number | undefined }>;
  fired: Map<ConnectionRuleId, number>;
  totals: AddressTotals;
}

export interface AddressTotals {
  created: number;
  closed: Record<string, number>;
  authFailures: number;
  timeoutCloses: number;
  networkEstablishFailures: number;
  poolCleared: number;
  poolClearedAfterNetworkFailure: number;
}

/** A pool clear this soon after a network failure to establish is attributed to it (no driver backpressure). */
const CLEAR_ATTRIBUTION_MS = 1_000;
/** A connection whose last checkout ended this recently, and lasted ~socketTimeoutMS, was closed by the timeout. */
const CLOSE_AFTER_USE_MS = 250;

export class ConnectionWatcher {
  readonly findings: ConnectionFinding[] = [];
  /** Errors raised inside the watcher's own handlers; counted, never thrown into the driver. */
  internalErrors = 0;
  private readonly client: WatchableClient;
  private readonly opts: Required<Omit<WatchOptions, 'deployment' | 'onFinding'>> & Pick<WatchOptions, 'onFinding'>;
  private readonly ratePerSec: number | undefined;
  private readonly state = new Map<string, AddressState>();
  private readonly listeners: Array<[string, (e: never) => void]> = [];

  constructor(client: WatchableClient, options: WatchOptions = {}) {
    this.client = client;
    this.opts = {
      windowMs: options.windowMs ?? 60_000,
      authFailureThreshold: options.authFailureThreshold ?? 3,
      idleChurnThreshold: options.idleChurnThreshold ?? 3,
      timeoutCloseThreshold: options.timeoutCloseThreshold ?? 3,
      instances: options.instances ?? 1,
      churnFraction: options.churnFraction ?? 0.5,
      now: options.now ?? Date.now,
      onFinding: options.onFinding,
    };
    this.ratePerSec = resolveLimits(options.deployment).newConnectionsPerSecPerNode;
    this.on('connectionCreated', (e) => this.created(e));
    this.on('connectionCheckedOut', (e) => this.checkedOut(e));
    this.on('connectionCheckedIn', (e) => this.checkedIn(e));
    this.on('connectionClosed', (e) => this.closed(e));
    this.on('connectionPoolCleared', (e) => this.cleared(e));
  }

  /** Totals per server address since the watcher started. */
  stats(): Record<string, AddressTotals> {
    const out: Record<string, AddressTotals> = {};
    for (const [address, s] of this.state) out[address] = { ...s.totals, closed: { ...s.totals.closed } };
    return out;
  }

  stop(): void {
    for (const [event, listener] of this.listeners) (this.client.off ?? this.client.removeListener)?.call(this.client, event, listener);
    this.listeners.length = 0;
  }

  private on(event: string, handler: (e: PoolEvent) => void): void {
    const safe = (e: never) => {
      try {
        handler(e as PoolEvent);
      } catch {
        this.internalErrors++;
      }
    };
    this.client.on(event, safe);
    this.listeners.push([event, safe]);
  }

  private at(address: string): AddressState {
    let s = this.state.get(address);
    if (!s) {
      s = {
        created: [], idleClosed: [], authFailed: [], timeoutClosed: [], lastNetworkEstablishFailure: -Infinity,
        lastUse: new Map(), fired: new Map(),
        totals: { created: 0, closed: {}, authFailures: 0, timeoutCloses: 0, networkEstablishFailures: 0, poolCleared: 0, poolClearedAfterNetworkFailure: 0 },
      };
      this.state.set(address, s);
    }
    return s;
  }

  private push(list: number[], now: number): number {
    list.push(now);
    const floor = now - this.opts.windowMs;
    while (list.length && list[0]! < floor) list.shift();
    return list.length;
  }

  private created(e: PoolEvent): void {
    const now = this.opts.now();
    const s = this.at(e.address);
    s.totals.created++;
    const n = this.push(s.created, now);
    const limit = this.ratePerSec;
    if (!limit) return;
    const perSec = n / (this.opts.windowMs / 1000);
    const fleet = perSec * this.opts.instances;
    if (fleet >= this.opts.churnFraction * limit) {
      this.fire(e.address, now, {
        rule: 'KR-C004', severity: 'warn', title: 'Connection churn near the rate limit',
        message: `${round(perSec)} new connections per second to this node from this process; × ${this.opts.instances} instance(s) = ${round(fleet)}/s against a limit of ${limit}/s. Above the limit the server queues, then drops, connection attempts.`,
        fix: 'Find what is opening connections (KR-C008 idle churn, KR-C010 timeouts, KR-C009 failed logins, or per-request clients) and stop it.',
        evidence: { newConnectionsPerSec: round(perSec), instances: this.opts.instances, projectedFleetPerSec: round(fleet), rateLimitPerSec: limit },
      });
    }
  }

  private checkedOut(e: PoolEvent): void {
    if (e.connectionId === undefined) return;
    this.at(e.address).lastUse.set(e.connectionId, { start: this.opts.now(), end: undefined });
  }

  private checkedIn(e: PoolEvent): void {
    if (e.connectionId === undefined) return;
    const use = this.at(e.address).lastUse.get(e.connectionId);
    if (use) use.end = this.opts.now();
  }

  private closed(e: PoolEvent): void {
    const now = this.opts.now();
    const s = this.at(e.address);
    const reason = e.reason ?? 'unknown';
    s.totals.closed[reason] = (s.totals.closed[reason] ?? 0) + 1;
    const use = e.connectionId === undefined ? undefined : s.lastUse.get(e.connectionId);
    if (e.connectionId !== undefined) s.lastUse.delete(e.connectionId);

    if (reason === 'idle') {
      const minPool = this.client.options?.minPoolSize ?? 0;
      const maxIdle = this.client.options?.maxIdleTimeMS ?? null;
      const n = this.push(s.idleClosed, now);
      const rate = idleRate(s.idleClosed, maxIdle);
      if (minPool > 0 && n >= this.opts.idleChurnThreshold && rate) {
        const { span, perHour } = rate;
        this.fire(e.address, now, {
          rule: 'KR-C008', severity: 'error', title: 'Idle re-login churn',
          message: `${n} idle connections closed in ${Math.round(span / 100) / 10} s and refilled to minPoolSize ${minPool}, each refill a new login: about ${Math.round(perHour)} logins per hour to this node from this client, with or without traffic.`,
          fix: 'Set minPoolSize: 0, or raise maxIdleTimeMS to at least several minutes.',
          evidence: { idleClosures: n, spanMs: span, loginsPerHour: Math.round(perHour), minPoolSize: minPool, maxIdleTimeMS: maxIdle },
        });
      }
      return;
    }
    if (reason !== 'error') return;

    if (e.error && isAuthFailure(e.error)) {
      s.totals.authFailures++;
      const n = this.push(s.authFailed, now);
      if (n >= this.opts.authFailureThreshold) {
        this.fire(e.address, now, {
          rule: 'KR-C009', severity: 'error', title: 'Authentication failure loop',
          message: `${n} logins rejected (code ${errorCode(e.error) ?? '?'}) in the last ${this.opts.windowMs / 1000} s. Each failure clears the pool; the driver rediscovers the server and tries again, indefinitely, with the same credentials. Credentials were probably rotated or revoked.`,
          fix: 'Re-resolve credentials and rebuild the client; stop retrying a client whose logins keep failing (TenantPools does both).',
          evidence: { authFailures: n, windowMs: this.opts.windowMs, code: errorCode(e.error) },
        });
      }
      return;
    }
    if (e.error && isNetworkError(e.error)) {
      s.totals.networkEstablishFailures++;
      s.lastNetworkEstablishFailure = now;
      return;
    }
    const socketTimeout = this.client.options?.socketTimeoutMS ?? 0;
    if (!e.error && use?.end !== undefined && socketTimeout > 0 && now - use.end <= CLOSE_AFTER_USE_MS && use.end - use.start >= 0.9 * socketTimeout) {
      s.totals.timeoutCloses++;
      const n = this.push(s.timeoutClosed, now);
      if (n >= this.opts.timeoutCloseThreshold) {
        this.fire(e.address, now, {
          rule: 'KR-C010', severity: 'warn', title: 'Socket timeout closes connections',
          message: `${n} connections closed after an operation ran past socketTimeoutMS ${socketTimeout} in the last ${this.opts.windowMs / 1000} s; each replacement is a new login.`,
          fix: 'Set socketTimeoutMS: 0 and bound operations with maxTimeMS, which the server enforces without closing the connection.',
          evidence: { timeoutCloses: n, socketTimeoutMS: socketTimeout, windowMs: this.opts.windowMs },
        });
      }
    }
  }

  private cleared(e: PoolEvent): void {
    const now = this.opts.now();
    const s = this.at(e.address);
    s.totals.poolCleared++;
    if (now - s.lastNetworkEstablishFailure > CLEAR_ATTRIBUTION_MS) return;
    s.totals.poolClearedAfterNetworkFailure++;
    this.fire(e.address, now, {
      rule: 'KR-C012', severity: 'warn', title: 'Pool cleared on a connection drop',
      message: `The pool was cleared ${s.totals.poolClearedAfterNetworkFailure} time(s) right after a connection attempt failed at the network level. Every clear fails in-flight operations and re-establishes all connections, which turns connection drops into a reconnect herd.`,
      fix: 'Use mongodb driver 7.1 or later, which keeps the pool and retries with backoff.',
      evidence: { poolClearedAfterNetworkFailure: s.totals.poolClearedAfterNetworkFailure },
    });
  }

  private fire(address: string, now: number, f: Omit<ConnectionFinding, 'address'>): void {
    const s = this.at(address);
    const last = s.fired.get(f.rule);
    if (last !== undefined && now - last < this.opts.windowMs) return;
    s.fired.set(f.rule, now);
    const finding: ConnectionFinding = { ...f, address };
    this.findings.push(finding);
    this.opts.onFinding?.(finding);
  }
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Closures this close together are one batch: connections opened together go idle together. */
const BATCH_MS = 50;

/**
 * Idle closures per hour, measured after the first batch. Connections created together retire together, so the first
 * batch can include one-off connections (the one `connect()` opens, say) and must not be read as rate; later batches
 * are minPoolSize connections each cycle, so counting closures after the first batch is right for any minPoolSize.
 *
 * On a slow machine the one-off connections can retire well over 50 ms apart. A refilled connection cannot be closed
 * as idle until it has been idle for maxIdleTimeMS, so when that is known, every closure within half of it from the
 * first belongs to the first batch.
 */
export function idleRate(closures: readonly number[], maxIdleTimeMS?: number | null): { span: number; perHour: number } | undefined {
  const first = closures[0];
  if (first === undefined) return undefined;
  const window = Math.max(BATCH_MS, (maxIdleTimeMS ?? 0) / 2);
  let batch = 0;
  while (batch < closures.length && closures[batch]! - first <= window) batch++;
  const after = closures.length - batch;
  const span = closures[closures.length - 1]! - first;
  if (after < 2 || span <= 0) return undefined;
  return { span, perHour: (after / span) * 3_600_000 };
}

/** Watch a client's connection-pool events for the KR-C rules. Pool events are always emitted; this adds no per-query cost. */
export function watchConnections(client: WatchableClient, options?: WatchOptions): ConnectionWatcher {
  return new ConnectionWatcher(client, options);
}
