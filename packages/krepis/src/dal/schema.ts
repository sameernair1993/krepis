import type { ObjectId } from 'mongodb';
import { isTrusted } from './input.ts';

/**
 * Schema definition for the Krepis data access layer.
 *
 * A schema is plain TypeScript: field builders carry their type, so the document,
 * insert and filter types are inferred rather than written twice. The same
 * definition drives runtime behaviour: casting, defaults, setters, validation and
 * the stripping of unknown fields.
 */

export type FieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'objectId'
  | 'enum'
  | 'map'
  | 'mixed'
  | 'array'
  | 'object';

export interface Validator {
  fn: (value: never) => boolean;
  message: string;
}

export interface FieldDef {
  kind: FieldKind;
  optional: boolean;
  default?: unknown;
  lowercase?: boolean;
  trim?: boolean;
  validators: Validator[];
  of?: FieldDef;
  shape?: Record<string, FieldDef>;
  ref?: string;
  /** The members of an `enum` field. */
  values?: readonly EnumMember[];
  /** Left out of every read unless a projection names it. Top-level fields only. */
  hidden?: boolean;
}

export type EnumMember = string | number;

export class Field<T, Opt extends boolean = false, Def extends boolean = false, Hid extends boolean = false> {
  // Phantom members: never assigned, present only so the type parameters are inferable.
  readonly __type?: T;
  readonly __opt?: Opt;
  readonly __def?: Def;
  readonly __hid?: Hid;
  readonly def: FieldDef;

  constructor(def: FieldDef) {
    this.def = def;
  }

  optional(): Field<T, true, Def, Hid> {
    return new Field({ ...this.def, optional: true });
  }

  default(value: T | (() => T)): Field<T, Opt, true, Hid> {
    return new Field({ ...this.def, default: value });
  }

  validate(fn: (value: T) => boolean, message: string): Field<T, Opt, Def, Hid> {
    return new Field({ ...this.def, validators: [...this.def.validators, { fn, message }] });
  }

  lowercase(): Field<T, Opt, Def, Hid> {
    return new Field({ ...this.def, lowercase: true });
  }

  trim(): Field<T, Opt, Def, Hid> {
    return new Field({ ...this.def, trim: true });
  }

  ref(collection: string): Field<T, Opt, Def, Hid> {
    return new Field({ ...this.def, ref: collection });
  }

  /**
   * Leaves the field out of every read unless a projection names it with `1`. Reads type it as
   * optional, because it is absent unless selected; inserts still require it unless it is `.optional()`.
   */
  hidden(): Field<T, Opt, Def, true> {
    return new Field({ ...this.def, hidden: true });
  }
}

type AnyField = Field<unknown, boolean, boolean, boolean>;
export type Shape = Record<string, AnyField>;

const base = (kind: FieldKind, extra: Partial<FieldDef> = {}): FieldDef => ({
  kind,
  optional: false,
  validators: [],
  ...extra,
});

export const t = {
  string: () => new Field<string>(base('string')),
  number: () => new Field<number>(base('number')),
  boolean: () => new Field<boolean>(base('boolean')),
  date: () => new Field<Date>(base('date')),
  objectId: () => new Field<ObjectId>(base('objectId')),
  /**
   * One of a fixed set of strings or numbers, typed as their literal union without `as const`.
   * Every write checks membership; reads do not, so legacy values stay queryable.
   */
  enum: <const V extends readonly EnumMember[]>(values: V) =>
    new Field<V[number]>(base('enum', { values: enumMembers(values) })),
  mixed: <T = unknown>() => new Field<T>(base('mixed')),
  map: <V extends AnyField>(of: V) => new Field<Record<string, FieldType<V>>>(base('map', { of: of.def })),
  array: <V extends AnyField>(of: V) => new Field<FieldType<V>[]>(base('array', { of: of.def })),
  object: <S extends Shape>(shape: S) =>
    new Field<DocOf<S>>(base('object', { shape: defsOf(shape) })),
};

