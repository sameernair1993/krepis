# @sameernair/krepis-kit

N+1 query analysis and connection incident drills for MongoDB on Node.js. Attaches to an existing driver or Mongoose client; your data code does not change.

> **Status: alpha.** Built and tested, but not yet used in production. APIs may change before v0.1. Feedback and issues are welcome on [GitHub](https://github.com/sameernair1993/krepis/issues).

## Install

```bash
npm install -D @sameernair/krepis-kit
```

Requires Node.js 20.19+, the `mongodb` driver 4.17 to 7.x (or Mongoose 6 to 9), and MongoDB server 7.0+.

## Finding N+1 queries

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

What it reports:

- **KR-P002, N+1 (warning).** Reported only when an earlier read supplied the looked-up values, never for repetition alone. Each finding gives the parent query and field, the query count, serial or parallel execution, time spent and call sites.
- **KR-P012, repeated lookup (information).** The same lookup repeated in one unit of work with no parent driving it. It never fails `--fail`.

Options:

- **Runtime batching.** With `optimize: 'safe'`, `_id` lookups in a loop within one request are batched and identical reads are answered once.
- **Overhead.** Commands outside a unit of work are not analysed, and `sampleRate` limits how many units are. Internal errors are counted rather than thrown into your app, and `KREPIS_DISABLED=1` turns it off.
- **Privacy.** Captures hold query shapes, not values, and stay on your machine. `krepis analyze` runs offline.

## Connection drills

```bash
npx krepis drill            # reads krepis.drill.{ts,mts,js,mjs}
```

`krepis drill` runs your own connection code through incidents (credential rotation, auth outages, restarts, slow nodes, network blips, connection limits, step-downs) against a throwaway MongoDB container in Docker, and exits 1 if a scenario fails. It needs a running Docker daemon.

## Limitations

- Not yet used in production by anyone.
- The only finding today is N+1, with repeated lookups as information. Index, schema and security rules are designed but not built.

## Documentation

- [Guide](https://github.com/sameernair1993/krepis/blob/main/docs/GUIDE.md)
- [Rules](https://github.com/sameernair1993/krepis/blob/main/docs/RULES.md)
- [Connections and drills](https://github.com/sameernair1993/krepis/blob/main/docs/CONNECTIONS.md)
- [Privacy](https://github.com/sameernair1993/krepis/blob/main/docs/PRIVACY.md)

For the typed data layer, see [`@sameernair/krepis`](https://www.npmjs.com/package/@sameernair/krepis).

## License

MIT. Krepis is an independent project and is not affiliated with or endorsed by MongoDB, Inc. MongoDB and Atlas are trademarks of MongoDB, Inc.
