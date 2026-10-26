import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import {
  createDal,
  fromMongoose,
  op,
  schema,
  t,
  KrepisUnboundedReadError,
  KrepisValidationError,
  KrepisCastError,
  type Doc,
  type Filter,
  type Insert,
  type ScopeContext,
  type TypedSchema,
} from '../src/dal/index.ts';
import { URI } from './helpers.ts';

const client = new MongoClient(URI);
const db = () => client.db('krepis_dal_test');

const notes = schema(
  {
    userId: t.objectId(),
    email: t.string().lowercase().trim(),
    key: t.string().validate((k) => /^[a-z_]+$/.test(k), 'lowercase letters and underscores only'),
    count: t.number().default(0),
    tags: t.array(t.string()).default(() => []),
    meta: t.map(t.mixed()).optional(),
    tenantId: t.string().optional(),
  },
  { timestamps: true, indexes: [{ keys: { userId: 1, key: 1 }, unique: true }] },
);

let tenant: string | undefined;
const tenantScope = (): ScopeContext | undefined =>
  tenant === undefined
    ? undefined
    : {
        filter: { tenantId: tenant },
        stamp: (doc) => {
          doc.tenantId = tenant;
        },
        update: (u) => {
          const set = u.$set as Record<string, unknown> | undefined;
          if (set) delete set.tenantId;
          return u;
        },
      };

const dal = createDal(client, { dbName: 'krepis_dal_test' });
const Notes = dal.collection('notes', notes, { scope: tenantScope });

before(() => client.connect());
after(() => client.close());
beforeEach(async () => {
  tenant = undefined;
  await db().dropDatabase();
});

const uid = new ObjectId();

test('insert casts, applies setters, defaults and timestamps, and strips unknown fields', async () => {
  const doc = await Notes.insertOne({
    userId: uid.toHexString(),
    email: '  Ada@Example.COM ',
    key: 'first_note',
    // @ts-expect-error unknown fields are a type error, and are stripped at runtime too
    junk: 1,
  });
  assert.ok(doc._id instanceof ObjectId);
  assert.ok(doc.userId instanceof ObjectId);
  assert.equal(doc.email, 'ada@example.com');
  assert.equal(doc.count, 0);
  assert.deepEqual(doc.tags, []);
  assert.ok(doc.createdAt instanceof Date && doc.updatedAt instanceof Date);
  const stored = await db().collection('notes').findOne({ _id: doc._id });
  assert.equal(stored?.junk, undefined);
  assert.ok(stored?.userId instanceof ObjectId);
});

test('insert enforces required fields, validators and casts', async () => {
  // @ts-expect-error key is required
  await assert.rejects(Notes.insertOne({ userId: uid, email: 'a@b.c' }), KrepisValidationError);
  await assert.rejects(Notes.insertOne({ userId: uid, email: 'a@b.c', key: 'Bad-Key' }), /lowercase letters/);
  await assert.rejects(Notes.insertOne({ userId: 'not-an-id', email: 'a@b.c', key: 'k' }), KrepisCastError);
});

test('filters are cast by schema, including inside operators and $or', async () => {
  await Notes.insertOne({ userId: uid, email: 'a@b.c', key: 'a' });
  assert.equal((await Notes.findOne({ userId: uid.toHexString() }))?.key, 'a');
  assert.equal((await Notes.findOne({ userId: op.in([uid.toHexString()]) }))?.key, 'a');
  assert.equal((await Notes.findOne({ $or: [{ email: ' A@B.C ' }] }))?.key, 'a');
  assert.equal(await Notes.exists({ userId: new ObjectId().toHexString() }), false);
});

test('unbounded reads throw unless limited or explicitly .all()', async () => {
  await Notes.insertMany([
    { userId: uid, email: 'a@b.c', key: 'a' },
    { userId: uid, email: 'a@b.c', key: 'b' },
  ]);
  await assert.rejects(Notes.find({ userId: uid }).toArray(), KrepisUnboundedReadError);
  assert.equal((await Notes.find({ userId: uid }).limit(1).toArray()).length, 1);
  const all = await Notes.find({ userId: uid }, { sort: { key: -1 } }).all();
  assert.deepEqual(
    all.map((d) => d.key),
    ['b', 'a'],
  );
});

test('a plain-object update is $set, never a replacement, and returns the new document', async () => {
  const { _id } = await Notes.insertOne({ userId: uid, email: 'a@b.c', key: 'a', count: 5 });
  const updated = await Notes.findOneAndUpdate({ _id: _id.toHexString() }, { key: 'b' });
  assert.equal(updated?.key, 'b');
  assert.equal(updated?.count, 5);
  assert.equal(updated?.email, 'a@b.c');
  assert.ok(updated!.updatedAt >= updated!.createdAt);
});

