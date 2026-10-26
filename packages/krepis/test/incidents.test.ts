import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { analyse, FlightRecorder, IncidentMonitor, TenantPools, type ConnectionFinding, type IncidentDump, type RecordedEvent } from '../src/connections/index.ts';

const A = 'db0:27017';
const AUTH_ERR = { name: 'MongoServerError', code: 18, codeName: 'AuthenticationFailed', message: 'Authentication failed for pw-secret-1' };
const NET_ERR = { name: 'MongoNetworkError', message: 'connect ECONNREFUSED' };

class FakeClient {
  options: { socketTimeoutMS?: number };
  private ee = new EventEmitter();
  constructor(options: { socketTimeoutMS?: number } = {}) {
    this.options = options;
  }
  on(event: string, listener: (e: never) => void): this {
    this.ee.on(event, listener as (e: unknown) => void);
    return this;
  }
  off(event: string, listener: (e: never) => void): this {
    this.ee.off(event, listener as (e: unknown) => void);
    return this;
  }
  emit(event: string, payload: unknown): void {
    this.ee.emit(event, payload);
  }
}

function rig(options: ConstructorParameters<typeof IncidentMonitor>[0] = {}) {
  const clock = { now: 1_000_000 };
  const findings: ConnectionFinding[] = [];
  const monitor = new IncidentMonitor({ now: () => clock.now, onFinding: (f) => findings.push(f), ...options });
  return { clock, findings, monitor };
}
const i001 = (fs: ConnectionFinding[]) => fs.filter((f) => f.rule === 'KR-I001');

// ---------- KR-I001 ----------

test('I001: a pool growing under a burst, or shrinking after it, costs nothing', () => {
  const { clock, findings, monitor } = rig();
  const c = new FakeClient();
  monitor.watch(c, { label: 't', rules: false });
  for (let id = 1; id <= 50; id++) {
    c.emit('connectionCreated', { address: A, connectionId: id });
    c.emit('connectionCheckedOut', { address: A, connectionId: id });
  }
  clock.now += 2_000;
  for (let id = 1; id <= 50; id++) c.emit('connectionClosed', { address: A, connectionId: id, reason: 'idle' });
  assert.deepEqual(i001(findings), []);
});

test('I001: replacing connections with no work behind them is reported as idle churn, citing KR-C008', () => {
  const { clock, findings, monitor } = rig();
  const c = new FakeClient();
  monitor.watch(c, { label: 't', rules: false });
  for (let id = 1; id <= 6; id++) {
    clock.now += 1_000;
    c.emit('connectionClosed', { address: A, connectionId: id, reason: 'idle' });
    c.emit('connectionCreated', { address: A, connectionId: id + 1 });
  }
  const [f] = i001(findings);
  assert.equal(f?.evidence.mechanism, 'idle-churn');
  assert.equal(f?.evidence.relatedRule, 'KR-C008');
  assert.equal(f?.client, 't');
  assert.equal(i001(findings).length, 1, 'deduplicated per mechanism');
});

test('I001: losing connections without replacing them is not a loop; no new logins are made', () => {
  const { findings, monitor } = rig();
  const c = new FakeClient();
  monitor.watch(c, { label: 't', rules: false });
  for (let i = 0; i < 12; i++) c.emit('connectionCheckedOut', { address: A, connectionId: 1 });
  for (let id = 1; id <= 10; id++) c.emit('connectionClosed', { address: A, connectionId: id + 100, reason: 'error', error: NET_ERR });
  assert.deepEqual(i001(findings), []);
});

test('I001: occasional replacements under real traffic stay below the cost ratio', () => {
  const { clock, findings, monitor } = rig();
  const c = new FakeClient();
  monitor.watch(c, { label: 't', rules: false });
  for (let i = 0; i < 1000; i++) c.emit('connectionCheckedOut', { address: A, connectionId: 1 });
  for (let id = 2; id < 10; id++) {
    clock.now += 500;
    c.emit('connectionClosed', { address: A, connectionId: id, reason: 'error', error: NET_ERR });
    c.emit('connectionCreated', { address: A, connectionId: id + 100 });
  }
  assert.deepEqual(i001(findings), []);
});

