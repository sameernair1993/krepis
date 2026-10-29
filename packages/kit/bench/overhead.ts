// Collector overhead: client CPU time per operation, interleaved rounds. `node bench/overhead.ts`
// `HAZARDS_AB=1`: hazards off, default and all as separate clients in one process, paired per round (ADR-055 G8 re-run).
import { MongoClient, type Collection } from 'mongodb';
import { observe, type ObserveOptions } from '../src/index.ts';

const URI = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const OPS = Number(process.env.OPS ?? 1500);
const AB = process.env.HAZARDS_AB === '1';
const ROUNDS = Number(process.env.ROUNDS ?? (AB ? 12 : 3));

const GATE = process.env.GATE !== '0';

type Variant = { name: string; client: MongoClient; run?: <T>(fn: () => Promise<T>) => Promise<T> };

async function makeVariant(name: string, mode: 'none' | 'attached' | 'attachedWide' | 'ctx0' | 'ctx1', hazards?: ObserveOptions['hazards']): Promise<Variant> {
  const client = new MongoClient(URI, { maxPoolSize: 5 });
  let run: Variant['run'];
  if (mode !== 'none') {
    const obs = observe(client, {
      callSiteSampleRate: mode === 'ctx1' ? 1 : 0,
      gateMonitoring: GATE && mode !== 'attachedWide',
      ...(hazards === undefined ? {} : { hazards }),
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

const workloads: Array<[string, (c: Collection) => Promise<unknown>]> = [
  ['findOne by _id', (c) => c.findOne({ _id: ((Math.random() * 100) | 0) as never })],
  ['find 100 docs', (c) => c.find({}).toArray()],
];

if (AB) {
  // Paired, in-process comparison: every variant runs once per round, in an order rotated by one each round.
  const levels = [['B1', 'attached'], ['B2', 'ctx0'], ['B3', 'ctx1']] as const;
  const settings = [['off', false], ['default', undefined], ['all', true]] as const;
  const ab: Variant[] = [await makeVariant('baseline', 'none')];
  for (const [level, mode] of levels) for (const [setting, hazards] of settings) ab.push(await makeVariant(`${level} ${setting}`, mode, hazards));
  ab.push(await makeVariant('B2 off-2', 'ctx0', false));
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
  const fmt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
  console.log(`HAZARDS_AB: ${ab.length} clients, ${ROUNDS} rounds x ${OPS} ops, rotated order; median of paired per-round differences, client CPU µs/op`);
  for (const [wname, work] of workloads) {
    const us = new Map<string, number[]>(ab.map((v) => [v.name, []]));
    for (const v of ab) await measure(v, work, 5); // warm-up
    for (let r = 0; r < ROUNDS; r++) {
      for (let i = 0; i < ab.length; i++) {
        const v = ab[(i + r) % ab.length]!;
        us.get(v.name)!.push(await measure(v, work, 5));
      }
    }
    const diff = (a: string, b: string) => median(us.get(a)!.map((x, r) => x - us.get(b)![r]!));
    console.log(`\n${wname}  (baseline median ${median(us.get('baseline')!).toFixed(1)} µs/op)`);
    console.log(`  A/A  B2 off-2 - B2 off: ${fmt(diff('B2 off-2', 'B2 off'))}`);
    for (const [level] of levels) {
      console.log(`  ${level}  off ${median(us.get(`${level} off`)!).toFixed(1)}  default-off ${fmt(diff(`${level} default`, `${level} off`))}  all-off ${fmt(diff(`${level} all`, `${level} off`))}`);
    }
  }
  for (const v of ab) await v.client.close();
  await sdb.dropDatabase();
  await seedClient.close();
  process.exit(0);
}

const variants = [
  await makeVariant('baseline (no monitoring)', 'none'),
  await makeVariant('B1w attached, client-wide (old)', 'attachedWide'),
  await makeVariant(`B1 attached, no context${GATE ? ' (gated)' : ''}`, 'attached'),
  await makeVariant('B2 in context, no call site', 'ctx0'),
  await makeVariant('B3 5 queries/context, call sites on', 'ctx1'),
];
console.log(`gated monitoring: ${GATE ? 'on' : 'off (GATE=0)'}`);

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