test('findOneAnd* return the document or null, never the driver wrapper', async () => {
  const { _id } = await Notes.insertOne({ userId: uid, email: 'a@b.c', key: 'z' });
  assert.equal(await Notes.findOneAndUpdate({ key: 'missing' }, { key: 'y' }), null);
  assert.equal(await Notes.findOneAndDelete({ key: 'missing' }), null);
  const deleted = await Notes.findOneAndDelete({ _id });
  assert.equal(deleted?.key, 'z');
  assert.equal((deleted as Record<string, unknown> | null)?.['ok'], undefined);
});

test('fromMongoose registers each collection with the Mongoose connection', () => {
  const registered: string[] = [];
  const fake = {
    connection: { db: db(), collection: (name: string) => registered.push(name) },
    mongo: { ObjectId },
  };
  fromMongoose(fake).collection('fm_notes', notes);
  assert.deepEqual(registered, ['fm_notes']);
});

test('updates are validated and cast, and unknown paths are stripped', async () => {
  const { _id } = await Notes.insertOne({ userId: uid, email: 'a@b.c', key: 'a' });
  await assert.rejects(Notes.updateOne({ _id }, { $set: { key: 'NOPE' } }), KrepisValidationError);
  await assert.rejects(Notes.updateOne({ _id }, { $set: { key: null } }), /is required/);
  await Notes.updateOne({ _id }, { $set: { email: ' X@Y.Z ', 'meta.source': 'api' } });
  await Notes.updateOne({ _id }, { $inc: { count: 2 } });
  const doc = await Notes.findOne({ _id });
  assert.equal(doc?.email, 'x@y.z');
  assert.equal(doc?.count, 2);
  assert.deepEqual(doc?.meta, { source: 'api' });
});

test('upsert inserts filter fields, defaults and createdAt', async () => {
  const doc = await Notes.findOneAndUpdate(
    { userId: uid.toHexString(), key: 'fresh' },
    { email: 'up@sert.io' },
    { upsert: true },
  );
  assert.ok(doc?.userId instanceof ObjectId);
  assert.equal(doc?.key, 'fresh');
  assert.equal(doc?.count, 0);
  assert.deepEqual(doc?.tags, []);
  assert.ok(doc?.createdAt instanceof Date);
});

test('the scope hook filters reads, stamps inserts and upserts, and sanitises updates', async () => {
  tenant = 'a';
  const a = await Notes.insertOne({ userId: uid, email: 'a@b.c', key: 'a' });
  assert.equal(a.tenantId, 'a');
  tenant = 'b';
  assert.equal(await Notes.findOne({ _id: a._id }), null);
  assert.equal((await Notes.updateMany({}, { count: 9 })).matchedCount, 0);
  const up = await Notes.findOneAndUpdate({ userId: uid, key: 'b' }, { email: 'b@b.c' }, { upsert: true });
  assert.equal(up?.tenantId, 'b');
  await Notes.updateOne({ _id: up!._id }, { $set: { tenantId: 'a' } });
  assert.equal((await Notes.findOne({ _id: up!._id }))?.tenantId, 'b');
  tenant = undefined;
  assert.equal(await Notes.count(), 2);
});

test('bulkWrite gets the same casting, timestamps, defaults and scope', async () => {
  tenant = 't';
  await Notes.bulkWrite([
    { insertOne: { document: { userId: uid.toHexString(), email: 'a@b.c', key: 'a' } } },
    { updateOne: { filter: { userId: uid.toHexString(), key: 'b' }, update: { $inc: { count: 1 } }, upsert: true } },
  ]);
  const docs = await Notes.find({}, { sort: { key: 1 } }).all();
  assert.equal(docs.length, 2);
  assert.ok(docs.every((d) => d.tenantId === 't' && d.updatedAt instanceof Date));
  assert.equal(docs[1]?.count, 1);
  assert.deepEqual(docs[1]?.tags, []);
});

test('ensureIndexes creates declared indexes explicitly', async () => {
  await dal.ensureIndexes();
  await Notes.insertOne({ userId: uid, email: 'a@b.c', key: 'a' });
  await assert.rejects(Notes.insertOne({ userId: uid, email: 'a@b.c', key: 'a' }), /E11000/);
});

