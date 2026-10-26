import { errorCode, errorCodeName, isAuthFailure, isNetworkError } from './classify.ts';
import { FlightRecorder, type RecorderOptions } from './recorder.ts';
import type { ConnectionFinding, ConnectionRuleId } from './types.ts';
import { ConnectionWatcher, type WatchableClient, type WatchOptions } from './watcher.ts';

/**
 * Incident detection that does not need to know the mechanism in advance.
 *
 * Client-side incidents are feedback loops: something fails, the client spends more to compensate, and the spending
 * makes it worse. The common signal is cost without useful work. From pool and SDAM events alone (both emitted
 * without `monitorCommands`):
 * - useful work is checkouts;
 * - cost is churn (`min(created, closed)`, so a pool growing or shrinking is free and only *replacement* costs)
 *   plus failed checkouts.
 * KR-I001 fires per client, node and mechanism; KR-I002 fires when many clients in this process re-establish at once.
 */

export type LoopMechanism = 'auth-failure' | 'unreachable' | 'idle-churn' | 'socket-timeout' | 'pool-clear' | 'connection-error' | 'pool-saturation';
const MECHANISMS: readonly LoopMechanism[] = ['auth-failure', 'unreachable', 'idle-churn', 'socket-timeout', 'pool-clear', 'connection-error', 'pool-saturation'];
const RELATED_RULE: Partial<Record<LoopMechanism, ConnectionRuleId>> = {
  'auth-failure': 'KR-C009', 'idle-churn': 'KR-C008', 'socket-timeout': 'KR-C010', 'pool-clear': 'KR-C012',
};
const FIX: Record<LoopMechanism, string> = {
  'auth-failure': 'Re-read credentials instead of retrying stale ones, and stop the client while they are wrong (TenantPools breaker).',
  unreachable: 'The node is refusing or dropping new connections. Use mongodb 7.1+ (backpressure) and fewer, smaller pools; do not add reconnect logic on top of the driver.',
  'idle-churn': 'Use minPoolSize 0, or maxIdleTimeMS of minutes rather than seconds.',
  'socket-timeout': 'Set socketTimeoutMS 0 and bound operations with maxTimeMS, which ends the operation and keeps the connection.',
  'pool-clear': 'Pool clears are discarding working connections. Find the error behind the clear; with mongodb before 7.1, upgrade for backpressure.',
  'connection-error': 'Connections are dying in use. Check the network path (idle timeouts on load balancers or NAT) and the server log for the same window.',
  'pool-saturation': 'Checkouts are timing out waiting for a connection: find the slow operations holding connections before raising maxPoolSize.',
};

// Window fields.
const CREATED = 0, CLOSED = 1, FAILED = 2, CHECKOUT = 3, MECH0 = 4;
const FIELDS = MECH0 + MECHANISMS.length;
const MECH_INDEX = new Map(MECHANISMS.map((m, i) => [m, MECH0 + i] as const));

/** Counters in one-second buckets over a sliding window. */
class Window {
  private readonly n: number;
  private readonly epoch: Float64Array;
  private readonly counts: Int32Array;
  constructor(seconds: number) {
    this.n = seconds;
    this.epoch = new Float64Array(seconds).fill(-1);
    this.counts = new Int32Array(seconds * FIELDS);
  }
  add(now: number, field: number): void {
    const sec = Math.floor(now / 1000);
    const b = sec % this.n;
    if (this.epoch[b] !== sec) {
      this.epoch[b] = sec;
      this.counts.fill(0, b * FIELDS, (b + 1) * FIELDS);
    }
    this.counts[b * FIELDS + field]!++;
  }
  sum(now: number, field: number): number {
    const sec = Math.floor(now / 1000);
    let total = 0;
    for (let b = 0; b < this.n; b++) {
      const e = this.epoch[b]!;
      if (e > sec - this.n && e <= sec) total += this.counts[b * FIELDS + field]!;
    }
    return total;
  }
}

interface AddressState {
  id: number;
  win: Window;
  /** connectionId → checkout start (positive), or −duration once checked in. */
  uses: Map<number, number>;
  fired: Map<LoopMechanism, number>;
  pendingSec: number;
  pendingCheckouts: number;
}

