# API

The data layer in `@sameernair/krepis`, and observe mode in `@sameernair/krepis-kit`. For connection helpers, see [Connections](CONNECTIONS.md).

## Design principles

1. **MongoDB-native.** Filters, updates and pipeline stages use MongoDB's own syntax, fully typed from the schema. There is no new query language.
2. **The naive path is a good path.** Defaults are safe and efficient: relations are batched, reads are bounded, inputs are checked, sensitive fields are hidden.
3. **Escape hatch always available.** `collection.raw()` returns the underlying driver collection for anything Krepis doesn't cover.
4. **Built on the official driver.** Krepis never reimplements the wire protocol, server selection or pooling.

## Overview

A model moved from Mongoose looks like this:

```ts
import { fromMongoose, schema, t, type ObjectId, type TypedSchema } from '@sameernair/krepis';

export interface Token { _id: ObjectId; userId: ObjectId; email?: string; createdAt: Date; /* … */ }
export const tokenSchema: TypedSchema<Token> = schema({
  userId: t.objectId().ref('users'),
  email: t.string().lowercase().trim().optional(),
  createdAt: t.date().default(() => new Date()),
}, { indexes: [{ keys: { createdAt: 1 }, expireAfterSeconds: 0 }] });

const Tokens = fromMongoose(mongoose).collection('tokens', tokenSchema, { scope: tenantScope });
```

- **`fromMongoose(mongoose)`** borrows Mongoose's connected client, so there is one pool and both libraries run against the same data during migration. Collections move one at a time. Each collection is also registered in `mongoose.connection.collections`, so Mongoose-side code that iterates it (e.g. a "clear every collection" test teardown) still sees it.
- **Mongoose behaviours kept:** unknown fields are stripped; a plain-key update means `$set`; defaults apply on upsert insert; `timestamps`; `lowercase`/`trim` run on writes *and* query values; strings are cast to ObjectId.
- **Deliberate differences:**
  - validators always run on updates;
  - `findOneAndUpdate` returns the updated document by default; `findOneAnd*` return the document or `null` on every driver from 4.17 to 7;
  - no `__v`;
  - results are plain objects;
  - no autoIndex (`ensureIndexes()` is explicit);
  - an unbounded `find(...).toArray()` throws; `.all()` states the intent.
