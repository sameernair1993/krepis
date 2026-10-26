import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Long, MongoClient, type CommandStartedEvent, type Db } from 'mongodb';
import { observe, type Observer, type OptimizeMismatch } from '../src/index.ts';
import { contextStorage } from '../src/context.ts';
import { repeatableKey } from '../src/optimize.ts';
import { URI, seed, type Seed } from './helpers.ts';

let client: MongoClient;
let db: Db;
let safe: Observer;
let data: Seed;
const wire: CommandStartedEvent[] = [];

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10, monitorCommands: true });
  safe = observe(client, { optimize: 'safe' });
  client.on('commandStarted', (e) => wire.push(e));
  await client.connect();
  db = client.db('krepis_opt');
  data = await seed(db);
});

after(async () => {
  safe.detach();
  await client.close();
});

const users = () => db.collection('users');
const orders = () => db.collection('orders');

async function measure<T>(obs: Observer, fn: () => Promise<T>) {
  const w = wire.length;
  const f = obs.findings.length;
  const result = await obs.run('test', fn);
  const reads = wire.slice(w).filter((e) => e.commandName === 'find' || e.commandName === 'aggregate');
  return { result, reads, findings: obs.findings.slice(f) };
}

/** Runs fn with no Krepis context, as another process (or an unobserved code path) would. */
const outside = <T>(fn: () => Promise<T>) => contextStorage.exit(fn);

test('D1 identical find twice: 1 read on the wire, equal documents, separate objects', async () => {
  const q = () => orders().find({ status: 'paid' }).sort({ n: 1 }).toArray();
  const { result, reads } = await measure(safe, async () => [await q(), await q()] as const);
  assert.equal(reads.length, 1);
  assert.deepEqual(result[0], result[1]);
  assert.notEqual(result[0][0], result[1][0]);
  assert.deepEqual(result[0], await q());
});

test('D2 a write to the same collection invalidates; a write elsewhere does not; aggregates drop on any write', async () => {
  const q = () => orders().find({ status: 'open' }).toArray();
  const same = await measure(safe, async () => {
    await q();
    await orders().updateOne({ n: 0 }, { $set: { touched: true } });
    return q();
  });
  assert.equal(same.reads.length, 2);
  assert.equal(same.result.find((o) => o.n === 0)?.touched, true, 'the second read sees the write');

  const other = await measure(safe, async () => {
    await q();
    await db.collection('scratch').insertOne({ x: 1 });
    await q();
  });
  assert.equal(other.reads.length, 1);

  const agg = () => orders().aggregate([{ $match: { n: { $lt: 3 } } }, { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } }]).toArray();
  const joined = await measure(safe, async () => {
    await agg();
    await users().updateOne({ _id: data.users[0]!._id }, { $set: { joined: 1 } });
    return agg();
  });
  assert.equal(joined.reads.length, 2, 'a write to a $lookup source invalidates the aggregate');
  assert.equal(joined.result.find((o) => o.n === 0)?.u[0]?.joined, 1);
});

test('D3 nondeterministic and writing stages are never deduplicated', async () => {
  const { reads } = await measure(safe, async () => {
    for (let i = 0; i < 2; i++) await orders().aggregate([{ $sample: { size: 3 } }]).toArray();
    for (let i = 0; i < 2; i++) await orders().find({ $expr: { $lt: [{ $rand: {} }, 2] } }).toArray();
  });
  assert.equal(reads.length, 4);
  assert.equal(repeatableKey({ aggregate: 'c', pipeline: [{ $addFields: { t: '$$NOW' } }] }), undefined);
  assert.equal(repeatableKey({ aggregate: 'c', pipeline: [{ $merge: { into: 'x' } }] }), undefined);
});

test('D4 an open cursor is not cached', async () => {
  const q = () => orders().find({}).batchSize(2).toArray();
  const { reads, result } = await measure(safe, async () => [await q(), await q()] as const);
  assert.equal(reads.length, 2);
  assert.equal(result[1].length, 30);
});

test('D5 concurrent identical reads share one round trip', async () => {
  const { reads, result } = await measure(safe, () => Promise.all(Array.from({ length: 5 }, () => users().find({ tenant: 't1' }).toArray())));
  assert.equal(reads.length, 1);
  for (const r of result) assert.equal(r.length, 10);
});