interface ClientState {
  label: string;
  labelId: number;
  client: WatchableClient;
  addresses: Map<string, AddressState>;
  lastLossAt: number;
  lastCheckoutAt: number;
  listeners: Array<[string, (e: never) => void]>;
  watcher: ConnectionWatcher | undefined;
  onFinding: ((f: ConnectionFinding) => void) | undefined;
}

export interface IncidentMonitorOptions {
  onFinding?: (finding: ConnectionFinding) => void;
  /** The flight recorder; `false` disables it. Default on, in memory only. */
  recorder?: RecorderOptions | false;
  /** KR-I001 window. Default 10 s. */
  windowMs?: number;
  /** KR-I001: events of one mechanism in the window. Default 5. */
  minCost?: number;
  /** KR-I001: cost must be at least this × max(checkouts, 1). Default 0.5. */
  costRatio?: number;
  /** Repeat suppression per client, node and mechanism (KR-I001) and per process (KR-I002). Default 60 s. */
  dedupeMs?: number;
  /** KR-I002: a connection created this soon after a loss is a re-establishment. Default 10 s. */
  reestablishMs?: number;
  /** KR-I002: span in which re-establishments count as one herd. Default 3 s. */
  herdSpanMs?: number;
  /** KR-I002: minimum clients, and fraction of active clients. Defaults 5 and 0.5. */
  herdMinClients?: number;
  herdFraction?: number;
  /** KR-I002: emit once re-establishments are quiet this long, or this long after the herd began. Defaults 2 s, 5 s. */
  herdQuietMs?: number;
  herdMaxMs?: number;
  /** A client is active if it checked out a connection this recently. Default 60 s. */
  activeMs?: number;
  now?: () => number;
}

export interface MonitorWatchOptions {
  /** Shown in findings and dumps. Default `client-<n>`. Must not contain secrets. */
  label?: string;
  /** Also run the per-mechanism connection rules on this client. Default on. */
  rules?: WatchOptions | boolean;
  /** Findings about this client, in addition to the monitor's `onFinding`. */
  onFinding?: (finding: ConnectionFinding) => void;
}

export interface MonitorHandle {
  readonly label: string;
  readonly watcher: ConnectionWatcher | undefined;
  stop(): void;
}

/** Findings severe enough to preserve the evidence. */
const DUMP_RULES = new Set<ConnectionRuleId>(['KR-I001', 'KR-I002', 'KR-C008', 'KR-C009']);
/** Findings are deduplicated, so this bounds a long-running process rather than a busy one. */
const MAX_FINDINGS = 1000;

export class IncidentMonitor {
  readonly findings: ConnectionFinding[] = [];
  readonly recorder: FlightRecorder | undefined;
  /** Errors raised inside the monitor's handlers; counted, never thrown into the driver. */
  internalErrors = 0;
  private readonly o: Required<Omit<IncidentMonitorOptions, 'onFinding' | 'recorder'>> & Pick<IncidentMonitorOptions, 'onFinding'>;
  private readonly clients = new Set<ClientState>();
  private seq = 0;
  private herdNotes: Array<{ c: ClientState; t: number }> = [];
  private herd: { start: number; last: number; clients: Set<ClientState>; timer: ReturnType<typeof setTimeout> | undefined } | undefined;
  private lastHerdAt = -Infinity;
  /** Per node, summed over every watched client: the fleet view of the same cost rule. */
  private readonly fleet = new Map<string, { win: Window; fired: Map<LoopMechanism, number> }>();

  constructor(options: IncidentMonitorOptions = {}) {
    this.o = {
      windowMs: options.windowMs ?? 10_000,
      minCost: options.minCost ?? 5,
      costRatio: options.costRatio ?? 0.5,
      dedupeMs: options.dedupeMs ?? 60_000,
      reestablishMs: options.reestablishMs ?? 10_000,
      herdSpanMs: options.herdSpanMs ?? 3_000,
      herdMinClients: options.herdMinClients ?? 5,
      herdFraction: options.herdFraction ?? 0.5,
      herdQuietMs: options.herdQuietMs ?? 2_000,
      herdMaxMs: options.herdMaxMs ?? 5_000,
      activeMs: options.activeMs ?? 60_000,
      now: options.now ?? Date.now,
      onFinding: options.onFinding,
    };
    if (options.recorder !== false) {
      this.recorder = new FlightRecorder({ now: this.o.now, ...options.recorder });
      this.recorder.beforeDump = () => this.flushCheckouts();
    }
  }

