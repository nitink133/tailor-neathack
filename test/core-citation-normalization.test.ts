import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTailorCore } from '../src/tailor/core.ts';
import { neatlogsAdapter, type NeatlogsTypes } from '../src/clients/neatlogs/adapter.ts';
import type { ProductAdapter } from '../src/tailor/adapter.ts';
import type { AgentAction, SessionSnapshot } from '../src/agent-contract.ts';
import { fixtures } from '../src/clients/neatlogs/fixtures.ts';
import { parseUserMessage } from '../src/clients/neatlogs/prompts.ts';
import { travelProposalV1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { fakeKnowledge, fixedClock, recordingTelemetry, scriptedProvider, SESSION_ID, stubTools } from './helpers/agent.ts';

function setup() {
  const tools = stubTools();
  tools.state.dataset = fixtures(SESSION_ID);
  const session: SessionSnapshot = { id: SESSION_ID, version: 1, conversationVersion: 1, story: null,
    dataset: structuredClone(tools.state.dataset), conversation: [], state: 'active', expiresAt: '2026-10-11T16:00:00.000Z' };
  const trace = tools.state.dataset.traces[0]!;
  const telemetry = recordingTelemetry();
  const attributes: Record<string, unknown>[] = [];
  telemetry.annotate = attrs => { attributes.push(attrs); };
  const run = async (action: AgentAction, options: { adapter?: ProductAdapter<NeatlogsTypes>; openTraceId?: string; beforeRead?: () => void } = {}) => {
    const provider = scriptedProvider(request => {
      const context = parseUserMessage(request.messages.find(m => m.role === 'user')!.content)!.context;
      assert.ok(context.activeTrace!.spans.some(s => s.key === 'verify'), 'planner sees short keys, not added saved IDs');
      assert.equal('id' in context.activeTrace!.spans[0]!, false);
      options.beforeRead?.();
      return action;
    });
    const result = await createTailorCore(options.adapter ?? neatlogsAdapter).handleTurn({ session,
      request: { text: 'Explain this fictional trace.', clientTurnId: 'citation-test', ...(options.openTraceId ? { openTraceId: options.openTraceId } : {}) },
      provider, tools, telemetry, clock: fixedClock, knowledge: fakeKnowledge() });
    return { result, drops: attributes.findLast(a => 'groundingDrops' in a)?.groundingDrops as number };
  };
  return { tools, session, trace, run };
}

test('core resolves model-visible span keys to saved IDs and deduplicates exact IDs without false grounding drops', async () => {
  const a = setup();
  const exact = `${a.trace.id}-verify`;
  const original = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', traceId: a.trace.scenario, spanIds: [exact] });
  const normalized = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', traceId: a.trace.scenario, spanIds: ['verify', exact, 'verify'] });
  assert.equal(normalized.result.outcome, 'answered');
  assert.deepEqual(normalized.result.messages[0]!.evidence, { version: 1, traceIds: [a.trace.id], spanIds: [exact] });
  assert.equal(normalized.drops, original.drops, 'valid alias deduplication is not an invalid citation');
  assert.equal(a.tools.publishCount(), 0);
  assert.equal(a.tools.calls.filter(c => c.name === 'readTrace').length, 2, 'each answer resolves against an independent current read');
});

test('open trace controls alias scope; other trace IDs, foreign IDs, names and unknown keys remain dropped', async () => {
  const a = setup();
  const other = a.tools.state.dataset.traces[1]!;
  const { result, drops } = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', traceId: other.id,
    spanIds: ['verify', `${other.id}-attempt-1`, 'another-session-recovered-verify', 'verify_order_result', 'not-a-span'] }, { openTraceId: a.trace.id });
  assert.deepEqual(result.messages[0]!.evidence?.spanIds, [`${a.trace.id}-verify`]);
  assert.deepEqual(result.messages[0]!.evidence?.traceIds, [a.trace.id]);
  assert.ok(drops >= 4);
  assert.equal(a.tools.publishCount(), 0);
});

