/**
 * Auto-batching benchmark: a serial loop of 100 `_id` lookups driven by a parent query.
 *
 *   node bench/autobatch.ts
 *
 * Variants: no Krepis; Krepis observing (no batching); Krepis with autoBatch.
 * Local: client CPU and wall per loop against localhost. Remote: wall per loop through a TCP proxy that delays
 * each direction by RTT/2, standing in for a cross-region database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { observe, type Observer } from '../src/index.ts';

const RTT_MS = Number(process.env.RTT_MS ?? 20);
const N = 100;
const LOCAL_ITERS = 40;
const LOCAL_ROUNDS = 5;
const REMOTE_ITERS = 3;

function startProxy(port: number, target: number): Promise<() => void> {
  const server = createServer((client) => {
    const upstream = createConnection(target, '127.0.0.1');
    const pipe = (from: typeof client, to: typeof client) =>
      from.on('data', (chunk) => setTimeout(() => to.writable && to.write(chunk), RTT_MS / 2));
    pipe(client, upstream);
    pipe(upstream, client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(() => server.close())));
}

async function setup(uri: string) {
  const client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  const db = client.db('krepis_bench_ab');
  return { client, db };
}

async function seed(uri: string) {
  const { client, db } = await setup(uri);
  await db.dropDatabase();
  const users = Array.from({ length: N }, (_, i) => ({ _id: new ObjectId(), name: `user${i}`, email: `u${i}@x.io`, plan: 'pro' }));
  await db.collection('users').insertMany(users);
  await db.collection('orders').insertMany(users.map((u, i) => ({ userId: u._id, n: i, total: i * 3 })));
  await client.close();
}

type Variant = 'none' | 'observe' | 'capture' | 'autoBatch' | 'safe';
const CAPTURE_DIR = mkdtempSync(join(tmpdir(), 'krepis-bench-'));

async function makeVariant(uri: string, v: Variant) {
  const { client, db } = await setup(uri);
  const obs: Observer | undefined = v === 'none' ? undefined : observe(client, v === 'autoBatch' ? { autoBatch: true } : v === 'safe' ? { optimize: 'safe' } : v === 'capture' ? { capture: CAPTURE_DIR } : {});
  const loop = async () => {
    const orders = await db.collection('orders').find({}).sort({ n: 1 }).limit(N).toArray();
    let found = 0;
    for (const o of orders) if (await db.collection('users').findOne({ _id: o.userId })) found++;
    if (found !== N) throw new Error(`found ${found}`);
  };
  const run = obs ? () => obs.run('bench', loop) : loop;
  await run(); // warm: pool, JIT
  return { run, close: async () => { obs?.detach(); await client.close(); } };
}

async function local(uri: string) {
  // Variants are interleaved, and the order rotates each round: run back to back, a variant's position (JIT
  // warm-up, CPU frequency) moved its result by up to ±30%, more than the differences being measured.
  const variants: Variant[] = ['none', 'observe', 'capture', 'autoBatch', 'safe'];
  const made = await Promise.all(variants.map((v) => makeVariant(uri, v)));
  const out: Record<string, { cpuUs: number; wallMs: number }> = {};
  for (const v of variants) out[v] = { cpuUs: Infinity, wallMs: Infinity };
  for (let r = 0; r < LOCAL_ROUNDS; r++) {
    for (let k = 0; k < variants.length; k++) {
      const idx = (k + r) % variants.length;
      const { run } = made[idx]!;
      const c0 = process.cpuUsage();
      const t0 = performance.now();
      for (let i = 0; i < LOCAL_ITERS; i++) await run();
      const c = process.cpuUsage(c0);
      const wallMs = (performance.now() - t0) / LOCAL_ITERS;
      const cpuUs = (c.user + c.system) / LOCAL_ITERS;
      if (cpuUs < out[variants[idx]!]!.cpuUs) out[variants[idx]!] = { cpuUs, wallMs };
    }
  }
  for (const m of made) await m.close();
  return out;
}

async function remote(uri: string) {
  const out: Record<string, number> = {};
  for (const v of ['none', 'autoBatch'] as Variant[]) {
    const { run, close } = await makeVariant(uri, v);
    let best = Infinity;
    for (let i = 0; i < REMOTE_ITERS; i++) {
      const t0 = performance.now();
      await run();
      best = Math.min(best, performance.now() - t0);
    }
    out[v] = best;
    await close();
  }
  return out;
}

const LOCAL = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const PROXIED = 'mongodb://127.0.0.1:27019/?directConnection=true';

await seed(LOCAL);
const l = await local(LOCAL);
console.log(`local, one loop of 1 parent + ${N} lookups (best of ${LOCAL_ROUNDS} rounds × ${LOCAL_ITERS}):`);
for (const [v, r] of Object.entries(l)) console.log(`  ${v.padEnd(10)} client CPU ${(r.cpuUs / 1000).toFixed(2)} ms   wall ${r.wallMs.toFixed(2)} ms`);

const stop = await startProxy(27019, Number(new URL(LOCAL).port));
const r = await remote(PROXIED);
stop();
console.log(`through a ${RTT_MS} ms RTT proxy (best of ${REMOTE_ITERS}):`);
for (const [v, ms] of Object.entries(r)) console.log(`  ${v.padEnd(10)} wall ${ms.toFixed(0)} ms`);
console.log(`  speed-up ${(r.none! / r.autoBatch!).toFixed(1)}x`);

const { client, db } = await setup(LOCAL);
await db.dropDatabase();
await client.close();
rmSync(CAPTURE_DIR, { recursive: true, force: true });
