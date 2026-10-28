<p align="center"><img src="docs/public/logo.svg" alt="Krepis logo: a database on three stone steps" width="88"></p>

<h1 align="center">Krepis</h1>

<p align="center">A typed data layer for MongoDB on Node.js, and an analyser that looks for N+1 queries in an existing app.</p>

> **Status: alpha.** Built, tested and published to npm, but not yet used in production. APIs may change before v0.1. Feedback and issues are welcome.

## What it is

Two packages:

| Package | What it is | Use it when |
|---|---|---|
| **`@sameernair/krepis`** | A typed data access layer over the official MongoDB driver, with safe defaults. Includes `@sameernair/krepis/connections` for per-tenant client pools and connection checks. | You are writing new code, or moving off Mongoose one collection at a time. |
| **`@sameernair/krepis-kit`** | An analyser you attach to an existing driver or Mongoose client, plus the `krepis` CLI and connection drills. | You want to look for N+1 queries in an app without changing its data code. |

They work independently. A reasonable way to try Krepis is to run the analyser on an app you already have, then decide whether the data layer is worth adopting.

## Why

Some MongoDB mistakes are easy to make and hard to notice until later:

- **Operator injection.** `find({ token: req.body.token })` matches any document when the body holds `{ "$ne": null }`.
- **N+1 queries.** A loop that runs `findOne` per row looks fine in review and in tests, and costs one round trip per row in production.
- **Unbounded reads.** `find().toArray()` with no limit works on a small collection and struggles on a large one.
- **Leaked fields.** A field like `passwordHash` comes back on every read unless someone remembers to exclude it.
- **Connection storms.** A credential rotation or a restart can make every tenant reconnect and log in at once.

Krepis tries to make the safe path the default one, and to back each behaviour with a test.

## Install

```bash
npm install @sameernair/krepis mongodb        # the data layer; mongodb is a peer dependency
npm install -D @sameernair/krepis-kit         # the analyser and the `krepis` CLI
```

Requires Node.js 20.19+, the `mongodb` driver 4.17 to 7.x (or Mongoose 6 to 9), and MongoDB server 7.0+. ESM and CommonJS both work.

## The data layer (`@sameernair/krepis`)

```ts
import { MongoClient } from 'mongodb';
import { createDal, schema, t, op, match } from '@sameernair/krepis';

const client = new MongoClient(process.env.MONGODB_URI!);
const dal = createDal(client, { dbName: 'shop' });

const Users = dal.collection('users', schema({
  email: t.string().lowercase().trim(),
  passwordHash: t.string().hidden(),          // left out of reads unless selected by name
  plan: t.enum(['free', 'pro']),              // checked on every write
}, { timestamps: true }));

const Orders = dal.collection('orders', schema({
  userId: t.objectId().ref('users'),
  status: t.enum(['pending', 'paid', 'shipped']),
  total: t.number(),
}));

// MongoDB's own filter syntax, typed from the schema.
const recent = await Orders.find({ status: 'paid' })
  .sort({ _id: -1 })
  .limit(50)                                   // a read with no limit throws; .all() states the intent
  .include({ user: { from: Users, local: 'userId' } })   // one batched read for the relation
  .toArray();

// An operator object from a request body throws KrepisInputError.
// Operators you mean are built with `op`; `match` escapes text-search input.
await Users.count({ email: match.prefix(req.query.q), plan: op.in(['pro']) });

// An aggregation builder in native stage syntax, with a typed result.
const top = await Orders.aggregate()
  .group({ _id: '$userId', spent: { $sum: '$total' } })
  .sort({ spent: -1 })
  .limit(10)
  .toArray();                                   // { _id: ObjectId; spent: number }[]

// Transactions without passing a session around.
await dal.transaction(async (tx) => {
  await Orders.updateOne({ _id: id }, { $set: { status: 'shipped' } });
  tx.afterCommit(() => notify(id));            // runs once, after the commit
});
```

- **Types.** Filters, updates (including array operators), projections, `include`, the aggregation builder and update pipelines are checked against the schema.
- **Defaults.** Strict input, required limits, hidden fields and enums are on by default. Server-side JavaScript is refused unless it is written in code.
- **Relations.** `include` loads each relation with one read per level. `packages/krepis/bench/include.ts` compares it with Mongoose's `populate`.
- **Multi-tenant scoping.** A `scope` hook per collection filters reads, stamps inserts and sanitises updates.
- **Moving from Mongoose.** `fromMongoose(mongoose)` shares Mongoose's connection, so collections can move one at a time. `@sameernair/krepis/compat` offers a Mongoose-shaped model API.
- **Escape hatch.** `collection.raw()` returns the underlying driver collection, for anything Krepis does not cover.

