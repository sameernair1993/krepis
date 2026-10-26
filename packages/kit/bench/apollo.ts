// Apollo plugin overhead: client CPU per operation, with and without the plugin.
// A resolver-heavy operation (500 list items, each with an explicit resolver) plus one query to Mongo, so both the
// per-field path and the per-command path are exercised. Variants are interleaved with a rotating order (see autobatch.ts),
// and the overhead is the median of per-round ratios against `none`: absolute CPU drifts between rounds, ratios less so.
//   node bench/apollo.ts
import { ApolloServer } from '@apollo/server';
import { MongoClient } from 'mongodb';
import { observe } from '../src/index.ts';

const URI = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const ITEMS = 500;
const ITERS = 200;
const ROUNDS = 15;
const QUERY = 'query Items { items { n double } orders { n } }';

const typeDefs = `#graphql
  type Item { n: Int! double: Int! }
  type Order { n: Int! }
  type Query { items: [Item!]! orders: [Order!]! }
`;
const items = Array.from({ length: ITEMS }, (_, n) => ({ n }));

// 'no call sites' and 'obs.run' split the plugin's cost: call-site stacks vs the unit itself vs the plugin hooks.
// 'no resolver sites' drops the per-field willResolveField hook, so 'plugin' minus it is that hook's cost.
type Variant = 'none' | 'plugin' | 'no resolver sites' | 'plugin unsampled' | 'no call sites' | 'obs.run';

async function makeVariant(v: Variant) {
  const client = new MongoClient(URI, { maxPoolSize: 10 });
  const obs = v === 'none' ? undefined : observe(client, { sampleRate: v === 'plugin unsampled' ? 0 : 1, callSiteSampleRate: v === 'no call sites' ? 0 : 1 });
  await client.connect();
  const orders = client.db('krepis_bench_apollo').collection<{ n: number }>('orders');
  const server = new ApolloServer({
    typeDefs,
    resolvers: {
      Query: { items: () => items, orders: () => orders.find({}, { projection: { n: 1 } }).limit(10).toArray() },
      Item: { double: (i: { n: number }) => i.n * 2 },
    },
    plugins: obs && v !== 'obs.run' ? [obs.apolloPlugin({ resolverSites: v !== 'no resolver sites' })] : [],
  });
  await server.start();
  const op = () => server.executeOperation({ query: QUERY });
  const exec = async () => {
    const res = await (v === 'obs.run' ? obs!.run('Items', op) : op());
    if (res.body.kind !== 'single' || res.body.singleResult.errors) throw new Error(JSON.stringify(res.body));
  };
  const close = async () => {
    await server.stop();
    obs?.detach();
    await client.close();
  };
  return { exec, close, obs };
}

const seedClient = new MongoClient(URI);
await seedClient.connect();
const coll = seedClient.db('krepis_bench_apollo').collection('orders');
await coll.deleteMany({});
await coll.insertMany(Array.from({ length: 10 }, (_, n) => ({ n })));

const variants: Variant[] = ['none', 'plugin', 'no resolver sites', 'plugin unsampled', 'no call sites', 'obs.run'];
const made = new Map<Variant, Awaited<ReturnType<typeof makeVariant>>>();
for (const v of variants) made.set(v, await makeVariant(v));
for (const v of variants) for (let i = 0; i < 50; i++) await made.get(v)!.exec(); // warm-up

const perRound = new Map<Variant, number[]>(variants.map((v) => [v, []]));
for (let r = 0; r < ROUNDS; r++) {
  const order = variants.map((_, i) => variants[(i + r) % variants.length]!);
  for (const v of order) {
    const { exec } = made.get(v)!;
    const c0 = process.cpuUsage();
    for (let i = 0; i < ITERS; i++) await exec();
    const c = process.cpuUsage(c0);
    perRound.get(v)!.push((c.user + c.system) / 1000 / ITERS);
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const none = perRound.get('none')!;
console.log(`client CPU per operation (${ITEMS} resolved list items + 1 find; median of ${ROUNDS} rounds × ${ITERS}):`);
for (const v of variants) {
  const ms = perRound.get(v)!;
  const ratios = ms.map((x, r) => x / none[r]! - 1).sort((a, b) => a - b);
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  const spread = v === 'none' ? '' : `${pct(median(ratios))}  (rounds ${pct(ratios[0]!)} … ${pct(ratios.at(-1)!)})`;
  console.log(`  ${v.padEnd(17)} ${median(ms).toFixed(3)} ms  ${spread}`);
}
const findings = made.get('plugin')!.obs!.findings.length;
console.log(`  findings in the sampled variant: ${findings} (expected 0)`);

for (const v of variants) await made.get(v)!.close();
await seedClient.db('krepis_bench_apollo').dropDatabase();
await seedClient.close();
