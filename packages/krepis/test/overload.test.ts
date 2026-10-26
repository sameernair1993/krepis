import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClusterRefusingConnectionsError, TenantPools, type OverloadOptions, type TenantPoolEvent } from '../src/connections/index.ts';

// A fake fleet: each tenant's handle is an EventEmitter the test drives with CMAP events, as the driver would.
// `refuse` holds tenants whose open() fails the way a refusing node makes it fail.
function rig(opts: { overload?: OverloadOptions | false; hosts?: (key: string) => string } = {}) {
  let clock = 1_000_000;
  const handles = new Map<string, EventEmitter>();
  const opens = new Map<string, number>();
  const refuse = new Map<string, Error>();
  const events: TenantPoolEvent[] = [];
  const pools = new TenantPools<EventEmitter>({
    appName: 'krepis-test',
    resolve: (key) => ({ uri: `mongodb://${key}:pw@${opts.hosts?.(key) ?? 'h1:27017'}/db`, fingerprint: key }),
    open: async (uri) => {
      const key = /^mongodb:\/\/([^:]+):/.exec(uri)![1]!;
      opens.set(key, (opens.get(key) ?? 0) + 1);
      const err = refuse.get(key);
      if (err) throw err;
      const h = new EventEmitter();
      handles.set(key, h);
      return h;
    },
    clientOf: (h) => h as never,
    close: async () => {},
    watch: false,
    retireGraceMs: 0,
    ...(opts.overload === undefined ? {} : { overload: opts.overload }),
    now: () => clock,
    onEvent: (e) => events.push(e),
  });
  let nextId = 1;
  const emit = (key: string, name: string, e: object) => handles.get(key)!.emit(name, { address: 'h1:27017', ...e });
  const refused = () => Object.assign(new Error('connection reset by peer'), { name: 'MongoNetworkError' });
  /** A connection that the node refuses while it is being established. */
  const fail = (key: string, address = 'h1:27017') => {
    const connectionId = nextId++;
    emit(key, 'connectionCreated', { connectionId, address });
    emit(key, 'connectionClosed', { connectionId, address, reason: 'error', error: refused() });
  };
  /** A connection that is established and stays open; returns its id. */
  const ready = (key: string, address = 'h1:27017') => {
    const connectionId = nextId++;
    emit(key, 'connectionCreated', { connectionId, address });
    emit(key, 'connectionReady', { connectionId, address });
    return connectionId;
  };
  /** The node answers something (a monitor heartbeat succeeds) on behalf of tenant `key`'s client. */
  const answer = (key: string, address = 'h1:27017') => emit(key, 'serverHeartbeatSucceeded', { connectionId: address });
  /** The node refuses once and then answers: it is alive and saturated, so its next refusals count. */
  const prime = (key = 'a', address = 'h1:27017') => {
    fail(key, address);
    answer(key, address);
  };
  const attempt = async (key: string) => {
    try {
      await pools.get(key);
      return 'ok';
    } catch (e) {
      if (e instanceof ClusterRefusingConnectionsError) return 'shed';
      throw e;
    }
  };
  /** Opens tenants (with no established connection yet). */
  const open = async (...keys: string[]) => {
    for (const k of keys) await pools.get(k);
  };
  const tick = () => (pools as unknown as { governorTick(): void }).governorTick();
  const of = (type: TenantPoolEvent['type']) => events.filter((e) => e.type === type);
  return { pools, handles, opens, refuse, refused, events, of, emit, fail, ready, answer, prime, attempt, open, tick, advance: (ms: number) => (clock += ms) };
}

const CLUSTER = 'mongodb://h1:27017';

test('overload: three distinct tenants refused within the window start it; two do not, nor one refused repeatedly', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.fail('a');
  r.fail('a');
  r.fail('b');
  assert.equal(r.of('overloadStarted').length, 0);
  assert.deepEqual(r.pools.stats().overloaded, []);
  r.fail('c');
  assert.deepEqual(r.of('overloadStarted'), [{ type: 'overloadStarted', cluster: CLUSTER, tenants: 3, nodes: ['h1:27017'], mode: 'enforce' }]);
  assert.deepEqual(r.pools.stats().overloaded, [CLUSTER]);
  r.fail('a');
  assert.equal(r.of('overloadStarted').length, 1, 'started once, not per failure');
  await r.pools.closeAll();
});

