// kit's tests run against krepis's *source*, through the `krepis-source` export condition that
// `npm test` passes. Without it they would silently test whatever stale krepis dist happened to be built.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('krepis resolves to its source under the krepis-source condition', () => {
  for (const [spec, file] of [['@sameernair/krepis', 'src/index.ts'], ['@sameernair/krepis/connections', 'src/connections/index.ts']]) {
    const path = fileURLToPath(import.meta.resolve(spec));
    assert.ok(path.endsWith(`packages/krepis/${file}`), `${spec} -> ${path}`);
    assert.ok(!path.includes('/node_modules/'), `${spec} resolved inside node_modules, where Node will not strip types`);
  }
});
