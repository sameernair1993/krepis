# @sameernair/krepis

A typed data access layer for MongoDB on Node.js, with safe defaults and connection helpers.

> **Status: pre-release.** Built and tested, but not yet used in production. APIs may change before v0.1. Feedback and issues are welcome on [GitHub](https://github.com/sameernair1993/krepis/issues).

## Install

```bash
npm install @sameernair/krepis mongodb   # mongodb is a peer dependency
```

Requires Node.js 20.19+, the `mongodb` driver 4.17 to 7.x (or Mongoose 6 to 9), and MongoDB server 7.0+. ESM and CommonJS both work.

## Example

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
```

## What it does

- **Types.** Filters, updates (including array operators), projections, `include`, the aggregation builder and update pipelines are checked against the schema.
- **Defaults.** Strict input, required limits, hidden fields and enums are on by default. Server-side JavaScript is refused unless it is written in code.
- **Relations.** `include` loads each relation with one read per level.
- **Transactions.** `dal.transaction()` without passing a session around, with `afterCommit` hooks.
- **Multi-tenant scoping.** A `scope` hook per collection filters reads, stamps inserts and sanitises updates.
- **Moving from Mongoose.** `fromMongoose(mongoose)` shares Mongoose's connection, so collections can move one at a time. `@sameernair/krepis/compat` offers a Mongoose-shaped model API.
- **Escape hatch.** `collection.raw()` returns the underlying driver collection, for anything Krepis does not cover.

## Entry points

| Import | Contents |
|---|---|
| `@sameernair/krepis` | The data layer: `createDal`, `schema`, `t`, `op`, `match`, errors |
| `@sameernair/krepis/connections` | A static check of client options, a pool watcher, and `TenantPools`: a per-tenant client cache with a login circuit breaker, a cluster-wide governor for login storms, and shedding when a node refuses new connections |
| `@sameernair/krepis/compat` | A Mongoose-shaped model API over the data layer |

These guards work at the database layer only: they govern how your app connects and logs in to MongoDB, not traffic to your app.

## Limitations

- Not yet used in production by anyone.
- CI runs the test suite against MongoDB 8.0 only.
- Parts of the documentation describe planned work. Each page says what exists today.

## Documentation

- [Guide](https://github.com/sameernair1993/krepis/blob/main/docs/GUIDE.md)
- [API](https://github.com/sameernair1993/krepis/blob/main/docs/API.md)
- [Connections](https://github.com/sameernair1993/krepis/blob/main/docs/CONNECTIONS.md)
- [Security](https://github.com/sameernair1993/krepis/blob/main/docs/SECURITY.md)

To look for N+1 queries in an existing app, see [`@sameernair/krepis-kit`](https://www.npmjs.com/package/@sameernair/krepis-kit).

## License

MIT. Krepis is an independent project and is not affiliated with or endorsed by MongoDB, Inc. MongoDB and Atlas are trademarks of MongoDB, Inc.
