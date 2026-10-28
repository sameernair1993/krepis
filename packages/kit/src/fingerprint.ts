import { createHash } from 'node:crypto';

type Shape = string | number | boolean | null | Shape[] | { [k: string]: Shape };

const IGNORED_COMMANDS = new Set([
  'hello', 'ismaster', 'isMaster', 'ping', 'saslStart', 'saslContinue', 'authenticate', 'endSessions',
  'killCursors', 'buildInfo', 'getParameter', 'abortTransaction', 'commitTransaction', 'logout',
]);

const ARRAY_OPERATORS = new Set(['$in', '$nin', '$all']);
const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor']);

export function bsonType(value: object): string | undefined {
  const t = (value as { _bsontype?: unknown })._bsontype;
  return typeof t === 'string' ? t : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && bsonType(value) === undefined
    && !(value instanceof Date) && !(value instanceof RegExp);
}

/** Type token for a scalar. Numeric BSON types collapse to `number` so int/double/long shapes agree. */
function scalarToken(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return 'date';
  if (value instanceof RegExp) return 'regex';
  if (typeof value === 'object') {
    const t = bsonType(value);
    if (t === 'ObjectId') return 'oid';
    if (t === 'Decimal128' || t === 'Long' || t === 'Int32' || t === 'Double') return 'number';
    if (t === 'BSONRegExp') return 'regex';
    if (t !== undefined) return t.toLowerCase();
    return Array.isArray(value) ? 'array' : 'object';
  }
  if (typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'bool';
  return typeof value;
}

function shapeValue(value: unknown, operator?: string): Shape {
  if (Array.isArray(value)) {
    if (operator && ARRAY_OPERATORS.has(operator)) {
      // `$in` of 3 ids and of 300 ids is the same query shape.
      const types = [...new Set(value.map((v) => (isPlainObject(v) ? 'object' : scalarToken(v))))].sort();
      return [types.join('|')];
    }
    if (operator && LOGICAL_OPERATORS.has(operator)) return value.map((v) => shapeFilter(v));
    return 'array';
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((k) => k.startsWith('$'))) {
      const out: Record<string, Shape> = {};
      for (const k of keys.sort()) out[k] = shapeValue(value[k], k);
      return out;
    }
    // An embedded document compared by equality; its contents are values, not structure.
    return operator === undefined ? 'object' : shapeFilter(value);
  }
  return scalarToken(value);
}

export function shapeFilter(filter: unknown): Shape {
  if (!isPlainObject(filter)) return scalarToken(filter);
  const out: Record<string, Shape> = {};
  for (const k of Object.keys(filter).sort()) {
    out[k] = k.startsWith('$') ? shapeValue(filter[k], k) : shapeValue(filter[k]);
  }
  return out;
}

/** Literal structure that is part of the code, not of the data: sort and projection specs. */
function literalKeys(spec: unknown): Shape {
  // The driver (5+) sends a find's sort as a Map.
  if (spec instanceof Map) spec = Object.fromEntries(spec);
  if (!isPlainObject(spec)) return null;
  const out: Record<string, Shape> = {};
  for (const k of Object.keys(spec)) {
    const v = spec[k];
    out[k] = typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : shapeValue(v);
  }
  return out;
}

function countBucket(n: unknown): Shape {
  if (n === undefined || n === null || n === 0) return null;
  return n === 1 || n === -1 ? 1 : 'n';
}

function shapeStage(stage: unknown): Shape {
  if (!isPlainObject(stage)) return scalarToken(stage);
  const [name] = Object.keys(stage);
  if (name === undefined) return {};
  const body = stage[name];
  switch (name) {
    case '$match':
      return { [name]: shapeFilter(body) };
    case '$limit':
    case '$skip':
    case '$sample':
      return { [name]: 'n' };
    case '$sort':
    case '$project':
    case '$group':
    case '$unwind':
    case '$addFields':
    case '$set':
    case '$unset':
    case '$count':
      return { [name]: typeof body === 'string' ? body : literalKeys(body) };
    case '$lookup': {
      const b = isPlainObject(body) ? body : {};
      return {
        [name]: {
          from: (b.from as Shape) ?? null,
          localField: (b.localField as Shape) ?? null,
          foreignField: (b.foreignField as Shape) ?? null,
          pipeline: Array.isArray(b.pipeline) ? b.pipeline.map(shapeStage) : null,
        },
      };
    }
    default:
      return { [name]: shapeValue(body) };
  }
}

