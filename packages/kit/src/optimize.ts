import { valueKey } from './fingerprint.ts';
import { docsOf } from './reply.ts';
import type { CommandRecord } from './types.ts';

/**
 * Request-scoped optimisations, applied inside the gated `Connection.command` (see gate.ts), so they cover every
 * library built on the driver. All are opt-in and share one contract: the semantics of a per-request DataLoader
 * cache, which is also the semantics of the hand-written fix (`$in` before the loop). An answer may come from a read
 * taken earlier in the same unit of work, at most `maxAgeMs` earlier. Nothing outlives the unit of work, so a write
 * acknowledged before a request reads is always seen by it. Within it:
 * - a write to a collection drops what was read from it;
 * - freshness gate: once the unit of work receives any reply for a collection that reflects a later cluster state
 *   (a greater `operationTime`), what was cached from that collection earlier is dropped, so two reads of one
 *   collection in one request never disagree in the stale direction.
 * Answers are rebuilt from raw BSON, so the driver decodes a fresh object with the application's own options.
 *
 * - batchLookups: a parent-driven loop of `_id` lookups is answered from one `$in` prefetch.
 * - dedupeReads: an identical `find` / `aggregate` repeated in the unit of work is answered from the first reply.
 * - verify: a sampled fraction of optimised answers is also sent to the server and compared byte for byte; the
 *   server's answer is the one returned. A difference is classified (see MismatchVerdict) by asking the server for
 *   the data as of the moment the answer was cached. This is how the optimisations earn being on by default.
 *
 * Anything unusual passes through untouched (explicit sessions, transactions, open cursors, nondeterministic
 * stages), and any internal error falls back to the application's original command.
 */

export interface AutoBatchOptions {
  /** Answers older than this are not used; the lookup goes to the server. Default 1000. */
  maxAgeMs?: number;
  /** Values fetched per prefetch. Default 500. */
  maxBatch?: number;
}

/**
 * What a difference found by `verify` means:
 * - `reordered`: the same documents in another order. Benign: a total sort cannot reorder an equal set, so the
 *   command left the order to the server.
 * - `stale`: the server, asked for the data as of the moment the answer was cached (snapshot read at its
 *   operationTime), returned exactly what was served. A write landed in between; the answer was right for its moment.
 * - `unexplained`: the server never held what was served. This is a Krepis bug and the number that must stay zero.
 * - `unclassified`: no oracle available (standalone server, server < 5.0, or the snapshot read failed).
 */
export type MismatchVerdict = 'reordered' | 'stale' | 'unexplained' | 'unclassified';

export interface OptimizeMismatch {
  kind: 'batchLookups' | 'dedupeReads';
  verdict: MismatchVerdict;
  namespace: string;
}

export interface OptimizeOptions {
  /** Answer parent-driven loops of `_id` lookups from one `$in` prefetch. */
  batchLookups?: boolean | { maxBatch?: number };
  /** Answer a repeated identical read in the same unit of work from the first reply. */
  dedupeReads?: boolean;
  /** Oldest answer that may be reused, in ms. Default 1000. */
  maxAgeMs?: number;
  /** Fraction (0–1) of optimised answers also checked against the server. The server's answer is returned. Default 0. */
  verify?: number;
  /** Called when a verified answer differs from the server's, with a verdict saying why. */
  onMismatch?: (mismatch: OptimizeMismatch) => void;
}

/** `'safe'` enables batchLookups and dedupeReads. */
export type OptimizeSetting = 'off' | 'safe' | OptimizeOptions;

export interface OptimizeStats {
  /** Lookups answered from a prefetch. */
  served: number;
  /** Reads answered from an identical earlier reply. */
  deduped: number;
  /** `$in` prefetches sent. */
  prefetches: number;
  /** Optimised answers also checked against the server. */
  verified: number;
  /** Checks where the server's answer differed, for any reason; broken down below. */
  mismatches: number;
  reordered: number;
  stale: number;
  /** Differences the server cannot account for. Must be zero before an optimisation is trusted by default. */
  unexplained: number;
  unclassified: number;
}

export interface ResolvedOptimize {
  batchLookups: boolean;
  maxBatch: number;
  dedupeReads: boolean;
  maxAgeMs: number;
  verify: number;
  onMismatch: ((m: OptimizeMismatch) => void) | undefined;
}

/** Merges `optimize` with the older `autoBatch` alias. Undefined when nothing is enabled. */
export function resolveOptimize(optimize: OptimizeSetting | undefined, autoBatch: boolean | AutoBatchOptions | undefined): ResolvedOptimize | undefined {
  const o: OptimizeOptions = optimize === 'safe' ? { batchLookups: true, dedupeReads: true } : optimize === 'off' || !optimize ? {} : optimize;
  const alias = autoBatch ? (autoBatch === true ? {} : autoBatch) : undefined;
  const batch = o.batchLookups ?? (alias ? { maxBatch: alias.maxBatch } : false);
  const resolved: ResolvedOptimize = {
    batchLookups: batch !== false,
    maxBatch: (typeof batch === 'object' ? batch.maxBatch : undefined) ?? 500,
    dedupeReads: o.dedupeReads ?? false,
    maxAgeMs: o.maxAgeMs ?? alias?.maxAgeMs ?? 1000,
    verify: Math.min(Math.max(o.verify ?? 0, 0), 1),
    onMismatch: o.onMismatch,
  };
  return resolved.batchLookups || resolved.dedupeReads ? resolved : undefined;
}