function enumMembers(values: readonly EnumMember[]): readonly EnumMember[] {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('Krepis: t.enum() needs at least one value');
  for (const v of values) {
    if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) {
      throw new TypeError(`Krepis: t.enum() values must be strings or finite numbers, got ${String(v)}`);
    }
  }
  return Object.freeze([...values]);
}

function defsOf(shape: Shape): Record<string, FieldDef> {
  return Object.fromEntries(Object.entries(shape).map(([k, f]) => [k, f.def]));
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type FieldType<F> = F extends Field<infer T, boolean, boolean, boolean> ? T : never;

// A hidden field is optional on reads: it is absent unless a projection names it.
type OptionalKeys<S> = {
  [K in keyof S]: S[K] extends Field<unknown, true, boolean, boolean> ? K : S[K] extends Field<unknown, boolean, boolean, true> ? K : never;
}[keyof S];
type InsertOptionalKeys<S> = {
  [K in keyof S]: S[K] extends Field<unknown, true, boolean, boolean>
    ? K
    : S[K] extends Field<unknown, boolean, true, boolean>
      ? K
      : never;
}[keyof S];

type DocOf<S> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: FieldType<S[K]> } & {
    [K in OptionalKeys<S>]?: FieldType<S[K]>;
  }
>;

/** Values a caller may supply where the schema stores `T`; Krepis casts them. */
export type Castable<T> = T extends ObjectId
  ? ObjectId | string
  : T extends Date
    ? Date | string | number
    : T extends readonly (infer E)[]
      ? Castable<E>[]
      : T extends Record<string, unknown>
        ? string extends keyof T
          ? { [key: string]: Castable<T[string]> } | Map<string, Castable<T[string]>>
          : { [K in keyof T]: Castable<T[K]> }
        : T;

type Timestamps<O> = O extends { timestamps: true } ? { createdAt: Date; updatedAt: Date } : unknown;

export interface SchemaOptions {
  timestamps?: boolean;
  indexes?: readonly IndexSpec[];
}

export interface IndexSpec {
  keys: Record<string, 1 | -1 | 'text' | '2dsphere' | '2d' | 'hashed'>;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

// `any` defaults let `X extends Schema` accept every schema despite the invariant carrier below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Schema<D = any, I = any, K = any> {
  readonly fields: Record<string, FieldDef>;
  readonly options: SchemaOptions;
  /**
   * Type carriers only. Use `Doc<typeof s>` and `Insert<typeof s>`. The document carrier is
   * invariant, so a `TypedSchema<Interface>` annotation fails to compile if the interface and
   * the schema disagree in either direction.
   */
  readonly __doc?: (doc: D) => D;
  /**
   * Structural typing tolerates an omitted optional property, and TypeScript compares `D` by
   * variance rather than structurally, so the key set is a separate invariant parameter.
   */
  readonly __keys?: (key: K) => K;
  readonly __insert?: I;
}

export type Doc<X> = X extends Schema<infer D, unknown> ? D : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Insert<X> = X extends Schema<any, infer I> ? I : never;

type InferDoc<S, O> = Simplify<{ _id: ObjectId } & DocOf<S> & Timestamps<O>>;
type InferInsert<S> = Simplify<
  { _id?: Castable<ObjectId> } & {
    [K in Exclude<keyof S, InsertOptionalKeys<S>>]: Castable<FieldType<S[K]>>;
  } & { [K in InsertOptionalKeys<S>]?: Castable<FieldType<S[K]>> | null }
>;

type RequiredKeys<D> = { [K in keyof D]-?: object extends Pick<D, K> ? never : K }[keyof D];
/** Keys an insert may omit: declared optional, defaulted, or stamped by `timestamps`. */
type InsertOptional<D, Defaults> = Defaults | 'createdAt' | 'updatedAt' | Exclude<keyof D, RequiredKeys<D>>;
type InsertOf<D, Defaults extends PropertyKey> = Simplify<
  { _id?: Castable<ObjectId> } & {
    [K in Exclude<keyof D, '_id' | InsertOptional<D, Defaults>>]: Castable<D[K]>;
  } & { [K in Exclude<keyof D & InsertOptional<D, Defaults>, '_id'>]?: Castable<D[K]> | null }
