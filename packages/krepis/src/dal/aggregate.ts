import type { AggregationCursor, ClientSession, Db, Document, ObjectId } from 'mongodb';
import type { Collection, Filter, Sort } from './collection.ts';
import { refuseServerJs, type Doc, type Schema } from './schema.ts';
import type { Leaf, OmitPaths, PathMap, PickPaths } from './paths.ts';
import { INCLUDE, type IncludeTarget } from './include.ts';
import { clientOf } from './transaction.ts';

/**
 * A typed aggregation pipeline. Stages use MongoDB's own syntax; each one is checked
 * against the documents the previous stage produced, and returns a builder typed by what it
 * produces. A scoped collection prepends its scope, and `$lookup` into a scoped collection keeps
 * that collection's scope.
 */

// ---------------------------------------------------------------------------
// Types: field paths and expressions
// ---------------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type Merge<A, B> = Simplify<Omit<A, keyof B> & B>;
type Paths<D> = keyof PathMap<D> & string;

/** A `$path` reference to a field of `D`. */
export type FieldRef<D> = `$${Paths<D>}`;

type FieldOf<V, K extends string> = V extends null | undefined ? undefined : V extends Leaf ? undefined : K extends keyof V ? V[K] : undefined;
type StepInto<V, T extends string> = unknown extends V
  ? unknown
  : V extends null | undefined
    ? undefined
    : V extends readonly (infer E)[]
      ? Exclude<AggValue<E, T>, undefined>[] // a path through an array yields an array; missing values are dropped
      : AggValue<V, T>;
/** The value of field path `P` in an aggregation expression. Unlike in a filter, a path through an array yields an array. */
export type AggValue<V, P extends string> = unknown extends V
  ? unknown
  : P extends `${infer H}.${infer T}`
    ? StepInto<FieldOf<V, H>, T>
    : FieldOf<V, P>;

type ElementOf<V> = NonNullable<V> extends readonly (infer E)[] ? E : unknown;
type Missing<T> = T extends undefined ? null : T;

type NumberOps =
  | '$multiply' | '$divide' | '$mod' | '$abs' | '$ceil' | '$floor' | '$round' | '$trunc' | '$sqrt' | '$pow' | '$exp'
  | '$ln' | '$log' | '$log10' | '$size' | '$strLenCP' | '$strLenBytes' | '$indexOfArray' | '$indexOfCP' | '$indexOfBytes'
  | '$toInt' | '$toDouble' | '$toLong' | '$cmp' | '$strcasecmp' | '$year' | '$month' | '$dayOfMonth' | '$dayOfWeek'
  | '$dayOfYear' | '$hour' | '$minute' | '$second' | '$millisecond' | '$week' | '$isoWeek' | '$isoWeekYear'
  | '$isoDayOfWeek' | '$dateDiff' | '$sum';
type StringOps =
  | '$concat' | '$toUpper' | '$toLower' | '$substr' | '$substrCP' | '$substrBytes' | '$trim' | '$ltrim' | '$rtrim'
  | '$toString' | '$dateToString' | '$replaceOne' | '$replaceAll' | '$type';
type BooleanOps =
  | '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$and' | '$or' | '$not' | '$in' | '$isArray' | '$isNumber'
  | '$regexMatch' | '$allElementsTrue' | '$anyElementTrue' | '$setIsSubset' | '$setEquals';
type DateOps = '$toDate' | '$dateFromString' | '$dateAdd' | '$dateSubtract' | '$dateTrunc' | '$dateFromParts';
type ArrayOps = '$filter' | '$slice' | '$reverseArray' | '$sortArray' | '$setUnion' | '$setIntersection' | '$setDifference';
/** Operators whose operands must be numbers. `$add` and `$subtract` also take dates. */
type NumericArgOps = '$multiply' | '$divide' | '$mod' | '$abs' | '$ceil' | '$floor' | '$round' | '$trunc' | '$sqrt' | '$pow' | '$exp' | '$ln' | '$log' | '$log10';
type StringArgOps = '$concat' | '$toUpper' | '$toLower' | '$trim' | '$ltrim' | '$rtrim' | '$strLenCP' | '$strLenBytes';

