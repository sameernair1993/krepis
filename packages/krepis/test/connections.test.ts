import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as mongodb from 'mongodb';
import { MongoClient } from 'mongodb';
import {
  checkConnectionOptions,
  driverHasBackpressure,
  KrepisConnectionConfigError,
  TenantLoginsFailingError,
  TenantPools,
  uriPoolOptions,
  watchConnections,
  type ConnectionFinding,
  type TenantPoolEvent,
} from '../src/connections/index.ts';
import { idleRate } from '../src/connections/watcher.ts';

// An auth-enabled server, separate from the suite's 27018 (which runs without auth). See CONTRIBUTING.md.
const AUTH_URI = process.env.KREPIS_AUTH_URI ?? 'mongodb://root:rootpw@127.0.0.1:27019/?authSource=admin';
const HOST = AUTH_URI.replace(/^mongodb:\/\/[^@]*@/, '').replace(/\/.*$/, '');
const NO_BACKPRESSURE = { MongoErrorLabel: {} };

const rules = (fs: ConnectionFinding[]) => fs.map((f) => `${f.rule}:${f.severity}`).sort();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

// ---------- Preflight (no server) ----------

test('preflight: the pre-incident options raise idle churn, socket timeout, appName and backpressure', () => {
  const f = checkConnectionOptions({
    options: { minPoolSize: 1, maxPoolSize: 5, maxIdleTimeMS: 30_000, socketTimeoutMS: 30_000 },
    driver: NO_BACKPRESSURE,
    deployment: { tier: 'M10' },
    fleet: { instances: 4, pools: 20 },
  });
  assert.deepEqual(rules(f), ['KR-C008:error', 'KR-C010:warn', 'KR-C011:warn', 'KR-C012:warn']);
  const churn = f.find((x) => x.rule === 'KR-C008')!;
  // 1 × 3,600,000 / 30,000 = 120 logins per hour per client per node; × 20 × 4 / 3600 ≈ 2.7/s per node.
  assert.equal(churn.evidence.loginsPerHourPerClientPerNode, 120);
  assert.equal(churn.evidence.fleetNewConnectionsPerSecPerNode, 2.7);
  assert.equal(churn.evidence.rateLimitPerSec, 15);
});

test('preflight: the post-fix options raise no idle churn', () => {
  const f = checkConnectionOptions({
    options: { minPoolSize: 0, maxPoolSize: 5, maxIdleTimeMS: 600_000, socketTimeoutMS: 60_000, appName: 'svc' },
    driver: NO_BACKPRESSURE,
  });
  assert.deepEqual(rules(f), ['KR-C010:warn', 'KR-C012:warn']);
});

test('preflight: idle churn is a warning between one and five minutes, and absent at five', () => {
  const at = (maxIdleTimeMS: number) => rules(checkConnectionOptions({ options: { minPoolSize: 1, maxIdleTimeMS, appName: 'a' } })).filter((r) => r.startsWith('KR-C008'));
  assert.deepEqual(at(59_999), ['KR-C008:error']);
  assert.deepEqual(at(60_000), ['KR-C008:warn']);
  assert.deepEqual(at(300_000), []);
  assert.deepEqual(rules(checkConnectionOptions({ options: { minPoolSize: 1, maxIdleTimeMS: 0, appName: 'a' } })), [], 'maxIdleTimeMS 0 never retires idle connections');
});

test('preflight: backpressure is feature-detected from the driver module', () => {
  assert.equal(driverHasBackpressure(mongodb), true, 'the resolved driver is 7.7');
  assert.equal(driverHasBackpressure(NO_BACKPRESSURE), false);
  assert.equal(driverHasBackpressure(undefined), false);
  assert.ok(!rules(checkConnectionOptions({ options: { appName: 'a' } })).some((r) => r.startsWith('KR-C012')));
});

