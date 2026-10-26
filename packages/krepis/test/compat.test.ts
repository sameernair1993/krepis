import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createDal, schema, t, KrepisUnboundedReadError, type Doc } from '../src/dal/index.ts';
import { mongooseModel } from '../src/compat/index.ts';
import { URI } from './helpers.ts';

/** The Mongoose-shaped facade. Runtime tests hit the database; `types*` functions are compile-time only. */

const client = new MongoClient(URI);
const db = () => client.db('krepis_compat_test');
const dal = createDal(client, { dbName: 'krepis_compat_test' });

const snapshots = schema({
  id: t.string(),
  org: t.string(),
  status: t.enum(['running', 'success', 'error']),
  n: t.number().default(0),
  note: t.string().optional(),
});
type Snap = Doc<typeof snapshots>;

const Snapshots = mongooseModel(dal.collection('snapshots', snapshots));
const Unbounded = mongooseModel(dal.collection('snapshots', snapshots), { allowUnboundedReads: true });

let tenant = 'a';
const scoped = dal.collection('snapshots', snapshots, {
  scope: () => ({ filter: { org: tenant }, stamp: (d) => { d.org = tenant; } }),
});
const Scoped = mongooseModel(scoped, { allowUnboundedReads: true });

before(() => client.connect());
after(() => client.close());
beforeEach(async () => {
  await db().dropDatabase();
  tenant = 'a';
});

const seed = () =>
  Snapshots.create([
    { id: 's1', org: 'a', status: 'success', n: 1 },
    { id: 's2', org: 'a', status: 'running', n: 2 },
    { id: 's3', org: 'b', status: 'error', n: 3 },
  ]);

test('create casts and defaults through the collection, single and array', async () => {
  const one = await Snapshots.create({ id: 'x', org: 'a', status: 'success' });
  assert.equal(one.n, 0);
  const many = await Snapshots.create([{ id: 'y', org: 'a', status: 'error', n: '4' as unknown as number }]);
  assert.equal(many.length, 1);
  assert.equal((await db().collection('snapshots').findOne({ id: 'y' }))?.n, 4);
});

test('find is lazy, chainable and thenable; exec and await agree', async () => {
  await seed();
  const q = Snapshots.find({ org: 'a' }).sort({ n: -1 }).skip(1).limit(5);
  assert.equal(await db().collection('snapshots').countDocuments(), 3, 'building a query runs nothing');
  assert.deepEqual((await q.exec()).map((d) => d.id), ['s1']);
  assert.deepEqual((await Snapshots.find({ org: 'a' }, null, { sort: { n: 1 }, skip: 1, limit: 1 })).map((d) => d.id), ['s2']);
});

test('find projection narrows, via the argument or select()', async () => {
  await seed();
  const rows = await Snapshots.find({ id: 's1' }, { id: 1 }).limit(1);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['_id', 'id']);
  const sel = await Snapshots.find({ id: 's1' }).select({ id: 1, _id: 0 }).limit(1);
  assert.deepEqual(sel, [{ id: 's1' }]);
});

test('an unbounded find follows the dal policy unless the model opts out', async () => {
  await seed();
  await assert.rejects(Snapshots.find({}).exec(), KrepisUnboundedReadError);
  assert.equal((await Unbounded.find({})).length, 3);
});

test('findOne honours projection and sort; lean() is the identity', async () => {
  await seed();
  const top = await Snapshots.findOne({ org: 'a' }, { id: 1 }, { sort: { n: -1 } }).lean();
  assert.equal(top?.id, 's2');
  assert.equal(Object.keys(top!).includes('status'), false);
  assert.equal(await Snapshots.findOne({ id: 'nope' }).exec(), null);
  assert.equal((await Snapshots.findOne({ org: 'a' }).sort({ n: 1 }))?.id, 's1');
});

test('findOneAndUpdate returns the document before the update unless new or returnDocument says after', async () => {
  await seed();
  assert.equal((await Snapshots.findOneAndUpdate({ id: 's1' }, { $set: { n: 10 } }))?.n, 1);
  assert.equal((await Snapshots.findOneAndUpdate({ id: 's1' }, { $set: { n: 11 } }, { new: true }))?.n, 11);
  assert.equal((await Snapshots.findOneAndUpdate({ id: 's1' }, { $set: { n: 12 } }, { returnDocument: 'after' }))?.n, 12);
  assert.equal((await Snapshots.findOneAndUpdate({ id: 's1' }, { $set: { n: 13 } }, { new: true, returnDocument: 'before' }))?.n, 12);
});

