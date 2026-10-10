import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('neatlogs is pinned to an exact version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.dependencies.neatlogs, /^\d+\.\d+\.\d+$/);
});

test('neatlogs SDK exposes init/flush/shutdown', async () => {
  const sdk = await import('neatlogs');
  for (const fn of ['init', 'flush', 'shutdown'] as const) {
    assert.equal(typeof sdk[fn], 'function', fn);
  }
});
