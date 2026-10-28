import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { captureFiles, formatAnalysis, groupFindings, loadCaptures, observe, suggestIndex, type ObserveOptions, type PlanFinding } from '../src/index.ts';
import { URI } from './helpers.ts';

let client: MongoClient;
let db: Db;

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10 });
  await client.connect();
  db = client.db('krepis_plan');
  await db.dropDatabase();
  const docs = Array.from({ length: 50 }, (_, i) => ({ status: i % 2 ? 'paid' : 'open', n: i, tenant: 't1', userId: i % 5 }));
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await db.collection(name).insertMany(docs.map((d) => ({ ...d })));
  await db.collection('users').insertMany(Array.from({ length: 5 }, (_, i) => ({ _id: i as never, uid: i, name: `u${i}` })));
  await db.collection('b').createIndex({ status: 1 });
  await db.collection('c').createIndex({ status: 1 });
});

after(async () => {
  await client.close();
});

/** Runs fn in a unit of work of a fresh explaining observer and returns what its explains found. */
async function plans(fn: () => Promise<unknown>, options: ObserveOptions = {}) {
  const obs = observe(client, { explain: true, ...options });
  try {
    await obs.run('test', fn);
    await obs.settled();
    return { findings: obs.planFindings, stats: obs.explainStats, obs };
  } finally {
    obs.detach();
  }
}

const rules = (fs: PlanFinding[]) => fs.map((f) => f.rule).sort();

test('X1 an equality filter no index serves: KR-P001 with the index to add and the call site', async () => {
  const { findings } = await plans(() => db.collection('a').find({ status: 'paid' }).toArray());
  assert.deepEqual(rules(findings), ['KR-P001']);
  const f = findings[0]!;
  assert.equal(f.namespace, 'krepis_plan.a');
  assert.deepEqual(f.suggestedIndex, { status: 1 });
  assert.ok(f.plan.stages.includes('COLLSCAN'), f.plan.stages.join());
  assert.match(f.callSites[0] ?? '', /plan\.test\.ts:\d+/);
});

test('X2 the same filter with a supporting index: nothing', async () => {
  const { findings, stats } = await plans(() => db.collection('b').find({ status: 'paid' }).toArray());
  assert.deepEqual(findings, []);
  assert.equal(stats.explained, 1);
});

test('X3 an index serves the filter but not the sort: KR-P010 only, suggesting the filter then the sort', async () => {
  const { findings } = await plans(() => db.collection('c').find({ status: 'paid' }).sort({ n: -1 }).toArray());
  assert.deepEqual(rules(findings), ['KR-P010']);
  assert.deepEqual(Object.entries(findings[0]!.suggestedIndex), [['status', 1], ['n', -1]]);
});

test('X4 suggested indexes follow equality, sort, range', () => {
  const s = (cmd: Record<string, unknown>) => Object.entries(suggestIndex('find', { find: 'x', ...cmd }) ?? {});
  assert.deepEqual(s({ filter: { status: 'paid', n: { $gt: 3 }, tenant: 't1' }, sort: { at: -1 } }), [['status', 1], ['tenant', 1], ['at', -1], ['n', 1]]);
  assert.deepEqual(s({ filter: { tags: { $in: ['a'] }, name: /^ab/ } }), [['tags', 1], ['name', 1]]);
  assert.deepEqual(s({ filter: { $and: [{ a: 1 }, { b: { $lte: 2 } }] } }), [['a', 1], ['b', 1]]);
  assert.deepEqual(s({ filter: { name: /ab/ } }), [], 'an unanchored regex cannot use an index bound');
  assert.deepEqual(s({ filter: { $or: [{ a: 1 }, { b: 2 }] } }), [], 'a $or needs an index per branch, not one index');
  assert.deepEqual(s({ filter: { a: { $ne: 1 } } }), []);
  assert.deepEqual(Object.entries(suggestIndex('aggregate', { aggregate: 'x', pipeline: [{ $match: { a: 1 } }, { $sort: { b: 1 } }] }) ?? {}), [['a', 1], ['b', 1]]);
});

