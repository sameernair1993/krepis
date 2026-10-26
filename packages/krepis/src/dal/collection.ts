import type { ClientSession, Collection as DriverCollection, Db, FindCursor, Document, MongoClient } from 'mongodb';
import { activeAttempt, clientOf } from './transaction.ts';
import {
  applyDefaults,
  applyUpdateTimestamps,
  applyUpsertDefaults,
  brandError,
  castDocument,
  castFilter,
  castPipeline,
  checkFilter,
  castUpdate,
  castValue,
  hiddenFields,
  isBrandedError,
  normalizeUpdate,
  resolvePath,
  validate,
  type Bson,
  type Castable,
  type Doc,
  type Insert,
  type Schema,
  type UpdateDoc,
} from './schema.ts';
import {
  attachIncludes,
  GROUP_KEY,
  INCLUDE,
  localFields,
  widen,
  type IncludeMap,
  type IncludeRead,
  type IncludeTarget,
  type ValidateIncludes,
  type WithIncludes,
} from './include.ts';
import type { CheckProjection, PathMap, Project } from './paths.ts';
import { Aggregate } from './aggregate.ts';
import { isTrusted, op, type UpdatePipeline } from './input.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type Operators<V> = {
  $eq?: V | null;
  $ne?: V | null;
  $gt?: V;
  $gte?: V;
  $lt?: V;
  $lte?: V;
  $in?: (V | null)[];
  $nin?: (V | null)[];
  $exists?: boolean;
  $regex?: string | RegExp;
  $options?: string;
  $not?: Operators<V> | RegExp;
  $elemMatch?: Record<string, unknown>;
  $size?: number;
  $all?: V[];
  $type?: string | number;
};

// Geospatial operators. Offered only where a geometry can live: a GeoJSON-shaped object
// (`{ coordinates }`) or a number array (a legacy coordinate pair). The runtime passes them through uncast.
type GeoPoint = readonly number[];
type Geometry = { type: string; coordinates: readonly unknown[]; crs?: unknown };
type GeoShape =
  | { $geometry: Geometry }
  | { $box: readonly [GeoPoint, GeoPoint] }
  | { $polygon: readonly GeoPoint[] }
  | { $center: readonly [GeoPoint, number] }
  | { $centerSphere: readonly [GeoPoint, number] };
type NearGeometry = { $geometry: Geometry; $maxDistance?: number; $minDistance?: number };
type GeoOperators = {
  $geoWithin?: GeoShape;
  $geoIntersects?: { $geometry: Geometry };
  $near?: NearGeometry | GeoPoint;
  $nearSphere?: NearGeometry | GeoPoint;
  $maxDistance?: number;
  $minDistance?: number;
};
type Geo<T> = [NonNullable<T>] extends [readonly number[] | { coordinates: unknown }] ? GeoOperators : unknown;

// Deliberately non-distributive: for a union field (`'running' | 'success'`) a naked `T extends …` would split into
// `Operators<'running'> | Operators<'success'>`, and a mixed `$in: ['running', 'success']` would fit no branch.
// NonNullable keeps an optional array field (`string[] | undefined`) on the array branch.
// `C`: whether values are cast by the schema (a hex string for an ObjectId). An aggregate stops casting once it reshapes.
type Val<T, C extends boolean> = C extends true ? Castable<T> : T;
type Condition<T, C extends boolean = true> =
  [NonNullable<T>] extends [readonly (infer E)[]]
    ? Val<T, C> | Val<E, C> | null | RegExp | (Operators<Val<E, C> | Val<T, C>> & Geo<T>)
    : Val<T, C> | null | RegExp | (Operators<Val<T, C>> & Geo<T>);

type Conditions<M, C extends boolean> = { [P in keyof M]?: Condition<M[P], C> };

/**
 * A MongoDB filter whose values are typed (and cast) by the schema. Dotted paths are typed too,
 * including implicit array traversal (`items.qty`) and indexes (`items.0.qty`).
 */