test('D6 explicit sessions are not deduplicated', async () => {
  const { reads } = await measure(safe, () => client.withSession(async (session) => {
    await users().find({ tenant: 't1' }, { session }).toArray();
    await users().find({ tenant: 't1' }, { session }).toArray();
  }));
  assert.equal(reads.length, 2);
});

test('D7 entries expire after maxAgeMs', async () => {
  const short = observe(client, { optimize: { dedupeReads: true, maxAgeMs: 20 } });
  try {
    const { reads } = await measure(short, async () => {
      await users().find({ tenant: 't1' }).toArray();
      await sleep(40);
      await users().find({ tenant: 't1' }).toArray();
    });
    assert.equal(reads.length, 2);
  } finally {
    short.detach();
  }
});

test('D8 keys are exact: Longs past 2^53 and sort order are not conflated', async () => {
  const big = Long.fromString('9007199254740992');
  const big1 = Long.fromString('9007199254740993');
  await db.collection('longs').insertMany([{ k: big, v: 'a' }, { k: big1, v: 'b' }]);
  const { reads, result } = await measure(safe, async () => [
    await db.collection('longs').find({ k: big }).toArray(),
    await db.collection('longs').find({ k: big1 }).toArray(),
    await orders().find({}).sort({ status: 1, n: -1 }).limit(3).toArray(),
    await orders().find({}).sort({ n: -1, status: 1 }).limit(3).toArray(),
  ] as const);
  assert.equal(reads.length, 4);
  assert.equal(result[0][0]?.v, 'a');
  assert.equal(result[1][0]?.v, 'b');
  assert.notDeepEqual(result[2], result[3]);
});

test('D9 a repeated query is still reported (served reads are recorded)', async () => {
  const id = data.users[3]!._id;
  const { reads, findings } = await measure(safe, async () => {
    for (let i = 0; i < 4; i++) await users().findOne({ _id: id });
  });
  assert.equal(reads.length, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.queries, 4);
  assert.equal(findings[0]!.distinctKeys, 1);
});

test('D10 off by default; stats are counted', async () => {
  const plain = observe(client);
  try {
    const { reads } = await measure(plain, async () => {
      await users().find({ tenant: 't1' }).toArray();
      await users().find({ tenant: 't1' }).toArray();
    });
    assert.equal(reads.length, 2);
  } finally {
    plain.detach();
  }
  assert.ok(safe.optimizeStats.deduped > 0);
});

test('V1 verify: 1 sends every optimised read to the server, returns the same documents, no mismatches', async () => {
  const mismatches: OptimizeMismatch[] = [];
  const v = observe(client, { optimize: { batchLookups: true, dedupeReads: true, verify: 1, onMismatch: (m) => mismatches.push(m) } });
  try {
    const run = async () => {
      const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
      const out = [];
      for (const o of list) out.push(await users().findOne({ _id: o.userId }));
      out.push(await orders().find({}).sort({ n: 1 }).limit(10).toArray());
      return out;
    };
    const plainResult = await run();
    const { reads, result } = await measure(v, run);
    assert.deepEqual(result, plainResult);
    assert.equal(reads.length, 13, 'parent + 10 lookups + 1 prefetch + repeated parent');
    assert.equal(v.optimizeStats.verified, 10, '9 batch answers + 1 dedupe answer');
    assert.equal(v.optimizeStats.mismatches, 0);
    assert.equal(mismatches.length, 0);
  } finally {
    v.detach();
  }
});

test('V2 verify catches a write from outside the request and returns the server answer', async () => {
  const target = data.users[7]!._id;
  const scenario = async () => {
    const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
    await users().findOne({ _id: list[0]!.userId });
    await users().findOne({ _id: list[1]!.userId }); // prefetch: user7 is now held
    await outside(() => users().updateOne({ _id: target }, { $set: { name: 'elsewhere' } }));
    return users().findOne({ _id: target });
  };
  const mismatches: OptimizeMismatch[] = [];
  const v = observe(client, { optimize: { batchLookups: true, verify: 1, onMismatch: (m) => mismatches.push(m) } });
  const nv = observe(client, { optimize: { batchLookups: true } });
  try {
    const fresh = await v.run('v', scenario);
    assert.equal(fresh?.name, 'elsewhere', 'verify returns the server answer');
    assert.equal(v.optimizeStats.mismatches, 1);
    assert.deepEqual(mismatches, [{ kind: 'batchLookups', verdict: 'stale', namespace: 'krepis_opt.users' }]);
    assert.equal(v.optimizeStats.stale, 1, 'the snapshot at the prefetch time holds exactly what was served');
    assert.equal(v.optimizeStats.unexplained, 0);

    await users().updateOne({ _id: target }, { $set: { name: 'user7' } });
    const stale = await nv.run('nv', scenario);
    assert.equal(stale?.name, 'user7', 'without verify the prefetched (pre-write) value is served: the documented staleness');
  } finally {
    v.detach();
    nv.detach();
    await users().updateOne({ _id: target }, { $set: { name: 'user7' } });
  }
});

