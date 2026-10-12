import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures } from '../src/clients/neatlogs/fixtures.ts';
import { groundNarrative } from '../src/clients/neatlogs/explain.ts';
import { reconcileTurnResult } from '../src/tailor/lifecycle.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
import { createAnthropicTransport } from '../src/tailor/anthropic-transport.ts';
import { ProviderError } from '../src/tailor/provider-error.ts';

test('successful readback rejects false status and unsupported causes without discarding true measured facts', () => {
  const trace = fixtures('regression').traces.find(t => t.scenario === 'recovered')!;
  for (const claim of ['The retry failed and the request never completed.', 'The root span failed.', 'The timeout was caused by a corrupted database.', 'The database corruption triggered the timeout.']) assert.equal(groundNarrative(claim, trace, null), '', claim);
  assert.equal(groundNarrative('The retry recovered.', trace, null), 'The retry recovered.');
  assert.equal(groundNarrative('The root took 43 ms.', trace, null), 'The root took 43 ms.');
});

test('answered read-only citations survive reconciliation; failed outcomes carry no fabricated evidence', () => {
  const execution = { mode: 'mock', provider: 'tailor-mock', model: null } as const;
  const evidence = { version: 2, traceIds: ['saved'], spanIds: ['saved-step'] };
  const result = { outcome: 'answered', messages: [{ role: 'tailor', status: 'note', text: 'Saved evidence', evidence }], steps: [], execution } as const;
  const read = reconcileTurnResult({ ...result, messages: [...result.messages], steps: [] }, 2, 2, execution);
  assert.deepEqual(read.messages[0]!.evidence, evidence);
  const failed = reconcileTurnResult({ ...result, outcome: 'provider_unavailable', messages: [...result.messages], steps: [] }, 2, 2, execution);
  assert.equal(failed.messages[0]!.evidence, undefined);
});

test('dense input reservation cannot admit the independently reproduced $0.07 call under $0.04', () => {
  const spend = createSpendGuard({ capUsd: 0.04 });
  const bytes = Buffer.byteLength('क'.repeat(10_000), 'utf8');
  const reserve = spend.worstCaseUsd(bytes, 1000, 'claude-sonnet-5-5');
  assert.ok(reserve >= 0.07);
  assert.throws(() => spend.reserve(reserve, { kind: 'plan', model: 'claude-sonnet-5-5' }), (e: unknown) => e instanceof ProviderError && e.kind === 'spend_cap');
  assert.equal(spend.summary().spentUsd, 0);
});

test('unexpected reported reservation overrun is visible and fails closed across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-reserve-regression-'));
  try {
    const ledgerPath = join(dir, 'ledger.json');
    const spend = createSpendGuard({ capUsd: 0.04, ledgerPath });
    const id = spend.reserve(0.03, { kind: 'plan', model: 'claude-sonnet-5-5' });
    spend.settle(id, { inputTokens: 30_000, outputTokens: 1000 });
    assert.equal(spend.summary().degraded, true);
    assert.equal(spend.summary().spentUsd, 0.07);
    assert.throws(() => createSpendGuard({ capUsd: 1, ledgerPath }).reserve(0.01, { kind: 'guard', model: 'claude-sonnet-5-5' }), /refused/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('billed truncation retains input/output/cache usage and latency independently of successful output decoding', async () => {
  const transport = createAnthropicTransport({ apiKey: 'fixture-not-a-key', spend: createSpendGuard({ capUsd: 1 }), client: { messages: { async create() { return { stop_reason: 'max_tokens', usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 4, output_tokens_details: { thinking_tokens: 12 } }, content: [] }; } } } });
  await assert.rejects(transport.call({ kind: 'guard', messages: [{ role: 'user', content: 'fixture' }], schema: { type: 'object' }, maxTokens: 1024, extract: () => null }), (e: unknown) => {
    assert.ok(e instanceof ProviderError); assert.equal(e.kind, 'truncated');
    assert.deepEqual(e.usage, { inputTokens: 20, outputTokens: 30, cacheReadInputTokens: 4, thinkingTokens: 12 });
    assert.equal(e.settlement, 'settled_reported'); assert.ok(e.latencyMs! >= 0); assert.ok(e.inputAccounting!.totalInputBytes > 0); return true;
  });
});
