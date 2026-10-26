import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId, type CommandStartedEvent } from 'mongodb';
import { createDal, KrepisInputError, op, schema, t, type ScopeContext, type UpdatePipeline } from '../src/dal/index.ts';
import { mongooseModel } from '../src/compat/index.ts';
import { URI } from './helpers.ts';

// Update pipelines are opt-in with op.pipeline.

const client = new MongoClient(URI, { monitorCommands: true });
const db = () => client.db('krepis_pipeline_test');
const writes: CommandStartedEvent[] = [];
client.on('commandStarted', (e) => {
  if (e.commandName === 'update' || e.commandName === 'findAndModify') writes.push(e);
});

const items = schema({ a: t.number(), b: t.number().optional(), tenantId: t.string().optional() }, { timestamps: true });
const dal = createDal(client, { dbName: 'krepis_pipeline_test' });
const Items = dal.collection('items', items);
const Rewriting = dal.collection('items', items, { scope: (): ScopeContext => ({ filter: { tenantId: 't1' }, update: (u) => u }) });
const Filtered = dal.collection('items', items, { scope: (): ScopeContext => ({ filter: { tenantId: 't1' } }) });

const inc = () => op.pipeline([{ $set: { b: { $add: ['$a', 1] } } }]);
const b = async (a: number) => (await Items.raw().findOne({ a }))?.b;

before(() => client.connect());
after(() => client.close());
beforeEach(async () => {
  await db().dropDatabase();
  await Items.insertMany([{ a: 1, tenantId: 't1' }, { a: 10, tenantId: 't1' }]);
  writes.length = 0;
});

test('P1 op.pipeline writes computed values through every update method, with timestamps', async () => {
  const was = await Items.raw().findOne({ a: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await Items.updateOne({ a: 1 }, inc())).modifiedCount, 1);
  const now = await Items.raw().findOne({ a: 1 });
  assert.equal(now?.b, 2);
  assert.ok(now!.updatedAt > was!.updatedAt, 'updatedAt advances');
  assert.equal(String(now!.createdAt), String(was!.createdAt), 'createdAt does not');

  assert.equal((await Items.updateMany({}, inc())).modifiedCount, 2);
  assert.equal(await b(10), 11);
  const returned = await Items.findOneAndUpdate({ a: 10 }, op.pipeline([{ $addFields: { b: { $multiply: ['$a', 3] } } }]));
  assert.equal(returned?.b, 30);
  await Items.bulkWrite([{ updateOne: { filter: { a: 1 }, update: op.pipeline([{ $set: { b: 7 } }]) } }]);
  assert.equal(await b(1), 7);
  await Items.updateOne({ a: 1 }, op.pipeline([{ $unset: 'b' }]));
  assert.equal(await b(1), undefined);
  await mongooseModel(Items).updateOne({ a: 10 }, [{ $set: { b: '$a' } }], { updatePipeline: true });
  assert.equal(await b(10), 10, 'compat with updatePipeline: true');
  const fn = op({ $function: { body: 'function (a) { return a * 5 }', args: ['$a'], lang: 'js' } });
  await Items.updateOne({ a: 1 }, op.pipeline([{ $set: { b: fn } }]));
  assert.equal(await b(1), 5, 'server-side JavaScript in an object built with op');
});

test('P2 refused before anything is sent', async () => {
  const js = { $function: { body: 'function () { return 1 }', args: [], lang: 'js' } };
  await assert.rejects(Items.updateOne({ a: 1 }, op.pipeline([{ $set: { b: js } }])), KrepisInputError);
  for (const stage of [{ $project: { a: 1 } }, { $replaceWith: { a: 1 } }, { $match: { a: 1 } }, { $set: { b: 1 }, $unset: 'a' }]) {
    await assert.rejects(Items.updateOne({ a: 1 }, op.pipeline([stage as any])), TypeError, JSON.stringify(stage));
  }
  // @ts-expect-error unknown path: a type error, and still refused at runtime
  await assert.rejects(Items.updateOne({ a: 1 }, op.pipeline([{ $set: { nope: 1 } }])), TypeError, 'unknown $set path');
  // @ts-expect-error unknown path: a type error, and still refused at runtime
  await assert.rejects(Items.updateOne({ a: 1 }, op.pipeline([{ $unset: ['b', 'nope'] }])), TypeError, 'unknown $unset path');
  await assert.rejects(Items.updateOne({ a: 1 }, op.pipeline([])), TypeError, 'empty');
  await assert.rejects(Items.updateOne({ a: 5 }, inc(), { upsert: true }), TypeError, 'upsert');
  await assert.rejects(Rewriting.updateOne({ a: 1 }, inc()), TypeError, 'scope with an update hook');
  await assert.rejects(mongooseModel(Items).updateOne({ a: 1 }, [{ $set: { b: 1 } }]), KrepisInputError, 'compat without the option');
  assert.deepEqual(writes, []);
  assert.equal((await Filtered.updateOne({ a: 1 }, inc())).modifiedCount, 1, 'a scope with only a filter');
  assert.equal(await b(1), 2);
});

test('P3 types: op.pipeline is an update; a bare array and other stages are not', () => {
  const typed = () => [
    Items.updateOne({ a: 1 }, inc()),
    Items.updateMany({ a: 1 }, inc()),
    Items.findOneAndUpdate({ a: 1 }, inc()),
    Items.bulkWrite([{ updateMany: { filter: {}, update: inc() } }]),
    // @ts-expect-error a bare array is not an update
    Items.updateOne({ a: 1 }, [{ $set: { b: 1 } }]),
    // @ts-expect-error $project is not an update-pipeline stage Krepis allows
    op.pipeline([{ $project: { a: 1 } }]),
  ];
  assert.equal(typeof typed, 'function');
});

