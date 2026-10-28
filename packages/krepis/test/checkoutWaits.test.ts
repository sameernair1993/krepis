import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { TenantPools, watchConnections, type ConnectionFinding, type WatchOptions } from '../src/connections/index.ts';
import { URI } from './helpers.ts';

// KR-C006 fixtures (ADR-056, W1–W4 and W6). One-document collections, so `$where` sleeps once per find.
const DB = 'krepis_c006';
const SLOW = { $where: 'sleep(300) || true' };
let admin: MongoClient;

before(async () => {
  admin = new MongoClient(URI);
  await admin.connect();
  for (const db of [DB, 'w6a', 'w6b', 'w6c']) {
    await admin.db(db).dropDatabase();
    await admin.db(db).collection('slow').insertOne({ _id: 1 } as never);
  }
});

after(async () => {
  for (const db of [DB, 'w6a', 'w6b', 'w6c']) await admin.db(db).dropDatabase();
  await admin.close();
});

async function run(maxPoolSize: number, options: WatchOptions, work: (c: MongoClient) => Promise<unknown>[]): Promise<ConnectionFinding[]> {
  const client = new MongoClient(URI, { maxPoolSize });
  const w = watchConnections(client, options);
  try {
    await client.connect();
    // Warm the pool, so waits for a connection being established are not part of the workload.
    await Promise.all(Array.from({ length: Math.min(maxPoolSize, 2) }, () => client.db(DB).collection('slow').findOne({ _id: 1 } as never)));
    await Promise.all(work(client));
    return w.findings.filter((f) => f.rule === 'KR-C006');
  } finally {
    w.stop();
    await client.close();
  }
}

const slowFinds = (n: number) => (c: MongoClient) => Array.from({ length: n }, () => c.db(DB).collection('slow').findOne(SLOW));

test('W1 a full pool behind slow finds raises KR-C006 once', async () => {
  const found = await run(2, { checkoutWaits: true }, slowFinds(8));
  assert.equal(found.length, 1, JSON.stringify(found));
  const e = found[0]!.evidence;
  assert.equal(e.waited, 3);
  assert.equal(e.maxPoolSize, 2);
  assert.ok((e.longestWaitMs as number) >= 250, String(e.longestWaitMs));
  assert.match(found[0]!.message, /holders: observer\.holders\(\)/, 'says how to name the holders');
  assert.equal(e.holder1, undefined);
});

test('W2 the same finds with room in the pool raise nothing', async () => {
  assert.deepEqual(await run(10, { checkoutWaits: true }, slowFinds(8)), []);
});

test('W3 brief waits behind fast finds raise nothing', async () => {
  const fast = (c: MongoClient) => Array.from({ length: 50 }, () => c.db(DB).collection('slow').findOne({ _id: 1 } as never));
  assert.deepEqual(await run(2, { checkoutWaits: true }, fast), []);
});

test('W4 on by default; checkoutWaits: false gives no finding and no extra listener', async () => {
  const client = new MongoClient(URI);
  const before = client.listenerCount('connectionCheckOutStarted');
  const w = watchConnections(client, { checkoutWaits: false });
  assert.equal(client.listenerCount('connectionCheckOutStarted'), before);
  w.stop();
  await client.close();
  assert.deepEqual(await run(2, { checkoutWaits: false }, slowFinds(8)), []);
  assert.equal((await run(2, {}, slowFinds(8))).length, 1, 'default on');
});

test('W4b thresholds are configurable', async () => {
  assert.deepEqual(await run(2, { checkoutWaitThreshold: 50 }, slowFinds(8)), []);
  assert.deepEqual(await run(2, { checkoutWaitMs: 5_000 }, slowFinds(8)), []);
});

test('W6 TenantPools with its default pool raises nothing under mixed load', async () => {
  const found: ConnectionFinding[] = [];
  const uri = (t: string) => URI.replace(/\/(\?|$)/, `/${t}$1`);
  const pools = new TenantPools({ appName: 'w6', resolve: (t) => ({ uri: uri(t) }), watch: { checkoutWaits: true, onFinding: (f) => found.push(f) } });
  try {
    await Promise.all(['w6a', 'w6b', 'w6c'].map(async (t) => {
      const coll = (await pools.get(t)).db(t).collection('slow');
      await Promise.all([
        ...Array.from({ length: 5 }, () => coll.findOne({ _id: 1 } as never)),
        coll.findOne(SLOW), coll.findOne(SLOW),
      ]);
    }));
    assert.deepEqual(found.filter((f) => f.rule === 'KR-C006'), []);
  } finally {
    await pools.closeAll();
  }
});