test('I001: an auth loop is reported as auth-failure even while an earlier idle-churn finding is still in the window', () => {
  const dumps: IncidentDump[] = [];
  const { clock, findings, monitor } = rig({ recorder: { onDump: (d) => dumps.push(d) } });
  const c = new FakeClient();
  monitor.watch(c, { label: 't', rules: false });
  for (let id = 1; id <= 6; id++) {
    clock.now += 300;
    c.emit('connectionClosed', { address: A, connectionId: id, reason: 'idle' });
    c.emit('connectionCreated', { address: A, connectionId: id + 10 });
  }
  for (let id = 20; id < 23; id++) {
    clock.now += 300;
    c.emit('connectionCreated', { address: A, connectionId: id });
    c.emit('connectionClosed', { address: A, connectionId: id, reason: 'error', error: AUTH_ERR });
    c.emit('connectionCheckOutFailed', { address: A, reason: 'connectionError', error: AUTH_ERR });
  }
  assert.deepEqual(i001(findings).map((f) => f.evidence.mechanism), ['idle-churn', 'auth-failure']);
  assert.equal(i001(findings)[1]!.evidence.relatedRule, 'KR-C009');
  assert.deepEqual(dumps.map((d) => d.reason), ['KR-I001:idle-churn', 'KR-I001:auth-failure'], 'the first dump does not suppress the second');
});

test('recorder: by default, failures paced by the 10 s heartbeat are one run, not several', () => {
  let now = 0;
  const r = new FlightRecorder({ now: () => now });
  const a = r.intern('a');
  for (const t of [0, 10_000, 20_000]) r.record('closed', t, a, 0, r.intern('error'));
  now = 21_000;
  assert.equal(r.dump('manual').analysis.firstMovers[0]!.events, 3);
});

test('I001: an error closure is a socket timeout only when its checkout lasted about socketTimeoutMS', () => {
  const run = (checkoutMs: number) => {
    const { clock, findings, monitor } = rig();
    const c = new FakeClient({ socketTimeoutMS: 500 });
    monitor.watch(c, { label: 't', rules: false });
    for (let id = 1; id <= 6; id++) {
      c.emit('connectionCreated', { address: A, connectionId: id });
      c.emit('connectionCheckedOut', { address: A, connectionId: id });
      clock.now += checkoutMs;
      c.emit('connectionCheckedIn', { address: A, connectionId: id });
      c.emit('connectionClosed', { address: A, connectionId: id, reason: 'error' });
    }
    return i001(findings).map((f) => f.evidence.mechanism);
  };
  assert.deepEqual(run(500), ['socket-timeout']);
  assert.deepEqual(run(20), ['connection-error']);
});

test('I001 fleet: clients each under the threshold are reported together when the node receives the sum', () => {
  const dumps: IncidentDump[] = [];
  const { clock, findings, monitor } = rig({ recorder: { onDump: (d) => dumps.push(d) } });
  const clients = Array.from({ length: 4 }, () => new FakeClient());
  clients.forEach((c, i) => monitor.watch(c, { label: `t${i}`, rules: false }));
  // One failed login per client: 2 events each, under minCost 5 for every client alone.
  clients.forEach((c, i) => {
    clock.now += 200;
    c.emit('connectionCreated', { address: A, connectionId: i });
    c.emit('connectionClosed', { address: A, connectionId: i, reason: 'error', error: AUTH_ERR });
    c.emit('connectionCheckOutFailed', { address: A, reason: 'connectionError', error: AUTH_ERR });
  });
  const fs = i001(findings);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  assert.equal(fs[0]!.client, '*');
  assert.equal(fs[0]!.evidence.mechanism, 'auth-failure');
  assert.ok(fs[0]!.clients!.length >= 2 && fs[0]!.clients!.every((l) => l.startsWith('t')));
  assert.deepEqual(dumps.map((d) => d.reason), ['KR-I001:auth-failure']);
});

