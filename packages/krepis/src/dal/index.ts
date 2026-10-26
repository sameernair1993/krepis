import { ObjectId } from 'mongodb';
import type { Db, MongoClient } from 'mongodb';
import { Collection, type DalContext, type ScopeHook, type UnboundedReads } from './collection.ts';
import type { Bson, Schema } from './schema.ts';
import { clientOf, runTransaction, type Transaction, type TransactionOptions } from './transaction.ts';

export { t, schema, KrepisCastError, KrepisInputError, KrepisValidationError } from './schema.ts';
export { op, match } from './input.ts';
export type { Op, MatchOptions, PipelineStage, UpdatePipeline } from './input.ts';
export type { Doc, Insert, Schema, TypedSchema, IndexSpec, SchemaOptions } from './schema.ts';
/** The driver's ObjectId, for entity interfaces. Mongoose's `Types.ObjectId` is a subclass with extra members. */
export type { ObjectId } from 'mongodb';
export { Collection, Query, KrepisUnboundedReadError } from './collection.ts';
export type { Filter, Update, Sort, Projection, ReadOptions, ScopeHook, ScopeContext, BulkOp, WriteResult } from './collection.ts';
export { Aggregate } from './aggregate.ts';
export type { AggValue, ExprType, FieldRef, GroupOut, ProjectOut } from './aggregate.ts';
export type { IncludeMap, Relation, RelationSpec, ValidateIncludes, WithIncludes } from './include.ts';
export { TransactionEndedError, TransactionTimeoutError, TransactionsUnsupportedError } from './transaction.ts';
export type { Transaction, TransactionOptions } from './transaction.ts';

export interface DalOptions {
  /** Unbounded `find().toArray()`: throw (default), warn, or allow. `.all()` is always allowed. */
  unboundedReads?: UnboundedReads;
  /**
   * Refuse a filter's operator object where the schema expects a scalar unless it was built by `op`:
   * `{ token: { $ne: null } }` from a request body throws `KrepisInputError`. Default true.
   */
  strictInput?: boolean;
  /** BSON classes from the driver that owns the client. Defaults to the installed `mongodb`. */
  bson?: Bson;
  /** Called with each collection name as it is declared. */
  onCollection?: (name: string) => void;
}

export class Dal {
  readonly #ctx: DalContext;
  readonly #collections: Collection<Schema>[] = [];
  readonly #onCollection: ((name: string) => void) | undefined;

  constructor(db: () => Db, options: DalOptions = {}) {
    this.#ctx = {
      db,
      bson: options.bson ?? { ObjectId },
      unboundedReads: options.unboundedReads ?? 'error',
      strictInput: options.strictInput ?? true,
    };
    this.#onCollection = options.onCollection;
  }

  collection<X extends Schema>(name: string, schema: X, options: { scope?: ScopeHook } = {}): Collection<X> {
    const c = new Collection(this.#ctx, name, schema, options.scope);
    this.#collections.push(c as unknown as Collection<Schema>);
    this.#onCollection?.(name);
    return c;
  }

  /** Creates every declared index. Run at deploy time, not on each boot. */
  async ensureIndexes(): Promise<void> {
    for (const c of this.#collections) await c.ensureIndexes();
  }

  /**
   * Runs `fn` in a transaction. Every Krepis operation inside it joins without a session argument,
   * the callback is re-run on a transient error, an unknown commit result is retried, and `afterCommit` hooks
   * run once, after the commit. A transaction started inside another on the same client joins it.
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return runTransaction(clientOf(this.#ctx.db()), fn, options);
  }
}

/** A data access layer over a client you own. The client may be created lazily. */
export function createDal(client: MongoClient | (() => MongoClient), options: DalOptions & { dbName?: string } = {}): Dal {
  const get = typeof client === 'function' ? client : () => client;
  return new Dal(() => get().db(options.dbName), options);
}

interface MongooseLike {
  connection: { db?: Db | null; collection?: (name: string) => unknown };
  mongo: { ObjectId: Bson['ObjectId'] };
}

/**
 * A data access layer that shares an existing Mongoose connection: one pool, one
 * driver, one BSON. Models can then move from Mongoose to Krepis one at a time.
 * The connection is resolved per operation, so this can be called before `connect()`.
 * Each collection is also registered in `mongoose.connection.collections`, so code that
 * iterates that registry (the common "clear every collection" test teardown) still sees it.
 */
export function fromMongoose(mongoose: MongooseLike, options: DalOptions = {}): Dal {
  return new Dal(
    () => {
      const db = mongoose.connection.db;
      if (!db) throw new Error('Krepis: the Mongoose connection is not open yet');
      return db;
    },
    { bson: { ObjectId: mongoose.mongo.ObjectId }, onCollection: (name) => mongoose.connection.collection?.(name), ...options },
  );
}