function stable(shape: Shape): string {
  if (Array.isArray(shape)) return `[${shape.map(stable).join(',')}]`;
  if (shape !== null && typeof shape === 'object') {
    return `{${Object.keys(shape).sort().map((k) => `${JSON.stringify(k)}:${stable(shape[k] as Shape)}`).join(',')}}`;
  }
  return JSON.stringify(shape);
}

/** Stages a pipeline may have after its leading `$match` and still read what a `find` would. */
const FIND_STAGES = new Set(['$sort', '$limit', '$skip', '$project']);

const stageName = (stage: unknown): string | undefined => {
  if (!isPlainObject(stage)) return undefined;
  const keys = Object.keys(stage);
  return keys.length === 1 ? keys[0] : undefined;
};

/** The `$match` body of a find-shaped pipeline (Prisma sends every read this way); undefined for any other. */
function findShapedMatch(pipeline: unknown): unknown {
  if (!Array.isArray(pipeline) || stageName(pipeline[0]) !== '$match') return undefined;
  if (!pipeline.slice(1).every((s) => FIND_STAGES.has(stageName(s) ?? ''))) return undefined;
  return (pipeline[0] as { $match: unknown }).$match;
}

export interface DescribedCommand {
  collection: string | undefined;
  shape: string;
  fingerprint: string;
  filter: unknown;
  cursorId: string | undefined;
}

export function describeCommand(commandName: string, database: string, command: Record<string, unknown>): DescribedCommand | undefined {
  if (IGNORED_COMMANDS.has(commandName)) return undefined;
  let collection: string | undefined;
  let filter: unknown;
  let shape: Shape;
  let cursorId: string | undefined;
  const target = command[commandName];
  const coll = typeof target === 'string' ? target : undefined;

  switch (commandName) {
    case 'find':
      collection = coll;
      filter = command.filter ?? {};
      shape = {
        filter: shapeFilter(filter),
        sort: literalKeys(command.sort),
        projection: literalKeys(command.projection),
        limit: countBucket(command.limit),
        skip: countBucket(command.skip),
      };
      break;
    case 'aggregate':
      collection = coll;
      filter = findShapedMatch(command.pipeline);
      shape = { pipeline: Array.isArray(command.pipeline) ? command.pipeline.map(shapeStage) : null };
      break;
    case 'count':
      collection = coll;
      filter = command.query ?? {};
      shape = { filter: shapeFilter(filter) };
      break;
    case 'distinct':
      collection = coll;
      filter = command.query ?? {};
      shape = { key: (command.key as Shape) ?? null, filter: shapeFilter(filter) };
      break;
    case 'update': {
      collection = coll;
      const updates = Array.isArray(command.updates) ? (command.updates as Record<string, unknown>[]) : [];
      if (updates.length === 1) filter = updates[0]?.q;
      shape = {
        statements: [...new Set(updates.map((u) => stable({
          q: shapeFilter(u.q),
          u: Array.isArray(u.u) ? u.u.map(shapeStage) : shapeFilter(u.u),
          multi: Boolean(u.multi),
          upsert: Boolean(u.upsert),
        })))].sort(),
        n: countBucket(updates.length),
      };
      break;
    }
    case 'delete': {
      collection = coll;
      const deletes = Array.isArray(command.deletes) ? (command.deletes as Record<string, unknown>[]) : [];
      if (deletes.length === 1) filter = deletes[0]?.q;
      shape = {
        statements: [...new Set(deletes.map((d) => stable({ q: shapeFilter(d.q), limit: countBucket(d.limit) })))].sort(),
        n: countBucket(deletes.length),
      };
      break;
    }
    case 'insert': {
      collection = coll;
      const docs = Array.isArray(command.documents) ? command.documents : [];
      shape = { n: countBucket(docs.length) };
      break;
    }
    case 'findAndModify':
      collection = coll;
      filter = command.query ?? {};
      shape = {
        filter: shapeFilter(filter),
        update: Array.isArray(command.update) ? command.update.map(shapeStage) : shapeFilter(command.update),
        remove: Boolean(command.remove),
        upsert: Boolean(command.upsert),
      };
      break;
    case 'getMore':
      collection = typeof command.collection === 'string' ? command.collection : undefined;
      cursorId = String(command.getMore);
      shape = {};
      break;
    default:
      collection = coll;
      shape = {};
  }

  const shapeText = stable(shape);
  const key = `${commandName} ${database}.${collection ?? ''} ${shapeText}`;
  return {
    collection,
    shape: shapeText,
    fingerprint: createHash('sha1').update(key).digest('hex').slice(0, 16),
    filter,
    cursorId,
  };
}