export const PREFETCH_COMMENT = 'krepis: auto-batched lookup';

type Original = (...args: unknown[]) => Promise<unknown>;
interface Namespace { db: string }
interface SessionLike { explicit?: boolean; inTransaction?: () => boolean }
interface CommandOptions { session?: SessionLike }
interface ResponseClass { make(bytes: Uint8Array): unknown }
interface OnDemandDoc { get(name: string | number, as: number, required?: boolean): unknown; toBytes(): Uint8Array }
interface CursorReply {
  batch: OnDemandDoc & { size(): number };
  id: { isZero(): boolean };
  toBytes(): Uint8Array;
}

/** Command keys a batchable `find` may carry at this layer. Anything else (sort, collation, hint, ...) passes through. */
const LOOKUP_KEYS = new Set(['find', 'filter', 'projection', 'limit', 'singleBatch', 'batchSize', 'readConcern', 'maxTimeMS']);
/**
 * Commands that change no data, so they never invalidate. Includes the connection handshake (`ismaster`, `hello`)
 * and authentication, which run through `Connection.command` whenever a pool opens a connection mid-request; treating
 * them as unknown would drop every pending prefetch exactly when parallel lookups open new connections.
 */
const READ_COMMANDS = new Set([
  'find', 'getMore', 'count', 'distinct', 'listIndexes', 'listCollections', 'listDatabases', 'killCursors', 'explain',
  'hello', 'ismaster', 'isMaster', 'ping', 'buildInfo', 'buildinfo', 'getParameter', 'serverStatus', 'connectionStatus',
  'saslStart', 'saslContinue', 'authenticate', 'endSessions', 'dbStats', 'collStats',
]);
const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify']);
/**
 * Operators whose result differs between two identical runs, or that write, or that read eventually-consistent
 * state. A command containing any of them, anywhere, is never deduplicated.
 */
const NOT_REPEATABLE = new Set([
  '$sample', '$rand', '$sampleRate', '$where', '$function', '$accumulator', '$out', '$merge',
  '$currentOp', '$listSessions', '$listLocalSessions', '$changeStream', '$changeStreamSplitLargeEvent',
  '$indexStats', '$collStats', '$planCacheStats', '$queryStats', '$querySettings', '$listSearchIndexes',
  '$search', '$searchMeta', '$vectorSearch',
]);
const NOT_REPEATABLE_VARIABLES = ['$$NOW', '$$CLUSTER_TIME'];
const MAX_DEDUPE_ENTRIES = 200;
const MAX_DEDUPE_BYTES = 1 << 20;
const MAX_DEDUPE_TOTAL_BYTES = 8 << 20;

const BSON_DOUBLE = 1;
const BSON_STRING = 2;
const BSON_OBJECT = 3;
const BSON_OBJECTID = 7;
const BSON_INT = 16;
const BSON_LONG = 18;

interface Lookup { slotKey: string; collection: string; key: string; value: unknown; reply: ResponseClass; ns: string }

type Answer = Uint8Array | null | undefined; // bytes = found, null = known absent, undefined = unknown: ask the server

/** When a cached answer was read: the reply's operationTime, as a comparable number and as the driver's own value. */
interface ReadAt { opTime: bigint | undefined; opTs: unknown }

interface Held extends ReadAt { bytes: Answer }

interface Slot {
  ns: string;
  createdAt: number;
  answers: Map<string, Promise<Held>>;
  /** Arrived prefetch answers (bytes, or null = absent) and when they were read, for the freshness gate. */
  held: Map<string, { bytes: Uint8Array | null; opTime: bigint | undefined }>;
  /** The most recent lookup that went to the server, used to recognise the second consecutive miss. */
  lastMiss: string | undefined;
  usedParents: Set<CommandRecord>;
  /** Consecutive misses no earlier result could explain; past a few, this is not a parent-driven loop. */
  unexplained: number;
  disabled: boolean;
}

interface CachedReply extends ReadAt { bytes: Uint8Array; count: number }

interface ReadEntry {
  sentAt: number;
  /** Namespace whose writes invalidate this entry, or '*' for any write (aggregates can read other collections). */
  deps: string;
  reply: Promise<CachedReply | undefined>;
  /** Set when the reply arrives. */
  opTime: bigint | undefined;
  /** For decoding the cached reply when the freshness gate needs its documents. */
  responseClass: ResponseClass;
  /** Documents of the cached reply by `_id`, built on first need; null if some document has no usable `_id`. */
  docs?: Map<string, Uint8Array> | null;
}

