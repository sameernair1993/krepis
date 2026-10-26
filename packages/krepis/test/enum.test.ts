import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import {
  createDal,
  op,
  schema,
  t,
  KrepisCastError,
  KrepisValidationError,
  type Doc,
  type Insert,
  type TypedSchema,
} from '../src/dal/index.ts';
import { URI } from './helpers.ts';

/** `t.enum()`. Runtime tests hit the database; the `types*` functions are compile-time only. */

const client = new MongoClient(URI);
const db = () => client.db('krepis_enum_test');
const dal = createDal(client, { dbName: 'krepis_enum_test' });

const accounts = schema({
  plan: t.enum(['free', 'pro']).trim().lowercase(),
  tier: t.enum([1, 2, 3]).default(1),
  code: t.enum(['1', '2']).optional(),
  tags: t.array(t.enum(['red', 'blue'])).default(() => []),
  billing: t.object({ cycle: t.enum(['monthly', 'yearly']) }).optional(),
});
const Accounts = dal.collection('accounts', accounts);

const badDefault = schema({ plan: t.enum(['free', 'pro']).default('gold' as 'free') });
const BadDefault = dal.collection('accounts', badDefault);

before(() => client.connect());
after(() => client.close());
beforeEach(() => db().dropDatabase());

const rejectsAt = (path: string) => (err: unknown) => {
  assert.ok(err instanceof KrepisValidationError, `expected KrepisValidationError, got ${String(err)}`);
  assert.equal(err.errors[0]?.path, path);
  assert.match(err.errors[0]!.message, /must be one of/);
  return true;
};

test('insert stores members, normalises strings first, and coerces once', async () => {
  const a = await Accounts.insertOne({ plan: ' PRO ' as 'pro', tier: '2' as unknown as 2, code: 2 as unknown as '2' });
  const raw = await db().collection('accounts').findOne({ _id: a._id });
  assert.equal(raw?.plan, 'pro');
  assert.equal(raw?.tier, 2);
  assert.equal(raw?.code, '2');
  assert.deepEqual(raw?.tags, []);
});

test('a non-member is rejected on every write path, at any depth', async () => {
  const bad = <T>(v: unknown) => v as T;
  await assert.rejects(Accounts.insertOne({ plan: bad('gold') }), rejectsAt('plan'));
  await assert.rejects(Accounts.insertOne({ plan: 'free', tier: bad(4) }), rejectsAt('tier'));
  await assert.rejects(Accounts.insertOne({ plan: 'free', billing: { cycle: bad('weekly') } }), rejectsAt('billing.cycle'));
  await assert.rejects(Accounts.insertOne({ plan: 'free', tags: bad(['red', 'green']) }), rejectsAt('tags.1'));
  await assert.rejects(Accounts.insertOne({ plan: bad({ x: 1 }) }), KrepisCastError);

  const { _id } = await Accounts.insertOne({ plan: 'free', tags: ['red'] });
  await assert.rejects(Accounts.updateOne({ _id }, { $set: { plan: bad('gold') } }), rejectsAt('plan'));
  await assert.rejects(Accounts.updateOne({ _id }, { plan: bad('gold') }), rejectsAt('plan'));
  await assert.rejects(Accounts.updateOne({ _id }, { $set: { 'billing.cycle': bad('weekly') } }), rejectsAt('billing.cycle'));
  await assert.rejects(Accounts.updateOne({ _id, tags: 'red' }, { $set: { 'tags.$': bad('green') } }), rejectsAt('tags.$'));
  await assert.rejects(Accounts.updateOne({ _id }, { $push: { tags: bad('green') } }), rejectsAt('tags'));
  await assert.rejects(Accounts.updateOne({ _id }, { $push: { tags: { $each: bad(['blue', 'green']) } } }), rejectsAt('tags'));
  await assert.rejects(Accounts.updateOne({ _id }, { $addToSet: { tags: bad('green') } }), rejectsAt('tags'));
  await assert.rejects(
    Accounts.updateOne({ _id: new ObjectId() }, { $setOnInsert: { plan: bad('gold') } }, { upsert: true }),
    rejectsAt('plan'),
  );
  await assert.rejects(Accounts.updateOne({ _id }, { $max: { tier: bad(9) } }), rejectsAt('tier'));
  await Accounts.updateOne({ _id }, { $max: { tier: 3 }, $push: { tags: 'blue' } });
  const doc = await Accounts.findOne({ _id });
  assert.equal(doc?.tier, 3);
  assert.deepEqual(doc?.tags, ['red', 'blue']);
});

test('$inc and $mul cannot change an enum: the server computes a result nothing can check', async () => {
  const { _id } = await Accounts.insertOne({ plan: 'free' });
  const loose = Accounts.updateOne as (f: object, u: object) => Promise<unknown>;
  await assert.rejects(loose.call(Accounts, { _id }, { $inc: { tier: 1 } }), /cannot be changed with \$inc/);
  await assert.rejects(loose.call(Accounts, { _id }, { $mul: { tier: 2 } }), /cannot be changed with \$mul/);
});

test('a default that is not a member fails on insert and on upsert', async () => {
  await assert.rejects(BadDefault.insertOne({}), rejectsAt('plan'));
  await assert.rejects(BadDefault.updateOne({ _id: new ObjectId() }, { $set: {} }, { upsert: true }), rejectsAt('plan'));
});

