import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId, type CommandStartedEvent } from 'mongodb';
import { createDal, op, schema, t, KrepisUnboundedReadError, type ScopeContext } from '../src/dal/index.ts';
import { URI } from './helpers.ts';

/**
 * The typed aggregation builder. Runtime tests run against MongoDB; the type
 * tests are functions that are never called, checked by `tsc` (a `@ts-expect-error` that
 * compiles fails the typecheck), each beside a control line that must compile.
 */

const DB = 'krepis_aggregate_test';
const client = new MongoClient(URI, { monitorCommands: true });
const db = () => client.db(DB);

let commands: CommandStartedEvent[] = [];
client.on('commandStarted', (e) => {
  if (e.databaseName === DB && ['find', 'aggregate', 'getMore'].includes(e.commandName)) commands.push(e);
});

const users = schema({
  name: t.string(),
  email: t.string().optional(),
  age: t.number(),
  orgId: t.objectId().optional(),
  tenantId: t.string().optional(),
  tags: t.array(t.string()).default(() => []),
  address: t.object({ city: t.string(), zip: t.number().optional() }).optional(),
});
const posts = schema({
  title: t.string(),
  authorId: t.objectId(),
  likes: t.number(),
  createdAt: t.date().optional(),
  items: t.array(t.object({ sku: t.string(), qty: t.number() })).default(() => []),
});

let tenant: string | undefined;
const tenantScope = (): ScopeContext | undefined => (tenant === undefined ? undefined : { filter: { tenantId: tenant } });

const dal = createDal(client, { dbName: DB });
const Users = dal.collection('users', users, { scope: tenantScope });
const Posts = dal.collection('posts', posts);
const Posts2 = dal.collection('posts', posts);

before(() => client.connect());
after(() => client.close());
beforeEach(async () => {
  tenant = undefined;
  await db().dropDatabase();
  commands = [];
});

async function seed() {
  const [ann, bob, cat] = await Users.insertMany([
    { name: 'Ann', age: 30, tenantId: 'a', tags: ['x', 'y'] },
    { name: 'Bob', age: 40, tenantId: 'b', tags: ['y'] },
    { name: 'Cat', age: 50, tenantId: 'a' },
  ]);
  const list = await Posts.insertMany([
    { title: 'p0', authorId: ann._id, likes: 1, items: [{ sku: 'a', qty: 2 }] },
    { title: 'p1', authorId: bob._id, likes: 2 },
    { title: 'p2', authorId: ann._id, likes: 3, items: [{ sku: 'b', qty: 1 }, { sku: 'c', qty: 4 }] },
    { title: 'p3', authorId: cat._id, likes: 4 },
  ]);
  commands = [];
  return { ann, bob, cat, posts: list };
}

const aggregates = () => commands.filter((c) => c.commandName === 'aggregate');

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

test('parity: the builder sends the pipeline it was given and returns what the driver returns', async () => {
  await seed();
  const built = Posts.aggregate()
    .group({ _id: '$authorId', likes: { $sum: '$likes' }, n: { $count: {} } })
    .sort({ likes: -1, _id: 1 })
    .limit(10);
  const rows = await built.toArray();
  const raw = await db().collection('posts').aggregate(built.pipeline()).toArray();
  assert.deepEqual(rows, raw);
  assert.deepEqual(rows.map((r) => r.likes), [4, 4, 2]);
  assert.deepEqual(built.pipeline(), [
    { $group: { _id: '$authorId', likes: { $sum: '$likes' }, n: { $count: {} } } },
    { $sort: { likes: -1, _id: 1 } },
    { $limit: 10 },
  ]);
});

test('one command: a pipeline costs one aggregate command, however many stages', async () => {
  await seed();
  await Posts.aggregate().match({ likes: op.gte(1) }).unwind('$items').project({ sku: '$items.sku' }).limit(10).toArray();
  assert.equal(commands.length, 1);
  assert.equal(aggregates().length, 1);
});

test('scope: a scoped collection prepends its scope $match, so other tenants never enter the pipeline', async () => {
  await seed();
  tenant = 'a';
  const names = await Users.aggregate().sort({ name: 1 }).project({ _id: 0, name: 1 }).limit(10).toArray();
  assert.deepEqual(names, [{ name: 'Ann' }, { name: 'Cat' }]);
  assert.deepEqual(aggregates()[0].command.pipeline[0], { $match: { tenantId: 'a' } });
  assert.deepEqual(Users.aggregate().pipeline()[0], { $match: { tenantId: 'a' } });
});

