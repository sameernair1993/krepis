import { isAuthFailure, isNetworkError, errorCode } from './classify.ts';
import { resolveLimits, type DeploymentLimits } from './limits.ts';
import { monitorsPerNode } from './preflight.ts';
import type { ClientOptionsLike, ConnectionFinding, ConnectionHolders, ConnectionRuleId } from './types.ts';

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
  /** KR-C006: report operations that wait for a connection because all of them are in use. Default true. */
  checkoutWaits?: boolean;
  /** KR-C006: the shortest wait that counts. Default 100 ms. */
  checkoutWaitMs?: number;
  /** KR-C006: waits per address per window that raise it. Default 3. */
  checkoutWaitThreshold?: number;
  /** KR-C006: names what held the connections; pass `observer.holders()` from `@sameernair/krepis-kit`. */
  holders?: ConnectionHolders;
  /** KR-C005: report connections the network dropped while idle, with a recommended maxIdleTimeMS. Default true. */
  idleDrops?: boolean;
  /** KR-C005: drops per address per window that raise it. Default 3. */
  idleDropThreshold?: number;
  /** KR-C002: report a maxPoolSize far above the measured peak when the fleet's demand at it nears the node limit (needs `deployment`). Default true. */
  oversizedPool?: boolean;
  /** KR-C002: how long an address is observed before its peak is judged, and how often it may fire. Default 1 hour. */
  poolObserveMs?: number;
  onFinding?: (finding: ConnectionFinding) => void;
  now?: () => number;
}

interface PoolEvent { address: string; connectionId?: number; reason?: string; error?: unknown; durationMS?: number }

/** A held connection given back while a KR-C006 wait was queued. `holder` is undefined when unnamed. */
interface Hold { at: number; ms: number; holder: string | undefined }

