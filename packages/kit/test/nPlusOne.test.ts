import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import mongoose from 'mongoose';
import { formatNPlusOne, formatRepeatedLookup, lookupKeys, observe, pointLookup, type Finding, type NPlusOneFinding, type Observer } from '../src/index.ts';
import { URI, seed, type Seed } from './helpers.ts';
import { getAwaiting, getNested, getReturning } from './dataLayer.ts';

let client: MongoClient;
let db: Db;
let obs: Observer;
let data: Seed;

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10 });
  obs = observe(client);
  await client.connect();
  db = client.db('krepis_test');
  data = await seed(db);
});

after(async () => {
  obs.detach();
  await client.close();
});

const users = () => db.collection('users');
const orders = () => db.collection('orders');

async function findingsOf(label: string, fn: () => Promise<unknown>) {
  const start = obs.findings.length;
  await obs.run(label, fn);
  return obs.findings.slice(start);
}

function nPlusOne(f: Finding | undefined): NPlusOneFinding {
  assert.equal(f?.rule, 'KR-P002', JSON.stringify(f));
  return f as NPlusOneFinding;
}

test('F1 serial loop: strong, parent field userId, 10 queries, 10 distinct, serial', async () => {
  const f = await findingsOf('F1', async () => {
    const list = await orders().find({ status: 'paid' }).limit(10).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
  });
  assert.equal(f.length, 1);
  const x = f[0]!;
  assert.equal(x.confidence, 'strong');
  assert.equal(x.parent?.field, 'userId');
  assert.equal(x.parent?.namespace, 'krepis_test.orders');
  assert.equal(x.queries, 10);
  assert.equal(x.distinctKeys, new Set((await orders().find({ status: 'paid' }).limit(10).toArray()).map((o) => String(o.userId))).size);
  assert.equal(x.execution, 'serial');
  assert.equal(x.peakConcurrency, 1);
  assert.deepEqual(x.lookupFields, ['_id']);
});

test('F2 parallel Promise.all: strong, parallel, peak > 1', async () => {
  const f = await findingsOf('F2', async () => {
    const list = await orders().find({}).limit(10).toArray();
    await Promise.all(list.map((o) => users().findOne({ _id: o.userId })));
  });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.execution, 'parallel');
  assert.ok(f[0]!.peakConcurrency > 1, `peak ${f[0]!.peakConcurrency}`);
});

test('F3 batched $in: no finding', async () => {
  const f = await findingsOf('F3', async () => {
    const list = await orders().find({}).limit(10).toArray();
    await users().find({ _id: { $in: list.map((o) => o.userId) } }).toArray();
  });
  assert.equal(f.length, 0);
});

test('F4 one lookup in each of several contexts: no finding', async () => {
  let total = 0;
  for (const u of data.users.slice(0, 5)) total += (await findingsOf('F4', () => users().findOne({ _id: u._id }))).length;
  assert.equal(total, 0);
});

test('F5 N=2 with parent containment: reported (small local data)', async () => {
  const f = await findingsOf('F5', async () => {
    const list = await orders().find({}).limit(2).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
  });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.confidence, 'strong');
});

test('F6 N=2 with no parent: not reported', async () => {
  const f = await findingsOf('F6', async () => {
    await users().findOne({ _id: data.users[0]!._id });
    await users().findOne({ _id: data.users[1]!._id });
  });
  assert.equal(f.length, 0);
});

test('F7 identical query repeated 4 times, no parent: a repeated lookup (KR-P012), not N+1', async () => {
  const f = await findingsOf('F7', async () => {
    for (let i = 0; i < 4; i++) await users().findOne({ _id: data.users[3]!._id });
  });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.rule, 'KR-P012');
  assert.equal(f[0]!.severity, 'info');
  assert.equal(f[0]!.confidence, undefined);
  assert.equal(f[0]!.distinctKeys, 1);
  assert.match(formatRepeatedLookup(f[0] as never), /not reported as N\+1/);
});

