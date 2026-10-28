import { resolveCallSite } from '../callsite.ts';
import { bsonType, describeCommand, isPlainObject } from '../fingerprint.ts';
import type { ReplyFacts } from '../reply.ts';
import type { WorkContext } from '../context.ts';
import type { CommandRecord, HazardFinding } from '../types.ts';

/**
 * Hazard rules evaluated in the collector (observe mode). Each looks at a query shape once per observer, or at most a
 * few times, so the per-command cost is a map lookup. What they record is value-free: field names, operator names and
 * counts.
 */

export interface HazardOptions {
  /** Field names reported by KR-S004 when a read returns them. Default: password, secret, token, api key. */
  sensitiveFields?: RegExp;
  /** Documents a `find` without a limit may return in one unit of work before KR-P006. Default 1000. */
  unboundedReadThreshold?: number;
}

const DEFAULT_SENSITIVE = /passw|secret|token|api_?key/i;
const SERVER_JS = new Set(['$where', '$function', '$accumulator']);
/** Shapes tracked per observer; later shapes are not inspected. */
const MAX_SHAPES = 2000;
/** Call sites resolved per shape for KR-S001: stack formatting is the costly step, so it is bounded. */
const SITE_ATTEMPTS = 5;
const MAX_SITE_FIELDS = 10_000;
const WALK_LIMIT = 5000;

interface ShapeState {
  analyzed: boolean;
  /**
   * Field → operator names (sorted) or `scalar`, from the filter's top level, and the fingerprint of the command with
   * that field masked: two commands are the same query apart from that field when these agree.
   */
  fields: Map<string, { kind: string[] | 'scalar'; rest: string }> | undefined;
  hasRegex: boolean;
  siteAttempts: number;
  sites: Set<string>;
  replyChecked: boolean;
  reported: Set<string>;
}

/** Keys found anywhere in a command, skipping inserted documents, which are data. */
function operatorsIn(value: unknown, wanted: Set<string>): string[] {
  const found = new Set<string>();
  let budget = WALK_LIMIT;
  const walk = (v: unknown, depth: number) => {
    if (--budget < 0 || depth > 32) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (isPlainObject(v)) {
      for (const k of Object.keys(v)) {
        if (wanted.has(k)) found.add(k);
        walk(v[k], depth + 1);
      }
    }
  };
  walk(value, 0);
  return [...found].sort();
}

/** Top-level fields of a filter (and of a top-level `$and`): scalar, or the operators applied. */
function fieldKinds(filter: unknown): Map<string, string[] | 'scalar'> {
  const out = new Map<string, string[] | 'scalar'>();
  const visit = (f: unknown) => {
    if (!isPlainObject(f)) return;
    for (const k of Object.keys(f)) {
      const v = f[k];
      if (k === '$and' && Array.isArray(v)) {
        v.forEach(visit);
        continue;
      }
      if (k.startsWith('$')) continue;
      if (isPlainObject(v)) {
        const keys = Object.keys(v);
        // `{ $eq: x }` is what a sanitised equality looks like; it is not an injection.
        if (keys.length > 0 && keys.every((x) => x.startsWith('$')) && !(keys.length === 1 && keys[0] === '$eq')) {
          out.set(k, keys.sort());
        }
      } else if (!Array.isArray(v) && !isRegex(v)) {
        out.set(k, 'scalar');
      }
    }
  };
  visit(filter);
  return out;
}

function isRegex(v: unknown): boolean {
  return v instanceof RegExp || (typeof v === 'object' && v !== null && bsonType(v) === 'BSONRegExp');
}

/** A filter with `field` (at the top level and in a top-level `$and`) replaced by a constant. */
function masked(filter: unknown, field: string): unknown {
  if (!isPlainObject(filter)) return filter;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(filter)) {
    const v = filter[k];
    out[k] = k === field ? 0 : k === '$and' && Array.isArray(v) ? v.map((x) => masked(x, field)) : v;
  }
  return out;
}

