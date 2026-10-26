// Checks the *built* package, so it runs from `npm run check:dist` (which builds first), not
// from `npm test`. Imports go through the package's own name, so they resolve via the exports map
// exactly as a consumer's would. No `krepis-source` condition is passed, so they reach dist, not src.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const ENTRIES = { '@sameernair/krepis': '', '@sameernair/krepis/connections': 'connections', '@sameernair/krepis/compat': 'compat' } as const;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

for (const [spec, sub] of Object.entries(ENTRIES)) {
  test(`${spec}: import and require return the same objects`, async () => {
    const cjs = require(spec);
    const esm = await import(spec);
    const names = Object.keys(cjs).sort();
    assert.ok(names.length > 0);
    for (const name of names) assert.equal(esm[name], cjs[name], `${spec}.${name} differs between import and require`);
  });

  test(`${spec}: the ESM entry exports exactly the CommonJS names`, async () => {
    const cjs = require(spec);
    const esm = await import(spec);
    assert.deepEqual(Object.keys(esm).filter((k) => k !== 'default').sort(), Object.keys(cjs).sort());
  });

  test(`${spec}: resolves to dist, not to the source condition`, () => {
    assert.ok(require.resolve(spec).startsWith(join(DIST, 'cjs', sub)), require.resolve(spec));
  });
}

test('the connections ESM directory holds only the wrapper', () => {
  assert.deepEqual(readdirSync(join(DIST, 'connections')).sort(), ['index.d.ts', 'index.js']);
});

test('the compat ESM directory holds only the wrapper', () => {
  assert.deepEqual(readdirSync(join(DIST, 'compat')).sort(), ['index.d.ts', 'index.js']);
});

test('the root is the data layer: it exposes createDal and no connections names', () => {
  const root = require('@sameernair/krepis');
  assert.equal(typeof root.createDal, 'function');
  for (const name of Object.keys(require('@sameernair/krepis/connections'))) assert.ok(!(name in root), `root exports ${name}`);
});

test('importing the root loads no connections module', () => {
  // A fresh process, because this one has already loaded krepis/connections above.
  const loaded = execFileSync(
    process.execPath,
    ['-e', `require('@sameernair/krepis'); console.log(JSON.stringify(Object.keys(require.cache)))`],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  const files: string[] = JSON.parse(loaded);
  assert.ok(files.some((f) => f.includes(join('dist', 'cjs', 'dal'))), 'dal not loaded');
  assert.deepEqual(files.filter((f) => f.includes(join('dist', 'cjs', 'connections'))), []);
  assert.deepEqual(files.filter((f) => f.includes(join('dist', 'cjs', 'compat'))), []);
});

test('no analyser, cli or drill code ships in this package', () => {
  const rel = walk(DIST).map((f) => f.slice(DIST.length));
  assert.deepEqual(rel.filter((f) => /(^|\/)(drill|rules)\/|cli\.|collector\.|analyze\./.test(f)), []);
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).bin, undefined);
});

test('a runtime error thrown by one entry point is instanceof the class from the other', async () => {
  const cjs = require('@sameernair/krepis');
  const esm = await import('@sameernair/krepis');
  const err = new cjs.KrepisValidationError([{ path: 'x', message: 'required' }]);
  assert.ok(err instanceof esm.KrepisValidationError);
});

test('emitted JavaScript carries no doc comments; declarations keep them', () => {
  const files = walk(DIST);
  const withDoc = files.filter((f) => f.endsWith('.js') && readFileSync(f, 'utf8').includes('/**'));
  assert.deepEqual(withDoc, []);
  const dts = files.filter((f) => f.endsWith('.d.ts'));
  assert.ok(dts.filter((f) => readFileSync(f, 'utf8').includes('/**')).length >= 10, 'JSDoc missing from declarations');
});

test('dist stays inside its size budget', () => {
  const bytes = walk(DIST).reduce((n, f) => n + statSync(f).size, 0);
  // The build measured ~221 KB once the analyser moved out. The budget allows growth, not a second copy.
  assert.ok(bytes <= 300_000, `dist is ${bytes} bytes`);
});