test('F20 parent returned exactly N documents but supplies none of the values: not N+1', async () => {
  const f = await findingsOf('F20', async () => {
    const list = await orders().find({}).limit(3).toArray();
    const unrelated = data.users.filter((u) => !list.some((o) => o.userId.equals(u._id))).slice(0, 3);
    for (const u of unrelated) await users().findOne({ _id: u._id });
  });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.rule, 'KR-P012');
});

test('F21 derived key with a constant prefix (user:<id>): KR-P002, derived, parent field _id', async () => {
  const f = await findingsOf('F21', async () => {
    const list = await users().find({}).limit(4).toArray();
    for (const u of list) await db.collection('objects').findOne({ _key: `user:${u._id.toHexString()}` });
  });
  assert.equal(f.length, 1);
  const x = nPlusOne(f[0]);
  assert.equal(x.confidence, 'derived');
  assert.equal(x.parent.field, '_id');
  assert.deepEqual(x.lookupFields, ['_key']);
  assert.match(formatNPlusOne(x), /key built from a value of its `_id` field/);
});

test('F22 derived key from a delimited parent value (Tag$tag0 -> tag0): KR-P002, derived', async () => {
  await db.collection('ptrs').insertMany([{ _p_tag: 'Tag$tag0' }, { _p_tag: 'Tag$tag1' }, { _p_tag: 'Tag$tag3' }]);
  const f = await findingsOf('F22', async () => {
    const list = await db.collection<{ _p_tag: string }>('ptrs').find({}).toArray();
    for (const p of list) await db.collection<{ _id: string }>('tags').findOne({ _id: p._p_tag.split('$')[1]! });
  });
  assert.equal(f.length, 1);
  const x = nPlusOne(f[0]);
  assert.equal(x.confidence, 'derived');
  assert.equal(x.parent.field, '_p_tag');
});

test('F23 derived-key guards: two lookups, one distinct value, or tokens no parent holds are not N+1', async () => {
  const list = await users().find({}).limit(4).toArray();
  const two = await findingsOf('F23a', async () => {
    const l = await users().find({}).limit(2).toArray();
    for (const u of l) await db.collection('objects').findOne({ _key: `user:${u._id.toHexString()}` });
  });
  assert.equal(two.length, 0, 'derived needs 3 lookups');
  const same = await findingsOf('F23b', async () => {
    await users().find({}).limit(4).toArray();
    // The hex string of a parent ObjectId: matches only loosely, and only one value, so no derived link.
    for (let i = 0; i < 3; i++) await db.collection('objects').findOne({ _key: list[0]!._id.toHexString() });
  });
  assert.deepEqual(same.map((x) => x.rule), ['KR-P012'], 'one distinct value is a repeat, not a derived link');
  const unrelated = await findingsOf('F23c', async () => {
    await users().find({}).limit(4).toArray();
    for (const k of ['a', 'b', 'c']) await db.collection('objects').findOne({ _key: `user:${k}` });
  });
  assert.deepEqual(unrelated.map((x) => x.rule), ['KR-P012']);
});

test('F25 a one-document parent re-read by key is not a loop: KR-P012, not N+1', async () => {
  const f = await findingsOf('F25', async () => {
    const u = await users().findOne({ name: 'user0' });
    for (let i = 0; i < 3; i++) await users().findOne({ _id: u!._id });
  });
  assert.deepEqual(f.map((x) => x.rule), ['KR-P012']);
});

