import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { TenantPools, watchClients, type ClientWatchOptions } from '../src/connections/index.ts';
import { URI } from './helpers.ts';

const OTHER_HOST = URI.replace('127.0.0.1', 'localhost');

async function withWatcher(options: ClientWatchOptions, fn: (w: ReturnType<typeof watchClients>, clients: MongoClient[]) => Promise<void>) {
  const w = watchClients(MongoClient, options);
  const clients: MongoClient[] = [];
  try {
    await fn(w, clients);
  } finally {
    w.stop();
    await Promise.all(clients.map((c) => c.close()));
  }
}

test('K1 two clients for the same target: KR-C001 naming both connect sites and the pool total', async () => {
  await withWatcher({}, async (w, clients) => {
    const a = new MongoClient(URI);
    const b = new MongoClient(URI, { maxPoolSize: 20 });
    clients.push(a, b);
    await a.connect();
    assert.equal(w.findings.length, 0);
    await b.connect();
    assert.equal(w.findings.length, 1);
    const f = w.findings[0]!;
    assert.equal(f.rule, 'KR-C001');
    assert.equal(f.evidence.openClients, 2);
    assert.equal(f.evidence.maxPoolSizeTotal, 120);
    assert.equal(f.clients?.length, 2);
    for (const site of f.clients ?? []) assert.match(site, /^test\/clients\.test\.ts:\d+$/);
    assert.match(f.message, /2 clients are open to 127\.0\.0\.1:27018/);
  });
});

test('K2 a client connected by its first operation is seen at the operation', async () => {
  await withWatcher({}, async (w, clients) => {
    const a = new MongoClient(URI);
    const b = new MongoClient(URI);
    clients.push(a, b);
    await a.db('krepis_clients').command({ ping: 1 });
    await b.db('krepis_clients').collection('x').findOne({});
    assert.equal(w.findings.length, 1);
    assert.ok(w.findings[0]!.clients!.every((s) => /^test\/clients\.test\.ts:\d+$/.test(s)), w.findings[0]!.clients!.join());
  });
});

test('K3 closed clients no longer count; raised again after the window', async () => {
  let now = 0;
  await withWatcher({ now: () => now }, async (w, clients) => {
    const a = new MongoClient(URI);
    clients.push(a);
    await a.connect();
    for (let i = 0; i < 3; i++) {
      const c = new MongoClient(URI);
      await c.connect();
      await c.close();
    }
    assert.equal(w.findings.length, 1, 'once per window');
    assert.equal(w.openClients()[0]!.sites.length, 1);
    now = 61_000;
    const b = new MongoClient(URI);
    clients.push(b);
    await b.connect();
    assert.equal(w.findings.length, 2);
    assert.equal(w.findings[1]!.evidence.createdSinceWatching, 5);
  });
});

test('K4 different targets, and a failed connect, are not duplicates', async () => {
  await withWatcher({}, async (w, clients) => {
    const a = new MongoClient(URI);
    const b = new MongoClient(OTHER_HOST);
    const bad = new MongoClient('mongodb://127.0.0.1:1/?directConnection=true', { serverSelectionTimeoutMS: 200 });
    const bad2 = new MongoClient('mongodb://127.0.0.1:1/?directConnection=true', { serverSelectionTimeoutMS: 200 });
    clients.push(a, b, bad, bad2);
    await a.connect();
    await b.connect();
    await assert.rejects(bad.connect());
    await assert.rejects(bad2.connect());
    assert.deepEqual(w.findings, []);
    assert.equal(w.openClients().length, 2);
  });
});

test('K5 Mongoose connections, through its driver copy', async () => {
  const w = watchClients(mongoose.mongo.MongoClient as never);
  const conns: mongoose.Connection[] = [];
  try {
    conns.push(await mongoose.createConnection(URI).asPromise());
    conns.push(await mongoose.createConnection(URI).asPromise());
    assert.equal(w.findings.length, 1);
    for (const site of w.findings[0]!.clients ?? []) assert.match(site, /^test\/clients\.test\.ts:\d+$/);
  } finally {
    w.stop();
    await Promise.all(conns.map((c) => c.close()));
  }
});

test('K6 stop restores the driver once no watcher is left', () => {
  const connect = MongoClient.prototype.connect;
  const close = MongoClient.prototype.close;
  const w1 = watchClients(MongoClient);
  const w2 = watchClients(MongoClient);
  assert.notEqual(MongoClient.prototype.connect, connect);
  w1.stop();
  assert.notEqual(MongoClient.prototype.connect, connect);
  w2.stop();
  assert.equal(MongoClient.prototype.connect, connect);
  assert.equal(MongoClient.prototype.close, close);
});

test('K7 TenantPools clients are not duplicates, with the driver or Mongoose; a client created beside them still is', async () => {
  // Tenants that differ only by database: one client per tenant is TenantPools' design, capped and evicted when idle.
  const uri = (t: string) => URI.replace(/\/(\?|$)/, `/${t}$1`);
  const w = watchClients(MongoClient);
  const wm = watchClients(mongoose.mongo.MongoClient as never);
  const pools = new TenantPools({ appName: 'k7', resolve: (t) => ({ uri: uri(t) }), watch: false });
  const viaMongoose = new TenantPools<mongoose.Connection>({
    appName: 'k7m', resolve: (t) => ({ uri: uri(t) }), watch: false,
    open: (u, o) => mongoose.createConnection(u, o as mongoose.ConnectOptions).asPromise(),
    close: (c) => c.close(),
  });
  const stray = new MongoClient(URI);
  try {
    for (const t of ['k7a', 'k7b', 'k7c']) {
      await (await pools.get(t)).db(t).collection('x').findOne({});
      await (await viaMongoose.get(t)).collection('x').findOne({});
    }
    assert.equal(w.findings.length, 0, w.findings.map((f) => f.message).join('\n'));
    assert.equal(wm.findings.length, 0, wm.findings.map((f) => f.message).join('\n'));
    await stray.connect();
    const second = new MongoClient(URI);
    await second.connect();
    await second.close();
    assert.equal(w.findings.length, 1, 'clients the app creates are still watched');
    assert.equal(w.findings[0]!.evidence.openClients, 2);
  } finally {
    w.stop();
    wm.stop();
    await stray.close();
    await pools.closeAll();
    await viaMongoose.closeAll();
  }
});
