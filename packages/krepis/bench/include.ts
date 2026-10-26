// 1000 parents x 1 relation, Krepis include vs Mongoose populate. `node bench/include.ts`
// Variants are interleaved within each iteration so drift (GC, server cache) hits all of them alike.
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { createDal, schema, t } from '../src/dal/index.ts';

const URI = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const DB = 'krepis_bench_include';
const PARENTS = Number(process.env.PARENTS ?? 1000);
const USERS = Number(process.env.USERS ?? 100);
const WARM = Number(process.env.WARM ?? 5);
const RUNS = Number(process.env.RUNS ?? 30);

const client = new MongoClient(URI);
await client.connect();
const dal = createDal(client, { dbName: DB });
const Users = dal.collection('users', schema({ name: t.string(), email: t.string() }));
const Posts = dal.collection('posts', schema({ title: t.string(), body: t.string(), authorId: t.objectId() }));

await client.db(DB).dropDatabase();
const users = await Users.insertMany(Array.from({ length: USERS }, (_, i) => ({ name: `user ${i}`, email: `u${i}@x.test` })));
await Posts.insertMany(
  Array.from({ length: PARENTS }, (_, i) => ({ title: `post ${i}`, body: 'x'.repeat(200), authorId: users[i % USERS]._id })),
);

const conn = await mongoose.createConnection(URI, { dbName: DB }).asPromise();
const S = mongoose.Schema;
conn.model('User', new S({ name: String, email: String }), 'users');
const MPost = conn.model('Post', new S({ title: String, body: String, authorId: { type: S.Types.ObjectId, ref: 'User' } }), 'posts');

const variants: Array<[string, () => Promise<unknown[]>]> = [
  ['krepis include', () => Posts.find().limit(PARENTS).include({ author: { from: Users, local: 'authorId' } }).toArray()],
  ['mongoose populate().lean()', () => MPost.find().limit(PARENTS).populate('authorId').lean()],
  ['mongoose populate() (hydrated)', () => MPost.find().limit(PARENTS).populate('authorId')],
];

const times = new Map<string, number[]>(variants.map(([n]) => [n, []]));
for (let i = 0; i < WARM + RUNS; i++) {
  for (const [name, run] of variants) {
    const t0 = performance.now();
    const rows = await run();
    const ms = performance.now() - t0;
    if (rows.length !== PARENTS) throw new Error(`${name}: ${rows.length} rows`);
    if (i >= WARM) times.get(name)!.push(ms);
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const base = median(times.get('krepis include')!);
console.log(`${PARENTS} parents, ${USERS} users, median of ${RUNS} after ${WARM} warm-ups`);
for (const [name] of variants) {
  const m = median(times.get(name)!);
  console.log(`${name.padEnd(32)} ${m.toFixed(2).padStart(8)} ms   ${(m / base).toFixed(2)}x krepis`);
}

await conn.close();
await client.db(DB).dropDatabase();
await client.close();
