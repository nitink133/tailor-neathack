import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry, createSpanMask, telemetryVocabulary } from '../src/infrastructure/telemetry.ts';
import { RUNTIME_PROJECT_ID, FORBIDDEN_PROJECT_ID, verifyHostedTrace, verifyProjectIdentity, readAndVerifyHostedTrace } from '../src/infrastructure/hosted-verification.ts';

async function fixture() {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'hosted-verifier-fake-secret', versions: { codeVersion: '17963acb6f7302384d278835697fefbd3ae6878c', adapterVersion: 'adapter-1', contractVersion: 'contract-1' } });
  const tt = telemetry.forTurn('turn-one', 'owner', { demoId: 'demo-one', requestId: 'request-one' });
  tt.evidence.expect('turn'); tt.evidence.expect('model');
  await tt.step('turn', {}, async () => { await tt.step('model', { purpose: 'plan' }, async () => null); return { outcome: 'answered', version: 1 }; });
  const captured = telemetry.captured(); const root = captured.find(s => s.name === 'tailor.turn')!;
  const body = { _id: root.traceId, projectId: RUNTIME_PROJECT_ID, spans: captured };
  const expected = { traceId: root.traceId, sessionId: tt.correlationId, turnRef: tt.turnRef, demoRef: tt.demoRef, requestRef: tt.requestRef, manifest: tt.evidence.snapshot(), outcome: 'answered', version: 1, requiredRootAttributes: ['tailor.code_version', 'tailor.adapter_version', 'tailor.contract_version'] };
  await telemetry.shutdown(); return { body, expected };
}

test('hosted verification requires independent received evidence; export success alone remains unverified', async () => {
  const { body, expected } = await fixture();
  assert.equal(verifyProjectIdentity(body), true);
  const verified = await readAndVerifyHostedTrace(async traceId => { assert.equal(traceId, expected.traceId); return body; }, expected);
  assert.equal(verified.ok, true, JSON.stringify(verified)); assert.equal(verified.receiptState, 'received_verified');
  assert.equal(verifyHostedTrace({ ...body, spans: [] }, expected).receiptState, 'unverified');
});

test('sandbox and unknown project identities are rejected before export', async () => {
  const { body, expected } = await fixture();
  for (const projectId of [FORBIDDEN_PROJECT_ID, 'unknown', undefined]) {
    const wrong = { ...body, projectId }; assert.equal(verifyProjectIdentity(wrong), false); assert.equal(verifyHostedTrace(wrong, expected).ok, false);
  }
});

test('missing retry/refusal events, duplicate roots, wrong sessions and detached spans cannot pass', async () => {
  const { body, expected } = await fixture();
  const missing = structuredClone(body); missing.spans.find(s => s.name === 'model')!.events = [];
  const incomplete = verifyHostedTrace(missing, expected);
  assert.equal(incomplete.ok, false); assert.deepEqual(incomplete.completeness.missing, ['model:1:start', 'model:1:end']);
  const duplicate = structuredClone(body); duplicate.spans.push(duplicate.spans.find(s => s.name === 'tailor.turn')!);
  assert.ok(verifyHostedTrace(duplicate, expected).issues.includes('turn_root_count'));
  const wrongSession = structuredClone(body); wrongSession.spans.find(s => s.name === 'tailor.turn')!.attributes['neatlogs.session.id'] = 'wrong';
  assert.ok(verifyHostedTrace(wrongSession, expected).issues.includes('session_mismatch'));
  const detached = structuredClone(body); detached.spans.find(s => s.name === 'model')!.parentSpanId = 'not-present';
  assert.ok(verifyHostedTrace(detached, expected).issues.includes('span_parentage'));
});

test('hosted attributes reject raw buyer payloads and credentials while declared code SHA remains valid', async () => {
  const { body, expected } = await fixture();
  const payload = structuredClone(body); payload.spans[0]!.attributes['input.value'] = 'private buyer text';
  assert.ok(verifyHostedTrace(payload, expected).issues.includes('payload_attribute'));
  const secret = structuredClone(body); secret.spans[0]!.attributes['tailor.unsafe'] = 'sk-ant-fake-secret';
  assert.ok(verifyHostedTrace(secret, expected).issues.includes('sensitive_attribute'));
  assert.equal(verifyHostedTrace(body, expected).ok, true);
});

test('hosted node projection verifies mirrored metadata evidence without raw attrs/events', async () => {
  const { body, expected } = await fixture();
  const mask = createSpanMask(telemetryVocabulary({ codeVersions: ['17963acb6f7302384d278835697fefbd3ae6878c'], adapterVersions: ['adapter-1'], contractVersions: ['contract-1'] }), { hostedFields: true });
  const spans = await Promise.all(body.spans.map(async span => {
    const mapped = await mask(span as any) as any;
    return { node_name: span.name, span_id: span.spanId, parent_span_id: span.parentSpanId, span_metadata: JSON.parse(mapped.attributes['neatlogs.metadata']) };
  }));
  const projected = { ...body, spans };
  assert.equal(verifyHostedTrace(projected, expected).ok, true, JSON.stringify(verifyHostedTrace(projected, expected)));
  const bad = structuredClone(projected); bad.spans[0].span_metadata.tailor.attributes['tailor.hidden'] = 'private buyer prompt';
  assert.ok(verifyHostedTrace(bad, expected).issues.includes('unsafe_metadata'));
  const missing = structuredClone(projected); missing.spans[0].span_metadata.tailor.events = [];
  assert.equal(verifyHostedTrace(missing, expected).ok, false);
});
test('received synthetic fixture text requires explicit exact expected text', async () => {
  const { body, expected } = await fixture();
  const root = body.spans.find(span => span.name === 'tailor.turn')!;
  root.attributes['tailor.synthetic'] = true;
  const spans = body.spans.map(span => ({ ...span, span_metadata: span === root ? { synthetic: { input: 'SYNTHETIC: fictional request', output: 'SYNTHETIC: fictional answer' } } : undefined }));
  const projected = { ...body, spans };
  assert.ok(verifyHostedTrace(projected, expected).issues.includes('unexpected_synthetic_payload'));
  assert.equal(verifyHostedTrace(projected, { ...expected, synthetic: { input: 'SYNTHETIC: fictional request', output: 'SYNTHETIC: fictional answer' } }).ok, true);
  assert.ok(verifyHostedTrace(projected, { ...expected, synthetic: { input: 'different approved fixture' } }).issues.includes('synthetic_input_mismatch'));
});
