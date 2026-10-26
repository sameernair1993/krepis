/**
 * Typed dotted paths and projection narrowing.
 *
 * `PathMap<D>` flattens a document type into `{ path: value }`, including the dotted
 * paths MongoDB accepts, so filters, updates, sorts and projections check a path and
 * its value instead of accepting any `${string}.${string}`. Where the schema itself is
 * open (a map, a `mixed` field, or past `MAX_DEPTH`), the path stays open below that
 * point: `prefs.${string}`, `meta.${string}`.
 */

/** Values never descended into: scalars, dates, and BSON values (all carry `_bsontype`). */
export type Leaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RegExp
  | Uint8Array
  | { readonly _bsontype: string }
  | ((...args: never[]) => unknown);

/** `read` paths (filter, sort, projection) traverse arrays implicitly; `update` paths use positional operators. */
export type PathMode = 'read' | 'update';

/** Depth below the top-level field; deeper paths stay open with an `unknown` value. */
type Depth = [never, 0, 1, 2, 3, 4];
type MAX_DEPTH = 4;

type Positional<P extends string> = `${P}.$` | `${P}.$[]` | `${P}.$[${string}]`;

/** [path, value] pairs strictly below `P`, whose value is `Raw`. */
type Below<P extends string, Raw, M extends PathMode, N extends number> = [N] extends [never]
  ? [`${P}.${string}`, unknown]
  : unknown extends Raw // `mixed`: checked before NonNullable, which turns unknown into {}
    ? [`${P}.${string}`, unknown]
    : BelowValue<P, NonNullable<Raw>, M, N>;

type BelowValue<P extends string, V, M extends PathMode, N extends number> = V extends Leaf
  ? never
  : V extends readonly (infer E)[]
    ? ArrayBelow<P, E, M, N>
    : string extends keyof V
      ? MapBelow<P, V[string]>
      : V extends object
        ? Fields<P, V, M, N>
        : never;

type Fields<P extends string, V, M extends PathMode, N extends number> = {
  [K in keyof V & string]-?: [`${P}.${K}`, V[K]] | Below<`${P}.${K}`, V[K], M, Depth[N]>;
}[keyof V & string];

type ArrayBelow<P extends string, E, M extends PathMode, N extends number> =
  | [`${P}.${number}`, E]
  | Below<`${P}.${number}`, E, M, Depth[N]>
  | (M extends 'read'
      ? Below<P, E, M, N> // implicit traversal: `items.qty` matches any element's qty
      : [Positional<P>, E] | Below<Positional<P>, E, M, Depth[N]>);

/** A map's values are typed when they are scalars; a map of objects stays open below its key. */
type MapBelow<P extends string, V> = [NonNullable<V>] extends [Leaf] ? [`${P}.${string}`, V] : [`${P}.${string}`, unknown];

type Pairs<D, M extends PathMode> = {
  [K in keyof D & string]-?: [K, D[K]] | Below<K, D[K], M, MAX_DEPTH>;
}[keyof D & string];

/** Every path of `D` (top-level and dotted) mapped to its value type. */
export type PathMap<D, M extends PathMode = 'read'> = { [E in Pairs<D, M> as E[0]]: E[1] };

// ---------------------------------------------------------------------------
// Projection narrowing
// ---------------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type Head<Ks> = Ks extends `${infer H}.${string}` ? H : Ks;
type Tail<Ks, K> = Ks extends `${K & string}.${infer R}` ? R : never;

type PickIn<V, Ks extends string> = V extends Leaf
  ? V
  : V extends readonly (infer E)[]
    ? PickIn<E, Ks>[]
    : V extends object
      ? PickPaths<V, Ks>
      : V;

export type PickPaths<D, Ks extends string> = Simplify<{
  [K in keyof D as K extends Head<Ks> ? K : never]: K extends Ks ? D[K] : PickIn<D[K], Tail<Ks, K>>;
}>;

type OmitIn<V, Ks extends string> = V extends Leaf
  ? V
  : V extends readonly (infer E)[]
    ? OmitIn<E, Ks>[]
    : V extends object
      ? OmitPaths<V, Ks>
      : V;

export type OmitPaths<D, Ks extends string> = Simplify<{
  [K in keyof D as K extends Ks ? never : K]: K extends Head<Ks> ? OmitIn<D[K], Tail<Ks, K>> : D[K];
}>;

type FieldKeys<P> = Exclude<keyof P, '_id'> & string;
type Flags<P> = { [K in FieldKeys<P>]-?: P[K] }[FieldKeys<P>];
/** A projection whose flags are not literals (a variable typed `{ a?: 0 | 1 }`) cannot be narrowed. */
type IsWide<P> = true extends { [K in keyof P]-?: [0 | 1] extends [Exclude<P[K], undefined>] ? true : number extends P[K] ? true : never }[keyof P]
  ? true
  : false;
/** Keys known only at runtime (`Record<string, 0>`) can be neither narrowed nor path-checked. */
type IsDynamic<P> = string extends keyof P ? true : false;

/**
 * The document `D` as returned by projection `P`. An inclusion keeps `_id` unless it is
 * excluded and keeps only the listed paths, nested ones included; an exclusion removes them.
 * A projection that is not a literal, or is empty, returns `D` unchanged.
 */
export type Project<D, P> = [keyof P] extends [never]
  ? D
  : true extends IsWide<P> | IsDynamic<P>
    ? D
    : [Flags<P>] extends [never]
      ? P extends { _id: 0 } ? Simplify<Omit<D, '_id'>> : D
      : [Flags<P>] extends [1]
        ? Simplify<(P extends { _id: 0 } ? unknown : Pick<D, '_id' & keyof D>) & PickPaths<D, FieldKeys<P>>>
        : [Flags<P>] extends [0]
          ? OmitPaths<D, (P extends { _id: 0 } ? '_id' : never) | FieldKeys<P>>
          : D;

/**
 * Rejects what a projection literal must not contain: an unknown path (inferred type
 * parameters escape excess-property checks, so this restores them), or a mix of
 * inclusion and exclusion, which the server refuses.
 */
export type CheckProjection<D, P> = (IsDynamic<P> extends true ? unknown : { [K in Exclude<keyof P, keyof PathMap<D>>]: never }) & (IsWide<P> extends true
  ? unknown
  : [0 | 1] extends [Flags<P>]
    ? { 'Krepis: a projection cannot mix inclusion and exclusion (other than _id)': never }
    : unknown);