/** The command with its filter replaced, for the commands whose filter `describeCommand` reads. */
function withFilter(name: string, command: Record<string, unknown>, filter: unknown): Record<string, unknown> | undefined {
  switch (name) {
    case 'find':
      return { ...command, filter };
    case 'count':
    case 'distinct':
    case 'findAndModify':
      return { ...command, query: filter };
    case 'update':
    case 'delete': {
      const key = name === 'update' ? 'updates' : 'deletes';
      const statements = command[key];
      return Array.isArray(statements) && statements.length === 1 ? { ...command, [key]: [{ ...statements[0], q: filter }] } : undefined;
    }
    case 'aggregate':
      return Array.isArray(command.pipeline) ? { ...command, pipeline: [{ $match: filter }, ...command.pipeline.slice(1)] } : undefined;
    default:
      return undefined;
  }
}

/** Fingerprint of the command with `field` masked; the command's own fingerprint if it cannot be rebuilt. */
function restOf(record: CommandRecord, command: Record<string, unknown>, filter: unknown, field: string): string {
  const rebuilt = withFilter(record.commandName, command, masked(filter, field));
  return (rebuilt && describeCommand(record.commandName, record.database, rebuilt)?.fingerprint) ?? record.fingerprint;
}

const INPUT_WALK_LIMIT = 2000;
const INPUT_OPS_LIMIT = 50;

const isOperatorObject = (v: unknown): v is Record<string, unknown> => {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
};