// Update pipelines are typed by the collection's schema.

const rich = schema({
  price: t.number(),
  qty: t.number(),
  total: t.number().optional(),
  name: t.string(),
  status: t.enum(['open', 'shut']),
  owner: t.objectId().optional(),
  lines: t.array(t.object({ sku: t.string(), n: t.number() })).optional(),
  meta: t.mixed().optional(),
});
const Rich = dal.collection('rich', rich);

test('T1 an inline pipeline is checked against the schema', () => {
  const input = String(Math.random());
  const id = new ObjectId();
  // An annotated variable types a pipeline outside a call.
  const forOther: UpdatePipeline<{ _id: ObjectId; x: number }> = op.pipeline([{ $set: { x: 1 } }]);
  // @ts-expect-error checked against the annotation
  const badOther: UpdatePipeline<{ _id: ObjectId; x: number }> = op.pipeline([{ $set: { y: 1 } }]);
  const typed = () => [
    badOther,
    Rich.updateOne({}, op.pipeline([{ $set: { total: { $multiply: ['$price', '$qty'] } } }])),
    Rich.updateMany({}, op.pipeline([{ $set: { name: { $concat: ['$name', '!'] }, status: 'shut' } }, { $unset: ['total', 'owner'] }])),
    Rich.findOneAndUpdate({}, op.pipeline([{ $set: { name: { $literal: input }, owner: id, meta: { any: 1 } } }])),
    Rich.bulkWrite([{ updateOne: { filter: {}, update: op.pipeline([{ $addFields: { 'lines.n': 1 } }]) } }]),
    Rich.updateOne({}, op.pipeline([{ $set: { total: '$price', name: '$$NOW' } }])),

    // @ts-expect-error unknown $set path
    Rich.updateOne({}, op.pipeline([{ $set: { totl: 1 } }])),
    // @ts-expect-error unknown $addFields path
    Rich.updateMany({}, op.pipeline([{ $addFields: { totl: 1 } }])),
    // @ts-expect-error unknown $unset path
    Rich.updateOne({}, op.pipeline([{ $unset: ['total', 'nope'] }])),
    // @ts-expect-error misspelled field reference
    Rich.updateOne({}, op.pipeline([{ $set: { total: { $multiply: ['$prce', '$qty'] } } }])),
    // @ts-expect-error $concat produces a string, not a number
    Rich.findOneAndUpdate({}, op.pipeline([{ $set: { total: { $concat: ['$name', 'x'] } } }])),
    // @ts-expect-error not a member of the enum
    Rich.updateOne({}, op.pipeline([{ $set: { status: 'closed' } }])),
    // @ts-expect-error input of type string into an enum
    Rich.updateOne({}, op.pipeline([{ $set: { status: { $literal: input } } }])),
    // @ts-expect-error a string is not an ObjectId: pipelines are not cast
    Rich.updateOne({}, op.pipeline([{ $set: { owner: input } }])),
    // @ts-expect-error _id cannot be set
    Rich.updateOne({}, op.pipeline([{ $set: { _id: id } }])),
    // @ts-expect-error an array index in a pipeline path names a field, not an element
    Rich.updateOne({}, op.pipeline([{ $set: { 'lines.0.n': 1 } }])),
    // @ts-expect-error same in $unset
    Rich.updateOne({}, op.pipeline([{ $unset: 'lines.0' }])),
    // @ts-expect-error two operators in one stage
    Rich.updateOne({}, op.pipeline([{ $set: { total: 1 }, $unset: 'owner' }])),
    // @ts-expect-error $project
    Rich.updateOne({}, op.pipeline([{ $project: { total: 1 } }])),
    // @ts-expect-error unknown path inside bulkWrite
    Rich.bulkWrite([{ updateMany: { filter: {}, update: op.pipeline([{ $set: { totl: 1 } }]) } }]),
    // @ts-expect-error a pipeline typed for another schema
    Rich.updateOne({}, forOther),
  ];
  assert.equal(typeof typed, 'function');
});

test('T2 a pipeline built outside a call keeps the stage-shape typing', async () => {
  const anyPath = () => op.pipeline([{ $set: { anything: 1 } }]);
  const typed = () => Rich.updateOne({}, anyPath());
  assert.equal(typeof typed, 'function');
  assert.equal((await Items.updateOne({ a: 1 }, inc())).modifiedCount, 1);
});

test('T3 an array index or positional segment in a pipeline path is refused', async () => {
  await Rich.insertOne({ price: 2, qty: 3, name: 'n', status: 'open', lines: [{ sku: 'a', n: 1 }, { sku: 'b', n: 2 }] });
  writes.length = 0;
  for (const p of [op.pipeline([{ $set: { 'lines.0.n': 9 } }]), op.pipeline([{ $set: { 'lines.$.n': 9 } }]), op.pipeline([{ $unset: 'lines.0' }])]) {
    await assert.rejects(Rich.updateOne({}, p), TypeError, JSON.stringify(p));
  }
  assert.deepEqual(writes, []);
  await Rich.updateOne({}, op.pipeline([{ $addFields: { 'lines.n': 5 } }]));
  assert.deepEqual((await Rich.raw().findOne({}))?.lines, [{ sku: 'a', n: 5 }, { sku: 'b', n: 5 }]);
});