  watch(client: WatchableClient, options: MonitorWatchOptions = {}): MonitorHandle {
    const label = options.label ?? `client-${++this.seq}`;
    const c: ClientState = {
      label, labelId: this.recorder?.intern(label) ?? 0, client, addresses: new Map(),
      lastLossAt: -Infinity, lastCheckoutAt: -Infinity, listeners: [], watcher: undefined, onFinding: options.onFinding,
    };
    this.clients.add(c);
    const on = (event: string, handler: (e: never) => void) => {
      const safe = (e: never) => {
        try {
          handler(e);
        } catch {
          this.internalErrors++;
        }
      };
      client.on(event, safe);
      c.listeners.push([event, safe]);
    };
    on('connectionCreated', (e: PoolEvent) => this.created(c, e));
    on('connectionCheckedOut', (e: PoolEvent) => this.checkedOut(c, e));
    on('connectionCheckedIn', (e: PoolEvent) => this.checkedIn(c, e));
    on('connectionClosed', (e: PoolEvent) => this.closed(c, e));
    on('connectionCheckOutFailed', (e: PoolEvent) => this.checkoutFailed(c, e));
    on('connectionPoolCleared', (e: PoolEvent) => this.cleared(c, e));
    on('serverHeartbeatFailed', (e: HeartbeatFailed) => this.heartbeatFailed(c, e));
    on('serverDescriptionChanged', (e: DescriptionChanged) => this.descriptionChanged(c, e));
    if (options.rules !== false) {
      const ruleOpts = options.rules === true || options.rules === undefined ? {} : options.rules;
      c.watcher = new ConnectionWatcher(client, {
        ...ruleOpts,
        onFinding: (f) => {
          ruleOpts.onFinding?.(f);
          this.emit({ ...f, client: label }, c);
        },
      });
    }
    return {
      label,
      watcher: c.watcher,
      stop: () => this.unwatch(c),
    };
  }

  /** Writes a dump now, regardless of rate limits. Undefined when the recorder is off. */
  dump(reason = 'manual') {
    return this.recorder?.dump(reason);
  }

  stop(): void {
    for (const c of [...this.clients]) this.unwatch(c);
    if (this.herd?.timer) clearTimeout(this.herd.timer);
    this.herd = undefined;
  }

  private unwatch(c: ClientState): void {
    if (!this.clients.delete(c)) return;
    const off = c.client.off ?? c.client.removeListener;
    for (const [event, listener] of c.listeners) off?.call(c.client, event, listener);
    c.listeners.length = 0;
    c.watcher?.stop();
  }

  private at(c: ClientState, address: string): AddressState {
    let s = c.addresses.get(address);
    if (!s) {
      s = {
        id: this.recorder?.intern(address) ?? 0, win: new Window(Math.max(1, Math.round(this.o.windowMs / 1000))),
        uses: new Map(), fired: new Map(), pendingSec: -1, pendingCheckouts: 0,
      };
      c.addresses.set(address, s);
    }
    return s;
  }

  private rec(kind: Parameters<FlightRecorder['record']>[0], now: number, c: ClientState, s: AddressState, reason?: string, error?: unknown): void {
    const r = this.recorder;
    if (!r) return;
    r.record(kind, now, c.labelId, s.id, r.intern(reason), errorCode(error) ?? -1, r.intern(errorCodeName(error)));
  }

  private add(s: AddressState, address: string, now: number, field: number): void {
    s.win.add(now, field);
    let f = this.fleet.get(address);
    if (!f) this.fleet.set(address, (f = { win: new Window(Math.max(1, Math.round(this.o.windowMs / 1000))), fired: new Map() }));
    f.win.add(now, field);
  }

