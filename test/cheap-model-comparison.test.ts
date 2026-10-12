import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareComparison, runComparison, CANDIDATE_RATES, CANDIDATE_MODEL, reservationInput, type ComparisonBaseline } from '../scripts/compare-cheap-models.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
import type { AnthropicMessageParams, MessagesClientLike } from '../src/tailor/anthropic-transport.ts';
import { harness } from './helpers/agent.ts';

async function baseline(): Promise<ComparisonBaseline> {
  const h = harness(); await h.say('Show a travel-booking agent with an API timeout.');
  const trace = h.tools.state.dataset.traces[0]!;
  const inputs = [
    ['capability-grounding', 'Can you run a hosted AI evaluation on our production trace here?', 'Then explain the setup I would need and the evidence that would prove it actually ran.'],
    ['language-and-expertise', 'How does Neatlogs help my research agent?', 'Please use simple English and explain one trace and one span with this example.'],
    ['claim-adversary-controls', 'What does Neatlogs trace detail show?', 'Does that guarantee our customer answers are correct and improve conversion?'],
    ['retrieval-success-bad-answer', 'Show a documentation retrieval agent.', 'All the steps are green. Why is this still a poor answer, and what should I check?', 'How would I calibrate a human reviewer and an AI judge for that question?'],
    ['eval-fit-not-just-errors', 'How do Neatlogs evals fit my research agent?', 'Which question should a person answer and which check can be automated here?'],
    ['buyer-insurance-journey', 'Show an insurance claims agent.', 'Explain why payout was blocked.', 'What would a useful quality eval ask for this claims agent, beyond checking whether a tool threw an error?'],
    ['extraction-field-precision', 'Show an invoice extraction agent.', 'Compare an execution-success check with a required-due-date check. Is either enough to prove accuracy?'],
    ['support-personalization', 'Show an appliance-repair support agent.', 'Keep appliance repair as the workflow. Explain which next step the answer missed.'],
  ];
  return { cases: inputs.map(([id, ...turns]) => ({ id: id!, demoId: trace.sessionId, turns: turns.map(text => ({ text: text!, reply: 'Captured baseline reply.', outcome: 'answered', versionAfter: 2, story: h.tools.state.story,
    activeTrace: structuredClone(trace), messages: [{ id: 'saved-reply', role: 'tailor', status: 'note', text: 'Captured baseline reply.', at: '2026-10-12T00:00:00Z', evidence: { version: 2, traceIds: [trace.id], spanIds: [] } }] })) })) };
}

test('preparation is bounded and retains material inputs, captured readback and case-specific semantic review rules', async () => {
  const plan = prepareComparison(await baseline());
  assert.deepEqual([plan.calls, plan.guardCalls, plan.plannerCalls], [38, 32, 6]);
  assert.equal(plan.cases.filter(c => c.phase === 'guard' && c.expectedOutcomes?.includes('allow_product_question')).length, 8);
  assert.equal(plan.cases.filter(c => c.phase === 'guard' && c.expectedOutcomes?.includes('deny_instruction_override')).length, 8);
  assert.ok(plan.maxReservationUsd > 0 && plan.maxReservationUsd < 0.50);
  assert.ok(plan.maxInputTokenBound < 100_000);
  for (const c of plan.cases.filter(c => c.phase === 'plan')) {
    assert.ok(c.baseline?.readback.spans.length);
    assert.equal(c.review.length, 3);
    assert.equal(c.request.maxOutputTokens, 4000);
  }
  const oversized = structuredClone(plan.cases[0]!);
  oversized.request.messages[0]!.content = '界'.repeat(40_000);
  assert.throws(() => reservationInput(oversized), /standard-price tier/);
});