test('F26 lookupKeys: equality conjuncts are keys, everything else is residual; pointLookup stays strict', () => {
  // A conflict between a top-level key and a $and part is residual in either key order.
  assert.equal(lookupKeys({ $and: [{ userId: 1 }], userId: 2 })!.residual, true);
  assert.equal(lookupKeys({ userId: 2, $and: [{ userId: 1 }] })!.residual, true);
  const acl = { _id: 'p1', _rperm: { $in: ['*', 'role:x'] } };
  assert.deepEqual([...lookupKeys(acl)!.keys.keys()], ['_id']);
  assert.equal(lookupKeys(acl)!.residual, true);
  assert.equal(pointLookup(acl), undefined);
  assert.deepEqual(lookupKeys({ a: { $eq: 2 }, b: 'x' }), { keys: new Map([['a', 'number:2'], ['b', 'string:x']]), residual: false });
  assert.equal(lookupKeys({ _id: 1, $or: [{ a: 1 }] })!.residual, true);
  assert.equal(lookupKeys({ $or: [{ a: 1 }, { b: 2 }] }), undefined);
  assert.equal(lookupKeys({ n: { $gt: 1 } }), undefined);
  assert.equal(lookupKeys({ tags: ['a', 'b'] }), undefined);
  // A top-level $and is the same conjunction (Prisma's compound equality); an $or inside it stays residual.
  assert.deepEqual(lookupKeys({ $and: [{ _id: { $eq: 1 } }, { tenant: { $eq: 't' } }] }), { keys: new Map([['_id', 'number:1'], ['tenant', 'string:t']]), residual: false });
  assert.equal(lookupKeys({ $and: [{ _id: 1 }, { $or: [{ a: 1 }] }] })!.residual, true);
  assert.equal(lookupKeys({ $and: [{ n: { $gt: 1 } }] }), undefined);
});

test('F27 an ACL-style residual conjunct does not hide the loop: KR-P002, lookup field _id', async () => {
  const f = await findingsOf('F27', async () => {
    const list = await orders().find({}).limit(5).toArray();
    for (const o of list) await users().findOne({ _id: o.userId, tenant: { $in: ['t1', 't2'] } });
  });
  assert.equal(f.length, 1);
  const x = nPlusOne(f[0]);
  assert.equal(x.parent?.field, 'userId');
  assert.deepEqual(x.lookupFields, ['_id']);
  assert.equal(x.queries, 5);
});

test('F28 a top-level $or residual does not hide the loop either', async () => {
  const f = await findingsOf('F28', async () => {
    const list = await orders().find({}).limit(4).toArray();
    for (const o of list) await users().findOne({ _id: o.userId, $or: [{ tenant: 't1' }, { deleted: { $exists: false } }] });
  });
  assert.deepEqual(f.map((x) => x.rule), ['KR-P002']);
});

test('F29 no equality conjunct, or one key that never varies beside a residual: nothing reported', async () => {
  const f = await findingsOf('F29', async () => {
    const list = await orders().find({}).limit(5).toArray();
    for (const o of list) await orders().findOne({ n: { $gt: o.n } });
    // `status` is a value of the parent's status field, but the varying part is the residual `n`.
    for (const o of list) await orders().findOne({ status: 'paid', n: { $lt: o.n } });
  });
  assert.equal(f.length, 0, JSON.stringify(f.map((x) => [x.rule, x.shape])));
});

test('F30 causality: an unrelated same-shape lookup before the parent no longer demotes the loop', async () => {
  const f = await findingsOf('F30', async () => {
    await users().findOne({ _id: data.users[9]!._id });
    const list = await orders().find({}).limit(3).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
  });
  assert.equal(f.length, 1);
  const x = nPlusOne(f[0]);
  assert.equal(x.parent?.field, 'userId');
  assert.equal(x.queries, 3, 'evidence counts the lookups after the parent only');
  assert.equal(x.distinctKeys, 3);
});

test('F31 causality stays conservative: a value after the parent that it does not hold still blocks N+1', async () => {
  const f = await findingsOf('F31', async () => {
    const list = await orders().find({}).limit(3).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
    await users().findOne({ _id: data.users[9]!._id });
  });
  assert.deepEqual(f.map((x) => x.rule), ['KR-P012']);
});

test('F32 causality: a parent that returned partway through drives only the lookups after it', async () => {
  const f = await findingsOf('F32', async () => {
    await users().findOne({ _id: data.users[8]!._id });
    await users().findOne({ _id: data.users[9]!._id });
    const list = await orders().find({}).limit(2).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
  });
  assert.equal(f.length, 1);
  assert.equal(nPlusOne(f[0]).queries, 2);
});

