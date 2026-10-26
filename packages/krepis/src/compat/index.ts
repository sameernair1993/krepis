/**
 * A Mongoose-shaped facade over a Krepis collection, so a model file can be migrated without
 * rewriting its call sites or hand-writing an adapter. Every operation goes through the collection, so
 * casting, defaults, validation and scope all apply; the types come from the schema, not from a generic.
 *
 * Mongoose semantics are kept where they differ from Krepis: `findOneAndUpdate` returns the document as
 * it was *before* the update unless `new: true` (or `returnDocument: 'after'`), and `collection` is the
 * driver collection. Two deliberate differences: `lean<T>()` may only widen the row type, and an unbounded
 * `find` follows the dal's `unboundedReads` policy unless the model sets `allowUnboundedReads`.
 */
import type { Collection as DriverCollection, Document } from 'mongodb';
import type { Collection, Filter, Projection, Query, Row, Sort, Update, WriteResult } from '../dal/collection.ts';
import type { CheckProjection, Project } from '../dal/paths.ts';
import type { Doc, Insert, Schema } from '../dal/schema.ts';
import { op, type PipelineStage, type UpdatePipeline } from '../dal/input.ts';

/** An update as Mongoose takes it: a pipeline is an array, accepted with `updatePipeline: true`. */
type ModelUpdate<D> = Update<D> | UpdatePipeline | readonly PipelineStage[];

/** Mongoose's `updatePipeline: true` says the array is a pipeline written by code; without it an array is refused. */
function updateOf<D>(update: ModelUpdate<D>, options: { updatePipeline?: boolean } | undefined): Update<D> | UpdatePipeline {
  return options?.updatePipeline && Array.isArray(update) ? op.pipeline(update) : (update as Update<D> | UpdatePipeline);
}

export interface ModelOptions {
  /** Read every match when a `find` or `aggregate` has no limit, as Mongoose does. Default: the dal's policy. */
  allowUnboundedReads?: boolean;
}

export interface FindOptions<D> {
  sort?: Sort<D>;
  skip?: number;
  limit?: number;
}

export interface FindOneAndUpdateOptions<D, P> {
  /** Mongoose's flag: `true` returns the updated document. Default `false`, as in Mongoose. */
  new?: boolean;
  /** Takes precedence over `new`. */
  returnDocument?: 'before' | 'after';
  upsert?: boolean;
  /** Mongoose's flag: the update is a pipeline. */
  updatePipeline?: boolean;
  sort?: Sort<D>;
  projection?: P;
}

/** `lean<T>()` accepts only a `T` the row is assignable to, so it can widen but never assert. */
type Widens<R, T> = [R] extends [T] ? [] : ['Krepis: lean<T>() can only widen; the row type is not assignable to T'];

type Then<R> = <A = R, B = never>(
  onfulfilled?: ((value: R) => A | PromiseLike<A>) | null,
  onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
) => Promise<A | B>;

