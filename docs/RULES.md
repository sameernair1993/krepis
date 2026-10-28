# Rules

The rules Krepis checks today. Rule IDs are stable. Thresholds may be tuned as Krepis is run against more codebases.

## Findings

Every finding has a `rule` (its ID), a `severity` (`info`, `warn` or `error`) and an `evidence` object: the numbers behind it, such as query counts, durations, connection counts and limits. A finding without numbers is not emitted.

- **Query findings** (KR-P), from `@sameernair/krepis-kit`, also carry the query shape, call sites and, for KR-P002, the earlier result that drives the loop and a `confidence`. `krepis analyze` prints each with its projected cost and a fix.
- **Plan findings** (KR-P001, KR-P010, KR-P003) carry the plan's stage and index names and a suggested index. **Hazard findings** (KR-S, KR-P006) carry field and operator names. Neither carries a value.
- **Connection findings** (KR-C, KR-I), from `@sameernair/krepis/connections`, also carry a `title`, a `message` whose numbers all appear in `evidence`, a `fix`, and the server address or client label where they apply.

## Queries (P)

| ID | Rule | Fires when | Severity |
|---|---|---|---|
| KR-P002 | N+1 query pattern | The same equality lookup repeats within one context, and every looked-up value comes from one field of an earlier result (see below) | warn |
| KR-P012 | Repeated lookup | The same equality lookup repeats 3 or more times within one context, with no earlier result supplying the values. Deduplication or loader material, not an N+1 | info |
| KR-P001 | Collection scan | The winning plan has a `COLLSCAN` and the filter has a field an index could serve. Needs `explain: true` | warn |
| KR-P010 | In-memory sort | The winning plan has a blocking `SORT` stage. Needs `explain: true` | warn |
| KR-P003 | `$lookup` without an index | A `localField` / `foreignField` `$lookup` whose foreign collection has no index starting with `foreignField`. Needs `explain: true` | warn |
| KR-P006 | Unbounded read | A `find` without a limit returned more than 1,000 documents (configurable), counting every batch. Needs `hazards: true` | warn |

`krepis analyze --fail` fails on KR-P002, KR-P001, KR-P010, KR-P003 and KR-P006. KR-P012 never fails it.

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

### Plan evidence

Off by default; turned on with `observe(client, { explain: true })` or `KREPIS_EXPLAIN=1`, and meant for tests and CI. The first time an observer sees a query shape, it sends `explain` (`queryPlanner` verbosity, which plans the command but does not run it) for a copy of that command to the same server, after the command itself has been sent, one explain at a time and outside any unit of work, so explains are not counted as the app's queries. Only stage and index names are kept from the reply. KR-P003 lists the foreign collection's indexes instead.

The suggested index is built from the query alone, in equality, sort, range order: equality fields first, then the sort keys, then range fields. It is a starting point: it does not take the collection's other indexes or the cost to writes into account.

**Known limits.** One explain per shape per observer (at most 1,000 shapes), so a plan that changes as data grows is not seen again. The plan is the one chosen for local or test data; a small collection can be scanned where production would use an index, and the reverse. A multi-statement update or delete is not explained.

