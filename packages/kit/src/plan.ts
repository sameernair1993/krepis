import { contextStorage } from './context.ts';
import { resolveCallSite, type CallSite } from './callsite.ts';
import type { IndexKeys, PlanFinding } from './types.ts';

/**
 * Plan evidence (opt-in `observe(client, { explain: true })`, for tests and CI): the first time an observer sees a
 * query shape, it runs `explain` (queryPlanner verbosity, which never executes the command) on a copy of the same
 * command, off the request's path and outside any unit of work. The reply is reduced to stage names and index names;
 * the filter values are held only until the explain is sent.
 *
 * Rules:
 *   KR-P001 collection scan: the winning plan has a COLLSCAN and the filter has a field an index could serve.
 *   KR-P010 in-memory sort: the winning plan has a blocking SORT stage.
 *   KR-P003 $lookup without an index: a localField/foreignField `$lookup` whose foreign collection has no index that
 *           starts with foreignField.
 */

/** Commands `explain` accepts. A multi-statement update or delete is skipped: explain takes one statement. */
const EXPLAINABLE = new Set(['find', 'aggregate', 'count', 'distinct', 'findAndModify', 'update', 'delete']);

/** Fields that tie a command to a session, a transaction or the wire, and that `explain` refuses or ignores. */
const TRANSPORT_FIELDS = [
  'lsid', 'txnNumber', 'startTransaction', 'autocommit', '$clusterTime', '$db', '$readPreference', 'readConcern',
  'writeConcern', 'apiVersion', 'apiStrict', 'apiDeprecationErrors',
];

/** Shapes explained per observer, at most. */
const MAX_SHAPES = 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { _bsontype?: unknown })._bsontype === undefined && !(value instanceof Date) && !(value instanceof RegExp);
}

/** A copy of `command` that can be sent as `{ explain: copy }`, or undefined if this command is not explained. */
export function explainable(commandName: string, command: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!EXPLAINABLE.has(commandName) || typeof command[commandName] !== 'string') return undefined;
  if (commandName === 'update' && (!Array.isArray(command.updates) || command.updates.length !== 1)) return undefined;
  if (commandName === 'delete' && (!Array.isArray(command.deletes) || command.deletes.length !== 1)) return undefined;
  const copy: Record<string, unknown> = { ...command };
  for (const f of TRANSPORT_FIELDS) delete copy[f];
  return copy;
}

/** The filter and sort a command's plan serves. */
function filterAndSort(commandName: string, command: Record<string, unknown>): { filter: unknown; sort: unknown } {
  switch (commandName) {
    case 'find':
      return { filter: command.filter, sort: command.sort };
    case 'count':
    case 'distinct':
      return { filter: command.query, sort: undefined };
    case 'findAndModify':
      return { filter: command.query, sort: command.sort };
    case 'update':
    case 'delete': {
      const statements = (command.updates ?? command.deletes) as Array<{ q?: unknown }>;
      return { filter: statements[0]?.q, sort: undefined };
    }
    case 'aggregate': {
      const pipeline = Array.isArray(command.pipeline) ? (command.pipeline as unknown[]) : [];
      const first = pipeline[0] as { $match?: unknown } | undefined;
      const second = pipeline[1] as { $sort?: unknown } | undefined;
      if (!isPlainObject(first) || !('$match' in first)) return { filter: undefined, sort: undefined };
      return { filter: first.$match, sort: isPlainObject(second) ? second.$sort : undefined };
    }
    default:
      return { filter: undefined, sort: undefined };
  }
}

const RANGE_OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte']);

type Role = 'equality' | 'range';

/** How a filter condition can use an index: equality (`v`, `$eq`, `$in`), range (`$gt`..., an anchored regex), or not. */
function roleOf(value: unknown): Role | undefined {
  if (value instanceof RegExp) return value.source.startsWith('^') ? 'range' : undefined;
  if ((value as { _bsontype?: unknown } | null)?._bsontype === 'BSONRegExp') {
    return String((value as { pattern?: unknown }).pattern).startsWith('^') ? 'range' : undefined;
  }
  if (!isPlainObject(value)) return 'equality';
  const ops = Object.keys(value);
  if (ops.length === 0 || !ops.every((k) => k.startsWith('$'))) return 'equality'; // an embedded document compared whole
  if (ops.includes('$eq') || ops.includes('$in')) return 'equality';
  if (ops.some((k) => RANGE_OPERATORS.has(k))) return 'range';
  if (ops.includes('$regex')) {
    const pattern = value.$regex instanceof RegExp ? value.$regex.source : String(value.$regex);
    return pattern.startsWith('^') ? 'range' : undefined;
  }
  return undefined;
}

/** Field → role for the top-level conjuncts of a filter (including those inside a top-level `$and`). */
function conditions(filter: unknown, out = new Map<string, Role>()): Map<string, Role> {
  if (!isPlainObject(filter)) return out;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const part of value) conditions(part, out);
      continue;
    }
    if (key.startsWith('$')) continue;
    const role = roleOf(value);
    if (role && out.get(key) !== 'equality') out.set(key, role);
  }
  return out;
}

/**
 * The index that would serve a command, in equality, sort, range order; undefined when the filter has no field an
 * index can serve (a `$or`, `$ne` or `$exists` alone) and there is no sort.
 */
export function suggestIndex(commandName: string, command: Record<string, unknown>): IndexKeys | undefined {
  const { filter, sort } = filterAndSort(commandName, command);
  const roles = conditions(filter);
  const keys: IndexKeys = {};
  for (const [field, role] of roles) if (role === 'equality') keys[field] = 1;
  // The driver (5+) sends a find's sort as a Map; an aggregate's $sort is a plain object.
  const sortEntries = sort instanceof Map ? [...(sort as Map<string, unknown>)] : isPlainObject(sort) ? Object.entries(sort) : [];
  for (const [field, dir] of sortEntries) {
    if (field in keys || (dir !== 1 && dir !== -1)) continue;
    keys[field] = dir;
  }
  for (const [field, role] of roles) if (role === 'range' && !(field in keys)) keys[field] = 1;
  return Object.keys(keys).length > 0 ? keys : undefined;
}