test('O1 several observers on one client: each context is recorded once, by its own observer', async () => {
  const other = observe(client);
  try {
    const f = other.findings.length;
    await other.run('O1', async () => {
      const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
      for (const o of list) await users().findOne({ _id: o.userId });
    });
    const found = other.findings.slice(f);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.queries, 10, 'not 20: the always-attached `safe` observer must not record into this context');
  } finally {
    other.detach();
  }
});

// ---- freshness gate and verify verdicts ----

const usersFinds = (from: number) => wire.slice(from).filter((e) => e.commandName === 'find' && e.command.find === 'users').length;

/** Loop that leaves user7 held by a prefetch, then a write lands from outside the request, then `between` runs. */
async function heldThenWritten(obs: Observer, between: () => Promise<unknown>) {
  const target = data.users[7]!._id;
  const w = wire.length;
  try {
    const name = await obs.run('fresh', async () => {
      const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
      await users().findOne({ _id: list[0]!.userId });
      await users().findOne({ _id: list[1]!.userId });
      await outside(() => users().updateOne({ _id: target }, { $set: { name: 'elsewhere' } }));
      await between();
      return (await users().findOne({ _id: target }))?.name;
    });
    return { name, usersFinds: usersFinds(w) };
  } finally {
    await outside(() => users().updateOne({ _id: target }, { $set: { name: 'user7' } }));
  }
}

test('G1 freshness gate: once the request has seen a newer version of a document, the older one is never served', async () => {
  const nv = observe(client, { optimize: { batchLookups: true } });
  try {
    const r = await heldThenWritten(nv, () => users().findOne({ name: 'elsewhere' }));
    assert.equal(r.name, 'elsewhere', 'the request saw user7 renamed, so user7 comes from the server');
    assert.equal(r.usersFinds, 4, 'u0, prefetch, the name read, user7');
  } finally {
    nv.detach();
  }
});

test('G1b a newer read whose documents agree with what is held retires nothing (writes elsewhere in the cluster are not evidence)', async () => {
  const nv = observe(client, { optimize: { batchLookups: true } });
  try {
    const r = await heldThenWritten(nv, () => users().findOne({ name: 'user5' }));
    assert.equal(r.name, 'user7', 'held answer kept: the request has seen nothing that contradicts it');
    assert.equal(r.usersFinds, 3, 'u0, prefetch, the name read');
  } finally {
    nv.detach();
  }
});

test('G2 a newer read of another collection does not retire them (the semantics of the hand-written $in fix)', async () => {
  const nv = observe(client, { optimize: { batchLookups: true } });
  try {
    const r = await heldThenWritten(nv, () => orders().findOne({ n: 5 }));
    assert.equal(r.name, 'user7');
    assert.equal(r.usersFinds, 2, 'u0 and the prefetch only');
  } finally {
    nv.detach();
  }
});

test('G3 dedupe: a newer read that the cached result cannot account for retires it; another collection does not', async () => {
  const xReads = (from: number) => wire.slice(from).filter((e) => e.commandName === 'find' && (e.command.filter as { status?: string })?.status === 'paid').length;
  const scenario = (between: () => Promise<unknown>) => async () => {
    await orders().find({ status: 'paid' }).sort({ n: 1 }).toArray();
    await outside(() => db.collection('elsewhere').insertOne({ at: Date.now() }));
    await between();
    await orders().find({ status: 'paid' }).sort({ n: 1 }).toArray();
  };
  let w = wire.length;
  await safe.run('g3a', scenario(() => orders().findOne({ status: { $ne: 'paid' } })));
  assert.equal(xReads(w), 2, 'a document the cached set does not contain may be a new match: retire');
  w = wire.length;
  await safe.run('g3b', scenario(() => users().findOne({ name: 'user5' })));
  assert.equal(xReads(w), 1, 'another collection');
  w = wire.length;
  await safe.run('g3c', scenario(() => orders().findOne({ status: 'paid' }, { sort: { n: 1 } })));
  assert.equal(xReads(w), 2, 'X, then the findOne (same filter, agrees with the cached set); X again is served');
});