test('preflight: tenant pools that fill an M10 node while idle are an error; peak-only overflow is a warning', () => {
  const idle = checkConnectionOptions({ options: { minPoolSize: 1, appName: 'a' }, deployment: { tier: 'M10' }, fleet: { instances: 10, pools: 200 } });
  const c7 = idle.find((f) => f.rule === 'KR-C007')!;
  assert.equal(c7.severity, 'error');
  assert.equal(c7.evidence.idlePerNode, 200 * 10 * (1 + 2), 'streaming monitoring: 2 sockets per node');
  // Polling monitors alone: 200 × 10 × 1 = 2,000 > 1,500. minPoolSize 0 is not enough at this scale.
  const monitorsOnly = checkConnectionOptions({ options: { minPoolSize: 0, serverMonitoringMode: 'poll', appName: 'a' }, deployment: { tier: 'M10' }, fleet: { instances: 10, pools: 200 } });
  assert.equal(monitorsOnly.find((f) => f.rule === 'KR-C007')!.severity, 'error');
  const poll = checkConnectionOptions({ options: { minPoolSize: 0, maxPoolSize: 5, serverMonitoringMode: 'poll', appName: 'a' }, deployment: { tier: 'M10' }, fleet: { instances: 10, pools: 50 } });
  const peak = poll.find((f) => f.rule === 'KR-C007')!;
  assert.equal(peak.severity, 'warn');
  assert.equal(peak.evidence.idlePerNode, 500);
  assert.equal(peak.evidence.peakPerNode, 3_000);
  const single = checkConnectionOptions({ options: { appName: 'a' }, deployment: { maxConnectionsPerNode: 500 }, fleet: { instances: 6 } });
  assert.deepEqual(rules(single), ['KR-C003:error'], '6 × (100 + 2) = 612 > 500');
});

test('preflight: pool options in the connection string are read', () => {
  assert.deepEqual(uriPoolOptions('mongodb://h1,h2/db?minPoolSize=1&MAXIDLETIMEMS=30000&appName=x&w=1'), { minPoolSize: 1, maxIdleTimeMS: 30000, appName: 'x' });
  assert.deepEqual(uriPoolOptions('mongodb://h1/db'), {});
});

test('watcher: the idle rate skips the opening batch even when its connections retire far apart', () => {
  // A slow CI runner: connect()'s one-off connection retired 120 ms after the minPoolSize one, then one refill per ~400 ms.
  const closures = [0, 120, 520, 920];
  assert.equal(Math.round(idleRate(closures, 300)!.perHour), Math.round((2 / 920) * 3_600_000));
  // Without maxIdleTimeMS the 50 ms window counts the one-off as a cycle.
  assert.equal(Math.round(idleRate(closures)!.perHour), Math.round((3 / 920) * 3_600_000));
});

// ---------- Against an auth-enabled server ----------

let admin: MongoClient;
let available = false;

before(async () => {
  admin = new MongoClient(AUTH_URI, { serverSelectionTimeoutMS: 2000, appName: 'krepis-test-admin' });
  try {
    await admin.connect();
    available = true;
  } catch {
    available = false;
  }
});

after(async () => {
  if (available) {
    for (const u of ['kr_t1', 'kr_t2', 'kr_g1', 'kr_g2', 'kr_g3', 'kr_g4', 'kr_g5']) await admin.db('admin').command({ dropUser: u }).catch(() => {});
  }
  await admin.close();
});

async function createUser(name: string, pwd: string): Promise<void> {
  await admin.db('admin').command({ dropUser: name }).catch(() => {});
  await admin.db('admin').command({ createUser: name, pwd, roles: [{ role: 'readWrite', db: 'krepis_conn_test' }] });
}
const changePassword = (name: string, pwd: string) => admin.db('admin').command({ updateUser: name, pwd });
const userUri = (name: string, pwd: string) => `mongodb://${name}:${pwd}@${HOST}/?authSource=admin`;

test('watcher: minPoolSize with a short maxIdleTimeMS is caught as idle re-login churn', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  const client = new MongoClient(AUTH_URI, { minPoolSize: 1, maxIdleTimeMS: 300 });
  const w = watchConnections(client);
  await client.connect();
  try {
    assert.ok(await until(() => w.findings.some((f) => f.rule === 'KR-C008'), 4000), JSON.stringify(w.stats()));
    const f = w.findings.find((x) => x.rule === 'KR-C008')!;
    // One login every maxIdleTimeMS plus the pool's maintenance tick and the login itself: ~314 ms locally (~11,500/h),
    // ~406 ms on a GitHub runner (~8,900/h). The ceiling is fixed by maxIdleTimeMS (3,600,000 / 300 = 12,000); the floor
    // depends on machine speed, so allow a cycle of up to 3 × maxIdleTimeMS.
    const perHour = f.evidence.loginsPerHour as number;
    assert.ok(perHour > 3_600_000 / 900 && perHour < 12500, String(perHour));
  } finally {
    w.stop();
    await client.close();
  }
});

