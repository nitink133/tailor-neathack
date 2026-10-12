// R2-01: service-level adversarial tests for EVERY model-authored reply path (planning narrative on a commit, the
// evidence explanation call, the explain tool, the answer lead, unsupported, refuse, and clarification question and
// labels), using the R2 review's exact sentences. Real service + Neatlogs adapter; scripted provider; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentAction, EvidenceExplanation, ModelProvider, ProviderResponse } from '../src/agent-contract.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { travelProposalV1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { fakeKnowledge, fixedClock, recordingTelemetry, SESSION_ID, stubTools } from './helpers/agent.ts';

const service = createAgentService();
let n = 0;

const LEAK = 'In this demo Neatlogs can page Opsgenie.';
const FULLWIDTH_RETRY = 'It retried ３ times.';
const STATUS_WORDS = 'The API returned status five hundred three.';
const FULLWIDTH_SPANS = 'Trace detail shows each step as ９ spans.';
const GROUNDED = 'The attempt took 1500 ms.';

/** Anything R2 showed reaching a buyer: the positive Opsgenie claim, full-width digits, or the invented counts/status. */
function leaksIn(text: string): string[] {
  const found: string[] = [];
  if (/can page Opsgenie/i.test(text)) found.push('positive capability claim');
  if (/(?![0-9])[\p{Nd}\p{No}]/u.test(text)) found.push('non-ASCII numeral');
  if (/\b(?:retried|retries)\s+(?:3|three)\s+times\b/i.test(text)) found.push('invented retry count');
  if (/five hundred|\b503\b/i.test(text)) found.push('invented status');
  if (/\b9\s+spans\b/i.test(text)) found.push('invented span count');
  return found;
}
type TurnResult = Awaited<ReturnType<typeof service.handleTurn>>;
const allText = (r: TurnResult) => r.messages.map(m => `${m.text} ${m.clarification ? JSON.stringify(m.clarification) : ''}`).join('\n');

interface RunOptions { seeded?: boolean; text?: string; openTraceId?: string; explanation?: EvidenceExplanation }
function provider(actions: AgentAction[], explanation?: EvidenceExplanation): ModelProvider {
  let i = 0;
  return {
    name: 'tailor-mock', model: null, mode: 'mock',
    // Independent allowed scope fixture: these cases exercise downstream prose grounding, not topic detection.
    async classifyPolicy() { return { decision: { outcome: 'allow_demo_action' as const, reason: 'demo_action' as const }, usage: null, latencyMs: 0, costUsd: 0 }; },
    async complete(): Promise<ProviderResponse> { return { action: actions[Math.min(i++, actions.length - 1)]!, usage: null, latencyMs: 0 }; },
    ...(explanation ? { async explain() { return { explanation, usage: null, latencyMs: 0 }; } } : {}),
  };
}
async function run(actions: AgentAction[], options: RunOptions = {}) {
  const tools = stubTools();
  if (options.seeded) assert.equal((await tools.publishScenario(travelProposalV1)).state, 'committed');
  const text = options.text ?? 'R2 adversarial request';
  const session = {
    id: SESSION_ID, version: tools.state.version, conversationVersion: 1, story: tools.state.story, dataset: structuredClone(tools.state.dataset),
    conversation: [{ id: 'buyer', role: 'buyer' as const, text, status: 'pending' as const, at: '2026-10-12T00:00:00.000Z' }],
    state: 'active' as const, expiresAt: '2026-10-12T04:00:00.000Z',
  };
  const result = await service.handleTurn({
    session, request: { text, clientTurnId: `adv-${++n}-000000`, ...(options.openTraceId ? { openTraceId: options.openTraceId } : {}) },
    tools, knowledge: fakeKnowledge(), telemetry: recordingTelemetry(), clock: fixedClock, provider: provider(actions, options.explanation),
  });
  return { result, tools };
}
async function seededTraceId(): Promise<string> {
  const tools = stubTools();
  await tools.publishScenario(travelProposalV1);
  return tools.state.dataset.traces[0]!.id;
}

test('R2-01: committed planning narrative drops the demo-scoped capability claim and the full-width count', async () => {
  const { result } = await run([{ type: 'propose', proposal: travelProposalV1, explanation: `${LEAK} ${FULLWIDTH_RETRY} ${GROUNDED}` }]);
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(leaksIn(allText(result)), []);
});

test('R2-01: committed evidence explanation (second model call) keeps only grounded sentences', async () => {
  const explanation = { text: `${LEAK} ${GROUNDED} ${FULLWIDTH_RETRY} ${STATUS_WORDS}`, spanIds: [] };
  const { result } = await run([{ type: 'propose', proposal: travelProposalV1, explanation: 'Saved.' }], { explanation });
  assert.equal(result.outcome, 'committed');
  const text = allText(result);
  assert.deepEqual(leaksIn(text), []);
  assert.ok(text.includes(GROUNDED), `grounded sentence survives: ${text}`);
});

test('R2-01: explain tool narrative drops the claim, the spelled-out status and the full-width span count', async () => {
  const traceId = await seededTraceId();
  const { result } = await run([{ type: 'explain', text: `${LEAK} ${GROUNDED} ${STATUS_WORDS} ${FULLWIDTH_SPANS}`, traceId, spanIds: [] }], { seeded: true });
  assert.equal(result.outcome, 'answered');
  const text = allText(result);
  assert.deepEqual(leaksIn(text), []);
  assert.ok(text.includes(GROUNDED), text);
});