  private created(c: ClientState, e: PoolEvent): void {
    const now = this.o.now();
    const s = this.at(c, e.address);
    this.add(s, e.address, now, CREATED);
    this.rec('created', now, c, s);
    if (now - c.lastLossAt <= this.o.reestablishMs) this.noteReestablish(c, now);
    this.evaluate(c, e.address, s, now);
  }

  private checkedOut(c: ClientState, e: PoolEvent): void {
    const now = this.o.now();
    const s = this.at(c, e.address);
    this.add(s, e.address, now, CHECKOUT);
    c.lastCheckoutAt = now;
    if (e.connectionId !== undefined) s.uses.set(e.connectionId, now);
    if (this.recorder) {
      const sec = Math.floor(now / 1000);
      if (sec !== s.pendingSec) {
        this.flushAddress(c, s);
        s.pendingSec = sec;
      }
      s.pendingCheckouts++;
    }
  }

  private checkedIn(c: ClientState, e: PoolEvent): void {
    if (e.connectionId === undefined) return;
    const s = this.at(c, e.address);
    const start = s.uses.get(e.connectionId);
    if (start !== undefined && start > 0) s.uses.set(e.connectionId, -(this.o.now() - start) || -1e-9);
  }

  private closed(c: ClientState, e: PoolEvent): void {
    if (e.reason === 'poolClosed') return;
    const now = this.o.now();
    const s = this.at(c, e.address);
    if (e.reason === 'idle' && e.connectionId !== undefined && s.uses.has(e.connectionId)) {
      // A connection that did work and then idled out is the pool shrinking, not waste. Only connections retired
      // without ever serving a checkout (the minPoolSize replacement loop) are idle churn.
      s.uses.delete(e.connectionId);
      this.rec('closed', now, c, s, e.reason);
      return;
    }
    let mechanism: LoopMechanism;
    if (e.reason === 'idle') mechanism = 'idle-churn';
    else if (e.reason === 'stale') mechanism = 'pool-clear';
    else if (e.error !== undefined && e.error !== null) mechanism = this.errorMechanism(e.error);
    else mechanism = this.inUseMechanism(c, s, e, now);
    if (e.connectionId !== undefined) s.uses.delete(e.connectionId);
    if (e.reason === 'error' || e.reason === 'stale') c.lastLossAt = now;
    this.add(s, e.address, now, CLOSED);
    this.add(s, e.address, now, MECH_INDEX.get(mechanism)!);
    this.rec('closed', now, c, s, e.reason, e.error);
    this.evaluate(c, e.address, s, now);
  }

  private checkoutFailed(c: ClientState, e: PoolEvent): void {
    if (e.reason === 'poolClosed') return;
    const now = this.o.now();
    const s = this.at(c, e.address);
    const mechanism: LoopMechanism = e.reason === 'timeout' ? 'pool-saturation' : this.errorMechanism(e.error);
    this.add(s, e.address, now, FAILED);
    this.add(s, e.address, now, MECH_INDEX.get(mechanism)!);
    this.rec('checkoutFailed', now, c, s, e.reason, e.error);
    this.evaluate(c, e.address, s, now);
  }

  private cleared(c: ClientState, e: PoolEvent): void {
    const now = this.o.now();
    c.lastLossAt = now;
    this.rec('poolCleared', now, c, this.at(c, e.address));
  }

  private heartbeatFailed(c: ClientState, e: HeartbeatFailed): void {
    const now = this.o.now();
    c.lastLossAt = now;
    if (typeof e.connectionId === 'string') this.rec('heartbeatFailed', now, c, this.at(c, e.connectionId), undefined, e.failure);
  }

  private descriptionChanged(c: ClientState, e: DescriptionChanged): void {
    const before = e.previousDescription?.type;
    const after = e.newDescription?.type;
    if (before === after || typeof e.address !== 'string') return;
    const now = this.o.now();
    if (after === 'Unknown') c.lastLossAt = now;
    this.rec('serverChanged', now, c, this.at(c, e.address), after, e.newDescription?.error);
  }