>;

/**
 * Nameable schema type, for codebases under `isolatedDeclarations` (which forbids exporting an
 * inferred schema): `export const s: TypedSchema<Entity, 'fieldWithDefault'> = schema({...})`.
 * `Defaults` lists required fields that the schema defaults, so inserts may omit them.
 */
export type TypedSchema<D extends { _id: ObjectId }, Defaults extends keyof D = never> = Schema<
  D,
  InsertOf<D, Defaults>,
  keyof D
>;

export function schema<S extends Shape, const O extends SchemaOptions = { timestamps?: false }>(
  shape: S,
  options?: O,
): Schema<InferDoc<S, O>, InferInsert<S>, keyof InferDoc<S, O>> {
  const fields = defsOf(shape);
  for (const [key, def] of Object.entries(fields)) {
    if (def.of || def.shape) refuseNestedHidden(def, key);
  }
  if (options?.timestamps) {
    fields.createdAt ??= base('date', { optional: true });
    fields.updatedAt ??= base('date', { optional: true });
  }
  return { fields, options: options ?? {} };
}

function refuseNestedHidden(def: FieldDef, path: string): void {
  const inner = [...(def.of ? [[path, def.of] as const] : []), ...Object.entries(def.shape ?? {}).map(([k, d]) => [`${path}.${k}`, d] as const)];
  for (const [p, d] of inner) {
    if (d.hidden) throw new TypeError(`Krepis: .hidden() applies to top-level fields only, not "${p}"`);
    refuseNestedHidden(d, p);
  }
}

/** Top-level fields marked `.hidden()`. */
export function hiddenFields(fields: Record<string, FieldDef>): string[] {
  return Object.entries(fields).filter(([, d]) => d.hidden).map(([k]) => k);
}

// ---------------------------------------------------------------------------
// Runtime: casting, defaults, validation
// ---------------------------------------------------------------------------

/** The BSON classes Krepis needs, taken from the caller's driver so versions never mix. */
export interface Bson {
  ObjectId: new (id?: string) => ObjectId;
}

// The DAL ships as both ESM and CJS, and an app can end up loading both copies.
// Each copy has its own error classes, so a plain prototype `instanceof` would be
// silently false across them. The brand lives in the global symbol registry,
// which both copies share, and `Symbol.hasInstance` checks it instead.
const ERROR_BRAND = Symbol.for('krepis.dal.error');

export function brandError(error: Error, name: string): void {
  Object.defineProperty(error, ERROR_BRAND, { value: name });
}

export function isBrandedError(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[ERROR_BRAND] === name;
}

export class KrepisCastError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedError(value, 'KrepisCastError');
  }
  readonly path: string;
  readonly value: unknown;
  constructor(path: string, kind: FieldKind, value: unknown) {
    super(`Cannot cast ${JSON.stringify(value)} to ${kind} at "${path}"`);
    this.name = 'KrepisCastError';
    brandError(this, 'KrepisCastError');
    this.path = path;
    this.value = value;
  }
}

export class KrepisValidationError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedError(value, 'KrepisValidationError');
  }
  readonly errors: { path: string; message: string }[];
  constructor(errors: { path: string; message: string }[]) {
    super(`Validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'KrepisValidationError';
    brandError(this, 'KrepisValidationError');
    this.errors = errors;
  }
}

/** A filter or stage refused before it was sent: an operator object from input, or server-side JavaScript. */
export class KrepisInputError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return isBrandedError(value, 'KrepisInputError');
  }
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${message} (at "${path}")`);
    this.name = 'KrepisInputError';
    brandError(this, 'KrepisInputError');
    this.path = path;
  }
}

