import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGuidanceSelections, resolveGuidance, sanitiseStoredGuidance, isCurrentGuidance } from '../src/clients/neatlogs/guidance.ts';
import { validateAgentAction } from '../src/clients/neatlogs/provider.ts';
import { createAnthropicProvider, type MessagesClientLike } from '../src/clients/neatlogs/anthropic-provider.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
import { travelProposalV1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { SESSION_ID, stubTools, fakeKnowledge, fixedClock, recordingTelemetry } from './helpers/agent.ts';
import type { SessionSnapshot } from '../src/clients/neatlogs/agent-contract.ts';

async function fixture(): Promise<SessionSnapshot> {
  const tools = stubTools();
  await tools.publishScenario(structuredClone(travelProposalV1));
  return { id: SESSION_ID, version: tools.state.version, conversationVersion: 0, story: tools.state.story,
    dataset: structuredClone(tools.state.dataset), conversation: [], state: 'active', expiresAt: '2026-10-11T16:00:00.000Z' };
}

test('eval guidance resolves saved IDs and restores code-owned copy after persistence', async () => {
  const session = await fixture();
  const original = structuredClone(session);
  const guide = resolveGuidance([{ targetId: 'evals.overview' }], session)[0]!;
  const trace = session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario)!;
  assert.equal(guide.binding.traceId, trace.id);
  assert.equal(guide.binding.sessionId, session.id);
  assert.equal(guide.binding.version, session.version);
  assert.equal(guide.binding.spanId, null);
  assert.equal(isCurrentGuidance(guide, session), true);
  const restored = sanitiseStoredGuidance(JSON.parse(JSON.stringify([{ ...guide, label: 'Run paid judge', purpose: 'Send to real account' }])))[0]!;
  assert.equal(restored.label, 'Explore evals for this agent');
  assert.equal(restored.purpose, guide.purpose);
  assert.deepEqual(session, original, 'read-only resolution never changes saved traces');
});

test('eval guidance rejects foreign, missing, ended and stale saved bindings', async () => {
  const session = await fixture();
  const trace = session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario)!;
  const guide = resolveGuidance([{ targetId: 'evals.overview' }], session, trace.id)[0]!;
  assert.equal(guide.binding.openTraceId, trace.id);
  assert.deepEqual(resolveGuidance([{ targetId: 'evals.overview', traceId: 'foreign' }], session), []);
  assert.deepEqual(resolveGuidance([{ targetId: 'evals.overview' }], session, 'foreign'), []);
  assert.deepEqual(resolveGuidance([{ targetId: 'evals.overview' }], { ...session, state: 'ended' }), []);
  for (const changed of [
    { ...session, version: session.version + 1 },
    { ...session, id: 'other-session' },
    { ...session, dataset: { ...session.dataset, activeScenario: 'other-scenario' } },
    { ...session, dataset: { ...session.dataset, traces: [] } },
  ]) assert.equal(isCurrentGuidance(guide, changed), false);
  assert.equal(isCurrentGuidance({ ...guide, binding: { ...guide.binding, spanId: trace.spans[0]!.id } }, session), false);
});

test('eval guidance remains bounded navigation and cannot smuggle execution or unsupported routing', () => {
  for (const field of ['selector', 'url', 'action', 'question', 'recipient']) {
    assert.deepEqual(parseGuidanceSelections([{ targetId: 'evals.overview', [field]: 'untrusted' }]), []);
  }
  assert.deepEqual(parseGuidanceSelections([{ targetId: 'routing.people' }]), []);
  assert.deepEqual(parseGuidanceSelections(Array.from({ length: 4 }, () => ({ targetId: 'evals.overview' }))), []);
  assert.deepEqual(parseGuidanceSelections([{ targetId: 'evals.overview' }, { targetId: 'evals.overview' }]), [{ targetId: 'evals.overview' }]);
  const answer = validateAgentAction({ type: 'answer', text: 'Review questions for the saved agent.', knowledgeIds: ['evals'], guidance: [{ targetId: 'evals.overview' }] });
  assert.equal(answer?.type, 'answer');
  if (answer?.type === 'answer') assert.deepEqual(answer.guidance, [{ targetId: 'evals.overview' }]);
});