test('overload: refusals spread wider than the window are not an overload', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.advance(6_000);
  r.fail('b');
  r.advance(6_000);
  r.fail('c');
  assert.equal(r.of('overloadStarted').length, 0);
  await r.pools.closeAll();
});

test('overload: cold tenants are parked when it starts; warm ones keep their client and are never shed', async () => {
  const r = rig();
  await r.open('a', 'b', 'c', 'warm');
  r.ready('warm');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  const parked = r.events.filter((e) => e.type === 'retired' && e.reason === 'overload').map((e) => (e as { key: string }).key);
  assert.deepEqual(parked.sort(), ['a', 'b', 'c']);
  assert.equal(r.pools.stats().pools, 1);
  for (let i = 0; i < 10; i++) assert.equal(await r.attempt('warm'), 'ok');
  assert.equal(r.opens.get('warm'), 1);
  await r.pools.closeAll();
});

test('overload: at most maxColdTenants cold tenants hold a client, admitted at admitPerSecond', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  assert.equal(await r.attempt('a'), 'ok');
  assert.equal(await r.attempt('b'), 'ok');
  for (let i = 0; i < 3; i++) assert.equal(await r.attempt('a'), 'ok', 'an admitted trial keeps its client');
  let shed: unknown;
  try {
    await r.pools.get('c');
  } catch (e) {
    shed = e;
  }
  assert.ok(shed instanceof ClusterRefusingConnectionsError);
  assert.equal(shed.name, 'ClusterRefusingConnectionsError');
  assert.equal(shed.code, 'MONGODB_CLUSTER_REFUSING_CONNECTIONS');
  assert.equal(shed.source, 'krepis');
  assert.equal(shed.key, 'c');
  assert.equal(shed.retryAfterMs, 500);
  assert.equal(shed.cluster, CLUSTER);
  assert.deepEqual(shed.nodes, ['h1:27017']);
  assert.equal(shed.refusedTenants, 3);
  assert.equal(shed.since, 1_000_000);
  assert.equal((shed.cause as Error).name, 'MongoNetworkError', 'the driver error that showed the refusal');
  assert.equal(
    shed.message,
    'MongoDB cluster mongodb://h1:27017 is refusing new connections: 3 tenants were refused in the last 10 s, by h1:27017. ' +
      'Last error: MongoNetworkError: connection reset by peer. Krepis is holding tenant "c" back for 1 s so as not to add to the load.',
  );
  assert.equal(r.opens.get('c'), 1, 'a shed tenant is not reopened');
  r.ready('a');
  assert.equal(await r.attempt('c'), 'shed', 'a slot is free, but the admission budget is spent');
  r.advance(500);
  assert.equal(await r.attempt('c'), 'ok');
  assert.equal(r.opens.get('c'), 2);
  await r.pools.closeAll();
});

test('overload: a trial that stays cold for a whole window loses its slot and its client', async () => {
  const r = rig({ overload: { maxColdTenants: 1, admitPerSecond: 10 } });
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  assert.equal(await r.attempt('a'), 'ok');
  assert.equal(await r.attempt('b'), 'shed');
  r.advance(9_000);
  r.fail('a');
  assert.equal(r.pools.stats().pools, 1, 'a refused trial inside its window keeps its client');
  assert.equal(await r.attempt('b'), 'shed');
  r.advance(1_000);
  assert.equal(await r.attempt('b'), 'ok');
  assert.equal(r.pools.stats().pools, 1, 'a lapsed trial was closed');
  assert.equal(await r.attempt('a'), 'shed');
  await r.pools.closeAll();
});