const ID_FIELD: FieldDef = base('objectId');
const MIXED: FieldDef = base('mixed');

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** A schema entry by own key only, so `__proto__` or `constructor` from input never resolves to a field. */
const own = (fields: Record<string, FieldDef> | undefined, key: string): FieldDef | undefined =>
  fields && Object.hasOwn(fields, key) ? fields[key] : undefined;

/**
 * Resolves a (possibly dotted) path to its field definition. Returns MIXED for
 * paths inside a map or mixed field, and undefined for paths the schema does not know.
 */
export function resolvePath(fields: Record<string, FieldDef>, path: string, positional = true): FieldDef | undefined {
  if (path === '_id') return fields._id ?? ID_FIELD;
  const parts = path.split('.');
  let def: FieldDef | undefined = own(fields, parts[0]!);
  for (let i = 1; def && i < parts.length; i++) {
    if (def.kind === 'mixed') return MIXED;
    if (def.kind === 'map') def = def.of ?? MIXED;
    else if (def.kind === 'array') def = positional && /^\d+$|^\$/.test(parts[i]!) ? def.of : own(def.of?.shape, parts[i]!);
    else if (def.kind === 'object') def = own(def.shape, parts[i]!);
    else return undefined;
  }
  return def;
}

/**
 * Casts a value to its field. `read` is set for filter values: an enum then normalises and coerces
 * but lets a non-member through, so documents written before a member was removed stay reachable.
 */
export function castValue(def: FieldDef, value: unknown, path: string, bson: Bson, read = false): unknown {
  if (value === null || value === undefined) return value;
  switch (def.kind) {
    case 'string': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new KrepisCastError(path, def.kind, value);
      }
      let s = String(value);
      if (def.trim) s = s.trim();
      if (def.lowercase) s = s.toLowerCase();
      return s;
    }
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) throw new KrepisCastError(path, def.kind, value);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      throw new KrepisCastError(path, def.kind, value);
    case 'date': {
      const d =
        value instanceof Date
          ? value
          : typeof value === 'string' || typeof value === 'number'
            ? new Date(value)
            : null;
      if (!d || Number.isNaN(d.getTime())) throw new KrepisCastError(path, def.kind, value);
      return d;
    }
    case 'objectId':
      return castObjectId(value, path, bson);
    case 'enum':
      return castEnum(def, value, path, read);
    case 'array': {
      const items = Array.isArray(value) ? value : [value];
      return items.map((v, i) => castValue(def.of ?? MIXED, v, `${path}.${i}`, bson, read));
    }
    case 'map': {
      const entries =
        value instanceof Map ? [...value.entries()] : isPlainObject(value) ? Object.entries(value) : null;
      if (!entries) throw new KrepisCastError(path, def.kind, value);
      return Object.fromEntries(
        entries.map(([k, v]) => [k, castValue(def.of ?? MIXED, v, `${path}.${k}`, bson, read)]),
      );
    }
    case 'object':
      if (!isPlainObject(value)) throw new KrepisCastError(path, def.kind, value);
      return castDocument(def.shape ?? {}, value, bson, path, read);
    case 'mixed':
      return value;
  }
}

/** Normalise (trim, lowercase), match exactly, then try the one coercion between `'2'` and `2`. */
function castEnum(def: FieldDef, value: unknown, path: string, read: boolean): unknown {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new KrepisCastError(path, def.kind, value);
  }
  const values = def.values ?? [];
  let v: EnumMember = typeof value === 'boolean' ? String(value) : value;
  if (typeof v === 'string') {
    if (def.trim) v = v.trim();
    if (def.lowercase) v = v.toLowerCase();
  }
  if (values.includes(v)) return v;
  const other = typeof v === 'number' ? String(v) : v.trim() === '' ? Number.NaN : Number(v);
  if (values.includes(other)) return other;
  if (read) {
    // A legacy value still takes the members' type when they share one, as t.number()/t.string() would cast it.
    if (typeof other === 'number' && !Number.isNaN(other) && values.every((m) => typeof m === 'number')) return other;
    if (typeof other === 'string' && values.every((m) => typeof m === 'string')) return other;
    return v;
  }
  throw new KrepisValidationError([{ path, message: `must be one of ${values.map((m) => JSON.stringify(m)).join(', ')}` }]);
}