  private errorMechanism(error: unknown): LoopMechanism {
    if (isAuthFailure(error)) return 'auth-failure';
    if (isNetworkError(error)) return 'unreachable';
    return 'connection-error';
  }

  /** An error closure with no error object: a socket timeout if the last checkout lasted about socketTimeoutMS. */
  private inUseMechanism(c: ClientState, s: AddressState, e: PoolEvent, now: number): LoopMechanism {
    const timeout = c.client.options?.socketTimeoutMS;
    if (!timeout || e.connectionId === undefined) return 'connection-error';
    const use = s.uses.get(e.connectionId);
    if (use === undefined) return 'connection-error';
    const duration = use > 0 ? now - use : -use;
    return duration >= 0.9 * timeout ? 'socket-timeout' : 'connection-error';
  }

  /** The cost gate: replacements plus failed checkouts, against the work done in the same window. */
  private assess(win: Window, now: number) {
    const created = win.sum(now, CREATED);
    const closed = win.sum(now, CLOSED);
    const failed = win.sum(now, FAILED);
    const checkouts = win.sum(now, CHECKOUT);
    const cost = Math.min(created, closed) + failed;
    if (cost < this.o.minCost || cost < this.o.costRatio * Math.max(checkouts, 1)) return undefined;
    return { created, closed, failed, checkouts, cost };
  }

  private loopFinding(mechanism: LoopMechanism, n: number, a: NonNullable<ReturnType<IncidentMonitor['assess']>>, address: string, scope: string): Omit<ConnectionFinding, 'client' | 'clients'> {
    const seconds = this.o.windowMs / 1000;
    return {
      rule: 'KR-I001', severity: 'error', title: 'Amplification loop',
      message: `${a.cost} connections replaced or failed in ${seconds} s against ${a.checkouts} checkouts${scope}; ${n} of those events are ${mechanism}. `
        + 'Each replacement is a new handshake and login, so the client is spending more on connections than on work.',
      fix: FIX[mechanism],
      address,
      evidence: {
        mechanism, mechanismEvents: n, cost: a.cost, created: a.created, closed: a.closed, failedCheckouts: a.failed, checkouts: a.checkouts,
        windowMs: this.o.windowMs, relatedRule: RELATED_RULE[mechanism] ?? null,
      },
    };
  }

  private evaluate(c: ClientState, address: string, s: AddressState, now: number): void {
    const a = this.assess(s.win, now);
    if (a) {
      for (const mechanism of MECHANISMS) {
        const n = s.win.sum(now, MECH_INDEX.get(mechanism)!);
        if (n < this.o.minCost) continue;
        const last = s.fired.get(mechanism);
        if (last !== undefined && now - last < this.o.dedupeMs) continue;
        s.fired.set(mechanism, now);
        this.emit({ ...this.loopFinding(mechanism, n, a, address, ''), client: c.label }, c);
      }
    }
    if (this.clients.size >= 2) this.evaluateFleet(address, now);
  }

  /**
   * The same rule over every watched client of one node. Catches a fleet in which each client stays under the threshold
   * while the node receives the sum, e.g. tenants whose drivers each self-throttle failed logins to ~2 per 10 s.
   */
  private evaluateFleet(address: string, now: number): void {
    const f = this.fleet.get(address);
    if (!f) return;
    const a = this.assess(f.win, now);
    if (!a) return;
    for (const mechanism of MECHANISMS) {
      const field = MECH_INDEX.get(mechanism)!;
      const n = f.win.sum(now, field);
      if (n < this.o.minCost) continue;
      const last = f.fired.get(mechanism);
      if (last !== undefined && now - last < this.o.dedupeMs) continue;
      const contributors: string[] = [];
      for (const c of this.clients) if ((c.addresses.get(address)?.win.sum(now, field) ?? 0) > 0) contributors.push(c.label);
      if (contributors.length < 2) continue;
      f.fired.set(mechanism, now);
      const scope = ` across ${contributors.length} clients`;
      this.emit({ ...this.loopFinding(mechanism, n, a, address, scope), client: '*', clients: contributors }, undefined);
    }
  }