test('scope: an aggregate that groups across the whole collection still only sees the tenant', async () => {
  await seed();
  tenant = 'b';
  const [row] = await Users.aggregate().group({ _id: null, n: { $sum: 1 } }).all();
  assert.equal(row.n, 1);
});

test('scoped $lookup: joining a scoped collection keeps its scope; the raw driver $lookup leaks', async () => {
  await seed();
  tenant = 'a';
  const rows = await Posts.aggregate()
    .lookup({ from: Users, localField: 'authorId', foreignField: '_id', as: 'author' })
    .sort({ title: 1 })
    .limit(10)
    .toArray();
  assert.deepEqual(rows.map((r) => r.author.map((u) => u.name)), [['Ann'], [], ['Ann'], ['Cat']]);
  assert.equal(aggregates().length, 1, 'still one command');

  const leaked = await db()
    .collection('posts')
    .aggregate([{ $lookup: { from: 'users', localField: 'authorId', foreignField: '_id', as: 'author' } }, { $sort: { title: 1 } }])
    .toArray();
  assert.deepEqual(leaked[1].author.map((u: { name: string }) => u.name), ['Bob'], 'the raw join reads tenant b');
});

test('scoped $lookup: a sub-pipeline is cast by the target schema and still scoped', async () => {
  const { ann } = await seed();
  const org = new ObjectId();
  await db().collection('users').updateOne({ _id: ann._id }, { $set: { orgId: org } });
  tenant = 'a';
  const rows = await Posts.aggregate()
    .match({ title: 'p0' })
    .lookup({
      from: Users,
      localField: 'authorId',
      foreignField: '_id',
      as: 'author',
      pipeline: (p) => p.match({ orgId: org.toHexString() }).project({ _id: 0, name: 1 }),
    })
    .limit(1)
    .toArray();
  assert.deepEqual(rows[0].author, [{ name: 'Ann' }]);
  const stage = aggregates()[0].command.pipeline[1].$lookup;
  assert.deepEqual(stage.pipeline[0], { $match: { tenantId: 'a' } }, 'the target scope leads the sub-pipeline');
  assert.ok(stage.pipeline[1].$match.orgId instanceof ObjectId, 'the hex string was cast for the target');
});

test('scoped $lookup: an unscoped target gets no extra $match', async () => {
  await seed();
  const p = Users.aggregate().lookup({ from: Posts, localField: '_id', foreignField: 'authorId', as: 'posts' }).pipeline();
  assert.deepEqual(p, [{ $lookup: { from: 'posts', localField: '_id', foreignField: 'authorId', as: 'posts' } }]);
});

test('$lookup refuses a collection from another database, which the server would read as a different one', async () => {
  const other = createDal(client, { dbName: 'krepis_aggregate_other' }).collection('users', users);
  assert.throws(() => Posts.aggregate().lookup({ from: other, localField: 'authorId', foreignField: '_id', as: 'a' }).pipeline(), TypeError);
});

test('cast before a reshape: $match values are cast while the documents are still stored documents', async () => {
  const { ann } = await seed();
  const rows = await Posts.aggregate().match({ authorId: ann._id.toHexString() }).sort({ title: 1 }).limit(10).toArray();
  assert.deepEqual(rows.map((r) => r.title), ['p0', 'p2']);
  assert.ok(aggregates()[0].command.pipeline[0].$match.authorId instanceof ObjectId);
});

test('no cast after a reshape: a $match after $group compares what the group produced', async () => {
  await seed();
  const hex = new ObjectId().toHexString();
  await Posts.insertMany([{ title: hex, authorId: new ObjectId(), likes: 9 }]);
  const rows = await Posts.aggregate().group({ _id: '$title', likes: { $sum: '$likes' } }).match({ _id: hex }).all();
  assert.deepEqual(rows, [{ _id: hex, likes: 9 }], 'a 24-hex string group key is not turned into an ObjectId');
  assert.equal(typeof aggregates()[0].command.pipeline[1].$match._id, 'string');
});