function castObjectId(value: unknown, path: string, bson: Bson): unknown {
  if (value instanceof bson.ObjectId) return value;
  if (typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value)) return new bson.ObjectId(value);
  // An ObjectId from a different bson copy: re-create it so the driver can serialise it.
  if (value && typeof value === 'object' && typeof (value as ObjectId).toHexString === 'function') {
    return new bson.ObjectId((value as ObjectId).toHexString());
  }
  throw new KrepisCastError(path, 'objectId', value);
}

/** Casts the known fields of a document and drops unknown ones (Mongoose `strict` parity). */
export function castDocument(
  fields: Record<string, FieldDef>,
  doc: Record<string, unknown>,
  bson: Bson,
  prefix = '',
  read = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    const def = key === '_id' ? (fields._id ?? ID_FIELD) : own(fields, key);
    if (!def || value === undefined) continue;
    out[key] = castValue(def, value, prefix ? `${prefix}.${key}` : key, bson, read);
  }
  return out;
}

export function defaultValue(def: FieldDef): unknown {
  return typeof def.default === 'function' ? (def.default as () => unknown)() : def.default;
}

export function applyDefaults(fields: Record<string, FieldDef>, doc: Record<string, unknown>, bson: Bson): void {
  for (const [key, def] of Object.entries(fields)) {
    if (doc[key] === undefined && def.default !== undefined) {
      doc[key] = castValue(def, defaultValue(def), key, bson);
    }
  }
}

/** Runs required checks (when `checkRequired`) and custom validators over the given paths. */
export function validate(
  fields: Record<string, FieldDef>,
  values: Record<string, unknown>,
  checkRequired: boolean,
): void {
  const errors: { path: string; message: string }[] = [];
  if (checkRequired) {
    for (const [key, def] of Object.entries(fields)) {
      if (!def.optional && def.default === undefined && (values[key] === undefined || values[key] === null)) {
        errors.push({ path: key, message: 'is required' });
      }
    }
  }
  for (const [path, value] of Object.entries(values)) {
    const def = resolvePath(fields, path);
    if (!def || value === undefined || value === null) continue;
    for (const v of def.validators) {
      if (!(v.fn as (x: unknown) => boolean)(value)) errors.push({ path, message: v.message });
    }
  }
  if (errors.length) throw new KrepisValidationError(errors);
}

// ---------------------------------------------------------------------------
// Filters and updates
// ---------------------------------------------------------------------------

const ROOT_LOGICAL = new Set(['$and', '$or', '$nor']);
const VALUE_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const LIST_OPS = new Set(['$in', '$nin', '$all']);

function castQueryValue(def: FieldDef, value: unknown, path: string, bson: Bson): unknown {
  if (value === null || value instanceof RegExp) return value;
  // A scalar compared against an array field matches its elements.
  if (def.kind === 'array' && !Array.isArray(value)) return castValue(def.of ?? MIXED, value, path, bson, true);
  return castValue(def, value, path, bson, true);
}

function castCondition(def: FieldDef, cond: unknown, path: string, bson: Bson): unknown {
  if (!isPlainObject(cond) || !Object.keys(cond).some((k) => k.startsWith('$'))) {
    return castQueryValue(def, cond, path, bson);
  }
  const out: Record<string, unknown> = {};
  for (const [op, v] of Object.entries(cond)) {
    if (VALUE_OPS.has(op)) out[op] = castQueryValue(def, v, path, bson);
    else if (LIST_OPS.has(op) && Array.isArray(v)) out[op] = v.map((x) => castQueryValue(def, x, path, bson));
    else if (op === '$not' && isPlainObject(v)) out[op] = castCondition(def, v, path, bson);
    else out[op] = v;
  }
  return out;
}

