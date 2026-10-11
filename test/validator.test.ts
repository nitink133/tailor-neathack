import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, type ScenarioProposal, type ValidationCode } from '../src/agent-contract.ts';
import { travelProposalV1, travelProposalV2 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { fixtures } from '../src/clients/neatlogs/fixtures.ts';
import { datasetProblems, validateDataset, validateProposal } from '../src/clients/neatlogs/validator.ts';
import { fakeClock } from './helpers/backend.ts';

const SID = '0b7c4a52-3f1e-4d8a-9c6b-2e5f7a9d1c30';
const clock = fakeClock(Date.parse('2026-10-11T09:30:00.000Z'));
const base = () => fixtures(SID);
const v1 = () => structuredClone(travelProposalV1) as ScenarioProposal;

function codes(proposal: unknown, current = base()): ValidationCode[] {
  const r = validateProposal(SID, current, proposal, clock);
  assert.equal(r.ok, false, 'expected rejection');
  return r.ok ? [] : r.problems.map(p => p.code);
}
function rejects(code: ValidationCode, mutate: (p: any) => void, current = base()) {
  const p: any = v1(); mutate(p);
  assert.ok(codes(p, current).includes(code), `expected ${code}, got ${codes(p, current).join(',')}`);
}

test('regression fixtures pass the dataset validator for both active scenarios', () => {
  assert.deepEqual(datasetProblems(SID, fixtures(SID, 'recovered')), []);
  assert.deepEqual(datasetProblems(SID, fixtures(SID, 'exhausted')), []);
  assert.equal(validateDataset(SID, fixtures(SID)), true);
});

test('travel v1 (mode new) is accepted with code-derived IDs, normalisation and the server clock', () => {
  const r = validateProposal(SID, base(), travelProposalV1, clock);
  assert.ok(r.ok);
  assert.equal(r.dataset.activeScenario, 'booking-timeout-retry-ok');
  assert.equal(r.dataset.traces.length, 1, 'mode new replaces the fixture dataset');
  const t = r.dataset.traces[0]!;
  assert.equal(t.id, `${SID}-booking-timeout-retry-ok`);
  assert.equal(t.sessionId, SID);
  assert.equal(t.status, 'Ready');
  assert.equal(t.ingestedAt, '2026-10-11T09:30:00.000Z');
  assert.equal(t.spans.length, 7);
  assert.equal(t.spans[0]!.parentId, null, 'root first');
  assert.equal(t.spans[0]!.id, `${t.id}-root`);
  for (const s of t.spans.slice(1)) { assert.equal(s.parentId, `${t.id}-root`); assert.ok(s.id.startsWith(`${t.id}-`)); }
  assert.deepEqual(t.spans.map(s => s.startMs), [...t.spans.map(s => s.startMs)].sort((a, b) => a - b));
  assert.deepEqual(t.spans.filter(s => s.status === 'ERROR').map(s => s.id), [`${t.id}-attempt-1`]);
  assert.equal(validateDataset(SID, r.dataset), true, 'the produced dataset re-validates as a concrete dataset');
  assert.equal(JSON.stringify(r.dataset).includes('"version"'), false, 'dataset is version-independent');
});

test('travel v2 (mode edit) against the v1 dataset carries over the first trace and activates the second', () => {
  const first = validateProposal(SID, base(), travelProposalV1, clock);
  assert.ok(first.ok);
  const later = fakeClock(Date.parse('2026-10-11T09:45:00.000Z'));
  const second = validateProposal(SID, first.dataset, travelProposalV2, later);
  assert.ok(second.ok);
  assert.equal(second.dataset.activeScenario, 'booking-timeout-retry-fails');
  assert.deepEqual(second.dataset.traces.map(t => t.scenario), ['booking-timeout-retry-ok', 'booking-timeout-retry-fails']);
  assert.deepEqual(second.dataset.traces[0], first.dataset.traces[0], 'carried-over trace is unchanged (incl. ingestedAt)');
  const fails = second.dataset.traces[1]!;
  assert.equal(fails.ingestedAt, '2026-10-11T09:45:00.000Z');
  assert.deepEqual(fails.spans.filter(s => s.status === 'ERROR').map(s => s.id.slice(fails.id.length + 1)), ['attempt-1', 'attempt-2']);
  assert.equal(fails.spans.find(s => s.detection)?.id, `${fails.id}-attempt-2`);
  assert.equal(validateDataset(SID, second.dataset), true);
  const removed = validateProposal(SID, second.dataset, { ...structuredClone(travelProposalV2), expectedVersion: 3, removeTraceKeys: ['booking-timeout-retry-ok'], traces: [] }, clock);
  assert.ok(removed.ok);
  assert.deepEqual(removed.dataset.traces.map(t => t.scenario), ['booking-timeout-retry-fails']);
});

test('normalisation adds synthetic tags and SYNTHETIC prefixes without trusting the model', () => {
  const p: any = v1();
  const t = p.traces[0];
  t.tags = ['travel-booking']; t.name = 'travel-booking confirm'; t.spans[0].name = 'travel root';
  t.spans[3].error = 'booking API timed out';
  const r = validateProposal(SID, base(), p, clock);
  assert.ok(r.ok);
  const out = r.dataset.traces[0]!;
  assert.deepEqual(out.tags, ['synthetic', 'tailor-demo', 'travel-booking']);
  assert.equal(out.name, 'SYNTHETIC travel-booking confirm');
  assert.equal(out.spans[0]!.name, 'SYNTHETIC travel root');
  assert.equal(out.spans.find(s => s.status === 'ERROR')!.error, 'SYNTHETIC: booking API timed out');
});

test('schema and limit rejections', () => {
  assert.deepEqual(codes(null), ['SCHEMA']);
  rejects('SCHEMA', p => { p.kind = 'dataset'; });
  rejects('SCHEMA', p => { p.contractVersion = '1999-01-01.0'; });
  rejects('SCHEMA', p => { p.mode = 'replace'; });
  rejects('SCHEMA', p => { p.traces[0].key = 'Bad Key'; });
  rejects('SCHEMA', p => { p.traces[0].spans[1].key = '-bad'; });
  rejects('SCHEMA', p => { p.traces[0].spans[1].kind = 'HTTP'; });
  rejects('SCHEMA', p => { p.traces[0].outcomeKind = 'meh'; });
  rejects('SCHEMA', p => { p.traces[0].spans[1].detection = 'yes'; });
  rejects('SCHEMA', p => { p.traces[0].input = { bad: undefined, fn: () => 1 }; });
  rejects('SCHEMA', p => { p.story = { domain: '', summary: 'x', assumptions: [] }; });
  rejects('LIMIT', p => { p.traces = Array.from({ length: LIMITS.maxTracesPerDataset + 1 }, (_, i) => ({ ...structuredClone(travelProposalV1.traces[0]!), key: `t-${i}` })); });
  rejects('LIMIT', p => { const s = p.traces[0].spans[1]; p.traces[0].spans.push(...Array.from({ length: LIMITS.maxSpansPerTrace }, (_, i) => ({ ...s, key: `extra-${i}` }))); });
  rejects('LIMIT', p => { p.traces[0].spans[1].input = { blob: 'x'.repeat(LIMITS.maxSpanJsonBytes) }; });
  rejects('LIMIT', p => { p.traces[0].label = 'L'.repeat(LIMITS.maxLabelChars + 1); });
  rejects('LIMIT', p => { p.traces[0].name = 'N'.repeat(LIMITS.maxNameChars); });
  rejects('LIMIT', p => { p.traces[0].spans[3].error = 'E'.repeat(LIMITS.maxErrorChars + 1); });
  rejects('LIMIT', p => { p.traces[0].tags = ['a', 'b', 'c', 'd', 'e', 'f', 'g']; });
  rejects('LIMIT', p => { p.traces[0].tags = ['t'.repeat(LIMITS.maxTagChars + 1)]; });
  rejects('LIMIT', p => { p.traces[0].spans[0].durationMs = LIMITS.maxRootDurationMs + 1; });
  rejects('LIMIT', p => { p.story.assumptions = Array.from({ length: LIMITS.maxAssumptions + 1 }, (_, i) => `a${i}`); });
  rejects('LIMIT', p => { p.story.summary = 's'.repeat(LIMITS.maxStoryChars); });
  const huge: any = v1(); huge.traces[0].input = { blob: 'x'.repeat(600_000) };
  const oversize = validateProposal(SID, base(), huge, clock);
  assert.ok(!oversize.ok && oversize.problems.length === 1 && oversize.problems[0]!.code === 'LIMIT', 'oversize JSON proposal is rejected before deeper checks');
});

test('structural and coherence rejections', () => {
  rejects('DUPLICATE_KEY', p => { p.traces[0].spans[2].key = 'validate'; });
  rejects('DUPLICATE_KEY', p => { p.traces.push(structuredClone(p.traces[0])); });
  rejects('MISSING_ROOT', p => { p.traces[0].spans[0].parentKey = 'validate'; });
  rejects('MULTIPLE_ROOTS', p => { p.traces[0].spans[1].parentKey = null; });
  rejects('UNKNOWN_PARENT', p => { p.traces[0].spans[1].parentKey = 'ghost'; });
  rejects('CYCLE', p => { p.traces[0].spans[1].parentKey = 'plan'; p.traces[0].spans[2].parentKey = 'validate'; });
  rejects('CYCLE', p => { p.traces[0].spans[1].parentKey = 'validate'; });
  rejects('TIMING', p => { p.traces[0].spans[0].startMs = 5; });
  rejects('TIMING', p => { p.traces[0].spans[1].durationMs = 0; });
  rejects('TIMING', p => { p.traces[0].spans[6].durationMs = 500; });
  rejects('STATUS_ERROR_MISMATCH', p => { p.traces[0].spans[3].error = null; });
  rejects('STATUS_ERROR_MISMATCH', p => { p.traces[0].spans[1].error = 'oops'; });
  rejects('DETECTION_WITHOUT_ERROR', p => { p.traces[0].spans[1].detection = true; });
  rejects('OUTCOME_INCONSISTENT', p => { p.traces[0].outcomeKind = 'failure'; p.traces[0].spans[3].status = 'OK'; p.traces[0].spans[3].error = null; });
  rejects('OUTCOME_INCONSISTENT', p => { p.traces[0].spans[0].status = 'ERROR'; p.traces[0].spans[0].error = 'root failed'; });
  rejects('OUTPUT_MISMATCH', p => { p.traces[0].output = { outcome: 'different' }; });
  rejects('ACTIVE_SCENARIO_UNKNOWN', p => { p.activeScenario = 'not-there'; });
  rejects('SCHEMA', p => { p.mode = 'edit'; p.expectedVersion = 2; p.removeTraceKeys = ['never-existed']; });
});

test('executable content and arbitrary URLs are rejected anywhere in the proposal', () => {
  const samples = ['<script>alert(1)</script>', 'javascript:alert(1)', 'data:text/html,<b>x</b>', '```js\nboom()\n```', 'require("fs")', 'import("x")', 'eval(code)', 'child_process', 'process.env.SECRET', 'rm -rf /', 'echo $(whoami)'];
  for (const sample of samples) rejects('EXECUTABLE_CONTENT', p => { p.traces[0].spans[2].output = { note: sample }; });
  rejects('EXECUTABLE_CONTENT', p => { p.story.summary = 'Uses eval(input) to plan.'; });
  rejects('EXECUTABLE_CONTENT', p => { p.traces[0].input = { 'process.env.KEY': true }; });
  for (const url of ['https://api.neatlogs.com/v1', 'http://169.254.169.254/latest', 'ftp://files.partner.io/x', 'https://user@evil.com:8443/']) {
    rejects('ARBITRARY_URL', p => { p.traces[0].spans[3].input.endpoint = url; });
  }
  for (const ok of ['https://api.partner-hotels.example/v1', 'http://localhost:8080/health', 'https://svc.test/x', 'https://x.invalid', 'https://example.com/docs']) {
    const p: any = v1(); p.traces[0].spans[3].input.endpoint = ok;
    assert.ok(validateProposal(SID, base(), p, clock).ok, `fictional host accepted: ${ok}`);
  }
});

test('developer datasets: cross-session IDs, broken parents and altered coherence are rejected', () => {
  const other = fixtures('ffffffff-0000-4000-8000-000000000000');
  assert.equal(validateDataset(SID, other), false, 'another session’s dataset');
  const mixed = fixtures(SID); mixed.traces[1] = other.traces[1]!;
  assert.equal(validateDataset(SID, mixed), false, 'one foreign trace');
  const foreignSpan = fixtures(SID); foreignSpan.traces[0]!.spans[1]!.id = `${other.traces[0]!.id}-validate`;
  assert.equal(validateDataset(SID, foreignSpan), false, 'one foreign span id');
  const orphan = fixtures(SID); orphan.traces[0]!.spans[1]!.parentId = 'other-session';
  assert.ok(datasetProblems(SID, orphan).some(p => p.code === 'UNKNOWN_PARENT'));
  const status = fixtures(SID); status.traces[0]!.spans[2]!.error = null;
  assert.ok(datasetProblems(SID, status).some(p => p.code === 'STATUS_ERROR_MISMATCH'));
  const active = fixtures(SID); active.activeScenario = 'missing';
  assert.ok(datasetProblems(SID, active).some(p => p.code === 'ACTIVE_SCENARIO_UNKNOWN'));
  const url = fixtures(SID); (url.traces[0]!.spans[1]!.input as any).callback = 'https://attacker.io/x';
  assert.ok(datasetProblems(SID, url).some(p => p.code === 'ARBITRARY_URL'));
  assert.equal(validateDataset(SID, { activeScenario: 'recovered', traces: [] }), false);
  assert.equal(validateDataset(SID, 'nope'), false);
});