test('F33 a loop of find-shaped aggregates (how Prisma reads) is N+1', async () => {
  const f = await findingsOf('F33', async () => {
    const list = await orders().aggregate([{ $match: { status: { $eq: 'paid' } } }, { $limit: 5 }]).toArray();
    for (const o of list) await users().aggregate([{ $match: { _id: { $eq: o.userId } } }, { $limit: 1 }]).toArray();
  });
  assert.equal(f.length, 1);
  const x = nPlusOne(f[0]);
  assert.equal(x.parent?.field, 'userId');
  assert.equal(x.queries, 5);
  assert.deepEqual(x.lookupFields, ['_id']);
});

test('F34 the same loop with a $group or $lookup stage is not a lookup', async () => {
  const f = await findingsOf('F34', async () => {
    const list = await orders().find({}).limit(5).toArray();
    for (const o of list) await users().aggregate([{ $match: { _id: o.userId } }, { $group: { _id: '$tenant' } }]).toArray();
    for (const o of list) {
      await users().aggregate([{ $match: { _id: o.userId } }, { $lookup: { from: 'orders', localField: '_id', foreignField: 'userId', as: 'o' } }]).toArray();
    }
  });
  assert.equal(f.length, 0, JSON.stringify(f.map((x) => [x.rule, x.shape])));
});

async function nestedFixture(prefix: string) {
  const orgs = Array.from({ length: 3 }, (_, i) => ({ _id: new ObjectId(), name: `org${i}` }));
  const members = Array.from({ length: 6 }, (_, i) => ({ _id: new ObjectId(), orgId: orgs[i % 3]!._id }));
  const posts = members.map((m) => ({ _id: new ObjectId(), memberId: m._id }));
  await db.collection(`${prefix}_orgs`).insertMany(orgs);
  await db.collection(`${prefix}_members`).insertMany(members);
  await db.collection(`${prefix}_posts`).insertMany(posts);
  return { orgs: db.collection(`${prefix}_orgs`), members: db.collection(`${prefix}_members`), posts: db.collection(`${prefix}_posts`), data: members };
}

test('F35 a two-level loop: the second level names the run of member reads as its parent', async () => {
  const { orgs, members, posts } = await nestedFixture('f35');
  const f = await findingsOf('F35', async () => {
    for (const p of await posts.find({}).limit(6).toArray()) {
      const m = await members.findOne({ _id: p.memberId });
      await orgs.findOne({ _id: m!.orgId });
    }
  });
  assert.deepEqual(f.map((x) => x.rule), ['KR-P002', 'KR-P002']);
  const second = nPlusOne(f.find((x) => x.namespace.endsWith('f35_orgs')));
  assert.equal(second.parent.namespace, 'krepis_test.f35_members');
  assert.equal(second.parent.field, 'orgId');
  assert.equal(second.parent.returned, 6);
  assert.equal(second.confidence, 'strong');
});

test('F36 a run of reads that ended after the lookups is not their parent', async () => {
  const { orgs, members, data: list } = await nestedFixture('f36');
  const f = await findingsOf('F36', async () => {
    for (const m of list.slice(0, 3)) await orgs.findOne({ _id: m.orgId });
    for (const m of list.slice(0, 3)) await members.findOne({ _id: m._id });
  });
  assert.deepEqual(f.map((x) => x.rule), ['KR-P012', 'KR-P012']);
});

// Run parents found by review.

test('F37 a loop over request ids is not given a parent by an earlier read that echoes the id', async () => {
  const ids = [...new Map((await orders().find({}).limit(30).toArray()).map((o) => [String(o.userId), o.userId as ObjectId])).values()].slice(0, 3);
  assert.equal(ids.length, 3);
  const f = await findingsOf('F37', async () => {
    for (const id of ids) {
      await orders().findOne({ userId: id });
      await users().findOne({ _id: id });
    }
  });
  assert.deepEqual(f.map((x) => x.rule), ['KR-P012', 'KR-P012']);
});

