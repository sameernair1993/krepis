// Per-field cost of the Apollo plugin's resolverSites hook: one operation resolving 10,001 fields and doing
// no I/O, which is the worst case for a per-field hook. Variants are interleaved; the minimum per variant is reported,
// because noise on a shared machine only ever adds time.
//   node --conditions=krepis-source bench/apolloFields.ts
import { ApolloServer, type ApolloServerPlugin } from '@apollo/server';
import { MongoClient } from 'mongodb';
import { observe } from '../src/index.ts';

const URI = process.env.KREPIS_TEST_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const ITEMS = 5000;
const ROUNDS = 60;
const WARMUP = 10;
const items = Array.from({ length: ITEMS }, (_, n) => ({ n }));
const typeDefs = 'type Item { n: Int! double: Int! } type Query { items: [Item!]! }';

const client = new MongoClient(URI);
const obs = observe(client);
await client.connect();

// 'noop hook' is a bare willResolveField: Apollo's own per-field wrapping, without Krepis's work.
const noopHook: ApolloServerPlugin = { async requestDidStart() { return { async executionDidStart() { return { willResolveField() {} }; } }; } };
const variants = {
  'none': [],
  'plugin, resolverSites off': [obs.apolloPlugin({ resolverSites: false })],
  'noop hook': [noopHook],
  'plugin (default)': [obs.apolloPlugin()],
} satisfies Record<string, ApolloServerPlugin[]>;

const servers = new Map<string, ApolloServer>();
for (const [name, plugins] of Object.entries(variants)) {
  const server = new ApolloServer({
    typeDefs,
    resolvers: { Query: { items: () => items }, Item: { double: (i: { n: number }) => i.n * 2 } },
    plugins,
  });
  await server.start();
  servers.set(name, server);
}

const mins = new Map<string, number>([...servers.keys()].map((k) => [k, Infinity]));
for (let round = 0; round < ROUNDS; round++) {
  for (const [name, server] of servers) {
    const c0 = process.cpuUsage();
    const res = await server.executeOperation({ query: 'query Items { items { n double } }' });
    const c = process.cpuUsage(c0);
    if (res.body.kind !== 'single' || res.body.singleResult.errors) throw new Error(JSON.stringify(res.body));
    if (round >= WARMUP) mins.set(name, Math.min(mins.get(name)!, (c.user + c.system) / 1000));
  }
}

const fields = ITEMS * 2 + 1;
const off = mins.get('plugin, resolverSites off')!;
const on = mins.get('plugin (default)')!;
console.log(`client CPU per operation (${fields} fields, no I/O; minimum of ${ROUNDS - WARMUP} rounds):`);
for (const [name, ms] of mins) console.log(`  ${name.padEnd(26)} ${ms.toFixed(2)} ms`);
console.log(`  resolverSites: ${(((on - off) / fields) * 1e6).toFixed(0)} ns per field, +${((on / off - 1) * 100).toFixed(1)}% on this operation`);

for (const server of servers.values()) await server.stop();
obs.detach();
await client.close();