export type Filter<D, C extends boolean = true> = Conditions<PathMap<D>, C> & {
  $and?: Filter<D, C>[];
  $or?: Filter<D, C>[];
  $nor?: Filter<D, C>[];
  $expr?: Record<string, unknown>;
  $comment?: string;
  /** Server-side JavaScript: refused unless the filter is built with `op`. */
  $where?: string;
};

type UpdatePaths<D> = PathMap<D, 'update'>;
type Settable<M> = { [P in Exclude<keyof M, '_id'>]?: Castable<M[P]> | null };
/** `$set` and friends: closed so an `_id`-only schema names nothing. */
type SetOp<M> = Closed<Settable<M>>;
// A literal-number union (a numeric enum) is not numeric here: `$inc` would store an unchecked result.
type IsNumeric<V> = unknown extends V ? true : [NonNullable<V>] extends [number] ? (number extends NonNullable<V> ? true : false) : false;
type Numeric<M> = Closed<{ [P in keyof M as IsNumeric<M[P]> extends true ? P : never]?: number }>;
/** An empty mapped type is `{}`, which skips excess-property checks and so accepts any key. */
type Closed<T> = [keyof T] extends [never] ? Record<string, never> : T;
type ElementOf<V> = unknown extends V ? unknown : NonNullable<V> extends readonly (infer E)[] ? E : never;
type ArrayPaths<M> = keyof { [P in keyof M as [ElementOf<M[P]>] extends [never] ? never : P]: 0 };
type Each<E> = {
  $each: Castable<E>[];
  $position?: number;
  $slice?: number;
  $sort?: 1 | -1 | Record<string, 1 | -1>;
};
type PullCondition<E> = [NonNullable<E>] extends [Record<string, unknown>]
  ? Castable<E> | Filter<NonNullable<E>>
  : Condition<E>;

/**
 * A MongoDB update. Top-level non-operator keys are treated as `$set`, so a plain
 * object updates fields rather than replacing the document. Paths are typed, with the
 * positional forms `items.$`, `items.$[]` and `items.$[id]`.
 */
export type Update<D, M = UpdatePaths<D>> = Settable<M> & {
  $set?: SetOp<M>;
  $setOnInsert?: SetOp<M>;
  $unset?: { [P in keyof M]?: '' | 1 | true };
  $inc?: Numeric<M>;
  $mul?: Numeric<M>;
  $min?: SetOp<M>;
  $max?: SetOp<M>;
  $push?: Closed<{ [P in ArrayPaths<M>]?: Castable<ElementOf<M[P]>> | Each<ElementOf<M[P]>> }>;
  $addToSet?: Closed<{ [P in ArrayPaths<M>]?: Castable<ElementOf<M[P]>> | Pick<Each<ElementOf<M[P]>>, '$each'> }>;
  $pull?: Closed<{ [P in ArrayPaths<M>]?: PullCondition<ElementOf<M[P]>> }>;
  $pullAll?: Closed<{ [P in ArrayPaths<M>]?: Castable<ElementOf<M[P]>>[] }>;
};

export type Sort<D> = { [P in keyof PathMap<D>]?: 1 | -1 };
export type Projection<D> = { [P in keyof PathMap<D>]?: 0 | 1 };

export interface ReadOptions<D, P = Projection<D>> {
  sort?: Sort<D>;
  projection?: P;
}

export interface WriteResult {
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: unknown;
}

export type BulkOp<X extends Schema> =
  | { insertOne: { document: Insert<X> } }
  | { updateOne: { filter: Filter<Doc<X>>; update: Update<Doc<X>> | UpdatePipeline<Doc<X>>; upsert?: boolean } }
  | { updateMany: { filter: Filter<Doc<X>>; update: Update<Doc<X>> | UpdatePipeline<Doc<X>>; upsert?: boolean } }
  | { deleteOne: { filter: Filter<Doc<X>> } }
  | { deleteMany: { filter: Filter<Doc<X>> } };

