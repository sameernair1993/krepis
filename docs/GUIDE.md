# Guide

How to install Krepis and use it in an application. For the design behind each feature, see [API](API.md).

- [Requirements](#requirements)
- [Install](#install)
- [The data layer](#the-data-layer)
  - [Connect and declare collections](#connect-and-declare-collections)
  - [Read](#read)
  - [Write](#write)
  - [Relations](#relations)
  - [Aggregation](#aggregation)
  - [Transactions](#transactions)
  - [Safe input](#safe-input)
  - [Multi-tenant scoping](#multi-tenant-scoping)
  - [Indexes](#indexes)
  - [Moving from Mongoose](#moving-from-mongoose)
- [The analyser](#the-analyser)
  - [Attach to your app](#attach-to-your-app)
  - [Find N+1 queries in tests and CI](#find-n1-queries-in-tests-and-ci)
  - [Production sampling](#production-sampling)
  - [Batching N+1 lookups at runtime](#batching-n1-lookups-at-runtime)
- [Connections](#connections)
- [Incident drills](#incident-drills)
- [CommonJS](#commonjs)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Requirements

| | Supported |
|---|---|
| Node.js | 20.19 or later |
| MongoDB driver (`mongodb`, a peer dependency) | 4.17 to 7.x |
| Mongoose, alongside Krepis | 6 to 9 |
| MongoDB server | 7.0 to 9.0 |
| TypeScript (optional) | 5.7 or later; `moduleResolution` `node16`, `nodenext` or `bundler` (legacy `node` also works) |
| Docker | only for `krepis drill` |

## Install

```bash
npm install @sameernair/krepis mongodb            # the data layer
npm install -D @sameernair/krepis-kit             # the analyser, CLI and drills (add it as a regular dependency if it runs in production)
```

`@sameernair/krepis-kit` depends on `@sameernair/krepis`, so installing kit alone also works. (npm refuses the unscoped name `krepis` as too close to `redis`, so both packages are scoped.)

> **To try a change that isn't on npm yet**, install from a build of this repository:
>
> ```bash
> git clone https://github.com/sameernair1993/krepis.git && cd krepis
> npx -y pnpm@10 install && npx -y pnpm@10 build
> (cd packages/krepis && npx -y pnpm@10 pack --pack-destination ../../.packs)
> (cd packages/kit    && npx -y pnpm@10 pack --pack-destination ../../.packs)
> # then, in your app:
> npm install mongodb /path/to/krepis/.packs/sameernair-krepis-<version>.tgz /path/to/krepis/.packs/sameernair-krepis-kit-<version>.tgz
> ```
>
> Pack with pnpm, not npm: kit's dependency on `krepis` is a workspace reference that only pnpm rewrites.

## The data layer

### Connect and declare collections

Krepis uses a `MongoClient` you create and own. It does not open its own connections.

```ts
import { MongoClient } from 'mongodb';
import { createDal, schema, t, type Doc } from '@sameernair/krepis';

const client = new MongoClient(process.env.MONGODB_URI!);
const dal = createDal(client, { dbName: 'shop' });

const userSchema = schema({
  email: t.string().lowercase().trim(),
  name: t.string(),
  passwordHash: t.string().hidden(),            // left out of every read unless selected
  plan: t.enum(['free', 'pro']).default(() => 'free'),
  tags: t.array(t.string()).default(() => []),
  address: t.object({ city: t.string(), zip: t.string().optional() }).optional(),
}, {
  timestamps: true,                             // createdAt and updatedAt, stamped on writes
  indexes: [{ keys: { email: 1 }, unique: true }],
});

export type User = Doc<typeof userSchema>;      // { _id: ObjectId; email: string; ...; createdAt: Date; updatedAt: Date }
export const Users = dal.collection('users', userSchema);

await client.connect();
```

Field types: `t.string()`, `t.number()`, `t.boolean()`, `t.date()`, `t.objectId()`, `t.enum([...])`, `t.array(...)`, `t.object({...})`, `t.mixed()`. Modifiers: `.optional()`, `.default(fn)`, `.hidden()`, `.ref('collection')`, and for strings `.lowercase()` and `.trim()`.

Unknown fields are stripped on write, strings are cast to `ObjectId` where the schema expects one, and validation runs on inserts and updates alike.

### Read

```ts
const user = await Users.findOne({ email: 'ada@example.com' });         // typed User | null, without passwordHash

const page = await Users.find({ plan: 'pro', 'address.city': 'Lisbon' })  // dotted paths are checked too
  .select({ name: 1, email: 1 })                                         // narrows the result type
  .sort({ createdAt: -1 })
  .limit(20)
  .toArray();

const everyone = await Users.find({ plan: 'free' }).all();               // a deliberate unbounded read
const n = await Users.count({ plan: 'pro' });
```

A `find().toArray()` with no `.limit()` throws `KrepisUnboundedReadError`. Use `.all()` when reading everything is intended, or set `createDal(client, { unboundedReads: 'warn' })`.

### Write

```ts
const created = await Users.insertOne({ email: 'Ada@Example.com ', name: 'Ada', passwordHash: hash });
// email is stored as 'ada@example.com'; plan defaults to 'free'; _id, createdAt, updatedAt are returned

await Users.updateOne({ _id: created._id }, { $set: { plan: 'pro' }, $push: { tags: 'beta' } });
await Users.updateMany({ plan: 'free' }, { name: 'renamed' });           // plain keys mean $set
await Users.deleteMany({ tags: 'spam' });

const updated = await Users.findOneAndUpdate({ _id: created._id }, { $set: { name: 'Ada L.' } });
// returns the document after the update by default
```

A value of the wrong type, a value outside an enum, or an update on a field the schema does not have fails to compile, and is also refused at runtime (`KrepisValidationError`, `KrepisCastError`).

Update pipelines are opt-in, through `op.pipeline`, and typed against the schema:

```ts
import { op } from '@sameernair/krepis';
await Orders.updateOne({ _id: id }, op.pipeline([{ $set: { total: { $add: ['$subtotal', '$tax'] } } }]));
```

### Relations

`include` loads related documents in one read per relation per level, never one per row:

```ts
const Orders = dal.collection('orders', schema({
  userId: t.objectId().ref('users'),
  itemIds: t.array(t.objectId()),
  status: t.enum(['pending', 'paid', 'shipped']),
  total: t.number(),
}));

const rows = await Orders.find({ status: 'paid' })
  .limit(50)
  .include({
    user: { from: Users, local: 'userId', select: { name: 1 } },        // row.user: { _id; name } | null
    items: { from: Items, local: 'itemIds' },                            // row.items: Item[]
  })
  .toArray();
```

### Aggregation

`aggregate()` is a typed builder in MongoDB's own stage syntax. Each stage's output type flows into the next:

```ts
const top = await Orders.aggregate()
  .match({ status: 'paid' })
  .group({ _id: '$userId', spent: { $sum: '$total' }, orders: { $count: {} } })
  .sort({ spent: -1 })
  .limit(10)
  .toArray();                                   // { _id: ObjectId; spent: number; orders: number }[]
```

`.pipeline()` returns the stages, if you want to run them elsewhere.

### Transactions

```ts
await dal.transaction(async (tx) => {
  const order = await Orders.findOne({ _id: id });
  await Orders.updateOne({ _id: id }, { $set: { status: 'shipped' } });
  await Stock.updateOne({ sku: order!.sku }, { $inc: { count: -1 } });
  tx.afterCommit(() => emailCustomer(id));      // runs once, only after a successful commit
});
```

Every Krepis call inside the callback joins the transaction without passing a session. Transient errors re-run the callback and an unknown commit result is retried. Transactions need a replica set or sharded cluster.

### Safe input

With `strictInput` (on by default), an operator object where the schema expects a scalar is refused:

```ts
await Users.findOne({ email: req.body.email });
// req.body.email = { "$ne": null }  →  throws KrepisInputError instead of matching the first user
```

Operators you mean are built with `op`, and text search from input goes through `match`, which escapes it:

```ts
import { op, match } from '@sameernair/krepis';

await Users.find({ createdAt: op.gte(since), plan: op.in(['free', 'pro']) }).limit(20).toArray();
await Users.find({ name: match.prefix(req.query.q) }).limit(20).toArray();     // also match.contains
```

`$where`, `$function` and `$accumulator` are refused unless the object holding them was built with `op(...)` in code.

### Multi-tenant scoping

One `scope` function per collection filters every read, stamps every insert and sanitises every update:

```ts
const Projects = dal.collection('projects', projectSchema, {
  scope: () => {
    const tenantId = currentTenant();           // e.g. from AsyncLocalStorage
    return { filter: { tenantId }, stamp: (doc) => { doc.tenantId = tenantId; } };
  },
});
```

### Indexes

Indexes declared in schemas are not created on boot. Run this at deploy time:

```ts
await dal.ensureIndexes();
```

### Moving from Mongoose

`fromMongoose` shares Mongoose's connection: one pool, one driver. Collections can then move one at a time while the rest stay on Mongoose.

```ts
import mongoose from 'mongoose';
import { fromMongoose, schema, t } from '@sameernair/krepis';

const dal = fromMongoose(mongoose);             // may be called before mongoose.connect()
export const Tokens = dal.collection('tokens', schema({ userId: t.objectId(), token: t.string() }));
```

For code written against Mongoose models, `@sameernair/krepis/compat` gives a Mongoose-shaped API (`create`, `find`, `findOne`, `countDocuments`, `updateOne`/`updateMany`, `deleteOne`/`deleteMany`, `findOneAndUpdate`, `findOneAndDelete`, `aggregate`, and `select`, `sort`, `skip`, `limit`, `lean` on queries; not `findById` or `populate`) over a Krepis collection:

```ts
import { mongooseModel } from '@sameernair/krepis/compat';
export const Token = mongooseModel(Tokens);
```

Differences from Mongoose that can affect a migration:
- results are plain objects;
- there is no `__v`;
- validators always run on updates;
- `findOneAndUpdate` returns the updated document by default;
- an unbounded read throws.

See [API → Prototype](API.md#prototype-what-krepis-implements-today) for the full list.

## The analyser

### Attach to your app

```ts
import { MongoClient } from 'mongodb';
import { observe } from '@sameernair/krepis-kit';

const client = new MongoClient(uri);
const observer = observe(client, { capture: true });   // write findings for `krepis analyze`
await client.connect();
```

With Mongoose, attach to its client: `observe(mongoose.connection.getClient())` after `mongoose.connect()`, or `observe(conn.getClient())` after `mongoose.createConnection()`.

Commands are analysed per **unit of work**, a request or a job. Tell Krepis where units begin and end:

```ts
app.use(observer.middleware());                                     // Express/Connect: one per request
new ApolloServer({ schema, plugins: [observer.apolloPlugin()] });   // GraphQL: one per operation
await observer.run('job sync-users', () => syncUsers());            // anything else with a callback
```

Commands outside a unit of work are not analysed and cost almost nothing.

To see findings as they happen instead of capturing them:

```ts
import { formatFinding } from '@sameernair/krepis-kit';
observe(client, { onFinding: (f) => console.warn(formatFinding(f)) });
```

### Find N+1 queries in tests and CI

Turn on capture for the test run, run the suite, then analyse:

```bash
npx krepis init                       # once: creates .krepis/ and adds it to .gitignore
KREPIS_CAPTURE=1 npm test             # or observe(client, { capture: true }) in your test setup
npx krepis analyze                    # N+1 patterns, grouped across requests, with call sites and a fix
npx krepis analyze --fail             # exit 1 if any N+1 is found: use this in CI
```

Repeated lookups that are not N+1 (`KR-P012`) are listed separately and never fail the build. `--json` gives machine-readable output, and `--rtt 1,20,50` projects the cost at those round-trip times.

### Production sampling

```ts
observe(client, { sampleRate: 0.01 });    // analyse 1% of units of work
```

Unsampled units run with no context and pay only one context lookup per command. A sampled 100-document read costs about 12 µs of client CPU on the machine `packages/kit/bench/overhead.ts` was run on; measure your own. Krepis's handlers are wrapped so that an internal error is counted, not thrown into your code, and `KREPIS_DISABLED=1` turns it off without a deploy.

### Batching N+1 lookups at runtime

```ts
observe(client, { optimize: 'safe' });
```

Inside a unit of work, a loop of `_id` lookups driven by an earlier read is answered from one `$in` prefetch, and identical reads are answered once. The semantics are those of a per-request DataLoader cache. Every N+1 is still reported. This needs driver 6.1 or later (with Mongoose, Mongoose 8 or later); on older drivers detection still works and optimisation is skipped with a warning.

## Connections

```ts
import { checkConnectionOptions, watchConnections, formatConnectionFinding, TenantPools } from '@sameernair/krepis/connections';

// At startup: flag risky pool settings for your deployment.
for (const f of checkConnectionOptions({ client, deployment: { tier: 'M10' }, fleet: { instances: 6 } })) {
  console.warn(formatConnectionFinding(f));
}

// At runtime: watch pool events for churn, auth failures and idle drops.
watchConnections(client, { deployment: { tier: 'M10' }, onFinding: (f) => console.warn(formatConnectionFinding(f)) });

// Multi-tenant apps: one client per tenant, with a login circuit breaker, a storm governor and overload shedding.
const pools = new TenantPools({ appName: 'orders-api', resolve: async (tenant) => ({ uri: await secretFor(tenant) }) });
const tenantClient = await pools.get('acme');
```

Details and every rule: [Connections](CONNECTIONS.md).

## Incident drills

`krepis drill` runs your own connection code through real faults on a disposable MongoDB in Docker, and judges it on server counters. Create `krepis.drill.ts`:

```ts
import { defineDrill } from '@sameernair/krepis-kit/drill';
import { TenantPools } from '@sameernair/krepis/connections';

export default defineDrill({
  tenants: 10,
  setup(ctx) {                                   // build clients exactly as production does
    const pools = new TenantPools({ appName: 'orders-api', resolve: (t) => ({ uri: ctx.uri(t) }) });
    return { client: (t) => pools.get(t), close: () => pools.closeAll() };
  },
});
```

```bash
npx krepis drill                                       # every scenario; exit 1 if any fails
npx krepis drill --scenario credential-rotation,idle   # a subset
```

Scenarios: credential rotation, auth outage, restart, slow node, overload (two variants), network blip, idle, and on a three-member replica set: step-down, primary crash and rolling restart. A full run takes about 13 minutes.

## CommonJS

Every entry point works with `require` as well as `import`:

```js
const { createDal, schema, t } = require('@sameernair/krepis');
const { TenantPools } = require('@sameernair/krepis/connections');
const { observe } = require('@sameernair/krepis-kit');            // needs Node 20.19+ (require of ES modules)
```

Bundling to ESM with esbuild while keeping `mongodb` external needs this banner, because Krepis `require()`s the driver: `--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"`.

## Environment variables

| Variable | Effect |
|---|---|
| `KREPIS_DISABLED=1` | The analyser attaches nothing; `observe()` returns an inert observer. |
| `KREPIS_CAPTURE=1` or a directory | Turns on capture without code changes (default directory `.krepis/`). An explicit `capture: false` wins. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `KrepisUnboundedReadError` | A `find()` without `.limit()`. Add a limit, or call `.all()` if reading everything is intended. |
| `KrepisInputError` on a filter | An operator object reached a scalar field: usually request input. Validate the input, or build intended operators with `op`. |
| No findings from the analyser | The queries ran outside a unit of work. Add the middleware, the Apollo plugin, or wrap the code in `observer.run()`. |
| Warning `KREPIS_LATE_OBSERVE` | The analyser fell back to client-wide monitoring and `observe()` ran after `connect()`. Call `observe()` before `connect()`. |
| Warning `KREPIS_OPTIMIZE_CALLBACK_DRIVER` | `optimize` is skipped on driver 4.x, 5.x and 6.0. Detection still works. |
| Type error passing `mongoose` to `fromMongoose` (`Db` not assignable) | Two copies of `mongodb` are installed: Mongoose pins its own minor (Mongoose 9.10 uses `~7.6`). Install the `mongodb` version your Mongoose uses so there is one copy (`npm ls mongodb` shows them). |
| Wrong `ObjectId` class errors | The client comes from a different copy of `mongodb`. Pass `createDal(client, { bson: { ObjectId } })` from that copy. |
