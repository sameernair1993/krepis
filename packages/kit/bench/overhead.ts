// Collector overhead: client CPU time per operation, interleaved rounds. `node bench/overhead.ts`
import { MongoClient, type Collection } from 'mongodb';
import { observe } from '../src/index.ts';

const URI = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const OPS = Number(process.env.OPS ?? 1500);
const ROUNDS = Number(process.env.ROUNDS ?? 3);

const GATE = process.env.GATE !== '0';

type Variant = { name: string; client: MongoClient; run?: <T>(fn: () => Promise<T>) => Promise<T> };

async function makeVariant(name: string, mode: 'none' | 'attached' | 'attachedWide' | 'ctx0' | 'ctx1'): Promise<Variant> {
  const client = new MongoClient(URI, { maxPoolSize: 5 });
  let run: Variant['run'];
  if (mode !== 'none') {
    const obs = observe(client, {
      callSiteSampleRate: mode === 'ctx1' ? 1 : 0,
      gateMonitoring: GATE && mode !== 'attachedWide',
    });
    if (mode === 'ctx0' || mode === 'ctx1') run = (fn) => obs.run('bench', fn);
  }
  await client.connect();
  return { name, client, run };
}

async function measure(v: Variant, work: (c: Collection) => Promise<unknown>, batch: number): Promise<number> {
  const col = v.client.db('krepis_bench').collection('docs');
  const t0 = process.cpuUsage();
  for (let i = 0; i < OPS; i += batch) {
    // One context per `batch` ops, like a request doing a handful of queries.
    const body = async () => { for (let j = 0; j < batch; j++) await work(col); };
    await (v.run ? v.run(body) : body());
  }
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / OPS;
}

const seedClient = new MongoClient(URI);
await seedClient.connect();
const sdb = seedClient.db('krepis_bench');
await sdb.dropDatabase();
await sdb.collection('docs').insertMany(Array.from({ length: 100 }, (_, i) => ({
  _id: i as never, name: `doc ${i}`, tags: ['a', 'b', 'c'], nested: { x: i, y: `y${i}`, z: [1, 2, 3] }, pad: 'x'.repeat(120),
})));

const variants = [
  await makeVariant('baseline (no monitoring)', 'none'),
  await makeVariant('B1w attached, client-wide (old)', 'attachedWide'),
  await makeVariant(`B1 attached, no context${GATE ? ' (gated)' : ''}`, 'attached'),
  await makeVariant('B2 in context, no call site', 'ctx0'),
  await makeVariant('B3 5 queries/context, call sites on', 'ctx1'),
];
console.log(`gated monitoring: ${GATE ? 'on' : 'off (GATE=0)'}`);

const workloads: Array<[string, (c: Collection) => Promise<unknown>]> = [
  ['findOne by _id', (c) => c.findOne({ _id: ((Math.random() * 100) | 0) as never })],
  ['find 100 docs', (c) => c.find({}).toArray()],
];

for (const [wname, work] of workloads) {
  const totals = new Map<string, number[]>();
  for (const v of variants) await measure(v, work, 5); // warm-up
  for (let r = 0; r < ROUNDS; r++) {
    for (const v of variants) {
      const us = await measure(v, work, 5);
      totals.set(v.name, [...(totals.get(v.name) ?? []), us]);
    }
  }
  const base = Math.min(...(totals.get(variants[0]!.name) ?? [0]));
  console.log(`\n${wname}  (${OPS} ops x ${ROUNDS} rounds, min of rounds, client CPU µs/op)`);
  for (const v of variants) {
    const best = Math.min(...(totals.get(v.name) ?? [0]));
    const delta = best - base;
    console.log(`  ${v.name.padEnd(36)} ${best.toFixed(1).padStart(7)}  ${v === variants[0] ? '' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`}`);
  }
}

for (const v of variants) await v.client.close();
await sdb.dropDatabase();
await seedClient.close();
