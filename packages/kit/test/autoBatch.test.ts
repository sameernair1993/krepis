import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BSON, MongoClient, ObjectId, type CommandStartedEvent, type Db } from 'mongodb';
import mongoose from 'mongoose';
import { observe, type NPlusOneFinding, type Observer } from '../src/index.ts';
import { cursorReplyBytes, PREFETCH_COMMENT } from '../src/optimize.ts';
import { URI, seed, type Seed } from './helpers.ts';

let client: MongoClient;
let db: Db;
let on: Observer;
let data: Seed;
const wire: CommandStartedEvent[] = [];

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10, monitorCommands: true });
  on = observe(client, { autoBatch: true });
  client.on('commandStarted', (e) => wire.push(e));
  await client.connect();
  db = client.db('krepis_ab');
  data = await seed(db);
});

after(async () => {
  on.detach();
  await client.close();
});

const users = () => db.collection('users');
const orders = () => db.collection('orders');

/** Runs fn in a context of `obs` and returns its result, the finds sent on the wire, and the findings. */
async function measure<T>(obs: Observer, fn: () => Promise<T>) {
  const w = wire.length;
  const f = obs.findings.length;
  const result = await obs.run('test', fn);
  const sent = wire.slice(w).filter((e) => e.commandName === 'find' || e.commandName === 'killCursors');
  return { result, sent, findings: obs.findings.slice(f) as NPlusOneFinding[] };
}

const serialLoop = async () => {
  const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
  const out = [];
  for (const o of list) out.push(await users().findOne({ _id: o.userId }));
  return out;
};

test('A1 serial loop: 11 finds -> 3 on the wire, same documents', async () => {
  const unbatched = await serialLoop();
  const { result, sent, findings } = await measure(on, serialLoop);
  assert.equal(sent.length, 3, sent.map((e) => JSON.stringify(e.command.filter)).join('\n'));
  assert.equal(sent[2]!.command.comment, PREFETCH_COMMENT);
  assert.deepEqual(result, unbatched);
  assert.equal(findings.length, 1, 'the N+1 is still reported');
  assert.equal(findings[0]!.queries, 10);
  assert.deepEqual(findings[0]!.autoBatched, { served: 9, roundTrips: 2 });
  assert.equal(findings[0]!.parent?.field, 'userId', 'the prefetch is not mistaken for the parent');
});

test('A2 Promise.all: 3 finds on the wire, same documents', async () => {
  const run = async () => {
    const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
    return Promise.all(list.map((o) => users().findOne({ _id: o.userId })));
  };
  const unbatched = await run();
  const { result, sent } = await measure(on, run);
  assert.equal(sent.length, 3, `${sent.length} finds`);
  assert.deepEqual(result, unbatched);
});

test('A3 a write in the context invalidates: the updated value is read', async () => {
  const target = data.users[5]!._id;
  try {
    const { result, sent } = await measure(on, async () => {
      const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
      for (const o of list.slice(0, 3)) await users().findOne({ _id: o.userId }); // prefetch happens here
      await users().updateOne({ _id: target }, { $set: { name: 'changed' } });
      return users().findOne({ _id: target });
    });
    assert.equal(result?.name, 'changed');
    assert.equal(sent.at(-1)!.command.comment, undefined, 'the post-write lookup went to the server');
  } finally {
    await users().updateOne({ _id: target }, { $set: { name: 'user5' } });
  }
});

test('A3b a write to another collection does not invalidate', async () => {
  const { sent } = await measure(on, async () => {
    const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
    for (const o of list.slice(0, 3)) await users().findOne({ _id: o.userId });
    await db.collection('scratch').insertOne({ at: 1 });
    for (const o of list.slice(3)) await users().findOne({ _id: o.userId });
  });
  assert.equal(sent.length, 3);
});

test('A4 a served document is a fresh object each time', async () => {
  const id = data.users[4]!._id;
  const { result } = await measure(on, async () => {
    const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
    await users().findOne({ _id: list[0]!.userId });
    await users().findOne({ _id: list[1]!.userId });
    const a = await users().findOne({ _id: id });
    a!.name = 'mutated';
    const b = await users().findOne({ _id: id });
    return { a, b };
  });
  assert.notEqual(result.a, result.b);
  assert.equal(result.b?.name, 'user4');
});

