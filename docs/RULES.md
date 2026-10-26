# Rules

The rules Krepis checks today. Rule IDs are stable. Thresholds may be tuned as Krepis is run against more codebases.

## Findings

Every finding has a `rule` (its ID), a `severity` (`info`, `warn` or `error`) and an `evidence` object: the numbers behind it, such as query counts, durations, connection counts and limits. A finding without numbers is not emitted.

- **Query findings** (KR-P), from `@sameernair/krepis-kit`, also carry the query shape, call sites and, for KR-P002, the earlier result that drives the loop and a `confidence`. `krepis analyze` prints each with its projected cost and a fix.
- **Connection findings** (KR-C, KR-I), from `@sameernair/krepis/connections`, also carry a `title`, a `message` whose numbers all appear in `evidence`, a `fix`, and the server address or client label where they apply.

## Queries (P)

| ID | Rule | Fires when | Severity |
|---|---|---|---|
| KR-P002 | N+1 query pattern | The same equality lookup repeats within one context, and every looked-up value comes from one field of an earlier result (see below) | warn |
| KR-P012 | Repeated lookup | The same equality lookup repeats 3 or more times within one context, with no earlier result supplying the values. Deduplication or loader material, not an N+1 | info |

### KR-P002 in detail

**Why it needs its own method.** Locally, an N+1 is invisible by timing: each lookup is a perfect `_id` hit and a local round trip is well under a millisecond. Server-side tools (profiler, Performance Advisor) see each child query as fast and well indexed, so they can't see it either. The problem is the *number* of round trips, which only the client sees, and which grows with real round-trip time. So the rule detects by structure and count, then projects the cost.

**Grouping.** Within one context (request, job, test), `find` / `count` / `distinct` commands with at least one top-level equality conjunct (`{f: v}` or `{f: {$eq: v}}`) are grouped by fingerprint. The equality conjuncts are the lookup keys; any other conjuncts (an ACL `{_rperm: {$in: …}}`, a tenant `$in`, a soft-delete `$exists`) are kept in the shape but are not keys. The *lookup fields* are the keys whose values vary across the group; keys that stay constant (a tenant id, a status) are ignored. A group with such extra conjuncts whose key never varies is skipped: with only one key value, the varying part of the query is in the other conjuncts, so it is not a lookup by key. `$in` batches have a different shape and never group with point lookups, so the fix itself never fires the rule.

**Data evidence is required.** A group is reported as N+1 only when an earlier result in the same context supplies the looked-up values. Repetition alone is not enough: on NodeBB, every repeat without that link was middleware re-reading a slug, parallel branches reading one key, or a cold cache, none of them an N+1. Those groups are reported as KR-P012 instead.

| Confidence | Evidence | Minimum repeats |
|---|---|---|
| `strong` | Every lookup value is a value of one field of one earlier result (top-level, one nested level, or array elements), compared by type (`5` ≠ `"5"`) | 2 |
| `derived` | Every lookup value is a key built from such a value: either the child values share constant tokens around one varying token (`user:3`, `user:7` → `3`, `7`), or a delimited parent string contains the value as a token (`_User$abc` → `abc`). Separators are `: $ / \| #`. Values compare as strings, so an ObjectId matches its hex string. | 3, with ≥2 distinct values |

**Causality.** A parent must have finished before the lookups it explains. Parents that ended before the first lookup are tried first, against the whole group. If none matches, a parent that ended partway through is tried against only the lookups that started after it; earlier same-shape calls are left out of both the match and the reported evidence. Without this, one unrelated call with the same shape before the loop stopped the parent from supplying every value and sent a real loop to KR-P012 (Habitica, NodeBB).

Either way the parent must supply at least two items to loop over: it returned two or more documents, or the matched field holds two or more values (an array). One document with a scalar field that is read again by key is a re-read, not a fan-out (found on NodeBB: `post:<pid>` read once, then re-read from two other code paths).

The 2-repeat threshold for `strong` exists because local and test data are small: a loop over 2 seeded rows is still the loop that will run over 200 in production. `derived` matches tokens, which can coincide, so it needs one more repeat and two distinct values. An earlier result that merely *returned as many documents as there were lookups* is not evidence; that count-coincidence tier (`likely`) was removed after it produced a false positive on NodeBB.

**Evidence reported.** Queries, distinct and duplicate values, serial vs parallel (peak in-flight overlap), parent namespace, field and returned count, call sites (up to three stacks sampled per shape per context, so lookups from several code paths show as several sites), local wall time and server time. Values themselves are never reported (see [Privacy](PRIVACY.md)).

**Projection.** Extra latency is `(waves − 1) × RTT`, where waves = queries when serial, or `ceil(queries / min(peak, maxPoolSize))` when parallel; reported at configurable RTTs (default 1 ms same-region and 20 ms cross-region). Parallel N+1 is reported as connection pressure instead: it checks out up to `min(N, maxPoolSize)` connections at once.

**Fix artifact.** One `$in` query keyed on the parent field (for `derived`, on the keys built from it), with DataLoader (GraphQL) and Mongoose `populate()` noted as equivalents. `populate()` is verified not to trigger the rule.