test('watcher: rotated credentials are caught as an authentication failure loop', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  await createUser('kr_t1', 'old-pw');
  const client = new MongoClient(userUri('kr_t1', 'old-pw'), { minPoolSize: 1, maxIdleTimeMS: 300, heartbeatFrequencyMS: 500 });
  const w = watchConnections(client);
  await client.connect();
  try {
    await changePassword('kr_t1', 'new-pw');
    assert.ok(await until(() => w.findings.some((f) => f.rule === 'KR-C009'), 8000), JSON.stringify(w.stats()));
    assert.equal(w.findings.find((f) => f.rule === 'KR-C009')!.evidence.code, 18);
  } finally {
    w.stop();
    await client.close();
  }
});

test('watcher: operations outliving socketTimeoutMS are caught as timeout closures; maxTimeMS keeps connections', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  const coll = (c: MongoClient) => c.db('krepis_conn_test').collection('slow');
  await coll(admin).deleteMany({});
  await coll(admin).insertOne({ _id: 1 } as never);
  const slow = { $where: 'sleep(500) || true' };

  const client = new MongoClient(AUTH_URI, { socketTimeoutMS: 300 });
  const w = watchConnections(client);
  await client.connect();
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(coll(client).findOne(slow));
    assert.ok(await until(() => w.findings.some((f) => f.rule === 'KR-C010'), 2000), JSON.stringify(w.stats()));
  } finally {
    w.stop();
    await client.close();
  }

  const bounded = new MongoClient(AUTH_URI);
  const w2 = watchConnections(bounded);
  await bounded.connect();
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(coll(bounded).findOne(slow, { maxTimeMS: 300 }), (e: { code?: number }) => e.code === 50);
    const totals = Object.values(w2.stats())[0]!;
    assert.equal(totals.closed.error ?? 0, 0, 'maxTimeMS expiry leaves the connection usable');
    assert.equal(w2.findings.length, 0);
  } finally {
    w2.stop();
    await bounded.close();
  }
});

test('watcher: ordinary traffic with safe options raises nothing', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  const client = new MongoClient(AUTH_URI, { maxIdleTimeMS: 300_000, appName: 'krepis-test' });
  const w = watchConnections(client, { deployment: { tier: 'M10' } });
  await client.connect();
  try {
    await Promise.all(Array.from({ length: 50 }, (_, i) => client.db('krepis_conn_test').collection('x').findOne({ i })));
    await sleep(500);
    assert.deepEqual(w.findings, []);
  } finally {
    w.stop();
    await client.close();
  }
});

test('TenantPools: refuses options that would churn logins, before opening anything', async () => {
  let opened = 0;
  const pools = new TenantPools({
    appName: 'krepis-test',
    resolve: () => ({ uri: AUTH_URI, options: { minPoolSize: 2, maxIdleTimeMS: 30_000 } }),
    open: async () => { opened++; return {} as never; },
  });
  await assert.rejects(pools.get('a'), (e: unknown) => e instanceof KrepisConnectionConfigError && e.findings[0]!.rule === 'KR-C008');
  assert.equal(opened, 0);
  await pools.closeAll();
});

test('TenantPools: a rotated password trips the breaker, closes the client, then recovers via resolve()', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  await createUser('kr_t2', 'old-pw');
  let pwd = 'old-pw';
  const events: TenantPoolEvent[] = [];
  const pools = new TenantPools({
    appName: 'krepis-test',
    resolve: () => ({ uri: userUri('kr_t2', pwd) }),
    clientOptions: { maxIdleTimeMS: 100 },
    breaker: { threshold: 2, baseCooldownMs: 600, maxCooldownMs: 600 },
    random: () => 1,
    onEvent: (e) => events.push(e),
  });
  try {
    const c1 = await pools.get('t2');
    await c1.db('krepis_conn_test').collection('x').findOne({});
    await changePassword('kr_t2', 'new-pw');
    // Authenticated connections survive a password change; idle retirement forces each later operation to log in again.
    const ops = async () => {
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        try {
          const c = await pools.get('t2');
          await c.db('krepis_conn_test').collection('x').findOne({});
        } catch (e) {
          if (e instanceof TenantLoginsFailingError) return e;
        }
      }
      return undefined;
    };
    const tripped = await ops();
    assert.ok(tripped instanceof TenantLoginsFailingError, JSON.stringify(events));
    assert.equal((tripped.cause as { code?: number }).code, 18, 'the real driver error is the cause');
    assert.ok(events.some((e) => e.type === 'retired' && e.reason === 'breaker'));
    assert.equal(pools.stats().pools, 0, 'the tenant client was closed');

    pwd = 'new-pw';
    await sleep(650);
    const c2 = await pools.get('t2');
    assert.equal((await c2.db('admin').command({ ping: 1 })).ok, 1);
    assert.ok(events.some((e) => e.type === 'breakerClosed'));
  } finally {
    await pools.closeAll();
  }
});