test('A5 a missing ObjectId reads null, without a round trip', async () => {
  const missing = new ObjectId();
  const refs = [data.users[0]!._id, data.users[1]!._id, missing, data.users[2]!._id].map((uid, i) => ({ i, uid }));
  await db.collection('refs').insertMany(refs);
  const run = async () => {
    const list = await db.collection('refs').find({}).sort({ i: 1 }).toArray();
    const out = [];
    for (const r of list) out.push(await users().findOne({ _id: r.uid }));
    return out;
  };
  const unbatched = await run();
  const { result, sent } = await measure(on, run);
  assert.equal(result[2], null);
  assert.deepEqual(result, unbatched);
  assert.equal(sent.length, 3, 'refs, lookup 1, prefetch');
});

test('A6 projections and numeric/string ids are answered like the server answers them', async () => {
  await db.collection('nums').insertMany([{ _id: 1, v: 'int' }, { _id: 2.5, v: 'double' }, { _id: 3, v: 'three' }] as never[]);
  await db.collection('nrefs').insertMany([{ k: 1 }, { k: 2.5 }, { k: 3 }, { k: 4 }]);
  const run = async () => {
    const list = await db.collection('nrefs').find({}).toArray();
    const out = [];
    for (const r of list) out.push(await db.collection('nums').findOne({ _id: r.k }, { projection: { v: 1 } }));
    const tagRun = [];
    const post = await db.collection('posts').findOne({ _id: 'p1' as never });
    for (const t of (post!.tagIds as string[])) tagRun.push(await db.collection('tags').findOne({ _id: t as never }));
    return { out, tagRun };
  };
  const unbatched = await run();
  const { result, sent } = await measure(on, run);
  assert.deepEqual(result, unbatched);
  assert.equal(result.out[3], null);
  // nrefs, nums#1, nums prefetch (2.5, 3, 4 served; 4 as a cached miss), posts, tags#1, tags prefetch: 6, not 9.
  assert.equal(sent.length, 6, sent.map((e) => JSON.stringify(e.command.filter)).join('\n'));
});

test('A7 default off: every lookup goes to the server', async () => {
  const off = observe(client);
  try {
    const { sent, findings } = await measure(off, serialLoop);
    assert.equal(sent.length, 11);
    assert.equal(findings[0]?.autoBatched, undefined);
  } finally {
    off.detach();
  }
});

test('A8 a projection excluding _id is not batched', async () => {
  const { sent } = await measure(on, async () => {
    const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
    for (const o of list) await users().findOne({ _id: o.userId }, { projection: { _id: 0, name: 1 } });
  });
  assert.equal(sent.length, 11);
});

test('A9 an explicit session is not batched', async () => {
  const { sent } = await measure(on, () => client.withSession(async (session) => {
    const list = await orders().find({}, { session }).sort({ n: 1 }).limit(10).toArray();
    for (const o of list) await users().findOne({ _id: o.userId }, { session });
  }));
  assert.equal(sent.length, 11);
});

test('A10 Mongoose findById loop: same hydrated documents, fewer round trips', async () => {
  const m = await mongoose.createConnection(URI, { dbName: 'krepis_ab', monitorCommands: true }).asPromise();
  const mObs = observe(m.getClient() as never, { autoBatch: true });
  const mWire: CommandStartedEvent[] = [];
  m.getClient().on('commandStarted', (e: CommandStartedEvent) => mWire.push(e));
  try {
    const Order = m.model('Order', new mongoose.Schema({ userId: mongoose.Schema.Types.ObjectId, n: Number }), 'orders');
    const User = m.model('User', new mongoose.Schema({ name: String, tenant: String }), 'users');
    const run = async () => {
      const list = await Order.find({}).sort({ n: 1 }).limit(10);
      const out = [];
      for (const o of list) out.push((await User.findById(o.userId))?.toObject());
      return out;
    };
    const unbatched = await run();
    const before = mWire.length;
    const result = await mObs.run('mongoose', run);
    const finds = mWire.slice(before).filter((e) => e.commandName === 'find');
    assert.deepEqual(result, unbatched);
    assert.equal(finds.length, 3, finds.map((e) => JSON.stringify(e.command)).join('\n'));
  } finally {
    mObs.detach();
    await m.close();
  }
});

test('A11 cursorReplyBytes is a valid exhausted find reply', () => {
  const doc = BSON.serialize({ _id: 7, a: 'x' });
  const found = BSON.deserialize(cursorReplyBytes('db.c', doc));
  assert.deepEqual(found, { cursor: { firstBatch: [{ _id: 7, a: 'x' }], id: 0, ns: 'db.c' }, ok: 1 });
  const empty = BSON.deserialize(cursorReplyBytes('db.c', null));
  assert.deepEqual(empty, { cursor: { firstBatch: [], id: 0, ns: 'db.c' }, ok: 1 });
});