/** `Model.find()`: lazy, chainable and thenable. Nothing runs until it is awaited or `exec()` is called. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class ModelQuery<D, P, R = Row<D, P, {}>> implements PromiseLike<R[]> {
  readonly #query: Query<D, P>;
  readonly #allowUnbounded: boolean;

  /** @internal */
  constructor(query: Query<D, P>, allowUnbounded: boolean) {
    this.#query = query;
    this.#allowUnbounded = allowUnbounded;
  }

  /** Replaces the projection (Mongoose merges); a literal narrows the row type. */
  select<const Q extends Projection<D>>(projection: Q & CheckProjection<D, Q>): ModelQuery<D, Q> {
    return new ModelQuery<D, Q>(this.#query.select<Q>(projection), this.#allowUnbounded);
  }

  sort(sort: Sort<D>): this {
    this.#query.sort(sort);
    return this;
  }

  skip(n: number): this {
    this.#query.skip(n);
    return this;
  }

  limit(n: number): this {
    this.#query.limit(n);
    return this;
  }

  /** Rows are already plain objects; this only re-types them, and only upward. */
  lean<T = R>(..._: Widens<R, T>): ModelQuery<D, P, T> {
    return new ModelQuery<D, P, T>(this.#query, this.#allowUnbounded);
  }

  exec(): Promise<R[]> {
    // R is the row type or, after lean(), a supertype of it (see `Widens`).
    return (this.#allowUnbounded ? this.#query.all() : this.#query.toArray()) as Promise<R[]>;
  }

  then: Then<R[]> = (onfulfilled, onrejected) => this.exec().then(onfulfilled, onrejected);
}

/** `Model.findOne()`: lazy and thenable. The read is built where the projection is checked, so it needs no cast. */
export class ModelQueryOne<D, R> implements PromiseLike<R | null> {
  readonly #run: (sort: Sort<D> | undefined) => Promise<R | null>;
  #sort: Sort<D> | undefined;

  /** @internal */
  constructor(run: (sort: Sort<D> | undefined) => Promise<R | null>, sort: Sort<D> | undefined) {
    this.#run = run;
    this.#sort = sort;
  }

  sort(sort: Sort<D>): this {
    this.#sort = sort;
    return this;
  }

  lean<T = R>(..._: Widens<R, T>): ModelQueryOne<D, T> {
    // Sound by `Widens`: R is assignable to T, which TypeScript cannot express as a bound on T.
    return new ModelQueryOne<D, T>(this.#run as (sort: Sort<D> | undefined) => Promise<T | null>, this.#sort);
  }

  exec(): Promise<R | null> {
    return this.#run(this.#sort);
  }

  then: Then<R | null> = (onfulfilled, onrejected) => this.exec().then(onfulfilled, onrejected);
}

/** The part of `Aggregate` a raw pipeline needs. */
interface Staged {
  stage(stage: Document): Staged;
  all(): Promise<unknown[]>;
  toArray(): Promise<unknown[]>;
}

/** What `mongooseModel()` returns: the Mongoose `Model` statics a typical model file calls. */
export class Model<X extends Schema> {
  readonly #collection: Collection<X>;
  readonly #allowUnbounded: boolean;

  /** @internal */
  constructor(collection: Collection<X>, allowUnbounded: boolean) {
    this.#collection = collection;
    this.#allowUnbounded = allowUnbounded;
  }

  create(doc: Insert<X>): Promise<Doc<X>>;
  create(docs: Insert<X>[]): Promise<Doc<X>[]>;
  create(input: Insert<X> | Insert<X>[]): Promise<Doc<X> | Doc<X>[]> {
    return Array.isArray(input) ? this.#collection.insertMany(input) : this.#collection.insertOne(input);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  find<const P extends Projection<Doc<X>> = {}>(
    filter: Filter<Doc<X>> = {},
    projection?: (P & CheckProjection<Doc<X>, P>) | null,
    options: FindOptions<Doc<X>> = {},
  ): ModelQuery<Doc<X>, P> {
    const q = new ModelQuery<Doc<X>, P>(
      this.#collection.find<P>(filter, { sort: options.sort, projection: projection ?? undefined }),
      this.#allowUnbounded,
    );
    if (options.skip !== undefined) q.skip(options.skip);
    if (options.limit !== undefined) q.limit(options.limit);
    return q;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  findOne<const P extends Projection<Doc<X>> = {}>(
    filter: Filter<Doc<X>> = {},
    projection?: (P & CheckProjection<Doc<X>, P>) | null,
    options: { sort?: Sort<Doc<X>> } = {},
  ): ModelQueryOne<Doc<X>, Project<Doc<X>, P>> {
    return new ModelQueryOne((sort) => this.#collection.findOne<P>(filter, { sort, projection: projection ?? undefined }), options.sort);
  }

  countDocuments(filter: Filter<Doc<X>> = {}): Promise<number> {
    return this.#collection.count(filter);
  }

  updateOne(filter: Filter<Doc<X>>, update: ModelUpdate<Doc<X>>, options?: { upsert?: boolean; updatePipeline?: boolean }): Promise<WriteResult> {
    return this.#collection.updateOne(filter, updateOf(update, options), { upsert: options?.upsert });
  }

  updateMany(filter: Filter<Doc<X>>, update: ModelUpdate<Doc<X>>, options?: { upsert?: boolean; updatePipeline?: boolean }): Promise<WriteResult> {
    return this.#collection.updateMany(filter, updateOf(update, options), { upsert: options?.upsert });
  }

  deleteOne(filter: Filter<Doc<X>>): Promise<{ deletedCount: number }> {
    return this.#collection.deleteOne(filter);
  }

  deleteMany(filter: Filter<Doc<X>>): Promise<{ deletedCount: number }> {
    return this.#collection.deleteMany(filter);
  }

  /** Returns the document as it was before the update unless `new: true`, as Mongoose does. */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  findOneAndUpdate<const P extends Projection<Doc<X>> = {}>(
    filter: Filter<Doc<X>>,
    update: ModelUpdate<Doc<X>>,
    options: FindOneAndUpdateOptions<Doc<X>, P & CheckProjection<Doc<X>, P>> = {},
  ): Promise<Project<Doc<X>, P> | null> {
    return this.#collection.findOneAndUpdate<P>(filter, updateOf(update, options), {
      upsert: options.upsert,
      returnDocument: options.returnDocument ?? (options.new ? 'after' : 'before'),
      sort: options.sort,
      projection: options.projection,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  findOneAndDelete<const P extends Projection<Doc<X>> = {}>(
    filter: Filter<Doc<X>>,
    options: { sort?: Sort<Doc<X>>; projection?: P & CheckProjection<Doc<X>, P> } = {},
  ): Promise<Project<Doc<X>, P> | null> {
    return this.#collection.findOneAndDelete<P>(filter, options);
  }

  /**
   * A raw pipeline, as `Model.aggregate()` takes. The collection's scope is still the first stage, and
   * stages that read another collection are refused. `T` is asserted, exactly as in Mongoose and the
   * driver; for checked result types use `collection.aggregate()`.
   */
  aggregate<T = Document>(pipeline: Document[]): { exec(): Promise<T[]> } & PromiseLike<T[]> {
    let agg: Staged = this.#collection.aggregate();
    for (const stage of pipeline) agg = agg.stage(stage);
    const exec = (): Promise<T[]> => (this.#allowUnbounded ? agg.all() : agg.toArray()) as Promise<T[]>;
    return { exec, then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected) };
  }

  /** The driver collection: no casting, defaults, scope or validation (Mongoose's `Model.collection`). */
  get collection(): DriverCollection<Doc<X>> {
    return this.#collection.raw();
  }
}

export function mongooseModel<X extends Schema>(collection: Collection<X>, options: ModelOptions = {}): Model<X> {
  return new Model(collection, options.allowUnboundedReads ?? false);
}