test('overload: a refused cold tenant that is not a trial is parked; a refused warm one is not', async () => {
  const r = rig({ overload: { maxColdTenants: 1 } });
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  assert.equal(await r.attempt('a'), 'ok');
  const id = r.ready('a');
  assert.equal(await r.attempt('b'), 'ok', 'a warmed trial frees its slot');
  r.fail('a');
  assert.equal(r.pools.stats().pools, 2, 'warm: refused a further connection, keeps its client');
  r.emit('a', 'connectionClosed', { connectionId: id, reason: 'stale' });
  assert.equal(r.pools.stats().pools, 2, 'losing a connection is not itself a refusal');
  r.fail('a');
  assert.equal(r.pools.stats().pools, 1, 'cold and not a trial: parked');
  await r.pools.closeAll();
});
test('overload: an admitted tenant whose open fails frees its slot at once', async () => {
  const r = rig({ overload: { maxColdTenants: 1, admitPerSecond: 10 } });
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  r.refuse.set('a', r.refused());
  await assert.rejects(r.pools.get('a'), { name: 'MongoNetworkError' });
  r.advance(100);
  assert.equal(await r.attempt('b'), 'ok');
  await r.pools.closeAll();
});

test('overload: a closed established connection takes the tenant back under the gate', async () => {
  const r = rig({ overload: { admitPerSecond: 1, maxColdTenants: 1 } });
  await r.open('a', 'b', 'c', 'warm');
  const id = r.ready('warm');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  assert.equal(await r.attempt('a'), 'ok');
  assert.equal(await r.attempt('warm'), 'ok');
  r.emit('warm', 'connectionClosed', { connectionId: id, reason: 'stale' });
  assert.equal(await r.attempt('warm'), 'shed');
  assert.equal(r.pools.stats().pools, 1, 'and, shed, it is parked');
  await r.pools.closeAll();
});

test('overload: opening a tenant is gated before the driver is asked to connect', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  assert.equal(await r.attempt('new1'), 'ok');
  assert.equal(await r.attempt('new2'), 'ok');
  assert.equal(await r.attempt('new3'), 'shed');
  assert.equal(r.opens.get('new3'), undefined, 'a shed tenant never reaches open()');
  await r.pools.closeAll();
});

test('overload: failed heartbeats count as refusals, so the monitor alone can start it; the member is named', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.emit('a', 'serverHeartbeatFailed', { connectionId: 'h2:27017', failure: r.refused() });
  r.answer('b', 'h2:27017');
  const auth = Object.assign(new Error('Authentication failed.'), { code: 18, codeName: 'AuthenticationFailed' });
  for (const k of ['a', 'b', 'c']) r.emit(k, 'serverHeartbeatFailed', { connectionId: 'h2:27017', failure: auth });
  for (const k of ['a', 'b', 'c']) r.emit(k, 'serverHeartbeatFailed', { connectionId: 'h2:27017', failure: new Error('not a network error') });
  assert.equal(r.of('overloadStarted').length, 0);
  for (const k of ['a', 'b', 'c']) r.emit(k, 'serverHeartbeatFailed', { connectionId: 'h2:27017', failure: r.refused() });
  assert.equal(r.of('overloadStarted').length, 1);
  assert.deepEqual((r.of('overloadStarted')[0] as { nodes: string[] }).nodes, ['h2:27017']);
  await r.pools.closeAll();
});

test('overload: failed opens count as refusals, auth failures do not', async () => {
  const r = rig();
  for (const k of ['x', 'y', 'z']) r.refuse.set(k, Object.assign(new Error('Authentication failed.'), { code: 18, codeName: 'AuthenticationFailed' }));
  for (const k of ['x', 'y', 'z']) await assert.rejects(r.pools.get(k));
  assert.equal(r.of('overloadStarted').length, 0);
  await r.open('w');
  r.prime('w');
  for (const k of ['p', 'q']) r.refuse.set(k, r.refused());
  r.refuse.set('s', Object.assign(new Error('Server selection timed out'), { name: 'MongoServerSelectionError' }));
  for (const k of ['p', 'q', 's']) await assert.rejects(r.pools.get(k));
  assert.equal(r.of('overloadStarted').length, 1);
  assert.deepEqual((r.of('overloadStarted')[0] as { nodes: string[] }).nodes, [], 'an open failure without per-server detail names no node');
  await r.pools.closeAll();
});