type HasDate<T> = true extends { [I in keyof T]: [NonNullable<T[I]>] extends [Date] ? true : false }[keyof T & number] ? true : false;

/** $add with a date operand is a date; $subtract of a number from a date is a date. Otherwise numbers. */
type AddSubType<D, E> = E extends { $add: infer A }
  ? HasDate<ExprType<D, A>> extends true ? Date : number
  : E extends { $subtract: readonly [infer A, infer B] }
    ? [ExprType<D, A>, ExprType<D, B>] extends [Date, number] ? Date : number
    : number;

/** The type of an operator expression `{ $op: args }`. Operators not listed here are `unknown`. */
type OpType<D, E> = keyof E extends infer K
  ? K extends '$add' | '$subtract'
    ? AddSubType<D, E>
    : K extends NumberOps
      ? number
      : K extends '$avg' | '$stdDevPop' | '$stdDevSamp'
        ? number | null
        : K extends StringOps
          ? string
          : K extends BooleanOps
            ? boolean
            : K extends DateOps
              ? Date
              : K extends '$toObjectId'
                ? ObjectId
                : K extends '$literal'
                  ? Mutable<E[K & keyof E]>
                  : K extends '$cond'
                    ? CondType<D, E[K & keyof E]>
                    : K extends '$ifNull'
                      ? E[K & keyof E] extends readonly [infer A, infer B]
                        ? NonNullable<ExprType<D, A>> | ExprType<D, B>
                        : unknown
                      : K extends '$arrayElemAt'
                        ? E[K & keyof E] extends readonly [infer A, unknown]
                          ? ElementOf<ExprType<D, A>> | undefined
                          : unknown
                        : K extends '$first' | '$last'
                          ? ElementOf<ExprType<D, E[K & keyof E]>> | undefined
                          : K extends ArrayOps
                            ? E[K & keyof E] extends readonly [infer A, ...unknown[]]
                              ? ExprType<D, A>
                              : E[K & keyof E] extends { input: infer A }
                                ? ExprType<D, A>
                                : ExprType<D, E[K & keyof E]>
                            : K extends '$concatArrays'
                              ? E[K & keyof E] extends readonly unknown[]
                                ? ElementOf<ExprType<D, E[K & keyof E][number]>>[]
                                : unknown
                              : unknown
  : never;

type CondType<D, A> = A extends readonly [unknown, infer T, infer F]
  ? ExprType<D, T> | ExprType<D, F>
  : A extends { then: infer T; else: infer F }
    ? ExprType<D, T> | ExprType<D, F>
    : unknown;

type Mutable<T> = T extends Leaf ? T : T extends readonly unknown[] ? { -readonly [I in keyof T]: Mutable<T[I]> } : { -readonly [K in keyof T]: Mutable<T[K]> };

/** The value an aggregation expression produces against documents `D`. */
export type ExprType<D, E> = E extends '$$ROOT' | '$$CURRENT'
  ? D
  : E extends `$$${string}`
    ? unknown
    : E extends `$${infer P}`
      ? AggValue<D, P>
      : E extends Leaf
        ? E
        : E extends readonly unknown[]
          ? { -readonly [I in keyof E]: ExprType<D, E[I]> }
          : E extends object
            ? [Extract<keyof E, `$${string}`>] extends [never]
              ? { -readonly [K in keyof E]: ExprType<D, E[K]> }
              : OpType<D, E>
            : unknown;

type Accepts<V, T> = unknown extends V ? true : [Exclude<V, null | undefined>] extends [T] ? true : false;
type TypedRef<D, T> = { [P in Paths<D>]: Accepts<AggValue<D, P>, T> extends true ? `$${P}` : never }[Paths<D>];
type ValidOperand<D, X, T> =
  ValidExpr<D, X> extends infer V ? ([X] extends [V] ? (Accepts<ExprType<D, X>, T> extends true ? X : TypedRef<D, T>) : V) : never;