test('I001 fleet: a loop confined to one client is left to the per-client finding', () => {
  const { clock, findings, monitor } = rig();
  const [a, b] = [new FakeClient(), new FakeClient()];
  monitor.watch(a, { label: 'a', rules: false });
  monitor.watch(b, { label: 'b', rules: false });
  b.emit('connectionCheckedOut', { address: A, connectionId: 1 });
  for (let id = 1; id <= 6; id++) {
    clock.now += 1_000;
    a.emit('connectionClosed', { address: A, connectionId: id, reason: 'idle' });
    a.emit('connectionCreated', { address: A, connectionId: id + 1 });
  }
  assert.deepEqual(i001(findings).map((f) => f.client), ['a']);
});

test('I001: checkout timeouts are pool saturation; poolClosed is never cost', () => {
  const { findings, monitor } = rig();
  const c = new FakeClient();
  monitor.watch(c, { label: 't', rules: false });
  for (let i = 0; i < 10; i++) c.emit('connectionClosed', { address: A, connectionId: i, reason: 'poolClosed' });
  for (let i = 0; i < 10; i++) c.emit('connectionCheckOutFailed', { address: A, reason: 'poolClosed' });
  assert.deepEqual(findings, []);
  for (let i = 0; i < 5; i++) c.emit('connectionCheckOutFailed', { address: A, reason: 'timeout' });
  assert.deepEqual(i001(findings).map((f) => f.evidence.mechanism), ['pool-saturation']);
});

// ---------- KR-I002 ----------

test('I002: many clients re-establishing right after losing the server is one herd finding naming all of them', async () => {
  const findings: ConnectionFinding[] = [];
  const monitor = new IncidentMonitor({ onFinding: (f) => findings.push(f), herdQuietMs: 100, herdMaxMs: 400, recorder: false });
  const clients = Array.from({ length: 10 }, () => new FakeClient());
  clients.forEach((c, i) => monitor.watch(c, { label: `t${i}`, rules: false }));
  for (const c of clients) c.emit('connectionCheckedOut', { address: A, connectionId: 1 });
  for (const c of clients) c.emit('serverHeartbeatFailed', { connectionId: A, failure: NET_ERR });
  for (const c of clients) c.emit('connectionCreated', { address: A, connectionId: 2 });
  // A second wave inside the dedupe period is the same incident.
  for (const c of clients) c.emit('connectionCreated', { address: A, connectionId: 3 });
  await new Promise((r) => setTimeout(r, 800));
  const herds = findings.filter((f) => f.rule === 'KR-I002');
  assert.equal(herds.length, 1);
  assert.equal(herds[0]!.clients!.length, 10);
  monitor.stop();
});

test('I002: a single client reconnecting, or creations with no loss before them, is not a herd', async () => {
  const findings: ConnectionFinding[] = [];
  const monitor = new IncidentMonitor({ onFinding: (f) => findings.push(f), herdQuietMs: 50, herdMaxMs: 100, recorder: false });
  const clients = Array.from({ length: 10 }, () => new FakeClient());
  clients.forEach((c, i) => monitor.watch(c, { label: `t${i}`, rules: false }));
  for (const c of clients) c.emit('connectionCreated', { address: A, connectionId: 1 });
  clients[0]!.emit('serverHeartbeatFailed', { connectionId: A, failure: NET_ERR });
  for (let id = 2; id < 20; id++) clients[0]!.emit('connectionCreated', { address: A, connectionId: id });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(findings.filter((f) => f.rule === 'KR-I002'), []);
  monitor.stop();
});

// ---------- Flight recorder ----------