test('overload: names every node that refused within the window, from pool refusals and server selection', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.fail('a', 'h2:27017');
  r.fail('b', 'h1:27017');
  r.advance(20_000);
  const selection = Object.assign(new Error('Server selection timed out'), {
    name: 'MongoServerSelectionError',
    reason: { servers: new Map<string, unknown>([['h3:27017', { error: r.refused() }], ['h4:27017', { error: null }]]) },
  });
  r.refuse.set('n', selection);
  await assert.rejects(r.pools.get('n'));
  r.fail('a', 'h2:27017');
  r.fail('b', 'h1:27017');
  assert.equal(r.of('overloadStarted').length, 0, 'none of these nodes has answered since it refused');
  for (const h of ['h1:27017', 'h2:27017', 'h3:27017']) r.answer('a', h);
  await assert.rejects(r.pools.get('n'));
  r.fail('a', 'h2:27017');
  r.fail('b', 'h1:27017');
  assert.equal(r.of('overloadStarted').length, 1);
  assert.deepEqual((r.of('overloadStarted')[0] as { nodes: string[] }).nodes, ['h1:27017', 'h2:27017', 'h3:27017']);
  await r.pools.closeAll();
});

test('overload: only an establishment the node broke counts, not a pool closing its own or an established one dropping', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.prime();
  const auth = Object.assign(new Error('Authentication failed.'), { code: 18, codeName: 'AuthenticationFailed' });
  for (const k of ['a', 'b', 'c']) {
    r.emit(k, 'connectionCreated', { connectionId: 100 });
    r.emit(k, 'connectionClosed', { connectionId: 100, reason: 'poolClosed' });
    r.emit(k, 'connectionCreated', { connectionId: 101 });
    r.emit(k, 'connectionClosed', { connectionId: 101, reason: 'error', error: auth });
    const id = r.ready(k);
    r.emit(k, 'connectionClosed', { connectionId: id, reason: 'error', error: r.refused() });
  }
  assert.equal(r.of('overloadStarted').length, 0);
  await r.pools.closeAll();
});

test('overload: connection ids are per server, so the same id on another member is a separate connection', async () => {
  const r = rig({ overload: { admitPerSecond: 1 } });
  await r.open('a', 'b', 'c');
  r.prime('b', 'h1:27017');
  r.prime('b', 'h2:27017');
  r.emit('a', 'connectionCreated', { connectionId: 7, address: 'h1:27017' });
  r.emit('a', 'connectionReady', { connectionId: 7, address: 'h1:27017' });
  r.emit('a', 'connectionCreated', { connectionId: 7, address: 'h2:27017' });
  r.emit('a', 'connectionClosed', { connectionId: 7, address: 'h2:27017', reason: 'error', error: r.refused() });
  r.fail('b');
  r.fail('c');
  assert.equal(r.of('overloadStarted').length, 1, "a's refusal on h2 counted despite h1 holding the same id");
  assert.equal(await r.attempt('b'), 'ok');
  for (let i = 0; i < 5; i++) assert.equal(await r.attempt('a'), 'ok', 'a still holds its h1 connection');
  await r.pools.closeAll();
});

test('overload: ends after quietMs without a refusal, reporting what it shed; a refusal pushes the end out', async () => {
  const r = rig({ overload: { admitPerSecond: 1 } });
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  assert.equal(await r.attempt('a'), 'ok');
  assert.equal(await r.attempt('b'), 'shed');
  assert.equal(await r.attempt('c'), 'shed');
  r.advance(8_000);
  r.fail('a');
  r.advance(8_000);
  r.tick();
  assert.equal(r.of('overloadEnded').length, 0, 'the refusal at 8 s restarted the quiet period');
  r.advance(2_000);
  r.tick();
  assert.deepEqual(r.of('overloadEnded'), [{ type: 'overloadEnded', cluster: CLUSTER, shed: 2, parked: 3 }]);
  assert.deepEqual(r.pools.stats().overloaded, []);
  for (const k of ['a', 'b', 'c', 'a', 'b', 'c']) assert.equal(await r.attempt(k), 'ok');
  await r.pools.closeAll();
});