test('F38 two one-to-one chains are not a run parent', async () => {
  const byUser = [...new Map((await orders().find({}).limit(30).toArray()).map((o) => [String(o.userId), o])).values()];
  const [a, b] = byUser;
  const f = await findingsOf('F38', async () => {
    const p1 = await orders().findOne({ _id: a!._id });
    await users().findOne({ _id: p1!.userId });
    const p2 = await orders().findOne({ _id: b!._id });
    await users().findOne({ _id: p2!.userId });
  });
  assert.deepEqual(f, []);
});

test('F39 run reads after the last lookup are not part of the parent', async () => {
  const { orgs, members, data: list } = await nestedFixture('f39');
  const f = await findingsOf('F39', async () => {
    for (const m of list.slice(0, 3)) {
      const x = await members.findOne({ _id: m._id });
      await orgs.findOne({ _id: x!.orgId });
    }
    for (const m of list.slice(3)) await members.findOne({ _id: m._id });
  });
  const org = nPlusOne(f.find((x) => x.namespace.endsWith('f39_orgs')));
  assert.equal(org.parent.returned, 3);
});

test('F24 repeats from two code paths show both call sites', async () => {
  const f = await findingsOf('F24', async () => {
    const list = await orders().find({}).limit(4).toArray();
    for (const o of list.slice(0, 2)) await users().findOne({ _id: o.userId });
    for (const o of list.slice(2)) await users().findOne({ _id: o.userId });
  });
  assert.equal(f.length, 1);
  assert.equal(nPlusOne(f[0]).confidence, 'strong');
  assert.equal(f[0]!.callSites.length, 2, f[0]!.callSites.join(' | '));
});

test('F8 reverse N+1 (children per parent): strong, parent field _id, lookup userId', async () => {
  const f = await findingsOf('F8', async () => {
    const list = await users().find({}).limit(5).toArray();
    for (const u of list) await orders().find({ userId: u._id }).toArray();
  });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.parent?.field, '_id');
  assert.deepEqual(f[0]!.lookupFields, ['userId']);
});

test('F9 parent read over several getMores: returned counts all batches, children correlated', async () => {
  const f = await findingsOf('F9', async () => {
    const list = await orders().find({}).batchSize(2).limit(7).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
  });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.parent?.returned, 7);
  assert.equal(f[0]!.confidence, 'strong');
});

test('F10 compound lookup with a constant tenant: lookup field is the varying one', async () => {
  const f = await findingsOf('F10', async () => {
    const list = await orders().find({}).limit(5).toArray();
    for (const o of list) await users().findOne({ tenant: 't1', _id: o.userId });
  });
  assert.equal(f.length, 1);
  assert.deepEqual(f[0]!.lookupFields, ['_id']);
  assert.equal(f[0]!.parent?.field, 'userId');
});

test('F11 parent array field: strong on tagIds', async () => {
  const f = await findingsOf('F11', async () => {
    const post = await db.collection<{ _id: string; tagIds: string[] }>('posts').findOne({ _id: 'p1' });
    for (const t of post?.tagIds ?? []) await db.collection<{ _id: string }>('tags').findOne({ _id: t });
  });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.parent?.field, 'tagIds');
});

test('F12 call site points at the loop in this file', async () => {
  const f = await findingsOf('F12', async () => {
    const list = await orders().find({}).limit(3).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
  });
  assert.equal(f.length, 1);
  assert.ok(f[0]!.callSites.some((s) => s.includes('nPlusOne.test.ts')), f[0]!.callSites.join(','));
});

