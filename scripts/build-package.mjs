// Package build, run from a package directory (`npm run build`). Code that must load the same way from
// `import` and `require` ships once, as CommonJS, and its ESM entry points are thin wrappers over it, so
// both return the same objects (Node's documented way to avoid the dual-package hazard). Which entry
// points get a wrapper is read from the package's own `exports`: every entry with a `require` condition.
// JavaScript is emitted without comments; declarations come from a second pass so their JSDoc survives.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const tsc = (...args) => {
  const r = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', ...args], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const dist = resolve(root, 'dist');
rmSync(dist, { recursive: true, force: true });
// The ESM pass is optional: a package whose every entry point is a wrapper has nothing to emit as ESM.
for (const project of ['tsconfig.build.json', 'tsconfig.build.cjs.json'].filter((p) => existsSync(resolve(root, p)))) {
  tsc('-p', project, '--removeComments', '--declaration', 'false');
  tsc('-p', project, '--emitDeclarationOnly');
}
writeFileSync(resolve(dist, 'cjs/package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);

const spec = (from, to) => {
  const p = relative(dirname(from), to);
  return p.startsWith('.') ? p : `./${p}`;
};
const require = createRequire(import.meta.url);
for (const [key, entry] of Object.entries(pkg.exports)) {
  if (typeof entry !== 'object' || !entry.require) continue;
  const cjs = resolve(root, entry.require.default);
  const wrapper = resolve(root, entry.import.default);
  const types = resolve(root, entry.import.types);
  // Names are read from the built module rather than left to Node's cjs-module-lexer, so the wrapper
  // does not depend on how tsc happens to phrase its re-exports.
  const names = Object.keys(require(cjs)).sort();
  if (names.length === 0) throw new Error(`${key}: ${entry.require.default} exports nothing`);
  // A wrapper in its own directory replaces whatever the ESM pass emitted there; one at the dist root
  // (the `.` entry) shares that directory with everything else, so nothing is removed.
  const dir = dirname(wrapper);
  if (dir !== dist && existsSync(dir)) for (const e of readdirSync(dir)) rmSync(resolve(dir, e), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(wrapper, `import m from '${spec(wrapper, cjs)}';\nexport const { ${names.join(', ')} } = m;\n`);
  writeFileSync(types, `export * from '${spec(types, cjs)}';\n`);
}