type ValidArgs<D, A, T> = A extends readonly unknown[] ? { [I in keyof A]: ValidOperand<D, A[I], T> } : ValidOperand<D, A, T>;

/**
 * `E` where it is a valid expression against `D`; otherwise the part that is wrong is replaced
 * by what it should be, so the error points at it (a misspelled `$path`, or an operand of the
 * wrong type for an arithmetic or string operator).
 */
export type ValidExpr<D, E> = E extends `$$${string}`
  ? E
  : E extends `$${string}`
    ? E extends FieldRef<D>
      ? E
      : FieldRef<D>
    : E extends Leaf
      ? E
      : E extends readonly unknown[]
        ? { [I in keyof E]: ValidExpr<D, E[I]> }
        : E extends object
          ? {
              [K in keyof E]: K extends NumericArgOps
                ? ValidArgs<D, E[K], number>
                : K extends '$add' | '$subtract'
                  ? ValidArgs<D, E[K], number | Date>
                  : K extends StringArgOps
                    ? ValidArgs<D, E[K], string>
                    : ValidExpr<D, E[K]>;
            }
          : E;

// ---------------------------------------------------------------------------
// Types: stages
// ---------------------------------------------------------------------------

type ValidAcc<D, A> = {
  [K in keyof A]: K extends '$sum' | '$avg' | '$stdDevPop' | '$stdDevSamp'
    ? ValidOperand<D, A[K], number>
    : K extends '$count'
      ? Record<string, never>
      : ValidExpr<D, A[K]>;
};

type AccType<D, A> = A extends { $sum: unknown } | { $count: unknown }
  ? number
  : A extends { $avg: unknown } | { $stdDevPop: unknown } | { $stdDevSamp: unknown }
    ? number | null
    : A extends { $min: infer E } | { $max: infer E } | { $first: infer E } | { $last: infer E }
      ? Missing<ExprType<D, E>>
      : A extends { $push: infer E } | { $addToSet: infer E }
        ? Exclude<ExprType<D, E>, undefined>[]
        : A extends { $firstN: { input: infer E } } | { $lastN: { input: infer E } } | { $maxN: { input: infer E } } | { $minN: { input: infer E } }
          ? Exclude<ExprType<D, E>, undefined>[]
          : A extends { $top: { output: infer E } } | { $bottom: { output: infer E } }
            ? ExprType<D, E>
            : A extends { $topN: { output: infer E } } | { $bottomN: { output: infer E } }
              ? ExprType<D, E>[]
              : unknown;

export type GroupSpec = { readonly _id: unknown } & { readonly [field: string]: unknown };
export type ValidGroup<D, G> = { [K in keyof G]: K extends '_id' ? ValidExpr<D, G[K]> : ValidAcc<D, G[K]> };
/** `$group` output: the key, with a missing key as `null`, and one field per accumulator. */
export type GroupOut<D, G> = Simplify<
  { _id: Missing<ExprType<D, G['_id' & keyof G]>> } & { -readonly [K in Exclude<keyof G, '_id'>]: AccType<D, G[K]> }
>;

type IsFlag<V> = [V] extends [0 | 1 | boolean] ? true : false;
type ProjKeys<P> = Exclude<keyof P, '_id'> & string;
type Included<P> = { [K in ProjKeys<P>]-?: P[K] extends 1 | true ? K : never }[ProjKeys<P>];
type Excluded<P> = { [K in ProjKeys<P>]-?: P[K] extends 0 | false ? K : never }[ProjKeys<P>];
type Computed<P> = { [K in ProjKeys<P>]-?: IsFlag<P[K]> extends true ? never : K }[ProjKeys<P>];
type IdPart<D, P> = '_id' extends keyof P
  ? P['_id'] extends 0 | false
    ? unknown
    : P['_id'] extends 1 | true
      ? Pick<D, '_id' & keyof D>
      : { _id: ExprType<D, P['_id']> }
  : Pick<D, '_id' & keyof D>;