// The wrappers live in their own module (dataLayer.ts), as a repository does in a real app.
for (const [name, get] of [['awaiting', getAwaiting], ['returning', getReturning], ['nested', getNested]] as const) {
  test(`F12b call site behind a data-layer wrapper (${name}) names the calling loop`, async () => {
    let loopLine = 0;
    const f = await findingsOf(`F12b-${name}`, async () => {
      const list = await orders().find({}).limit(3).toArray();
      loopLine = Number(/:(\d+):\d+\)?\s*$/.exec(new Error().stack!.split('\n')[1]!)![1]) + 1;
      for (const o of list) await get(users(), o.userId);
    });
    assert.equal(f.length, 1);
    const chain = f[0]!.callSites[0]!.split(' ← ');
    assert.ok(chain.some((s) => s.endsWith(`nPlusOne.test.ts:${loopLine}`)), `${f[0]!.callSites[0]} (loop at ${loopLine})`);
    if (name !== 'returning') assert.match(chain[0]!, /dataLayer\.ts:\d+$/);
  });
}

test('F13 middleware: per-request context, label masks ids', async () => {
  const handler = obs.middleware();
  const res = new EventEmitter();
  const req = { method: 'GET', originalUrl: `/orders/${data.orders[0]!._id.toHexString()}/items?x=1` };
  const start = obs.findings.length;
  await new Promise<void>((resolve) => {
    handler(req, res, async () => {
      const list = await orders().find({}).limit(4).toArray();
      for (const o of list) await users().findOne({ _id: o.userId });
      res.emit('finish');
      resolve();
    });
  });
  const f = obs.findings.slice(start);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.context, 'GET /orders/:id/items');
});

test('F13b middleware label: mount path kept, absolute baseUrl ignored, catch-all route falls back to the path', async () => {
  const handler = obs.middleware();
  const labelOf = async (req: object) => {
    const res = new EventEmitter();
    const start = obs.findings.length;
    await new Promise<void>((resolve) => {
      handler(req, res, async () => {
        const list = await orders().find({}).limit(4).toArray();
        for (const o of list) await users().findOne({ _id: o.userId });
        res.emit('finish');
        resolve();
      });
    });
    return obs.findings.slice(start).map((f) => f.context);
  };
  const id = data.orders[0]!._id.toHexString();
  // The middleware runs before routing; the route is known by the time the response finishes.
  const routed = (route: string, baseUrl: string, originalUrl: string) => {
    const req: Record<string, unknown> = { method: 'GET', originalUrl, baseUrl };
    setImmediate(() => (req.route = { path: route }));
    return req;
  };
  assert.deepEqual(await labelOf(routed('/items/:id', '/api', `/api/items/${id}`)), ['GET /api/items/:id']);
  assert.deepEqual(await labelOf(routed('/items/:id', 'http://localhost', `/items/${id}`)), ['GET /items/:id']);
  assert.deepEqual(await labelOf(routed('*', 'http://localhost', `/section-0/${id}`)), ['GET /section-0/:id']);
  assert.deepEqual(await labelOf(routed('/*splat', '', '/docs/a/b?x=1')), ['GET /docs/a/b']);
});

test('F14 late observe: gated monitoring works on already-open connections; the fallback still warns', async () => {
  const c = new MongoClient(URI);
  await c.connect();
  const col = c.db('krepis_test').collection('users');
  await col.findOne({}); // ensure a pooled connection exists before observing
  let warnings = 0;
  const onWarning = () => warnings++;
  process.on('warning', onWarning);
  try {
    const o = observe(c);
    await o.run('F14', async () => {
      for (let i = 0; i < 4; i++) await col.findOne({ _id: data.users[0]!._id });
    });
    assert.equal(o.findings.length, 1);
    o.detach();
    await new Promise((r) => setImmediate(r));
    assert.equal(warnings, 0);
  } finally {
    process.off('warning', onWarning);
  }
  const warned = new Promise<string>((resolve) => process.once('warning', (w) => resolve((w as Error & { code?: string }).code ?? '')));
  const c2 = new MongoClient(URI);
  await c2.connect();
  const o2 = observe(c2, { gateMonitoring: false });
  assert.equal(await warned, 'KREPIS_LATE_OBSERVE');
  o2.detach();
  await c.close();
  await c2.close();
});

