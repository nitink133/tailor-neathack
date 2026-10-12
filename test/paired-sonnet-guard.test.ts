import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareSonnetGuard, runSonnetGuard, type ArchivedComparison } from '../scripts/compare-sonnet-guard.ts';
import type { ComparisonCase, ComparisonPlan } from '../scripts/compare-cheap-models.ts';
import { ANTHROPIC_FIXED_PARTS, type MessagesClientLike } from '../src/clients/neatlogs/anthropic-provider.ts';
import { toAnthropicMessages } from '../src/tailor/anthropic-transport.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function archived(): ArchivedComparison {
  const cases: ComparisonCase[] = Array.from({ length: 16 }, (_, i) => ({ id: `paired-${i}`, phase: 'guard', buyerText: `case ${i}`,
    request: { messages: [{ role: 'system', content: 'Fixed archived guard policy.' }, { role: 'user', content: JSON.stringify({ case: i }) }], responseSchema: 'entry_policy', maxOutputTokens: 1024 },
    expectedOutcomes: i < 8 ? ['allow_product_question'] : ['clarify'], review: ['Original dispatch requirement'], knownTraceIds: [], knownSpanIds: [], knownKnowledgeIds: [] }));
  return { plan: { schema: 'tailor-cheap-model-comparison-v1', cases, requestsSha256: hash(cases.map(c => c.request)) } as ComparisonPlan,
    rows: cases.flatMap(c => ['low', 'medium'].map(effort => { const mapped = toAnthropicMessages(c.request.messages); return { caseId: c.id, phase: 'guard', effort,
      wireEvidence: { systemSha256: hash(mapped.system), messagesSha256: hash(mapped.messages), schemaSha256: hash(ANTHROPIC_FIXED_PARTS.guard.schema), actualWireEffort: effort } }; })) };
}

test('paired Sonnet uses exact archived system/messages/schema with native low effort and genuine Sonnet pricing', async () => {
  const archive = archived(), plan = prepareSonnetGuard(archive), spend = createSpendGuard({ capUsd: 19 }); let calls = 0;
  assert.equal(plan.calls, 16); assert.ok(plan.maxReservationUsd < .5);
  const client: MessagesClientLike = { messages: { async create(params) {
    const c = plan.cases[calls++]!, mapped = toAnthropicMessages(c.request.messages);
    assert.equal(params.model, 'claude-sonnet-5-5'); assert.equal(params.output_config.effort, 'low');
    assert.equal(params.system, mapped.system); assert.deepEqual(params.messages, mapped.messages);
    assert.equal(hash(params.output_config.format.schema), plan.schemaSha256);
    assert.equal(params.max_tokens, 1024);
    return { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 100, output_tokens_details: { thinking_tokens: 50 } },
      content: [{ type: 'text', text: JSON.stringify({ outcome: c.expectedOutcomes![0], reason: calls <= 8 ? 'product_question' : 'ambiguous' }) }] };
  } } };
  const result = await runSonnetGuard(archive, { apiKey: 'offline-fixture', spend, client });
  assert.equal(calls, 16); assert.equal(result.guardEligibility, 'eligible-for-review');
  assert.ok(Math.abs(result.finalSpend.spentUsd - 16 * .0012) < 1e-12);
  assert.equal(result.defaultSwitch, false);
});

test('tampered messages/schema and wrong pricing or pending ledger state prevent every call', async () => {
  const archive = archived(); let calls = 0;
  const client: MessagesClientLike = { messages: { async create() { calls++; throw Error('must not call'); } } };
  const changed = structuredClone(archive); changed.plan.cases[0]!.request.messages[0]!.content += ' altered';
  assert.throws(() => prepareSonnetGuard(changed), /changed/);
  const badSchema = structuredClone(archive); badSchema.rows[0]!.wireEvidence!.schemaSha256 = 'changed';
  assert.throws(() => prepareSonnetGuard(badSchema), /verify paired/);
  await assert.rejects(runSonnetGuard(archive, { apiKey: 'offline', client, spend: createSpendGuard({ capUsd: 19, rates: { inputPerMTok: .1, outputPerMTok: .5 } }) }), /Sonnet model rates/);
  const spend = createSpendGuard({ capUsd: 19 }); spend.reserve(.01, { kind: 'other-root-call', model: 'claude-sonnet-5-5' });
  await assert.rejects(runSonnetGuard(archive, { apiKey: 'offline', client, spend }), /zero pending/);
  assert.equal(calls, 0);
});
