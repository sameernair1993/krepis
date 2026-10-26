import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClientSession, Db, MongoClient, TransactionOptions as DriverTransactionOptions } from 'mongodb';
import { brandError, isBrandedError } from './schema.ts';

/** The handle passed to a `transaction()` callback. */
export interface Transaction {
  /**
   * The driver session. Krepis operations join the transaction without it; pass it to code that talks to
   * the driver or to Mongoose directly (`Model.create([doc], { session: tx.session })`).
   */
  readonly session: ClientSession;
  /** 1 on the first run of the callback, 2 after one retry, and so on. */
  readonly attempt: number;
  /**
   * Runs `fn` once, after the transaction commits. Hooks from an attempt that is retried or aborted never run.
   * Hooks run in order, outside the transaction. A hook that throws does not fail the transaction, which has
   * already committed; its error is emitted as a process warning.
   */
  afterCommit(fn: () => unknown): void;
}

export interface TransactionOptions {
  /**
   * Budget for the whole transaction, including retries. Default 60,000, the server's own transaction
   * lifetime limit. An operation started after it throws `TransactionTimeoutError` and the transaction aborts.
   */
  timeoutMs?: number;
  readConcern?: DriverTransactionOptions['readConcern'];
  writeConcern?: DriverTransactionOptions['writeConcern'];
  readPreference?: DriverTransactionOptions['readPreference'];
  maxCommitTimeMS?: number;
}

export class TransactionEndedError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedError(value, 'TransactionEndedError');
  }
  constructor(collection: string, operation: string) {
    super(
      `${operation} on "${collection}" was started inside a transaction that has already ended. ` +
        'Await it inside the callback, or run it from afterCommit().',
    );
    this.name = 'TransactionEndedError';
    brandError(this, 'TransactionEndedError');
  }
}

export class TransactionTimeoutError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedError(value, 'TransactionTimeoutError');
  }
  constructor(collection: string, operation: string, timeoutMs: number) {
    super(`${operation} on "${collection}" started after the transaction's ${timeoutMs} ms budget; the transaction was aborted`);
    this.name = 'TransactionTimeoutError';
    brandError(this, 'TransactionTimeoutError');
  }
}

