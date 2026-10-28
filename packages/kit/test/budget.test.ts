import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoClient, type Db } from 'mongodb';
import { expectQueries, KrepisQueryBudgetError, observe, type Observer } from '../src/index.ts';
import { URI, seed } from './helpers.ts';

let client: MongoClient;
let db: Db;
let obs: Observer;
let server: Server;
let base: string;

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10 });
  obs = observe(client, { sampleRate: 0 });
  await client.connect();
  db = client.db('krepis_budget');
  await seed(db);
  const handle = obs.middleware();
  server = createServer((req, res) => handle(req, res, async () => {
    const list = await orders().find({}).sort({ n: 1 }).limit(5).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
    res.end(String(list.length));
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  obs.detach();
  await client.close();
});

const users = () => db.collection('users');
const orders = () => db.collection('orders');

test('B1 counts the commands a block issues; a cursor and its getMores are one command', async () => {
  const { result, queries } = await obs.measure('B1', async () => {
    const all = await orders().find({}, { batchSize: 4 }).toArray();
    await users().countDocuments({});
    return all.length;
  });
  assert.equal(result, 30);
  assert.equal(queries.commands, 2);
  assert.equal(queries.roundTrips, 2);
  assert.equal(queries.units, 1);
  assert.deepEqual(queries.shapes.map((s) => [s.command, s.namespace, s.count]).sort(), [
    ['aggregate', 'krepis_budget.users', 1],
    ['find', 'krepis_budget.orders', 1],
  ]);
});

test('B2 expectQueries returns the block\'s value when it is within budget', async () => {
  const n = await expectQueries(obs, { max: 1 }, () => users().countDocuments({}));
  assert.equal(n, 10);
});

test('B3 over budget: throws with each shape, its count and its call site', async () => {
  const err = await expectQueries(obs, { max: 3 }, async () => {
    const list = await orders().find({ status: 'paid' }).limit(10).toArray();
    for (const o of list) await users().findOne({ _id: o.userId });
  }, 'GET /orders').then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof KrepisQueryBudgetError, String(err));
  assert.equal(err.queries.commands, 11);
  assert.equal(err.queries.shapes[0]!.count, 10);
  assert.equal(err.queries.shapes[0]!.namespace, 'krepis_budget.users');
  assert.match(err.queries.shapes[0]!.callSite ?? '', /budget\.test\.ts:\d+/);
  assert.match(err.message, /^Expected at most 3 queries in GET \/orders, got 11:/);
  assert.match(err.message, /10 × find krepis_budget\.users/);
  assert.match(err.message, /at .*budget\.test\.ts:\d+/);
});

test('B4 a request served in this process while measuring is counted, whatever sampleRate says', async () => {
  const { queries } = await obs.measure('B4', async () => {
    const res = await fetch(`${base}/orders`);
    return res.text();
  });
  assert.equal(queries.commands, 6);
  assert.equal(queries.units, 2);
});

test('B5 units that begin after the measurement are not counted', async () => {
  const { queries } = await obs.measure('B5', () => users().countDocuments({}));
  await fetch(`${base}/orders`).then((r) => r.text());
  assert.equal(queries.commands, 1);
});

test('B6 with optimize, commands answered locally are commands but not round trips', async () => {
  const c = new MongoClient(URI, { maxPoolSize: 10 });
  const o = observe(c, { optimize: 'safe' });
  await c.connect();
  try {
    const d = c.db('krepis_budget');
    const { queries } = await o.measure('B6', async () => {
      const list = await d.collection('orders').find({}).sort({ n: 1 }).limit(10).toArray();
      for (const x of list) await d.collection('users').findOne({ _id: x.userId });
    });
    assert.equal(queries.commands, 11);
    assert.ok(queries.roundTrips < queries.commands, `round trips ${queries.roundTrips}`);
  } finally {
    o.detach();
    await c.close();
  }
});

test('B7 a disabled observer refuses to measure instead of passing silently', async () => {
  process.env.KREPIS_DISABLED = '1';
  const o = observe(client);
  delete process.env.KREPIS_DISABLED;
  await assert.rejects(expectQueries(o, { max: 0 }, () => 1), /disabled/);
});