/** Casts filter values by schema path. Unknown paths pass through unchanged. */
export function castFilter(
  fields: Record<string, FieldDef>,
  filter: Record<string, unknown>,
  bson: Bson,
  strict: boolean,
): Record<string, unknown> {
  refuseServerJs(filter, '');
  checkFilter(fields, filter, strict);
  return castFilterAt(fields, filter, bson);
}

/**
 * Refuses what a filter from input must not hold, without casting it: a `__proto__` key and a logical operator
 * over anything but filter objects always; with `strict`, an operator object not built by `op` where
 * the schema expects a scalar, including inside `$elemMatch` on an array of objects.
 */
export function checkFilter(fields: Record<string, FieldDef>, filter: Record<string, unknown>, strict: boolean, prefix = ''): void {
  for (const [key, value] of Object.entries(filter)) {
    const path = prefix + key;
    if (key === '__proto__') throw new KrepisInputError(path, '__proto__ is not a field name');
    if (ROOT_LOGICAL.has(key) && Array.isArray(value)) {
      for (const f of value) {
        if (!isPlainObject(f)) throw new KrepisInputError(path, `${key} takes an array of filter objects`);
        checkFilter(fields, f, strict, prefix);
      }
      continue;
    }
    if (!strict || key.startsWith('$')) continue;
    const def = resolvePath(fields, key);
    if (!def) continue;
    refuseOperators(def, value, path);
    const shape = elementShape(def);
    if (shape && isPlainObject(value) && isPlainObject(value.$elemMatch)) checkFilter(shape, value.$elemMatch, true, `${path}.$elemMatch.`);
  }
}

function elementShape(def: FieldDef): Record<string, FieldDef> | undefined {
  return def.kind === 'array' && def.of?.kind === 'object' ? def.of.shape : undefined;
}

function castFilterAt(fields: Record<string, FieldDef>, filter: Record<string, unknown>, bson: Bson): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (ROOT_LOGICAL.has(key) && Array.isArray(value)) {
      out[key] = value.map((f) => castFilterAt(fields, f as Record<string, unknown>, bson));
      continue;
    }
    const def = key.startsWith('$') ? undefined : resolvePath(fields, key);
    out[key] = def ? castCondition(def, value, key, bson) : value;
  }
  return out;
}

const SCALAR_KINDS = new Set<FieldKind>(['string', 'number', 'boolean', 'date', 'objectId', 'enum']);

/**
 * `strictInput`: an operator object where the schema expects a scalar, or an array of scalars, must
 * have been built by `op`. A plain one is what a parsed request body carrying `{ "$ne": null }` looks like.
 */
function refuseOperators(def: FieldDef, value: unknown, path: string): void {
  const scalar = SCALAR_KINDS.has(def.kind) ? def.kind : def.kind === 'array' && def.of && SCALAR_KINDS.has(def.of.kind) ? `array of ${def.of.kind}` : undefined;
  if (!scalar || !isPlainObject(value) || isTrusted(value)) return;
  const ops = Object.keys(value).filter((k) => k.startsWith('$'));
  if (ops.length === 0) return;
  throw new KrepisInputError(
    path,
    `Operator object {${ops.join(', ')}} where the schema expects ${scalar}. Operators written in code are built with op `
      + `(op.gte(1), op.in(ids), op({ ... })); from input, this is operator injection. strictInput: false turns this check off`,
  );
}

const SERVER_JS = new Set(['$where', '$function', '$accumulator']);

/**
 * `$where`, `$function` and `$accumulator` run JavaScript on the server: refused unless the object holding them
 * is built by `op`. The mark allows them at that object's own level only; everything under it is still scanned.
 */
export function refuseServerJs(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const v of value) refuseServerJs(v, path);
    return;
  }
  if (!isPlainObject(value)) return;
  const trusted = isTrusted(value);
  for (const [k, v] of Object.entries(value)) {
    const at = path ? `${path}.${k}` : k;
    if (SERVER_JS.has(k) && !trusted) {
      throw new KrepisInputError(at, `${k} runs JavaScript on the server and is refused; build the object holding it with op({ ... }) to allow it for this call`);
    }
    refuseServerJs(v, at);
  }
}

