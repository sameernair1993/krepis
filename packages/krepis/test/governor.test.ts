import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TenantLoginsFailingError, TenantPools, clusterKey, type BreakerOptions, type TenantPoolEvent } from '../src/connections/index.ts';
import { TokenBucket } from '../src/connections/governor.ts';

// A fake server: each tenant logs in as its own user; `accepted` holds what the server accepts, `published` what the
// secret store hands out. Opens are counted per tenant, so a test can tell a probe from a fast failure.
function rig(opts: { breaker?: BreakerOptions; hosts?: (key: string) => string } = {}) {
  let clock = 1_000_000;
  const accepted = new Map<string, string>();
  const published = new Map<string, string>();
  const opens = new Map<string, number>();
  const events: TenantPoolEvent[] = [];
  const authError = () => Object.assign(new Error('Authentication failed.'), { code: 18, codeName: 'AuthenticationFailed' });
  const pools = new TenantPools<EventEmitter & { key: string }>({
    appName: 'krepis-test',
    resolve: (key) => {
      const pw = published.get(key) ?? 'pw';
      return { uri: `mongodb://${key}:${pw}@${opts.hosts?.(key) ?? 'h1:27017'}/db`, fingerprint: `${key}:${pw}` };
    },
    open: async (uri) => {
      const m = /^mongodb:\/\/([^:]+):([^@]+)@/.exec(uri)!;
      const key = m[1]!;
      opens.set(key, (opens.get(key) ?? 0) + 1);
      if ((accepted.get(key) ?? 'pw') !== m[2]) throw authError();
      return Object.assign(new EventEmitter(), { key });
    },
    clientOf: (h) => h as never,
    close: async () => {},
    watch: false,
    retireGraceMs: 0,
    breaker: { baseCooldownMs: 4_000, ...opts.breaker },
    random: () => 1,
    now: () => clock,
    onEvent: (e) => events.push(e),
  });
  const attempt = async (key: string) => {
    try {
      await pools.get(key);
      return 'ok';
    } catch (e) {
      return e instanceof TenantLoginsFailingError ? 'open' : 'auth';
    }
  };
  const tick = async () => {
    (pools as unknown as { governorTick(): void }).governorTick();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const of = (type: TenantPoolEvent['type']) => events.filter((e) => e.type === type);
  return { pools, accepted, published, opens, events, of, attempt, tick, advance: (ms: number) => (clock += ms), now: () => clock };
}

test('governor: the cluster key ignores credentials, database, options, host order and case', () => {
  const a = clusterKey('mongodb://u:p%40ss@B.example:27017,a.example:27017/db?authSource=admin&x=@');
  assert.equal(a, 'mongodb://a.example:27017,b.example:27017');
  assert.equal(clusterKey('mongodb://other:secret@a.example:27017,b.example:27017/'), a);
  assert.notEqual(clusterKey('mongodb+srv://u:p@a.example/db'), clusterKey('mongodb://u:p@a.example/db'));
  assert.ok(!clusterKey('mongodb://user:hunter2@h/db').includes('hunter2'));
});

test('governor: the token bucket allows its burst, then paces at its rate', () => {
  const b = new TokenBucket(2, 0);
  assert.equal(b.take(0), 0);
  assert.equal(b.take(0), 0);
  assert.equal(b.take(0), 500);
  assert.equal(b.take(500), 0);
  assert.equal(new TokenBucket(Infinity, 0).take(0), 0);
});

test('governor: a tripped tenant fails fast with TenantLoginsFailingError, carrying the driver error', async () => {
  const r = rig();
  r.accepted.set('a', 'rotated');
  for (let i = 0; i < 3; i++) assert.equal(await r.attempt('a'), 'auth');
  let err: unknown;
  try {
    await r.pools.get('a');
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof TenantLoginsFailingError);
  assert.equal(err.name, 'TenantLoginsFailingError');
  assert.equal(err.code, 'MONGODB_TENANT_LOGINS_FAILING');
  assert.equal(err.source, 'krepis');
  assert.equal(err.key, 'a');
  assert.equal(err.cluster, 'mongodb://h1:27017');
  assert.equal(err.retryAfterMs, 4_000);
  assert.equal(err.storm, false);
  assert.equal((err.cause as { codeName?: string }).codeName, 'AuthenticationFailed');
  assert.equal(
    err.message,
    'MongoDB logins for tenant "a" are failing on cluster mongodb://h1:27017. Last error: Error: Authentication failed. ' +
      'Krepis is not retrying them for 4 s, so failed logins do not pile up on the cluster.',
  );
  await r.pools.closeAll();
});

test('governor: one tenant with a bad password is not a storm and pays the normal threshold', async () => {
  const r = rig();
  for (const k of ['a', 'b', 'c', 'd', 'e']) assert.equal(await r.attempt(k), 'ok');
  r.accepted.set('a', 'rotated');
  await r.pools.invalidate('a');
  assert.equal(await r.attempt('a'), 'auth');
  assert.equal(await r.attempt('a'), 'auth');
  assert.equal(r.of('breakerOpen').length, 0, 'not tripped before the threshold');
  assert.equal(await r.attempt('a'), 'auth');
  const [open] = r.of('breakerOpen') as Extract<TenantPoolEvent, { type: 'breakerOpen' }>[];
  assert.equal(open?.failures, 3);
  assert.equal(open?.storm, false);
  assert.equal(r.of('stormStarted').length, 0);
  for (const k of ['b', 'c', 'd', 'e']) assert.equal(await r.attempt(k), 'ok');
  await r.pools.closeAll();
});

test('governor: when a third tenant fails, the storm trips every failing tenant on its first failure', async () => {
  const r = rig();
  for (const k of ['a', 'b', 'c', 'd']) r.accepted.set(k, 'unknown');
  assert.equal(await r.attempt('a'), 'auth');
  assert.equal(await r.attempt('b'), 'auth');
  assert.equal(r.of('breakerOpen').length, 0);
  assert.equal(await r.attempt('c'), 'auth');
  assert.equal(r.of('stormStarted').length, 1);
  assert.deepEqual(r.pools.stats().openBreakers.sort(), ['a', 'b', 'c']);
  assert.equal(await r.attempt('d'), 'auth');
  assert.ok(r.pools.stats().openBreakers.includes('d'), 'a new tenant trips on its first failure during a storm');
  assert.ok((r.of('breakerOpen') as Extract<TenantPoolEvent, { type: 'breakerOpen' }>[]).every((e) => e.storm && e.failures === 1));
  assert.deepEqual(r.pools.stats().storms, ['mongodb://h1:27017']);
  await r.pools.closeAll();
});

test('governor: failures spread wider than the window are not a storm', async () => {
  const r = rig({ breaker: { storm: { windowMs: 10_000 } } });
  for (const k of ['a', 'b', 'c']) r.accepted.set(k, 'unknown');
  for (const k of ['a', 'b', 'c']) {
    assert.equal(await r.attempt(k), 'auth');
    r.advance(10_001);
  }
  assert.equal(r.of('stormStarted').length, 0);
  assert.equal(r.of('breakerOpen').length, 0, 'one failure each is below the normal threshold');
  await r.pools.closeAll();
});

test('governor: during a storm, unchanged credentials wait for one canary; its success releases the cluster', async () => {
  const r = rig();
  const keys = ['a', 'b', 'c', 'd', 'e'];
  for (const k of keys) r.accepted.set(k, 'unknown');
  for (const k of keys) await r.attempt(k);
  r.opens.clear();

  r.advance(4_001); // past the first canary slot and every tenant's first cooldown
  assert.equal(await r.attempt('a'), 'auth', 'the canary probes');
  for (const k of keys.slice(1)) assert.equal(await r.attempt(k), 'open');
  assert.equal([...r.opens.values()].reduce((s, n) => s + n, 0), 1, 'one login attempt for the whole cluster');
  assert.deepEqual(r.of('canary').map((e) => (e as { ok: boolean }).ok), [false]);

  r.advance(4_001);
  assert.equal(await r.attempt('b'), 'open', 'the second canary waits for the doubled schedule (8 s)');
  r.advance(4_000);
  for (const k of keys) r.accepted.set(k, 'pw'); // the authentication path recovers; nothing was republished
  assert.equal(await r.attempt('b'), 'ok');
  assert.deepEqual(r.of('canary').map((e) => (e as { ok: boolean }).ok), [false, true]);
  assert.equal(r.of('stormEnded').length, 1);
  for (const k of ['a', 'c', 'd', 'e']) assert.equal(await r.attempt(k), 'ok', `${k} released by the canary`);
  await r.pools.closeAll();
});

test('governor: a successful canary releases tenants whose own cooldowns run longer', async () => {
  const r = rig({ breaker: { storm: { canaryMaxMs: 4_000 } } });
  const keys = ['a', 'b', 'c'];
  for (const k of keys) r.accepted.set(k, 'unknown');
  for (const k of keys) await r.attempt(k);
  r.advance(4_001);
  assert.equal(await r.attempt('a'), 'auth', 'first canary fails; a now cools down for 8 s');
  for (const k of keys) r.accepted.set(k, 'pw');
  r.advance(4_001); // the next canary is due (4 s cap); a's own cooldown is not
  assert.equal(await r.attempt('b'), 'ok');
  assert.equal(await r.attempt('a'), 'ok', 'released by the canary, not by its own cooldown');
  await r.pools.closeAll();
});

test('governor: new credentials found by the poll end the cooldown at once', async () => {
  const r = rig({ breaker: { baseCooldownMs: 60_000, credentialPollMs: 2_000 } });
  for (const k of ['a', 'b', 'c']) r.accepted.set(k, 'rotated');
  for (const k of ['a', 'b', 'c']) await r.attempt(k);
  assert.equal(r.pools.stats().openBreakers.length, 3);
  r.published.set('a', 'rotated');
  r.advance(2_001);
  await r.tick();
  assert.ok(r.events.some((e) => e.type === 'credentialsChanged' && e.key === 'a'));
  assert.equal(await r.attempt('a'), 'ok', 'probed long before the 30-60 s cooldown');
  assert.equal(await r.attempt('b'), 'open', 'unchanged credentials keep waiting');
  await r.pools.closeAll();
});

test('governor: half-open probes are budgeted per cluster', async () => {
  const r = rig({ breaker: { storm: false, threshold: 1, probesPerSecond: 2 } });
  const keys = ['a', 'b', 'c', 'd', 'e'];
  for (const k of keys) r.accepted.set(k, 'x');
  for (const k of keys) await r.attempt(k);
  for (const k of keys) r.accepted.set(k, 'pw');
  r.advance(4_001);
  const results = [];
  for (const k of keys) results.push(await r.attempt(k));
  assert.deepEqual(results, ['ok', 'ok', 'open', 'open', 'open']);
  r.advance(1_000);
  assert.equal(await r.attempt('c'), 'ok');
  assert.equal(await r.attempt('d'), 'ok');
  assert.equal(await r.attempt('e'), 'open');
  await r.pools.closeAll();
});

test('governor: storms are per cluster', async () => {
  const r = rig({ hosts: (k) => (k === 'y' ? 'other:27017' : 'h1:27017') });
  for (const k of ['a', 'b', 'c', 'y']) r.accepted.set(k, 'unknown');
  assert.equal(await r.attempt('y'), 'auth');
  for (const k of ['a', 'b', 'c']) await r.attempt(k);
  assert.equal(r.of('stormStarted').length, 1);
  assert.ok(!r.pools.stats().openBreakers.includes('y'), 'a tenant on another cluster keeps its own threshold');
  await r.pools.closeAll();
});

test('governor: a storm ends after the quiet period', async () => {
  const r = rig({ breaker: { storm: { quietMs: 10_000 } } });
  for (const k of ['a', 'b', 'c']) r.accepted.set(k, 'unknown');
  for (const k of ['a', 'b', 'c']) await r.attempt(k);
  r.advance(9_999);
  await r.tick();
  assert.equal(r.of('stormEnded').length, 0);
  r.advance(1);
  await r.tick();
  assert.deepEqual(r.of('stormEnded').map((e) => (e as { reason: string }).reason), ['quiet']);
  assert.deepEqual(r.pools.stats().storms, []);
  await r.pools.closeAll();
});

test('governor: disabled, it is the plain per-tenant breaker exactly', async () => {
  const r = rig({ breaker: { storm: false, credentialPollMs: 0, probesPerSecond: Infinity } });
  for (const k of ['a', 'b', 'c', 'd']) r.accepted.set(k, 'unknown');
  for (let i = 0; i < 2; i++) for (const k of ['a', 'b', 'c', 'd']) assert.equal(await r.attempt(k), 'auth');
  assert.equal(r.of('breakerOpen').length, 0, 'every tenant pays the full threshold');
  for (const k of ['a', 'b', 'c', 'd']) await r.attempt(k);
  assert.equal(r.of('breakerOpen').length, 4);
  r.advance(4_001);
  for (const k of ['a', 'b', 'c', 'd']) assert.equal(await r.attempt(k), 'auth', 'each tenant probes on its own');
  assert.equal(r.of('stormStarted').length + r.of('canary').length, 0);
  await r.pools.closeAll();
});

test('governor: observe mode reports the storm and blocks nothing', async () => {
  const r = rig({ breaker: { mode: 'observe' } });
  for (const k of ['a', 'b', 'c']) r.accepted.set(k, 'unknown');
  for (const k of ['a', 'b', 'c']) await r.attempt(k);
  assert.equal(r.of('stormStarted').length, 1);
  assert.deepEqual(r.pools.stats().openBreakers, []);
  for (const k of ['a', 'b', 'c']) assert.equal(await r.attempt(k), 'auth', 'still attempting');
  await r.pools.closeAll();
});

test('governor: options are validated', () => {
  assert.throws(() => new TenantPools({ appName: 'x', resolve: () => ({ uri: 'mongodb://h' }), breaker: { storm: { minTenants: 1 } } }), /minTenants/);
  assert.throws(() => new TenantPools({ appName: 'x', resolve: () => ({ uri: 'mongodb://h' }), breaker: { probesPerSecond: 0 } }), /probesPerSecond/);
});