interface AddressState {
  created: number[];
  idleClosed: number[];
  authFailed: number[];
  timeoutClosed: number[];
  lastNetworkEstablishFailure: number;
  lastUse: Map<number, { start: number; end: number | undefined; idle: number | undefined }>;
  fired: Map<ConnectionRuleId, number>;
  totals: AddressTotals;
  // KR-C006: connections checked out, checkouts not yet served (full: the pool had no room when it began),
  // counted waits, and holds that ended while a counted checkout was queued.
  inUse: Set<number>;
  queue: Array<{ start: number; full: boolean }>;
  waits: Array<{ at: number; ms: number }>;
  holds: Hold[];
  // KR-C005: reuses after idling (id identifies the one a same-tick closure turns into a drop), drops, last pool clear.
  reused: Array<{ at: number; idle: number; id: number }>;
  drops: Array<{ at: number; idle: number }>;
  lastCleared: number;
  // KR-C002: most connections checked out at once, checkouts, and when the first was.
  peak: number;
  checkouts: number;
  firstCheckout: number;
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
/** Bounds KR-C006's per-address lists if events go missing. */
const MAX_TRACKED = 10_000;
/** KR-C005 ignores shorter idles: no network path times flows out this fast, and blips fail busy connections. */
const MIN_DROP_IDLE_MS = 1_000;
/** KR-C002 judges a peak only after this many checkouts, and never recommends fewer connections than this. */
const MIN_POOL_CHECKOUTS = 100;
const MIN_RECOMMENDED_POOL = 5;
/** KR-C002: the fraction of the node's connection limit the fleet's demand at maxPoolSize must reach. */
const POOL_DEMAND_FRACTION = 0.5;

export class ConnectionWatcher {
  readonly findings: ConnectionFinding[] = [];
  /** Errors raised inside the watcher's own handlers; counted, never thrown into the driver. */
  internalErrors = 0;
  private readonly client: WatchableClient;
  private readonly opts: Required<Omit<WatchOptions, 'deployment' | 'onFinding' | 'holders'>> & Pick<WatchOptions, 'onFinding' | 'holders'>;
  private readonly ratePerSec: number | undefined;
  private readonly connectionLimit: number | undefined;
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
      checkoutWaits: options.checkoutWaits ?? true,
      checkoutWaitMs: options.checkoutWaitMs ?? 100,
      checkoutWaitThreshold: options.checkoutWaitThreshold ?? 3,
      holders: options.holders,
      idleDrops: options.idleDrops ?? true,
      idleDropThreshold: options.idleDropThreshold ?? 3,
      oversizedPool: options.oversizedPool ?? true,
      poolObserveMs: options.poolObserveMs ?? 3_600_000,
      now: options.now ?? Date.now,
      onFinding: options.onFinding,
    };
    this.ratePerSec = resolveLimits(options.deployment).newConnectionsPerSecPerNode;
    this.connectionLimit = resolveLimits(options.deployment).maxConnectionsPerNode;
    this.on('connectionCreated', (e) => this.created(e));
    this.on('connectionCheckedOut', (e) => this.checkedOut(e));
    this.on('connectionCheckedIn', (e) => this.checkedIn(e));
    this.on('connectionClosed', (e) => this.closed(e));
    this.on('connectionPoolCleared', (e) => this.cleared(e));
    if (this.opts.checkoutWaits) {
      this.on('connectionCheckOutStarted', (e) => this.checkOutStarted(e));
      this.on('connectionCheckOutFailed', (e) => this.served(e, this.opts.now(), true));
    }
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
        inUse: new Set(), queue: [], waits: [], holds: [], reused: [], drops: [], lastCleared: -Infinity,
        peak: 0, checkouts: 0, firstCheckout: -Infinity,
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
    const now = this.opts.now();
    if (this.opts.checkoutWaits) this.served(e, now, false);
    if (e.connectionId === undefined) return;
    const s = this.at(e.address);
    const prev = s.lastUse.get(e.connectionId);
    s.lastUse.set(e.connectionId, { start: now, end: undefined, idle: prev?.end === undefined ? undefined : now - prev.end });
    s.inUse.add(e.connectionId);
    if (s.checkouts++ === 0) s.firstCheckout = now;
    if (s.inUse.size > s.peak) s.peak = s.inUse.size;
  }

  private checkedIn(e: PoolEvent): void {
    if (e.connectionId === undefined) return;
    const now = this.opts.now();
    const s = this.at(e.address);
    const use = s.lastUse.get(e.connectionId);
    if (use) use.end = now;
    if (this.opts.idleDrops && use?.idle !== undefined) {
      s.reused.push({ at: now, idle: use.idle, id: e.connectionId });
      this.prune(s.reused, now);
    }
    s.inUse.delete(e.connectionId);
    if (this.opts.oversizedPool && this.connectionLimit) this.oversized(e.address, s, now, this.connectionLimit);
    if (!this.opts.checkoutWaits) return;
    // Asked at every check-in, so a name is never carried over to a later command it did not record.
    const holder = this.opts.holders?.heldBy(e.address, e.connectionId);
    if (use && s.queue.some((q) => q.full)) {
      s.holds.push({ at: now, ms: now - use.start, holder });
      this.prune(s.holds, now);
    }
  }

  private checkOutStarted(e: PoolEvent): void {
    const s = this.at(e.address);
    const max = this.client.options?.maxPoolSize ?? 100;
    s.queue.push({ start: this.opts.now(), full: max > 0 && s.inUse.size + s.queue.length >= max });
    if (s.queue.length > MAX_TRACKED) s.queue.shift();
  }

  /**
   * KR-C005. A connection closed with reason `error` (and no error: not a failure to establish) after idling. Closed
   * right after its check-in, it failed on first use after `use.idle`; closed later, the peer closed it in the pool,
   * after `now - use.end`, unless the pool was cleared meanwhile (a restart or failover closes every connection).
   */
  private idleDrop(address: string, s: AddressState, id: number, use: { start: number; end: number; idle: number | undefined }, now: number): void {
    const onUse = now - use.end <= CLOSE_AFTER_USE_MS;
    if (!onUse && s.lastCleared > use.end) return;
    const idle = onUse ? use.idle : now - use.end;
    if (idle === undefined || idle < MIN_DROP_IDLE_MS) return;
    // The check-in just before this closure was not a successful reuse.
    if (onUse) {
      const last = s.reused[s.reused.length - 1];
      if (last?.id === id && last.at === use.end) s.reused.pop();
    }
    s.drops.push({ at: now, idle });
    this.prune(s.drops, now);
    this.prune(s.reused, now);
    if (s.drops.length < this.opts.idleDropThreshold) return;
    const shortest = Math.min(...s.drops.map((d) => d.idle));
    const longestOk = s.reused.reduce((m, r) => Math.max(m, r.idle), -1);
    // A path with an idle timeout drops every connection idle beyond it; one reused fine after as long is not that.
    if (longestOk >= shortest) return;
    const last = s.fired.get('KR-C005');
    if (last !== undefined && now - last < this.opts.windowMs) return;
    const raw = longestOk >= shortest / 2 ? longestOk : shortest / 2;
    const step = raw >= 10_000 ? 1_000 : 100;
    const recommended = Math.max(step, Math.floor(raw / step) * step);
    const minPool = this.client.options?.minPoolSize ?? 0;
    const current = this.client.options?.maxIdleTimeMS || null;
    const sec = (ms: number) => `${Math.round(ms / 100) / 10} s`;
    this.fire(address, now, {
      rule: 'KR-C005', severity: 'warn', title: 'Idle connections dropped by the network',
      message: `${s.drops.length} pooled connections failed after idling (shortest idle ${sec(shortest)}) in the last ${this.opts.windowMs / 1000} s, `
        + `while ${longestOk >= MIN_DROP_IDLE_MS ? `connections idle up to ${sec(longestOk)} were reused fine` : 'no connection was reused after idling a second or more'}. Something between this process and the server (a NAT gateway, firewall or load balancer) is forgetting idle connections. Each drop costs a new connection and a login, and when the drop fails an operation, the driver also clears the pool.`,
      fix: `Set maxIdleTimeMS to ${recommended}${current ? ` (now ${current})` : ''}, below the network path's idle timeout, so the pool retires connections before the network drops them${minPool > 0 ? ', with minPoolSize: 0 so retired connections are not refilled (KR-C008)' : ''}.`,
      evidence: { drops: s.drops.length, shortestDropIdleMs: Math.round(shortest), longestReusedIdleMs: longestOk >= 0 ? Math.round(longestOk) : null, recommendedMaxIdleTimeMS: recommended, maxIdleTimeMS: current, windowMs: this.opts.windowMs },
    });
  }

  /**
   * KR-C002. The pool opens connections on demand, so a cap far above the peak costs nothing until the server slows
   * down and the pool grows to it; judged only against a known node limit, after `poolObserveMs` of checkouts.
   */
  private oversized(address: string, s: AddressState, now: number, limit: number): void {
    const observed = now - s.firstCheckout;
    if (observed < this.opts.poolObserveMs || s.checkouts < MIN_POOL_CHECKOUTS) return;
    const last = s.fired.get('KR-C002');
    if (last !== undefined && now - last < this.opts.poolObserveMs) return;
    const max = this.client.options?.maxPoolSize || 100;
    const recommended = Math.max(MIN_RECOMMENDED_POOL, 2 * s.peak);
    if (recommended > max / 2) return;
    const monitors = monitorsPerNode(this.client.options?.serverMonitoringMode);
    const instances = this.opts.instances;
    const demand = instances * (max + monitors);
    if (demand < POOL_DEMAND_FRACTION * limit) return;
    const after = instances * (recommended + monitors);
    const span = observed < 120_000 ? `${Math.round(observed / 1000)} s` : `${Math.round(observed / 60_000)} min`;
    this.fire(address, now, {
      rule: 'KR-C002', severity: 'warn', title: 'Pool far larger than its peak',
      message: `At most ${s.peak} of maxPoolSize ${max} connections to this node were checked out at once in ${span} (${s.checkouts} checkouts). `
        + `At maxPoolSize ${max}, ${instances} instance(s) × (${max} + ${monitors} monitoring) = ${demand} connections to this node, ${Math.round((demand / limit) * 100)}% of its ${limit} limit. `
        + 'A pool grows to its cap when the server slows down, and each new connection is a login.',
      fix: `Set maxPoolSize to ${recommended} (twice the observed peak; ${instances} × (${recommended} + ${monitors}) = ${after} per node), with waitQueueTimeoutMS so a saturated pool fails fast. `
        + 'The peak is only what was seen while watched: if KR-C006 then reports waits, raise it.',
      evidence: {
        peakCheckedOut: s.peak, maxPoolSize: max, checkouts: s.checkouts, observedMs: Math.round(observed), instances, monitorsPerNode: monitors,
        demandPerNode: demand, maxConnectionsPerNode: limit, recommendedMaxPoolSize: recommended, demandAfterPerNode: after,
      },
    });
  }

  /** A checkout was served or failed. The driver serves its wait queue first in, first out. */
  private served(e: PoolEvent, now: number, failed: boolean): void {
    const s = this.at(e.address);
    const entry = s.queue.shift();
    if (!entry?.full) return;
    const ms = e.durationMS ?? now - entry.start;
    if (failed ? e.reason !== 'timeout' : ms < this.opts.checkoutWaitMs) return;
    s.waits.push({ at: now, ms });
    this.prune(s.waits, now);
    if (s.waits.length >= this.opts.checkoutWaitThreshold) this.fireWaits(e.address, s, now);
  }

  private prune(list: Array<{ at: number }>, now: number): void {
    const floor = now - this.opts.windowMs;
    while (list.length && (list[0]!.at < floor || list.length > MAX_TRACKED)) list.shift();
  }

  private fireWaits(address: string, s: AddressState, now: number): void {
    const last = s.fired.get('KR-C006');
    if (last !== undefined && now - last < this.opts.windowMs) return;
    const waits = s.waits.map((w) => Math.round(w.ms)).sort((a, b) => a - b);
    const max = this.client.options?.maxPoolSize ?? 100;
    const evidence: ConnectionFinding['evidence'] = {
      waited: waits.length, longestWaitMs: waits[waits.length - 1]!, medianWaitMs: waits[waits.length >> 1]!,
      checkoutWaitMs: this.opts.checkoutWaitMs, maxPoolSize: max, windowMs: this.opts.windowMs,
    };
    let held = '';
    if (this.opts.holders) {
      const by = new Map<string | undefined, { ms: number; n: number; longest: number }>();
      let total = 0;
      for (const h of s.holds) {
        const t = by.get(h.holder) ?? { ms: 0, n: 0, longest: 0 };
        t.ms += h.ms;
        t.n++;
        t.longest = Math.max(t.longest, h.ms);
        by.set(h.holder, t);
        total += h.ms;
      }
      const pct = (ms: number) => (total > 0 ? Math.round((ms / total) * 100) : 0);
      const named = [...by].filter(([k]) => k !== undefined).sort((a, b) => b[1].ms - a[1].ms).slice(0, 3);
      named.forEach(([name, t], i) => {
        Object.assign(evidence, { [`holder${i + 1}`]: name!, [`holder${i + 1}SharePct`]: pct(t.ms), [`holder${i + 1}Holds`]: t.n, [`holder${i + 1}LongestMs`]: Math.round(t.longest) });
      });
      const unnamed = pct(by.get(undefined)?.ms ?? 0);
      evidence.unnamedSharePct = unnamed;
      held = named.length
        ? ` Held longest by: ${named.map(([name, t]) => `${name} (${pct(t.ms)}% of held time, ${t.n} hold(s), longest ${Math.round(t.longest)} ms)`).join('; ')}.`
        : '';
      if (unnamed > 0) held += ` ${unnamed}% of held time was commands the observer did not record (outside a unit of work).`;
    } else {
      held = ' Pass `holders: observer.holders()` (krepis-kit) to name the queries holding them.';
    }
    this.fire(address, now, {
      rule: 'KR-C006', severity: 'warn', title: 'Operations wait for a connection',
      message: `${waits.length} operations waited at least ${this.opts.checkoutWaitMs} ms for a connection in the last ${this.opts.windowMs / 1000} s because all ${max} were in use (longest ${evidence.longestWaitMs} ms, median ${evidence.medianWaitMs} ms).${held}`,
      fix: 'Make the queries holding connections faster (an index, a bound, maxTimeMS) or move them off the request path. Raise maxPoolSize only if the server has headroom: more connections running the same slow query make each one slower.',
      evidence,
    });
  }

  private closed(e: PoolEvent): void {
    const now = this.opts.now();
    const s = this.at(e.address);
    const reason = e.reason ?? 'unknown';
    s.totals.closed[reason] = (s.totals.closed[reason] ?? 0) + 1;
    const use = e.connectionId === undefined ? undefined : s.lastUse.get(e.connectionId);
    if (e.connectionId !== undefined) {
      s.lastUse.delete(e.connectionId);
      s.inUse.delete(e.connectionId);
    }

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
    if (!e.error && use?.end !== undefined && this.opts.idleDrops && e.connectionId !== undefined) this.idleDrop(e.address, s, e.connectionId, { ...use, end: use.end }, now);
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
    s.lastCleared = now;
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
