import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadKnowledge, pricingSummary } from '../src/knowledge.ts';

const knowledgeDir = new URL('../knowledge/neatlogs/', import.meta.url);
const validLevels = new Set(['demonstrable', 'modifiable', 'explain_only', 'unsupported']);
const validScopes = new Set(['official_product', 'clone_only']);

test('real knowledge files match the version and source contract', () => {
  const index = loadKnowledge();
  const records = index.all();
  const version = JSON.parse(readFileSync(new URL('version.json', knowledgeDir), 'utf8')) as { recordCount: number };
  assert.equal(records.length, version.recordCount);
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);

  for (const record of records) {
    assert.ok(validLevels.has(record.demonstration.level));
    assert.ok(validScopes.has(record.scope));
    if (record.scope === 'official_product') {
      assert.ok(record.sources.some((source) => /^https?:\/\//.test(source.url) && /^\d{4}-\d{2}-\d{2}$/.test(source.verifiedOn)));
    } else {
      assert.ok(record.sources.some((source) => /^(?:repo:|https?:\/\/)/.test(source.url)));
    }
  }
});

test('retry selection is bounded and executable-first', () => {
  const selected = loadKnowledge().select('booking API timeout then retry');
  assert.ok(selected.length > 0);
  assert.ok(selected.length <= 6);
  assert.ok(['demonstrable', 'modifiable'].includes(selected[0]!.demonstration.level));
  assert.match(JSON.stringify(selected[0]).toLowerCase(), /retry|error|timeout/);
});

test('pricing question surfaces pricing with appropriately verified availability', () => {
  const selected = loadKnowledge().select('how much does it cost');
  const pricing = selected.find((record) => record.topics.includes('pricing'));
  assert.ok(pricing, 'expected a pricing-related record');
  const summary = pricingSummary();
  if (summary.status === 'known') {
    assert.ok(summary.sources.some((source) => /^https?:\/\//.test(source.url)));
    assert.equal(pricing.planAvailability.status, 'known');
  } else {
    assert.equal(pricing.planAvailability.status, 'unknown');
  }
});

test('Slack alert question returns an explain-only alert record', () => {
  const selected = loadKnowledge().select('set up a Slack alert');
  const alert = selected.find((record) => record.topics.includes('slack') && record.topics.includes('alert'));
  assert.ok(alert, 'expected the official alerts record');
  assert.equal(alert.demonstration.level, 'explain_only');
});

test('malformed records fail with a clear error', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tailor-knowledge-'));
  try {
    const records = JSON.parse(readFileSync(new URL('capabilities.json', knowledgeDir), 'utf8')) as Record<string, unknown>[];
    delete records[0]!.title;
    writeFileSync(join(directory, 'capabilities.json'), JSON.stringify(records));
    writeFileSync(join(directory, 'version.json'), readFileSync(new URL('version.json', knowledgeDir)));
    writeFileSync(join(directory, 'pricing.json'), readFileSync(new URL('pricing.json', knowledgeDir)));
    assert.throws(() => loadKnowledge(pathToFileURL(`${directory}/`)), /Malformed capabilities\.json: records\[0\]\.title/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