/** Commands whose reply carries data from a collection, for the freshness gate. */
const DATA_READS = new Set(['find', 'getMore', 'count', 'distinct', 'aggregate']);
/** Stages that bring documents from other collections into an aggregate's reply. */
const CROSS_COLLECTION_STAGES = ['$lookup', '$unionWith', '$graphLookup', '$facet'];

/** A reply's operationTime (cluster time of the data it reflects), from a driver response or a plain document. */
function readAt(res: unknown): ReadAt {
  try {
    const ts = (res as { operationTime?: unknown } | null)?.operationTime;
    const { t, i } = (ts ?? {}) as { t?: unknown; i?: unknown };
    if (typeof t === 'number' && typeof i === 'number') return { opTime: (BigInt(t) << 32n) | BigInt(i), opTs: ts };
  } catch {
    // No usable operationTime (standalone server): the freshness gate and the verify oracle stand down.
  }
  return { opTime: undefined, opTs: undefined };
}

/** Server and authenticated identity of a connection: answers are never shared across credentials. */
function identityOf(conn: unknown): string {
  const c = conn as { address?: string; authContext?: { credentials?: { username?: string; source?: string; mechanism?: string } } };
  const cr = c.authContext?.credentials;
  return `${c.address ?? ''}|${cr ? `${cr.username ?? ''}@${cr.source ?? ''}/${cr.mechanism ?? ''}` : ''}`;
}

/** Misses with no explaining parent before a slot stops looking (bounds the cost of scanning results). */
const MAX_UNEXPLAINED = 3;

export interface OptimizeHooks {
  /** Completed commands in the current context, with retained result documents. */
  commands(): CommandRecord[];
  /** Records a command answered locally, so the rules still see it. */
  recordServed(commandName: string, database: string, command: Record<string, unknown>, returned: number): void;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map) && !('_bsontype' in v) && !(v instanceof Date);
}

/** Ids whose lookup key is exact: numbers are keyed by value (as the server compares them), so only safe ones. */
function isScalarId(v: unknown): boolean {
  if (typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v) && (Number.isSafeInteger(v) || !Number.isInteger(v));
  if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER);
  const t = (v as { _bsontype?: string } | null)?._bsontype;
  if (t === 'ObjectId') return true;
  if (t === 'Long' || t === 'Int32' || t === 'Double') {
    const n = v as { toNumber?: () => number; valueOf(): unknown };
    const num = typeof n.toNumber === 'function' ? n.toNumber() : Number(n.valueOf());
    // Long.toNumber() is lossy past 2^53; anything outside the safe range could share a key with a neighbour.
    return isScalarId(num);
  }
  return false;
}

/** Order-independent key for small option documents (projection, readConcern). */
function stableKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  if (isPlain(v)) return `{${Object.keys(v).sort().map((k) => `${k}:${stableKey(v[k])}`).join(',')}}`;
  return valueKey(v);
}

/**
 * Exact key for a whole command: equal keys mean the same command on the wire. Types are kept apart (no numeric
 * normalisation, so no precision loss) and key order is kept (it is meaningful in `sort`). Undefined when the
 * command contains something not repeatable or not keyable; that read is simply not deduplicated.
 */
export function repeatableKey(v: unknown, depth = 0): string | undefined {
  if (depth > 64) return undefined;
  if (v === null) return 'null';
  if (v === undefined) return 'undef';
  switch (typeof v) {
    case 'string':
      return NOT_REPEATABLE_VARIABLES.some((s) => v.includes(s)) ? undefined : JSON.stringify(v);
    case 'number':
      return Object.is(v, -0) ? 'n:-0' : `n:${v}`;
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return `L:${v}`;
    case 'object':
      break;
    default:
      return undefined;
  }
  const join = (entries: Iterable<[string, unknown]>, open: string, close: string) => {
    const parts: string[] = [];
    for (const [k, x] of entries) {
      if (NOT_REPEATABLE.has(k)) return undefined;
      const sub = repeatableKey(x, depth + 1);
      if (sub === undefined) return undefined;
      parts.push(`${JSON.stringify(k)}:${sub}`);
    }
    return `${open}${parts.join(',')}${close}`;
  };
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const x of v) {
      const sub = repeatableKey(x, depth + 1);
      if (sub === undefined) return undefined;
      parts.push(sub);
    }
    return `[${parts.join(',')}]`;
  }
  if (v instanceof Map) return join(v as Map<string, unknown>, 'M{', '}');
  if (v instanceof Date) return `D:${v.getTime()}`;
  if (v instanceof RegExp) return `R:${v.source}/${v.flags}`;
  const t = (v as { _bsontype?: string })._bsontype;
  if (t !== undefined) {
    const x = v as { toString(enc?: string): string; toHexString?: () => string; value?: unknown; sub_type?: number; pattern?: string; options?: string };
    switch (t) {
      case 'ObjectId': return `O:${x.toHexString!()}`;
      case 'Long': return `L:${x.toString()}`;
      case 'Int32': return `I:${String(x.value)}`;
      case 'Double': return `F:${String(x.value)}`;
      case 'Decimal128': return `M:${x.toString()}`;
      case 'Timestamp': return `TS:${x.toString()}`;
      case 'BSONRegExp': return `R:${x.pattern}/${x.options}`;
      case 'Binary': return `B:${x.sub_type}:${x.toString('base64')}`;
      case 'MinKey': return 'MinKey';
      case 'MaxKey': return 'MaxKey';
      default: return undefined;
    }
  }
  if (!isPlain(v)) return undefined;
  return join(Object.entries(v), '{', '}');
}