test('findOneAndUpdate upserts and casts the update', async () => {
  const up = await Snapshots.findOneAndUpdate(
    { id: 'u' },
    { $set: { org: 'a', status: 'running', n: '7' as unknown as number } },
    { upsert: true, new: true, projection: { n: 1, _id: 0 } },
  );
  assert.deepEqual(up, { n: 7 });
});

test('findOneAndDelete, countDocuments and the write passthroughs', async () => {
  await seed();
  assert.equal(await Snapshots.countDocuments({ org: 'a' }), 2);
  assert.equal((await Snapshots.findOneAndDelete({ org: 'a' }, { sort: { n: -1 } }))?.id, 's2');
  assert.equal((await Snapshots.updateMany({ org: 'a' }, { $set: { note: 'x' } })).modifiedCount, 1);
  assert.equal((await Snapshots.updateOne({ id: 'z' }, { $set: { org: 'a', status: 'error' } }, { upsert: true })).upsertedCount, 1);
  assert.equal((await Snapshots.deleteOne({ id: 'z' })).deletedCount, 1);
  assert.equal((await Snapshots.deleteMany({})).deletedCount, 2);
});

test('aggregate runs a raw pipeline and keeps the collection scope as its first stage', async () => {
  await seed();
  const all = await Unbounded.aggregate<{ _id: string; total: number }>([{ $group: { _id: '$org', total: { $sum: '$n' } } }, { $sort: { _id: 1 } }]).exec();
  assert.deepEqual(all, [{ _id: 'a', total: 3 }, { _id: 'b', total: 3 }]);
  const scopedRows = await Scoped.aggregate<{ _id: string }>([{ $group: { _id: '$org' } }]);
  assert.deepEqual(scopedRows, [{ _id: 'a' }]);
  assert.throws(() => Scoped.aggregate([{ $lookup: { from: 'x', localField: 'a', foreignField: 'b', as: 'c' } }]), /bypasses the target's scope/);
});

test('scope applies to every facade read and write', async () => {
  await seed();
  assert.deepEqual((await Scoped.find({})).map((d) => d.id).sort(), ['s1', 's2']);
  assert.equal(await Scoped.findOne({ id: 's3' }), null);
  assert.equal(await Scoped.countDocuments({}), 2);
  const made = await Scoped.create({ id: 's4', org: 'b', status: 'running' });
  assert.equal(made.org, 'a');
});

test('collection is the driver collection, as Model.collection is in Mongoose', async () => {
  await seed();
  assert.equal(Snapshots.collection.collectionName, 'snapshots');
  assert.equal(await Snapshots.collection.countDocuments({}), 3);
});

export function typesCompat(): void {
  const rows = Snapshots.find({ org: 'a' }, { id: 1 }).limit(1).exec();
  void rows.then((r) => {
    const id: string = r[0]!.id;
    // @ts-expect-error -- projected away
    void r[0]!.status;
    void id;
  });
  // @ts-expect-error -- unknown path in the projection
  Snapshots.find({}, { nope: 1 });
  // @ts-expect-error -- unknown path in the filter
  Snapshots.find({ nope: 1 });
  // @ts-expect-error -- required field missing on create
  void Snapshots.create({ id: 'x', status: 'success' });
  // @ts-expect-error -- not an enum member
  void Snapshots.create({ id: 'x', org: 'a', status: 'done' });
  // lean<T>() may only widen: a full row is a Partial<Snap>...
  const wide: Promise<Partial<Snap> | null> = Snapshots.findOne({}).lean<Partial<Snap>>().exec();
  void wide;
  // @ts-expect-error -- ...but a projected row is not a full Snap
  void Snapshots.findOne({}, { id: 1 }).lean<Snap>();
  const after: Promise<Snap | null> = Snapshots.findOneAndUpdate({ id: 'x' }, { $set: { n: 1 } }, { new: true });
  void after;
  // @ts-expect-error -- not a schema path in the update
  void Snapshots.updateOne({}, { $set: { nope: 1 } });
}