test('G4 nothing outlives the request: a write acknowledged before it starts is always seen', async () => {
  const target = data.users[7]!._id;
  try {
    await users().updateOne({ _id: target }, { $set: { name: 'before' } });
    const names = await safe.run('g4', async () => {
      const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
      const out = [];
      for (const o of list) out.push((await users().findOne({ _id: o.userId }))?.name);
      return out;
    });
    assert.ok(names.includes('before'));
  } finally {
    await users().updateOne({ _id: target }, { $set: { name: 'user7' } });
  }
});

test('G6 verify: an answer the server never held is "unexplained"', async () => {
  const mismatches: OptimizeMismatch[] = [];
  const v = observe(client, { optimize: { dedupeReads: true, verify: 1, onMismatch: (m) => mismatches.push(m) } });
  try {
    await v.run('g6', async () => {
      await orders().find({ status: 'paid' }).sort({ n: 1 }).toArray();
      // Test seam: corrupt the cached reply, standing in for a Krepis bug.
      const reads = (contextStorage.getStore()!.optimizer as unknown as { reads: Map<string, { reply: Promise<{ bytes: Uint8Array }> }> }).reads;
      const cached = await [...reads.values()][0]!.reply;
      cached.bytes[Buffer.from(cached.bytes).indexOf('paid')] = 'P'.charCodeAt(0);
      const served = await orders().find({ status: 'paid' }).sort({ n: 1 }).toArray();
      assert.ok(served.every((o) => o.status === 'paid'), 'verify returns the server answer, not the corrupt one');
    });
    assert.deepEqual(mismatches, [{ kind: 'dedupeReads', verdict: 'unexplained', namespace: 'krepis_opt.orders' }]);
    assert.equal(v.optimizeStats.unexplained, 1);
  } finally {
    v.detach();
  }
});

test('G7 verify: the same documents in another order are "reordered", not a mismatch to worry about', async () => {
  const mismatches: OptimizeMismatch[] = [];
  const v = observe(client, { optimize: { dedupeReads: true, verify: 1, onMismatch: (m) => mismatches.push(m) } });
  const c = db.collection<{ _id: number; v: string }>('reorder');
  try {
    await c.deleteMany({});
    await c.insertMany([{ _id: 1, v: 'a' }, { _id: 2, v: 'b' }, { _id: 3, v: 'c' }]);
    const [first, second] = await v.run('g7', async () => {
      const a = await c.find({}).toArray();
      await outside(async () => {
        await c.deleteOne({ _id: 1 });
        await c.insertOne({ _id: 1, v: 'a' });
      });
      return [a, await c.find({}).toArray()];
    });
    assert.deepEqual(first!.map((d) => d._id), [1, 2, 3]);
    assert.deepEqual(second!.map((d) => d._id), [2, 3, 1], 'reinserting moves the document to the end of natural order');
    assert.deepEqual(mismatches, [{ kind: 'dedupeReads', verdict: 'reordered', namespace: 'krepis_opt.reorder' }]);
  } finally {
    v.detach();
  }
});

test('G5 answers Krepis serves itself are not evidence: served lookups do not retire a cached read of the same collection', async () => {
  const xReads = (from: number) => wire.slice(from).filter((e) => e.commandName === 'find' && (e.command.filter as { name?: string })?.name === 'user5').length;
  const w = wire.length;
  await safe.run('g5', async () => {
    const list = await orders().find({}).sort({ n: 1 }).limit(10).toArray();
    await users().findOne({ _id: list[0]!.userId });
    await users().findOne({ _id: list[1]!.userId }); // prefetch: users 2..9 held
    await users().find({ name: 'user5' }).toArray(); // cached; agrees with the held user5
    for (const o of list.slice(2)) await users().findOne({ _id: o.userId }); // served: documents the cached set lacks
    await users().find({ name: 'user5' }).toArray();
  });
  assert.equal(xReads(w), 1);
});
