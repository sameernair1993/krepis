import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MongoClient, type Db } from 'mongodb';
import { observe, type ObserveOptions } from '../src/index.ts';
import { URI, seed, type Seed } from './helpers.ts';

const DB = 'krepis_cap';
const PKG = new URL('..', import.meta.url).pathname;
let client: MongoClient;
let db: Db;
let data: Seed;
const tmp = mkdtempSync(join(tmpdir(), 'krepis-cap-'));

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(DB);
  data = await seed(db);
});

after(async () => {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
});

let dirs = 0;
const freshDir = () => join(tmp, `d${dirs++}`);

async function nPlusOne(label: string, opts: ObserveOptions) {
  const obs = observe(client, opts);
  try {
    await obs.run(label, async () => {
      const list = await db.collection('orders').find({ status: 'paid' }).limit(10).toArray();
      for (const o of list) await db.collection('users').findOne({ _id: o.userId });
    });
    obs.flush();
    return obs;
  } finally {
    obs.detach();
  }
}

const files = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort().map((f) => join(dir, f));
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const cli = (...args: string[]) => spawnSync(process.execPath, [join(PKG, 'src/cli.ts'), ...args], { encoding: 'utf8', cwd: tmp });

test('C1 one N+1 unit of work: a header, one shape line per fingerprint, one ctx line, one finding', async () => {
  const dir = freshDir();
  const obs = await nPlusOne('C1', { capture: dir });
  assert.equal(obs.findings.length, 1);
  const f = files(dir);
  assert.equal(f.length, 1);
  const ls = lines(f[0]!);
  assert.equal(ls[0]!.krepis_capture, 1);
  const shapes = ls.filter((l) => l.t === 'shape');
  assert.equal(shapes.length, 2, JSON.stringify(shapes));
  assert.deepEqual(new Set(shapes.map((s) => s.ns)), new Set([`${DB}.orders`, `${DB}.users`]));
  const ctx = ls.filter((l) => l.t === 'ctx');
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0]!.label, 'C1');
  const counts = (ctx[0]!.cmds as unknown[][]).map((r) => r[1]).sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(counts, [1, 10]);
  assert.equal(ls.filter((l) => l.t === 'finding').length, 1);
  assert.equal(ls.length, 5);
  assert.deepEqual({ ...obs.captureStats, bytes: 0 }, { contexts: 1, lines: 5, bytes: 0, segments: 1, dropped: 0, errors: 0 });
});

test('C2 privacy: no seeded value reaches a capture', async () => {
  const dir = freshDir();
  await nPlusOne('C2', { capture: dir });
  const text = readFileSync(files(dir)[0]!, 'utf8');
  const values = [
    ...data.users.flatMap((u) => [u.name, u._id.toHexString()]),
    ...data.orders.map((o) => o._id.toHexString()),
    'paid',
  ];
  for (const v of values) assert.ok(!text.includes(v), `capture contains the value ${v}`);
});

test('C3 rotation: each segment starts with a header and carries the shapes it references', async () => {
  const dir = freshDir();
  const obs = observe(client, { capture: { dir, segmentBytes: 1 } });
  for (let i = 0; i < 3; i++) {
    await obs.run(`C3-${i}`, async () => {
      const list = await db.collection('orders').find({ status: 'paid' }).limit(3).toArray();
      for (const o of list) await db.collection('users').findOne({ _id: o.userId });
    });
  }
  obs.detach();
  const f = files(dir);
  assert.equal(f.length, 3);
  for (const file of f) {
    const ls = lines(file);
    assert.equal(ls[0]!.krepis_capture, 1);
    const shapes = new Set(ls.filter((l) => l.t === 'shape').map((l) => l.fp));
    for (const l of ls.filter((x) => x.t === 'ctx')) for (const row of l.cmds as unknown[][]) assert.ok(shapes.has(row[0]), `${file} lacks shape ${String(row[0])}`);
  }
  assert.equal(obs.captureStats.segments, 3);
});

