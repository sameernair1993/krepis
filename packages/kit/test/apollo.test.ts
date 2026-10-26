import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApolloServer } from '@apollo/server';
import DataLoader from 'dataloader';
import { MongoClient, type CommandStartedEvent, type Db, type ObjectId } from 'mongodb';
import { observe, type NPlusOneFinding, type ObserveOptions, type Observer } from '../src/index.ts';
import { URI, seed } from './helpers.ts';

const typeDefs = `#graphql
  type User { name: String! }
  type Order { n: Int! status: String! user: User }
  type Query { orders(limit: Int!): [Order!]! }
`;

interface Ctx { loader?: DataLoader<ObjectId, unknown, string> }
type OrderDoc = { n: number; status: string; userId: ObjectId };

const resolvers = (db: Db) => ({
  Query: {
    orders: (_: unknown, { limit }: { limit: number }) =>
      db.collection<OrderDoc>('orders').find({}).sort({ n: 1 }).limit(limit).toArray(),
  },
  Order: {
    user: (o: OrderDoc, _: unknown, ctx: Ctx) => (ctx.loader ? ctx.loader.load(o.userId) : db.collection('users').findOne({ _id: o.userId })),
  },
});

const userLoader = (db: Db) =>
  new DataLoader<ObjectId, unknown, string>(
    async (ids) => {
      const docs = await db.collection('users').find({ _id: { $in: [...ids] } }).toArray();
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      return ids.map((id) => byId.get(String(id)) ?? null);
    },
    { cacheKeyFn: String },
  );

interface Rig { client: MongoClient; db: Db; obs: Observer; server: ApolloServer<Ctx>; wire: CommandStartedEvent[] }
const rigs: Rig[] = [];

async function rig(options: ObserveOptions = {}): Promise<Rig> {
  const client = new MongoClient(URI, { maxPoolSize: 10, monitorCommands: true });
  const obs = observe(client, options);
  const wire: CommandStartedEvent[] = [];
  client.on('commandStarted', (e) => wire.push(e));
  await client.connect();
  const db = client.db('krepis_apollo');
  const server = new ApolloServer<Ctx>({ typeDefs, resolvers: resolvers(db), plugins: [obs.apolloPlugin()] });
  await server.start();
  const r = { client, db, obs, server, wire };
  rigs.push(r);
  return r;
}

const ORDERS = 'query Orders { orders(limit: 10) { n status user { name } } }';

async function exec(r: Rig, query: string, contextValue: Ctx = {}) {
  const res = await r.server.executeOperation({ query }, { contextValue });
  assert.equal(res.body.kind, 'single');
  if (res.body.kind !== 'single') throw new Error('unreachable');
  assert.equal(res.body.singleResult.errors, undefined, JSON.stringify(res.body.singleResult.errors));
  return res.body.singleResult.data as { orders: Array<{ n: number; user: { name: string } }> };
}

const findsOn = (r: Rig, from: number, coll: string) => r.wire.slice(from).filter((e) => e.commandName === 'find' && e.command.find === coll);
const newFindings = (r: Rig, from: number) => r.obs.findings.slice(from) as NPlusOneFinding[];

let base: Rig;

before(async () => {
  base = await rig();
  await seed(base.db);
});

after(async () => {
  for (const r of rigs) {
    await r.server.stop();
    r.obs.detach();
    await r.client.close();
  }
});

test('P1 naive resolver: one strong N+1 labelled with the operation', async () => {
  const f = base.obs.findings.length;
  const data = await exec(base, ORDERS);
  assert.equal(data.orders.length, 10);
  assert.ok(data.orders.every((o) => typeof o.user.name === 'string'));
  const found = newFindings(base, f);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0]!.context, 'query Orders');
  assert.equal(found[0]!.confidence, 'strong');
  assert.equal(found[0]!.queries, 10);
  assert.equal(found[0]!.parent?.namespace, 'krepis_apollo.orders');
  assert.equal(found[0]!.parent?.field, 'userId');
  // Both resolvers return the query promise without await, so no application frame is left: the resolver is named.
  assert.deepEqual(found[0]!.callSites, ['resolver Order.user']);
  assert.equal(found[0]!.parent?.callSite, 'resolver Query.orders');
});

test('P2 DataLoader resolver: no finding, one $in on the wire', async () => {
  const f = base.obs.findings.length;
  const w = base.wire.length;
  const data = await exec(base, ORDERS, { loader: userLoader(base.db) });
  assert.equal(data.orders.length, 10);
  assert.deepEqual(newFindings(base, f), []);
  const users = findsOn(base, w, 'users');
  assert.equal(users.length, 1);
  assert.ok(users[0]!.command.filter._id.$in);
});

test('P3 concurrent operations are attributed separately', async () => {
  const f = base.obs.findings.length;
  await Promise.all([
    exec(base, 'query Naive { orders(limit: 10) { user { name } } }'),
    exec(base, 'query Loaded { orders(limit: 10) { user { name } } }', { loader: userLoader(base.db) }),
  ]);
  const found = newFindings(base, f);
  assert.equal(found.length, 1, JSON.stringify(found.map((x) => [x.context, x.queries])));
  assert.equal(found[0]!.context, 'query Naive');
  assert.equal(found[0]!.queries, 10);
});