/**
 * Per-operation scope, used for multi-tenancy. Resolved once per operation, so a
 * hook can read request context (AsyncLocalStorage) and fail closed by throwing.
 */
export interface ScopeContext {
  /** Conditions ANDed into every filter, and so into every upserted document. */
  filter?: Record<string, unknown>;
  /** Called on every document before it is inserted. */
  stamp?: (doc: Record<string, unknown>) => void;
  /** May rewrite an update; returning null drops the operation, which then matches nothing. */
  update?: (update: UpdateDoc) => UpdateDoc | null;
}
export type ScopeHook = (operation: string) => ScopeContext | undefined;

export type UnboundedReads = 'error' | 'warn' | 'allow';

export interface DalContext {
  db: () => Db;
  bson: Bson;
  unboundedReads: UnboundedReads;
  /** Refuse operator objects not built by `op` where the schema expects a scalar. */
  strictInput: boolean;
}

/** A projection value that returns the field: `$slice` and `$meta` alone return every field, as `0` does. */
function includes(value: unknown): boolean {
  if (value === 0 || value === false || value === null || value === undefined) return false;
  if (typeof value !== 'object') return true;
  const ops = Object.keys(value);
  return !(ops.length > 0 && ops.every((k) => k === '$slice' || k === '$meta'));
}

/** Leaves hidden fields out of a projection unless it includes them by name. */
function hide(projection: Document | undefined, hidden: readonly string[]): Document | undefined {
  if (hidden.length === 0) return projection;
  if (projection) {
    const entries = Object.entries(projection);
    const onlyId = entries.length === 1 && entries[0]![0] === '_id' && includes(entries[0]![1]);
    if (onlyId || entries.some(([k, v]) => k !== '_id' && includes(v))) return projection;
  }
  const out: Document = { ...projection };
  for (const h of hidden) if (!(h in out)) out[h] = 0;
  return out;
}

/** The scope hook refused an update: the operation matches nothing. */
const DROPPED = Symbol('dropped');

/**
 * Drivers before 5.7 ignore `includeResultMetadata` and always return `{ value, ok }`; later ones return
 * it only when asked. Always asking makes the shape identical across the supported range.
 */
function unwrapModifyResult<D>(res: unknown): D | null {
  return ((res as { value?: D | null } | null)?.value ?? null) as D | null;
}

export class KrepisUnboundedReadError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedError(value, 'KrepisUnboundedReadError');
  }
  constructor(collection: string) {
    super(
      `Unbounded read on "${collection}": add .limit(n), or call .all() to read every match deliberately`,
    );
    this.name = 'KrepisUnboundedReadError';
    brandError(this, 'KrepisUnboundedReadError');
  }
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

/**
 * A read. `D` is the stored document, `P` the projection given to `.select()` and `S` the
 * relations given to `.include()`; a row is `D` narrowed by `P` with the relations attached.
 * Relations survive any projection, so the two compose in either order.
 */
export type Row<D, P, S> = WithIncludes<D, S, Project<D, P>>;
type Merge<A, B> = Omit<A, keyof B> & B;