/** Fields of the filter an index could serve (what makes a collection scan worth reporting). */
function hasIndexableFilter(commandName: string, command: Record<string, unknown>): boolean {
  return conditions(filterAndSort(commandName, command).filter).size > 0;
}

/** `$lookup` stages joined on a field: `{ from, localField, foreignField }`. */
export function equalityLookups(commandName: string, command: Record<string, unknown>): Array<{ from: string; foreignField: string }> {
  if (commandName !== 'aggregate' || !Array.isArray(command.pipeline)) return [];
  const out: Array<{ from: string; foreignField: string }> = [];
  for (const stage of command.pipeline as unknown[]) {
    const body = isPlainObject(stage) ? stage.$lookup : undefined;
    if (!isPlainObject(body)) continue;
    if (typeof body.from === 'string' && typeof body.foreignField === 'string' && typeof body.localField === 'string') {
      out.push({ from: body.from, foreignField: body.foreignField });
    }
  }
  return out;
}

export interface PlanSummary {
  /** Stage names of the winning plan(s), outermost first, deduplicated. */
  stages: string[];
  /** Index names the winning plan(s) use. */
  indexes: string[];
}

/** Stage and index names from every `winningPlan` in an explain reply (classic, SBE, sharded, aggregate `$cursor`). */
export function summarizePlan(explain: unknown): PlanSummary {
  const stages: string[] = [];
  const indexes: string[] = [];
  const walkPlan = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walkPlan(n);
      return;
    }
    if (!isPlainObject(node)) return;
    if (typeof node.stage === 'string' && !stages.includes(node.stage)) stages.push(node.stage);
    if (typeof node.indexName === 'string' && !indexes.includes(node.indexName)) indexes.push(node.indexName);
    for (const [k, v] of Object.entries(node)) if (k !== 'slotBasedPlan' && k !== 'rejectedPlans') walkPlan(v);
  };
  const find = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) find(n);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'winningPlan') walkPlan(v);
      else if (k !== 'rejectedPlans') find(v);
    }
  };
  find(explain);
  return { stages, indexes };
}

export interface ExplainStats {
  /** Shapes explained. */
  explained: number;
  /** Explains or index listings the server refused (counted, never thrown). */
  failed: number;
}

interface Client {
  db(name: string): {
    command(cmd: Record<string, unknown>): Promise<unknown>;
    collection(name: string): { listIndexes(): { toArray(): Promise<Array<{ key?: Record<string, unknown> }>> } };
  };
}

/** Runs the explains for one observer, at most one at a time, and reports the findings they support. */
export class PlanInspector {
  readonly stats: ExplainStats = { explained: 0, failed: 0 };
  private readonly seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly client: Client;
  private readonly report: (finding: PlanFinding) => void;

  constructor(client: Client, report: (finding: PlanFinding) => void) {
    this.client = client;
    this.report = report;
  }

  /** Called when a command opens; explains its shape the first time this observer sees it. */
  consider(input: { context: string; database: string; collection: string | undefined; commandName: string; command: Record<string, unknown>; fingerprint: string; shape: string; callSite: CallSite | undefined }): void {
    if (this.seen.has(input.fingerprint) || this.seen.size >= MAX_SHAPES) return;
    const copy = explainable(input.commandName, input.command);
    if (!copy) return;
    this.seen.add(input.fingerprint);
    // Chained so explains run one at a time, after the command that prompted them has been sent.
    this.queue = this.queue
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => contextStorage.exit(() => this.inspect(input, copy)));
  }

  /** Resolves once every explain started so far has finished. */
  settled(): Promise<void> {
    return this.queue;
  }

  private async inspect(input: Parameters<PlanInspector['consider']>[0], copy: Record<string, unknown>): Promise<void> {
    const { commandName, command, database } = input;
    let summary: PlanSummary;
    try {
      summary = summarizePlan(await this.client.db(database).command({ explain: copy, verbosity: 'queryPlanner' }));
      this.stats.explained++;
    } catch {
      this.stats.failed++;
      return;
    }
    const base = {
      severity: 'warn' as const,
      context: input.context,
      namespace: `${database}.${input.collection ?? ''}`,
      fingerprint: input.fingerprint,
      command: commandName,
      shape: input.shape,
      callSites: [resolveCallSite(input.callSite)].filter((s): s is string => s !== undefined),
      plan: summary,
    };
    const index = suggestIndex(commandName, command);
    if (summary.stages.includes('COLLSCAN') && hasIndexableFilter(commandName, command) && index) {
      this.report({ ...base, rule: 'KR-P001', suggestedIndex: index });
    }
    if (summary.stages.includes('SORT') && index) {
      this.report({ ...base, rule: 'KR-P010', suggestedIndex: index });
    }
    for (const lookup of equalityLookups(commandName, command)) {
      if (lookup.foreignField === '_id') continue;
      let keys: Array<{ key?: Record<string, unknown> }>;
      try {
        keys = await this.client.db(database).collection(lookup.from).listIndexes().toArray();
      } catch {
        this.stats.failed++;
        continue;
      }
      if (keys.some((ix) => Object.keys(ix.key ?? {})[0] === lookup.foreignField)) continue;
      this.report({ ...base, rule: 'KR-P003', suggestedIndex: { [lookup.foreignField]: 1 }, lookup });
    }
  }
}