**Measured** on Krepis's comparison suite (seven workloads through the raw driver, Krepis, Mongoose, Typegoose, Papr and Prisma 8): with the suite's index in place, no plan finding; with it dropped, KR-P001 and KR-P010 on the one query it served, for every library (Prisma's as an `aggregate`), each suggesting the dropped index, and nothing else. Not yet run on the reference codebases.

## Security (S)

KR-S001 and KR-S002 are on by default. KR-S003 and KR-S004 are off by default and turned on with `observe(client, { hazards: true })` or `KREPIS_HAZARDS=1`, together with KR-P006. `hazards: false` or `KREPIS_HAZARDS=0` turns all of them off. Each rule records field, operator and call-site names, never values.

| ID | Rule | Fires when | Severity |
|---|---|---|---|
| KR-S001 | Operator injection signal | A top-level filter field received an operator object that the client sent in the request (body, query string, route parameters, GraphQL variables), or one call site has sent the field both as a plain value and as an operator object (`{email: 'a@b.c'}` and `{email: {$ne: null}}`) in otherwise identical queries. `{$eq: …}` does not count | warn |
| KR-S002 | Server-side JavaScript | A command uses `$where`, `$function`, `$accumulator` or `mapReduce` | warn |
| KR-S003 | Unanchored regular expression | A filter field is matched by a regular expression that does not start with `^`, which no index can bound | info |
| KR-S004 | Sensitive field returned | A read returned a field whose name matches `/passw\|secret\|token\|api_?key/i` (configurable), up to four levels deep | info |

`krepis analyze --fail` fails on KR-S001 and KR-S002. KR-S003 and KR-S004 never fail it.

**How they are checked.** KR-S002 and KR-S003 inspect each query shape once. KR-S001 has two sources of evidence. **From the request:** the framework hooks (`middleware()`, Fastify, Koa, Hono, Apollo) record where the request's parsed input is, and when a filter field holds an operator object, it is compared with the operator objects in that input; a match is reported from that one request, whatever line sent the query. Values are cast on the way (an id string to an ObjectId, `'5'` to `5`), so they are compared as text. Code without a hook can call `observer.input('body', parsed)` inside its unit. **From the call site:** it resolves the call site of up to 5 commands per shape and remembers, per call site, field and the rest of the query, whether a value or an operator was sent. KR-S004 decodes the first document of the first reply for each shape, in memory, and keeps only its field names.

**Known limits.** KR-S001 is a signal, not proof. From the request, it needs a request that actually sends an operator object (an injection test, or traffic in production), and input the hooks know about: Hono form bodies and input parsed by the app itself (a JSON header, a decoded token) are not seen unless passed to `observer.input`. A route that accepts operators from clients by design is reported. From the call site, it needs the same call site to receive both forms while observed, and code that accepts both on purpose is reported. Fields nested under `$or` or `$elemMatch` are not checked. KR-S004 sees the first document per shape, so a sensitive field that only some documents have can be missed. None of these rules has yet been run on the reference codebases (step 6 below), including the two that are on by default.

**Measured on Krepis's own comparison suite** (eight hazards sent through the raw driver, Mongoose, Mongoose with `sanitizeFilter` and `runValidators`, Papr, Prisma 8 and Krepis, each also run once as legitimate use):

- **KR-S001 depends on the call site.** It is resolved like an N+1 call site, so a function that `return`s the query promise without `await` hands it to its caller. When the legitimate and the injected request reached the query from different lines, it caught none of 3 exposed cases; when both went through one awaiting helper, as one route handler would, it caught all 3. The same property once caused false positives: a line that dispatches many different queries (a generic repository method, a test harness) sent `_id` as a value in one query and as `$in` in another. KR-S001 now matches the two forms only when the rest of the command is the same query (command, collection, the other filter fields, sort, projection, limit), which removed those findings on the suite and kept the 3. With the request body recorded as input, as the hooks do, it caught all 3 from separate lines too, and none of the legitimate requests or the protected libraries (Mongoose with `sanitizeFilter`, Prisma, Krepis).
- **KR-S002** caught every `$where` case that reached the server and fired on no legitimate request.
- **KR-S003** does not detect regular-expression denial of service: the hazard's pattern `^(a|aa)+$` is anchored and was not flagged, while legitimate `contains` searches were, Krepis's own `match.contains` included.
- **KR-S004** reports a shape, not a request: it fired in the first unit that read each collection, often a legitimate one, and on Krepis too for a field the suite does not treat as sensitive (`resetToken`).
- **KR-P006** checks `find` only, so a read through `aggregate` (Prisma 8) is not seen. At the default threshold it flagged none of the suite's 3-document reads; at threshold 2 it flagged each unbounded `find`.

KR-S003 and KR-S004 are informational and off by default for these reasons. KR-S001 is on by default and fails `--fail`. A helper that sends one query with a field sometimes as a value and sometimes as an operator on purpose (a filter builder that accepts either) is still flagged; record accepted findings in a baseline (`--update-baseline`) or turn the rules off with `hazards: false`.

## Connections (C)

Checked from client options before connecting (`checkConnectionOptions`, *static*), from pool events while running (`watchConnections`, *runtime*), or both. See [Connections](CONNECTIONS.md).

| ID | Rule | Fires when | Checked | Severity |
|---|---|---|---|---|
| KR-C001 | Duplicate clients | Two or more connected clients (configurable) share a deployment and credentials. Each holds its own pool and monitoring connections. Reported at most once a minute per deployment, with the call sites that created them. Clients opened by `TenantPools` are not counted. Checked by `watchClients` | runtime | warn |
| KR-C002 | Pool far larger than its peak | On by default, and only with `deployment` (a tier or `maxConnectionsPerNode`); `oversizedPool: false` turns it off. After an hour (`poolObserveMs`) and at least 100 checkouts to a node, twice the most connections ever checked out at once (at least 5) is at most half of `maxPoolSize`, and `instances` × (`maxPoolSize` + monitoring connections) is at least half the node's limit. Recommends that size | runtime | warn |
| KR-C003 | Fleet demand over node limit | Instances × pool size against the per-node connection limit | static | error |
| KR-C004 | Connection churn | New connections per second near the Atlas per-node rate limit | runtime | warn |
| KR-C005 | Idle connections dropped by the network | On by default; `idleDrops: false` turns it off. 3 pooled connections within a minute (`idleDropThreshold`, `windowMs`) are closed by an error after idling at least 1 s, and no connection in that time was reused after idling as long as the shortest of them. Closures after a pool clear (a restart or failover) do not count. Recommends a `maxIdleTimeMS` below the shortest idle that failed | runtime | warn |
| KR-C006 | Operations wait for a connection | On by default; `checkoutWaits: false` turns it off. 3 operations within a minute (`checkoutWaitThreshold`, `windowMs`) each wait at least 100 ms (`checkoutWaitMs`) for a connection while every connection in the pool is in use. Waiting for a connection being established does not count. With `holders: observer.holders()` from the kit, it names the queries that held the connections (unit label, namespace and fingerprint) with their share of the time held | runtime | warn |
| KR-C007 | Tenant pool multiplication | One client per tenant: tenants × instances × (`minPoolSize` + monitoring connections) held open per node even when idle, and tenants × instances × `maxPoolSize` at peak, against the per-node limit | static | warn |
| KR-C008 | Idle re-login churn | `minPoolSize` > 0 with a short `maxIdleTimeMS`: the pool closes idle connections and refills them, each refill a new login, with or without traffic | both | static: error under 60 s, warn under 5 min; runtime: error |
| KR-C009 | Authentication failure loop | Repeated login failures (code 18) on one node: rotated or revoked credentials the process never re-reads | runtime | error |
| KR-C010 | Socket timeout closes connections | A finite `socketTimeoutMS`: an operation that outlives it closes its connection, and the replacement is a new login. Retryable reads run the operation again, so one slow read costs two | both | warn |
| KR-C011 | No appName | Connections the server and Atlas cannot attribute to a service | static | warn |
| KR-C012 | Driver without connection backpressure | mongodb before 7.1: a network error while establishing a connection clears the pool, so an overloaded node causes every pooled connection to reconnect | both | warn |

The static check raises KR-C003 and KR-C007 as an error when the idle connections alone reach 80% of the node limit.

In the drill's `slow-node` scenario KR-C006 fired for all 10 tenants of a configuration with one client per tenant and `maxPoolSize: 2`, during the fault only, and for none under `TenantPools` defaults. Both configurations pass that scenario, which judges recovery rather than latency during the fault, so a drill that passes can still raise KR-C006. Limits:
- A wait is counted when it ends, so a pool stuck behind holds longer than the window is reported late.
- Only commands inside a unit of work are named; the rest are reported as an unnamed share.
- Give `holders` to one watcher. Connection ids repeat across clients to the same server, so with several clients (`TenantPools`) names can be attributed to the wrong client.

KR-C005 was tested through a proxy that forgets connections idle for 1.5 s. It fired when the proxy reset or closed them, and it raised nothing directly to the server or in the drill's `idle`, `restart` and `network-blip` scenarios. Limits:
- A path that silently discards packets, with `socketTimeoutMS: 0` (the default), leaves the first operation on a dropped connection waiting until the operating system gives up on the socket, which can take minutes. Nothing is reported until then.
- With a finite `socketTimeoutMS`, the same drop also raises KR-C010, whose advice (`maxTimeMS`) does not apply to it.
- The driver's TCP keepalive (every 120 s) keeps most network paths from forgetting a connection, so drops are usually seen only on paths with idle timeouts under about 2 minutes.

KR-C002 limits:
- The peak is only what was seen while the process was watched. A process not watched through its busiest period gets too small a recommendation, and KR-C006 is what shows it: in the drill's `slow-node` scenario, a pool of 5 sized for calm traffic recovered as fast as one of 100 and opened fewer connections, but raised KR-C006.
- It judges one client. With many clients per process (`TenantPools`), the fleet arithmetic is KR-C007's.

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