function unsafeSession(options: CommandOptions | undefined): boolean {
  const session = options?.session;
  return Boolean(session?.explicit || session?.inTransaction?.());
}

function parseLookup(conn: unknown, ns: Namespace, cmd: Record<string, unknown>, reply: unknown): Lookup | undefined {
  if (typeof cmd.find !== 'string' || typeof (reply as ResponseClass | undefined)?.make !== 'function') return undefined;
  for (const k of Object.keys(cmd)) if (!LOOKUP_KEYS.has(k)) return undefined;
  if (cmd.limit !== undefined && cmd.limit !== 1) return undefined;
  const projection = cmd.projection;
  if (isPlain(projection) && (projection._id === 0 || projection._id === false)) return undefined;
  const filter = cmd.filter;
  if (!isPlain(filter)) return undefined;
  const keys = Object.keys(filter);
  if (keys.length !== 1 || keys[0] !== '_id') return undefined;
  let value = filter._id;
  if (isPlain(value)) {
    const inner = Object.keys(value);
    if (inner.length !== 1 || inner[0] !== '$eq') return undefined;
    value = value.$eq;
  }
  if (!isScalarId(value)) return undefined;
  return {
    slotKey: `${identityOf(conn)}|${ns.db}.${cmd.find}|${stableKey(cmd.projection)}|${stableKey(cmd.readConcern)}`,
    collection: cmd.find,
    key: valueKey(value),
    value,
    reply: reply as ResponseClass,
    ns: `${ns.db}.${cmd.find}`,
  };
}

/** Values of `field` (top level or `a.b`, arrays flattened) across documents, keyed like lookup values. */
function fieldValues(docs: unknown[], field: string): Map<string, unknown> {
  const [head, tail] = field.split('.', 2) as [string, string | undefined];
  const out = new Map<string, unknown>();
  const add = (v: unknown) => {
    for (const item of Array.isArray(v) ? v : [v]) if (isScalarId(item)) out.set(valueKey(item), item);
  };
  for (const doc of docs) {
    if (!isPlain(doc)) continue;
    const top = doc[head];
    if (tail === undefined) add(top);
    else for (const sub of Array.isArray(top) ? top : [top]) if (isPlain(sub)) add(sub[tail]);
  }
  return out;
}

/** Candidate fields of a document: top level, plus one nested level. */
function candidateFields(docs: unknown[]): string[] {
  const fields = new Set<string>();
  for (const doc of docs.slice(0, 20)) {
    if (!isPlain(doc)) continue;
    for (const [k, v] of Object.entries(doc)) {
      fields.add(k);
      for (const sub of Array.isArray(v) ? v : [v]) if (isPlain(sub)) for (const k2 of Object.keys(sub)) fields.add(`${k}.${k2}`);
    }
  }
  return [...fields];
}

/** Reads a document's `_id` from raw BSON as a lookup key, without decoding the document. */
function idKey(doc: OnDemandDoc): { key: string; isString: boolean } | undefined {
  const oid = doc.get('_id', BSON_OBJECTID);
  if (oid != null) return { key: valueKey(oid), isString: false };
  const s = doc.get('_id', BSON_STRING);
  if (s != null) return { key: valueKey(s), isString: true };
  for (const t of [BSON_INT, BSON_LONG, BSON_DOUBLE]) {
    const n = doc.get('_id', t);
    if (n != null) return isScalarId(n) ? { key: valueKey(n), isString: false } : undefined;
  }
  return undefined;
}

/** Raw bytes of each document in a cursor reply's batch. */
function batchDocs(res: unknown): Uint8Array[] {
  const batch = (res as CursorReply).batch;
  const out: Uint8Array[] = [];
  for (let i = 0; i < batch.size(); i++) out.push((batch.get(i, BSON_OBJECT, true) as OnDemandDoc).toBytes());
  return out;
}

