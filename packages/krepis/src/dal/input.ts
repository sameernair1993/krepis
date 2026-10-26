/**
 * Values written by code, as opposed to values received as input. At runtime a code literal
 * `{ $gte: 100 }` and `{ $ne: null }` parsed from a request body are the same kind of object, so code says
 * which is which: `op` marks an operator object as its own, and strict mode refuses unmarked ones.
 */

import type { ExprType, ValidExpr } from './aggregate.ts';
import type { PathMap } from './paths.ts';

// A registry symbol, so a mark made by one installed copy of Krepis is seen by another.
const TRUSTED = Symbol.for('krepis.dal.op');

/** Whether `value` itself was built by `op` or `match`: an own mark, never one inherited. */
export function isTrusted(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.getOwnPropertyDescriptor(value, TRUSTED)?.value === true;
}

function mark<T extends object>(value: T): T {
  // Non-enumerable and keyed by a symbol, so the driver never serialises it.
  Object.defineProperty(value, TRUSTED, { value: true });
  return value;
}

declare const PIPELINE: unique symbol;

/** A stage Krepis allows in an update pipeline. Values are aggregation expressions: wrap input in `{ $literal: v }`. */
export type PipelineStage =
  | { $set: Record<string, unknown> }
  | { $addFields: Record<string, unknown> }
  | { $unset: string | readonly string[] };

/** An update pipeline built by `op.pipeline` for documents `D`; a bare array is not an update. */
export type UpdatePipeline<D = any> = readonly PipelineStage[] & { readonly [PIPELINE]: (doc: D) => D };

type IsAny<T> = 0 extends 1 & T ? true : false;
// In a pipeline a numeric segment names a field, not an array element.
type SetPath<D> = Exclude<keyof PathMap<D> & string, '_id' | `${string}.${number}` | `${string}.${number}.${string}`>;
type At<M, K> = K extends keyof M ? M[K] : never;
type Fits<V, T> = unknown extends V ? true : [Exclude<V, null | undefined>] extends [NonNullable<T>] ? true : false;
type ValidValue<D, T, E> = ValidExpr<D, E> extends infer V
  ? [E] extends [V] ? (Fits<ExprType<D, E>, T> extends true ? E : T | null) : V
  : never;
type ValidSet<D, F> = {
  [K in keyof F]: K extends SetPath<D> ? ValidValue<D, At<PathMap<D>, K>, F[K]> : `Krepis: "${K & string}" is not a path of the schema`;
};
type ValidUnset<D, U> = U extends string
  ? U extends SetPath<D> ? U : SetPath<D>
  : U extends readonly unknown[]
    ? { [I in keyof U]: U[I] extends SetPath<D> ? U[I] : SetPath<D> }
    : SetPath<D> | readonly SetPath<D>[];
type Only<S, K extends string> = { [X in Exclude<keyof S, K>]: never };
type ValidStage<D, S> = S extends { $set: infer F }
  ? { $set: ValidSet<D, F> } & Only<S, '$set'>
  : S extends { $addFields: infer F }
    ? { $addFields: ValidSet<D, F> } & Only<S, '$addFields'>
    : S extends { $unset: infer U }
      ? { $unset: ValidUnset<D, U> } & Only<S, '$unset'>
      : PipelineStage;
/** Stages `S` where they fit documents `D`; otherwise the part that is wrong, so the error points at it. */
type ValidPipeline<D, S> = IsAny<D> extends true ? S : { [I in keyof S]: ValidStage<D, S[I]> };
type Checked<X, V> = [X] extends [V] ? X : NoInfer<V>;

export interface Op {
  /** Marks an operator object (or a filter, or a stage holding `$where`/`$function`) as written by code. */
  <T extends object>(operators: T): T;
  /**
   * An update pipeline written by code: `$set`, `$addFields` and `$unset` stages on paths of the schema.
   * Written inline as an update, its paths and value types are checked against the collection's schema.
   */
  pipeline<D = any, const S extends readonly PipelineStage[] = readonly PipelineStage[]>(
    stages: Checked<S, ValidPipeline<NoInfer<D>, S>>,
  ): UpdatePipeline<D>;
  eq<V>(value: V): { $eq: V };
  ne<V>(value: V): { $ne: V };
  gt<V>(value: V): { $gt: V };
  gte<V>(value: V): { $gte: V };
  lt<V>(value: V): { $lt: V };
  lte<V>(value: V): { $lte: V };
  in<V>(values: readonly V[]): { $in: V[] };
  nin<V>(values: readonly V[]): { $nin: V[] };
  all<V>(values: readonly V[]): { $all: V[] };
  exists(present?: boolean): { $exists: boolean };
  size(n: number): { $size: number };
  not<T extends object>(condition: T): { $not: T };
}

/**
 * Operators written in code. With `strictInput` (the default), an operator object where the schema expects a
 * scalar is refused unless it was built here: `{ total: op.gte(100) }`, `{ _id: op.in(ids) }`,
 * `{ n: op({ $gte: 1, $lt: 5 }) }`.
 */
export const op: Op = Object.assign(<T extends object>(operators: T): T => mark(operators), {
  pipeline: (stages: readonly PipelineStage[]) => mark([...stages]) as unknown as UpdatePipeline,
  eq: <V>(value: V) => mark({ $eq: value }),
  ne: <V>(value: V) => mark({ $ne: value }),
  gt: <V>(value: V) => mark({ $gt: value }),
  gte: <V>(value: V) => mark({ $gte: value }),
  lt: <V>(value: V) => mark({ $lt: value }),
  lte: <V>(value: V) => mark({ $lte: value }),
  in: <V>(values: readonly V[]) => mark({ $in: [...values] }),
  nin: <V>(values: readonly V[]) => mark({ $nin: [...values] }),
  all: <V>(values: readonly V[]) => mark({ $all: [...values] }),
  exists: (present = true) => mark({ $exists: present }),
  size: (n: number) => mark({ $size: n }),
  not: <T extends object>(condition: T) => mark({ $not: condition }),
});

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function literal(input: string | number, helper: string): string {
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new TypeError(`Krepis: match.${helper}() takes a string, got ${input === null ? 'null' : typeof input}`);
  }
  const text = String(input);
  // MongoDB refuses a pattern holding NUL with a server error.
  if (text.includes('\0')) throw new TypeError(`Krepis: match.${helper}() input contains a NUL character`);
  return text.replace(REGEX_META, '\\$&');
}

export interface MatchOptions {
  ignoreCase?: boolean;
}

type RegexCondition = { $regex: string; $options?: string };

function regex(pattern: string, options: MatchOptions): RegexCondition {
  return mark(options.ignoreCase ? { $regex: pattern, $options: 'i' } : { $regex: pattern });
}

/**
 * Text search from input, with every regex metacharacter escaped, so input cannot change the pattern (or
 * make it backtrack). A case-sensitive `prefix` is anchored, so it can use an index.
 */
export const match = {
  prefix: (input: string | number, options: MatchOptions = {}): RegexCondition => regex(`^${literal(input, 'prefix')}`, options),
  contains: (input: string | number, options: MatchOptions = {}): RegexCondition => regex(literal(input, 'contains'), options),
};
