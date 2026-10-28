import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MongoClient, type MongoClientOptions } from 'mongodb';
import { TenantPools, watchConnections, type ConnectionFinding, type WatchOptions } from '../src/connections/index.ts';
import { URI } from './helpers.ts';

// KR-C005 fixtures (ADR-057, D1–D6): a TCP proxy that forgets a flow after IDLE_MS without data.
//   rst:       the client's next data is answered with a reset (a NAT that has forgotten the flow)
//   close:     both sides are closed at the timeout (a load balancer with idle resets)
//   blackhole: the client's next data is swallowed
type Mode = 'rst' | 'close' | 'blackhole';
const IDLE_MS = 1_500;
const DB = 'krepis_c005';
const upstream = new URL(URI);

async function idleProxy(mode: Mode): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const up = net.connect(Number(upstream.port), upstream.hostname);
    sockets.add(client).add(up);
    let last = Date.now();
    let dead = false;
    client.on('data', (d) => {
      if (!dead) {
        last = Date.now();
        up.write(d);
      } else if (mode === 'rst') {
        client.resetAndDestroy();
      }
    });
    up.on('data', (d) => {
      if (dead) return;
      last = Date.now();
      client.write(d);
    });
    const timer = setInterval(() => {
      if (dead || Date.now() - last < IDLE_MS) return;
      dead = true;
      up.destroy();
      if (mode === 'close') client.destroy();
    }, 50);
    const end = () => {
      clearInterval(timer);
      up.destroy();
      client.destroy();
    };
    client.on('close', end).on('error', end);
    up.on('error', () => !dead && end()).on('close', () => !dead && end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

let admin: MongoClient;
before(async () => {
  admin = new MongoClient(URI);
  await admin.connect();
  await admin.db(DB).dropDatabase();
  await admin.db(DB).collection('x').insertOne({ _id: 1 } as never);
});
after(async () => {
  await admin.db(DB).dropDatabase();
  await admin.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 4 rounds of 4 concurrent findOne by _id, 2 s apart. Returns failed operations. */
async function workload(find: () => Promise<unknown>): Promise<number> {
  let failed = 0;
  for (let round = 0; round < 4; round++) {
    if (round > 0) await sleep(2_000);
    await Promise.all(Array.from({ length: 4 }, () => find().catch(() => failed++)));
  }
  return failed;
}

async function run(mode: Mode | 'direct', watch: WatchOptions = {}, options: MongoClientOptions = {}) {
  const proxy = mode === 'direct' ? undefined : await idleProxy(mode);
  const uri = proxy ? `mongodb://127.0.0.1:${proxy.port}/?directConnection=true` : URI;
  const client = new MongoClient(uri, { heartbeatFrequencyMS: 500, ...options });
  const w = watchConnections(client, watch);
  try {
    await client.connect();
    const failed = await workload(() => client.db(DB).collection('x').findOne({ _id: 1 } as never));
    const totals = Object.values(w.stats())[0]!;
    return { failed, totals, found: (rule: string) => w.findings.filter((f) => f.rule === rule) };
  } finally {
    w.stop();
    await client.close();
    await proxy?.close();
  }
}

const recommended = (f: ConnectionFinding) => f.evidence.recommendedMaxIdleTimeMS as number;

test('D1 rst: connections reset on first use after idling raise KR-C005 once, with a maxIdleTimeMS below the timeout', async () => {
  const r = await run('rst');
  const c5 = r.found('KR-C005');
  assert.equal(c5.length, 1, JSON.stringify(r.totals));
  assert.equal(c5[0]!.evidence.drops, 3);
  assert.ok((c5[0]!.evidence.shortestDropIdleMs as number) >= IDLE_MS, String(c5[0]!.evidence.shortestDropIdleMs));
  assert.ok(recommended(c5[0]!) >= 500 && recommended(c5[0]!) < IDLE_MS, String(recommended(c5[0]!)));
  assert.match(c5[0]!.fix, new RegExp(`maxIdleTimeMS to ${recommended(c5[0]!)}`));
  assert.equal(r.failed, 0, 'retryable reads hide the drops');
});

test('D2 close: connections closed by the path while pooled raise KR-C005 once, without a pool clear', async () => {
  const r = await run('close');
  const c5 = r.found('KR-C005');
  assert.equal(c5.length, 1, JSON.stringify(r.totals));
  const shortest = c5[0]!.evidence.shortestDropIdleMs as number;
  assert.ok(shortest >= IDLE_MS && shortest <= 2_100, String(shortest));
  assert.ok(recommended(c5[0]!) >= 500 && recommended(c5[0]!) < IDLE_MS, String(recommended(c5[0]!)));
  assert.equal(r.failed, 0);
  assert.equal(r.totals.poolCleared, 0);
});

test('D3 the same workload directly to the server raises nothing', async () => {
  assert.deepEqual((await run('direct')).found('KR-C005'), []);
});

test('D4 idleDrops: false turns it off', async () => {
  assert.deepEqual((await run('rst', { idleDrops: false })).found('KR-C005'), []);
});

test('D5 blackhole with socketTimeoutMS: KR-C005 and KR-C010 both fire; operations succeed on retry', async () => {
  const r = await run('blackhole', {}, { socketTimeoutMS: 1_000 });
  assert.ok(r.found('KR-C005').length >= 1, JSON.stringify(r.totals));
  assert.ok(r.found('KR-C010').length >= 1, JSON.stringify(r.totals));
  assert.equal(r.failed, 0);
});

test('D6 TenantPools with its defaults, directly to the server, raises nothing', async () => {
  const found: ConnectionFinding[] = [];
  const uri = (t: string) => URI.replace(/\/(\?|$)/, `/${t}$1`);
  const pools = new TenantPools({ appName: 'd6', resolve: (t) => ({ uri: uri(t) }), watch: { onFinding: (f) => found.push(f) } });
  try {
    await Promise.all(['d6a', 'd6b', 'd6c'].map(async (t) => {
      const coll = (await pools.get(t)).db(t).collection('x');
      assert.equal(await workload(() => coll.findOne({ _id: 1 } as never)), 0);
    }));
    assert.deepEqual(found.filter((f) => f.rule === 'KR-C005'), []);
  } finally {
    await pools.closeAll();
  }
});
