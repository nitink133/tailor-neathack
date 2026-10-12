// Offline structured Anthropic transport through the actual Neatlogs service. No network or credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnthropicProvider, type MessagesClientLike } from '../src/clients/neatlogs/anthropic-provider.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { parseGuidanceSelections, resolveGuidance, isCurrentGuidance } from '../src/clients/neatlogs/guidance.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
import { travelProposalV1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { fakeKnowledge, fixedClock, recordingTelemetry, SESSION_ID, stubTools } from './helpers/agent.ts';
import type { SessionSnapshot } from '../src/agent-contract.ts';

async function fixture() {
  const tools = stubTools();
  await tools.publishScenario(structuredClone(travelProposalV1));
  const session: SessionSnapshot = { id: SESSION_ID, version: tools.state.version, conversationVersion: 0, story: tools.state.story, dataset: structuredClone(tools.state.dataset), conversation: [], state: 'active', expiresAt: '2026-10-11T16:00:00.000Z' };
  return { tools, session, trace: session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario)! };
}
const selection = (targetId: string, traceId?: string) => ({ targetId, traceId: traceId ?? null });
const targets = ['trace.overview', 'trace.slowest-span', 'trace.output'];
function wire(guidance: unknown, extra: Record<string, unknown> = {}) {
  return { type: 'answer', text: 'Trace detail shows stored steps, timing and errors.', knowledgeIds: ['trace-detail'], clarification: null, proposal: null, explanation: null, traceId: null, spanIds: null, capabilityId: null, reason: null, guidance, ...extra };
}
async function run(guidance: unknown, extra: Record<string, unknown> = {}, openTraceId?: string) {
  const f = await fixture();
  const schemas: string[] = [];
  const client: MessagesClientLike = { messages: { async create(params) {
    const properties = params.output_config.format.schema.properties as Record<string, unknown>;
    const guard = 'outcome' in properties;
    schemas.push(guard ? 'guard' : 'plan');
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(guard ? { outcome: 'allow_product_question', reason: 'product_question' } : wire(guidance, extra)) }], usage: { input_tokens: 50, output_tokens: 30 } };
  } } };
  const telemetry = recordingTelemetry();
  const provider = createAnthropicProvider({ apiKey: 'offline-placeholder', spend: createSpendGuard({ capUsd: 100 }), client });
  const result = await createAgentService().handleTurn({ ...f, request: { text: 'What does trace detail show?', clientTurnId: 'guidance-offline', ...(openTraceId ? { openTraceId } : {}) }, knowledge: fakeKnowledge(), clock: fixedClock, telemetry, provider });
  return { ...f, result, schemas, telemetry };
}

test('guidance: structured answer carries zero to three suggestions without another planning call', async () => {
  for (let count = 0; count <= 3; count++) {
    const { result, schemas, tools, session } = await run(targets.slice(0, count).map(t => selection(t)));
    assert.equal(result.outcome, 'answered');
    assert.equal(result.messages.at(-1)?.guidance?.length ?? 0, count);
    assert.deepEqual(schemas, ['guard', 'plan'], 'guidance shares the answer generation call');
    assert.equal(tools.publishCount(), 1, 'guidance never publishes data');
    for (const guide of result.messages.at(-1)?.guidance ?? []) {
      assert.equal(guide.binding.sessionId, SESSION_ID);
      assert.equal(guide.binding.version, session.version);
    }
  }
});

test('guidance: parser fails closed for oversized, malformed and arbitrary selector/action entries', () => {
  assert.deepEqual(parseGuidanceSelections(targets.concat('trace.model-call').map(t => selection(t))), []);
  for (const bad of [null, {}, 'trace.overview', [{ targetId: 'unknown' }], [{ targetId: 'trace.overview', selector: 'body' }], [{ targetId: 'trace.overview', url: 'https://example.com' }], [{ targetId: 'trace.output', action: 'publishScenario' }], [{ targetId: 'trace.output', traceId: 7 }]]) {
    assert.deepEqual(parseGuidanceSelections(bad), [], JSON.stringify(bad));
  }
});

