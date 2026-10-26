// The typed aggregation builder against the identical pipeline on the raw driver. `node bench/aggregate.ts`
// W-A: group USERS users by plan with $avg. W-B: POSTS posts plus their author through $lookup.
// Variants are interleaved within each iteration so drift (GC, server cache) hits both alike. Before timing, each
// variant runs once under command monitoring: the wire pipelines must be identical and the command counts equal.
import { MongoClient, type Document } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { createDal, schema, t } from '../src/dal/index.ts';

const URI = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const DB = 'krepis_bench_aggregate';
const USERS = Number(process.env.USERS ?? 10_000);
const POSTS = Number(process.env.POSTS ?? 100);
const WARM = Number(process.env.WARM ?? 5);
const RUNS = Number(process.env.RUNS ?? 40);

const client = new MongoClient(URI, { monitorCommands: true });
await client.connect();
const dal = createDal(client, { dbName: DB });
const Users = dal.collection('users', schema({ name: t.string(), age: t.number(), plan: t.string() }));
const Posts = dal.collection('posts', schema({ title: t.string(), body: t.string(), authorId: t.objectId() }));

await client.db(DB).dropDatabase();
const plans = ['free', 'pro', 'team', 'enterprise'];
const users = await Users.insertMany(Array.from({ length: USERS }, (_, i) => ({ name: `user ${i}`, age: 18 + (i % 60), plan: plans[i % 4] })));
await Posts.insertMany(Array.from({ length: POSTS }, (_, i) => ({ title: `post ${i}`, body: 'x'.repeat(200), authorId: users[i % USERS]._id })));
const raw = client.db(DB);

const lookup = { from: 'users', localField: 'authorId', foreignField: '_id', as: 'author' };
const workloads: Array<{ name: string; rows: number; variants: Array<[string, () => Promise<unknown[]>]> }> = [
  {
    name: `W-A group ${USERS} users by plan, $avg`,
    rows: 4,
    variants: [
      ['builder', () => Users.aggregate().group({ _id: '$plan', avg: { $avg: '$age' } }).all()],
      ['raw driver', () => raw.collection('users').aggregate([{ $group: { _id: '$plan', avg: { $avg: '$age' } } }]).toArray()],
    ],
  },
  {
    name: `W-B ${POSTS} posts + author via $lookup`,
    rows: POSTS,
    variants: [
      ['builder', () => Posts.aggregate().limit(POSTS).lookup({ from: Users, localField: 'authorId', foreignField: '_id', as: 'author' }).all()],
      ['raw driver', () => raw.collection('posts').aggregate([{ $limit: POSTS }, { $lookup: lookup }]).toArray()],
    ],
  },
];

const wire = async (run: () => Promise<unknown[]>) => {
  const cmds: Document[] = [];
  const on = (e: { databaseName: string; commandName: string; command: Document }) => {
    if (e.databaseName === DB) cmds.push({ name: e.commandName, pipeline: e.command.pipeline });
  };
  client.on('commandStarted', on);
  await run();
  client.off('commandStarted', on);
  return cmds;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

console.log(`median of ${RUNS} after ${WARM} warm-ups, interleaved\n`);
for (const w of workloads) {
  const b = await wire(w.variants[0][1]);
  const r = await wire(w.variants[1][1]);
  const sameWire = isDeepStrictEqual(b, r);
  const times = new Map<string, number[]>(w.variants.map(([n]) => [n, []]));
  const ratios: number[] = [];
  for (let i = 0; i < WARM + RUNS; i++) {
    for (const [name, run] of i % 2 ? [...w.variants].reverse() : w.variants) {
      const t0 = performance.now();
      const rows = await run();
      const ms = performance.now() - t0;
      if (rows.length !== w.rows) throw new Error(`${w.name} ${name}: ${rows.length} rows`);
      if (i >= WARM) times.get(name)!.push(ms);
    }
    if (i >= WARM) ratios.push(times.get('builder')!.at(-1)! / times.get('raw driver')!.at(-1)!);
  }
  const mb = median(times.get('builder')!);
  const mr = median(times.get('raw driver')!);
  console.log(w.name);
  console.log(`  builder     ${mb.toFixed(3).padStart(8)} ms`);
  console.log(`  raw driver  ${mr.toFixed(3).padStart(8)} ms`);
  console.log(`  overhead (median of medians) ${(((mb / mr) - 1) * 100).toFixed(2)}%   (median paired ratio) ${((median(ratios) - 1) * 100).toFixed(2)}%`);
  console.log(`  commands builder=${b.length} raw=${r.length}   identical wire: ${sameWire}`);
  console.log('  builder', JSON.stringify(b));
  console.log('  raw    ', JSON.stringify(r));
  console.log();
}

await client.db(DB).dropDatabase();
await client.close();
