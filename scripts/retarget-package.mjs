// Rewrites an unpacked krepis package for GitHub Packages, which accepts only names scoped to the repository
// owner: `@sameernair/krepis` (the npm name) becomes `@owner/krepis`, and krepis-kit's dependency on it
// becomes an alias of the owner-scoped package, so an install from GitHub Packages never reaches npmjs. The
// dependency keeps its npm name, so kit's `require('@sameernair/krepis/connections')` still resolves.
// Used by .github/workflows/release.yml.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, scope] = process.argv.slice(2);
if (!dir || !/^@[a-z0-9][a-z0-9-]*$/.test(scope ?? '')) {
  console.error('usage: node scripts/retarget-package.mjs <unpacked-package-dir> <@lowercase-scope>');
  process.exit(2);
}

const OURS = new Set(['krepis', 'krepis-kit']);
/** The unscoped name of one of our packages, or undefined. */
const ours = (name) => {
  const base = name.replace(/^@[^/]+\//, '');
  return OURS.has(base) ? base : undefined;
};

const file = join(dir, 'package.json');
const pkg = JSON.parse(readFileSync(file, 'utf8'));
const base = ours(pkg.name);
if (!base) {
  console.error(`refusing to retarget ${pkg.name}: not a krepis package`);
  process.exit(1);
}

pkg.name = `${scope}/${base}`;
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  const dep = ours(name);
  if (!dep) continue;
  if (range.startsWith('workspace:')) {
    console.error(`${name} is still ${range}: pack with pnpm`);
    process.exit(1);
  }
  if (name !== `${scope}/${dep}`) pkg.dependencies[name] = `npm:${scope}/${dep}@${range}`;
}
pkg.publishConfig = { registry: 'https://npm.pkg.github.com' };

writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${pkg.name}@${pkg.version}`);