export type UpdateDoc = Record<string, unknown>;

/**
 * Normalises an update: top-level non-operator keys go into `$set`, so a plain
 * object can never replace a whole document by accident (replacement is `replaceOne`).
 */
export function normalizeUpdate(update: UpdateDoc): UpdateDoc {
  // Anything else would be read as index keys, dropped as unknown fields, and the write misreported.
  if (!isPlainObject(update)) {
    throw new KrepisInputError('', Array.isArray(update)
      ? 'An update pipeline (an array) must be built with op.pipeline([...]); pass an update document otherwise'
      : `An update must be an object, got ${update === null ? 'null' : typeof update}`);
  }
  const out: UpdateDoc = {};
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith('$')) out[key] = isPlainObject(value) ? { ...value } : value;
    else if (value !== undefined) set[key] = value;
  }
  if (Object.keys(set).length) out.$set = { ...set, ...(out.$set as object | undefined) };
  return out;
}

const SET_OPS = new Set(['$set', '$setOnInsert']);
const PIPELINE_STAGES = new Set(['$set', '$addFields', '$unset']);

/**
 * An update pipeline built by `op.pipeline`: `$set`, `$addFields` and `$unset` on paths of the schema,
 * with no server-side JavaScript outside objects built by `op`. Values are computed on the server, so they are
 * neither cast nor validated. `updatedAt` is appended as an update document gets it.
 */
export function castPipeline(
  fields: Record<string, FieldDef>,
  pipeline: readonly unknown[],
  upsert: boolean,
  timestamps: boolean | undefined,
  now = new Date(),
): Record<string, unknown>[] {
  if (pipeline.length === 0) throw new TypeError('Krepis: an update pipeline needs at least one stage');
  if (upsert) {
    throw new TypeError('Krepis: an update pipeline cannot upsert: it cannot apply defaults or createdAt on insert only; use an update document');
  }
  const known = (path: unknown, at: string): void => {
    // A pipeline path below an array names a field of every element: `items.0` is a field "0".
    if (typeof path !== 'string' || !resolvePath(fields, path, false)) throw new TypeError(`Krepis: ${JSON.stringify(path)} in ${at} is not a path of the schema`);
  };
  let setsUpdatedAt = false;
  const out = pipeline.map((stage, i) => {
    const keys = isPlainObject(stage) ? Object.keys(stage) : [];
    const name = keys[0] ?? '';
    if (keys.length !== 1 || !PIPELINE_STAGES.has(name)) {
      throw new TypeError(`Krepis: update pipeline stage ${i} must be one $set, $addFields or $unset; use raw() for other stages`);
    }
    const body = (stage as Record<string, unknown>)[name];
    refuseServerJs(stage, String(i));
    if (name === '$unset') {
      const paths = typeof body === 'string' ? [body] : Array.isArray(body) ? body : undefined;
      if (!paths) throw new TypeError(`Krepis: $unset in update pipeline stage ${i} takes a path or an array of paths`);
      for (const p of paths) known(p, `stage ${i} $unset`);
    } else {
      if (!isPlainObject(body)) throw new TypeError(`Krepis: ${name} in update pipeline stage ${i} takes an object`);
      for (const p of Object.keys(body)) known(p, `stage ${i} ${name}`);
      setsUpdatedAt ||= Object.hasOwn(body, 'updatedAt');
    }
    return { [name]: body };
  });
  if (timestamps && !setsUpdatedAt) out.push({ $set: { updatedAt: now } });
  return out;
}
const NUMERIC_OPS = new Set(['$inc', '$mul', '$min', '$max']);
const NUMBER = base('number');