export class TransactionsUnsupportedError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedError(value, 'TransactionsUnsupportedError');
  }
  constructor(cause: unknown) {
    super('Transactions need a replica set or a sharded cluster; this server is a standalone', { cause });
    this.name = 'TransactionsUnsupportedError';
    brandError(this, 'TransactionsUnsupportedError');
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

function hasLabel(e: unknown, label: string): boolean {
  return typeof (e as { hasErrorLabel?: unknown })?.hasErrorLabel === 'function' &&
    (e as { hasErrorLabel(l: string): boolean }).hasErrorLabel(label);
}

/**
 * The server's reply when a transaction is attempted on a standalone. Driver 7 rewraps it as advice to set
 * `retryWrites=false`, which is wrong for a transaction, and keeps the server's reply on `originalError`.
 */
function isStandaloneRefusal(e: unknown): boolean {
  const err = e as { code?: number; message?: string; originalError?: unknown } | null;
  if (err?.code === 20 && /replica set member or mongos/i.test(err.message ?? '')) return true;
  return err?.originalError !== undefined && err.originalError !== e && isStandaloneRefusal(err.originalError);
}

export function translate(e: unknown): unknown {
  return isStandaloneRefusal(e) ? new TransactionsUnsupportedError(e) : e;
}

/** Driver 4.x keeps the client at `db.s.client`; later drivers expose `db.client`. */
export function clientOf(db: Db): MongoClient {
  const d = db as unknown as { client?: MongoClient; s?: { client?: MongoClient } };
  const client = d.client ?? d.s?.client;
  if (!client) throw new TypeError('Krepis: cannot find the MongoClient behind this Db');
  return client;
}

/** One attempt of one transaction. */
export class Attempt {
  readonly client: MongoClient;
  readonly session: ClientSession;
  readonly hooks: (() => unknown)[] = [];
  readonly handle: Transaction;
  ended = false;
  /** An error that must fail the attempt even if the callback catches it. */
  poison: unknown;
  readonly #deadline: number;
  readonly #timeoutMs: number;
  /** Until one operation has succeeded the transaction may not exist on the server yet, so operations queue. */
  #started = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(client: MongoClient, session: ClientSession, attempt: number, deadline: number, timeoutMs: number) {
    this.client = client;
    this.session = session;
    this.#deadline = deadline;
    this.#timeoutMs = timeoutMs;
    const hooks = this.hooks;
    this.handle = Object.freeze({
      session,
      attempt,
      afterCommit(fn: () => unknown) {
        if (typeof fn !== 'function') throw new TypeError('afterCommit takes a function');
        hooks.push(fn);
      },
    });
  }

  /** Runs one driver operation in this transaction. */
  run<T>(collection: string, operation: string, op: (session: ClientSession) => Promise<T>): Promise<T> {
    if (this.ended) return Promise.reject(new TransactionEndedError(collection, operation));
    if (Date.now() > this.#deadline) {
      const e = new TransactionTimeoutError(collection, operation, this.#timeoutMs);
      this.poison ??= e;
      return Promise.reject(e);
    }
    const call = () => op(this.session).catch((e: unknown) => Promise.reject(translate(e)));
    if (this.#started) return call();
    // Parallel first operations race to start the transaction and fail: run them one at a time
    // until one succeeds, after which the transaction exists and operations run in parallel.
    const p = this.#queue.then(() => {
      if (this.#started) return call();
      return call().then((r) => {
        this.#started = true;
        return r;
      });
    });
    this.#queue = p.catch(() => undefined);
    return p;
  }
}

const active = new AsyncLocalStorage<Attempt>();

/**
 * The transaction an operation on `client` should join, or undefined. Throws when the active transaction
 * belongs to another client: running the operation outside it would silently break atomicity.
 */
export function activeAttempt(client: () => MongoClient, collection: string): Attempt | undefined {
  const a = active.getStore();
  if (!a) return undefined;
  if (a.client !== client()) {
    throw new TypeError(
      `Krepis: "${collection}" uses a different MongoClient than the active transaction, so it cannot join it`,
    );
  }
  return a;
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.random() * Math.min(5 * 2 ** (attempt - 1), 500);
  return new Promise((r) => setTimeout(r, ms));
}

function runHooks(hooks: (() => unknown)[]): Promise<void> {
  return active.exit(async () => {
    for (const fn of hooks) {
      try {
        await fn();
      } catch (e) {
        process.emitWarning(new Error('Krepis: an afterCommit hook failed; the transaction had committed', { cause: e }), 'KrepisWarning');
      }
    }
  });
}

export async function runTransaction<T>(
  client: MongoClient,
  fn: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const outer = active.getStore();
  if (outer && !outer.ended) {
    if (outer.client !== client) {
      throw new TypeError('Krepis: a transaction cannot be nested inside one on a different MongoClient');
    }
    // MongoDB has no savepoints: the inner callback is part of the outer transaction, which owns retries.
    return fn(outer.handle);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const { timeoutMs: _, ...driverOptions } = options;
  const session = client.startSession();
  try {
    for (let n = 1; ; n++) {
      const attempt = new Attempt(client, session, n, deadline, timeoutMs);
      session.startTransaction(driverOptions);
      let result: T;
      try {
        result = await active.run(attempt, () => fn(attempt.handle));
        if (attempt.poison !== undefined) throw attempt.poison;
      } catch (e) {
        attempt.ended = true;
        if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
        if (attempt.poison === undefined && hasLabel(e, 'TransientTransactionError') && Date.now() < deadline) {
          await backoff(n);
          continue;
        }
        throw translate(e);
      }
      attempt.ended = true;
      const retry = await commit(session, deadline);
      if (retry) {
        await backoff(n);
        continue;
      }
      await runHooks(attempt.hooks);
      return result;
    }
  } finally {
    await session.endSession().catch(() => undefined);
  }
}

/** Commits, retrying an unknown result. Returns true when the whole transaction should be retried. */
async function commit(session: ClientSession, deadline: number): Promise<boolean> {
  for (;;) {
    try {
      await session.commitTransaction();
      return false;
    } catch (e) {
      const timedOut = (e as { codeName?: string }).codeName === 'MaxTimeMSExpired';
      if (hasLabel(e, 'UnknownTransactionCommitResult') && !timedOut && Date.now() < deadline) continue;
      if (hasLabel(e, 'TransientTransactionError') && Date.now() < deadline) return true;
      throw translate(e);
    }
  }
}