- **`scope` hook:** one function per collection injects a filter, stamps inserts and sanitises updates. An update the hook drops entirely matches nothing; it is never widened.
- **Typed paths:** filters, updates (including `$push`/`$addToSet`/`$pull`/`$pullAll`/`$mul` and positional `$`, `$[]`, `$[id]`), sorts and projections check dotted paths and their value types; `select()` and `projection` narrow the result type. A projection built at runtime (`Record<string, 0>`) has no literal keys, so it is not key-checked and the row keeps the full document type.
- **`aggregate()`:** a typed builder in native stage syntax; see [Aggregation pipelines](#aggregation-pipelines).
- **`include()`:** typed relation loading in one batched read per relation per level; see [Relations without N+1](#relations-without-n1).
- **`dal.transaction(fn)`:** operations join without a session argument; parallel first operations are safe; retries are built in; `afterCommit` hooks run once. See [Transactions](#transactions).
- **`TypedSchema<Entity, DefaultKeys>`:** under `isolatedDeclarations`, an inferred schema cannot be exported (TS9010), and this applies to zod-style APIs generally. Declaring the interface and annotating the schema is checked invariantly, so an interface that disagrees with the schema in either direction (fields, types, the key set, or an undeclared default) fails to compile. Without `isolatedDeclarations`, `Doc<typeof s>` infers the type and no interface is needed.
- **Errors** (`KrepisValidationError`, `KrepisCastError`, `KrepisUnboundedReadError`) work with `instanceof` even when an app resolves two installed copies of Krepis. Each carries a registry-symbol brand, so the check does not depend on which copy created the error.
- **`createDal(client)` and `ObjectId`:** the DAL builds ids with the `mongodb` package it resolves. If your client comes from a different copy of the driver (for example, one nested under another package), pass `bson: { ObjectId }` from that copy. `fromMongoose` does this for you with `mongoose.mongo.ObjectId`.
- **Packaging:**
  - Two packages: `@sameernair/krepis` is the data layer (root) and `@sameernair/krepis/connections`; `@sameernair/krepis-kit` is the analyser (root), the CLI and `@sameernair/krepis-kit/drill`, and depends on `@sameernair/krepis`. Importing the data layer loads no connections code.
  - The data layer, `@sameernair/krepis/connections` and `@sameernair/krepis-kit/drill` are one CommonJS implementation. Their ESM entry points are thin wrappers over it, so `import` and `require` return the same classes.
  - Bundling to ESM with esbuild while leaving `mongodb` external needs the usual banner, because the implementation `require()`s the driver: `--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"`. Rollup, and esbuild with `--format=cjs`, need nothing.
  - The analyser root (`@sameernair/krepis-kit`) is ESM-only; CommonJS loads it with `require()` through Node's `require(esm)`, hence `engines: node >=20.19`.
  - Types resolve under `moduleResolution` `node16`/`nodenext`, `bundler` and the legacy `node`.
  - Supported: drivers 4.17 to 7 and Mongoose 6 to 9 alongside `fromMongoose` (tested in `packages/krepis/test/dalMatrix.test.ts`), and servers 7.0, 8.0, 8.3 and 9.0 (CI runs 8.0; the others are run locally before a release).

## Creating a data layer

```ts
import { MongoClient } from 'mongodb';
import { createDal, fromMongoose } from '@sameernair/krepis';

const client = new MongoClient(uri, { appName: 'orders-api' });
const dal = createDal(client, {
  dbName: 'shop',
  strictInput: true,          // operator-injection protection (default: true)
  unboundedReads: 'error',    // 'error' | 'warn' | 'allow' (default: 'error')
});

// or, alongside Mongoose, sharing its connection:
const dal2 = fromMongoose(mongoose, { strictInput: true });
```

You create and own the `MongoClient`; Krepis does not open connections itself. Use one client per process, or one per tenant with `TenantPools` below.

### Multi-tenant connections

Apps with a database or cluster per tenant legitimately need one pool per tenant. `TenantPools` in `@sameernair/krepis/connections` manages them.

```ts
import { TenantPools, TenantLoginsFailingError, ClusterRefusingConnectionsError } from '@sameernair/krepis/connections';

const tenants = new TenantPools({
  appName: 'orders-api',                       // required: attributes connections and failed logins
  resolve: async (tenantId) => {
    const t = await tenantCatalog.lookup(tenantId);
    return { uri: t.uri, options: { auth: t.auth } };  // re-read every credentialCheckMs, and every 5 s while a breaker is open
  },
  // defaults: minPoolSize 0, maxPoolSize 10, maxIdleTimeMS 300000, serverMonitoringMode 'poll'
  evictIdleMs: 10 * 60_000,   // close clients for tenants with no recent traffic
  maxPools: 100,              // least recently used client is retired first
  breaker: { mode: 'enforce' }, // 3 auth failures in 60 s → close the client, fail fast, probe after 5 s → 300 s
  // governor, on by default: 3+ tenants of one cluster failing in 10 s is a storm → trip on the first failure,
  // one canary probe per cluster instead of one per tenant, 10 probes/s per cluster
  // overload shedding, on by default: 3+ tenants of one cluster refused connections in 10 s, by a node still
  // answering, so a dead member does not count → park tenants with no established connection (client closed,
  // get() throws ClusterRefusingConnectionsError), admit 2 at a time
  onEvent: (e) => logger.info(e),
});

const client = await tenants.get(tenantId);    // one client per tenant, created once, reused
```

Options that would cause login churn (`KR-C008` at error level, or tenant arithmetic over the node limit) are refused with `KrepisConnectionConfigError` before anything connects; `allowUnsafeOptions: true` overrides. For Mongoose, pass `open: (uri, o) => mongoose.createConnection(uri, o).asPromise()`, `clientOf: (c) => c.getClient()` and `close: (c) => c.close()`.

The governor's options are `breaker.storm` (`false` to disable), `breaker.credentialPollMs` and `breaker.probesPerSecond` (CONNECTIONS → Governor). Its events are `stormStarted`, `stormEnded` and `canary`, and `stats().storms` lists clusters in a storm.

Overload shedding is configured by `overload` (`false` to disable; `mode`, `minTenants`, `windowMs`, `quietMs`, `admitPerSecond`, `maxColdTenants`; CONNECTIONS → Overload shedding). Its events are `overloadStarted` and `overloadEnded` (with `shed` and `parked` counts), parked tenants are `retired` with reason `overload`, and `stats().overloaded` lists overloaded clusters. `overloadStarted` names the refusing `nodes`, which are only nodes that were still answering.

Both fail-fast errors are named for the database fact, not for Krepis. Each carries `key`, `cluster`, `retryAfterMs` (for HTTP 503 `Retry-After`), `source: 'krepis'` and the driver's own error as `cause`:

| error | `code` | thrown when | extra fields |
|---|---|---|---|
| `ClusterRefusingConnectionsError` | `MONGODB_CLUSTER_REFUSING_CONNECTIONS` | a shed `get`, without contacting the node | `nodes`, `refusedTenants`, `since` |
| `TenantLoginsFailingError` | `MONGODB_TENANT_LOGINS_FAILING` | `get` while the tenant's breaker is open | `storm` (other tenants of the cluster are failing too) |

Neither subclasses the driver's errors, so label-based retry code does not retry them at once.

The combined size of pools opened through `TenantPools` is checked by `KR-C007`.

Pass `monitor: new IncidentMonitor({ recorder: { dumpDir } })` to label every tenant's client with its tenant key for KR-I001/I002 and the flight recorder (CONNECTIONS → Incident monitor). A tenant's own findings also arrive through `onEvent` as `{ type: 'finding', key }`. Findings that span tenants, a fleet I001 (`client: '*'`, with the tenants in `clients`) or an I002, arrive only through the monitor's `onFinding`.

To check how a connection setup survives credential rotation, restarts, slow nodes, a node refusing connections, network blips, idleness and replica-set failovers (step-down, primary crash, rolling restart) before it ships, wrap it in `defineDrill({ setup: (ctx) => ({ client, close }) })` from `@sameernair/krepis-kit/drill` and run `npx krepis drill` in CI (CONNECTIONS → Drill). For Mongoose, return the connection from `client`: the drill watches `getClient()` itself. Supply `op` to drive your real queries.

## Schema

```ts
import { schema, t } from '@sameernair/krepis';

const Users = dal.collection('users', schema({
  email: t.string().lowercase().trim(),
  passwordHash: t.string().hidden(),
  plan: t.enum(['free', 'pro']),
  orgId: t.objectId().ref('orgs'),
  address: t.object({ city: t.string(), country: t.string() }).optional(),
  tags: t.array(t.string()),
}, {
  timestamps: true,
  indexes: [{ keys: { email: 1 }, unique: true }, { keys: { plan: 1, _id: -1 } }],
}));
```

- **`t.enum(values)`** types the field as the literal union of `values` (no `as const` needed). Every write checks membership at any depth: insert, defaults, `$set`, `$setOnInsert`, `$push`/`$addToSet`, positional paths and `$min`/`$max`. A non-member throws `KrepisValidationError` with the path. `trim`/`lowercase` run first, then one coercion (`'2'` ↔ `2`). `$inc` and `$mul` are rejected, by the types and at runtime. Reads never enforce membership, so documents written before a member was removed stay reachable (cast the value to query them). For a TS string enum, use `t.enum(Object.values(Plan))`; for a numeric enum, list the numbers.
- **`.optional()`** distinguishes "may be missing" from "may be null".
- **`.hidden()`** fields are left out of every read unless a projection names them with `1`: `find`, `findOne`, `findOneAndUpdate`, `findOneAndDelete`, `include` targets, and aggregates. In an aggregate, filtering and sorting on a hidden field work. An `$unset` is placed before the first stage that does more than `$match`, `$sort`, `$limit`, `$skip` or `$sample`, so `$$ROOT`, `$facet` and `$push` never carry the field. A stage from there on that names it, by key or `$field` reference, opts in. `distinct()` on a hidden field returns its values, since naming the field opts in. Filters and writes still see them. Reads type the field as optional, because it is absent unless selected; inserts still require it. Top-level fields only.
- **`.ref('orgs')`** records the collection a field refers to.
- **Indexes** are declared next to the schema and created by `ensureIndexes()`, explicitly; nothing is created on startup.

## Queries

```ts
const page = await Orders
  .find({ status: 'paid', total: op.gte(100) })     // typed MongoDB filter; operators on scalar fields go through op
  .select({ total: 1, userId: 1 })                   // typed projection; result type narrows
  .sort({ _id: -1 })
  .limit(50)
  .toArray();

const one = await Users.findOne({ email });          // typed by schema
const n = await Orders.count({ status: 'pending' });
```

- **Bounded reads:** with `unboundedReads: 'error'` (the default), `toArray()` on a `find` without `limit` throws `KrepisUnboundedReadError`; `'warn'` emits a process warning instead. `.all()` reads everything on purpose, and `.cursor()` streams large results.
- **Writes:** `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `findOneAndUpdate`, `findOneAndDelete` and `bulkWrite`, with typed update operators. An operator with nothing it can name rejects every key, so `$push` on a schema without arrays does not compile.
- **Update pipelines** are opt-in: `updateOne(f, op.pipeline([{ $set: { total: { $multiply: ['$price', '$qty'] } } }]))`. The same works in `updateMany`, `findOneAndUpdate` and `bulkWrite`; compat takes Mongoose's `updatePipeline: true`.
  - **Allowed stages:** `$set`, `$addFields` and `$unset`, on paths of the schema. An unknown path throws `TypeError`.
  - **Not cast or validated:** values are computed on the server. A value from input must be wrapped in `{ $literal: value }`, because a string starting with `$` is a field path in a pipeline.
  - **Typed when written inline** in a write call, or assigned to a variable declared `UpdatePipeline<Doc<typeof schema>>`. Paths, `$` references and the type of each value are checked, so `{ owner: input }` with a string `input` is a type error where `owner` is an `ObjectId`. A path through an array names a field of every element, so an index (`items.0.n`) is refused.
  - **Timestamps:** `updatedAt` is set.
  - **Refused:** `upsert`, scopes with an `update` hook, and other stages (use `raw()`).
  - **Not an object:** any other array, string or `null` passed as an update throws `KrepisInputError`.

## Relations without N+1

Built:

```ts
const rows = await Posts.find({ status: 'live' })
  .limit(100)
  .include({
    author: { from: Users, local: 'authorId', select: { name: 1 },
              include: { org: { from: Orgs, local: 'orgId' } } },   // nested: one more read
    tags: { from: Tags, local: 'tagIds' },                          // array of ids → Tag[]
    comments: { from: Comments, foreign: 'postId', sort: { at: -1 }, limit: 3 },  // 3 per post
  })
  .toArray();
// rows[0].author: (User & { org: Org | null }) | null; rows[0].tags: Tag[]; rows[0].comments: Comment[]
```

- **Cost is fixed:** one read for the parents plus one per relation per level, whatever the number of parents. Values are deduplicated and sent as one `$in` (split at 5,000).
- **Cardinality:**
  - Forward (`local`, matching the target's `_id`): one id → `T | null`; an array of ids → `T[]`, in the stored order, repeating duplicates and dropping ids that match nothing (as Mongoose `populate` does).
  - Many (`foreign` other than `_id`; `local` defaults to `_id`): `T[]`. It must carry `limit` (per parent) or `all: true`, otherwise it follows the target's `unboundedReads` policy, which throws by default before anything is read.
  - Naming the relation after its `local` field replaces the id in place. A missing id stays missing, as in Mongoose.
- **Through the target collection:** its schema casts the parent's values (ids stored as strings still match) and its `scope` hook applies, so a tenant cannot include another tenant's documents.
- **`select`, `where`, `sort`** apply to the included read. Fields a relation needs to match are read even when a `select` leaves them out, and removed again afterwards.
- **Per-parent `limit`** uses one aggregate (`$topN`, or `$firstN` without `sort`), so it needs MongoDB 5.2+. When the `foreign` field is an array, the limit applies per value in it.
- **Types:** `local`, `foreign`, `select` and `where` keys are checked against the right schema, including nested relations, and the result type carries each relation.
- **Not supported:** `cursor()` with `include()` (throws), and `limit`/`sort` on a forward relation (throws: a forward relation returns what the ids reference).
- **Measured:** 1,000 parents × 1 relation, median of 30: Krepis 9.5 ms, Mongoose 9 `populate().lean()` 10.6 ms, hydrated `populate()` 12.9 ms (`bench/include.ts`). The time is mostly the wire and BSON decoding, so the gap is modest; the fixed cost and the checks above are the point.

## Aggregation pipelines

Built. Stages are MongoDB's own stage objects; each one's output type is inferred from the object:

```ts
const top = await Orders.aggregate()
  .match({ status: 'paid', 'shipping.country': 'NZ' })      // typed dotted path, cast by the schema
  .group({ _id: '$userId', total: { $sum: '$total' }, n: { $sum: 1 } })
  .sort({ total: -1 })                                       // only fields the group produced
  .limit(10)
  .lookup({ from: Users, localField: '_id', foreignField: '_id', as: 'user',
            pipeline: (p) => p.project({ _id: 0, name: 1 }) })
  .toArray();
// top: { _id: ObjectId; total: number; n: number; user: { name: string }[] }[]
```

- **Typed stages:** `match`, `sort`, `limit`, `skip`, `sample`, `group`, `project`, `addFields`/`set`, `unset`, `unwind`, `lookup`, `count`, `replaceWith`. A misspelled field reference, an accumulator over the wrong type, or a field a previous stage removed is a compile error at the field.
- **`stage<T>(raw)`** is the escape hatch for anything else. It refuses `$lookup`, `$graphLookup`, `$unionWith`, `$out` and `$merge`, which would bypass scope.
- **Running:** `toArray()` follows `unboundedReads` unless the pipeline has `$limit`, `$count` or `$sample`. `all()` reads everything on purpose; `first()` appends `$limit: 1`; `cursor()` streams; `pipeline()` returns the stages without running them. Builders are immutable.
- **Scope:** a scoped collection's scope is the first stage, and `lookup()` into a scoped collection carries that collection's scope into the join.
- **Casting:** `$match` values are cast by the schema only before the first reshaping stage (anything other than `$match`, `$sort`, `$limit`, `$skip`, `$sample`). After that, documents no longer have the schema's shape, so values are sent as written.
- **Transactions:** inside `dal.transaction` the aggregate joins the transaction.
- **Limits:** `unwind` takes top-level arrays; `addFields` keys cannot be dotted; `$map`, `$reduce` and `$mergeObjects` are typed `unknown`.
- **Measured:** wire-identical to the raw driver; +0.5–1.7% on a `$group` over 10k documents, +3.1–5.0% on 100 posts with a `$lookup` (`bench/aggregate.ts`).

## Transactions

Built.

```ts
const order = await dal.transaction(async (tx) => {
  const o = await Orders.findOneAndUpdate({ _id }, { status: 'paid' });
  await Ledger.insertOne(entry);
  tx.afterCommit(() => queue.publish('order.paid', o));
  return o;
});
```

- **No session argument.** Every Krepis operation started inside the callback joins the transaction, including ones in functions the callback calls, so Krepis calls cannot forget `{ session }`. Raw-driver and Mongoose calls still need it (see Limits below).
- **Parallel operations work.** With a plain driver session, `Promise.all` as the *first* operations of a transaction can fail: the operations race to start the transaction on the server (20 of 20 trials failed on driver 7.7). Krepis runs operations one at a time until the first succeeds, then lets them run in parallel; `packages/krepis/test/transaction.test.ts` checks this over 20 trials.
- **Retries:**
  - a `TransientTransactionError` re-runs the whole callback with jittered backoff;
  - an `UnknownTransactionCommitResult` retries only the commit;
  - `tx.attempt` says which attempt is running.

  The callback may run more than once, so side effects belong in `afterCommit`.
- **`afterCommit(fn)`:** hooks run once, in order, only after the successful attempt commits, and outside the transaction. A failed attempt's hooks are discarded. A hook that throws emits a `KrepisWarning` and does not fail the call, because the data is already committed.
- **`timeoutMs` (default 60 s)** is a deadline for the whole call, retries included. An operation started after it throws `TransactionTimeoutError`, and the transaction aborts even if the callback catches that error.
- **Late operations are refused.** An un-awaited operation that runs after its transaction ended throws `TransactionEndedError`, naming the collection and operation. Without this check it would write outside the transaction.
- **Nesting:**
  - a `transaction()` inside another on the same client joins the outer one;
  - MongoDB has no savepoints, so the inner options are ignored, and the inner hooks run after the outer commit;
  - a collection on a different `MongoClient` is refused with a `TypeError` instead of quietly running outside the transaction.
- **Standalone servers** throw `TransactionsUnsupportedError`, with the server error as `cause`. Driver 7 rewraps that server error as advice to set `retryWrites=false`, which does not help a transaction; Krepis reports the real cause on every driver.
- **Mixing with Mongoose:** `tx.session` is the driver session. Pass it to Mongoose or raw-driver calls (`{ session: tx.session }`) and they commit or roll back with the Krepis writes. Those calls do not wait for the transaction to start, so do not make them the first operation of a `Promise.all`. If Mongoose bundles a different copy of the driver, the session type needs a cast; it is the same object.
- **`cursor()`** joins the transaction but is not queued behind the first operation.
- **Cost:** 3 writes issue exactly 3 write commands and 1 `commitTransaction`. In `packages/krepis/bench/transaction.ts` the median was 7% slower than a hand-threaded driver session on the machine it was run on, including Krepis's validation and casting; measure your own.

Limits: raw-driver or Mongoose writes inside the callback that omit `{ session: tx.session }` run outside the transaction, and Krepis does not detect them.

## Safety defaults

Built:

| Default | Behaviour |
|---|---|
| `strictInput: true` (a `createDal`/`fromMongoose` option) | An operator object where the schema expects a scalar (or an array of scalars) throws `KrepisInputError`, unless it was built with `op`: `op.eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `all`, `exists`, `size`, `not`, or `op({ ... })` for anything else. Checked inside `$and`/`$or`/`$nor`, in every filter, `include` `where` and `aggregate().match()`. Fields typed `t.mixed()`, `t.map()` or `t.object()`, and paths outside the schema, are not checked. `strictInput: false` turns it off. |
| `.hidden()` fields | Left out of Krepis reads unless selected by name (`collection.raw()` returns them). |
| `unboundedReads: 'error'` | `find` requires a `limit` or an explicit cursor. |
| Regex | Search from input uses `match.prefix(input)` / `match.contains(input)`, which escape every metacharacter (`{ ignoreCase: true }` for `i`); a case-sensitive prefix is anchored, so it can use an index. A raw `{ $regex: input }` on a string field is an operator object, so `strictInput` refuses it. |
| Server-side JavaScript | `$where`, `$function` and `$accumulator` throw `KrepisInputError` anywhere in a filter or stage, whatever `strictInput` says, unless the object holding them is built with `op` (the per-call opt-in). |

## Observe mode

```ts
import { observe } from '@sameernair/krepis-kit';
const observer = observe(client, { sampleRate: 0.2 });
```

Captures and the CLI:

```ts
observe(client, { capture: true });                            // value-free NDJSON to .krepis/
observe(client, { capture: { dir: 'tmp/krepis', segmentBytes: 16 << 20, retentionDays: 7, maxBufferBytes: 8 << 20 } });
// or, with no option: KREPIS_CAPTURE=1 (or a directory). An explicit capture: false wins.
```

```bash
krepis init                          # create .krepis/ and add it to .gitignore
krepis analyze                       # N+1 patterns grouped across units of work, with the fix; repeated lookups listed apart
krepis analyze .krepis --json        # for scripts; --rtt 1,20,50 to project costs; --fail exits 1 on any N+1 pattern
krepis analyze --format markdown     # or sarif; --output file writes it there
krepis analyze --update-baseline     # record today's findings in krepis-baseline.json
krepis analyze --baseline krepis-baseline.json --fail   # fail only on findings not in the baseline
```

Each finding is grouped with the same pattern from other requests (same query shape, parent and call site), so the report says how many units of work and which routes hit it.

Findings are a union on `rule`: `KR-P002` (`NPlusOneFinding`, severity `warn`, with `confidence: 'strong' | 'derived'` and the `parent` that supplies the values) and `KR-P012` (`RepeatedLookupFinding`, severity `info`, no parent: repeats that are not N+1). `onFinding` receives both; `formatFinding(f)` prints either. `--fail` and `analysisJson().summary.patterns` count KR-P002 only; `summary.repeatedLookups` counts the rest. `observer.captureStats` counts contexts, lines, bytes, segments, `dropped` (buffer full) and `errors` (failed writes); `observer.flush()` writes buffered lines now. Format: [Architecture](ARCHITECTURE.md#capture-format).

The same reports from code: `ciFindings(loadCaptures(captureFiles(['.krepis'])))` lists what `--fail` acts on, each with a stable `key`; `compareBaseline`, `readBaseline` and `writeBaseline` handle baselines, and `formatMarkdown` and `formatSarif` render them.

Query budgets:

```ts
import { expectQueries, KrepisQueryBudgetError } from '@sameernair/krepis-kit';
await expectQueries(observer, { max: 3 }, () => request(app).get('/posts'));    // throws KrepisQueryBudgetError
const { result, queries } = await observer.measure('GET /posts', () => request(app).get('/posts'));
// queries: { commands, roundTrips, units, shapes: [{ namespace, command, shape, count, callSite }] }
```

Every unit of work that begins while the block runs is counted, so run one measurement at a time per observer. `commands` counts what the application issued (a cursor's `getMore`s belong to it); `roundTrips` what reached the server after `optimize`.

Opt-in rules ([Rules](RULES.md)):

```ts
observe(client, { explain: true, onPlanFinding: (f) => console.warn(formatFinding(f)) });   // KR-P001, P010, P003
observe(client, { hazards: true, onHazard: (f) => console.warn(formatFinding(f)) });       // KR-S001–S004, KR-P006 (S001, S002 run by default)
observe(client, { hazards: { sensitiveFields: /passw|secret|token|ssn/i, unboundedReadThreshold: 5000 } });
await observer.settled();   // explains still running, then buffered capture lines
```

Findings are also kept on `observer.planFindings` and `observer.hazardFindings`; `observer.explainStats` counts explains sent and refused. `KREPIS_EXPLAIN=1` and `KREPIS_HAZARDS=1` turn them on without code changes. KR-S001 and KR-S002 run without `hazards: true`; `hazards: false` or `KREPIS_HAZARDS=0` turns them off.

`observer.holders()` names the queries holding connections for the connection watcher's KR-C006: `watchConnections(client, { holders: observer.holders() })` (see Connections → Checkout waits). Only commands inside a unit of work are named. Give it to one watcher.

Units of work from frameworks:

```ts
app.use(observer.middleware());                                        // Express/Connect: one unit per request, labelled 'GET /orders/:id'
new ApolloServer({ schema, plugins: [observer.apolloPlugin()] });      // one unit per GraphQL operation, labelled 'query Orders'
await observer.run('job sync-users', () => syncUsers());               // anything with one callback
await fastify.register(observer.fastifyPlugin());                      // Fastify
koa.use(observer.koaMiddleware());                                     // Koa, before @koa/router
hono.use(observer.honoMiddleware());                                   // Hono
const unit = observer.begin('job sync-users');                         // hooks that cannot wrap a callback; undefined when not sampled
unit?.enter(); /* … */ unit?.end();
unit?.input('body', () => message.payload);                            // request input for KR-S001; read only when a filter holds an operator
observer.input('body', req.body);                                      // the same, for the current unit (inside `run`)
```

The hooks record the request's input themselves: `body`, `query` and `params` (Express, Fastify, Koa), the JSON body (Hono, as `c.req.json()` returns it) and `variables` (Apollo). It is compared in memory when a filter field holds an operator object, and is never kept or captured; a KR-S001 finding says only which part it came from (`finding.input`).

The middleware labels a unit by method and route pattern, read when the response finishes. If the route is a catch-all (`*`, `(.*)`, as in CMSs that resolve pages themselves) or the router's `baseUrl` is not a path, it falls back to the request path with id-like segments masked.

The Apollo plugin has no runtime dependency on `@apollo/server` and covers every resolver, including default resolvers that call a method on the source object. In a resolver that returns the query promise without `await` (`(o) => Users.findOne(…)`) there is no application frame to report, so the call site is the resolver itself: `resolver Order.user`. An application frame, when there is one, always wins. Naming the resolver costs about 0.15 µs per resolved field in sampled operations; `observer.apolloPlugin({ resolverSites: false })` turns it off.

Observe mode needs no changes to your data code: it works with the raw driver and Mongoose alike.

```ts
observe(client, { optimize: 'safe' });                         // batchLookups + dedupeReads
observe(client, { optimize: { batchLookups: true, dedupeReads: false, maxAgeMs: 500, verify: 0.01, onMismatch: (m) => log(m) } });
observe(client, { autoBatch: true });                          // alias for { optimize: { batchLookups: true } }
```

All optimisations are opt-in and apply only inside an observed unit of work. No code changes are needed, and every N+1 is still reported. They need a promise-style driver: on mongodb 4.x, 5.x and 6.0 (callback-style `Connection.command`, as used by Mongoose 6 and 7) detection works and optimisation is skipped, with a one-time `KREPIS_OPTIMIZE_CALLBACK_DRIVER` process warning.

- `batchLookups` answers parent-driven loops of `_id` lookups from one `$in` prefetch, with the semantics of a per-request DataLoader cache. Findings carry `autoBatched: { served, roundTrips }`.
- `dedupeReads` answers a `find`/`aggregate` identical to an earlier one in the same unit of work from its reply. Nondeterministic and writing stages, open cursors and sessions are never deduplicated.
- `verify` (0–1) sends that fraction of optimised answers to the server too, returns the server's answer, and classifies any difference: `reordered` (same documents, unsorted query), `stale` (proved by a snapshot read at the cached answer's cluster time: a write landed after it), `unexplained` (a Krepis bug; report it), `unclassified` (no replica set, or outside the snapshot window). `onMismatch` receives `{ kind, verdict, namespace }`.
- `maxAgeMs` (default 1,000) bounds how old an answer may be. Writes in the same unit of work invalidate. A write from another process is seen as soon as the request reads the changed document (or an unknown document of a cached result set) itself, and after at most `maxAgeMs` otherwise.

Counters for the whole observer are on `observer.optimizeStats`: `prefetches`, `served` (lookups answered from a prefetch), `deduped`, `verified`, `mismatches`, and per verdict `reordered`, `stale`, `unexplained`, `unclassified`.