test('P4 no upward leak: an outer unit keeps its own commands after awaiting an operation', async () => {
  const f = base.obs.findings.length;
  await base.obs.run('outer', async () => {
    await exec(base, ORDERS, { loader: userLoader(base.db) });
    const list = await base.db.collection<OrderDoc>('orders').find({ status: 'open' }).sort({ n: 1 }).limit(4).toArray();
    for (const o of list) await base.db.collection('users').findOne({ _id: o.userId });
  });
  const found = newFindings(base, f);
  assert.equal(found.length, 1, JSON.stringify(found.map((x) => [x.context, x.queries])));
  assert.equal(found[0]!.context, 'outer');
  assert.equal(found[0]!.queries, 4, 'the GraphQL unit\'s commands are not in the outer unit');
});

test('P5 sampleRate 0: no units, resolvers unaffected', async () => {
  const r = await rig({ sampleRate: 0 });
  const expected = await exec(base, ORDERS);
  const data = await exec(r, ORDERS);
  assert.deepEqual(data, expected);
  assert.deepEqual(r.obs.findings, []);
  assert.equal(r.obs.internalErrors, 0);
});

test('P6 optimize safe: the naive resolver is auto-batched, same data', async () => {
  const r = await rig({ optimize: 'safe' });
  const expected = await exec(base, ORDERS);
  const w = r.wire.length;
  const data = await exec(r, ORDERS);
  assert.deepEqual(data, expected);
  const users = findsOn(r, w, 'users');
  assert.ok(users.length <= 3, `users finds on the wire: ${users.length}`);
  const found = newFindings(r, 0);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.context, 'query Orders');
  assert.ok(found[0]!.autoBatched, 'finding records the auto-batching');
  assert.equal(r.obs.internalErrors, 0);
});

test('P8 leak guard: code still running in an ended unit is attributed to the unit it began in', async () => {
  const f = base.obs.findings.length;
  await base.obs.run('outer', async () => {
    const inner = base.obs.begin('inner')!;
    inner.enter(); // the worst case: entered in this function's own frame, before any await
    await base.db.collection('users').findOne({ name: 'user0' });
    inner.end();
    const list = await base.db.collection<OrderDoc>('orders').find({ status: 'open' }).sort({ n: 1 }).limit(4).toArray();
    for (const o of list) await base.db.collection('users').findOne({ _id: o.userId });
  });
  const found = newFindings(base, f);
  assert.equal(found.length, 1, JSON.stringify(found.map((x) => [x.context, x.queries])));
  assert.equal(found[0]!.context, 'outer');
  assert.equal(found[0]!.queries, 4);
});

test('P9 default resolver calling a method on the source (model classes) is attributed', async () => {
  const db = base.db;
  class OrderModel {
    n: number;
    userId: ObjectId;
    constructor(d: OrderDoc) {
      this.n = d.n;
      this.userId = d.userId;
    }
    user() {
      return db.collection('users').findOne({ _id: this.userId });
    }
  }
  const server = new ApolloServer({
    typeDefs: `#graphql
      type User { name: String! }
      type Order { n: Int! user: User }
      type Query { orders: [Order!]! }`,
    resolvers: {
      Query: { orders: async () => (await db.collection<OrderDoc>('orders').find({}).sort({ n: 1 }).limit(10).toArray()).map((d) => new OrderModel(d)) },
    },
    plugins: [base.obs.apolloPlugin()],
  });
  await server.start();
  try {
    const f = base.obs.findings.length;
    const res = await server.executeOperation({ query: 'query Models { orders { n user { name } } }' });
    assert.ok(res.body.kind === 'single' && !res.body.singleResult.errors);
    const found = newFindings(base, f);
    assert.equal(found.length, 1, JSON.stringify(found.map((x) => [x.context, x.queries])));
    assert.equal(found[0]!.context, 'query Models');
    assert.equal(found[0]!.queries, 10);
  } finally {
    await server.stop();
  }
});

test('P10 resolverSites false: no per-field hook, so a resolver without await has no call site', async () => {
  const server = new ApolloServer<Ctx>({ typeDefs, resolvers: resolvers(base.db), plugins: [base.obs.apolloPlugin({ resolverSites: false })] });
  await server.start();
  try {
    const f = base.obs.findings.length;
    const res = await server.executeOperation({ query: ORDERS }, { contextValue: {} });
    assert.ok(res.body.kind === 'single' && !res.body.singleResult.errors);
    const found = newFindings(base, f);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.callSites, []);
    assert.equal(found[0]!.parent?.callSite, undefined);
  } finally {
    await server.stop();
  }
});

test('P11 an application frame wins over the resolver name', async () => {
  const f = base.obs.findings.length;
  await base.obs.run('outer', async () => {
    const list = await base.db.collection<OrderDoc>('orders').find({}).sort({ n: 1 }).limit(4).toArray();
    for (const o of list) await base.db.collection('users').findOne({ _id: o.userId });
  });
  const found = newFindings(base, f);
  assert.equal(found.length, 1);
  assert.match(found[0]!.callSites[0] ?? '', /apollo\.test\.ts:\d+/);
});