## The analyser (`@sameernair/krepis-kit`)

```ts
import { observe } from '@sameernair/krepis-kit';

const observer = observe(client, { capture: true });   // before client.connect(); with Mongoose: mongoose.connection.getClient()
app.use(observer.middleware());                          // Express: one unit of work per request
new ApolloServer({ schema, plugins: [observer.apolloPlugin()] }); // GraphQL: one per operation
```

```bash
npx krepis init             # adds .krepis/ to .gitignore
npm test                    # run the app or its tests with capture on
npx krepis analyze          # N+1 patterns, with the call site and a suggested fix
npx krepis analyze --fail   # exit 1 when one is found, for CI
```

- **Evidence for each finding.** An N+1 finding needs proof that an earlier read supplied the looked-up values. Lookups that only repeat are listed separately, as information.
- **In tests and CI.** `expectQueries(observer, { max: 3 }, fn)` fails a test that issues too many queries. `--baseline` fails only on new findings, and `--format markdown` or `sarif` writes a pull request summary or a code scanning report.
- **Security signals by default.** A call site that receives operator objects where it otherwise receives values (operator injection signal) and server-side JavaScript are reported without configuration.
- **Opt-in checks.** `explain: true` reports collection scans, in-memory sorts and unindexed `$lookup`s with a suggested index. `hazards: true` adds unanchored regular expressions, sensitive-looking fields in results and large reads without a limit.
- **Frameworks.** Express and NestJS on Express, Fastify, Koa, Hono and Apollo Server.
- **Optional runtime batching.** With `optimize: 'safe'`, `_id` lookups in a loop within one request are batched and identical reads are answered once. `packages/kit/bench/autobatch.ts` measures the effect.
- **Overhead.** Commands outside a unit of work are not analysed, and `sampleRate` limits how many units are. `packages/kit/bench/overhead.ts` measures the cost on your machine. The handlers are wrapped so that an internal error is counted rather than thrown into your app, and `KREPIS_DISABLED=1` turns it off.
- **Privacy.** Captures hold query shapes, not values, and stay on your machine.

## Connections and drills

- **`@sameernair/krepis/connections`:** a static check of client options, a pool watcher, a duplicate-client watcher, and `TenantPools`, a per-tenant client cache with a login circuit breaker, a cluster-wide governor for login storms, and shedding when a node refuses new connections.
- **`krepis drill`** runs your own connection code through incidents (credential rotation, auth outages, restarts, slow nodes, network blips, connection limits, step-downs) against a throwaway MongoDB container, and exits 1 on failure.

## Limitations

- Alpha releases only, and not yet used in production by anyone.
- CI runs the test suite against MongoDB 8.0 only. The 7.0 and 9.0 server runs are done locally before a release.
- The analyser's default finding is N+1 (with repeated lookups as information). The index and hazard checks are opt-in and have not yet been measured on the reference codebases. See [Rules](docs/RULES.md).
- Krepis works at the database layer. It does not replace validation, authentication or access control in your app.

## Documentation

| Document | Contents |
|---|---|
| [Guide](docs/GUIDE.md) | **Start here:** install, the data layer, the analyser, connections, drills, troubleshooting |
| [API](docs/API.md) | The data layer: schema, queries, relations, pipelines, transactions, safety |
| [Connections](docs/CONNECTIONS.md) | Pool checks, Atlas limits, breaker, governor, shedding, drills |
| [Rules](docs/RULES.md) | The rules Krepis checks, with their evidence and thresholds |
| [Security](docs/SECURITY.md) | MongoDB-specific protections and Krepis's own security |
| [Privacy](docs/PRIVACY.md) | What is captured, what never is, where it lives |
| [Architecture](docs/ARCHITECTURE.md) | How the parts fit together, fingerprinting, the capture format |
| [Contributing](CONTRIBUTING.md) | Setup, repository layout, testing rules |

The same documentation is published as a website with GitHub Pages.

## The name

**κρηπίς (krepis)** is the stepped stone platform a Greek temple stands on. The logo is a database resting on those three steps.

## License

[MIT](LICENSE)

Krepis is an independent project and is not affiliated with or endorsed by MongoDB, Inc. MongoDB and Atlas are trademarks of MongoDB, Inc.