/**
 * Comparable key for a value. Numeric BSON types and JS numbers with the same value agree
 * (5, Int32(5), Long(5), Double(5)), so a parent field and a child lookup match across types.
 */
export function valueKey(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (typeof value === 'object') {
    const t = bsonType(value);
    if (t === 'ObjectId') return `oid:${(value as { toHexString(): string }).toHexString()}`;
    if (t === 'Long' || t === 'Int32' || t === 'Double') {
      const n = value as { toNumber?: () => number; valueOf(): unknown };
      return `number:${typeof n.toNumber === 'function' ? n.toNumber() : Number(n.valueOf())}`;
    }
    if (t !== undefined) return `${t}:${String(value)}`;
    try {
      return `json:${JSON.stringify(value)}`;
    } catch {
      return 'unkeyable';
    }
  }
  if (typeof value === 'bigint') return `number:${Number(value)}`;
  return `${typeof value}:${String(value)}`;
}

function isScalarForLookup(value: unknown): boolean {
  return !Array.isArray(value) && !isPlainObject(value) && !(value instanceof RegExp)
    && !(typeof value === 'object' && value !== null && bsonType(value) === 'BSONRegExp');
}

/**
 * Equality-only filter, e.g. `{ _id: X }` or `{ tenantId: T, userId: U }` or `{ _id: { $eq: X } }`.
 * These are the children of an N+1: individually perfect, collectively wasteful.
 */
export function pointLookup(filter: unknown): Map<string, string> | undefined {
  if (!isPlainObject(filter)) return undefined;
  const keys = Object.keys(filter);
  if (keys.length === 0) return undefined;
  const out = new Map<string, string>();
  for (const k of keys) {
    if (k.startsWith('$')) return undefined;
    let v = filter[k];
    if (isPlainObject(v)) {
      const inner = Object.keys(v);
      if (inner.length !== 1 || inner[0] !== '$eq') return undefined;
      v = v.$eq;
    }
    if (!isScalarForLookup(v)) return undefined;
    out.set(k, valueKey(v));
  }
  return out;
}

/** Equality conjuncts of a filter plus whether anything else constrained it. */
export interface LookupKeys { keys: Map<string, string>; residual: boolean }

/**
 * Lookup keys for N+1 detection: the equality conjuncts of a filter. Anything else — an
 * operator on another field (`_rperm: { $in: [...] }`, the ACL clause Parse Server adds to every query),
 * a top-level `$or`/`$nor`/`$expr`, an embedded-document or array match — is residual: it stays in the
 * shape, which already groups the queries, but is not a key. A top-level `$and` contributes its
 * parts' conjuncts. Unlike `pointLookup`, which only accepts
 * pure equality, one residual clause does not hide the lookup. Undefined when no conjunct is equality.
 */
export function lookupKeys(filter: unknown): LookupKeys | undefined {
  if (!isPlainObject(filter)) return undefined;
  const keys = new Map<string, string>();
  let residual = false;
  for (const k of Object.keys(filter)) {
    let v = filter[k];
    if (k === '$and' && Array.isArray(v)) {
      // A top-level `$and` is the same conjunction written out; Prisma sends compound equality this way.
      for (const part of v) {
        const sub = lookupKeys(part);
        if (!sub) {
          residual = true;
          continue;
        }
        residual ||= sub.residual;
        for (const [sk, sv] of sub.keys) {
          if (keys.has(sk) && keys.get(sk) !== sv) residual = true;
          else keys.set(sk, sv);
        }
      }
      continue;
    }
    if (k.startsWith('$')) {
      residual = true;
      continue;
    }
    if (isPlainObject(v)) {
      const inner = Object.keys(v);
      if (inner.length !== 1 || inner[0] !== '$eq') {
        residual = true;
        continue;
      }
      v = v.$eq;
    }
    if (!isScalarForLookup(v)) {
      residual = true;
      continue;
    }
    const key = valueKey(v);
    // A `$and` part read earlier may already hold this field.
    if (keys.has(k) && keys.get(k) !== key) residual = true;
    else keys.set(k, key);
  }
  return keys.size > 0 ? { keys, residual } : undefined;
}