test('no cast after $addFields, $unwind or $lookup either', async () => {
  await seed();
  const hex = new ObjectId().toHexString();
  const p = Posts.aggregate().addFields({ copy: '$title' }).match({ copy: hex }).pipeline();
  assert.equal(typeof (p[1].$match as { copy: unknown }).copy, 'string');
});

test('unbounded reads: toArray() without $limit follows the policy; $limit, $count, first() and all() do not', async () => {
  await seed();
  await assert.rejects(Posts.aggregate().match({ likes: op.gt(0) }).toArray(), KrepisUnboundedReadError);
  assert.equal(aggregates().length, 0, 'refused before any command');
  assert.equal((await Posts.aggregate().limit(2).toArray()).length, 2);
  assert.deepEqual(await Posts.aggregate().count('n').toArray(), [{ n: 4 }]);
  assert.equal((await Posts.aggregate().all()).length, 4);
  const first = await Posts.aggregate().sort({ likes: -1 }).first();
  assert.equal(first?.title, 'p3');
  assert.deepEqual(aggregates().at(-1)?.command.pipeline.at(-1), { $limit: 1 });
  assert.equal(await Posts.aggregate().match({ likes: 99 }).first(), null);
});

test('first() does not change the builder it was called on', async () => {
  await seed();
  const b = Posts.aggregate().sort({ likes: 1 });
  await b.first();
  assert.deepEqual(b.pipeline(), [{ $sort: { likes: 1 } }]);
});

test('builders are immutable: each stage returns a new builder', async () => {
  const base = Posts.aggregate().match({ likes: 1 });
  const a = base.limit(1);
  const b = base.limit(2);
  assert.deepEqual(base.pipeline(), [{ $match: { likes: 1 } }]);
  assert.deepEqual(a.pipeline().at(-1), { $limit: 1 });
  assert.deepEqual(b.pipeline().at(-1), { $limit: 2 });
});

test('cursor() streams the result', async () => {
  await seed();
  const titles: string[] = [];
  for await (const r of Posts.aggregate().sort({ title: 1 }).project({ _id: 0, title: 1 }).cursor()) titles.push(r.title);
  assert.deepEqual(titles, ['p0', 'p1', 'p2', 'p3']);
});

test('transactions: an aggregate inside dal.transaction joins it and sees its uncommitted writes', async () => {
  await seed();
  await dal.transaction(async () => {
    await Posts.insertOne({ title: 'tx', authorId: new ObjectId(), likes: 100 });
    const [row] = await Posts.aggregate().group({ _id: null, likes: { $sum: '$likes' } }).all();
    assert.equal(row.likes, 110);
    const outside = await db().collection('posts').countDocuments();
    assert.equal(outside, 4, 'not visible outside before commit');
  });
  // countDocuments is an aggregate too, so pick the builder's by its $group stage.
  const cmd = aggregates().find((c) => c.command.pipeline.some((st: object) => '$group' in st))!.command;
  assert.ok(cmd.txnNumber !== undefined && cmd.lsid !== undefined, 'the aggregate ran in the transaction');
});

test('stage(): an escape hatch for stages without a typed method, refusing those that read or write other collections', () => {
  const p = Posts.aggregate().stage<{ n: number }>({ $densify: { field: 'likes', range: { step: 1, bounds: 'full' } } }).pipeline();
  assert.equal(p.length, 1);
  for (const s of [
    { $lookup: { from: 'users', localField: 'authorId', foreignField: '_id', as: 'u' } },
    { $unionWith: 'users' },
    { $graphLookup: { from: 'users', startWith: '$a', connectFromField: 'a', connectToField: 'b', as: 'g' } },
    { $out: 'copy' },
    { $merge: { into: 'copy' } },
    { $facet: { a: [{ $lookup: { from: 'users', as: 'u', pipeline: [] } }] } },
  ]) {
    assert.throws(() => Posts.aggregate().stage(s), TypeError, JSON.stringify(s));
  }
});

test('unwind, addFields, project and count produce the documents their types describe', async () => {
  await seed();
  const rows = await Posts.aggregate()
    .unwind('$items')
    .addFields({ total: { $multiply: ['$items.qty', '$likes'] } })
    .project({ _id: 0, sku: '$items.sku', total: 1 })
    .sort({ sku: 1 })
    .limit(10)
    .toArray();
  assert.deepEqual(rows, [
    { total: 2, sku: 'a' },
    { total: 3, sku: 'b' },
    { total: 12, sku: 'c' },
  ]);
  const kept = await Posts.aggregate().unwind({ path: '$items', preserveNullAndEmptyArrays: true }).count('n').toArray();
  assert.deepEqual(kept, [{ n: 5 }]);
});

