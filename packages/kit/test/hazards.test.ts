import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { captureFiles, ciFindings, formatAnalysis, formatFinding, groupFindings, loadCaptures, observe, type HazardFinding, type ObserveOptions } from '../src/index.ts';
import { URI } from './helpers.ts';

let client: MongoClient;
let db: Db;

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10 });
  await client.connect();
  db = client.db('krepis_hazards');
  await db.dropDatabase();
  await db.collection('users').insertMany(Array.from({ length: 20 }, (_, i) => ({
    email: `u${i}@example.com`, name: `user ${i}`, passwordHash: 'x', profile: { apiKey: 'k', city: 'c' },
  })));
});

after(async () => {
  await client.close();
});

/** Hazard findings of one unit of work; KR-S004 (every users read returns passwordHash) only when asked for. */
async function hazards(fn: () => Promise<unknown>, options: ObserveOptions = { hazards: true }, withS004 = false): Promise<HazardFinding[]> {
  const obs = observe(client, options);
  try {
    await obs.run('test', fn);
    return obs.hazardFindings.filter((f) => withS004 || f.rule !== 'KR-S004');
  } finally {
    obs.detach();
  }
}

const rules = (fs: HazardFinding[]) => fs.map((f) => f.rule).sort();
// The call site of these lookups is this line, whichever test calls it.
const byEmail = async (email: unknown) => await db.collection('users').findOne({ email });

test('H1 KR-S001: one call site sends a field as a value and as an operator object', async () => {
  const found = await hazards(async () => {
    await byEmail('u1@example.com');
    await byEmail({ $ne: null });
  });
  assert.deepEqual(rules(found), ['KR-S001']);
  const f = found[0]!;
  assert.deepEqual(f.fields, ['email']);
  assert.deepEqual(f.operators, ['$ne']);
  assert.match(f.callSites[0] ?? '', /^test\/hazards\.test\.ts:\d+$/);
  assert.match(f.shape, /\$ne/);
});

test('H2 KR-S001 not raised for $eq, or for operators from a call site that never sends a value', async () => {
  const found = await hazards(async () => {
    await byEmail('u1@example.com');
    await byEmail({ $eq: 'u2@example.com' });
    await db.collection('users').findOne({ email: { $in: ['u1@example.com'] } });
  });
  assert.deepEqual(found, []);
});

test('H2b KR-S001 not raised when one call site dispatches different queries (a generic helper)', async () => {
  // Returns the promise unawaited, so every query's call site is the awaiting line below.
  const run = (q: () => Promise<unknown>) => q();
  const users = db.collection('users');
  const found = await hazards(async () => {
    for (const q of [
      () => users.findOne({ email: 'u1@example.com' }),
      () => users.find({ email: { $in: ['u1@example.com', 'u2@example.com'] } }).toArray(),
      () => users.find({ email: 'u3@example.com', name: 'user 3' }).toArray(),
      () => users.find({ email: { $exists: true } }).sort({ name: 1 }).limit(5).toArray(),
    ]) await run(q);
  });
  assert.deepEqual(found, []);
  const injected = await hazards(async () => {
    for (const email of ['u1@example.com', { $ne: null }]) await run(() => users.findOne({ email }));
  });
  assert.deepEqual(rules(injected), ['KR-S001'], 'the same query through the same helper is still flagged');
});