test('R2-01: "It can detect X" rule — kept only for a trace-evidence verb about a real step name', async () => {
  const traceId = await seededTraceId();
  const cases: [string, boolean][] = [
    ['It detects create_reservation_attempt_1.', true],
    ['It can detect payment fraud.', false],
    ['It detects ghost_retry_step.', false],
    ['Neatlogs detects create_reservation_attempt_1.', false],
    ['It can detect create_reservation_attempt_1 and page Opsgenie.', false],
  ];
  for (const [sentence, kept] of cases) {
    const { result } = await run([{ type: 'explain', text: `${GROUNDED} ${sentence}`, traceId, spanIds: [] }], { seeded: true });
    assert.equal(allText(result).includes(sentence), kept, `${sentence} kept=${kept}`);
  }
});

test('R2-01: answer lead drops full-width numerals (exact R2 sentences) and keeps a grounded lead in a mixed reply', async () => {
  for (const lead of [FULLWIDTH_SPANS, 'It retries ３ times', `${LEAK} ${FULLWIDTH_SPANS}`]) {
    const { result } = await run([{ type: 'answer', text: lead, knowledgeIds: ['trace-detail'] }], { text: 'What does trace detail show?' });
    assert.equal(result.outcome, 'answered');
    assert.deepEqual(leaksIn(allText(result)), [], lead);
  }
  const mixed = await run([{ type: 'answer', text: `Failing steps show as ERROR in the trace detail. ${FULLWIDTH_RETRY}`, knowledgeIds: ['trace-detail'] }], { text: 'Can Neatlogs detect failed retries?' });
  assert.ok(allText(mixed.result).startsWith('Failing steps show as ERROR in the trace detail.'));
  assert.deepEqual(leaksIn(allText(mixed.result)), []);
});

test('R2-01: unsupported and refuse drop the positive claim and invented numbers, keep negative/limit wording', async () => {
  const negative = 'I can’t page Opsgenie from this demo.';
  for (const type of ['unsupported', 'refuse'] as const) {
    const text = `${LEAK} ${FULLWIDTH_RETRY} It retried 3 times. ${STATUS_WORDS} ${negative}`;
    const action = (type === 'unsupported' ? { type, text, capabilityId: 'alerts' } : { type, text, reason: 'injection' }) as AgentAction;
    const { result, tools } = await run([action]);
    const out = allText(result);
    assert.deepEqual(leaksIn(out), [], `${type}: ${out}`);
    assert.ok(out.includes(negative), `${type} keeps the negative limit sentence: ${out}`);
    assert.match(out, /Nothing was changed/);
    assert.equal(tools.publishCount(), 0);
  }
});

test('R2-01: numbers the buyer stated may be repeated on paths without read-back evidence', async () => {
  const { result } = await run([{ type: 'refuse', text: 'It retried 3 times, and I can’t change that from here.', reason: 'off_topic' }], { text: 'My agent retried 3 times. Explain this fictional run.' });
  assert.match(allText(result), /It retried 3 times/);
});

test('R2-01: clarification question and labels — R2 sentences never reach the buyer', async () => {
  const { result } = await run([{
    type: 'ask',
    clarification: {
      question: `${LEAK} Which failure?`,
      choices: [{ id: 'a', label: 'It retries ３ times' }, { id: 'b', label: 'HTTP five hundred three' }, { id: 'c', label: 'A neutral failure' }],
      allowFreeText: true,
    },
  }]);
  assert.deepEqual(leaksIn(allText(result)), [], allText(result));
  assert.notEqual(result.outcome, 'clarification', 'a clarification whose labels empty out is malformed, never shown');
});

test('R2-01 (e): "enterprise" survives as the buyer’s domain word, never as a plan', async () => {
  const ask = (question: string): AgentAction => ({
    type: 'ask',
    clarification: { question, choices: [{ id: 'a', label: 'Approval step times out' }, { id: 'b', label: 'Vendor lookup fails' }, { id: 'c', label: 'Budget check errors' }], allowFreeText: true },
  });
  const domain = await run([ask('Which enterprise workflow should fail?')], { text: 'Build a fictional enterprise procurement agent' });
  assert.equal(domain.result.outcome, 'clarification');
  assert.equal(domain.result.messages[0]!.text, 'Which enterprise workflow should fail?');

  const noDomain = await run([ask('Which enterprise workflow should fail?')], { text: 'Build a fictional procurement agent' });
  assert.notEqual(noDomain.result.outcome, 'clarification', 'not grounded in the buyer’s words: treated as a plan word');

  for (const plan of ['Enterprise plan includes SSO.', 'That is on Enterprise only.', 'Neatlogs Enterprise adds audit logs.', 'Enterprise includes SSO.']) {
    const { result } = await run([{ type: 'refuse', text: `${plan} I can’t do that here.`, reason: 'off_topic' }], { text: 'Build a fictional enterprise procurement agent' });
    assert.equal(allText(result).includes(plan), false, plan);
  }
});

test('R2-01 (e): code fences are de-fenced and their content grounded, not dropped wholesale', async () => {
  const kept = await run([{ type: 'refuse', text: 'Not possible. ```I can’t page Opsgenie from this demo```', reason: 'off_topic' }]);
  assert.match(allText(kept.result), /I can’t page Opsgenie from this demo\./);
  const dropped = await run([{ type: 'refuse', text: 'Not possible. ```In this demo Neatlogs can page Opsgenie```', reason: 'off_topic' }]);
  assert.deepEqual(leaksIn(allText(dropped.result)), []);
});
