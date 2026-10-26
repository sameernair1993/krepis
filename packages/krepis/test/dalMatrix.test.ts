import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDal, fromMongoose, op, schema, t, KrepisUnboundedReadError } from '../src/dal/index.ts';
import { URI } from './helpers.ts';

// The DAL against every driver major it claims (peer range >=4.17) plus the nightly build of the driver's main
// branch, which is the earliest signal of the next major. Then `fromMongoose` against every Mongoose major still in
// use, each of which bundles a different driver. Each copy has its own BSON, so identity is checked per driver.
const require = createRequire(import.meta.url);
const DRIVERS = ['mongodb-v4', 'mongodb-v5', 'mongodb-v6', 'mongodb-v6-latest', 'mongodb', 'mongodb-next'] as const;
const MONGOOSES = ['mongoose-v6', 'mongoose-v7', 'mongoose-v8', 'mongoose'] as const;

const items = schema(
  {
    ownerId: t.objectId(),
    name: t.string().trim(),
    qty: t.number().default(0),
    tags: t.array(t.string()).default(() => []),
  },
  { timestamps: true, indexes: [{ keys: { ownerId: 1, name: 1 }, unique: true }] },
);

interface AnyClient {
  connect(): Promise<unknown>;
  close(): Promise<void>;
  db(name: string): { dropDatabase(): Promise<unknown>; collection(n: string): any };
}
// Typed as the resolved driver's ObjectId for the DAL's signatures; at runtime each copy brings its own class.
type OidClass = new (id?: string) => import('mongodb').ObjectId;

const version = (pkg: string) => (require(`${pkg}/package.json`) as { version: string }).version;