test('C3b retention: expired capture files are pruned when a segment opens; others are left alone', async () => {
  const dir = freshDir();
  await nPlusOne('seed-dir', { capture: dir });
  const old = join(dir, 'krepis-old-1-0.ndjson');
  const unrelated = join(dir, 'notes.ndjson');
  writeFileSync(old, '{}\n');
  writeFileSync(unrelated, '{}\n');
  const past = new Date(Date.now() - 8 * 86_400_000);
  utimesSync(old, past, past);
  utimesSync(unrelated, past, past);
  await nPlusOne('C3b', { capture: dir });
  const names = readdirSync(dir);
  assert.ok(!names.includes('krepis-old-1-0.ndjson'), 'expired capture kept');
  assert.ok(names.includes('notes.ndjson'), 'a file krepis did not write was deleted');
});

test('C4 bounded buffer: overflow drops units of work, counts them, and never touches the app', async () => {
  const dir = freshDir();
  const obs = observe(client, { capture: { dir, maxBufferBytes: 10 } });
  const n = await obs.run('C4', async () => db.collection('users').countDocuments({}));
  obs.detach();
  assert.equal(n, 10);
  assert.equal(obs.captureStats.dropped, 1);
  assert.equal(obs.captureStats.contexts, 0);
  assert.equal(obs.internalErrors, 0);
});

test('C5 unwritable capture path: writes fail, are counted, and the app is unaffected', async () => {
  const blocker = join(tmp, 'a-file');
  writeFileSync(blocker, 'x');
  const obs = await nPlusOne('C5', { capture: join(blocker, 'sub') });
  assert.equal(obs.findings.length, 1);
  assert.ok(obs.captureStats.errors > 0, JSON.stringify(obs.captureStats));
  assert.equal(obs.internalErrors, 0);
});

test('C6 analyze groups one pattern across units of work and counts labels', async () => {
  const dir = freshDir();
  for (const label of ['A', 'A', 'B']) await nPlusOne(label, { capture: dir });
  const r = cli('analyze', dir, '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { summary: { contexts: number; patterns: number }; groups: Array<{ occurrences: number; labels: Record<string, number> }> };
  assert.equal(out.summary.contexts, 3);
  assert.equal(out.summary.patterns, 1);
  assert.equal(out.groups[0]!.occurrences, 3);
  assert.deepEqual(out.groups[0]!.labels, { A: 2, B: 1 });
  const text = cli('analyze', dir);
  assert.match(text.stdout, /seen in 3 unit\(s\) of work, 10 queries each: A \(2\), B \(1\)/);
  assert.match(text.stdout, /KR-P002 N\+1 query/);
});

test('C7 --fail: exit 1 with a pattern, 0 without', async () => {
  const withN1 = freshDir();
  await nPlusOne('C7', { capture: withN1 });
  assert.equal(cli('analyze', withN1, '--fail').status, 1);
  const clean = freshDir();
  const obs = observe(client, { capture: clean });
  await obs.run('C7-clean', async () => db.collection('users').find({}).toArray());
  obs.detach();
  const r = cli('analyze', clean, '--fail');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No N\+1 patterns found/);
});

test('C13 repeated lookups: their own section, counted apart, and never fail --fail', async () => {
  const dir = freshDir();
  const obs = observe(client, { capture: dir });
  await obs.run('C13', async () => {
    for (let i = 0; i < 4; i++) await db.collection('users').findOne({ _id: data.users[0]!._id });
  });
  obs.detach();
  const r = cli('analyze', dir, '--fail');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No N\+1 patterns found\./);
  assert.match(r.stdout, /1 repeated-lookup pattern\(s\) \(info, not N\+1\)/);
  assert.match(r.stdout, /\[R1\] seen in 1 unit\(s\) of work, 4 queries each: C13 \(1\)\nKR-P012 repeated lookup/);
  const json = JSON.parse(cli('analyze', dir, '--json').stdout) as { summary: { patterns: number; repeatedLookups: number } };
  assert.deepEqual([json.summary.patterns, json.summary.repeatedLookups], [0, 1]);
});

