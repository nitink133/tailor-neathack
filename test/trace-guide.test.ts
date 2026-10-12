import assert from 'node:assert/strict';
import test from 'node:test';
import { traceGuideFacts, recommendedTrace, selectedSpanAncestors } from '../src/clients/neatlogs/trace-guide.ts';
import type { Span, Trace } from '../src/clients/neatlogs/contracts.ts';

const span = (id: string, status: Span['status'] = 'OK', detection = false, parentId: string | null = 'root'): Span => ({ id, parentId, name: id, kind: 'TOOL', startMs: 0, durationMs: 1, status, detection, input: {}, output: {}, error: null });
const trace = (id: string, spans: Span[], output: Trace['output'] = {}): Trace => ({ id, sessionId: 'owned', scenario: id, label: id, name: id, ingestedAt: '', status: 'Ready', outcome: 'task_succeeded', outcomeKind: 'success', tags: [], input: {}, output, spans });

test('guide counts stored errors separately from detections and Ready/task success', () => {
  const t = trace('recovered', [span('root', 'OK', false, null), span('failed-attempt', 'ERROR'), span('flagged', 'OK', true)]);
  const facts = traceGuideFacts(t);
  assert.equal(facts.steps, 3);
  assert.equal(facts.stepErrors, 1);
  assert.equal(facts.detections, 1);
  assert.equal(facts.recommendedSpan?.id, 'failed-attempt');
  assert.equal(facts.outputSummary, 'Open to inspect output');
});

test('guide uses actual output only, with bounded preview and root fallback', () => {
  const t = trace('clean', [span('child'), span('root', 'OK', false, null)], { outcome: 'resolved' });
  assert.equal(traceGuideFacts(t).recommendedSpan?.id, 'root');
  assert.equal(traceGuideFacts(t).outputSummary, 'Reported outcome: resolved');
  for (const output of [null, [], 'resolved', { outcome: 123 }, { outcome: ' ' }]) assert.equal(traceGuideFacts({ ...t, output }).outputSummary, 'Open to inspect output');
  assert.ok(traceGuideFacts({ ...t, output: { outcome: 'x'.repeat(200) } }).outputSummary.length < 120);
  assert.equal(traceGuideFacts(trace('empty', [])).recommendedSpan, undefined);
});

test('recommendation stays within filtered results, preferring an actual error then active trace', () => {
  const clean = trace('clean', [span('root', 'OK', false, null)]);
  const active = trace('active', [span('root', 'OK', false, null)]);
  const failed = trace('failed', [span('actual-error', 'ERROR')]);
  assert.equal(recommendedTrace([clean, active, failed], active.scenario), failed);
  assert.equal(recommendedTrace([clean, active], active.scenario), active);
  assert.equal(recommendedTrace([clean], 'filtered-out'), clean);
  assert.equal(recommendedTrace([], active.scenario), undefined);
});

test('selected-step reveal follows only its stored ancestor path, leaving unrelated roots untouched', () => {
  const t = trace('nested', [span('root-a', 'OK', false, null), span('parent', 'OK', false, 'root-a'), span('selected-error', 'ERROR', false, 'parent'), span('root-b', 'OK', false, null)]);
  assert.deepEqual(selectedSpanAncestors(t, 'selected-error'), ['parent', 'root-a']);
  assert.deepEqual(selectedSpanAncestors(t, 'root-a'), []);
  assert.deepEqual(selectedSpanAncestors(t, 'not-saved'), []);
});

test('selected-step ancestor walk stops at missing parents and cycles', () => {
  assert.deepEqual(selectedSpanAncestors(trace('missing', [span('selected', 'ERROR', false, 'missing-root')]), 'selected'), []);
  const cyclic = trace('cyclic', [span('selected', 'ERROR', false, 'parent'), span('parent', 'OK', false, 'selected')]);
  assert.deepEqual(selectedSpanAncestors(cyclic, 'selected'), ['parent']);
});