test('recorder: the ring keeps the newest records and says when the span was truncated', () => {
  let now = 0;
  const r = new FlightRecorder({ capacity: 16, now: () => now });
  const client = r.intern('t');
  for (let i = 0; i < 40; i++) r.record('created', (now = i * 10), client, r.intern(A));
  assert.equal(r.size, 16);
  const dump = r.dump('manual');
  assert.equal(dump.events.length, 16);
  assert.equal(dump.events[0]!.t, -150);
  assert.equal(dump.truncated, true);
  assert.equal(dump.events[0]!.client, 't');
});

test('recorder: first movers are ranked by the onset of their current run, and the ordering says who moved first', () => {
  const ev = (t: number, client: string, kind: RecordedEvent['kind'], reason?: string, code?: number): RecordedEvent => ({ t, client, kind, reason, code });
  const events = [
    ev(-60_000, 'b', 'closed', 'error'), // an old, finished run for b
    ev(-30_000, 'a', 'closed', 'error', 18),
    ev(-20_000, 'a', 'checkoutFailed', 'connectionError', 18), // 10 s gap: the same run (heartbeat-paced)
    ev(-10_000, 'a', 'closed', 'error', 18),
    ev(-5_000, 'x', 'heartbeatFailed'),
    ev(-4_500, 'b', 'closed', 'stale'),
    ev(-4_000, 'c', 'closed', 'error'),
    ev(-3_000, 'a', 'closed', 'idle'), // idle churn is not cost here
  ];
  const a = analyse(events, 15_000);
  assert.deepEqual(a.firstMovers.map((m) => [m.client, m.onsetMs]), [['a', -30_000], ['b', -4_500], ['c', -4_000]]);
  assert.equal(a.firstMovers[0]!.events, 3);
  assert.equal(a.ordering, 'client-before-server');
  assert.equal(a.firstAuthFailure?.client, 'a');
  assert.equal(analyse(events.filter((e) => e.client !== 'a'), 15_000).ordering, 'simultaneous');
  assert.equal(analyse([ev(-9_000, 'x', 'heartbeatFailed'), ev(-1_000, 'c', 'closed', 'error')], 15_000).ordering, 'server-before-client');
  assert.equal(analyse([ev(-1_000, 'c', 'closed', 'error')], 15_000).ordering, 'no-server-signal');
});

