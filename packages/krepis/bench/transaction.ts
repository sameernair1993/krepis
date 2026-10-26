// A 3-write transaction through Krepis vs the same writes with a hand-threaded driver session.
// `node bench/transaction.ts`. Variants are interleaved within each iteration so drift hits all of them alike.
import { MongoClient, type ClientSession } from 'mongodb';
import { createDal, schema, t } from '../src/dal/index.ts';

const URI = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const DB = 'krepis_bench_tx';
const WARM = Number(process.env.WARM ?? 20);
const RUNS = Number(process.env.RUNS ?? 200);

const client = new MongoClient(URI);
await client.connect();
await client.db(DB).dropDatabase();
const dal = createDal(client, { dbName: DB });
const Items = dal.collection('items', schema({ name: t.string(), qty: t.number() }));
await client.db(DB).createCollection('items');
const raw = client.db(DB).collection('items');

let n = 0;
const writesWith = async (session: ClientSession) => {
  const name = `r${n++}`;
  await raw.insertOne({ name, qty: 1 }, { session });
  await raw.updateOne({ name }, { $inc: { qty: 1 } }, { session });
  await raw.deleteOne({ name }, { session });
};

const variants: Array<[string, () => Promise<unknown>]> = [
  [
    'krepis transaction()',
    () =>
      dal.transaction(async () => {
        const name = `k${n++}`;
        await Items.insertOne({ name, qty: 1 });
        await Items.updateOne({ name }, { $inc: { qty: 1 } });
        await Items.deleteOne({ name });
      }),
  ],
  [
    'driver, hand-threaded session',
    async () => {
      const session = client.startSession();
      try {
        session.startTransaction();
        await writesWith(session);
        await session.commitTransaction();
      } finally {
        await session.endSession();
      }
    },
  ],
  ['driver withTransaction()', () => client.withSession((s) => s.withTransaction(() => writesWith(s)))],
];

const times = new Map<string, number[]>(variants.map(([v]) => [v, []]));
for (let i = 0; i < WARM + RUNS; i++) {
  for (const [name, run] of variants) {
    const t0 = performance.now();
    await run();
    const ms = performance.now() - t0;
    if (i >= WARM) times.get(name)!.push(ms);
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const base = median(times.get('driver, hand-threaded session')!);
console.log(`runs=${RUNS} warm=${WARM}`);
for (const [name, xs] of times) {
  const m = median(xs);
  console.log(`${name.padEnd(32)} median ${m.toFixed(3)} ms  p95 ${p95(xs).toFixed(3)} ms  vs hand-threaded ${(((m - base) / base) * 100).toFixed(1)}%`);
}
if ((await raw.countDocuments()) !== 0) throw new Error('bench left documents behind');
await client.db(DB).dropDatabase();
await client.close();
