import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient, type MongoClientOptions } from 'mongodb';
import { TenantPools, watchConnections, type ConnectionFinding, type WatchOptions } from '../src/connections/index.ts';
import { URI } from './helpers.ts';

// KR-C002 fixtures (ADR-058, P1–P8). One-document collections, so `$where` sleeps once per find.
const DB = 'krepis_c002';
const TENANTS = ['c002a', 'c002b', 'c002c'];
const SLOW = { $where: 'sleep(300) || true' };
const M1500 = { maxConnectionsPerNode: 1500 };
let admin: MongoClient;

before(async () => {
  admin = new MongoClient(URI);
  await admin.connect();
  for (const db of [DB, ...TENANTS]) {
    await admin.db(db).dropDatabase();
    await admin.db(db).collection('c').insertOne({ _id: 1 } as never);
  }
});

after(async () => {
  for (const db of [DB, ...TENANTS]) await admin.db(db).dropDatabase();
  await admin.close();
});

/** 30 rounds of 4 concurrent finds by _id, 100 ms apart: 120 checkouts over about 3 s. */
async function rounds(c: MongoClient, db = DB): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.all(Array.from({ length: 4 }, () => c.db(db).collection('c').findOne({ _id: 1 } as never)));
    await sleep(100);
  }
}

async function run(watch: WatchOptions, client: MongoClientOptions = {}, before?: (c: MongoClient) => Promise<unknown>): Promise<ConnectionFinding[]> {
  const c = new MongoClient(URI, client);
  const w = watchConnections(c, watch);
  try {
    await c.connect();
    await before?.(c);
    await rounds(c);
    return w.findings.filter((f) => f.rule === 'KR-C002');
  } finally {
    w.stop();
    await c.close();
  }
}

const fast = { poolObserveMs: 2_000 };

test('P1 driver defaults, 10 instances against a 1500 limit: one KR-C002 sized from the peak', async () => {
  const found = await run({ ...fast, deployment: M1500, instances: 10 });
  assert.equal(found.length, 1, JSON.stringify(found));
  const e = found[0]!.evidence;
  const peak = e.peakCheckedOut as number;
  assert.ok(peak >= 1 && peak <= 4, String(peak));
  assert.equal(e.recommendedMaxPoolSize, Math.max(5, 2 * peak));
  assert.equal(e.maxPoolSize, 100);
  assert.equal(e.monitorsPerNode, 2);
  assert.equal(e.demandPerNode, 1020);
});

test('P2 without a deployment limit: none', async () => {
  assert.deepEqual(await run({ ...fast, instances: 10 }), []);
});

test('P3 one instance (102 of 1500): none', async () => {
  assert.deepEqual(await run({ ...fast, deployment: M1500, instances: 1 }), []);
});

test('P4 a pool that reached its cap: none', async () => {
  const slow = (c: MongoClient) => Promise.all(Array.from({ length: 12 }, () => c.db(DB).collection('c').findOne(SLOW)));
  assert.deepEqual(await run({ ...fast, deployment: M1500, instances: 100 }, { maxPoolSize: 8 }, slow), []);
});

test('P5 the default observation period (1 hour): none', async () => {
  assert.deepEqual(await run({ deployment: M1500, instances: 10 }), []);
});

test('P6 oversizedPool: false turns it off', async () => {
  assert.deepEqual(await run({ ...fast, deployment: M1500, instances: 10, oversizedPool: false }), []);
});

test('P7 TenantPools with its defaults, declared M10 and 10 instances: none', async () => {
  const found: ConnectionFinding[] = [];
  const uri = (t: string) => URI.replace(/\/(\?|$)/, `/${t}$1`);
  const pools = new TenantPools({
    appName: 'p7', resolve: (t) => ({ uri: uri(t) }),
    watch: { ...fast, deployment: { tier: 'M10' }, instances: 10, onFinding: (f) => found.push(f) },
  });
  try {
    await Promise.all(TENANTS.map(async (t) => rounds(await pools.get(t), t)));
    assert.deepEqual(found.filter((f) => f.rule === 'KR-C002'), []);
  } finally {
    await pools.closeAll();
  }
});

test('P8 a slowdown grows the pool to its cap', async () => {
  const created = async (maxPoolSize: number) => {
    const c = new MongoClient(URI, { maxPoolSize });
    let n = 0;
    c.on('connectionCreated', () => n++);
    try {
      await c.connect();
      await Promise.all(Array.from({ length: 40 }, () => c.db(DB).collection('c').findOne(SLOW)));
      return n;
    } finally {
      await c.close();
    }
  };
  const big = await created(100);
  const small = await created(5);
  assert.ok(big >= 20, `maxPoolSize 100 created ${big}`);
  assert.ok(small <= 5, `maxPoolSize 5 created ${small}`);
});