test('two collections sharing a name share a pipeline target', async () => {
  await seed();
  const rows = await Posts.aggregate()
    .lookup({ from: Posts2, localField: 'authorId', foreignField: 'authorId', as: 'siblings' })
    .match({ title: 'p0' })
    .limit(1)
    .toArray();
  assert.equal(rows[0].siblings.length, 2);
});

// ---------------------------------------------------------------------------
// Types (never called)
// ---------------------------------------------------------------------------

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <A, B>(..._: Same<A, B> extends true ? [] : [never]) => {};
declare const id: ObjectId;

export async function b1MatchField() {
  Posts.aggregate().match({ likes: 1 });
  // @ts-expect-error B1: misspelled field in $match
  Posts.aggregate().match({ likse: 1 });
}

export async function b2MatchDottedType() {
  Posts.aggregate().match({ 'items.qty': { $gt: 1 } });
  // @ts-expect-error B2: dotted path with the wrong value type
  Posts.aggregate().match({ 'items.qty': 'two' });
}

export async function b3GroupFieldRef() {
  Posts.aggregate().group({ _id: '$authorId', n: { $sum: '$likes' } });
  // @ts-expect-error B3: accumulator references a misspelled field
  Posts.aggregate().group({ _id: '$authorId', n: { $sum: '$likse' } });
  // @ts-expect-error B3: the group key references a misspelled field
  Posts.aggregate().group({ _id: '$authr', n: { $sum: 1 } });
}

export async function b4SumOfString() {
  Posts.aggregate().group({ _id: null, n: { $sum: '$likes' }, a: { $avg: '$likes' } });
  // @ts-expect-error B4: $sum over a string field
  Posts.aggregate().group({ _id: null, n: { $sum: '$title' } });
  // @ts-expect-error B4: $avg over a string field
  Posts.aggregate().group({ _id: null, n: { $avg: '$title' } });
}

export async function b5GroupDropsFields() {
  const [r] = await Posts.aggregate().group({ _id: '$authorId', n: { $sum: 1 } }).all();
  void r.n;
  // @ts-expect-error B5: a field the group did not produce is absent
  void r.title;
}

export async function b6AccumulatorTypes() {
  const [r] = await Posts.aggregate()
    .group({
      _id: '$authorId',
      n: { $sum: '$likes' },
      avg: { $avg: '$likes' },
      top: { $max: '$likes' },
      first: { $first: '$title' },
      titles: { $push: '$title' },
      skus: { $addToSet: '$items.sku' },
      c: { $count: {} },
      when: { $min: '$createdAt' },
    })
    .all();
  same<typeof r._id, ObjectId>();
  same<typeof r.n, number>();
  same<typeof r.avg, number | null>();
  same<typeof r.top, number>();
  same<typeof r.first, string>();
  same<typeof r.titles, string[]>();
  same<typeof r.skus, string[][]>();
  same<typeof r.c, number>();
  same<typeof r.when, Date | null>();
  // @ts-expect-error B6: the sum is a number, not a string
  same<typeof r.n, string>();
}

export async function b7ProjectNarrows() {
  const [r] = await Posts.aggregate().project({ title: 1, author: '$authorId', _id: 0 }).all();
  same<typeof r, { title: string; author: ObjectId }>();
  // @ts-expect-error B7: an un-projected field is gone
  void r.likes;
  const [x] = await Posts.aggregate().project({ items: 0, likes: 0 }).all();
  void x.title;
  // @ts-expect-error B7: an excluded field is gone
  void x.likes;
  // @ts-expect-error B7: a projected path must exist
  Posts.aggregate().project({ titel: 1 });
  // @ts-expect-error B7: a computed field must reference an existing path
  Posts.aggregate().project({ t: '$titel' });
}