test('types are inferred from the schema', () => {
  type Note = Doc<typeof notes>;
  const check = (n: Note) => {
    const id: ObjectId = n.userId;
    const count: number = n.count;
    const created: Date = n.createdAt;
    // @ts-expect-error meta is optional
    const meta: Record<string, unknown> = n.meta;
    return [id, count, created, meta];
  };
  // Compile-time only: never called.
  const typeOnly = () => [
    // @ts-expect-error count is a number
    Notes.findOne({ count: 'many' }),
    // @ts-expect-error no such field
    Notes.findOne({ nope: 1 }),
    Notes.findOne({ 'meta.source': 'api', userId: uid.toHexString() }),
  ];
  assert.equal(typeof check, 'function');
  assert.equal(typeof typeOnly, 'function');
});

test('Filter on a union-typed field accepts operators that span the union', () => {
  // Found by typechecking the GrowthBook port: `status: { $in: ['success', 'error'] }` was rejected because
  // Condition distributed over the union. Optional arrays must keep their element-level conditions.
  type Run = { _id: ObjectId; status: 'running' | 'success' | 'error'; tags?: string[]; n?: number | null };
  const ok: Filter<Run>[] = [
    { status: { $in: ['success', 'error'] } },
    { status: { $nin: ['running', 'error'] }, n: null },
    { tags: 'a' },
    { tags: { $all: ['a', 'b'] } },
    { tags: { $in: ['a', 'b'] } },
    { n: { $gte: 1, $lt: 5 } },
  ];
  // @ts-expect-error not a member of the union
  const bad: Filter<Run> = { status: { $in: ['success', 'nope'] } };
  // @ts-expect-error tags holds strings
  const badTag: Filter<Run> = { tags: { $all: [1] } };
  assert.ok(ok.length === 6 && bad && badTag);
});

interface NoteEntity {
  _id: ObjectId;
  userId: ObjectId;
  email: string;
  key: string;
  count: number;
  tags: string[];
  meta?: Record<string, unknown>;
  tenantId?: string;
  createdAt: Date;
  updatedAt: Date;
}

test("TypedSchema: an explicit interface annotation must match the schema exactly", () => {
  // Compiles: interface and schema agree; defaulted fields are optional on insert.
  const typed: TypedSchema<NoteEntity, "count" | "tags"> = notes;
  const insert: Insert<typeof typed> = { userId: new ObjectId(), email: "a@b.c", key: "k" };
  const doc: Doc<typeof typed> = {} as NoteEntity;
  // @ts-expect-error interface declares a field the schema lacks
  const extra: TypedSchema<NoteEntity & { missing: string }, "count" | "tags"> = notes;
  // @ts-expect-error schema has a field (tenantId) the interface omits
  const fewer: TypedSchema<Omit<NoteEntity, "tenantId">, "count" | "tags"> = notes;
  // @ts-expect-error field type disagrees
  const wrong: TypedSchema<Omit<NoteEntity, "count"> & { count: string }, "count" | "tags"> = notes;
  // @ts-expect-error a defaulted field not listed in Defaults would be required on insert
  const undeclared: TypedSchema<NoteEntity, "count"> = notes;
  assert.ok(typed && insert && doc && extra && fewer && wrong && undeclared);
});

test('DAL errors satisfy instanceof across separate copies of the module', async () => {
  // The package ships ESM and CJS builds, so one app can load two copies of the
  // DAL. A query string makes Node load a genuinely separate module instance.
  const self = await import('../src/dal/schema.ts');
  const second = (path: string) => import(`${path}?second-copy`);
  const other: typeof self = await second('../src/dal/schema.ts');
  const otherCollection: typeof import('../src/dal/collection.ts') = await second('../src/dal/collection.ts');
  assert.notEqual(self.KrepisCastError, other.KrepisCastError);
  const cast = new other.KrepisCastError('n', 'number', 'x');
  const invalid = new other.KrepisValidationError([{ path: 'n', message: 'bad' }]);
  const unbounded = new otherCollection.KrepisUnboundedReadError('notes');
  assert.ok(cast instanceof self.KrepisCastError && cast instanceof Error);
  assert.ok(invalid instanceof self.KrepisValidationError);
  assert.ok(unbounded instanceof KrepisUnboundedReadError);
  // The brand is per class, not shared: a cast error is not a validation error.
  assert.ok(!(cast instanceof self.KrepisValidationError));
  assert.ok(!(new Error('plain') instanceof self.KrepisCastError));
  assert.ok(!Object.keys(cast).some((k) => k.includes('brand')) && !JSON.stringify(cast).includes('krepis.dal'));
});