test('overload: the governor keeps ticking while a cluster is overloaded, so the end is reached without traffic', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  const governor = () => (r.pools as unknown as { governor?: unknown }).governor;
  assert.ok(governor(), 'started');
  r.advance(10_000);
  r.tick();
  assert.equal(r.of('overloadEnded').length, 1);
  await r.pools.closeAll();
});

test('overload: is per cluster', async () => {
  const r = rig({ overload: { admitPerSecond: 1 }, hosts: (k) => (k.startsWith('z') ? 'h2:27017' : 'h1:27017') });
  await r.open('a', 'b', 'c', 'z1', 'z2', 'z3');
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  for (const k of ['z1', 'z2', 'z3', 'z4', 'z5']) assert.equal(await r.attempt(k), 'ok');
  await r.pools.closeAll();
});

test('overload: observe mode reports but never sheds; false does neither', async () => {
  for (const mode of ['observe', 'off'] as const) {
    const r = rig({ overload: mode === 'off' ? false : { mode, admitPerSecond: 1 } });
    await r.open('a', 'b', 'c');
    r.prime();
    r.fail('a');
    r.fail('b');
    r.fail('c');
    assert.equal(r.of('overloadStarted').length, mode === 'off' ? 0 : 1, mode);
    if (mode === 'observe') assert.equal((r.of('overloadStarted')[0] as { mode: string }).mode, 'observe');
    for (let i = 0; i < 6; i++) assert.equal(await r.attempt(['a', 'b', 'c', 'n1', 'n2', 'n3'][i]!), 'ok', mode);
    await r.pools.closeAll();
  }
});

test('overload: options are validated', () => {
  const base = { appName: 'x', resolve: () => ({ uri: 'mongodb://h/db' }) };
  assert.throws(() => new TenantPools({ ...base, overload: { minTenants: 1 } }), /minTenants/);
  assert.throws(() => new TenantPools({ ...base, overload: { admitPerSecond: 0 } }), /admitPerSecond/);
  assert.throws(() => new TenantPools({ ...base, overload: { maxColdTenants: 0 } }), /maxColdTenants/);
  assert.throws(() => new TenantPools({ ...base, overload: { maxColdTenants: 1.5 } }), /maxColdTenants/);
  assert.doesNotThrow(() => new TenantPools({ ...base, overload: false }));
});

test('overload: a connection made before Krepis attached (the driver pings inside connect) counts once it is checked out', async () => {
  const r = rig();
  await r.open('pre', 'a', 'b', 'c');
  // connect() created and authenticated this connection before attach, so its created/ready events were never seen.
  r.emit('pre', 'connectionCheckedOut', { connectionId: 99 });
  r.prime();
  r.fail('a');
  r.fail('b');
  r.fail('c');
  const parked = r.events.filter((e) => e.type === 'retired' && e.reason === 'overload').map((e) => (e as { key: string }).key);
  assert.deepEqual(parked.sort(), ['a', 'b', 'c'], 'a tenant holding a working connection is warm, not parked');
  for (let i = 0; i < 5; i++) assert.equal(await r.attempt('pre'), 'ok');
  assert.equal(r.opens.get('pre'), 1);

  r.advance(1_000);
  assert.equal(await r.attempt('a'), 'ok');
  assert.equal(await r.attempt('b'), 'ok');
  assert.equal(await r.attempt('c'), 'shed', 'both trial slots are held');
  // The trial's only connection also came from connect(): checking it out is what shows it warmed.
  r.emit('a', 'connectionCheckedOut', { connectionId: 7 });
  r.advance(500);
  assert.equal(await r.attempt('c'), 'ok', 'the warmed trial freed its slot');

  // Once that connection closes the tenant is cold again, and gated like any other.
  r.emit('pre', 'connectionClosed', { connectionId: 99, reason: 'stale' });
  assert.equal(await r.attempt('pre'), 'shed');
  await r.pools.closeAll();
});