function castUpdatePath(op: string, def: FieldDef, path: string, value: unknown, bson: Bson, strict: boolean): unknown {
  if (SET_OPS.has(op)) return castValue(def, value, path, bson);
  if (def.kind === 'enum' && NUMERIC_OPS.has(op)) {
    // $min/$max store one of the given values, so membership holds; $inc/$mul store a computed one.
    if (op === '$min' || op === '$max') return castValue(def, value, path, bson);
    throw new KrepisValidationError([{ path, message: `cannot be changed with ${op}` }]);
  }
  if (NUMERIC_OPS.has(op)) return castValue(def.kind === 'date' ? def : NUMBER, value, path, bson);
  if (op === '$push' || op === '$addToSet') {
    const el = def.of ?? MIXED;
    return isPlainObject(value) && Array.isArray(value.$each)
      ? { ...value, $each: value.$each.map((v) => castValue(el, v, path, bson)) }
      : castValue(el, value, path, bson);
  }
  if (op === '$pullAll' && Array.isArray(value)) return value.map((v) => castQueryValue(def, v, path, bson));
  if (op === '$pull') {
    // A $pull condition is a query on the elements, so strictInput applies to it.
    if (strict) {
      refuseOperators(def, value, path);
      const shape = elementShape(def);
      if (shape && isPlainObject(value)) checkFilter(shape, value, true, `${path}.`);
    }
    return castCondition(def, value, path, bson);
  }
  return value;
}

/** Casts an update, stripping unknown paths and validating every value it sets. */
export function castUpdate(fields: Record<string, FieldDef>, update: UpdateDoc, bson: Bson, strict: boolean): UpdateDoc {
  const out: UpdateDoc = {};
  const setValues: Record<string, unknown> = {};
  const errors: { path: string; message: string }[] = [];
  for (const [op, body] of Object.entries(update)) {
    if (!isPlainObject(body)) {
      out[op] = body;
      continue;
    }
    const castBody: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(body)) {
      const def = resolvePath(fields, path);
      if (!def) continue;
      castBody[path] = castUpdatePath(op, def, path, value, bson, strict);
      if (SET_OPS.has(op)) {
        setValues[path] = castBody[path];
        if (castBody[path] === null && !def.optional && def.default === undefined) {
          errors.push({ path, message: 'is required' });
        }
      }
    }
    if (Object.keys(castBody).length) out[op] = castBody;
  }
  if (errors.length) throw new KrepisValidationError(errors);
  validate(fields, setValues, false);
  return out;
}

const touches = (update: UpdateDoc, key: string): boolean =>
  Object.values(update).some(
    (body) => isPlainObject(body) && Object.keys(body).some((p) => p === key || p.startsWith(`${key}.`)),
  );

const filterSets = (filter: Record<string, unknown>, key: string): boolean =>
  key in filter ||
  (Array.isArray(filter.$and) && filter.$and.some((f) => isPlainObject(f) && filterSets(f, key)));

/** Adds defaults to `$setOnInsert` for fields an upsert would otherwise leave unset. */
export function applyUpsertDefaults(
  fields: Record<string, FieldDef>,
  filter: Record<string, unknown>,
  update: UpdateDoc,
  bson: Bson,
): void {
  const onInsert = (update.$setOnInsert ?? {}) as Record<string, unknown>;
  for (const [key, def] of Object.entries(fields)) {
    if (def.default === undefined || filterSets(filter, key) || touches(update, key)) continue;
    onInsert[key] = castValue(def, defaultValue(def), key, bson);
  }
  if (Object.keys(onInsert).length) update.$setOnInsert = onInsert;
}

export function applyUpdateTimestamps(
  timestamps: boolean | undefined,
  update: UpdateDoc,
  upsert: boolean,
  now = new Date(),
): void {
  if (!timestamps) return;
  if (upsert && !touches(update, 'createdAt')) {
    update.$setOnInsert = { ...(update.$setOnInsert as object | undefined), createdAt: now };
  }
  const set = (update.$set ?? {}) as Record<string, unknown>;
  if (set.updatedAt === undefined) set.updatedAt = now;
  update.$set = set;
}
