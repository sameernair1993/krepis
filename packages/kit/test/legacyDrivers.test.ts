import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MongoClient as CurrentClient } from 'mongodb';
import { observe } from '../src/index.ts';
import { contextStorage } from '../src/context.ts';
import { URI, seed } from './helpers.ts';

// Real applications attach older drivers than the peer range names: Mongoose 6 bundles mongodb 4.17, and mongodb up
// to 6.0 still used a callback-style `Connection.command`. The gate once assumed a promise there and crashed the host
// with an uncaught TypeError on the first command inside a context. These run the same checks on each real driver.
const require = createRequire(import.meta.url);
const DRIVERS = ['mongodb-v4', 'mongodb-v5', 'mongodb-v6', 'mongodb'] as const;
const DB = 'krepis_legacy';

interface LegacyEvent { commandName: string }
// Typed loosely: each driver copy has its own (incompatible) declarations, and only the public API common to all is used.
interface LegacyClient {
  db(name: string): { collection(n: string): any; command(c: object): Promise<unknown> };
  on(event: 'commandStarted', fn: (e: LegacyEvent) => void): void;
  connect(): Promise<unknown>;
  close(): Promise<void>;
}

/** Process-wide: Krepis warns once per process, not once per client. */
const warnings: string[] = [];
const onWarning = (w: Error & { code?: string }) => warnings.push(w.code ?? w.message);

before(async () => {
  process.on('warning', onWarning);
  const c = new CurrentClient(URI);
  await c.connect();
  await seed(c.db(DB));
  await c.close();
});

after(() => {
  process.off('warning', onWarning);
});

for (const pkg of DRIVERS) {
  const { version } = require(`${pkg}/package.json`) as { version: string };
  describe(`${pkg} (${version})`, () => {
    let client: LegacyClient;
    let obs: ReturnType<typeof observe>;
    const started: string[] = [];
    let ownWarnings: string[] = [];

    before(async () => {
      const w0 = warnings.length;
      const { MongoClient } = require(pkg) as { MongoClient: new (uri: string, o: object) => LegacyClient };
      client = new MongoClient(URI, { maxPoolSize: 1 });
      obs = observe(client as never, { optimize: 'safe' });
      client.on('commandStarted', (e) => started.push(e.commandName));
      await client.connect();
      ownWarnings = warnings.slice(w0);
    });

    after(async () => {
      obs.detach();
      await client.close();
    });

    const users = () => client.db(DB).collection('users');
    const orders = () => client.db(DB).collection('orders');
    const outside = <T>(fn: () => Promise<T>) => contextStorage.exit(fn);

    test('attaches with context-gated monitoring (no fallback warning)', () => {
      assert.ok(!ownWarnings.includes('KREPIS_NO_OPTIMIZE'), `warnings: ${ownWarnings.join(', ')}`);
    });

    test('a loop of lookups inside a context is observed and reported, with correct results', async () => {
      const before = obs.findings.length;
      const names = await obs.run('legacy loop', async () => {
        const list = await orders().find({ status: 'paid' }).sort({ n: 1 }).limit(10).toArray();
        const out: string[] = [];
        for (const o of list) out.push((await users().findOne({ _id: o.userId }))!.name);
        return out;
      });
      assert.equal(names.length, 10);
      assert.ok(names.every((n) => /^user\d$/.test(n)));
      const rules = obs.findings.slice(before).map((f) => f.rule);
      assert.ok(rules.includes('KR-P002'), `rules: ${rules.join(', ')}`);
    });

    test('monitoring is switched back off: commands outside a context are not monitored', async () => {
      await obs.run('legacy one', () => users().findOne({ name: 'user1' }));
      const n = started.length;
      if (pkg === 'mongodb') assert.equal(n, 0, 'promise-style driver: recorded from the reply, no events');
      else assert.ok(n > 0, 'the in-context command was monitored');
      await outside(() => users().findOne({ name: 'user2' }));
      await outside(() => orders().countDocuments({}));
      assert.equal(started.length, n);
    });

    test('a failing command inside a context rejects normally and still switches monitoring off', async () => {
      await assert.rejects(obs.run('legacy err', () => client.db(DB).command({ krepisNoSuchCommand: 1 })), /no such command/i);
      const n = started.length;
      await outside(() => users().findOne({ name: 'user3' }));
      assert.equal(started.length, n);
    });

    test('optimize leaves results correct; callback drivers pass through and say so once', async () => {
      const q = () => orders().find({ status: 'open' }).sort({ n: 1 }).toArray();
      const before = started.length;
      const deduped = obs.optimizeStats.deduped;
      const [a, b] = await obs.run('legacy dedupe', async () => [await q(), await q()] as const);
      assert.deepEqual(a.map((d: { n: number }) => d.n), b.map((d: { n: number }) => d.n));
      const reads = started.slice(before).filter((c) => c === 'find').length;
      if (pkg === 'mongodb') {
        assert.equal(obs.optimizeStats.deduped - deduped, 1, 'promise-style driver: the repeat read is deduplicated');
      } else {
        assert.equal(reads, 2, 'callback-style driver: no optimisation');
        assert.ok(warnings.includes('KREPIS_OPTIMIZE_CALLBACK_DRIVER'), `warnings: ${warnings.join(', ')}`);
      }
    });
  });
}