/** @internal How a query reaches the driver, inside or outside a transaction. */
export interface QueryBinding {
  open: (session: ClientSession | undefined) => FindCursor<Document>;
  exec: <T>(operation: string, fn: (session: ClientSession | undefined) => Promise<T>) => Promise<T>;
  session: () => ClientSession | undefined;
  /** The projection actually sent: hidden fields are left out unless it names them. */
  hide: (projection: Document | undefined) => Document | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class Query<D, P = {}, S = {}> {
  readonly #bind: QueryBinding;
  readonly #collection: string;
  readonly #policy: UnboundedReads;
  #sort?: Sort<D>;
  #projection?: Projection<D>;
  #skip?: number;
  #limit?: number;
  #includes?: IncludeMap;

  constructor(bind: QueryBinding, collection: string, policy: UnboundedReads) {
    this.#bind = bind;
    this.#collection = collection;
    this.#policy = policy;
  }

  sort(sort: Sort<D>): this {
    this.#sort = sort;
    return this;
  }

  /** Projects the result; a literal projection narrows the row type. Replaces any earlier select. */
  select<const Q extends Projection<D>>(projection: Q & CheckProjection<D, Q>): Query<D, Q, S> {
    this.#projection = projection;
    return this as unknown as Query<D, Q, S>;
  }

  skip(n: number): this {
    this.#skip = n;
    return this;
  }

  limit(n: number): this {
    this.#limit = n;
    return this;
  }

  /**
   * Attaches related documents, loaded in one batched read per relation per level, however
   * many parents there are. Relations are checked against both schemas at compile
   * time, and each read goes through the target collection, so its casting and scope apply.
   * Calls merge.
   */
  include<const T extends IncludeMap>(
    spec: T extends ValidateIncludes<D, T> ? T : ValidateIncludes<D, T>,
  ): Query<D, P, Merge<S, T>> {
    this.#includes = { ...this.#includes, ...spec };
    return this as unknown as Query<D, P, Merge<S, T>>;
  }

  /** Reads the matches. Without `.limit()` this follows the `unboundedReads` policy. */
  async toArray(): Promise<Row<D, P, S>[]> {
    if (this.#limit === undefined && this.#policy !== 'allow') {
      if (this.#policy === 'error') throw new KrepisUnboundedReadError(this.#collection);
      process.emitWarning(new KrepisUnboundedReadError(this.#collection).message, 'KrepisWarning');
    }
    return this.#run();
  }

  /** Reads every match, deliberately. Use when the result is bounded by the data model. */
  all(): Promise<Row<D, P, S>[]> {
    return this.#run();
  }

  async first(): Promise<Row<D, P, S> | null> {
    this.#limit = 1;
    const [doc] = await this.#run();
    return doc ?? null;
  }

  /**
   * The driver cursor, for streaming large results. Relations cannot be streamed. Inside a transaction the
   * cursor joins it, but is not queued behind the transaction's first operation.
   */
  cursor(): FindCursor<Project<D, P>> {
    if (this.#includes) {
      throw new TypeError('Krepis: cursor() cannot load relations; use toArray() or all() with include()');
    }
    return this.#cursor(this.#bind.hide(this.#projection as Document | undefined), this.#bind.session()) as unknown as FindCursor<Project<D, P>>;
  }

  #cursor(projection: Document | undefined, session: ClientSession | undefined): FindCursor<Document> {
    let c = this.#bind.open(session);
    if (this.#sort) c = c.sort(this.#sort as Document);
    if (projection) c = c.project(projection);
    if (this.#skip !== undefined) c = c.skip(this.#skip);
    if (this.#limit !== undefined) c = c.limit(this.#limit);
    return c;
  }

  async #run(): Promise<Row<D, P, S>[]> {
    const includes = this.#includes;
    const read = (projection: Document | undefined) =>
      this.#bind.exec('find', (session) => this.#cursor(projection, session).toArray());
    const base = this.#bind.hide(this.#projection as Document | undefined);
    if (!includes) return (await read(base)) as Row<D, P, S>[];
    // A relation must see its local field even when the projection leaves it out; it is removed again after.
    const { projection, added } = widen(base, localFields(includes));
    const docs = (await read(projection)) as Record<string, unknown>[];
    await attachIncludes(docs, includes);
    const drop = added.filter((f) => !(f in includes));
    if (drop.length) for (const d of docs) for (const f of drop) delete d[f];
    return docs as Row<D, P, S>[];
  }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export class Collection<X extends Schema> {
  readonly name: string;
  readonly schema: X;
  readonly #ctx: DalContext;
  readonly #scope?: ScopeHook;
  readonly #hidden: string[];

  constructor(ctx: DalContext, name: string, schema: X, scope?: ScopeHook) {
    this.#ctx = ctx;
    this.name = name;
    this.schema = schema;
    this.#scope = scope;
    this.#hidden = hiddenFields(schema.fields);
  }

  /** The underlying driver collection. Escape hatch: no casting, defaults, scope or validation. */
  raw(): DriverCollection<Doc<X>> {
    return this.#ctx.db().collection<Doc<X>>(this.name);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  find<const P extends Projection<Doc<X>> = {}>(
    filter: Filter<Doc<X>> = {},
    options: ReadOptions<Doc<X>, P & CheckProjection<Doc<X>, P>> = {},
  ): Query<Doc<X>, P> {
    const scope = this.#scope?.('find');
    const q = new Query<Doc<X>, P>(
      {
        open: (session) => this.#driver().find(this.#filter(filter, scope), { session }),
        exec: (operation, fn) => this.#op(operation, fn),
        session: () => activeAttempt(this.#client, this.name)?.session,
        hide: (projection) => hide(projection, this.#hidden),
      },
      this.name,
      this.#ctx.unboundedReads,
    );
    if (options.sort) q.sort(options.sort);
    if (options.projection) q.select(options.projection as never);
    return q;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  async findOne<const P extends Projection<Doc<X>> = {}>(
    filter: Filter<Doc<X>>,
    options: ReadOptions<Doc<X>, P & CheckProjection<Doc<X>, P>> = {},
  ): Promise<Project<Doc<X>, P> | null> {
    const scope = this.#scope?.('findOne');
    const f = this.#filter(filter, scope);
    return (await this.#op('findOne', (session) =>
      this.#driver().findOne(f, {
        sort: options.sort as Document | undefined,
        projection: hide(options.projection as Document | undefined, this.#hidden),
        session,
      }),
    )) as Project<Doc<X>, P> | null;
  }

  async exists(filter: Filter<Doc<X>>): Promise<boolean> {
    const scope = this.#scope?.('exists');
    const f = this.#filter(filter, scope);
    const doc = await this.#op('exists', (session) => this.#driver().findOne(f, { projection: { _id: 1 }, session }));
    return doc !== null;
  }

  async count(filter: Filter<Doc<X>> = {}): Promise<number> {
    const scope = this.#scope?.('count');
    const f = this.#filter(filter, scope);
    return this.#op('count', (session) => this.#driver().countDocuments(f, { session }));
  }

  async distinct<K extends keyof Doc<X> & string>(key: K, filter: Filter<Doc<X>> = {}): Promise<Doc<X>[K][]> {
    const scope = this.#scope?.('distinct');
    const f = this.#filter(filter, scope);
    return this.#op('distinct', (session) => this.#driver().distinct(key, f, { session })) as Promise<Doc<X>[K][]>;
  }

  async insertOne(doc: Insert<X>): Promise<Doc<X>> {
    const prepared = this.#insert(doc as Record<string, unknown>, this.#scope?.('insertOne'));
    await this.#op('insertOne', (session) => this.#driver().insertOne(prepared, { session }));
    return prepared as Doc<X>;
  }

  async insertMany(docs: Insert<X>[]): Promise<Doc<X>[]> {
    if (docs.length === 0) return [];
    const scope = this.#scope?.('insertMany');
    const prepared = docs.map((d) => this.#insert(d as Record<string, unknown>, scope));
    await this.#op('insertMany', (session) => this.#driver().insertMany(prepared, { session }));
    return prepared as Doc<X>[];
  }

  updateOne(filter: Filter<Doc<X>>, update: Update<Doc<X>> | UpdatePipeline<Doc<X>>, options: { upsert?: boolean } = {}): Promise<WriteResult> {
    return this.#update('updateOne', filter, update, options.upsert ?? false);
  }

  updateMany(filter: Filter<Doc<X>>, update: Update<Doc<X>> | UpdatePipeline<Doc<X>>, options: { upsert?: boolean } = {}): Promise<WriteResult> {
    return this.#update('updateMany', filter, update, options.upsert ?? false);
  }

  /** Returns the updated document by default (`returnDocument: 'after'`). */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  async findOneAndUpdate<const P extends Projection<Doc<X>> = {}>(
    filter: Filter<Doc<X>>,
    update: Update<Doc<X>> | UpdatePipeline<Doc<X>>,
    options: ReadOptions<Doc<X>, P & CheckProjection<Doc<X>, P>> & { upsert?: boolean; returnDocument?: 'before' | 'after' } = {},
  ): Promise<Project<Doc<X>, P> | null> {
    const scope = this.#scope?.('findOneAndUpdate');
    const f = this.#filter(filter, scope);
    const u = this.#prepareUpdate(f, update as UpdateDoc, options.upsert ?? false, scope);
    if (u === DROPPED) return null;
    if (!u) return this.findOne(filter, options as never) as Promise<Project<Doc<X>, P> | null>;
    const res = await this.#op('findOneAndUpdate', (session) =>
      this.#driver().findOneAndUpdate(f, u, {
        upsert: options.upsert ?? false,
        returnDocument: options.returnDocument ?? 'after',
        sort: options.sort as Document | undefined,
        projection: hide(options.projection as Document | undefined, this.#hidden),
        includeResultMetadata: true,
        session,
      }),
    );
    return unwrapModifyResult<Project<Doc<X>, P>>(res);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  async findOneAndDelete<const P extends Projection<Doc<X>> = {}>(
    filter: Filter<Doc<X>>,
    options: ReadOptions<Doc<X>, P & CheckProjection<Doc<X>, P>> = {},
  ): Promise<Project<Doc<X>, P> | null> {
    const scope = this.#scope?.('findOneAndDelete');
    const f = this.#filter(filter, scope);
    const res = await this.#op('findOneAndDelete', (session) =>
      this.#driver().findOneAndDelete(f, {
        sort: options.sort as Document | undefined,
        projection: hide(options.projection as Document | undefined, this.#hidden),
        includeResultMetadata: true,
        session,
      }),
    );
    return unwrapModifyResult<Project<Doc<X>, P>>(res);
  }

  async deleteOne(filter: Filter<Doc<X>>): Promise<{ deletedCount: number }> {
    const scope = this.#scope?.('deleteOne');
    const f = this.#filter(filter, scope);
    const { deletedCount } = await this.#op('deleteOne', (session) => this.#driver().deleteOne(f, { session }));
    return { deletedCount };
  }

  async deleteMany(filter: Filter<Doc<X>>): Promise<{ deletedCount: number }> {
    const scope = this.#scope?.('deleteMany');
    const f = this.#filter(filter, scope);
    const { deletedCount } = await this.#op('deleteMany', (session) => this.#driver().deleteMany(f, { session }));
    return { deletedCount };
  }

  /** Bulk write with the same casting, defaults, timestamps and scope as the single operations. */
  async bulkWrite(ops: BulkOp<X>[], options: { ordered?: boolean } = {}): Promise<WriteResult & { insertedCount: number; deletedCount: number }> {
    const scope = this.#scope?.('bulkWrite');
    const prepared: Document[] = [];
    for (const op of ops) {
      if ('insertOne' in op) {
        prepared.push({ insertOne: { document: this.#insert(op.insertOne.document as Record<string, unknown>, scope) } });
      } else if ('updateOne' in op || 'updateMany' in op) {
        const kind = 'updateOne' in op ? 'updateOne' : 'updateMany';
        const spec = 'updateOne' in op ? op.updateOne : op.updateMany;
        const filter = this.#filter(spec.filter, scope);
        const update = this.#prepareUpdate(filter, spec.update as UpdateDoc, spec.upsert ?? false, scope);
        if (update && update !== DROPPED) prepared.push({ [kind]: { filter, update, upsert: spec.upsert ?? false } });
      } else {
        const kind = 'deleteOne' in op ? 'deleteOne' : 'deleteMany';
        const spec = 'deleteOne' in op ? op.deleteOne : op.deleteMany;
        prepared.push({ [kind]: { filter: this.#filter(spec.filter, scope) } });
      }
    }
    if (prepared.length === 0) {
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: undefined, insertedCount: 0, deletedCount: 0 };
    }
    const r = await this.#op('bulkWrite', (session) =>
      this.#driver().bulkWrite(prepared as never, { ordered: options.ordered ?? true, session }),
    );
    return {
      matchedCount: r.matchedCount,
      modifiedCount: r.modifiedCount,
      upsertedCount: r.upsertedCount,
      upsertedId: undefined,
      insertedCount: r.insertedCount,
      deletedCount: r.deletedCount,
    };
  }

  /**
   * A typed aggregation pipeline. A scoped collection's scope is its first stage, and a
   * `lookup()` into a scoped collection keeps that collection's scope. Runs inside an active transaction.
   */
  aggregate(): Aggregate<Doc<X>> {
    const scope = this.#scope?.('aggregate');
    return new Aggregate<Doc<X>>(
      {
        collection: this.name,
        db: () => this.#ctx.db(),
        cast: (filter) => castFilter(this.schema.fields, filter, this.#ctx.bson, this.#ctx.strictInput),
        check: (filter) => checkFilter(this.schema.fields, filter, this.#ctx.strictInput),
        hidden: this.#hidden,
        checkUnbounded: () => this.#checkUnbounded(),
        exec: (fn) => this.#op('aggregate', fn),
        open: (pipeline, session) => this.#driver().aggregate(pipeline, { session }),
        session: () => activeAttempt(this.#client, this.name)?.session,
      },
      scope?.filter ? [{ $match: scope.filter }] : [],
    );
  }

  /** Creates the indexes declared on the schema. Never runs implicitly. */
  async ensureIndexes(): Promise<void> {
    const indexes = this.schema.options.indexes ?? [];
    if (indexes.length === 0) return;
    await this.#driver().createIndexes(
      indexes.map(({ keys, ...rest }) => ({ key: keys, ...rest })),
    );
  }

  /** @internal Used by `Query.include` on another collection to read this one. */
  [INCLUDE](): IncludeTarget {
    return {
      cast: (foreign, value) => {
        const def = resolvePath(this.schema.fields, foreign);
        const scalar = def?.kind === 'array' ? def.of : def;
        if (!scalar) return value;
        try {
          return castValue(scalar, value, foreign, this.#ctx.bson, true);
        } catch {
          return undefined; // a value the target field cannot hold matches nothing
        }
      },
      checkUnbounded: () => this.#checkUnbounded(),
      read: (r) => this.#includeRead(r),
      database: () => this.#ctx.db(),
    };
  }

  async #includeRead(r: IncludeRead): Promise<{ docs: Document[]; strip?: string }> {
    const scope = this.#scope?.('find');
    const where = (r.where ?? {}) as Record<string, unknown>;
    const match = { [r.foreign]: op.in(r.values) };
    const filter = this.#filter((r.foreign in where ? { $and: [where, match] } : { ...where, ...match }) as Filter<Doc<X>>, scope);
    // The relation is matched on `foreign`, so a select must not drop it; it is removed again after.
    const top = r.foreign.split('.')[0];
    const { projection, added } = widen(hide(r.select as Document | undefined, this.#hidden), [top]);
    let docs: Document[];
    if (r.limit === undefined) {
      docs = await this.#op('find', (session) =>
        this.#driver()
          .find(filter, { projection: projection as Document | undefined, sort: r.sort as Document | undefined, session })
          .toArray(),
      );
    } else {
      const output = '$$ROOT';
      const pick = r.sort ? { $topN: { n: r.limit, sortBy: r.sort, output } } : { $firstN: { n: r.limit, input: output } };
      const pipeline: Document[] = [
        { $match: filter },
        { $addFields: { [GROUP_KEY]: `$${r.foreign}` } },
        { $unwind: `$${GROUP_KEY}` },
        { $match: { [GROUP_KEY]: { $in: r.values } } },
        { $group: { _id: `$${GROUP_KEY}`, docs: pick } },
        { $unwind: '$docs' },
        { $replaceRoot: { newRoot: '$docs' } },
      ];
      if (projection) {
        const inclusive = Object.entries(projection).some(([k, v]) => k !== '_id' && v);
        pipeline.push({ $project: inclusive ? { ...projection, [GROUP_KEY]: 1 } : projection });
      }
      docs = await this.#op('aggregate', (session) => this.#driver().aggregate(pipeline, { session }).toArray());
    }
    return { docs, strip: added[0] };
  }

  // -------------------------------------------------------------------------

  readonly #client = (): MongoClient => clientOf(this.#ctx.db());

  #checkUnbounded(): void {
    const policy = this.#ctx.unboundedReads;
    if (policy === 'error') throw new KrepisUnboundedReadError(this.name);
    if (policy === 'warn') process.emitWarning(new KrepisUnboundedReadError(this.name).message, 'KrepisWarning');
  }

  /** Runs a driver call, inside the active transaction when there is one. */
  #op<T>(operation: string, fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
    const tx = activeAttempt(this.#client, this.name);
    return tx ? tx.run(this.name, operation, fn) : fn(undefined);
  }

  #driver(): DriverCollection<Document> {
    return this.#ctx.db().collection(this.name);
  }

  #filter(filter: Filter<Doc<X>>, scope: ScopeContext | undefined): Document {
    const cast = castFilter(this.schema.fields, filter as Record<string, unknown>, this.#ctx.bson, this.#ctx.strictInput);
    if (!scope?.filter) return cast;
    const clash = Object.keys(scope.filter).some((k) => k in cast);
    return clash ? { $and: [cast, scope.filter] } : { ...cast, ...scope.filter };
  }

  #insert(doc: Record<string, unknown>, scope: ScopeContext | undefined): Record<string, unknown> {
    const { fields, options } = this.schema;
    const { bson } = this.#ctx;
    const out = castDocument(fields, doc, bson);
    applyDefaults(fields, out, bson);
    if (options.timestamps) {
      const now = new Date();
      out.createdAt ??= now;
      out.updatedAt ??= now;
    }
    scope?.stamp?.(out);
    validate(fields, out, true);
    return { _id: out._id ?? new bson.ObjectId(), ...out };
  }

  #prepareUpdate(
    filter: Document,
    update: UpdateDoc | readonly unknown[],
    upsert: boolean,
    scope: ScopeContext | undefined,
  ): UpdateDoc | Document[] | typeof DROPPED | null {
    if (Array.isArray(update) && isTrusted(update)) {
      if (scope?.update) {
        throw new TypeError(`Krepis: "${this.name}" has a scope that rewrites updates, and it cannot inspect an update pipeline; use an update document`);
      }
      return castPipeline(this.schema.fields, update, upsert, this.schema.options.timestamps);
    }
    let u: UpdateDoc | null = normalizeUpdate(update as UpdateDoc);
    if (scope?.update) {
      u = scope.update(u);
      if (!u) return DROPPED;
    }
    u = castUpdate(this.schema.fields, u, this.#ctx.bson, this.#ctx.strictInput);
    applyUpdateTimestamps(this.schema.options.timestamps, u, upsert);
    if (upsert) applyUpsertDefaults(this.schema.fields, filter, u, this.#ctx.bson);
    return Object.keys(u).length ? u : null;
  }

  async #update(
    operation: 'updateOne' | 'updateMany',
    filter: Filter<Doc<X>>,
    update: Update<Doc<X>> | UpdatePipeline,
    upsert: boolean,
  ): Promise<WriteResult> {
    const scope = this.#scope?.(operation);
    const f = this.#filter(filter, scope);
    const u = this.#prepareUpdate(f, update as UpdateDoc, upsert, scope);
    if (!u || u === DROPPED) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: undefined };
    const r = await this.#op(operation, (session) => this.#driver()[operation](f, u, { upsert, session }));
    return {
      matchedCount: r.matchedCount,
      modifiedCount: r.modifiedCount,
      upsertedCount: r.upsertedCount,
      upsertedId: r.upsertedId,
    };
  }
}
