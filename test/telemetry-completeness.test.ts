import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceObserver, compareEvidence } from '../src/tailor/evidence.ts';
import { createTelemetry } from '../src/infrastructure/telemetry.ts';

test('expectations survive a crash independently of observed events and can be restored', () => {
  let persisted = createEvidenceObserver().snapshot();
  const evidence = createEvidenceObserver({ onChange: s => { persisted = s; } });
  evidence.expect('turn'); evidence.expect('save'); evidence.expect('readback');
  evidence.observe('turn', 1, 'start', 'ok'); evidence.observe('save', 1, 'start', 'ok'); evidence.observe('save', 1, 'end', 'ok');
  evidence.interrupt('crashed');
  const resumed = createEvidenceObserver({ manifest: persisted });
  assert.deepEqual(compareEvidence(resumed.snapshot()).missing, ['turn:1:end', 'readback:1:start', 'readback:1:end']);
  assert.equal(compareEvidence(resumed.snapshot()).interruption, 'crashed');
  assert.equal(JSON.stringify(persisted).includes('buyer'), false);
});

test('independent expectations distinguish missing, duplicate, unexpected, failed and cancelled receipts', () => {
  const evidence = createEvidenceObserver();
  evidence.expect('model', 1); evidence.expect('repair', 1); evidence.expect('guard', 1);
  evidence.observe('model', 1, 'start', 'ok'); evidence.observe('model', 1, 'end', 'failed');
  evidence.observe('model', 1, 'end', 'failed'); evidence.observe('tool', 1, 'start', 'ok');
  evidence.observe('guard', 1, 'start', 'ok'); evidence.observe('guard', 1, 'end', 'cancelled');
  const result = compareEvidence(evidence.snapshot());
  assert.deepEqual(result.missing, ['repair:1:start', 'repair:1:end']);
  assert.deepEqual(result.duplicates, ['model:1:end']); assert.deepEqual(result.unexpected, ['tool:1:start']);
  assert.deepEqual(result.failed, ['model:1:end']); assert.deepEqual(result.cancelled, ['guard:1:end']);
  assert.equal(result.complete, false);
});

test('a malformed manifest cannot turn arbitrary buyer strings into persisted evidence', () => {
  assert.throws(() => createEvidenceObserver({ manifest: { version: 1, expected: [{ key: 'buyer prompt', operation: 'turn', ordinal: 1, phase: 'start' }], observed: [], interruption: null } }), /Invalid evidence/);
  assert.throws(() => createEvidenceObserver().expect('buyer prompt' as never), /Invalid evidence/);
});

test('native roots group turns by session while demo, HTTP request and logical turn references remain distinct', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'test-evidence-secret' });
  try {
    const handles = [];
    for (let n = 1; n <= 3; n++) {
      const handle = telemetry.forTurn(`turn-${n}`, 'browser-owner', { demoId: 'demo-one', requestId: `http-${n}`, clientTurnId: `client-${n}`, endUserId: 'buyer-opaque', codeVersion: 'build-1', adapterVersion: 'adapter-1', contractVersion: 'contract-1' });
      handle.evidence.expect('turn'); handle.evidence.expect('model');
      await handle.step('turn', {}, async () => { await handle.step('model', { purpose: 'plan' }, async () => { handle.recordUsage(null, null); }); return { outcome: 'answered', version: n }; });
      handles.push(handle);
    }
    const roots = telemetry.captured().filter(s => s.name === 'tailor.turn');
    assert.equal(roots.length, 3); assert.equal(new Set(roots.map(s => s.traceId)).size, 3);
    assert.equal(new Set(roots.map(s => s.attributes['neatlogs.session.id'])).size, 1);
    assert.equal(roots[0]!.attributes['neatlogs.session.id'], handles[0]!.correlationId);
    assert.equal(new Set(roots.map(s => s.attributes['tailor.demo_ref'])).size, 1);
    for (const key of ['tailor.turn_id', 'tailor.request_ref', 'tailor.client_turn_ref']) assert.equal(new Set(roots.map(s => s.attributes[key])).size, 3);
    assert.match(String(roots[0]!.attributes['neatlogs.end_user.id']), /^u[0-9a-f]{16}$/);
    assert.equal(roots[0]!.attributes['tailor.code_version'], 'build-1');
    assert.equal(telemetry.diagnostics().missingEvents, 0);
    assert.ok(telemetry.diagnostics().recentTurns.every(t => t.completeness?.complete));
    const flush = await telemetry.flush(); assert.equal(flush.ok, true); assert.equal(flush.receiptState, 'unverified');
    assert.equal(telemetry.diagnostics().receiptState, 'unverified');
    const dump = JSON.stringify(telemetry.captured());
    for (const id of ['browser-owner', 'demo-one', 'buyer-opaque', 'http-1', 'client-1']) assert.equal(dump.includes(id), false);
  } finally { await telemetry.shutdown(); }
});