test('recorder: a finding dumps once per rule per interval, to onDump and dumpDir, with no error messages in it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kr-dump-'));
  try {
    const dumps: IncidentDump[] = [];
    const { clock, monitor } = rig({ recorder: { dumpDir: dir, onDump: (d) => dumps.push(d) } });
    const c = new FakeClient();
    monitor.watch(c, { label: 'tenant-a', rules: false });
    for (let id = 1; id <= 12; id++) {
      clock.now += 200;
      c.emit('connectionCheckedOut', { address: A, connectionId: 99 });
      c.emit('connectionCreated', { address: A, connectionId: id });
      c.emit('connectionClosed', { address: A, connectionId: id, reason: 'error', error: AUTH_ERR });
      c.emit('connectionCheckOutFailed', { address: A, reason: 'connectionError', error: AUTH_ERR });
    }
    assert.equal(dumps.length, 1);
    const d = dumps[0]!;
    assert.equal(d.reason, 'KR-I001:auth-failure');
    assert.equal(d.analysis.firstMovers[0]!.client, 'tenant-a');
    assert.equal(d.analysis.firstMovers[0]!.dominant, 'AuthenticationFailed');
    assert.ok(d.events.some((e) => e.kind === 'checkouts' && e.value! > 0), 'checkout counts are flushed into the dump');
    assert.ok(d.findings.some((f) => f.rule === 'KR-I001'));
    await new Promise((r) => setTimeout(r, 100));
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const text = await readFile(join(dir, files[0]!), 'utf8');
    assert.ok(!text.includes('pw-secret'), 'error messages are never recorded');
    assert.ok(text.includes('"codeName": "AuthenticationFailed"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitor: the per-mechanism rules run underneath, labelled, and their error findings also dump', () => {
  const dumps: IncidentDump[] = [];
  const { clock, findings, monitor } = rig({ recorder: { onDump: (d) => dumps.push(d) } });
  const c = new FakeClient();
  (c.options as Record<string, unknown>).minPoolSize = 1;
  monitor.watch(c, { label: 't', rules: { now: () => clock.now } });
  for (let id = 1; id <= 3; id++) {
    clock.now += 1_000;
    c.emit('connectionCreated', { address: A, connectionId: id });
    c.emit('connectionClosed', { address: A, connectionId: id, reason: 'error', error: AUTH_ERR });
  }
  const c009 = findings.find((f) => f.rule === 'KR-C009');
  assert.equal(c009?.client, 't');
  assert.ok(dumps.some((d) => d.reason === 'KR-C009'));
});

// ---------- Live, against the auth rig ----------

const AUTH_URI = process.env.KREPIS_AUTH_URI ?? 'mongodb://root:rootpw@127.0.0.1:27019/?authSource=admin';
const HOST = AUTH_URI.replace(/^mongodb:\/\/[^@]*@/, '').replace(/\/.*$/, '');
let admin: MongoClient;
let available = false;
before(async () => {
  admin = new MongoClient(AUTH_URI, { serverSelectionTimeoutMS: 2000 });
  try {
    await admin.connect();
    available = true;
  } catch {
    available = false;
  }
});
after(async () => {
  if (available) await admin.db('admin').command({ dropUser: 'kr_i1' }).catch(() => {});
  await admin.close();
});

test('live: TenantPools under a monitor labels an auth loop with its tenant and dumps evidence without the password', async (t) => {
  if (!available) return t.skip('no auth-enabled server at KREPIS_AUTH_URI');
  await admin.db('admin').command({ dropUser: 'kr_i1' }).catch(() => {});
  await admin.db('admin').command({ createUser: 'kr_i1', pwd: 'pw-live-old-5d1e', roles: [{ role: 'readWrite', db: 'krepis_conn_test' }] });
  const dumps: IncidentDump[] = [];
  const monitor = new IncidentMonitor({ recorder: { onDump: (d) => dumps.push(d) } });
  const pools = new TenantPools({
    appName: 'krepis-test',
    resolve: () => ({ uri: `mongodb://kr_i1:pw-live-old-5d1e@${HOST}/?authSource=admin` }),
    clientOptions: { maxIdleTimeMS: 100, heartbeatFrequencyMS: 500 },
    breaker: { mode: 'observe' },
    monitor,
  });
  try {
    const c = await pools.get('tenant-live');
    await c.db('krepis_conn_test').collection('x').findOne({});
    await admin.db('admin').command({ updateUser: 'kr_i1', pwd: 'pw-live-new-8c2b' });
    const end = Date.now() + 10_000;
    while (Date.now() < end && !monitor.findings.some((f) => f.rule === 'KR-I001' && f.evidence.mechanism === 'auth-failure')) {
      await new Promise((r) => setTimeout(r, 200));
      await c.db('krepis_conn_test').collection('x').findOne({}).catch(() => {});
    }
    const f = monitor.findings.find((x) => x.rule === 'KR-I001' && x.evidence.mechanism === 'auth-failure');
    assert.ok(f, JSON.stringify(monitor.findings.map((x) => [x.rule, x.evidence.mechanism ?? null])));
    assert.equal(f.client, 'tenant-live');
    const d = dumps.find((x) => x.reason === 'KR-I001' || x.reason === 'KR-C009')!;
    assert.ok(d.analysis.firstAuthFailure, 'the dump identifies the first failed login');
    const text = JSON.stringify(dumps);
    for (const secret of ['pw-live-old-5d1e', 'pw-live-new-8c2b', 'rootpw']) assert.ok(!text.includes(secret), secret);
  } finally {
    await pools.closeAll();
    monitor.stop();
  }
});