test('H2c KR-S001 from request input: one request is enough, from any line; operators the code builds are not', async () => {
  const users = db.collection('users');
  // Returned unawaited, so the call site is the caller's line, which differs per request below.
  const reset = (b: Record<string, unknown>) => users.findOne({ email: b.email });
  const obs = observe(client);
  try {
    const body = JSON.parse('{"email":{"$ne":null}}');
    await obs.run('POST /reset', async () => {
      obs.input('body', body);
      await reset(body);
    });
    const query = { age: { $gt: '5' } }; // a parsed query string; the app casts the value
    await obs.run('GET /users', async () => {
      obs.input('query', query);
      await users.find({ age: { $gt: 5 } }).limit(1).toArray();
    });
    const found = obs.hazardFindings.filter((f) => f.rule === 'KR-S001');
    assert.deepEqual(found.map((f) => [f.context, f.fields[0], f.operators.join(), f.input]), [
      ['POST /reset', 'email', '$ne', 'body'],
      ['GET /users', 'age', '$gt', 'query'],
    ]);
    assert.match(formatFinding(found[0]!), /received an operator object \(\$ne\) that the client sent in the request's body/);

    const before = obs.hazardFindings.length;
    await obs.run('POST /batch', async () => {
      const input = { ids: ['u1@example.com', 'u2@example.com'], email: { $ne: null }, filter: { $set: { admin: true } } };
      obs.input('body', input);
      await users.find({ email: { $in: input.ids } }).toArray(); // an operator the code built from values
      await users.findOne({ email: { $eq: input.email } }); // sanitised: the object is compared as a value
      await users.findOne({ name: { $exists: true } }); // an operator the client did not send
    });
    assert.deepEqual(obs.hazardFindings.slice(before).filter((f) => f.rule === 'KR-S001'), []);
  } finally {
    obs.detach();
  }
});

test('H3 KR-S002: $where and $function, once per shape', async () => {
  const found = await hazards(async () => {
    for (let i = 0; i < 3; i++) await db.collection('users').find({ $where: 'this.name.length > 0' }).toArray().catch(() => []);
    await db.collection('users').aggregate([
      { $match: { $expr: { $function: { body: 'function (n) { return n.length > 0 }', args: ['$name'], lang: 'js' } } } },
    ]).toArray().catch(() => []);
  });
  assert.deepEqual(rules(found), ['KR-S002', 'KR-S002']);
  assert.deepEqual(found.map((f) => f.operators[0]).sort(), ['$function', '$where']);
});

test('H4 KR-S003: an unanchored pattern on a field; an anchored one is fine', async () => {
  const found = await hazards(async () => {
    await db.collection('users').find({ name: /^user/ }).toArray();
    await db.collection('users').find({ email: { $regex: 'example' } }).toArray();
  });
  assert.deepEqual(rules(found), ['KR-S003']);
  assert.deepEqual(found[0]!.fields, ['email']);
  assert.equal(found[0]!.severity, 'info');
});

test('H5 KR-S004: sensitive fields named by path, not by value; a projection removes them', async () => {
  const found = await hazards(async () => {
    await db.collection('users').find({ name: 'user 1' }).toArray();
    await db.collection('users').find({ name: 'user 2' }, { projection: { passwordHash: 0, profile: 0 } }).toArray();
  }, { hazards: true }, true);
  assert.deepEqual(rules(found), ['KR-S004']);
  assert.deepEqual(found[0]!.fields, ['passwordHash', 'profile.apiKey']);
});

test('H6 KR-P006: a find without a limit over the threshold; a limit, or a small result, is fine', async () => {
  const found = await hazards(async () => {
    await db.collection('users').find({}, { batchSize: 5 }).toArray();
    await db.collection('users').find({ name: { $exists: true } }).limit(100).toArray();
    await db.collection('users').find({ email: /^u2/ }).toArray();
  }, { hazards: { unboundedReadThreshold: 10 } });
  assert.deepEqual(rules(found), ['KR-P006']);
  assert.equal(found[0]!.returned, 20, 'getMore batches are counted');
});

test('H7 KR-S001 and KR-S002 are on by default, the rest opt-in; false or KREPIS_HAZARDS=0 turns all off', async () => {
  const mixed = async () => {
    await byEmail('u1@example.com');
    await byEmail({ $ne: null });
    await db.collection('users').find({ $where: 'true' }).toArray().catch(() => []);
    await db.collection('users').find({ name: /user/ }).toArray();
    await db.collection('users').find({}).toArray();
  };
  assert.deepEqual(rules(await hazards(mixed, {}, true)), ['KR-S001', 'KR-S002']);
  assert.deepEqual([...new Set(rules(await hazards(mixed, { hazards: { unboundedReadThreshold: 10 } })))], ['KR-P006', 'KR-S001', 'KR-S002', 'KR-S003']);
  assert.deepEqual(await hazards(mixed, { hazards: false }, true), []);
  process.env.KREPIS_HAZARDS = '0';
  try {
    assert.deepEqual(await hazards(mixed, {}, true), []);
  } finally {
    delete process.env.KREPIS_HAZARDS;
  }
  process.env.KREPIS_HAZARDS = '1';
  try {
    assert.deepEqual(rules(await hazards(mixed, {})), ['KR-S001', 'KR-S002', 'KR-S003']);
  } finally {
    delete process.env.KREPIS_HAZARDS;
  }
});

test('H8 captured without values; S001, S002 and P006 fail CI, S003 and S004 are info', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krepis-hazards-'));
  try {
    const obs = observe(client, { capture: dir, hazards: { unboundedReadThreshold: 10 } });
    await obs.run('POST /login', async () => {
      await byEmail('secret-address@example.com');
      await byEmail({ $gt: '' });
      await db.collection('users').find({ $where: 'this.email == "secret-where"' }).toArray().catch(() => []);
      await db.collection('users').find({ name: /secret-pattern/ }).toArray();
      await db.collection('users').find({}).toArray();
    });
    obs.detach();
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    for (const value of ['secret-address', 'secret-where', 'secret-pattern']) assert.ok(!text.includes(value), `${value} reached the capture`);
    const loaded = loadCaptures(captureFiles([dir]));
    assert.deepEqual([...new Set(loaded.hazards.map((h) => h.rule))].sort(), ['KR-P006', 'KR-S001', 'KR-S002', 'KR-S003', 'KR-S004']);
    assert.deepEqual(ciFindings(loaded).map((f) => f.rule).sort(), ['KR-P006', 'KR-S001', 'KR-S002']);
    const report = formatAnalysis(loaded, groupFindings(loaded.findings));
    assert.match(report, /hazard\(s\): 3 injection, server-side JavaScript or unbounded read; \d+ info/);
    assert.match(report, /KR-S001 operator injection signal {2}in POST \/login/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
