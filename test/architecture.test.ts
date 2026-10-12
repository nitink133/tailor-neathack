// Module boundaries: the reusable core (src/tailor) never reaches the demo adapter or infrastructure, telemetry never
// reaches the demo adapter, and the browser-reachable contract stays free of Node modules. Checked transitively by
// following relative imports from source text (no tooling).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const rel = (file: string) => relative(root, file).split('\\').join('/');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? filesUnder(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}
/** Every import/export specifier, including type-only and dynamic imports, with ' " or ` delimiters. */
export function specifiersOf(text: string): string[] {
  const q = `(['"\`])([^'"\`]+)\\1`;
  return [
    ...[...text.matchAll(new RegExp(`^\\s*(?:import|export)\\b[^;]*?\\bfrom\\s+${q}`, 'gm'))].map(m => m[2]!),
    ...[...text.matchAll(new RegExp(`^\\s*import\\s+${q}`, 'gm'))].map(m => m[2]!),
    ...[...text.matchAll(new RegExp(`\\bimport\\(\\s*${q}\\s*\\)`, 'g'))].map(m => m[2]!),
  ];
}
const specifiers = (file: string) => specifiersOf(readFileSync(file, 'utf8'));
/** CommonJS escape hatches that bypass the import graph: `createRequire` or a `require(` call. */
export const hasRequire = (text: string) => /\bcreateRequire\b|(?<![\w.$])require\s*\(/.test(text);
function localImports(file: string): string[] {
  return specifiers(file).filter(s => s.startsWith('.')).map(s => resolve(dirname(file), s));
}
/** The file plus everything it reaches through relative imports. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...localImports(file));
  }
  return seen;
}

const tailorFiles = filesUnder(join(src, 'tailor'));

test('src/tailor exists and holds the core modules', () => {
  const names = tailorFiles.map(f => rel(f));
  for (const expected of ['src/tailor/core.ts', 'src/tailor/adapter.ts', 'src/tailor/contract.ts', 'src/tailor/lifecycle.ts', 'src/tailor/anthropic-transport.ts', 'src/tailor/spend.ts']) {
    assert.ok(names.includes(expected), `${expected} is part of the core`);
  }
});

test('src/tailor/** never imports src/clients/** or src/infrastructure/** (transitively)', () => {
  for (const file of tailorFiles) {
    for (const reached of closure(file)) {
      const r = rel(reached);
      assert.ok(r.startsWith('src/tailor/'), `${rel(file)} reaches ${r}`);
    }
  }
});

test('src/tailor/** never uses createRequire or require( (they bypass the import graph)', () => {
  for (const file of tailorFiles) assert.equal(hasRequire(readFileSync(file, 'utf8')), false, `${rel(file)} uses require`);
});

test('the boundary scanner sees every delimiter and require form (R1-F5)', () => {
  assert.deepEqual(specifiersOf(`import { a } from '../clients/x.ts';`), ['../clients/x.ts']);
  assert.deepEqual(specifiersOf(`import { a } from "../clients/x.ts";`), ['../clients/x.ts']);
  assert.deepEqual(specifiersOf('export * from `../infrastructure/y.ts`;'), ['../infrastructure/y.ts']);
  assert.deepEqual(specifiersOf(`import "../clients/side.ts";`), ['../clients/side.ts']);
  assert.deepEqual(specifiersOf('const m = await import(`../clients/z.ts`);'), ['../clients/z.ts']);
  assert.equal(hasRequire(`import { createRequire } from 'node:module';`), true);
  assert.equal(hasRequire(`const x = require('../clients/x.cjs');`), true);
  assert.equal(hasRequire(`const req = module.require; // not a call`), false);
  assert.equal(hasRequire(`// requireValue(x) and obj.require(x) are not CommonJS require`), false);
});

test('telemetry never imports the demo adapter (transitively)', () => {
  const telemetry = join(src, 'infrastructure', 'telemetry.ts');
  for (const reached of closure(telemetry)) assert.doesNotMatch(rel(reached), /^src\/clients\//, `telemetry reaches ${rel(reached)}`);
});

test('the browser bundle entry reaches no Node-only module', () => {
  const browser = JSON.parse(readFileSync(join(root, 'tsconfig.browser.json'), 'utf8')) as { include: string[] };
  assert.deepEqual(browser.include, ['src/clients/neatlogs/client.ts']);
  for (const reached of closure(join(root, browser.include[0]!))) {
    for (const s of specifiers(reached)) assert.ok(s.startsWith('.'), `${rel(reached)} imports ${s} into the browser bundle`);
  }
});

test('the core carries no trace/span/scenario/Neatlogs vocabulary outside the allowlist', () => {
  // Each entry: file, the exact line fragment allowed, and why.
  const allowed: { file: string; fragment: string; why: string }[] = [
    { file: 'src/tailor/adapter.ts', fragment: 'its telemetry span', why: 'telemetry spans, not product spans' },
    { file: 'src/tailor/claims.ts', fragment: 'keeps?\\s+(?:your|traces?|data)', why: 'retention-claim filter phrase ("keeps your traces") inherited verbatim' },
    { file: 'src/tailor/claims.ts', fragment: 'const UNIT = ', why: 'measure nouns for number-word grounding ("nine spans" is a count)' },
    { file: 'src/tailor/claims.ts', fragment: 'const CONTEXT_BEFORE = ', why: 'position words for number-word grounding ("span three")' },
    { file: 'src/tailor/claims.ts', fragment: 'const MEASURE_CONTEXT = ', why: 'count nouns that make an unparsed number word ungrounded' },
  ];
  const offenders: string[] = [];
  for (const file of tailorFiles) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!/trace|span|scenario|neatlogs/i.test(line)) return;
      if (allowed.some(a => a.file === rel(file) && line.includes(a.fragment))) return;
      offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the infrastructure and adapter layers stay where main.ts wires them', () => {
  const main = specifiers(join(src, 'main.ts'));
  assert.ok(main.some(s => s.startsWith('./infrastructure/')), 'main wires infrastructure');
  assert.ok(main.some(s => s.startsWith('./clients/neatlogs/')), 'main wires the Neatlogs adapter');
  assert.ok(main.some(s => s.startsWith('./tailor/')), 'main wires the core');
});
