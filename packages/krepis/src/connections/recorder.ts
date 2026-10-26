import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectionFinding } from './types.ts';

/**
 * A flight recorder for connection incidents.
 *
 * The first question after an incident is "what started it?", and by then the evidence is gone. The recorder keeps
 * the last few minutes of connection events in a fixed-capacity ring and writes them out when a rule fires. Records
 * live in typed arrays, so recording allocates nothing per event; strings (labels, addresses, reasons, error code
 * names) are interned once. Nothing that could hold a secret is stored: no URIs, no error messages, only error
 * codes and code names, and the labels the caller chose.
 */

export type RecordKind = 'created' | 'closed' | 'checkoutFailed' | 'poolCleared' | 'heartbeatFailed' | 'serverChanged' | 'checkouts' | 'finding';
const KINDS: readonly RecordKind[] = ['created', 'closed', 'checkoutFailed', 'poolCleared', 'heartbeatFailed', 'serverChanged', 'checkouts', 'finding'];
const KIND_INDEX = new Map(KINDS.map((k, i) => [k, i] as const));

export interface RecorderOptions {
  /** Records kept. Default 16384 (about 600 KB). */
  capacity?: number;
  /** How far back a dump reaches. Default 120 s. */
  spanMs?: number;
  /** Write each dump as JSON into this directory. */
  dumpDir?: string;
  /** Receive each dump. Called synchronously; keep it cheap. */
  onDump?: (dump: IncidentDump) => void;
  /** Automatic dumps per rule are at most this often. Default 60 s. */
  minDumpIntervalMs?: number;
  /** Cost events further apart than this start a new run. Default 15 s: longer than the 10 s heartbeat that paces a failing driver's retries. */
  runGapMs?: number;
  now?: () => number;
}

export interface RecordedEvent {
  /** Milliseconds relative to the dump (negative: before it). */
  t: number;
  kind: RecordKind;
  client?: string;
  address?: string;
  reason?: string;
  code?: number;
  codeName?: string;
  /** Checkouts in that second, for `checkouts`; otherwise unused. */
  value?: number;
}

export interface FirstMover {
  client: string;
  /** Onset of the client's current run of cost, relative to the dump. */
  onsetMs: number;
  /** Cost events in that run. */
  events: number;
  /** The most common reason or code name in the run. */
  dominant: string;
}

export type IncidentOrdering = 'client-before-server' | 'server-before-client' | 'simultaneous' | 'no-server-signal' | 'none';

export interface IncidentDump {
  version: 1;
  reason: string;
  at: string;
  spanMs: number;
  /** True when the ring wrapped inside the span, so the oldest part of the span is missing. */
  truncated: boolean;
  events: RecordedEvent[];
  findings: ConnectionFinding[];
  analysis: {
    firstMovers: FirstMover[];
    firstHeartbeatFailure: { t: number; client?: string; address?: string; codeName?: string } | null;
    firstAuthFailure: { t: number; client?: string; address?: string } | null;
    /** Whether clients started paying for connections before the server showed any sign of trouble. */
    ordering: IncidentOrdering;
  };
}

const MAX_STRINGS = 10_000;
const MAX_FINDINGS = 200;
const ORDERING_SLACK_MS = 1_000;
const AUTH_FAILED = 18;

export class FlightRecorder {
  /** Errors writing dumps or in `onDump`; counted, never thrown. */
  internalErrors = 0;
  /** Called before each dump so producers can flush aggregated records (checkout counts). */
  beforeDump: (() => void) | undefined;
  private readonly cap: number;
  private readonly o: Required<Pick<RecorderOptions, 'spanMs' | 'minDumpIntervalMs' | 'runGapMs' | 'now'>> & Pick<RecorderOptions, 'dumpDir' | 'onDump'>;
  private readonly t: Float64Array;
  private readonly kind: Uint8Array;
  private readonly client: Uint32Array;
  private readonly address: Uint32Array;
  private readonly reason: Uint32Array;
  private readonly codeName: Uint32Array;
  private readonly code: Int32Array;
  private readonly value: Float64Array;
  private next = 0;
  private count = 0;
  private readonly strings: string[] = [''];
  private readonly ids = new Map<string, number>();
  private readonly findings: Array<{ at: number; finding: ConnectionFinding }> = [];
  private readonly lastDump = new Map<string, number>();