  private noteReestablish(c: ClientState, now: number): void {
    if (this.herd) {
      if (!this.herd.clients.has(c)) this.herd.last = now;
      this.herd.clients.add(c);
      return;
    }
    if (now - this.lastHerdAt < this.o.dedupeMs) return;
    const floor = now - this.o.herdSpanMs;
    this.herdNotes = this.herdNotes.filter((n) => n.t >= floor);
    this.herdNotes.push({ c, t: now });
    const distinct = new Set(this.herdNotes.map((n) => n.c));
    if (distinct.size < this.threshold(now)) return;
    this.herd = { start: Math.min(...this.herdNotes.map((n) => n.t)), last: now, clients: distinct, timer: undefined };
    this.herdNotes = [];
    this.scheduleHerd();
  }

  private threshold(now: number): number {
    let active = 0;
    for (const c of this.clients) if (now - c.lastCheckoutAt <= this.o.activeMs) active++;
    return Math.max(this.o.herdMinClients, Math.ceil(this.o.herdFraction * active));
  }

  private scheduleHerd(): void {
    const h = this.herd;
    if (!h) return;
    h.timer = setTimeout(() => {
      try {
        const now = this.o.now();
        if (now - h.last < this.o.herdQuietMs && now - h.start < this.o.herdMaxMs) return this.scheduleHerd();
        this.emitHerd(h, now);
      } catch {
        this.internalErrors++;
      }
    }, 250);
    h.timer.unref?.();
  }

  private emitHerd(h: NonNullable<IncidentMonitor['herd']>, now: number): void {
    this.herd = undefined;
    this.lastHerdAt = now;
    let active = 0;
    for (const c of this.clients) if (now - c.lastCheckoutAt <= this.o.activeMs) active++;
    const labels = [...h.clients].map((c) => c.label).sort();
    this.emit({
      rule: 'KR-I002', severity: 'error', title: 'Reconnect herd',
      message: `${labels.length} clients (of ${active} active, ${this.clients.size} watched) re-established connections within `
        + `${Math.round((h.last - h.start) / 100) / 10} s of losing them. Every one is a handshake and login against the same nodes at the same moment.`,
      fix: 'Keep fewer clients connected (evict idle tenants), spread reconnects with jitter, use mongodb 7.1+ for backpressure, and do not add reconnect loops on top of the driver.',
      clients: labels,
      evidence: { clients: labels.length, active, watched: this.clients.size, spanMs: Math.round(h.last - h.start) },
    }, undefined);
  }

  private emit(finding: ConnectionFinding, c: ClientState | undefined): void {
    this.findings.push(finding);
    if (this.findings.length > MAX_FINDINGS) this.findings.shift();
    const r = this.recorder;
    if (r) {
      const addressId = finding.address ? r.intern(finding.address) : 0;
      r.noteFinding(finding, c?.labelId ?? 0, addressId);
    }
    try {
      c?.onFinding?.(finding);
      this.o.onFinding?.(finding);
    } catch {
      this.internalErrors++;
    }
    if (r && finding.severity === 'error' && DUMP_RULES.has(finding.rule)) {
      // Keyed per mechanism for I001 (reason "KR-I001:auth-failure"), so an earlier idle-churn dump cannot suppress a
      // later auth-failure one.
      const mechanism = finding.rule === 'KR-I001' ? finding.evidence.mechanism : undefined;
      r.trigger(mechanism ? `${finding.rule}:${String(mechanism)}` : finding.rule);
    }
  }

  private flushAddress(c: ClientState, s: AddressState): void {
    if (s.pendingCheckouts > 0 && this.recorder) {
      this.recorder.record('checkouts', s.pendingSec * 1000, c.labelId, s.id, 0, -1, 0, s.pendingCheckouts);
    }
    s.pendingCheckouts = 0;
  }

  private flushCheckouts(): void {
    for (const c of this.clients) for (const s of c.addresses.values()) this.flushAddress(c, s);
  }
}

interface PoolEvent { address: string; connectionId?: number; reason?: string; error?: unknown }
interface HeartbeatFailed { connectionId?: string; failure?: unknown }
interface DescriptionChanged {
  address?: string;
  previousDescription?: { type?: string };
  newDescription?: { type?: string; error?: unknown };
}
