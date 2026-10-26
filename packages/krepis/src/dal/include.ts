import type { Db, Document } from 'mongodb';
import type { Collection, Filter, Projection, Sort } from './collection.ts';
import type { PathMap, Project } from './paths.ts';
import type { Doc, Schema } from './schema.ts';

/**
 * Relation loading for `Query.include`.
 *
 * Every relation is one batched read per level, whatever the number of parents: the
 * referenced values are collected, deduplicated, cast by the target schema and read
 * with `$in` through the target collection, so its casting and scope hook apply.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type Path<D> = keyof PathMap<D> & string;
type NoExtra<W, D> = { [P in Exclude<keyof W, keyof PathMap<D> | `$${string}`>]: never };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCollection = Collection<any>;

/** Runtime shape of one relation. */
export interface RelationSpec {
  from: AnyCollection;
  /** Field on the parent holding the value(s) to match. Defaults to `_id`. */
  local?: string;
  /** Field on the target matched against `local`. Defaults to `_id`; anything else makes the relation many. */
  foreign?: string;
  select?: Record<string, 0 | 1>;
  where?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  /** Many relations only: at most this many per parent value (server 5.2+). */
  limit?: number;
  /** Many relations only: read every match deliberately, as `Query.all()`. */
  all?: boolean;
  include?: IncludeMap;
}
export type IncludeMap = Record<string, RelationSpec>;

/** A relation, checked against the parent document `D` and the target schema `Y`. */
export type Relation<D, Y extends Schema> = {
  from: Collection<Y>;
  local?: Path<D>;
  foreign?: Path<Doc<Y>>;
  select?: Projection<Doc<Y>>;
  where?: Filter<Doc<Y>>;
  sort?: Sort<Doc<Y>>;
  limit?: number;
  all?: boolean;
  include?: IncludeMap;
};

/** Checks every relation of `S`, including nested ones, against its own target. */
export type ValidateIncludes<D, S> = {
  [K in keyof S]: S[K] extends { from: Collection<infer Y> }
    ? Relation<D, Y> &
        (S[K] extends { where: infer W } ? { where: NoExtra<W, Doc<Y>> } : unknown) &
        (S[K] extends { select: infer P } ? { select: NoExtra<P, Doc<Y>> } : unknown) &
        (S[K] extends { include: infer N } ? { include: ValidateIncludes<Doc<Y>, N> } : unknown)
    : never;
};

type Target<Y, R> = WithIncludes<
  Doc<Y>,
  R extends { include: infer N } ? N : {}, // eslint-disable-line @typescript-eslint/no-empty-object-type
  Project<Doc<Y>, R extends { select: infer P } ? P : {}> // eslint-disable-line @typescript-eslint/no-empty-object-type
>;
type ByLocal<D, R, T> = R extends { local: infer L }
  ? L extends keyof D
    ? [NonNullable<D[L]>] extends [readonly unknown[]]
      ? T[]
      : T | null
    : T | null
  : T | null;
type Cardinality<D, R, T> = R extends { foreign: infer F } ? ([F] extends ['_id'] ? ByLocal<D, R, T> : T[]) : ByLocal<D, R, T>;
type Loaded<D, R> = R extends { from: Collection<infer Y> } ? Cardinality<D, R, Target<Y, R>> : never;
type OptionalOf<D> = { [K in keyof D]-?: object extends Pick<D, K> ? K : never }[keyof D];

/**
 * The row `R` (by default the parent document `D`, or `D` narrowed by a projection) with each
 * relation attached; cardinality and optionality come from `D`. A relation named after an
 * optional field (an in-place replacement) stays optional: a missing id stays missing, as in Mongoose.
 */
export type WithIncludes<D, S, R = D> = Simplify<
  Omit<R, keyof S> & { [K in Exclude<keyof S, OptionalOf<D>>]: Loaded<D, S[K]> } & {
    [K in Extract<keyof S, OptionalOf<D>>]?: Loaded<D, S[K]>;
  }
>;

// ---------------------------------------------------------------------------
// Internal hook into the target collection
// ---------------------------------------------------------------------------

/** Global, so an ESM and a CJS copy of Krepis can load each other's collections. */
export const INCLUDE = Symbol.for('krepis.dal.include');

export interface IncludeRead {
  foreign: string;
  values: unknown[];
  where?: Record<string, unknown>;
  select?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
  /** Per-value limit (aggregate). */
  limit?: number;
  /** A many relation with neither `limit` nor `all`: the target's unbounded-read policy applies. */
  unbounded: boolean;
}