/** `$project` output: an exclusion removes paths; otherwise the included paths and computed fields. */
export type ProjectOut<D, P> = [Excluded<P>] extends [never]
  ? [Included<P> | Computed<P>] extends [never]
    ? Simplify<IdPart<D, P> & Omit<D, '_id'>>
    : Simplify<IdPart<D, P> & PickPaths<D, Included<P>> & { -readonly [K in Computed<P>]: ExprType<D, P[K]> }>
  : OmitPaths<D, Excluded<P> | (P extends { _id: 0 | false } ? '_id' : never)>;

export type ValidProject<D, P> = {
  [K in keyof P]: K extends '_id'
    ? IsFlag<P[K]> extends true ? P[K] : ValidExpr<D, P[K]>
    : IsFlag<P[K]> extends true
      ? K extends Paths<D> ? P[K] : `Krepis: "${K & string}" is not a field of these documents`
      : P[K] extends number
        ? 0 | 1 // any other number means inclusion to the server; use { $literal: n } for a constant
        : K extends `${string}.${string}`
          ? `Krepis: a computed field cannot be dotted ("${K}")`
          : ValidExpr<D, P[K]>;
} & ([Excluded<P>] extends [never]
  ? unknown
  : [Included<P> | Computed<P>] extends [never]
    ? unknown
    : { 'Krepis: a $project cannot mix exclusion with inclusion or computed fields (other than _id)': never });

export type ValidFields<D, F> = { [K in keyof F]: K extends `${string}.${string}` ? `Krepis: addFields keys cannot be dotted ("${K}")` : ValidExpr<D, F[K]> };
export type AddFieldsOut<D, F> = Merge<D, { -readonly [K in keyof F]: ExprType<D, F[K]> }>;

type ArrayField<D> = { [K in keyof D & string]-?: NonNullable<D[K]> extends readonly unknown[] ? K : never }[keyof D & string];
type Unwound<D, K extends keyof D, B, I extends string> = Merge<
  D,
  { [P in K]: ElementOf<D[K]> | (B extends true ? null | undefined : never) } & {
    [P in I]: B extends true ? number | null : number;
  }
>;

type Joined<D, As extends string, R> = Merge<D, { [K in As]: R[] }>;

/**
 * `X` when it is valid, otherwise the corrected shape, so the error names what was expected.
 * The check is wrapped in a tuple: the distributive form `X extends V ? X : V` loses `const` inference,
 * which widens `{ title: 1 }` to `{ title: number }` and every `$path` to `string`. The fallback is `NoInfer`
 * so the corrected shape is never inferred from.
 */
type Checked<X, V> = [X] extends [V] ? X : NoInfer<V>;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** @internal How a builder reaches its collection. */
export interface AggregateSource {
  collection: string;
  db: () => Db;
  /** Casts a filter by the collection's schema (no scope: that is the first stage). */
  cast: (filter: Record<string, unknown>) => Document;
  /** Checks a filter as `cast` does, without casting it: a `$match` passed to `stage()`. */
  check: (filter: Record<string, unknown>) => void;
  /** Fields left out of results while the documents still have their stored shape. */
  hidden: readonly string[];
  checkUnbounded: () => void;
  exec: <T>(fn: (session: ClientSession | undefined) => Promise<T>) => Promise<T>;
  open: (pipeline: Document[], session: ClientSession | undefined) => AggregationCursor<Document>;
  session: () => ClientSession | undefined;
}

/** Stages after which the documents are no longer stored documents, so `$match` stops casting. Others keep them. */
const KEEPS_SHAPE = new Set(['$match', '$sort', '$limit', '$skip', '$sample']);
/** Stages that bound the result. */
const BOUNDED = new Set(['$limit', '$count', '$sample']);
/** Stages that read or write another collection, which `stage()` cannot scope. */
const FOREIGN = new Set(['$lookup', '$graphLookup', '$unionWith', '$out', '$merge']);
/** Stages whose output carries only the fields they name, so a hidden field is there only if named. */
const REBUILDS = new Set(['$group', '$replaceWith', '$replaceRoot', '$count', '$bucket', '$bucketAuto', '$facet']);

