# Connections

## The problem

Teams on Atlas run out of connections and write custom logic to clear "stale" ones. Most of the time the cause is detectable, and the custom logic can make things worse.

## Usual causes

1. **Multiple clients per process.** `mongoose.connect()` or `new MongoClient()` called per request, per module, or repeatedly during hot reload. Each opens its own pool.
2. **Pool arithmetic nobody did.** The driver default `maxPoolSize` is 100. Instances × pool size × replica-set members read from, plus monitoring connections, can exceed the tier's per-node limit.
3. **Idle drops on the network path.** Load balancers, NAT gateways and private endpoints silently drop idle TCP connections. The driver's `maxIdleTimeMS` defaults to 0 (never close idle connections proactively), so the app discovers dead connections only on use.
4. **Slow queries holding connections.** Saturation leads to queue waits, then scale-out, then more pools, which makes it worse.
5. **Serverless.** The client created inside the handler instead of cached outside it.
6. **One pool per tenant.** Multi-tenant apps often open a separate client per tenant (separate databases, credentials or clusters). That is legitimate, and must not be flagged as duplicate clients, but it multiplies everything above. Each client keeps `minPoolSize` connections **to every node** it talks to, plus its own monitoring connections to every node (one, or two with the streaming protocol's round-trip monitor). So 200 tenants × 10 instances with `minPoolSize: 1` holds roughly 200 × 10 × (1 + 1–2) = **4,000–6,000 connections per node** while doing nothing, against M10's 1,500, before any traffic arrives. (Source: the driver Server Monitoring spec. Monitors use dedicated sockets outside the pool, and the streaming protocol, the default outside FaaS, adds a second dedicated socket per server for RTT. Those sockets emit no command events, so the collector must count them from topology, not from events.)

## Login storms

Running out of connections is one failure; logging in too often is another, and on a managed cluster it is the one that cascades. Every new connection is a TLS handshake plus a SCRAM login, and the node rate-limits new connections. Four configurations turn ordinary operation into a steady stream of logins:

1. **Idle re-login churn (`KR-C008`).** `minPoolSize` > 0 with a short `maxIdleTimeMS`. The pool closes an idle connection and immediately refills it to `minPoolSize`, so each tenant client logs in once per `maxIdleTimeMS` per node **with no traffic at all**. Measured: the cycle is `maxIdleTimeMS` + ~15 ms. At `maxIdleTimeMS: 30000` that is 120 logins per hour per client per node; 200 tenants × 10 instances is 66 per second per node, over four times M10's 15/s.
2. **Stale credentials (`KR-C009`).** A password is rotated and the process never re-reads it. Live, already-authenticated connections keep working (MongoDB does not de-authenticate them), so nothing fails until a connection is replaced, and then every replacement fails. The driver clears the pool and marks the server Unknown on an auth failure, which throttles each client to a burst of failed logins about every heartbeat (10 s): measured, ~1.4 per client per 10 s on driver 6.20. Harmless for one client; across hundreds of tenant clients it is thousands per minute, forever.
3. **Socket timeout (`KR-C010`).** An operation that runs past `socketTimeoutMS` closes its connection; the replacement is a new login. Retryable reads re-run the operation on a fresh connection, so **one slow read costs two connections and two logins** (measured). Bound slow operations with `maxTimeMS` instead: the server ends the operation and the connection survives (measured: 0 closures, 0 logins).
4. **No backpressure in the driver (`KR-C012`).** Before mongodb 7.1, a network error while establishing a connection clears the whole pool, so a node that is shedding new connections makes every client drop its working connections and reconnect, which sheds more. From 7.1 the driver labels these errors `SystemOverloadedError` + `RetryableError` and keeps the pool. Mongoose 8 pins mongodb 6.x; Mongoose 9 uses 7.x.

None of these is caused by the cluster event that exposes them, but each one multiplies it.

## What ships today: `@sameernair/krepis/connections`

Five layers, each usable alone:

| Layer | API | What it does |
|---|---|---|
| Static check | `checkConnectionOptions({ options \| client, driver, deployment, fleet })` | Reads client options (including those in the URI) before anything connects. Raises KR-C003, C007, C008, C010, C011, C012 with arithmetic against the tier's limits. Pure; safe in CI. |
| Runtime watcher | `watchConnections(client, opts)` | Listens to pool events only (no command monitoring). Raises KR-C004, C008, C009, C010 and C012 per node over a sliding window, at most once per window per rule. |
| Prevention | `new TenantPools({ appName, resolve, … })` | One client per tenant with safe defaults underneath the caller's options (`minPoolSize: 0`, `maxPoolSize: 10`, `maxIdleTimeMS: 300000`, `serverMonitoringMode: 'poll'`); refuses error-level options before opening anything; evicts idle tenants and caps open clients (least recently used); re-reads credentials and replaces a client whose credentials changed; and an **authentication circuit breaker** that closes a tenant's client after repeated login failures, fails its callers fast with `TenantLoginsFailingError`, and probes again after a jittered, doubling cooldown that re-resolves credentials. A **governor** handles storms across a cluster's tenants, and **overload shedding** stops tenants hammering a node that is refusing connections (both below). Works with Mongoose through the `open` / `clientOf` / `close` hooks. |
| Incident monitor | `new IncidentMonitor({ onFinding, recorder })`, then `watch(client, { label })` or `TenantPools({ monitor })` | Mechanism-agnostic KR-I001 (amplification loop, per client and fleet) and KR-I002 (reconnect herd), with a flight recorder that dumps the last 120 s and names the first movers. Runs the watcher's C rules underneath. |
| Drill | `krepis drill` / `runDrill(defineDrill({ setup, … }))` from `@sameernair/krepis-kit/drill` | Rehearses credential rotation, an authentication outage, a restart, a slow node, a node refusing connections, a network blip and idleness against **your own connection code**, on a disposable authenticated, rate-limited `mongo:8.0` in docker. Verdicts come from server counters; it exits 1 in CI when a scenario fails. |

The breaker **closes** the client rather than only rejecting calls: a rejected call does not stop the pool's own refills, which are what keep logging in.

### Governor: storms are handled per cluster

When many tenants of one cluster fail logins at once, the cause is shared: a rotation, or the server's authentication path. A breaker per tenant then costs `threshold × tenants` failed logins before anything trips, and one probe per tenant per cooldown afterwards. The governor, on by default in `TenantPools`, treats the cluster as one:

- **Storm:** at least 3 tenants of one cluster (same hosts in the URI) fail a login within 10 s. From then on a tenant trips on its **first** failure, and every tenant that has already failed trips at once. The storm ends after 30 s with no auth failure.
- **Canary:** during a storm, tenants whose credentials have not changed do not probe. One canary per cluster probes on a doubling schedule (5 s up to 15 s). If it logs in, the outage is over and the whole cluster is released; if not, it costs one failed login, not one per tenant.
- **Credential poll:** an open breaker re-resolves its credentials every 5 s (jittered). New credentials end the cooldown immediately, so recovery follows the secret store, not the cooldown schedule.
- **Probe budget:** half-open probes take a token from a per-cluster bucket (10/s), so releasing hundreds of tenants does not arrive at the node as a herd. First opens of healthy tenants are not budgeted.
- One tenant with a bad password is **not** a storm: it keeps the normal threshold and affects no other tenant.

```ts
new TenantPools({
  appName: 'orders-api',
  resolve,
  breaker: {
    storm: { minTenants: 3, windowMs: 10_000, quietMs: 30_000, canaryMaxMs: 15_000 }, // or false
    credentialPollMs: 5_000, // 0 disables
    probesPerSecond: 10,
  },
  onEvent: (e) => e.type === 'stormStarted' && logger.warn(e), // also stormEnded, canary
});
```

`{ storm: false, credentialPollMs: 0, probesPerSecond: Infinity }` restores the plain per-tenant breaker. Events carry tenant keys and cluster host lists, never credentials.

### Overload shedding

A node at its connection limit refuses new connections but keeps serving the ones it has. Every refused attempt still costs it an accept (and, on Atlas, a TLS handshake), and clients make many: in the `overload` drill, `TenantPools` without shedding made 16–21 refused attempts per connection admitted. About half came from **monitors**. A dropped connection resets a client's monitor, and while operations wait for a server it re-probes every 500 ms. The rest were the driver's own retries. Nearly all came from tenants with no established connection.

- **Signal:** a connection that closes before it is ready (not an auth failure), a failed open, or a failed heartbeat with a network error. These are CMAP and SDAM events, which both driver majors emit.
- **Only from a node that is still answering:** a node at its limit refuses *new* connections while it keeps serving the ones it has; a dead node answers nothing. So a refusal counts only if the node it names has **answered** within 10 s *after* refusing: a successful heartbeat, or a connection made ready, from any tenant of the cluster. An answer from before the node first refused does not count, so a member that dies is never counted. Refusals held back while no answer had come are not counted later either, so a member refusing while it restarts and answering once it is back does not start an overload. A refusal naming no node counts while any node of the cluster is answering. The cost: the first refusal of each burst is held, so it takes refusals from 4 tenants, not 3, and detection is slower (1.2–2.2 s, against 0.4 s).
- **Overload:** at least 3 tenants of one cluster refused within 10 s. It ends after 10 s with no refusal.
- **Warm tenants are untouched:** a tenant holding a ready connection needs nothing new from the node. The driver pings inside `connect()`, so a tenant's first connection exists before Krepis is listening; checking out a connection Krepis has not seen counts it as ready.
- **Cold tenants are parked:** their client is closed at once (`retired`, reason `overload`), which stops its monitor and its retries; `get` throws `ClusterRefusingConnectionsError` (`retryAfterMs`) without touching the node. At most 2 cold tenants at a time are admitted as **trials** (2/s). A trial ends when the tenant warms, its open fails, or it stays cold for 10 s.

```ts
new TenantPools({
  appName: 'orders-api',
  resolve,
  overload: { mode: 'enforce', minTenants: 3, windowMs: 10_000, quietMs: 10_000, admitPerSecond: 2, maxColdTenants: 2 }, // or false
  onEvent: (e) => e.type === 'overloadStarted' && logger.warn(e), // also overloadEnded { shed, parked }
});
```

`mode: 'observe'` reports the events and changes nothing; `overload: false` turns shedding off. Refused-but-parked operations fail fast instead of waiting: callers should treat `ClusterRefusingConnectionsError` like any other retryable unavailability, after `retryAfterMs`.

**The errors name the cause and carry the evidence.** Both fail-fast errors state the database fact first and Krepis's action last, and keep the driver's error as `cause`:

> MongoDB cluster mongodb://127.0.0.1:53493 is refusing new connections: 9 tenants were refused in the last 10 s, by 127.0.0.1:53493. Last error: MongoNetworkError: connection &lt;monitor&gt; to 127.0.0.1:53493 closed. Krepis is holding tenant "t04" back for 1 s so as not to add to the load.

`ClusterRefusingConnectionsError` (`MONGODB_CLUSTER_REFUSING_CONNECTIONS`) carries `nodes`, `refusedTenants` and `since`. `TenantLoginsFailingError` (`MONGODB_TENANT_LOGINS_FAILING`, from the breaker) carries `storm`. Both also carry `key`, `cluster`, `retryAfterMs` and `source: 'krepis'`. `overloadStarted` carries `nodes` too. Neither error subclasses `MongoNetworkError`: code that retries on driver labels would retry it at once, which is what it exists to prevent.

Limits: a client already opening when the overload starts cannot be parked until its open settles, and an admitted open keeps trying until the driver's `serverSelectionTimeoutMS`. The driver gives no hook on its own connection creation, so the unit is the tenant, not the connection.

### Incident monitor and flight recorder

The C rules each know one mechanism. `IncidentMonitor` detects the general case, **cost without useful work**, and records enough to answer "what started it?" afterwards.

```ts
import { IncidentMonitor, TenantPools } from '@sameernair/krepis/connections';

const monitor = new IncidentMonitor({
  onFinding: (f) => logger.error(f),               // KR-I001 / I002, plus the C rules underneath
  recorder: { dumpDir: '/var/log/krepis' },          // or onDump: (d) => ship(d)
});
monitor.watch(client, { label: 'orders' });          // any MongoClient
const tenants = new TenantPools({ appName: 'orders-api', resolve, monitor }); // labelled by tenant key
```

- **KR-I001 amplification loop** and **KR-I002 reconnect herd** ([Rules → Incidents](RULES.md#incidents-i)), from pool and SDAM events only. Command monitoring is not needed.
- **Flight recorder:** a ring of 16,384 compact records held in typed arrays (about 0.6 MB). An error finding dumps the last 120 s, at most once a minute per rule (per mechanism for I001), as `krepis-incident-<time>-<reason>.json`. The dump analysis lists the **first movers** (clients ranked by when their current run of failures began), the first heartbeat failure, the first auth failure, and the **ordering**: did the clients start failing before the server showed trouble, or after?
- **No secrets:** records hold error codes and code names only, never messages or URIs. Labels are whatever you pass.
- **Overhead:** about 0.05 µs per pool event, measured on a laptop.

### Drill

The rules and the monitor find problems once production is already suffering. `krepis drill` finds them before deploy, by injecting the faults real clusters produce into the application's real connection layer.

```ts
// krepis.drill.ts
import { defineDrill } from '@sameernair/krepis-kit/drill';
import { TenantPools } from '@sameernair/krepis/connections';

export default defineDrill({
  tenants: 10,                                   // one user each, random passwords
  setup(ctx) {                                   // build clients exactly as production does
    const pools = new TenantPools({ appName: 'orders-api', resolve: (t) => ({ uri: ctx.uri(t) }) });
    return { client: (t) => pools.get(t), close: () => pools.closeAll() };
  },
  // op: (client, tenant) => …                   // default: findOne on the drill database
  // budgets: { maxFailedLogins: 100, noAmplification: true },
});
```

```sh
npx krepis drill             # all eleven scenarios, ~13 min; exit 1 if any fails
npx krepis drill --scenario credential-rotation,idle --json
```

- **The server:** the drill starts its own `mongo:8.0` on a free 127.0.0.1 port, with auth on, the connection rate limiter at 15/s and failpoints enabled. It removes the container afterwards, including after Ctrl-C. Docker is the only requirement.
- **The replica set:** the last three scenarios run on a second rig, a three-member `rs0` in one container (one `mongod` per member, a shared keyfile, the same auth and rate limiter), after the standalone ones. Each member's port is published under the same number, so the hosts the driver discovers are reachable from the host. A scenario is meaningful only if the primary changed; the report prints the election.
- **Credentials:** `ctx.uri(tenant)` returns what a secret store would currently hand the app. After a rotation it lags the server by 15 s, so code that never re-reads credentials is exercised honestly.
- **Scenarios** each run warm-up (15 s), fault, heal, recovery (30 s):
  - `credential-rotation`: passwords change and in-use connections drop. A rotation alone disconnects nobody.
  - `auth-outage`: the server rejects the published credentials for 20 s, then accepts them again. Nothing is republished, so re-reading credentials cannot help.
  - `restart`: `docker restart`.
  - `slow-node`: commands block for 5 s, for 20 s.
  - `overload`: the application's connections drop and the node admits one new connection per second (queue of 1) for 20 s, refusing the rest, as at its connection limit.
  - `overload-keep`: the same admission limit, but established connections are kept, as an Atlas node at its limit does. Only tenants needing a new connection are refused.
  - `network-blip`: every command's connection is closed, for 5 s.
  - `idle`: no traffic for 90 s.
  - `stepdown`: `replSetStepDown` on the primary, as in Atlas maintenance. Heals when another member is writable primary.
  - `primary-crash`: SIGKILL on the primary; the others elect after about 10 s. Heals at the new primary; the killed member restarts then.
  - `rolling-restart`: each secondary restarted, then a step-down and the old primary restarted, as Atlas scales or patches. Heals when all three are healthy.
- **Verdicts** are measured on the server and do not depend on the mechanism:
  - `recovered`: every tenant succeeds again within 30 s of the heal;
  - `settled`: in the last 10 s, no failed logins and at most twice the baseline login rate;
  - `quiet` (idle only): at most 1 login per tenant per idle minute;
  - plus optional budgets.
- **Findings:** KR-I001/I002 findings and flight-recorder dumps are reported as evidence (`--dump-dir`). A bounded breaker trip during a rotation is an I001, and is the right behaviour, so findings fail a run only with `noAmplification`.
- **Latecomers:** three extra tenants (`late1`–`late3`) first ask for a client 3 s into each fault except `idle`. They are outside `ctx.tenants`, so a `setup` that warms its tenants does not warm them. The report gives each one's time from arrival to first success; they judge nothing. They answer whether a tenant new to the process is served during a fault. `latecomers: 0` disables them.
- **Faulted commands** are the CRUD commands plus `ping`. The drill's own admin connection never issues them, so it needs nothing from your `appName`.

## Atlas specifics

> Values as of October 2026. Always check the current Atlas documentation.

- **Connection limits apply per node** (per `mongos` for sharded clusters): M10 is 1,500; M20 and M30 are 3,000.
- **Connection rate limits:** always on for M10 and M20; on M30 and above only from MongoDB 9.0. Excess connections are queued, and sustained overload drops some. New connections per second per node: **M10/M20 15, M30 24, M40 85, M50 170, M60 320** (verified October 2026; `ATLAS_TIERS` in `@sameernair/krepis/connections`). The server-side mechanism is mongod's ingress connection-establishment rate limiter (8.0.12+), which is what the local test rig turns on.
- **Free tier (M0) and Flex** have their own, lower limits. Development and testing for this project run there and on a local replica set, so read the limits for the tier actually under test.

The rate limit matters most: cleanup logic that closes and reopens connections across many instances, or a deploy or failover that reconnects everyone at once, can hit it and look exactly like running out of connections.

## Recommended defaults (starting points)

- **One client per process**, created once and reused (one per tenant with `TenantPools`).
- **`maxPoolSize` from measured peak**, with headroom, instead of the default 100.
- **`maxIdleTimeMS` below the network path's idle timeout**, so the driver retires idle connections before the network drops them.
- **A sensible `waitQueueTimeoutMS`**, so saturation fails fast and visibly.
- **Serverless:** create the client outside the handler and reuse it.
- **Per-tenant pools:** `minPoolSize: 0`, a small `maxPoolSize`, and evict pools for tenants that have been idle (least recently used), so connections track active tenants rather than all tenants. `TenantPools` applies these by default.
- **`maxIdleTimeMS` of minutes, not seconds**, whenever `minPoolSize` > 0 (KR-C008).
- **`socketTimeoutMS: 0` and `maxTimeMS` per operation** instead of a socket timeout (KR-C010).
- **mongodb 7.1 or later** (Mongoose 9) for connection backpressure (KR-C012).
- **A distinct `appName` per service**, so the server's logs and Atlas attribute connections and failed logins to the right service (KR-C011).

## What Krepis will not do

- **Replace the driver's pool.** The pool implements server selection, retries, session pinning and failover to a cross-driver specification. Krepis configures and diagnoses it.
- **Put a network round trip in front of every query**, for example to gate queries through a shared service.