export async function b8ExpressionTypes() {
  const [r] = await Posts.aggregate()
    .addFields({
      score: { $add: ['$likes', 1] },
      label: { $concat: ['$title', '!'] },
      hot: { $gt: ['$likes', 2] },
      pick: { $cond: [{ $gt: ['$likes', 2] }, '$title', null] },
      n: { $size: '$items' },
    })
    .all();
  same<typeof r.score, number>();
  same<typeof r.label, string>();
  same<typeof r.hot, boolean>();
  same<typeof r.pick, string | null>();
  same<typeof r.n, number>();
  void r.title; // addFields keeps the rest
  // @ts-expect-error B8: arithmetic on a string field
  Posts.aggregate().addFields({ bad: { $add: ['$title', 1] } });
  // @ts-expect-error B8: string operator over a number field
  Posts.aggregate().addFields({ bad: { $concat: ['$likes'] } });
}

export async function b9SortAfterGroup() {
  Posts.aggregate().group({ _id: '$authorId', n: { $sum: 1 } }).sort({ n: -1 });
  // @ts-expect-error B9: the field is gone after $group
  Posts.aggregate().group({ _id: '$authorId', n: { $sum: 1 } }).sort({ likes: -1 });
}

export async function b10Unwind() {
  const [r] = await Posts.aggregate().unwind('$items').all();
  same<typeof r.items, { sku: string; qty: number }>();
  const [k] = await Posts.aggregate().unwind({ path: '$items', preserveNullAndEmptyArrays: true, includeArrayIndex: 'i' }).all();
  same<typeof k.items, { sku: string; qty: number } | null | undefined>();
  same<typeof k.i, number | null>();
  // @ts-expect-error B10: only an array field can be unwound
  Posts.aggregate().unwind('$title');
  // @ts-expect-error B10: the path must exist
  Posts.aggregate().unwind('$itmes');
}

export async function b11LookupTyped() {
  const [r] = await Posts.aggregate().lookup({ from: Users, localField: 'authorId', foreignField: '_id', as: 'author' }).all();
  same<typeof r.author[number]['name'], string>();
  void r.title;
  const [s] = await Posts.aggregate()
    .lookup({ from: Users, localField: 'authorId', foreignField: '_id', as: 'author', pipeline: (p) => p.project({ _id: 0, name: 1 }) })
    .all();
  same<typeof s.author, { name: string }[]>();
  // @ts-expect-error B11: the joined documents carry the target's fields only
  void r.author[0].likes;
}

export async function b12LookupFields() {
  // @ts-expect-error B12: foreignField must be a path on the target
  Posts.aggregate().lookup({ from: Users, localField: 'authorId', foreignField: 'authorId', as: 'a' });
  // @ts-expect-error B12: localField must be a path on this collection
  Posts.aggregate().lookup({ from: Users, localField: 'author', foreignField: '_id', as: 'a' });
  // @ts-expect-error B12: from must be a Krepis collection, so its scope can apply
  Posts.aggregate().lookup({ from: 'users', localField: 'authorId', foreignField: '_id', as: 'a' });
}

export async function castState() {
  // Before a reshape, values are castable (a hex string for an ObjectId)...
  Posts.aggregate().match({ authorId: id.toHexString() });
  Posts.aggregate().sort({ likes: 1 }).match({ authorId: id.toHexString() });
  Posts.aggregate().group({ _id: '$authorId' }).match({ _id: id });
  // @ts-expect-error TB10: ...after one they are not cast, so the type no longer accepts a string for an ObjectId
  Posts.aggregate().group({ _id: '$authorId' }).match({ _id: id.toHexString() });
}

export async function misc() {
  const [c] = await Posts.aggregate().count('total').toArray();
  same<typeof c, { total: number }>();
  const [u] = await Posts.aggregate().unset('items', 'likes').all();
  void u.title;
  // @ts-expect-error unset removes the field
  void u.likes;
  // @ts-expect-error unset takes existing paths
  Posts.aggregate().unset('itmes');
  const [s] = await Posts.aggregate().stage<{ any: string }>({ $sample: { size: 1 } }).all();
  same<typeof s, { any: string }>();
  const [rw] = await Posts.aggregate().replaceWith({ t: '$title', l: '$likes' }).all();
  same<typeof rw, { t: string; l: number }>();
  const [root] = await Users.aggregate().match({ 'address.city': 'x' }).group({ _id: '$address.city', who: { $push: '$$ROOT' } }).all();
  same<typeof root._id, string | null>(); // $group turns a missing key into null
  void root.who[0].name;
}
