// Contract snapshot checks (NIT-270). Network-free, model-free. These assert the frozen examples are
// internally coherent so backend/agent/QA lanes can rely on them. The full validator lives in NIT-273.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION, LIMITS, SCENARIO_KEY_PATTERN, SPAN_KEY_PATTERN, FICTIONAL_HOST_PATTERN, type ScenarioProposal } from '../src/agent-contract.ts';
import { travelProposalV1, travelProposalV2, nonProposalRequests, travelBuyerTurn1, travelBuyerTurn2 } from '../src/examples/travel-booking.ts';
import { fixtures } from '../src/fixtures.ts';

function coherent(p: ScenarioProposal) {
  assert.equal(p.kind, 'scenario_proposal');
  assert.equal(p.contractVersion, CONTRACT_VERSION);
  assert.ok(p.traces.length >= 1 && p.traces.length <= LIMITS.maxTracesPerDataset);
  assert.ok(p.traces.some(t => t.key === p.activeScenario), 'activeScenario must name a proposed trace');
  assert.ok(p.story.assumptions.length <= LIMITS.maxAssumptions);
  for (const t of p.traces) {
    assert.match(t.key, SCENARIO_KEY_PATTERN);
    assert.ok(t.spans.length >= 1 && t.spans.length <= LIMITS.maxSpansPerTrace);
    assert.ok(t.label.length <= LIMITS.maxLabelChars);
    const roots = t.spans.filter(s => s.parentKey === null);
    assert.equal(roots.length, 1, 'exactly one root');
    const root = roots[0]!;
    assert.equal(root.startMs, 0);
    assert.deepEqual(root.output, t.output, 'root output equals trace output');
    const keys = new Set<string>();
    for (const s of t.spans) {
      assert.match(s.key, SPAN_KEY_PATTERN);
      assert.ok(!keys.has(s.key), `duplicate span key ${s.key}`); keys.add(s.key);
      if (s.parentKey) {
        const parent = t.spans.find(x => x.key === s.parentKey);
        assert.ok(parent, `parent ${s.parentKey} exists`);
        assert.ok(s.startMs >= parent.startMs && s.startMs + s.durationMs <= parent.startMs + parent.durationMs, `span ${s.key} inside parent timing`);
      }
      assert.ok(s.durationMs > 0 && s.startMs >= 0);
      assert.equal(s.status === 'ERROR', s.error !== null, 'ERROR iff error text');
      if (s.detection) assert.equal(s.status, 'ERROR', 'detections only on ERROR spans');
      assert.ok(Buffer.byteLength(JSON.stringify({ input: s.input, output: s.output })) <= LIMITS.maxSpanJsonBytes);
      for (const url of JSON.stringify(s).match(/https?:\/\/([^/"\s]+)/g) ?? []) {
        assert.match(new URL(url).hostname, FICTIONAL_HOST_PATTERN, `fictional host only: ${url}`);
      }
    }
    const errors = t.spans.filter(s => s.status === 'ERROR').length;
    if (t.outcomeKind === 'failure' || t.outcomeKind === 'escalation') assert.ok(errors >= 1, 'failure/escalation needs an ERROR span');
    assert.ok(t.tags.includes('synthetic'));
    assert.ok(t.name.startsWith('SYNTHETIC '));
  }
}

test('contract examples: travel-booking v1 (timeout, retry ok) and v2 edit (retry fails, escalate) are coherent', () => {
  coherent(travelProposalV1);
  coherent(travelProposalV2);
  assert.equal(travelProposalV1.mode, 'new');
  assert.equal(travelProposalV1.expectedVersion, 1);
  assert.equal(travelProposalV2.mode, 'edit');
  assert.equal(travelProposalV2.expectedVersion, 2, 'follow-up is built against the accepted version');
  assert.equal(travelProposalV2.story.domain, travelProposalV1.story.domain, 'story preserved across the follow-up');
  const v1 = travelProposalV1.traces[0]!; const v2 = travelProposalV2.traces[0]!;
  assert.equal(v1.spans.filter(s => s.status === 'ERROR').length, 1);
  assert.equal(v2.spans.filter(s => s.status === 'ERROR').length, 2);
  assert.equal(v2.outcomeKind, 'escalation');
  assert.ok(v2.spans.some(s => s.detection), 'exhausted retry is surfaced as a detection');
  assert.match(travelBuyerTurn1.text, /travel-booking/);
  assert.match(travelBuyerTurn2.text, /retry fail/);
  for (const r of Object.values(nonProposalRequests)) assert.match(r.clientTurnId, /^[0-9a-f-]{36}$/);
});

test('regression fixtures carry the generalised fields (label, outcomeKind) and stay coherent', () => {
  const d = fixtures('session-x');
  assert.equal(d.traces.length, 2);
  for (const t of d.traces) {
    assert.ok(t.label && ['success', 'escalation'].includes(t.outcomeKind));
    assert.equal(t.spans.filter(s => s.parentId === null).length, 1);
  }
});

test('limits are finite and lifecycle constants match the agreed policy', () => {
  assert.equal(LIMITS.idleMs, 60 * 60 * 1000);
  assert.equal(LIMITS.lifetimeMs, 4 * 60 * 60 * 1000);
  for (const [k, v] of Object.entries(LIMITS)) assert.ok(Number.isFinite(v) && v > 0, `${k} finite`);
});