// A refusal counts only from a node that has answered since it started refusing. A node at its connection
// limit keeps serving what it has (heartbeats, admitted connections); a dead node answers nothing.

test('overload: a node that refuses and never answers is dead, not overloaded', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  for (let i = 0; i < 4; i++) {
    for (const k of ['a', 'b', 'c']) {
      r.fail(k);
      r.emit(k, 'serverHeartbeatFailed', { connectionId: 'h1:27017', failure: r.refused() });
    }
    r.answer('a', 'h2:27017');
    r.advance(1_000);
  }
  assert.equal(r.of('overloadStarted').length, 0, 'another member answering does not vouch for h1');
  for (const k of ['a', 'b', 'c']) assert.equal(await r.attempt(k), 'ok');
  await r.pools.closeAll();
});

test('overload: refuse, answer, refuse starts it; refusals from before the answer are not counted', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.fail('a');
  r.fail('b');
  r.fail('c');
  assert.equal(r.of('overloadStarted').length, 0);
  r.advance(300);
  r.answer('a');
  r.fail('a');
  r.fail('b');
  assert.equal(r.of('overloadStarted').length, 0, 'two tenants since the answer');
  r.fail('c');
  assert.deepEqual(r.of('overloadStarted'), [{ type: 'overloadStarted', cluster: CLUSTER, tenants: 3, nodes: ['h1:27017'], mode: 'enforce' }]);
  await r.pools.closeAll();
});

test('overload: an answer before the node first refused does not count', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.answer('a');
  r.ready('a');
  r.advance(100);
  for (const k of ['a', 'b', 'c']) r.fail(k);
  for (const k of ['b', 'c']) r.fail(k);
  assert.equal(r.of('overloadStarted').length, 0);
  await r.pools.closeAll();
});

test('overload: an established connection is an answer, from any tenant of the cluster', async () => {
  const r = rig();
  await r.open('a', 'b', 'c', 'w');
  for (const k of ['a', 'b', 'c']) r.fail(k);
  assert.equal(r.of('overloadStarted').length, 0);
  r.ready('w');
  for (const k of ['a', 'b', 'c']) r.fail(k);
  assert.equal(r.of('overloadStarted').length, 1);
  await r.pools.closeAll();
});

test('overload: a node back from a restart answers and stops refusing, which is not an overload', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  for (let i = 0; i < 5; i++) {
    for (const k of ['a', 'b', 'c']) r.fail(k);
    r.advance(500);
  }
  for (const k of ['a', 'b', 'c']) r.answer(k);
  for (const k of ['a', 'b', 'c']) r.ready(k);
  r.advance(30_000);
  for (const k of ['a', 'b', 'c']) r.fail(k);
  assert.equal(r.of('overloadStarted').length, 0, 'the answers expired with the window');
  await r.pools.closeAll();
});

test('overload: an answer vouches for a node only within the window', async () => {
  const r = rig();
  await r.open('a', 'b', 'c');
  r.prime();
  r.advance(4_000);
  r.fail('a');
  r.advance(7_000);
  for (const k of ['a', 'b', 'c']) r.fail(k);
  assert.equal(r.of('overloadStarted').length, 0, 'last answer 11 s ago');
  r.answer('b');
  for (const k of ['a', 'b', 'c']) r.fail(k);
  assert.equal(r.of('overloadStarted').length, 1, 'refused 7 s before this answer, so it counts');
  await r.pools.closeAll();
});

test('overload: a refusal naming no node counts only while some node of the cluster is answering', async () => {
  const r = rig();
  for (const k of ['p', 'q', 's']) r.refuse.set(k, r.refused());
  for (const k of ['p', 'q', 's']) await assert.rejects(r.pools.get(k));
  assert.equal(r.of('overloadStarted').length, 0);
  await r.open('a');
  r.prime();
  r.fail('a');
  for (const k of ['p', 'q']) await assert.rejects(r.pools.get(k));
  assert.equal(r.of('overloadStarted').length, 1);
  assert.deepEqual((r.of('overloadStarted')[0] as { nodes: string[] }).nodes, ['h1:27017']);
  await r.pools.closeAll();
});
