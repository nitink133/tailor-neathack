import assert from 'node:assert/strict';
import test from 'node:test';
import { composeAnswer } from '../src/clients/neatlogs/answer.ts';
import { describeCommit } from '../src/clients/neatlogs/explain.ts';
import type { ReadbackEvidence } from '../src/clients/neatlogs/agent-contract.ts';
import type { Trace } from '../src/clients/neatlogs/contracts.ts';
import { FAKE_RECORDS } from './helpers/agent.ts';

test('capability sections preserve behavior, limits, prerequisites and metadata while filtering invented lead claims', () => {
  const record = { ...FAKE_RECORDS[0]!, prerequisites: ['An instrumented agent'], sources: [{ url: 'https://docs.example.org/traces', verifiedOn: '2026-10-10', claim: 'trace details' }] };
  const pricing = FAKE_RECORDS.find(r => r.id === 'pricing')!;
  const text = composeAnswer([record, pricing], 'How much does it cost?', 'Neatlogs Pro costs $49 and provides SSO.', 'test-1');
  assert.ok(text.startsWith(`1. ${record.title}\n${record.behaviour}`));
  assert.ok(text.includes('\n- Limits: Synthetic data only in this demo.\n- You’d need: An instrumented agent.\n- In this demo'));
  assert.ok(text.includes(`\n\n2. ${pricing.title}\n${pricing.behaviour}`));
  assert.ok(text.includes('\n\nSources: Trace detail and spans (verified 2026-10-10); Pricing and plans; knowledge version test-1.\n\n'));
  assert.ok(text.includes('\n\nI don’t have verified prices, so I won’t quote any.\n\n'));
  assert.match(text.split('\n').at(-1)!, /^Plan availability for Pricing and plans: unknown\./);
  assert.doesNotMatch(text, /\$49|SSO|https?:\/\//);
});

test('capability without limits or prerequisites omits those bullets and keeps its supported demo boundary', () => {
  const record = FAKE_RECORDS.find(r => r.id === 'alerts')!;
  const text = composeAnswer([record], 'Tell me about alerts', '', 'test-1');
  assert.ok(text.startsWith(`1. ${record.title}\n${record.behaviour}`));
  assert.doesNotMatch(text, /Limits:|You’d need:/);
  assert.ok(text.includes('\n- In this demo Alerts and notifications is view-only: I can describe it but not run it.'));
});

const trace: Trace = {
  id: 'saved-trace', sessionId: 'owned-demo', scenario: 'recovered', label: 'Retry recovers', name: 'Synthetic support', ingestedAt: '', status: 'Ready', outcome: 'resolved', outcomeKind: 'success', tags: [], input: {}, output: {},
  spans: [
    { id: 'saved-root', parentId: null, name: 'support', kind: 'WORKFLOW', startMs: 0, durationMs: 3000, status: 'OK', input: {}, output: {}, error: null, detection: false },
    { id: 'saved-error', parentId: 'saved-root', name: 'lookup_attempt_1', kind: 'TOOL', startMs: 10, durationMs: 1500, status: 'ERROR', input: {}, output: {}, error: 'SYNTHETIC: timed out', detection: true },
  ],
};
const readback: ReadbackEvidence = { version: 4, activeScenario: trace.scenario, traceIds: [trace.id], spanIds: trace.spans.map(s => s.id), traces: [{ id: trace.id, key: trace.scenario, label: trace.label, outcome: trace.outcome, outcomeKind: trace.outcomeKind, spanCount: 2, rootDurationMs: 3000, errorSpanIds: ['saved-error'] }] };

test('commit reply keeps verified version first, separates actual run/failure/narrative facts and retains evidence IDs', () => {
  const narrative = 'lookup_attempt_1 timed out after 1500 ms.';
  const reply = describeCommit(readback, trace, narrative);
  assert.ok(reply.text.startsWith('Saved and verified as version 4.\n\n1. Review the run\n'));
  assert.ok(reply.text.includes('“Retry recovers” runs 3000 ms end to end across 2 steps and ends as resolved.'));
  assert.ok(reply.text.includes('\n\n2. Inspect failed steps\n1 step failed: lookup_attempt_1 (SYNTHETIC: timed out).'));
  assert.ok(reply.text.endsWith(`\n\n3. Read the saved evidence\n${narrative}`));
  assert.deepEqual(reply.evidence, { version: 4, traceIds: ['saved-trace'], spanIds: ['saved-error'] });
});

test('missing detail or empty readback preserves uncertainty about names and never invents run facts', () => {
  const missing = describeCommit(readback, null, '');
  assert.ok(missing.text.includes('1 step ended in an error (names could not be read back just now).'));
  assert.doesNotMatch(missing.text, /lookup_attempt_1|3\. Read/);
  assert.deepEqual(missing.evidence.spanIds, ['saved-error']);
  const empty = describeCommit({ ...readback, traces: [] }, null, '');
  assert.equal(empty.text, 'Saved and verified as version 4.');
  assert.deepEqual(empty.evidence, { version: 4, traceIds: ['saved-trace'], spanIds: ['saved-root', 'saved-error'] });
});