test('aliases use fresh read version and spans, never stale planner snapshot spans', async () => {
  const a = setup();
  const oldId = `${a.trace.id}-verify`;
  const freshId = `${a.trace.id}-recheck`;
  const { result, drops } = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', spanIds: ['verify', oldId, 'recheck'] }, {
    beforeRead() {
      a.tools.state.version = 2;
      const fresh = structuredClone(a.trace);
      fresh.spans.find(s => s.id === oldId)!.id = freshId;
      a.tools.state.dataset.traces[0] = fresh;
    },
  });
  assert.deepEqual(result.messages[0]!.evidence, { version: 2, traceIds: [a.trace.id], spanIds: [freshId] });
  assert.ok(drops >= 2, 'both forms of the stale citation were dropped');
  assert.ok(a.session.dataset.traces[0]!.spans.some(s => s.id === oldId), 'the planner snapshot still contained the old key');
});

test('ambiguous short keys are dropped while exact saved IDs retain their existing meaning', async () => {
  const a = setup();
  const verify = a.trace.spans.find(s => s.id === `${a.trace.id}-verify`)!;
  // Defensive malformed read fixture: a key must not be guessed when more than one span matches.
  a.trace.spans.push(structuredClone(verify));
  const root = `${a.trace.id}-root`;
  const { result, drops } = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', spanIds: [root, 'verify'] });
  assert.deepEqual(result.messages[0]!.evidence?.spanIds, [root]);
  assert.ok(drops >= 1);
  const exact = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', spanIds: [verify.id] });
  assert.deepEqual(exact.result.messages[0]!.evidence?.spanIds, [verify.id]);
});

test('missing selected trace never calls normalization or switches to another trace', async () => {
  const a = setup();
  let normalized = false;
  const adapter = { ...neatlogsAdapter, grounding: { ...neatlogsAdapter.grounding, normaliseCitation() { normalized = true; return `${a.trace.id}-verify`; } } };
  const { result } = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', spanIds: ['verify'] }, { adapter, openTraceId: 'foreign-session-trace' });
  assert.equal(normalized, false);
  assert.equal(result.messages[0]!.status, 'failed');
  assert.equal(result.messages[0]!.evidence, undefined);
});

test('normalization stays optional and cannot bypass the final citable-ID filter', async () => {
  const a = setup();
  const noHook = { ...neatlogsAdapter, grounding: { ...neatlogsAdapter.grounding, normaliseCitation: undefined } };
  const legacy = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', spanIds: ['verify'] }, { adapter: noHook });
  assert.ok(!legacy.result.messages[0]!.evidence!.spanIds.includes(`${a.trace.id}-verify`), 'without the optional hook legacy exact-ID filtering remains');
  const badHook = { ...neatlogsAdapter, grounding: { ...neatlogsAdapter.grounding, normaliseCitation: () => 'foreign-session-span' } };
  const rejected = await a.run({ type: 'explain', text: 'The trace includes verify_order_result.', spanIds: ['verify'] }, { adapter: badHook });
  assert.ok(!rejected.result.messages[0]!.evidence!.spanIds.includes('foreign-session-span'));
  assert.ok(rejected.drops >= 1);
});

test('a publication version conflict does not resolve citations or claim saved evidence', async () => {
  const a = setup();
  a.tools.script.push({ state: 'conflict', currentVersion: 2 });
  let normalized = false;
  const adapter = { ...neatlogsAdapter, grounding: { ...neatlogsAdapter.grounding, normaliseCitation() { normalized = true; return `${a.trace.id}-verify`; } } };
  const { result } = await a.run({ type: 'propose', proposal: travelProposalV1, explanation: 'A fictional booking retry.' }, { adapter });
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.messages[0]!.evidence, undefined);
  assert.equal(normalized, false);
  assert.equal(a.tools.calls.some(c => c.name === 'readTrace'), false);
});