test('X5 $lookup: KR-P003 when the joined collection has no index on foreignField; none on _id', async () => {
  const { findings } = await plans(async () => {
    await db.collection('users').aggregate([{ $lookup: { from: 'd', localField: 'uid', foreignField: 'userId', as: 'orders' } }]).toArray();
    await db.collection('d').aggregate([{ $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } }]).toArray();
  });
  assert.deepEqual(rules(findings), ['KR-P003']);
  assert.deepEqual(findings[0]!.lookup, { from: 'd', foreignField: 'userId' });
  assert.deepEqual(findings[0]!.suggestedIndex, { userId: 1 });

  await db.collection('d').createIndex({ userId: 1, n: 1 });
  const again = await plans(() => db.collection('users').aggregate([{ $lookup: { from: 'd', localField: 'uid', foreignField: 'userId', as: 'orders' } }]).toArray());
  assert.deepEqual(again.findings, []);
});

test('X6 one explain per query shape, however often it runs; other values are the same shape', async () => {
  const { findings, stats } = await plans(async () => {
    for (let i = 0; i < 5; i++) await db.collection('e').findOne({ n: i });
  });
  assert.equal(stats.explained, 1);
  assert.equal(findings.length, 1);
});

test('X7 a scan with no filter (a bounded listing) is not a finding', async () => {
  const { findings, stats } = await plans(() => db.collection('a').find({}).limit(10).toArray());
  assert.equal(stats.explained, 1);
  assert.deepEqual(findings, []);
});

test('X8 explaining a write executes nothing, and explains are not counted as the app\'s commands', async () => {
  const before = await db.collection('f').countDocuments({ status: 'gone' });
  const obs = observe(client, { explain: true });
  const { queries } = await obs.measure('X8', () => db.collection('f').updateMany({ tenant: 't1' }, { $set: { status: 'gone' } }));
  await db.collection('f').updateMany({ status: 'gone' }, { $set: { status: 'open' } });
  await obs.settled();
  obs.detach();
  assert.equal(before, 0);
  assert.equal(queries.commands, 1);
  assert.deepEqual(rules(obs.planFindings), ['KR-P001']);
  assert.equal(await db.collection('f').countDocuments({ status: 'gone' }), 0);
});

test('X9 a query inside a transaction is explained outside it', async () => {
  const session = client.startSession();
  try {
    const { findings, stats } = await plans(() => session.withTransaction(async () => {
      await db.collection('g').findOne({ tenant: 't1', n: { $gte: 3 } }, { session });
    }));
    assert.equal(stats.failed, 0);
    assert.deepEqual(rules(findings), ['KR-P001']);
    assert.deepEqual(Object.entries(findings[0]!.suggestedIndex), [['tenant', 1], ['n', 1]]);
  } finally {
    await session.endSession();
  }
});

test('X10 off by default: no explains', async () => {
  const obs = observe(client);
  await obs.run('X10', () => db.collection('a').find({ status: 'paid' }).toArray());
  await obs.settled();
  obs.detach();
  assert.equal(obs.explainStats.explained, 0);
  assert.deepEqual(obs.planFindings, []);
});

test('X11 captured for krepis analyze, without values; --fail material', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krepis-plan-'));
  try {
    const obs = observe(client, { explain: true, capture: dir });
    await obs.run('GET /a', () => db.collection('a').find({ status: 'secret-value-123' }).toArray());
    await obs.settled();
    obs.detach();
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    assert.ok(!text.includes('secret-value-123'), 'a filter value reached the capture');
    const loaded = loadCaptures(captureFiles([dir]));
    assert.deepEqual(loaded.plans.map((p) => p.rule), ['KR-P001']);
    const report = formatAnalysis(loaded, groupFindings(loaded.findings));
    assert.match(report, /1 index finding/);
    assert.match(report, /KR-P001 collection scan {2}in GET \/a/);
    assert.match(report, /createIndex\(\{ status: 1 \}\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