export interface IncludeTarget {
  /** Casts a parent value to the target field's type; undefined when it cannot match. */
  cast(foreign: string, value: unknown): unknown;
  /** Throws or warns per the target's unbounded-read policy. */
  checkUnbounded(): void;
  /** `strip`: a field the read added to a `select` so it could match, to remove after matching. */
  read(request: IncludeRead): Promise<{ docs: Document[]; strip?: string }>;
  /** The target's database, so a $lookup can refuse to cross one. */
  database(): Db;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** `$in` lists are split so one relation never builds a command near the 16 MB limit. */
export const IN_CHUNK = 5000;

export function keyOf(v: unknown): string {
  if (v instanceof Date) return `d${v.getTime()}`;
  if (v !== null && typeof v === 'object') {
    const hex = (v as { toHexString?: () => string }).toHexString;
    return typeof hex === 'function' ? `o${hex.call(v)}` : `j${JSON.stringify(v)}`;
  }
  return `${typeof v}:${String(v)}`;
}

function getPath(doc: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return doc[path];
  let cur: unknown = doc;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const asList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Widens a projection so it returns `fields`. Returns the fields it had to add, for the caller
 * to remove once they have been used, so the result still honours the projection.
 */
export function widen(
  projection: Record<string, unknown> | undefined,
  fields: Iterable<string>,
): { projection: Record<string, unknown> | undefined; added: string[] } {
  if (!projection) return { projection, added: [] };
  const out = { ...projection };
  const inclusive = Object.entries(out).some(([k, v]) => k !== '_id' && v);
  const added: string[] = [];
  for (const f of new Set(fields)) {
    // `_id` is returned by an inclusion projection unless it is excluded explicitly.
    const present = inclusive ? (f === '_id' ? !(f in out) || Boolean(out[f]) : Boolean(out[f])) : !(f in out);
    if (present) continue;
    if (inclusive) out[f] = 1;
    else delete out[f];
    added.push(f);
  }
  return { projection: out, added };
}

/** Top-level local fields the parent read must return for `specs` to resolve. */
export function localFields(specs: IncludeMap): string[] {
  return Object.values(specs).map((s) => (s.local ?? '_id').split('.')[0]);
}

interface Plan {
  name: string;
  spec: RelationSpec;
  target: IncludeTarget;
  local: string;
  foreign: string;
  many: boolean;
  /** Raw parent value → cast value, per parent: computed before any relation assigns. */
  perParent: unknown[][];
}

function plan(parents: Record<string, unknown>[], name: string, spec: RelationSpec): Plan {
  if (spec.local === undefined && spec.foreign === undefined) {
    throw new TypeError(`Krepis include "${name}": give local or foreign`);
  }
  const target = (spec.from as unknown as Record<symbol, () => IncludeTarget>)[INCLUDE]?.();
  if (!target) throw new TypeError(`Krepis include "${name}": from must be a Krepis collection`);
  const local = spec.local ?? '_id';
  const foreign = spec.foreign ?? '_id';
  const many = foreign !== '_id';
  if (!many && (spec.limit !== undefined || spec.sort !== undefined)) {
    throw new TypeError(`Krepis include "${name}": limit and sort apply to many relations (foreign other than _id)`);
  }
  const perParent = parents.map((p) =>
    asList(getPath(p, local))
      .map((v) => target.cast(foreign, v))
      .filter((v) => v !== undefined && v !== null),
  );
  return { name, spec, target, local, foreign, many, perParent };
}

/** Attaches every relation in `specs` to `parents`, in place. One read per relation per level. */
export async function attachIncludes(parents: Record<string, unknown>[], specs: IncludeMap): Promise<void> {
  if (parents.length === 0) return;
  // Plan every relation before any assigns, so an in-place relation cannot hide a key another one reads.
  const plans = Object.entries(specs).map(([name, spec]) => plan(parents, name, spec));
  await Promise.all(plans.map((p) => load(parents, p)));
}

async function load(parents: Record<string, unknown>[], p: Plan): Promise<void> {
  const { spec, target, foreign, many } = p;
  const unique = new Map<string, unknown>();
  for (const values of p.perParent) for (const v of values) unique.set(keyOf(v), v);

  const unbounded = many && spec.limit === undefined && !spec.all;
  if (unique.size > 0 && unbounded) target.checkUnbounded();

  const ids = [...unique.values()];
  const chunks: unknown[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) chunks.push(ids.slice(i, i + IN_CHUNK));
  // Nested relations need their local fields on the children, whatever `select` says.
  const nested = widen(spec.select, spec.include ? localFields(spec.include) : []);
  const select = nested.projection as RelationSpec['select'];
  const results = await Promise.all(
    chunks.map((values) => target.read({ foreign, values, where: spec.where, select, sort: spec.sort, limit: spec.limit, unbounded })),
  );
  const children = results.flatMap((r) => r.docs) as Record<string, unknown>[];
  const strip = results[0]?.strip;

  // Index children by the foreign value(s) they carry; a many relation may match an array field.
  const byKey = new Map<string, Record<string, unknown>[]>();
  for (const child of children) {
    const own = asList(getPath(child, foreign));
    const keys = spec.limit !== undefined ? [child[GROUP_KEY]] : own;
    if (spec.limit !== undefined) delete child[GROUP_KEY];
    for (const k of keys) {
      const key = keyOf(k);
      if (!unique.has(key)) continue;
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push(child);
    }
  }

  if (strip) for (const c of children) delete c[strip];
  if (spec.include && children.length) {
    const kids = dedupe(children);
    await attachIncludes(kids, spec.include);
    const drop = nested.added.filter((f) => !(f in spec.include!));
    if (drop.length) for (const c of kids) for (const f of drop) delete c[f];
  }

  const inPlace = p.name === p.local;
  parents.forEach((parent, i) => {
    const raw = getPath(parent, p.local);
    const values = p.perParent[i];
    if (many) {
      const seen = new Set<unknown>();
      const out: Record<string, unknown>[] = [];
      for (const v of values) {
        for (const c of byKey.get(keyOf(v)) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          out.push(c);
        }
      }
      parent[p.name] = out;
    } else if (Array.isArray(raw)) {
      parent[p.name] = values.flatMap((v) => byKey.get(keyOf(v))?.[0] ?? []);
    } else if (raw === undefined && inPlace) {
      // Leave a missing id missing (Mongoose parity).
    } else {
      parent[p.name] = values.length ? (byKey.get(keyOf(values[0]))?.[0] ?? null) : null;
    }
  });
}

function dedupe(docs: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...new Set(docs)];
}

/** Field the per-parent-limit aggregate adds to carry the matched value; removed before returning. */
export const GROUP_KEY = '__krepisKey';