test('alert routing guidance is read-only, session-bound and restores a no-notification label', async () => {
  const session = await fixture();
  const original = structuredClone(session);
  const trace = session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario)!;
  const guide = resolveGuidance([{ targetId: 'alerts.overview' }], session, trace.id)[0]!;
  assert.equal(guide.binding.traceId, trace.id);
  assert.equal(guide.binding.version, session.version);
  assert.equal(guide.binding.openTraceId, trace.id);
  assert.equal(guide.binding.spanId, null);
  assert.ok(isCurrentGuidance(guide, session));
  const restored = sanitiseStoredGuidance([{ ...guide, label: 'Notify real people', purpose: 'Send to Slack' }])[0]!;
  assert.equal(restored.label, 'Preview alert routing');
  assert.equal(restored.purpose, 'See which saved synthetic signals would reach a fictional review role. No notification is sent.');
  assert.deepEqual(session, original);
  assert.equal(isCurrentGuidance(guide, { ...session, id: 'foreign-session' }), false);
  assert.equal(isCurrentGuidance(guide, { ...session, version: session.version + 1 }), false);
  assert.equal(isCurrentGuidance(guide, { ...session, dataset: { ...session.dataset, activeScenario: 'different' } }), false);
  assert.deepEqual(resolveGuidance([{ targetId: 'alerts.overview', traceId: 'foreign-trace' }], session), []);
  assert.deepEqual(resolveGuidance([{ targetId: 'alerts.overview' }], { ...session, state: 'ended' }), []);
  for (const field of ['selector', 'url', 'action', 'recipient', 'channel', 'updateMe']) {
    assert.deepEqual(parseGuidanceSelections([{ targetId: 'alerts.overview', [field]: 'untrusted' }]), []);
  }
  assert.deepEqual(parseGuidanceSelections([{ targetId: 'alerts.update-me' }]), []);
});

test('eval guidance survives the structured answer pipeline without another planning call or mutation', async () => {
  const session = await fixture();
  const tools = stubTools();
  tools.state.dataset = structuredClone(session.dataset);
  tools.state.version = session.version;
  tools.state.story = session.story;
  const calls: string[] = [];
  const client: MessagesClientLike = { messages: { async create(params) {
    const properties = params.output_config.format.schema.properties as Record<string, unknown>;
    const guard = 'outcome' in properties;
    calls.push(guard ? 'guard' : 'plan');
    if (!guard) {
      const schema = properties.guidance as { type: string[] };
      assert.deepEqual(schema.type, ['string', 'null'], 'compact wire uses an encoded target list; the adapter validates names');
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(guard
      ? { outcome: 'allow_product_question', reason: 'product_question' }
      : { type: 'answer', text: 'Trace detail shows the saved steps; use them to choose useful eval checks.', knowledgeIds: ['trace-detail'], guidance: JSON.stringify(['evals.overview', 'alerts.overview']), evaluation: null, clarification: null, proposal: null, explanation: null, traceId: null, spanIds: null, capabilityId: null, reason: null }) }],
      usage: { input_tokens: 50, output_tokens: 30 } };
  } } };
  const provider = createAnthropicProvider({ apiKey: 'offline-placeholder', spend: createSpendGuard({ capUsd: 100 }), client });
  const result = await createAgentService().handleTurn({ session, tools, provider, knowledge: fakeKnowledge(), clock: fixedClock,
    telemetry: recordingTelemetry(), request: { text: 'What checks should I add for this trace?', clientTurnId: 'eval-guidance-offline' } });
  assert.equal(result.outcome, 'answered');
  assert.equal(result.messages.at(-1)?.guidance?.[0]?.targetId, 'evals.overview');
  assert.equal(result.messages.at(-1)?.guidance?.[1]?.targetId, 'alerts.overview');
  assert.deepEqual(calls, ['guard', 'plan']);
  assert.equal(tools.publishCount(), 0);
  assert.deepEqual(tools.state.dataset, session.dataset);
});