/** Stages that keep stored documents whole, so hidden fields can stay until the first stage that is not one. */
const PASSES = new Set([...KEEPS_SHAPE, '$geoNear', '$search', '$searchMeta', '$vectorSearch']);

/** Whether a stage names `field`: as a key, as a `$field` reference, or as a `$lookup` `localField`. */
function names(value: unknown, field: string): boolean {
  if (typeof value === 'string') return value === `$${field}` || value.startsWith(`$${field}.`);
  if (Array.isArray(value)) return value.some((v) => names(v, field));
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).some(
    ([k, v]) => k === field || k.startsWith(`${field}.`) || (k === 'localField' && v === field) || names(v, field),
  );
}

function rebuilds(stage: Document): boolean {
  const [op] = Object.keys(stage);
  if (op !== '$project') return REBUILDS.has(op);
  // An exclusion projection keeps every field it does not name.
  const body = stage.$project as Record<string, unknown>;
  return Object.entries(body).some(([k, v]) => k !== '_id' && v !== 0 && v !== false);
}

function reachesForeign(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = reachesForeign(v);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (FOREIGN.has(k)) return k;
    const hit = reachesForeign(v);
    if (hit) return hit;
  }
  return undefined;
}

function sameDatabase(a: Db, b: Db): boolean {
  return a.databaseName === b.databaseName && clientOf(a) === clientOf(b);
}

interface LookupSpec {
  from: Collection<Schema>;
  as: string;
  localField?: string;
  foreignField?: string;
  let?: Record<string, unknown>;
  pipeline?: (p: Aggregate<Document, boolean>) => Aggregate<unknown, boolean>;
}

/**
 * An aggregation pipeline on a collection, typed stage by stage. Builders are immutable: each
 * stage returns a new one. `C` is whether `$match` is still cast by the schema, which holds until
 * the first stage that reshapes the documents.
 */
export class Aggregate<D, C extends boolean = true> {
  readonly #src: AggregateSource;
  readonly #stages: readonly Document[];
  readonly #cast: boolean;
  readonly #checks: readonly (() => void)[];
  /** Whether hidden fields may still be in the documents: no stage has rebuilt them yet. */
  readonly #exposed: boolean;

  /** @internal Use `collection.aggregate()`. */
  constructor(src: AggregateSource, stages: Document[] = [], cast = true, checks: (() => void)[] = [], exposed = true) {
    this.#src = src;
    this.#stages = stages;
    this.#cast = cast;
    this.#checks = checks;
    this.#exposed = exposed;
  }