test('TenantPools: one tenant rotated among five is not a storm; the others keep working', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  const keys = ['g1', 'g2', 'g3', 'g4', 'g5'];
  for (const k of keys) await createUser(`kr_${k}`, 'pw');
  const events: TenantPoolEvent[] = [];
  const pools = new TenantPools({
    appName: 'krepis-test',
    resolve: (key) => ({ uri: userUri(`kr_${key}`, 'pw') }),
    clientOptions: { maxIdleTimeMS: 100 },
    onEvent: (e) => events.push(e),
  });
  let othersFailed = 0;
  try {
    for (const k of keys) await (await pools.get(k)).db('krepis_conn_test').collection('x').findOne({});
    await changePassword('kr_g1', 'rotated');
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      await Promise.all(keys.map(async (k) => {
        try {
          await (await pools.get(k)).db('krepis_conn_test').collection('x').findOne({});
        } catch {
          if (k !== 'g1') othersFailed++;
        }
      }));
    }
    assert.equal(events.filter((e) => e.type === 'stormStarted').length, 0, JSON.stringify(events));
    const trips = events.filter((e): e is Extract<TenantPoolEvent, { type: 'breakerOpen' }> => e.type === 'breakerOpen');
    assert.ok(trips.length >= 1 && trips.every((e) => e.key === 'g1' && !e.storm));
    assert.equal(trips[0]!.failures, 3, 'the normal threshold, not a storm trip');
    assert.equal(othersFailed, 0);
  } finally {
    await pools.closeAll();
  }
});

test('TenantPools: idle tenants are evicted, the least recently used is retired at the cap, and rotation is noticed', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  const events: TenantPoolEvent[] = [];
  let version = 1;
  const pools = new TenantPools({
    appName: 'krepis-test',
    resolve: (key) => ({ uri: AUTH_URI, fingerprint: `${key}:${version}` }),
    maxPools: 2,
    evictIdleMs: 600,
    retireGraceMs: 0,
    credentialCheckMs: 0,
    onEvent: (e) => events.push(e),
  });
  try {
    const a = await pools.get('a');
    await pools.get('b');
    await pools.get('c');
    assert.ok(events.some((e) => e.type === 'retired' && e.key === 'a' && e.reason === 'lru'));
    assert.equal(pools.stats().pools, 2);

    version = 2;
    await pools.get('c');
    await sleep(20);
    assert.ok(events.some((e) => e.type === 'credentialsChanged' && e.key === 'c'));
    const c2 = await pools.get('c');
    assert.notEqual(c2, a);
    assert.ok(events.some((e) => e.type === 'retired' && e.key === 'c' && e.reason === 'credentials'));

    assert.ok(await until(() => pools.stats().pools === 0, 3000), 'idle tenants evicted');
    assert.ok(events.some((e) => e.type === 'retired' && e.reason === 'idle'));
  } finally {
    await pools.closeAll();
  }
});

test('TenantPools: safe defaults hold no connections for an idle tenant and raise no findings', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  const events: TenantPoolEvent[] = [];
  const pools = new TenantPools({ appName: 'krepis-test', resolve: () => ({ uri: AUTH_URI }), onEvent: (e) => events.push(e) });
  try {
    const c = await pools.get('quiet');
    assert.equal(c.options.minPoolSize, 0);
    assert.equal(c.options.serverMonitoringMode, 'poll');
    assert.equal(c.options.appName, 'krepis-test');
    await c.db('krepis_conn_test').collection('x').findOne({});
    await sleep(300);
    assert.deepEqual(events.filter((e) => e.type === 'finding'), []);
  } finally {
    await pools.closeAll();
  }
});