/** A cursor reply's documents keyed by `_id`; null if any document has no `_id` usable as a key. */
function docsById(res: unknown): Map<string, Uint8Array> | null {
  const batch = (res as CursorReply).batch;
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < batch.size(); i++) {
    const doc = batch.get(i, BSON_OBJECT, true) as OnDemandDoc;
    const id = idKey(doc);
    if (!id) return null;
    out.set(id.key, doc.toBytes());
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSequence(a: Uint8Array[], b: Uint8Array[]): boolean {
  return a.length === b.length && a.every((d, i) => sameBytes(d, b[i]!));
}

function sameMultiset(a: Uint8Array[], b: Uint8Array[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...b];
  for (const d of a) {
    const at = left.findIndex((x) => sameBytes(x, d));
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return true;
}

/** An exhausted, small cursor reply, copied out of the socket buffer it is a view into. */
function cacheable(res: unknown): CachedReply | undefined {
  try {
    const r = res as CursorReply;
    if (!r.id.isZero()) return undefined;
    const bytes = r.toBytes();
    if (bytes.length > MAX_DEDUPE_BYTES) return undefined;
    return { bytes: bytes.slice(), count: r.batch.size(), ...readAt(res) };
  } catch {
    return undefined;
  }
}

const utf8 = new TextEncoder();

function cstring(s: string): Uint8Array {
  const b = utf8.encode(s);
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  return out;
}

function document(...parts: Uint8Array[]): Uint8Array {
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(4 + body + 1);
  new DataView(out.buffer).setInt32(0, out.length, true);
  let at = 4;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function element(type: number, name: string, value: Uint8Array): Uint8Array {
  const n = cstring(name);
  const out = new Uint8Array(1 + n.length + value.length);
  out[0] = type;
  out.set(n, 1);
  out.set(value, 1 + n.length);
  return out;
}

/** `{ cursor: { firstBatch: [doc?], id: Long(0), ns }, ok: 1 }`: what the server returns for an exhausted find. */
export function cursorReplyBytes(ns: string, doc: Uint8Array | null): Uint8Array {
  const firstBatch = doc ? document(element(BSON_OBJECT, '0', doc)) : document();
  const nsBytes = cstring(ns);
  const nsValue = new Uint8Array(4 + nsBytes.length);
  new DataView(nsValue.buffer).setInt32(0, nsBytes.length, true);
  nsValue.set(nsBytes, 4);
  const cursor = document(element(4, 'firstBatch', firstBatch), element(BSON_LONG, 'id', new Uint8Array(8)), element(BSON_STRING, 'ns', nsValue));
  const ok = new Uint8Array(8);
  new DataView(ok.buffer).setFloat64(0, 1, true);
  return document(element(BSON_OBJECT, 'cursor', cursor), element(BSON_DOUBLE, 'ok', ok));
}

export function emptyStats(): OptimizeStats {
  return { served: 0, deduped: 0, prefetches: 0, verified: 0, mismatches: 0, reordered: 0, stale: 0, unexplained: 0, unclassified: 0 };
}

/** One per observed unit of work. */
export class Optimizer {
  private readonly slots = new Map<string, Slot>();
  private readonly reads = new Map<string, ReadEntry>();
  private readonly indexes = new WeakMap<CommandRecord, Map<string, Map<string, unknown>>>();
  /** Bytes held by dedupeReads in this context (bounded by MAX_DEDUPE_TOTAL_BYTES; not released on invalidation). */
  private cachedBytes = 0;
  /** dedupeReads entries whose reply has arrived and is cached. */
  private readonly settled = new WeakMap<ReadEntry, CachedReply>();
  /** Replies Krepis built itself: they carry no new information for the freshness gate. */
  private readonly served = new WeakSet<object>();

  private readonly hooks: OptimizeHooks;
  private readonly options: ResolvedOptimize;
  readonly stats: OptimizeStats;

  constructor(hooks: OptimizeHooks, options: ResolvedOptimize, stats: OptimizeStats = emptyStats()) {
    this.hooks = hooks;
    this.options = options;
    this.stats = stats;
  }

  handle(conn: unknown, args: unknown[], original: Original): Promise<unknown> {
    let plan: (() => Promise<unknown>) | undefined;
    try {
      plan = this.plan(conn, args, original);
    } catch {
      plan = undefined;
    }
    return (plan ? plan() : original.apply(conn, args)).then((res) => {
      this.noteReply(args[0] as Namespace, args[1], res);
      return res;
    });
  }

  /** A command Krepis cannot optimize (callback-style driver): only its effect on cached reads is applied. */
  observeUnmanaged(ns: unknown, cmd: unknown): void {
    try {
      if (isPlain(cmd)) this.invalidateFor(ns as Namespace, cmd);
    } catch {
      // Never break the application's command over cache bookkeeping.
    }
  }

  private plan(conn: unknown, args: unknown[], original: Original): (() => Promise<unknown>) | undefined {
    const [ns, cmd, options, reply] = args as [Namespace, Record<string, unknown>, CommandOptions | undefined, unknown];
    if (!isPlain(cmd)) return undefined;
    this.invalidateFor(ns, cmd);
    if (unsafeSession(options)) return undefined;
    if (this.options.batchLookups) {
      const p = this.planLookup(conn, ns, cmd, options, reply, args, original);
      if (p) return p;
    }
    return this.options.dedupeReads ? this.planDedupe(conn, ns, cmd, options, reply, args, original) : undefined;
  }

  // ---- batchLookups ----

  private planLookup(
    conn: unknown, ns: Namespace, cmd: Record<string, unknown>, options: CommandOptions | undefined, reply: unknown,
    args: unknown[], original: Original,
  ): (() => Promise<unknown>) | undefined {
    const lookup = parseLookup(conn, ns, cmd, reply);
    if (!lookup) return undefined;

    let slot = this.slots.get(lookup.slotKey);
    if (!slot || performance.now() - slot.createdAt > this.options.maxAgeMs) {
      slot = { ns: lookup.ns, createdAt: performance.now(), answers: new Map(), held: new Map(), lastMiss: undefined, usedParents: new Set(), unexplained: 0, disabled: false };
      this.slots.set(lookup.slotKey, slot);
    }
    if (slot.disabled) return undefined;

    const pending = slot.answers.get(lookup.key);
    if (pending) return () => this.answer(pending, lookup, ns, cmd, options, conn, args, original);

    const previous = slot.lastMiss;
    slot.lastMiss = lookup.key;
    if (previous === undefined || previous === lookup.key || slot.unexplained >= MAX_UNEXPLAINED) return undefined;
    const source = this.findSource(slot, [previous, lookup.key]);
    if (!source) {
      slot.unexplained++;
      return undefined;
    }
    slot.unexplained = 0;

    slot.usedParents.add(source.parent);
    const values = [lookup.value];
    for (const [k, v] of source.values) {
      if (values.length >= this.options.maxBatch) break;
      if (k !== lookup.key && !slot.answers.has(k)) values.push(v);
    }
    const fetched = this.prefetch(conn, ns, cmd, options, reply, original, values, slot);
    for (const v of values) {
      const k = valueKey(v);
      slot.answers.set(k, fetched.then((f) => ({ bytes: f.answers.get(k), opTime: f.opTime, opTs: f.opTs })));
    }
    return () => this.answer(slot.answers.get(lookup.key)!, lookup, ns, cmd, options, conn, args, original);
  }

  /** A completed result in this context whose field contains every given lookup key. */
  private findSource(slot: Slot, keys: string[]): { parent: CommandRecord; values: Map<string, unknown> } | undefined {
    const commands = this.hooks.commands();
    for (let i = commands.length - 1; i >= 0; i--) {
      const parent = commands[i]!;
      if (slot.usedParents.has(parent) || parent.prefetch || !docsOf(parent)?.length) continue;
      for (const values of this.fieldIndex(parent).values()) {
        if (keys.every((k) => values.has(k))) return { parent, values };
      }
    }
    return undefined;
  }

  private fieldIndex(parent: CommandRecord): Map<string, Map<string, unknown>> {
    let index = this.indexes.get(parent);
    if (!index) {
      const docs = parent.docs ?? [];
      index = new Map(candidateFields(docs).map((f) => [f, fieldValues(docs, f)]));
      this.indexes.set(parent, index);
    }
    return index;
  }

  private async prefetch(
    conn: unknown, ns: Namespace, cmd: Record<string, unknown>, options: CommandOptions | undefined, reply: unknown,
    original: Original, values: unknown[], slot: Slot,
  ): Promise<ReadAt & { answers: Map<string, Answer> }> {
    const answers = new Map<string, Answer>();
    let at: ReadAt = { opTime: undefined, opTs: undefined };
    try {
      const { filter: _f, limit: _l, singleBatch: _s, batchSize: _b, ...rest } = cmd;
      // batchSize one past limit: a batch that fills exactly at the limit can come back with the cursor still open
      // (observed through the driver on 8.0), which would cost a killCursors round trip.
      const prefetchCmd = { ...rest, filter: { _id: { $in: values } }, limit: values.length, batchSize: values.length + 1, comment: PREFETCH_COMMENT };
      this.stats.prefetches++;
      const res = (await original.call(conn, ns, prefetchCmd, options, reply)) as CursorReply;
      at = readAt(res);
      const batch = res.batch;
      for (let i = 0; i < batch.size(); i++) {
        const doc = batch.get(i, BSON_OBJECT, true) as OnDemandDoc;
        const id = idKey(doc);
        if (id) answers.set(id.key, doc.toBytes());
      }
      const complete = res.id.isZero();
      if (!complete) {
        await original.call(conn, ns, { killCursors: cmd.find, cursors: [res.id] }, options).catch(() => undefined);
      }
      // The prefetch is itself a reply the request will see: it retires older contradicting answers first.
      this.reconcile(slot.ns, at.opTime, new Map([...answers].filter((e): e is [string, Uint8Array] => e[1] instanceof Uint8Array)));
      for (const v of values) {
        const k = valueKey(v);
        // Absent means "does not exist" only if the reply was complete, and not for strings: a collection
        // collation can make a string lookup match an _id that differs byte-wise.
        if (!answers.has(k)) answers.set(k, complete && typeof v !== 'string' ? null : undefined);
        const a = answers.get(k);
        if (a !== undefined) slot.held.set(k, { bytes: a, opTime: at.opTime });
      }
    } catch {
      slot.disabled = true;
    }
    return { answers, ...at };
  }

  private async answer(
    pending: Promise<Held>, lookup: Lookup, ns: Namespace, cmd: Record<string, unknown>, options: CommandOptions | undefined,
    conn: unknown, args: unknown[], original: Original,
  ): Promise<unknown> {
    const held = await pending.catch(() => undefined);
    const bytes = held?.bytes;
    if (held === undefined || bytes === undefined) return original.apply(conn, args);
    if (this.sampleVerify()) {
      return this.verified('batchLookups', lookup.ns, bytes ? [bytes] : [], held, ns, cmd, options, lookup.reply, conn, args, original);
    }
    this.stats.served++;
    this.record('find', ns.db, cmd, bytes ? 1 : 0);
    return this.mark(lookup.reply.make(cursorReplyBytes(lookup.ns, bytes)));
  }

  // ---- dedupeReads ----

  private planDedupe(
    conn: unknown, ns: Namespace, cmd: Record<string, unknown>, options: CommandOptions | undefined, reply: unknown,
    args: unknown[], original: Original,
  ): (() => Promise<unknown>) | undefined {
    const name = Object.keys(cmd)[0];
    if ((name !== 'find' && name !== 'aggregate') || typeof (reply as ResponseClass | undefined)?.make !== 'function') return undefined;
    const exact = repeatableKey(cmd);
    if (exact === undefined) return undefined;
    const key = `${identityOf(conn)}|${ns.db}|${exact}`;
    const now = performance.now();
    const hit = this.reads.get(key);
    if (hit && now - hit.sentAt <= this.options.maxAgeMs) {
      return () => this.serveRead(hit, name, ns, cmd, options, reply as ResponseClass, conn, args, original);
    }
    if (!hit && this.reads.size >= MAX_DEDUPE_ENTRIES) return undefined;
    let settle!: (r: CachedReply | undefined) => void;
    const entry: ReadEntry = {
      sentAt: now,
      deps: name === 'find' && typeof cmd.find === 'string' ? `${ns.db}.${cmd.find}` : '*',
      reply: new Promise((resolve) => { settle = resolve; }),
      opTime: undefined,
      responseClass: reply as ResponseClass,
    };
    this.reads.set(key, entry);
    const forget = () => { if (this.reads.get(key) === entry) this.reads.delete(key); };
    return () => original.apply(conn, args).then(
      (res) => {
        let cached = cacheable(res);
        if (cached && this.cachedBytes + cached.bytes.length > MAX_DEDUPE_TOTAL_BYTES) cached = undefined;
        if (cached) {
          this.cachedBytes += cached.bytes.length;
          entry.opTime = cached.opTime;
          this.settled.set(entry, cached);
        } else forget();
        settle(cached);
        return res;
      },
      (err: unknown) => {
        forget();
        settle(undefined);
        throw err;
      },
    );
  }

  private async serveRead(
    entry: ReadEntry, name: string, ns: Namespace, cmd: Record<string, unknown>, options: CommandOptions | undefined,
    reply: ResponseClass, conn: unknown, args: unknown[], original: Original,
  ): Promise<unknown> {
    const cached = await entry.reply;
    if (!cached) return original.apply(conn, args);
    const namespace = `${ns.db}.${typeof cmd[name] === 'string' ? cmd[name] : ''}`;
    if (this.sampleVerify()) {
      return this.verified('dedupeReads', namespace, batchDocs(reply.make(cached.bytes)), cached, ns, cmd, options, reply, conn, args, original);
    }
    this.stats.deduped++;
    this.record(name, ns.db, cmd, cached.count);
    return this.mark(reply.make(cached.bytes));
  }

  private mark(res: unknown): unknown {
    if (typeof res === 'object' && res !== null) this.served.add(res);
    return res;
  }

  // ---- verify ----

  private sampleVerify(): boolean {
    return this.options.verify > 0 && Math.random() < this.options.verify;
  }

  /**
   * Sends the real command and returns the server's answer. If its documents differ from what would have been
   * served, classifies the difference before returning (one extra round trip, only on a difference; it must finish
   * while the application still holds this connection).
   */
  private async verified(
    kind: OptimizeMismatch['kind'], namespace: string, expected: Uint8Array[], at: ReadAt,
    ns: Namespace, cmd: Record<string, unknown>, options: CommandOptions | undefined, reply: ResponseClass,
    conn: unknown, args: unknown[], original: Original,
  ): Promise<unknown> {
    const res = await original.apply(conn, args);
    this.stats.verified++;
    try {
      const actual = batchDocs(res);
      if (!sameSequence(actual, expected)) {
        this.stats.mismatches++;
        const verdict = sameMultiset(actual, expected)
          ? 'reordered'
          : await this.oracle(expected, at, ns, cmd, options, reply, conn, original);
        this.stats[verdict]++;
        this.options.onMismatch?.({ kind, verdict, namespace });
      }
    } catch {
      // Comparison is diagnostic; the server's answer is returned regardless.
    }
    return res;
  }

  /** Asks the server for the data as of the moment the answer was cached, and compares it with what was served. */
  private async oracle(
    expected: Uint8Array[], at: ReadAt, ns: Namespace, cmd: Record<string, unknown>, options: CommandOptions | undefined,
    reply: ResponseClass, conn: unknown, original: Original,
  ): Promise<MismatchVerdict> {
    if (at.opTs === undefined) return 'unclassified';
    try {
      const { readConcern: _rc, ...rest } = cmd;
      const snapshot = { ...rest, readConcern: { level: 'snapshot', atClusterTime: at.opTs } };
      const then = await original.call(conn, ns, snapshot, options, reply);
      return sameMultiset(batchDocs(then), expected) ? 'stale' : 'unexplained';
    } catch {
      return 'unclassified';
    }
  }

  private record(commandName: string, database: string, cmd: Record<string, unknown>, returned: number): void {
    try {
      this.hooks.recordServed(commandName, database, cmd, returned);
    } catch {
      // Recording is diagnostic; never let it affect the answer.
    }
  }

  // ---- invalidation ----

  /** Writes in the context make earlier reads of that collection unusable; unknown commands drop everything. */
  private invalidateFor(ns: Namespace, cmd: Record<string, unknown>): void {
    const name = Object.keys(cmd)[0];
    if (name === undefined || READ_COMMANDS.has(name)) return;
    if (name === 'aggregate' && Array.isArray(cmd.pipeline)
      && !cmd.pipeline.some((s) => isPlain(s) && ('$out' in s || '$merge' in s))) return;
    if (WRITE_COMMANDS.has(name) && typeof cmd[name] === 'string') {
      const target = `${ns.db}.${cmd[name] as string}`;
      for (const [key, slot] of this.slots) if (slot.ns === target) this.slots.delete(key);
      for (const [key, read] of this.reads) if (read.deps === target || read.deps === '*') this.reads.delete(key);
      return;
    }
    this.slots.clear();
    this.reads.clear();
  }

  /**
   * Freshness gate. A real reply from collection N that may reflect a later state than a cached answer is compared
   * with it by content: a document the request has now seen in a different version (same `_id`, other bytes, or
   * present where the answer said absent) retires the older answer. A cached result set also retires on a
   * document it does not contain (it may be a new match). Replies whose content cannot be compared (count, distinct,
   * cross-collection aggregates) retire every older answer they could touch. operationTime only short-cuts the
   * comparison when the reply is provably not newer; the cluster-wide clock alone would retire answers on every
   * write anywhere in the cluster.
   */
  private noteReply(ns: Namespace, cmd: unknown, res: unknown): void {
    try {
      if (!isPlain(cmd) || this.served.has(res as object)) return;
      const name = Object.keys(cmd)[0];
      if (name === undefined || !DATA_READS.has(name)) return;
      if (this.slots.size === 0 && this.reads.size === 0) return;
      const { opTime } = readAt(res);
      const coll = name === 'getMore' ? cmd.collection : cmd[name];
      const crossCollection = name === 'aggregate' && (!Array.isArray(cmd.pipeline)
        || cmd.pipeline.some((s) => isPlain(s) && CROSS_COLLECTION_STAGES.some((st) => st in s)));
      if (crossCollection || typeof coll !== 'string') return this.reconcile('*', opTime, undefined);
      const docs = name === 'count' || name === 'distinct' ? undefined : docsById(res);
      this.reconcile(`${ns.db}.${coll}`, opTime, docs ?? undefined);
    } catch {
      // Bookkeeping must never affect the reply.
    }
  }

  /** `docs` undefined = content unknown: retire every possibly-older answer for `target` ('*' = all collections). */
  private reconcile(target: string, opTime: bigint | undefined, docs: Map<string, Uint8Array> | undefined): void {
    const newer = (at: bigint | undefined) => opTime === undefined || at === undefined || at < opTime;
    for (const slot of this.slots.values()) {
      if (target !== '*' && slot.ns !== target) continue;
      const drop = (k: string) => {
        slot.answers.delete(k);
        slot.held.delete(k);
      };
      if (docs === undefined) {
        for (const [k, h] of slot.held) if (newer(h.opTime)) drop(k);
        continue;
      }
      for (const [k, bytes] of docs) {
        const h = slot.held.get(k);
        if (h && newer(h.opTime) && (h.bytes === null || !sameBytes(h.bytes, bytes))) drop(k);
      }
    }
    for (const [key, read] of this.reads) {
      if (target !== '*' && read.deps !== target && read.deps !== '*') continue;
      // Entries still in flight are skipped: their own reply may be the newer one.
      if (!this.settled.has(read) || !newer(read.opTime)) continue;
      if (docs === undefined || !this.consistent(read, docs)) this.reads.delete(key);
    }
  }

  /** Every document in `docs` appears, byte-identical, in the cached result. */
  private consistent(read: ReadEntry, docs: Map<string, Uint8Array>): boolean {
    if (docs.size === 0) return true;
    if (read.docs === undefined) read.docs = docsById(read.responseClass.make(this.settled.get(read)!.bytes));
    if (!read.docs) return false;
    for (const [k, bytes] of docs) {
      const mine = read.docs.get(k);
      if (!mine || !sameBytes(mine, bytes)) return false;
    }
    return true;
  }
}