test('provider failures retain safe settlement/usage attributes and guard outcomes prevent dispatch', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'test-settlement-secret' });
  try {
    const handle = telemetry.forTurn('turn-failure', 'owner');
    handle.declare({ policyVersions: ['policy-1'], modelIds: ['guard-model-1'] });
    handle.evidence.expect('turn'); handle.evidence.expect('guard'); handle.evidence.expect('model');
    await handle.step('turn', {}, async () => {
      await handle.step('guard', { policyVersion: 'policy-1', policyOutcome: 'deny_instruction_override', policyReason: 'instruction_override', preventedDispatch: true, guardModel: 'guard-model-1' }, async () => null);
      await assert.rejects(handle.step('model', {}, async () => {
        handle.recordUsage({ inputTokens: 7, outputTokens: 9, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 }, 'claude-sonnet-5-5');
        handle.annotate({ reservationRef: '8c82c2af-2c59-4fef-baa9-2aaad219c002', settlement: 'settled_reported', pricingVersion: 'tailor-rates-2026-10-12.1', costUsd: 0.001, reservationUsd: 0.2, latencyMs: 15, systemBytes: 4, schemaBytes: 10, framingTokens: 600, estimationVersion: 'utf8-conservative-v1' });
        throw new Error('private buyer response');
      }));
    });
    const spans = telemetry.captured(); const model = spans.find(s => s.name === 'model')!;
    assert.equal(model.attributes['tailor.usage.input_tokens'], 7); assert.equal(model.attributes['tailor.settlement'], 'settled_reported');
    assert.match(String(model.attributes['tailor.reservation_ref']), /^z[0-9a-f]{16}$/);
    assert.equal(model.attributes['tailor.system_bytes'], 4); assert.equal(model.attributes['tailor.pricing_version'], 'tailor-rates-2026-10-12.1');
    assert.equal(spans.find(s => s.name === 'guard')!.attributes['tailor.prevented_dispatch'], true);
    assert.deepEqual(telemetry.diagnostics().recentTurns[0]!.completeness?.failed, ['model:1:end']);
    assert.equal(JSON.stringify(spans).includes('private buyer response'), false);
  } finally { await telemetry.shutdown(); }
});

test('disabled recording preserves independent expectations and explicitly reports missing observations', async () => {
  const telemetry = await createTelemetry({ mode: 'disabled', secret: 'disabled-evidence-secret' });
  let persisted;
  const handle = telemetry.forTurn('turn-disabled', 'owner', { onEvidence: s => { persisted = s; } });
  handle.evidence.expect('turn'); await handle.step('turn', {}, async () => 1);
  assert.ok(persisted); assert.deepEqual(handle.evidence.snapshot().observed, []);
  assert.deepEqual(compareEvidence(handle.evidence.snapshot()).missing, ['turn:1:start', 'turn:1:end']);
});


test('fixed clarification after guard-provider failure and rolled-back save each record a failed receipt', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'fixed-outcome-failure-secret' });
  try {
    const tt = telemetry.forTurn('fixed-failure', 'owner');
    tt.evidence.expect('turn'); tt.evidence.expect('guard'); tt.evidence.expect('save');
    await tt.step('turn', {}, async () => {
      const gate = await tt.step('guard', {}, async () => {
        tt.annotate({ attemptResult: 'error', providerErrorKind: 'timeout', policyOutcome: 'clarify', policyReason: 'guard_unavailable', preventedDispatch: true });
        return { kind: 'ask' };
      });
      assert.equal(gate.kind, 'ask');
      const save = await tt.step('save', {}, async () => ({ state: 'save_failed' }));
      assert.equal(save.state, 'save_failed');
    });
    assert.deepEqual(telemetry.diagnostics().recentTurns[0]!.completeness?.failed, ['guard:1:end', 'save:1:end']);
    assert.equal(telemetry.diagnostics().recentTurns[0]!.completeness?.complete, true, 'failure evidence is complete and does not imply success');
  } finally { await telemetry.shutdown(); }
});

test('context trimming counts and actual readback result events remain allowlisted', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'context-metrics-secret' });
  try {
    const tt = telemetry.forTurn('context-metrics', 'owner'); tt.evidence.expect('turn'); tt.evidence.expect('context');
    await tt.step('turn', {}, async () => {
      await tt.step('context', { contextBudgetChars: 40, contextChars: 30, contextRecentTurnsKept: 2, contextRecentTurnsDropped: 3, contextPayloadsDropped: 1, contextKnowledgeRecordsKept: 4 }, async () => null);
      tt.event('readback.result', { state: 'committed', version: 2, latencyMs: 1, evidenceOrdinal: 1 });
    });
    assert.equal(telemetry.diagnostics().droppedAttributes, 0);
    const root = telemetry.captured().find(s => s.name === 'tailor.turn')!;
    assert.equal(root.events.find(e => e.name === 'tailor.readback.result')!.attributes['tailor.version'], 2);
    assert.equal(telemetry.captured().find(s => s.name === 'context')!.attributes['tailor.context_recent_turns_dropped'], 3);
  } finally { await telemetry.shutdown(); }
});