  /** `scanned`: the caller already refused server-side JavaScript in the stage's source. */
  #with<T, K extends boolean>(stage: Document, check?: () => void, scanned = false): Aggregate<T, K> {
    if (!scanned) refuseServerJs(stage, '');
    const op = Object.keys(stage)[0];
    const cast = this.#cast && KEEPS_SHAPE.has(op);
    const checks = check ? [...this.#checks, check] : [...this.#checks];
    return new Aggregate<T, K>(this.#src, [...this.#stages, stage], cast, checks, this.#exposed && !rebuilds(stage));
  }

  /** Filters documents. Values are cast by the schema until the first stage that reshapes the documents. */
  match(filter: Filter<D, C>): Aggregate<D, C> {
    const f = filter as Record<string, unknown>;
    if (this.#cast) return this.#with({ $match: this.#src.cast(f) }, undefined, true);
    refuseServerJs(f, '$match');
    return this.#with({ $match: f }, undefined, true);
  }

  sort(sort: Sort<D>): Aggregate<D, C> {
    return this.#with({ $sort: sort });
  }

  limit(n: number): Aggregate<D, C> {
    return this.#with({ $limit: n });
  }

  skip(n: number): Aggregate<D, C> {
    return this.#with({ $skip: n });
  }

  sample(size: number): Aggregate<D, C> {
    return this.#with({ $sample: { size } });
  }

  /** Groups documents. Each output field is an accumulator, typed by its expression (`$sum` takes numbers only). */
  group<const G extends GroupSpec>(spec: Checked<G, ValidGroup<D, G>>): Aggregate<GroupOut<D, G>, false> {
    return this.#with({ $group: spec });
  }

  /** Reshapes documents: include paths with 1, exclude them with 0, or compute fields from expressions. */
  project<const P extends { readonly [k: string]: unknown }>(spec: Checked<P, ValidProject<D, P>>): Aggregate<ProjectOut<D, P>, false> {
    return this.#with({ $project: spec });
  }

  /** Adds or replaces top-level fields computed from expressions. */
  addFields<const F extends { readonly [k: string]: unknown }>(fields: Checked<F, ValidFields<D, F>>): Aggregate<AddFieldsOut<D, F>, false> {
    return this.#with({ $addFields: fields });
  }

  /** Alias of `addFields`. */
  set<const F extends { readonly [k: string]: unknown }>(fields: Checked<F, ValidFields<D, F>>): Aggregate<AddFieldsOut<D, F>, false> {
    return this.#with({ $set: fields });
  }

  unset<const P extends readonly Paths<D>[]>(...paths: P): Aggregate<OmitPaths<D, P[number]>, false> {
    return this.#with({ $unset: paths.length === 1 ? paths[0] : [...paths] });
  }

  /** One document per array element; the field becomes the element. */
  unwind<K extends ArrayField<D>>(path: `$${K}`): Aggregate<Unwound<D, K, false, never>, false>;
  unwind<K extends ArrayField<D>, const B extends boolean = false, const I extends string = never>(spec: {
    path: `$${K}`;
    preserveNullAndEmptyArrays?: B;
    includeArrayIndex?: I;
  }): Aggregate<Unwound<D, K, B, I>, false>;
  unwind(spec: string | Document): Aggregate<unknown, false> {
    return this.#with({ $unwind: spec });
  }

  /**
   * Joins another Krepis collection. `foreignField` is checked against the target schema, and a
   * scoped target keeps its scope: the join reads only the documents its own reads would.
   * `pipeline` runs on the joined documents, as a builder on the target collection.
   */
  lookup<Y extends Schema, const As extends string, R = Doc<Y>>(spec: {
    from: Collection<Y>;
    localField: Paths<D>;
    foreignField: Paths<Doc<Y>>;
    as: As;
    pipeline?: (p: Aggregate<Doc<Y>>) => Aggregate<R, boolean>;
  }): Aggregate<Joined<D, As, R>, false>;
  lookup<Y extends Schema, const As extends string, R>(spec: {
    from: Collection<Y>;
    as: As;
    let?: { [name: string]: unknown };
    pipeline: (p: Aggregate<Doc<Y>>) => Aggregate<R, boolean>;
  }): Aggregate<Joined<D, As, R>, false>;
  lookup(spec: LookupSpec): Aggregate<unknown, false> {
    const target = (spec.from as unknown as Record<symbol, (() => IncludeTarget) | undefined>)[INCLUDE]?.();
    if (!target) throw new TypeError('Krepis: lookup() takes a Krepis collection, so its scope can apply; use stage() for anything else');
    const sub = spec.from.aggregate() as unknown as Aggregate<Document, boolean>;
    const pipeline = (spec.pipeline ? spec.pipeline(sub) : sub).pipeline();
    const stage: Document = { from: spec.from.name };
    if (spec.localField !== undefined) stage.localField = spec.localField;
    if (spec.foreignField !== undefined) stage.foreignField = spec.foreignField;
    if (spec.let) {
      refuseServerJs(spec.let, 'let');
      stage.let = spec.let;
    }
    if (pipeline.length) stage.pipeline = pipeline;
    stage.as = spec.as;
    // The joined pipeline was checked stage by stage when it was built.
    return this.#with({ $lookup: stage }, () => {
      if (!sameDatabase(this.#src.db(), target.database())) {
        throw new TypeError(`Krepis: lookup() into "${spec.from.name}" crosses databases; $lookup reads from the pipeline's own database`);
      }
    }, true);
  }

  /** Replaces the document with `{ [field]: count }`. */
  count<const K extends string>(field: K): Aggregate<{ [P in K]: number }, false> {
    return this.#with({ $count: field });
  }

  /** Replaces each document with the result of an expression. */
  replaceWith<const E extends { readonly [k: string]: unknown } | string>(
    expr: Checked<E, ValidExpr<D, E>>,
  ): Aggregate<ExprType<D, E> extends object ? ExprType<D, E> : Document, false> {
    return this.#with({ $replaceWith: expr });
  }

  /**
   * Appends a stage that has no typed method, typed by `T`. Stages that read or write another
   * collection are refused, because their scope cannot be applied; use `lookup()`, or the driver.
   */
  stage<T = Document>(stage: Document): Aggregate<T, false> {
    const foreign = reachesForeign(stage);
    if (foreign) throw new TypeError(`Krepis: stage() cannot run ${foreign}, which bypasses the target's scope; use lookup() or raw()`);
    refuseServerJs(stage, '');
    // A $match on stored documents gets the same input checks as match(), without the cast (compat keeps Mongoose's uncast $match).
    const keys = Object.keys(stage);
    if (this.#cast && keys.length === 1 && keys[0] === '$match' && stage.$match !== null && typeof stage.$match === 'object') {
      this.#src.check(stage.$match as Record<string, unknown>);
    }
    return this.#with({ ...stage }, undefined, true);
  }

  /**
   * The pipeline as sent, including any scope stage. Hidden fields are removed before the first stage that does
   * more than filter, sort or limit stored documents, unless that stage or a later one names them; those are
   * removed at the end while the documents still have their stored shape.
   */
  pipeline(): Document[] {
    for (const check of this.#checks) check();
    const hidden = this.#src.hidden;
    const stages = [...this.#stages];
    if (hidden.length === 0) return stages;
    const at = stages.findIndex((s) => !PASSES.has(Object.keys(s)[0]!));
    if (at === -1) return [...stages, { $unset: [...hidden] }];
    // A filter reads a field without passing it on, so a $match does not opt in (its values may be input).
    const later = stages.slice(at).filter((s) => !('$match' in s));
    const named = hidden.filter((h) => later.some((s) => names(s, h)));
    const dropped = hidden.filter((h) => !named.includes(h));
    if (dropped.length) stages.splice(at, 0, { $unset: dropped });
    if (named.length && this.#exposed) stages.push({ $unset: named });
    return stages;
  }

  /** Runs the pipeline. Without `$limit`, `$count` or `$sample` this follows the `unboundedReads` policy. */
  async toArray(): Promise<D[]> {
    if (!this.#stages.some((s) => BOUNDED.has(Object.keys(s)[0]))) this.#src.checkUnbounded();
    return this.#run(this.pipeline());
  }

  /** Runs the pipeline and returns every result, deliberately. */
  all(): Promise<D[]> {
    return this.#run(this.pipeline());
  }

  async first(): Promise<D | null> {
    const [doc] = await this.#run([...this.pipeline(), { $limit: 1 }]);
    return doc ?? null;
  }

  /** The driver cursor, for streaming. Inside a transaction it joins it. */
  cursor(): AggregationCursor<D> {
    return this.#src.open(this.pipeline(), this.#src.session()) as unknown as AggregationCursor<D>;
  }

  #run(pipeline: Document[]): Promise<D[]> {
    return this.#src.exec((session) => this.#src.open(pipeline, session).toArray()) as Promise<D[]>;
  }
}