for (const pkg of DRIVERS) {
  describe(`DAL on ${pkg} (${version(pkg)})`, () => {
    const dbName = `krepis_dalm_${pkg.replace(/\W/g, '_')}`;
    const { MongoClient, ObjectId } = require(pkg) as { MongoClient: new (u: string, o: object) => AnyClient; ObjectId: OidClass };
    const client = new MongoClient(URI, { maxPoolSize: 2 });
    const dal = createDal(client as never, { dbName, bson: { ObjectId: ObjectId as never } });
    const Items = dal.collection('items', items);
    const owner = new ObjectId();

    before(() => client.connect());
    after(() => client.close());
    beforeEach(() => client.db(dbName).dropDatabase());

    test('insert casts with this driver’s ObjectId, applies defaults and timestamps', async () => {
      const doc = await Items.insertOne({ ownerId: owner.toHexString(), name: ' a ' });
      assert.ok(doc._id instanceof ObjectId && doc.ownerId instanceof ObjectId);
      assert.equal(doc.name, 'a');
      assert.equal(doc.qty, 0);
      assert.ok(doc.createdAt instanceof Date);
      const stored = await client.db(dbName).collection('items').findOne({ _id: doc._id });
      assert.ok(stored.ownerId instanceof ObjectId);
      const many = await Items.insertMany([{ ownerId: owner, name: 'b' }, { ownerId: owner, name: 'c' }]);
      assert.equal(many.length, 2);
    });

    test('reads: find/sort/select/skip/limit/all/first/cursor, findOne, exists, count, unbounded guard', async () => {
      await Items.insertMany(['a', 'b', 'c'].map((name, i) => ({ ownerId: owner, name, qty: i })));
      assert.deepEqual((await Items.find({ ownerId: owner.toHexString() }, { sort: { qty: -1 } }).limit(2).toArray()).map((d) => d.name), ['c', 'b']);
      assert.deepEqual((await Items.find({ ownerId: owner }).sort({ qty: 1 }).skip(1).all()).map((d) => d.name), ['b', 'c']);
      const sel = await Items.find({ name: 'a' }).select({ name: 1 }).first();
      assert.equal(sel?.name, 'a');
      assert.equal((sel as Record<string, unknown>).qty, undefined);
      const seen: string[] = [];
      for await (const d of Items.find({ ownerId: owner }).sort({ qty: 1 }).limit(3).cursor()) seen.push(d.name);
      assert.deepEqual(seen, ['a', 'b', 'c']);
      assert.equal((await Items.findOne({ name: op.in(['b']) }))?.qty, 1);
      assert.equal(await Items.exists({ name: 'zzz' }), false);
      assert.equal(await Items.count({ ownerId: owner }), 3);
      await assert.rejects(Items.find({ ownerId: owner }).toArray(), KrepisUnboundedReadError);
    });

    test('updateOne/updateMany report counts; upsert inserts defaults', async () => {
      await Items.insertMany([{ ownerId: owner, name: 'a' }, { ownerId: owner, name: 'b' }]);
      const one = await Items.updateOne({ name: 'a' }, { qty: 5 });
      assert.deepEqual([one.matchedCount, one.modifiedCount, one.upsertedCount], [1, 1, 0]);
      const many = await Items.updateMany({ ownerId: owner }, { $inc: { qty: 1 } });
      assert.deepEqual([many.matchedCount, many.modifiedCount], [2, 2]);
      const up = await Items.updateOne({ ownerId: owner, name: 'new' }, { qty: 9 }, { upsert: true });
      assert.equal(up.upsertedCount, 1);
      assert.ok(up.upsertedId instanceof ObjectId);
      const created = await Items.findOne({ name: 'new' });
      assert.deepEqual([created?.qty, created?.tags], [9, []]);
    });

    test('findOneAndUpdate/findOneAndDelete return the document or null, never the driver wrapper', async () => {
      await Items.insertOne({ ownerId: owner, name: 'a', qty: 1 });
      const afterDoc = await Items.findOneAndUpdate({ name: 'a' }, { qty: 2 });
      assert.equal(afterDoc?.qty, 2);
      assert.equal((afterDoc as Record<string, unknown>).ok, undefined);
      const beforeDoc = await Items.findOneAndUpdate({ name: 'a' }, { qty: 3 }, { returnDocument: 'before' });
      assert.equal(beforeDoc?.qty, 2);
      assert.equal(await Items.findOneAndUpdate({ name: 'missing' }, { qty: 1 }), null);
      const upserted = await Items.findOneAndUpdate({ ownerId: owner, name: 'u' }, { qty: 7 }, { upsert: true });
      assert.ok(upserted?._id instanceof ObjectId);
      assert.equal(upserted?.qty, 7);
      assert.equal(await Items.findOneAndDelete({ name: 'missing' }), null);
      const deleted = await Items.findOneAndDelete({ name: 'a' });
      assert.equal(deleted?.qty, 3);
      assert.equal((deleted as Record<string, unknown>).ok, undefined);
    });

    test('deleteOne/deleteMany and bulkWrite report counts', async () => {
      await Items.insertMany(['a', 'b', 'c'].map((name) => ({ ownerId: owner, name })));
      assert.equal((await Items.deleteOne({ name: 'a' })).deletedCount, 1);
      const res = await Items.bulkWrite([
        { insertOne: { document: { ownerId: owner, name: 'd' } } },
        { updateOne: { filter: { name: 'b' }, update: { qty: 4 } } },
        { updateOne: { filter: { ownerId: owner, name: 'e' }, update: { qty: 1 }, upsert: true } },
        { deleteMany: { filter: { name: 'c' } } },
      ]);
      assert.deepEqual(
        [res.insertedCount, res.matchedCount, res.modifiedCount, res.upsertedCount, res.deletedCount],
        [1, 1, 1, 1, 1],
      );
      assert.equal((await Items.deleteMany({ ownerId: owner })).deletedCount, 3);
    });

    test('ensureIndexes creates the declared index; raw() is this driver’s collection', async () => {
      await dal.ensureIndexes();
      const names = (await Items.raw().listIndexes().toArray()).map((i: { name: string }) => i.name);
      assert.ok(names.includes('ownerId_1_name_1'), names.join(', '));
      await Items.insertOne({ ownerId: owner, name: 'x' });
      await assert.rejects(Items.insertOne({ ownerId: owner, name: 'x' }), /duplicate key|E11000/);
    });
  });
}