/** Operator objects (every key starts with `$`) anywhere in a parsed request input. */
function operatorObjects(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let budget = INPUT_WALK_LIMIT;
  const walk = (v: unknown, depth: number) => {
    if (--budget < 0 || depth > 16 || out.length >= INPUT_OPS_LIMIT) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (isPlainObject(v)) {
      if (isOperatorObject(v)) out.push(v);
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/**
 * Same value as sent by the client, allowing for what a library does to it on the way: an id string cast to an
 * ObjectId, a query-string `'5'` cast to a number.
 */
function sameInput(input: unknown, sent: unknown, depth = 0): boolean {
  if (input === sent) return true;
  if (depth > 8 || input === null || sent === null || input === undefined || sent === undefined) return false;
  if (Array.isArray(input) || Array.isArray(sent)) {
    return Array.isArray(input) && Array.isArray(sent) && input.length === sent.length && input.every((x, i) => sameInput(x, sent[i], depth + 1));
  }
  if (isPlainObject(input) || isPlainObject(sent)) {
    if (!isPlainObject(input) || !isPlainObject(sent)) return false;
    const keys = Object.keys(input);
    return keys.length === Object.keys(sent).length && keys.every((k) => Object.hasOwn(sent, k) && sameInput(input[k], sent[k], depth + 1));
  }
  return String(input) === String(sent);
}

/** Values of `field` in a filter's top level and top-level `$and`. */
function fieldValues(filter: unknown, field: string, out: unknown[] = []): unknown[] {
  if (!isPlainObject(filter)) return out;
  if (Object.hasOwn(filter, field)) out.push(filter[field]);
  if (Array.isArray(filter.$and)) for (const part of filter.$and) fieldValues(part, field, out);
  return out;
}

function patternOf(v: unknown): string | undefined {
  if (v instanceof RegExp) return v.source;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && bsonType(v) === 'BSONRegExp') return String((v as { pattern?: unknown }).pattern ?? '');
  return undefined;
}

const anchored = (pattern: string) => pattern.startsWith('^') || pattern.startsWith('\\A');

/** Fields of a filter matched by an unanchored regular expression. */
function unanchoredFields(filter: unknown): string[] {
  const out = new Set<string>();
  const visit = (f: unknown, depth: number) => {
    if (!isPlainObject(f) || depth > 8) return;
    for (const k of Object.keys(f)) {
      const v = f[k];
      if ((k === '$and' || k === '$or' || k === '$nor') && Array.isArray(v)) {
        for (const part of v) visit(part, depth + 1);
        continue;
      }
      if (k.startsWith('$')) continue;
      const candidates: unknown[] = [];
      if (isRegex(v)) candidates.push(v);
      else if (isPlainObject(v)) {
        if ('$regex' in v) candidates.push(v.$regex);
        if (Array.isArray(v.$in)) candidates.push(...v.$in.filter(isRegex));
      }
      for (const c of candidates) {
        const p = patternOf(c);
        if (p !== undefined && !anchored(p)) out.add(k);
      }
    }
  };
  visit(filter, 0);
  return [...out].sort();
}

/** Paths of keys matching `pattern` in a document, to depth 4; arrays are read through their first element. */
function sensitivePaths(doc: unknown, pattern: RegExp): string[] {
  const out: string[] = [];
  const visit = (v: unknown, path: string, depth: number) => {
    if (depth > 4 || out.length >= 20) return;
    if (Array.isArray(v)) {
      if (v.length > 0) visit(v[0], path, depth + 1);
      return;
    }
    if (!isPlainObject(v)) return;
    for (const k of Object.keys(v)) {
      const p = path ? `${path}.${k}` : k;
      if (pattern.test(k)) out.push(p);
      else visit(v[k], p, depth + 1);
    }
  };
  visit(doc, '', 0);
  return out;
}

type Where = Pick<HazardFinding, 'context' | 'namespace' | 'command' | 'fingerprint' | 'shape' | 'callSites'>;

function where(ctx: WorkContext, record: CommandRecord, site = resolveCallSite(record.callSite)): Where {
  return {
    context: ctx.label,
    namespace: `${record.database}.${record.collection ?? ''}`,
    command: record.commandName,
    fingerprint: record.fingerprint,
    shape: record.shape,
    callSites: site ? [site] : [],
  };
}

export class HazardInspector {
  private readonly shapes = new Map<string, ShapeState>();
  // `site|field|rest` → what that call site sent for the field (`rest`: the query apart from the field).
  private readonly siteFields = new Map<string, { scalar: boolean; operators: { ops: string[]; at: Where; state: ShapeState } | undefined }>();
  private readonly sensitive: RegExp;
  private readonly threshold: number;
  private readonly report: (f: HazardFinding) => void;
  // False by default: only KR-S001 and KR-S002 run. True with `hazards: true` or options: KR-S003, S004, P006 too.
  private readonly all: boolean;

  constructor(options: HazardOptions, report: (f: HazardFinding) => void, all = true) {
    this.sensitive = options.sensitiveFields ?? DEFAULT_SENSITIVE;
    this.threshold = options.unboundedReadThreshold ?? 1000;
    this.report = report;
    this.all = all;
  }

  private state(fingerprint: string): ShapeState | undefined {
    let s = this.shapes.get(fingerprint);
    if (!s) {
      if (this.shapes.size >= MAX_SHAPES) return undefined;
      s = { analyzed: false, fields: undefined, hasRegex: false, siteAttempts: 0, sites: new Set(), replyChecked: false, reported: new Set() };
      this.shapes.set(fingerprint, s);
    }
    return s;
  }

  private emit(s: ShapeState, key: string, at: () => Where, f: Pick<HazardFinding, 'rule' | 'severity' | 'fields' | 'operators'> & Partial<Pick<HazardFinding, 'returned' | 'input'>>): void {
    if (s.reported.has(key)) return;
    s.reported.add(key);
    this.report({ ...f, ...at() });
  }

  /** At the start of a command, with its values (which are not kept). */
  command(ctx: WorkContext, record: CommandRecord, command: Record<string, unknown>, filter: unknown): void {
    if (record.commandName === 'getMore' || record.prefetch) return;
    if (this.all && record.commandName === 'find') {
      const limit = command.limit;
      record.unbounded = (limit === undefined || limit === null || String(limit) === '0') && !command.singleBatch;
    }
    const s = this.state(record.fingerprint);
    if (!s) return;
    if (!s.analyzed) {
      s.analyzed = true;
      const { documents: _d, ...rest } = command;
      const js = record.commandName === 'mapReduce' ? ['mapReduce'] : operatorsIn(rest, SERVER_JS);
      if (js.length > 0) this.emit(s, 'S002', () => where(ctx, record), { rule: 'KR-S002', severity: 'warn', fields: [], operators: js });
      const kinds = fieldKinds(filter);
      s.fields = kinds.size === 0 ? undefined : new Map([...kinds].map(([field, kind]) => [field, { kind, rest: restOf(record, command, filter, field) }]));
      s.hasRegex = this.all && (record.shape.includes('"regex"') || record.shape.includes('"$regex"'));
    }
    if (s.hasRegex && !s.reported.has('S003')) {
      const fields = unanchoredFields(filter);
      if (fields.length > 0) this.emit(s, 'S003', () => where(ctx, record), { rule: 'KR-S003', severity: 'info', fields, operators: ['$regex'] });
    }
    if (s.fields && ctx.inputs) this.fromInput(s, ctx, record, filter);
    if (s.fields && record.callSite && s.siteAttempts < SITE_ATTEMPTS) {
      s.siteAttempts++;
      const site = resolveCallSite(record.callSite);
      if (site && !s.sites.has(site)) {
        s.sites.add(site);
        this.injection(s, ctx, record, site);
      }
    }
  }

  // KR-S001 from one request: an operator object in the filter is one the client sent (a JSON body, a parsed query
  // string, GraphQL variables). Needs no second request and no shared call site. Runs only for shapes with an operator
  // on a top-level field, and reads the input only while it has not yet been reported for that shape and field.
  private fromInput(s: ShapeState, ctx: WorkContext, record: CommandRecord, filter: unknown): void {
    let sources: Array<{ source: string; ops: Record<string, unknown>[] }> | undefined;
    for (const [field, { kind }] of s.fields!) {
      if (kind === 'scalar' || s.reported.has(`S001in|${field}`)) continue;
      sources ??= ctx.inputs!.map((i) => {
        const value = i.read();
        if (!i.ops || value !== i.seen) {
          i.seen = value;
          i.ops = operatorObjects(value);
        }
        return { source: i.source, ops: i.ops };
      }).filter((x) => x.ops.length > 0);
      if (sources.length === 0) return;
      for (const value of fieldValues(filter, field)) {
        if (!isOperatorObject(value)) continue;
        const hit = sources.find((x) => x.ops.some((o) => sameInput(o, value)));
        if (!hit) continue;
        s.reported.add(`S001in|${field}`);
        const at = where(ctx, record);
        // Same key as the call-site evidence, so one injection is not reported twice.
        this.emit(s, `S001|${at.callSites[0] ?? ''}|${field}`, () => at, { rule: 'KR-S001', severity: 'warn', fields: [field], operators: kind, input: hit.source });
        break;
      }
    }
  }

  // KR-S001: the same call site sent this field both as a scalar and as an operator object, in commands that are
  // otherwise the same query (command, collection, other filter fields, sort, projection, limit). A call site that
  // dispatches different queries (a generic repository method) does not match itself across them.
  private injection(s: ShapeState, ctx: WorkContext, record: CommandRecord, site: string): void {
    for (const [field, { kind, rest }] of s.fields!) {
      const key = `${site}|${field}|${rest}`;
      let entry = this.siteFields.get(key);
      if (!entry) {
        if (this.siteFields.size >= MAX_SITE_FIELDS) continue;
        entry = { scalar: false, operators: undefined };
        this.siteFields.set(key, entry);
      }
      if (kind === 'scalar') entry.scalar = true;
      else entry.operators ??= { ops: kind, at: where(ctx, record, site), state: s };
      if (entry.scalar && entry.operators) {
        const op = entry.operators;
        this.emit(op.state, `S001|${site}|${field}`, () => op.at, { rule: 'KR-S001', severity: 'warn', fields: [field], operators: op.ops });
      }
    }
  }

  /** On a command's first reply. */
  reply(ctx: WorkContext, record: CommandRecord, reply: ReplyFacts): void {
    if (!this.all || (record.commandName !== 'find' && record.commandName !== 'aggregate')) return;
    if (record.prefetch || !reply.batch) return;
    const s = this.shapes.get(record.fingerprint);
    if (!s || s.replyChecked) return;
    s.replyChecked = true;
    const fields = sensitivePaths(reply.docs(1)[0], this.sensitive);
    if (fields.length > 0) this.emit(s, 'S004', () => where(ctx, record), { rule: 'KR-S004', severity: 'info', fields, operators: [] });
  }

  /** When a unit of work ends: reads whose cursors it drained. */
  end(ctx: WorkContext): void {
    if (!this.all) return;
    for (const record of ctx.commands) {
      if (!record.unbounded || (record.returned ?? 0) <= this.threshold) continue;
      const s = this.shapes.get(record.fingerprint);
      if (s) this.emit(s, 'P006', () => where(ctx, record), { rule: 'KR-P006', severity: 'warn', fields: [], operators: [], returned: record.returned });
    }
  }
}