test('F19 direct recording: no driver events outside or inside a context, and the loop is still recorded', async () => {
  const c = new MongoClient(URI);
  const o = observe(c);
  let started = 0;
  let succeeded = 0;
  c.on('commandStarted', () => started++);
  c.on('commandSucceeded', () => succeeded++);
  await c.connect();
  try {
    const col = c.db('krepis_test').collection('users');
    for (let i = 0; i < 5; i++) await col.findOne({ _id: data.users[i]!._id });
    await col.find({}).toArray();
    assert.equal(started, 0, 'outside a context the driver must not build events');
    await o.run('F19', async () => {
      for (let i = 0; i < 5; i++) await col.findOne({ _id: data.users[i]!._id });
    });
    assert.equal(started, 0, 'inside a context the reply is read directly');
    assert.equal(succeeded, 0);
    assert.equal(o.findings.length, 1);
    assert.equal(o.findings[0]!.queries, 5);
  } finally {
    o.detach();
    await c.close();
  }
});

test('F40 monitorCommands set by the application: each in-context command is recorded once', async () => {
  const c = new MongoClient(URI, { monitorCommands: true });
  const o = observe(c);
  let started = 0;
  c.on('commandStarted', () => started++);
  await c.connect();
  try {
    const db2 = c.db('krepis_test');
    await o.run('F40', async () => {
      const list = await db2.collection('orders').find({ status: 'paid' }).limit(10).toArray();
      for (const x of list) await db2.collection('users').findOne({ _id: x.userId });
    });
    assert.equal(started, 11, 'the application still gets its own events');
    assert.equal(o.findings.length, 1);
    assert.equal(nPlusOne(o.findings[0]).queries, 10);
  } finally {
    o.detach();
    await c.close();
  }
});

test('F41 an in-context read decodes each document once, as outside a context', async () => {
  const { OnDemandDocument } = createRequire(import.meta.url)('mongodb/lib/cmap/wire_protocol/on_demand/document.js') as {
    OnDemandDocument: { prototype: { toObject: (...a: unknown[]) => unknown } };
  };
  const col = db.collection('decode');
  await col.deleteMany({});
  await col.insertMany(Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(50) })));
  const original = OnDemandDocument.prototype.toObject;
  let calls = 0;
  OnDemandDocument.prototype.toObject = function counted(this: unknown, ...a: unknown[]) {
    calls++;
    return original.apply(this, a);
  };
  try {
    calls = 0;
    await col.find({}).toArray();
    const outside = calls;
    calls = 0;
    await obs.run('F41', () => col.find({}).toArray());
    assert.equal(calls, outside, `outside ${outside}, inside ${calls}`);
  } finally {
    OnDemandDocument.prototype.toObject = original;
  }
});

test('F15 Mongoose (its own bundled driver copy, no monitorCommands): populate() is not N+1; findById loop is', async () => {
  const conn = mongoose.createConnection(URI, { dbName: 'krepis_test' });
  const User = conn.model('User', new mongoose.Schema({ name: String, tenant: String }), 'users');
  const Order = conn.model('Order', new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, n: Number }), 'orders');
  await conn.asPromise();
  const mobs = observe(conn.getClient() as unknown as MongoClient);
  try {
    await mobs.run('populate', async () => {
      await Order.find({}).limit(10).populate('userId').lean();
    });
    assert.equal(mobs.findings.length, 0, JSON.stringify(mobs.findings));
    await mobs.run('loop', async () => {
      const list = await Order.find({}).limit(10).lean();
      for (const o of list) await User.findById(o.userId).lean();
    });
    assert.equal(mobs.findings.length, 1);
    assert.equal(mobs.findings[0]!.confidence, 'strong');
    assert.equal(mobs.findings[0]!.parent?.field, 'userId');
  } finally {
    mobs.detach();
    await conn.close();
  }
});