interface AnyMongoose {
  connect(uri: string, o: object): Promise<unknown>;
  disconnect(): Promise<void>;
  model(name: string, schema: unknown): any;
  Schema: (new (def: object, o?: object) => unknown) & { Types: { ObjectId: unknown } };
  connection: { db?: any; collections: Record<string, { deleteMany(f: object): Promise<unknown> }>; getClient(): any; dropDatabase(): Promise<unknown> };
  mongo: { ObjectId: OidClass };
  Types: { ObjectId: OidClass };
}

for (const pkg of MONGOOSES) {
  describe(`fromMongoose on ${pkg} (${version(pkg)})`, () => {
    const dbName = `krepis_dalm_${pkg.replace(/\W/g, '_')}`;
    const MongooseCtor = (require(pkg) as { Mongoose: new () => AnyMongoose }).Mongoose;
    const m = new MongooseCtor();
    const Model = m.model('Item', new m.Schema({ ownerId: m.Schema.Types.ObjectId, name: String, qty: Number }, { collection: 'items' }));
    const dal = fromMongoose(m as never);
    const Items = dal.collection('items', items);
    const Extra = dal.collection('krepis_only', items);
    const commands: string[] = [];

    before(async () => {
      await m.connect(URI, { dbName, monitorCommands: true, maxPoolSize: 2 });
      m.connection.getClient().on('commandStarted', (e: { commandName: string }) => commands.push(e.commandName));
    });
    after(() => m.disconnect());
    beforeEach(() => m.connection.dropDatabase());

    test('both libraries read each other’s writes, with one BSON', async () => {
      const owner = new m.Types.ObjectId();
      await Model.create({ ownerId: owner, name: 'from-mongoose', qty: 1 });
      const viaKrepis = await Items.findOne({ ownerId: owner.toHexString() });
      assert.equal(viaKrepis?.name, 'from-mongoose');
      assert.ok(viaKrepis?.ownerId instanceof m.mongo.ObjectId);
      const written = await Items.insertOne({ ownerId: owner, name: 'from-krepis' });
      const viaMongoose = await Model.findById(written._id).lean();
      assert.equal(viaMongoose?.name, 'from-krepis');
      assert.equal(String(viaMongoose?.ownerId), owner.toHexString());
    });

    test('one pool: Krepis commands go through Mongoose’s client', async () => {
      const n = commands.length;
      await Extra.insertOne({ ownerId: new m.Types.ObjectId(), name: 'p' });
      await Extra.findOne({ name: 'p' });
      assert.deepEqual(commands.slice(n), ['insert', 'find']);
    });

    test('a Krepis-only collection is in mongoose.connection.collections, so a clear-all teardown clears it', async () => {
      await Extra.insertOne({ ownerId: new m.Types.ObjectId(), name: 'q' });
      assert.ok('krepis_only' in m.connection.collections);
      for (const key in m.connection.collections) await m.connection.collections[key]!.deleteMany({});
      assert.equal(await Extra.count(), 0);
    });

    test('findOneAnd* through Mongoose’s bundled driver return the document or null', async () => {
      await Items.insertOne({ ownerId: new m.Types.ObjectId(), name: 'f', qty: 1 });
      assert.equal((await Items.findOneAndUpdate({ name: 'f' }, { qty: 2 }))?.qty, 2);
      assert.equal(await Items.findOneAndUpdate({ name: 'none' }, { qty: 2 }), null);
      assert.equal((await Items.findOneAndDelete({ name: 'f' }))?.qty, 2);
      assert.equal(await Items.findOneAndDelete({ name: 'f' }), null);
    });
  });
}