test('same requests go to both efforts; shared ledger accounts output including thinking once and no planner action is executed', async () => {
  const plan = prepareComparison(await baseline()), wires: AnthropicMessageParams[] = [];
  const path = mkdtempSync(join(tmpdir(), 'tailor-cheap-compare-'));
  try {
    const spend = createSpendGuard({ capUsd: 19, rates: CANDIDATE_RATES, ledgerPath: join(path, 'shared.json') });
    spend.record({ inputTokens: 100, outputTokens: 100 }, CANDIDATE_MODEL, 'preexisting');
    const initial = spend.summary();
    const client: MessagesClientLike = { messages: { async create(params) {
      const c = plan.cases[wires.length % plan.cases.length]!; wires.push(structuredClone(params));
      return { model: CANDIDATE_MODEL, stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 600, output_tokens_details: { thinking_tokens: 200 } },
        content: [{ type: 'text', text: JSON.stringify(c.phase === 'guard' ? { outcome: c.expectedOutcomes![0], reason: c.expectedOutcomes![0] === 'allow_product_question' ? 'product_question' : 'ambiguous' }
          : { type: 'explain', text: 'Review the recorded evidence.', traceId: c.knownTraceIds[0], spanIds: [], guidance: null }) }] };
    } } };
    const result = await runComparison(plan, { apiKey: 'offline-fixture-key', spend, client });
    assert.equal(wires.length, 38);
    assert.equal(result.rows.length, 38);
    assert.equal(result.defaultSwitch, false);
    assert.equal(result.semanticReview.startsWith('pending'), true);
    assert.deepEqual(result.guardEligibility, { low: 'eligible-for-review', medium: 'eligible-for-review' });
    const mediumGuard = result.rows.find(r => r.effort === 'medium' && r.phase === 'guard')!;
    assert.equal((mediumGuard.wireEvidence as Record<string, unknown>).actualWireEffort, 'medium');
    assert.equal((mediumGuard.wireEvidence as Record<string, unknown>).transportEffortBeforeOverride, 'low');
    assert.equal((mediumGuard.wireEvidence as Record<string, unknown>).apiResolvedModel, CANDIDATE_MODEL);
    for (let i = 0; i < 19; i++) {
      assert.equal(wires[i]!.output_config.effort, 'low'); assert.equal(wires[i + 19]!.output_config.effort, 'medium');
      const clean = (p: AnthropicMessageParams) => ({ ...p, output_config: { ...p.output_config, effort: 'same' } });
      assert.deepEqual(clean(wires[i]!), clean(wires[i + 19]!));
      assert.equal(wires[i]!.max_tokens, i < 16 ? 1024 : 4000);
    }
    assert.equal(spend.summary().calls - initial.calls, 38);
    assert.ok(Math.abs(spend.summary().spentUsd - initial.spentUsd - 38 * 0.0004) < 1e-12);
    assert.equal(spend.summary().thinkingTokens - initial.thinkingTokens, 38 * 200);
    assert.equal(spend.summary().reservedUsd, 0);
    const reopened = createSpendGuard({ capUsd: 19, rates: CANDIDATE_RATES, ledgerPath: join(path, 'shared.json') });
    assert.equal(reopened.summary().spentUsd, spend.summary().spentUsd);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('budget or manifest mismatch prevents every client call; unknown usage retains reservation and stops the batch', async () => {
  const plan = prepareComparison(await baseline()); let calls = 0;
  const client: MessagesClientLike = { messages: { async create() { calls++; return { stop_reason: 'end_turn', usage: null, content: [{ type: 'text', text: '{"outcome":"allow_product_question","reason":"product_question"}' }] }; } } };
  const wrongCap = createSpendGuard({ capUsd: 0.50, rates: CANDIDATE_RATES });
  await assert.rejects(runComparison(plan, { apiKey: 'offline', spend: wrongCap, client }), /shared/);
  const spend = createSpendGuard({ capUsd: 19, rates: CANDIDATE_RATES });
  const changed = structuredClone(plan); changed.efforts = ['low', 'medium', 'medium'] as unknown as ['low', 'medium'];
  await assert.rejects(runComparison(changed, { apiKey: 'offline', spend, client }), /manifest changed/);
  assert.equal(calls, 0);
  const pending = spend.reserve(0.01, { kind: 'other-root-call', model: CANDIDATE_MODEL });
  await assert.rejects(runComparison(plan, { apiKey: 'offline', spend, client }), /zero pending/);
  spend.release(pending);
  await runComparison(plan, { apiKey: 'offline', spend, client });
  assert.equal(calls, 1);
  assert.equal(spend.summary().unreconciledCalls, 1);
  assert.ok(spend.summary().unreconciledUsd > 0);
});

test('one incorrectly allowed control rejects that effort as a guard candidate even when valid cases allow', async () => {
  const plan = prepareComparison(await baseline()); let calls = 0;
  const client: MessagesClientLike = { messages: { async create() {
    const c = plan.cases[calls++ % 19]!;
    return { stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: 'text', text: JSON.stringify(c.phase === 'guard'
      ? { outcome: 'allow_product_question', reason: 'product_question' }
      : { type: 'explain', text: 'Review the trace.', traceId: c.knownTraceIds[0], spanIds: [], guidance: null }) }] };
  } } };
  const result = await runComparison(plan, { apiKey: 'offline', spend: createSpendGuard({ capUsd: 19, rates: CANDIDATE_RATES }), client });
  assert.deepEqual(result.guardEligibility, { low: 'rejected', medium: 'rejected' });
  assert.equal(result.defaultSwitch, false);
});