test('reads never enforce membership, so documents written before a member was removed stay reachable', async () => {
  const legacy = (v: unknown) => v as never;
  const { insertedId } = await db()
    .collection('accounts')
    .insertOne({ plan: 'trial', tier: 7, tags: ['red', 'green'], billing: { cycle: 'weekly' } });
  assert.equal((await Accounts.findOne({ plan: legacy(' TRIAL ') }))?._id.toString(), insertedId.toString());
  assert.ok(await Accounts.findOne({ tier: legacy('7') }), 'coerced, then passed through');
  assert.ok(await Accounts.findOne({ plan: op.in([legacy('trial')]) }));
  assert.ok(await Accounts.findOne({ tags: legacy('green') }));
  assert.ok(await Accounts.findOne({ tags: legacy(['red', 'green']) }), 'whole-array equality, through array recursion');
  assert.ok(await Accounts.findOne({ 'billing.cycle': legacy('weekly') }));
  await Accounts.updateOne({ _id: insertedId }, { $pull: { tags: legacy('green') } });
  assert.deepEqual((await db().collection('accounts').findOne({ _id: insertedId }))?.tags, ['red']);
});

test('t.enum() rejects a definition it could never satisfy', () => {
  assert.throws(() => t.enum([]), TypeError);
  assert.throws(() => t.enum([{} as unknown as string]), TypeError);
  assert.throws(() => t.enum([Number.NaN]), TypeError);
  assert.throws(() => t.enum([Number.POSITIVE_INFINITY]), TypeError);
});

// ---------------------------------------------------------------------------
// Compile-time tests: `tsc --noEmit` fails if a @ts-expect-error line compiles.
// ---------------------------------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const expectType = <T extends true>(): T => true as T;

// Ambient, because erasableSyntaxOnly forbids a runtime enum in this package; the function using it never runs.
declare enum Plan {
  Free = 'free',
  Pro = 'pro',
}

export function typesInference() {
  type A = Doc<typeof accounts>;
  expectType<Equal<A['plan'], 'free' | 'pro'>>();
  expectType<Equal<A['tier'], 1 | 2 | 3>>();
  expectType<Equal<A['tags'], ('red' | 'blue')[]>>();
  expectType<Equal<NonNullable<A['billing']>['cycle'], 'monthly' | 'yearly'>>();
  expectType<Equal<Insert<typeof accounts>['plan'], 'free' | 'pro'>>();
  const s = schema({ plan: t.enum(Object.values(Plan)) });
  // Mutual assignability: the strict Equal tells the enum type `Plan` from its expanded member union.
  expectType<Same<Doc<typeof s>['plan'], Plan>>();
  expectType<Equal<Same<Doc<typeof s>['plan'], string>, false>>(); // not widened
}

export function typesTypedSchema() {
  interface Account {
    _id: ObjectId;
    plan: 'free' | 'pro';
    tier: 1 | 2 | 3;
    code?: '1' | '2';
    tags: ('red' | 'blue')[];
    billing?: { cycle: 'monthly' | 'yearly' };
  }
  const ok: TypedSchema<Account, 'tier' | 'tags'> = accounts;
  // @ts-expect-error the interface widens an enum to string
  const wide: TypedSchema<Omit<Account, 'plan'> & { plan: string }, 'tier' | 'tags'> = accounts;
  // @ts-expect-error the interface narrows an enum the schema allows
  const narrow: TypedSchema<Omit<Account, 'plan'> & { plan: 'free' }, 'tier' | 'tags'> = accounts;
  return [ok, wide, narrow];
}

export async function typesWrites(id: ObjectId) {
  await Accounts.insertOne({ plan: 'pro' });
  // @ts-expect-error not a member
  await Accounts.insertOne({ plan: 'gold' });
  await Accounts.updateOne({ _id: id }, { $set: { plan: 'free', 'billing.cycle': 'yearly' } });
  // @ts-expect-error not a member, nested
  await Accounts.updateOne({ _id: id }, { $set: { 'billing.cycle': 'weekly' } });
  await Accounts.updateOne({ _id: id }, { $push: { tags: 'red' } });
  // @ts-expect-error not a member, array element
  await Accounts.updateOne({ _id: id }, { $push: { tags: 'green' } });
  await Accounts.updateOne({ _id: id }, { $max: { tier: 3 } });
  // @ts-expect-error $inc cannot be checked against the members
  await Accounts.updateOne({ _id: id }, { $inc: { tier: 1 } });
  // @ts-expect-error $mul neither
  await Accounts.updateOne({ _id: id }, { $mul: { tier: 2 } });
}

export async function typesReads() {
  await Accounts.findOne({ plan: 'pro', tags: 'red', 'billing.cycle': 'monthly' });
  await Accounts.findOne({ plan: { $in: ['free', 'pro'] } });
  await Accounts.findOne({ plan: op.in(['free', 'pro']) });
  // @ts-expect-error not a member
  await Accounts.findOne({ plan: 'gold' });
  // @ts-expect-error not a member, inside $in
  await Accounts.findOne({ plan: { $in: ['free', 'gold'] } });
  // @ts-expect-error not a member, inside op.in
  await Accounts.findOne({ plan: op.in(['free', 'gold']) });
  // @ts-expect-error not a member, nested
  await Accounts.findOne({ 'billing.cycle': 'weekly' });
}

export function typesNumberStillIncrements() {
  const Counters = dal.collection('counters', schema({ n: t.number() }));
  return Counters.updateOne({}, { $inc: { n: 1 } });
}