test('guidance: foreign trace, unknown open trace and stale dataset membership never resolve', async () => {
  const { session, trace } = await fixture();
  const known = parseGuidanceSelections([selection('trace.overview')]);
  assert.equal(resolveGuidance(known, session).length, 1);
  assert.deepEqual(resolveGuidance(parseGuidanceSelections([selection('trace.overview', 'foreign-trace')]), session), []);
  assert.deepEqual(resolveGuidance(known, session, 'foreign-trace'), []);
  assert.deepEqual(resolveGuidance(known, { ...session, dataset: { ...session.dataset, traces: [] } }, trace.id), []);
  const altered = { ...session, dataset: { ...session.dataset, traces: [{ ...trace, sessionId: 'other-session' }] } };
  assert.deepEqual(resolveGuidance(known, altered), [], 'stored trace ownership matters too');
});

test('guidance: open trace grounding rejects a different owned trace and unsupported model target', async () => {
  const { session, trace } = await fixture();
  const other = session.dataset.traces.find(t => t.id !== trace.id);
  if (other) assert.deepEqual(resolveGuidance(parseGuidanceSelections([selection('trace.overview', other.id)]), session, trace.id), []);
  const noModel = { ...session, dataset: { ...session.dataset, traces: [{ ...trace, spans: trace.spans.filter(s => s.kind !== 'LLM') }] } };
  assert.deepEqual(resolveGuidance(parseGuidanceSelections([selection('trace.model-call')]), noModel, trace.id), []);
});

test('guidance: clarification and refusal never receive actionable suggestions', async () => {
  for (const extra of [
    { type: 'ask', text: null, knowledgeIds: null, clarification: { question: 'Which workflow?', allowFreeText: true, choices: [{ id: 'travel', label: 'Travel' }, { id: 'support', label: 'Support' }, { id: 'other', label: 'Other' }] } },
    { type: 'refuse', text: 'I cannot provide another session’s traces.', knowledgeIds: null, reason: 'cross_session' },
  ]) {
    const { result } = await run([selection('trace.overview')], extra);
    for (const message of result.messages) assert.equal(message.guidance?.length ?? 0, 0);
  }
});


test('guidance: malformed guidance remains absent through genuine structured answer pipeline', async () => {
  for (const bad of [[{ targetId: 'trace.overview', selector: 'body' }], [{ targetId: 'unknown' }], [{ targetId: 'trace.overview', traceId: 'foreign-trace' }], targets.concat('trace.model-call').map(t => selection(t))]) {
    const { result, schemas } = await run(bad);
    assert.equal(result.outcome, 'answered');
    assert.equal(result.messages.at(-1)?.guidance?.length ?? 0, 0);
    assert.deepEqual(schemas, ['guard', 'plan']);
  }
});

test('guidance: saved target binding is revalidated after version, scenario and rendered target changes', async () => {
  const { session, trace } = await fixture();
  const guide = resolveGuidance([selection('trace.slowest-span')], session, trace.id)[0]!;
  assert.ok(isCurrentGuidance(guide, session));
  assert.equal(isCurrentGuidance(guide, { ...session, version: session.version + 1 }), false);
  assert.equal(isCurrentGuidance(guide, { ...session, dataset: { ...session.dataset, activeScenario: 'changed' } }), false);
  assert.equal(isCurrentGuidance(guide, { ...session, id: 'foreign-session' }), false);
  assert.equal(isCurrentGuidance(guide, { ...session, dataset: { ...session.dataset, traces: [{ ...trace, spans: trace.spans.filter(s => s.id !== guide.binding.spanId) }] } }), false);
  assert.equal(isCurrentGuidance({ ...guide, binding: { ...guide.binding, openTraceId: 'foreign-trace' } }, session), false);
});