**Auto-batched.** With `optimize` batching on, lookups answered from a prefetch are still counted as queries in the finding, so detection is unchanged; the finding gains `autoBatched: { served, roundTrips }` and the report says the code fix is still the real one. The prefetch itself is never treated as a parent. Reads answered by `dedupeReads` are recorded too, so a repeated identical query is still found.

**KR-P012, repeated lookups.** The same evidence (queries, distinct values, execution, sites, projection) without a parent. It says so in the report ("not reported as N+1"), advises a request-scoped loader or cache when several sites are involved, and is listed in its own section of `krepis analyze`. It never makes `analyze --fail` fail. Captures written by earlier versions are read the same way: their KR-P002 findings with `likely` or `pattern` confidence become KR-P012.

**Known limits.** Requiring a parent costs recall: a loop over values that come from request input (`req.body.ids`) or from another service has no parent in the context, so it is reported as KR-P012, not as N+1. A function that `return`s a query promise without `await` drops its own stack frame (V8), so the call site is the nearest awaiting caller; in a GraphQL resolver written that way the nearest awaiting caller is graphql-js, and no call site is reported. Write-side N+1 (an `insertOne` / `updateOne` per item) is not yet covered. A lookup needs at least one equality conjunct; a loop whose key is itself an operator (`{_id: {$gt: x}}`) is not seen. Counting extra conjuncts as lookups makes KR-P012 noisier where many repeated reads carry them: on NodeBB, KR-P012 groups rose from 14 to 37, 22 of them from `{_key: {$in}, members: …}`-style filters. KR-P012 is informational and never fails `--fail`, so this was accepted. A result that ends partway through a loop can be taken as its parent, and it then explains only the lookups after it. A lookup whose start timestamp equals its parent's end timestamp is counted as after it; that case could not be produced in a test, so the boundary is untested.

## Connections (C)

Checked from client options before connecting (`checkConnectionOptions`, *static*), from pool events while running (`watchConnections`, *runtime*), or both. See [Connections](CONNECTIONS.md).

| ID | Rule | Fires when | Checked | Severity |
|---|---|---|---|---|
| KR-C003 | Fleet demand over node limit | Instances × pool size against the per-node connection limit | static | error |
| KR-C004 | Connection churn | New connections per second near the Atlas per-node rate limit | runtime | warn |
| KR-C007 | Tenant pool multiplication | One client per tenant: tenants × instances × (`minPoolSize` + monitoring connections) held open per node even when idle, and tenants × instances × `maxPoolSize` at peak, against the per-node limit | static | warn |
| KR-C008 | Idle re-login churn | `minPoolSize` > 0 with a short `maxIdleTimeMS`: the pool closes idle connections and refills them, each refill a new login, with or without traffic | both | static: error under 60 s, warn under 5 min; runtime: error |
| KR-C009 | Authentication failure loop | Repeated login failures (code 18) on one node: rotated or revoked credentials the process never re-reads | runtime | error |
| KR-C010 | Socket timeout closes connections | A finite `socketTimeoutMS`: an operation that outlives it closes its connection, and the replacement is a new login. Retryable reads run the operation again, so one slow read costs two | both | warn |
| KR-C011 | No appName | Connections the server and Atlas cannot attribute to a service | static | warn |
| KR-C012 | Driver without connection backpressure | mongodb before 7.1: a network error while establishing a connection clears the pool, so an overloaded node causes every pooled connection to reconnect | both | warn |

The static check raises KR-C003 and KR-C007 as an error when the idle connections alone reach 80% of the node limit.

## Incidents (I)

These rules do not need to know what is going wrong, only that the client is paying for connections without doing work. Raised by `IncidentMonitor` in `@sameernair/krepis/connections`.

| ID | Name | Fires when | Severity |
|---|---|---|---|
| KR-I001 | Amplification loop | Over 10 s on one node, replaced connections plus failed checkouts reach 5 and at least half the checkouts. It fires per mechanism (`auth-failure`, `unreachable`, `idle-churn`, `socket-timeout`, `connection-error`, `pool-clear`, `pool-saturation`) once that mechanism has 5 events, and names the specific C rule where one exists. Scope is per client, and also the **fleet** (`client: '*'`): the same rule summed over every client of the monitor, when at least 2 contributed. | error |
| KR-I002 | Reconnect herd | At least `max(5, ⌈half the active clients⌉)` clients create connections within 3 s, each within 10 s of losing one (an error closure, pool clear, heartbeat failure or server marked Unknown). It is reported once per episode and names every client in it. | error |

A connection that served work and then idled out is shrinkage, not cost. Losing connections without replacing them is not a loop either, because no new logins are made. Error-level findings from I001, I002, C008 and C009 trigger a **flight recorder** dump (see [Connections](CONNECTIONS.md)).

## Adding a rule

1. Define required inputs and the evidence it produces.
2. Write the explanation template using only evidence fields.
3. Define the fix artifact and its cost.
4. Add fixtures: at least one positive and one negative case, against real MongoDB.
5. Document it here.
6. Measure its false-positive rate on the reference codebases before enabling it by default.