  constructor(options: RecorderOptions = {}) {
    this.cap = Math.max(16, Math.floor(options.capacity ?? 16_384));
    this.o = {
      spanMs: options.spanMs ?? 120_000,
      minDumpIntervalMs: options.minDumpIntervalMs ?? 60_000,
      runGapMs: options.runGapMs ?? 15_000,
      now: options.now ?? Date.now,
      dumpDir: options.dumpDir,
      onDump: options.onDump,
    };
    this.t = new Float64Array(this.cap);
    this.kind = new Uint8Array(this.cap);
    this.client = new Uint32Array(this.cap);
    this.address = new Uint32Array(this.cap);
    this.reason = new Uint32Array(this.cap);
    this.codeName = new Uint32Array(this.cap);
    this.code = new Int32Array(this.cap);
    this.value = new Float64Array(this.cap);
  }

  get size(): number {
    return this.count;
  }

  /** Interns a string; 0 is "none". Past the cap, new strings share one overflow id rather than growing without bound. */
  intern(s: string | undefined | null): number {
    if (!s) return 0;
    const id = this.ids.get(s);
    if (id !== undefined) return id;
    if (this.strings.length >= MAX_STRINGS) return this.intern('(overflow)');
    this.strings.push(s);
    this.ids.set(s, this.strings.length - 1);
    return this.strings.length - 1;
  }

  /** Records one event. String arguments are interned ids from `intern()`. */
  record(kind: RecordKind, at: number, client: number, address: number, reason = 0, code = -1, codeName = 0, value = 0): void {
    const i = this.next;
    this.t[i] = at;
    this.kind[i] = KIND_INDEX.get(kind)!;
    this.client[i] = client;
    this.address[i] = address;
    this.reason[i] = reason;
    this.code[i] = code;
    this.codeName[i] = codeName;
    this.value[i] = value;
    this.next = (i + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }

  noteFinding(finding: ConnectionFinding, client: number, address: number): void {
    const at = this.o.now();
    this.findings.push({ at, finding });
    if (this.findings.length > MAX_FINDINGS) this.findings.shift();
    this.record('finding', at, client, address, this.intern(finding.rule));
  }

  /** An automatic dump for `reason`, at most once per `minDumpIntervalMs` per reason. */
  trigger(reason: string): IncidentDump | undefined {
    const now = this.o.now();
    const last = this.lastDump.get(reason);
    if (last !== undefined && now - last < this.o.minDumpIntervalMs) return undefined;
    this.lastDump.set(reason, now);
    return this.dump(reason);
  }

  /** Builds a dump of the last `spanMs`, delivers it to `onDump` and `dumpDir`, and returns it. */
  dump(reason: string): IncidentDump {
    try {
      this.beforeDump?.();
    } catch {
      this.internalErrors++;
    }
    const at = this.o.now();
    const from = at - this.o.spanMs;
    const events: RecordedEvent[] = [];
    const start = (this.next - this.count + this.cap) % this.cap;
    let truncated = false;
    for (let n = 0; n < this.count; n++) {
      const i = (start + n) % this.cap;
      if (this.t[i]! < from) continue;
      if (n === 0 && this.count === this.cap) truncated = true;
      events.push(this.decode(i, at));
    }
    events.sort((a, b) => a.t - b.t);
    const dump: IncidentDump = {
      version: 1,
      reason,
      at: new Date(at).toISOString(),
      spanMs: this.o.spanMs,
      truncated,
      events,
      findings: this.findings.filter((f) => f.at >= from).map((f) => f.finding),
      analysis: analyse(events, this.o.runGapMs),
    };
    this.deliver(dump);
    return dump;
  }