test('F16 a loop costs a bounded number of call-site captures, still pointing at the loop', async () => {
  const captured = obs.callSitesCaptured;
  const f = await findingsOf('F16', async () => {
    const list = await orders().find({}).limit(8).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
  });
  // One for the parent find, three for the child fingerprint, not 1 + 8.
  assert.equal(obs.callSitesCaptured - captured, 4);
  assert.equal(f.length, 1);
  assert.ok(f[0]!.callSites[0]!.includes('nPlusOne.test.ts'), f[0]!.callSites[0]);
});

test('F17 failures inside Krepis never reach the application', async () => {
  const c = new MongoClient(URI);
  const o = observe(c, {
    onFinding: () => {
      throw new Error('onFinding boom');
    },
  });
  await c.connect();
  try {
    const col = c.db('krepis_test').collection('users');
    // An identical lookup repeated: a KR-P012 finding, so the throwing onFinding runs.
    await o.run('F17a', async () => {
      for (let i = 0; i < 4; i++) await col.findOne({ _id: data.users[0]!._id });
    });
    assert.ok(o.internalErrors >= 1, `internalErrors ${o.internalErrors}`);
    // Break the recorder itself: the query must still succeed.
    (o as unknown as { settle: unknown }).settle = () => {
      throw new Error('boom');
    };
    const before = o.internalErrors;
    const doc = await o.run('F17b', () => col.findOne({ _id: data.users[1]!._id }));
    assert.equal(String(doc?._id), String(data.users[1]!._id));
    assert.ok(o.internalErrors > before);
  } finally {
    o.detach();
    await c.close();
  }
});

test('F18 KREPIS_DISABLED=1: no monitoring, no findings, run() still runs', async () => {
  process.env.KREPIS_DISABLED = '1';
  const c = new MongoClient(URI);
  try {
    const o = observe(c);
    await c.connect();
    const col = c.db('krepis_test').collection('users');
    const r = await o.run('F18', async () => {
      for (const u of data.users.slice(0, 5)) await col.findOne({ _id: u._id });
      return 42;
    });
    assert.equal(r, 42);
    assert.equal(o.findings.length, 0);
    assert.equal((c as unknown as { monitorCommands: boolean }).monitorCommands, false);
  } finally {
    delete process.env.KREPIS_DISABLED;
    await c.close();
  }
});

/** Runs the `const rows = ...` line the report suggests, against the real parents, and returns the _ids it fetched. */
async function runSuggestedFix(report: string, parents: unknown[]): Promise<string[]> {
  const line = report.split('\n').find((l) => l.trim().startsWith('const rows = await'));
  assert.ok(line, report);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown[]>;
  const fix = new AsyncFunction('db', 'parents', `${line.trim()}\nreturn rows;`);
  const rows = await fix(db, parents);
  return rows.map((r) => String((r as { _id: unknown })._id)).sort();
}

test('R1 the suggested fix runs and fetches exactly the looked-up documents (scalar parent field)', async () => {
  let parents: unknown[] = [];
  const looked = new Set<string>();
  const f = await findingsOf('R1', async () => {
    parents = await orders().find({ status: 'paid' }).limit(10).toArray();
    for (const o of parents as Array<{ userId: unknown }>) looked.add(String((await users().findOne({ _id: o.userId as never }))!._id));
  });
  assert.deepEqual(await runSuggestedFix(formatNPlusOne(nPlusOne(f[0])), parents), [...looked].sort());
});

test('R2 the suggested fix runs and fetches exactly the looked-up documents (array parent field)', async () => {
  let parents: unknown[] = [];
  const f = await findingsOf('R2', async () => {
    const post = await db.collection<{ _id: string; tagIds: string[] }>('posts').findOne({ _id: 'p1' });
    parents = [post];
    for (const t of post?.tagIds ?? []) await db.collection<{ _id: string }>('tags').findOne({ _id: t });
  });
  assert.deepEqual(await runSuggestedFix(formatNPlusOne(nPlusOne(f[0])), parents), ['tag0', 'tag1', 'tag3']);
});
