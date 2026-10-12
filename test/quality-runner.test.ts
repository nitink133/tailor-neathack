import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResponseQuality, runQualityEvaluations, tailorReply } from '../src/evaluation/quality-runner.ts';
import { RUNTIME_QUALITY_CASES, TRACE_INSPECTION_REQUIREMENTS, type QualityTurn } from '../src/evaluation/quality-cases.ts';
import type { TurnResponse } from '../src/clients/neatlogs/agent-contract.ts';
import type { Evidence, Trace } from '../src/clients/neatlogs/contracts.ts';

// Independently authored reference labels: no model, hosted review or provider-generated labels.
const trace: Trace = {
  id: 'saved-warehouse', sessionId: 'synthetic-buyer', scenario: 'warehouse', label: 'Calendar timeout', name: 'Warehouse scheduling',
  ingestedAt: '2026-10-12T00:00:00Z', status: 'Ready', outcome: 'escalation_required', outcomeKind: 'escalation', tags: ['synthetic'], input: {}, output: {},
  spans: [{ id: 'calendar-timeout', parentId: null, name: 'calendar_api', kind: 'TOOL', startMs: 0, durationMs: 100, status: 'ERROR', input: {}, output: null, error: 'SYNTHETIC timeout', detection: true }],
};
const citation: Evidence = { version: 3, traceIds: [trace.id], spanIds: ['calendar-timeout'] };
type Response = Pick<TurnResponse, 'outcome' | 'messages' | 'evidence'>;
function response(text: string, evidence?: Evidence): Response {
  return { outcome: 'answered', messages: [
    { id: 'buyer', role: 'buyer', text: 'Neatlogs traces span inputs outputs timing. Explain the failed warehouse calendar tool.', status: 'note', at: '2026-10-12T00:00:00Z' },
    { id: 'tailor', role: 'tailor', text, status: 'note', at: '2026-10-12T00:00:00Z', ...(evidence ? { evidence } : {}) },
  ] };
}
const inspect: QualityTurn['expect'] = { outcomes: ['answered'], versionDelta: 0, answerRequirements: TRACE_INSPECTION_REQUIREMENTS };
const explain: QualityTurn['expect'] = { outcomes: ['answered'], versionDelta: 0, requireTraceEvidence: true, answerRequirements: [
  { key: 'buyer_calendar_failure', alternatives: [['warehouse', 'calendar', 'failed|timeout']], forbiddenPatterns: ['flight|airline|travel.booking'] },
] };
const allPassed = (r: Response, expected: QualityTurn['expect']) => evaluateResponseQuality(r, expected, [trace], 3, trace.id).every(c => c.passed);

test('calibration: substantive product facts pass, generic trace/span filler and echoed buyer facts fail', () => {
  const labelled = [
    { label: 'good', text: 'A trace records a complete agent run with nested spans. Inspect inputs, outputs and timing to find the failing step. What is available depends on application instrumentation.' },
    { label: 'bad', text: 'Neatlogs provides traces and spans. This is useful observability.' },
    { label: 'bad', text: 'Thank you! That is a great question.' },
    { label: 'bad', text: 'Trace. Complete agent run. Spans. Inputs. Outputs. Timing. Instrumentation.' },
  ];
  for (const item of labelled) assert.equal(allPassed(response(item.text), inspect), item.label === 'good', item.text);
  assert.equal(tailorReply(response('Tailor only')), 'Tailor only');
  assert.equal(allPassed(response('Thank you!'), { ...inspect, answerPattern: 'warehouse|calendar|trace|span' }), false);
});

test('calibration: wrong-domain explanation fails even with valid saved citations', () => {
  const labelled = [
    { label: 'good', text: 'The warehouse calendar tool failed with a timeout.', evidence: citation },
    { label: 'bad', text: 'The flight booking failed because the airline timed out.', evidence: citation },
    { label: 'bad', text: 'The warehouse calendar tool failed, and your flight booking caused it.', evidence: citation },
  ];
  for (const item of labelled) assert.equal(allPassed(response(item.text, item.evidence), explain), item.label === 'good', item.text);
});

test('calibration: answered trace explanation needs nonempty evidence; a product answer does not need saved traces', () => {
  const text = 'The warehouse calendar tool failed with a timeout.';
  for (const evidence of [undefined, { version: 3, traceIds: [], spanIds: [] }, { version: 3, traceIds: [trace.id], spanIds: [] }]) {
    const checks = evaluateResponseQuality(response(text, evidence), explain, [trace], 3, trace.id);
    assert.ok(checks.some(c => c.name === 'required_message_evidence' && !c.passed));
    assert.equal(checks.every(c => c.passed), false);
  }
  assert.equal(allPassed(response(text, citation), explain), true);
  const goodProduct = response('A trace records a complete agent run with spans. Inputs, outputs and timing show the steps. Data depends on application instrumentation.');
  assert.equal(evaluateResponseQuality(goodProduct, inspect, [], 3).every(c => c.passed), true);
});

test('evidence checks reject stale versions, orphan IDs and spans from an uncited trace', () => {
  const text = 'The warehouse calendar tool failed with a timeout.';
  const other: Trace = { ...trace, id: 'other-trace', spans: [{ ...trace.spans[0]!, id: 'other-span' }] };
  for (const evidence of [
    { ...citation, version: 2 }, { ...citation, traceIds: ['missing'] }, { ...citation, spanIds: ['missing'] },
    { ...citation, spanIds: ['other-span'] }, { version: 3, traceIds: [other.id], spanIds: ['other-span'] },
  ]) assert.equal(evaluateResponseQuality(response(text, evidence), explain, [trace, other], 3, trace.id).every(c => c.passed), false);
});

test('committed turns require both message citations and authoritative readback evidence', () => {
  const answered = response('Saved the warehouse calendar timeout.', citation);
  const committed: Response = { ...answered, outcome: 'committed' };
  assert.equal(allPassed(committed, { outcomes: ['committed'], versionDelta: 1 }), false);
  const readback: NonNullable<TurnResponse['evidence']> = { ...citation, activeScenario: trace.scenario, traces: [] };
  assert.equal(allPassed({ ...committed, evidence: readback }, { outcomes: ['committed'], versionDelta: 1 }), true);
  assert.equal(allPassed({ ...response('Saved'), outcome: 'committed', evidence: readback }, { outcomes: ['committed'], versionDelta: 1 }), false);
  const other: Trace = { ...trace, id: 'other-trace', spans: [{ ...trace.spans[0]!, id: 'other-span' }] };
  const wrongMessage = response('Saved', { version: 3, traceIds: [other.id], spanIds: ['other-span'] });
  assert.equal(evaluateResponseQuality({ ...wrongMessage, outcome: 'committed', evidence: readback }, { outcomes: ['committed'], versionDelta: 1 }, [trace, other], 3, trace.id).every(c => c.passed), false);
});

test('runtime: independent GET evidence validates answered explanations as well as commits', async () => {
  const cases = RUNTIME_QUALITY_CASES.filter(c => ['retry-follow-up-preserves-state', 'coding-benefit-is-product-answer', 'research-benefit-is-product-answer'].includes(c.id));
  const report = await runQualityEvaluations(cases);
  assert.equal(report.passed, true, JSON.stringify(report.runtime.flatMap(c => c.checks.filter(x => !x.passed))));
  const journey = report.runtime.find(c => c.id === 'retry-follow-up-preserves-state')!;
  assert.equal(journey.evidence[2]!.outcome, 'answered');
  assert.equal(journey.evidence[2]!.independentReadback, true);
  assert.ok(journey.checks.some(c => c.name === 'turn2:independent_span_get' && c.passed));
});