  private decode(i: number, at: number): RecordedEvent {
    const e: RecordedEvent = { t: Math.round(this.t[i]! - at), kind: KINDS[this.kind[i]!]! };
    if (this.client[i]) e.client = this.strings[this.client[i]!];
    if (this.address[i]) e.address = this.strings[this.address[i]!];
    if (this.reason[i]) e.reason = this.strings[this.reason[i]!];
    if (this.code[i]! >= 0) e.code = this.code[i]!;
    if (this.codeName[i]) e.codeName = this.strings[this.codeName[i]!];
    if (e.kind === 'checkouts') e.value = this.value[i]!;
    return e;
  }

  private deliver(dump: IncidentDump): void {
    try {
      this.o.onDump?.(dump);
    } catch {
      this.internalErrors++;
    }
    const dir = this.o.dumpDir;
    if (!dir) return;
    const file = join(dir, `krepis-incident-${dump.at.replace(/[:.]/g, '-')}-${dump.reason.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
    mkdir(dir, { recursive: true })
      .then(() => writeFile(file, JSON.stringify(dump, null, 2)))
      .catch(() => { this.internalErrors++; });
  }
}

/** Cost events for the first-mover analysis: connections lost to errors or pool clears, and failed checkouts. */
function isCost(e: RecordedEvent): boolean {
  if (e.kind === 'checkoutFailed') return e.reason !== 'poolClosed';
  return e.kind === 'closed' && (e.reason === 'error' || e.reason === 'stale');
}

function isAuth(e: RecordedEvent): boolean {
  return (e.kind === 'closed' || e.kind === 'checkoutFailed') && (e.code === AUTH_FAILED || e.codeName === 'AuthenticationFailed');
}

export function analyse(events: readonly RecordedEvent[], runGapMs: number): IncidentDump['analysis'] {
  const byClient = new Map<string, RecordedEvent[]>();
  let firstHeartbeatFailure: IncidentDump['analysis']['firstHeartbeatFailure'] = null;
  let firstAuthFailure: IncidentDump['analysis']['firstAuthFailure'] = null;
  for (const e of events) {
    if (e.kind === 'heartbeatFailed' && !firstHeartbeatFailure) {
      firstHeartbeatFailure = { t: e.t, client: e.client, address: e.address, codeName: e.codeName };
    }
    if (!firstAuthFailure && isAuth(e)) firstAuthFailure = { t: e.t, client: e.client, address: e.address };
    if (!isCost(e)) continue;
    const key = e.client ?? '(unlabelled)';
    let list = byClient.get(key);
    if (!list) byClient.set(key, (list = []));
    list.push(e);
  }
  const firstMovers: FirstMover[] = [];
  for (const [client, list] of byClient) {
    // The current run: walk back from the latest cost event while the gaps stay under runGapMs.
    let i = list.length - 1;
    while (i > 0 && list[i]!.t - list[i - 1]!.t < runGapMs) i--;
    const run = list.slice(i);
    const tally = new Map<string, number>();
    for (const e of run) {
      const k = e.codeName ?? e.reason ?? e.kind;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    firstMovers.push({ client, onsetMs: run[0]!.t, events: run.length, dominant });
  }
  firstMovers.sort((a, b) => a.onsetMs - b.onsetMs || b.events - a.events);
  const onset = firstMovers[0]?.onsetMs;
  let ordering: IncidentOrdering;
  if (onset === undefined) ordering = firstHeartbeatFailure ? 'server-before-client' : 'none';
  else if (!firstHeartbeatFailure) ordering = 'no-server-signal';
  else if (onset < firstHeartbeatFailure.t - ORDERING_SLACK_MS) ordering = 'client-before-server';
  else if (firstHeartbeatFailure.t < onset - ORDERING_SLACK_MS) ordering = 'server-before-client';
  else ordering = 'simultaneous';
  return { firstMovers: firstMovers.slice(0, 20), firstHeartbeatFailure, firstAuthFailure, ordering };
}
