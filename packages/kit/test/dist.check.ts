// Checks the *built* krepis-kit, so it runs from `npm run check:dist` (which builds krepis and
// then kit), not from `npm test`. Imports go through package names, so they resolve via the exports maps
// exactly as a consumer's would; no `krepis-source` condition is passed, so krepis resolves to its dist.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test('the root loads and exposes the analyser', async () => {
  const kit = await import('@sameernair/krepis-kit');
  assert.equal(typeof kit.observe, 'function');
  assert.equal(typeof kit.formatFinding, 'function');
});

test('the root re-exports no connections or DAL names; those live in krepis', async () => {
  const kit: Record<string, unknown> = await import('@sameernair/krepis-kit');
  for (const spec of ['@sameernair/krepis', '@sameernair/krepis/connections'])
    for (const name of Object.keys(require(spec))) assert.ok(!(name in kit), `krepis-kit exports ${name} from ${spec}`);
});

test('krepis-kit/drill: import and require return the same objects', async () => {
  const cjs = require('@sameernair/krepis-kit/drill');
  const esm: Record<string, unknown> = await import('@sameernair/krepis-kit/drill');
  const names = Object.keys(cjs).sort();
  assert.ok(names.includes('runDrill'));
  assert.deepEqual(Object.keys(esm).filter((k) => k !== 'default').sort(), names);
  for (const name of names) assert.equal(esm[name], cjs[name], `drill.${name}`);
});

test('the drill ESM directory holds only the wrapper', () => {
  assert.deepEqual(readdirSync(join(DIST, 'drill')).sort(), ['index.d.ts', 'index.js']);
});

test('no connections or DAL code ships in kit; drill requires it from krepis', () => {
  const rel = walk(DIST).map((f) => f.slice(DIST.length));
  assert.deepEqual(rel.filter((f) => /(^|\/)(connections|dal)\//.test(f)), []);
  const runner = readFileSync(join(DIST, 'cjs', 'drill', 'runner.js'), 'utf8');
  assert.match(runner, /require\("@sameernair\/krepis\/connections"\)/);
});

test('drill shares krepis/connections with the app rather than loading a second copy', () => {
  const out = execFileSync(
    process.execPath,
    ['-e', `require('@sameernair/krepis-kit/drill'); console.log(JSON.stringify(Object.keys(require.cache)))`],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  const conn = (JSON.parse(out) as string[]).filter((f) => f.endsWith(join('connections', 'index.js')));
  assert.deepEqual(conn, [require.resolve('@sameernair/krepis/connections')]);
});

test('both bins point at the cli, and the cli loads drill through the wrapper', async () => {
  assert.deepEqual(PKG.bin, { krepis: './dist/cli.js', 'krepis-kit': './dist/cli.js' });
  assert.match(readFileSync(join(DIST, 'cli.js'), 'utf8'), /^#!\/usr\/bin\/env node/);
  const drill = await import(join(DIST, 'drill', 'index.js'));
  assert.equal(typeof drill.runDrill, 'function');
  assert.equal(typeof drill.formatDrillReport, 'function');
});

test('krepis is a dependency, not a peer, so `npx @sameernair/krepis-kit` works on its own', () => {
  assert.equal(PKG.dependencies?.['@sameernair/krepis'], 'workspace:^');
  assert.equal(PKG.peerDependencies?.['@sameernair/krepis'], undefined);
});

// TypeScript 7 does not reject krepis src outside rootDir and emits identical output, so this pins the
// override directly: the build must compile against krepis's published declarations, as consumers do.
test('the build compiles against krepis declarations, never krepis source', () => {
  const tsc = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url));
  for (const config of ['tsconfig.build.json', 'tsconfig.build.cjs.json']) {
    const listed = execFileSync(tsc, ['-p', config, '--listFilesOnly'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    }).split('\n');
    assert.deepEqual(listed.filter((f) => f.includes('/packages/krepis/src/')), [], config);
    assert.ok(listed.some((f) => f.includes('/packages/krepis/dist/')), `${config} reads no krepis declarations`);
  }
});

test('emitted JavaScript carries no doc comments; declarations keep them', () => {
  const files = walk(DIST);
  assert.deepEqual(files.filter((f) => f.endsWith('.js') && readFileSync(f, 'utf8').includes('/**')), []);
  assert.ok(files.filter((f) => f.endsWith('.d.ts') && readFileSync(f, 'utf8').includes('/**')).length >= 10);
});

test('dist stays inside its size budget', () => {
  const bytes = walk(DIST).reduce((n, f) => n + statSync(f).size, 0);
  assert.ok(bytes <= 260_000, `dist is ${bytes} bytes`);
});