test('C14 captures written by earlier versions: KR-P002 without a data link is read as KR-P012', async () => {
  const dir = freshDir();
  const obs = observe(client, { capture: dir });
  await obs.run('C14', async () => {
    for (let i = 0; i < 4; i++) await db.collection('users').findOne({ _id: data.users[0]!._id });
  });
  obs.detach();
  const file = files(dir)[0]!;
  const legacy = readFileSync(file, 'utf8').split('\n').map((l) => {
    if (!l.includes('"t":"finding"')) return l;
    const f = JSON.parse(l) as Record<string, unknown>;
    return JSON.stringify({ ...f, rule: 'KR-P002', severity: 'warn', confidence: 'pattern', parent: undefined });
  }).join('\n');
  writeFileSync(file, legacy);
  const r = cli('analyze', dir, '--json', '--fail');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const json = JSON.parse(r.stdout) as { summary: { patterns: number; repeatedLookups: number }; groups: Array<{ rule: string }> };
  assert.deepEqual([json.summary.patterns, json.summary.repeatedLookups, json.groups[0]!.rule], [0, 1, 'KR-P012']);
});

test('C8 a process that exits without flush or detach still writes its capture', async () => {
  const dir = freshDir();
  const index = pathToFileURL(join(PKG, 'src/index.ts')).href;
  const code = `
    import { MongoClient } from 'mongodb';
    import { observe } from ${JSON.stringify(index)};
    const client = new MongoClient(${JSON.stringify(URI)});
    const obs = observe(client, { capture: ${JSON.stringify(dir)} });
    await client.connect();
    const db = client.db(${JSON.stringify(DB)});
    await obs.run('C8', async () => {
      const list = await db.collection('orders').find({ status: 'paid' }).limit(5).toArray();
      for (const o of list) await db.collection('users').findOne({ _id: o.userId });
    });
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: PKG });
  assert.equal(r.status, 0, r.stderr);
  const f = files(dir);
  assert.equal(f.length, 1);
  assert.equal(lines(f[0]!).filter((l) => l.t === 'finding').length, 1);
});

test('C11 KREPIS_CAPTURE turns capture on without options; an explicit false wins', async () => {
  const dir = freshDir();
  process.env.KREPIS_CAPTURE = dir;
  try {
    const on = observe(client, {});
    assert.equal(on.captureDir, dir);
    on.detach();
    const off = observe(client, { capture: false });
    assert.equal(off.captureDir, undefined);
    off.detach();
  } finally {
    delete process.env.KREPIS_CAPTURE;
  }
});

test('C12 analyze tolerates a torn last line and reports files that are not captures', async () => {
  const dir = freshDir();
  await nPlusOne('C10', { capture: dir });
  const f = files(dir)[0]!;
  writeFileSync(f, readFileSync(f, 'utf8') + '{"t":"ctx","lab');
  writeFileSync(join(dir, 'krepis-bogus-1-0.ndjson'), 'hello\n');
  const out = JSON.parse(cli('analyze', dir, '--json').stdout) as { summary: { malformed: number; patterns: number; skipped: unknown[] } };
  assert.equal(out.summary.malformed, 1);
  assert.equal(out.summary.patterns, 1);
  assert.equal(out.summary.skipped.length, 1);
});

test('C15 --help after any command prints the usage and does nothing else', () => {
  for (const args of [['analyze', '--help'], ['init', '-h'], ['drill', '--help']]) {
    const r = cli(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage:/m, args.join(' '));
  }
  assert.deepEqual(readdirSync(tmp).filter((f) => f === '.krepis'), [], 'init --help created nothing');
  assert.equal(cli('analyze', '--bogus').status, 2, 'unknown options still fail');
});
