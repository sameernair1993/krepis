import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import {
  captureFiles, ciFindings, compareBaseline, formatMarkdown, formatSarif, loadCaptures, observe, readBaseline, writeBaseline,
  type CiFinding,
} from '../src/index.ts';
import { URI } from './helpers.ts';

let client: MongoClient;
const work = mkdtempSync(join(tmpdir(), 'krepis-ci-'));
const dirA = join(work, 'a');
const dirB = join(work, 'b');

async function seed(db: Db) {
  await db.dropDatabase();
  await db.collection('orders').insertMany(Array.from({ length: 10 }, (_, i) => ({ status: 'paid', userId: i })));
  await db.collection('users').insertMany(Array.from({ length: 10 }, (_, i) => ({ _id: i as never, name: `u${i}` })));
}

/** An N+1 (users per order) whose parent query also scans the collection (orders has no index on status). */
async function workload(db: Db) {
  const orders = await db.collection('orders').find({ status: 'paid' }).toArray();
  for (const o of orders) await db.collection('users').findOne({ _id: o.userId });
}

async function captureRun(dbName: string, dir: string) {
  const db = client.db(dbName);
  await seed(db);
  const obs = observe(client, { explain: true, capture: dir });
  try {
    await obs.run('GET /orders', () => workload(db));
    await obs.settled();
  } finally {
    obs.detach();
  }
  return ciFindings(loadCaptures(captureFiles([dir])));
}

let a: CiFinding[];
let b: CiFinding[];

before(async () => {
  client = new MongoClient(URI, { maxPoolSize: 10 });
  await client.connect();
  // Two runs in differently named databases, as parallel test workers often use.
  a = await captureRun('krepis_ci_a', dirA);
  b = await captureRun('krepis_ci_b', dirB);
});

after(async () => {
  await client.close();
  rmSync(work, { recursive: true, force: true });
});

const keys = (fs: CiFinding[]) => fs.map((f) => f.key).sort();

test('C1 one CI finding per pattern, keyed the same across database names', () => {
  assert.deepEqual(a.map((f) => f.rule).sort(), ['KR-P001', 'KR-P002']);
  assert.deepEqual(keys(a), keys(b));
  for (const f of a) {
    assert.match(f.callSite ?? '', /^test\/ci\.test\.ts:\d+/);
    assert.ok(!f.title.includes('krepis_ci_a'), f.title);
  }
});

test('C2 baseline round trip: known, new and no longer seen', () => {
  const path = join(work, 'baseline.json');
  writeBaseline(path, a);
  const text = readFileSync(path, 'utf8');
  assert.ok(!text.includes('krepis_ci_a') && !text.includes('GET /orders'), 'database or context name in the baseline');
  const baseline = readBaseline(path);
  assert.equal(baseline.findings.length, 2);

  const same = compareBaseline(b, baseline);
  assert.deepEqual(same.findings.map((f) => f.state), ['known', 'known']);
  assert.deepEqual(same.fixed, []);

  const p002 = a.find((f) => f.rule === 'KR-P002')!;
  const partial = compareBaseline(b, { ...baseline, findings: baseline.findings.filter((e) => e.key !== p002.key) });
  assert.deepEqual(partial.findings.filter((f) => f.state === 'new').map((f) => f.rule), ['KR-P002']);

  const stale = { key: 'gone', rule: 'KR-P001', title: 'collection scan: find old {}' };
  assert.deepEqual(compareBaseline(b, { ...baseline, findings: [...baseline.findings, stale] }).fixed, [stale]);

  writeFileSync(path, '{"something":"else"}');
  assert.throws(() => readBaseline(path), /not a krepis baseline/);
});

test('C3 markdown: new findings in a table with the full report collapsed, known ones counted', () => {
  const p001 = a.find((f) => f.rule === 'KR-P001')!;
  const { findings } = compareBaseline(a, { krepis_baseline: 1, findings: [{ key: p001.key, rule: p001.rule, title: p001.title }] });
  const md = formatMarkdown(findings);
  assert.match(md, /\*\*1 new finding\*\*/);
  assert.match(md, /\| KR-P002 \| N\+1: 10 × users/);
  assert.match(md, /<details><summary>KR-P002/);
  assert.match(md, /1 known finding in the baseline/);
  assert.match(formatMarkdown([]), /No findings\./);
});

test('C4 SARIF: rules with descriptions, a repository-relative location, baseline state', () => {
  const sarif = JSON.parse(formatSarif(compareBaseline(a, { krepis_baseline: 1, findings: [] }).findings, { version: '9.9.9' }));
  assert.equal(sarif.version, '2.1.0');
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.version, '9.9.9');
  assert.deepEqual(run.tool.driver.rules.map((r: { id: string }) => r.id), ['KR-P001', 'KR-P002']);
  for (const r of run.tool.driver.rules) assert.ok(r.shortDescription.text && r.fullDescription.text && r.help.text);
  assert.equal(run.results.length, 2);
  for (const r of run.results) {
    assert.equal(r.baselineState, 'new');
    assert.match(r.locations[0].physicalLocation.artifactLocation.uri, /^test\/ci\.test\.ts$/);
    assert.ok(r.locations[0].physicalLocation.region.startLine > 0);
    assert.ok(r.partialFingerprints.krepisKey);
  }
  // An absolute call site (a file outside the app's working directory) is made relative to the root, if inside it.
  const absolute = a.map((f) => ({ ...f, callSite: join(work, 'src', 'repo.ts') + ':7' }));
  const inside = JSON.parse(formatSarif(absolute, { root: work }));
  assert.ok(inside.runs[0].results.every((r: { locations: [{ physicalLocation: { artifactLocation: { uri: string } } }] }) =>
    r.locations[0].physicalLocation.artifactLocation.uri === 'src/repo.ts'));
  const outside = JSON.parse(formatSarif(absolute, { root: join(work, 'elsewhere') }));
  assert.ok(outside.runs[0].results.every((r: { locations?: unknown }) => r.locations === undefined));
});

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--conditions=krepis-source', 'src/cli.ts', 'analyze', ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('C5 krepis analyze --baseline/--update-baseline/--format/--output exit codes', () => {
  const baseline = join(work, 'cli-baseline.json');
  const written = cli(dirA, '--update-baseline', '--baseline', baseline);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /Wrote 2 findings/);

  const passing = cli(dirB, '--baseline', baseline, '--fail');
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /0 new, 2 known, 0 no longer seen/);

  writeFileSync(baseline, JSON.stringify({ krepis_baseline: 1, findings: [] }));
  const failing = cli(dirB, '--baseline', baseline, '--fail');
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /2 new, 0 known/);

  const out = join(work, 'report.sarif');
  assert.equal(cli(dirA, '--format', 'sarif', '--output', out).status, 0);
  assert.ok(existsSync(out));
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).runs[0].results.length, 2);

  const json = JSON.parse(cli(dirB, '--json', '--baseline', baseline).stdout);
  assert.equal(json.baseline.new.length, 2);

  assert.equal(cli(dirA, '--format', 'xml').status, 2);
  assert.equal(cli(dirA, '--baseline', join(work, 'missing.json')).status, 2);
});
