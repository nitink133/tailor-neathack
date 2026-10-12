import { Store } from '../src/infrastructure/store.ts';
import { createSessionTools } from '../src/clients/neatlogs/session-tools.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { createMockProvider } from '../src/clients/neatlogs/mock-provider.ts';
import { stubTools, fakeKnowledge, fixedClock, SESSION_ID } from './helpers/agent.ts';
import { travelBuyerTurn1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry, createSpanMask, telemetryVocabulary, parseNativeDiagnosticEnvelope } from '../src/infrastructure/telemetry.ts';
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

test('native diagnostic fallback reconstructs observed child evidence and exact approved text', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'fake-native-secret', syntheticPayloads: true });
  const tt = telemetry.forTurn('native-turn', 'native-owner', { synthetic: true });
  tt.evidence.expect('turn'); tt.evidence.expect('model');
  await tt.step('turn', {}, async () => {
    await tt.step('model', { provider: 'anthropic', model: 'claude-sonnet-5-5' }, async () => { tt.recordUsage({ inputTokens: 4, outputTokens: 2 }, 'claude-sonnet-5-5'); return null; });
    tt.attachSynthetic({ input: 'SYNTHETIC: fictional question', output: 'SYNTHETIC: fictional response' });
    return { outcome: 'answered', version: 1 };
  });
  const captured = telemetry.captured(); const root = captured.find(span => span.name === 'tailor.turn')!;
  const mask = createSpanMask(telemetryVocabulary({ modelIds: ['claude-sonnet-5-5'] }), { hostedFields: true, syntheticPayloads: true });
  const projected = [];
  for (const span of captured) {
    const mapped = await mask(span as any) as any;
    projected.push({ node_name: span.name, span_id: span.spanId, parent_span_id: span.parentSpanId,
      span_metadata: { 'session.id': tt.correlationId }, data: { input: mapped.attributes['neatlogs.input.value'], output: mapped.attributes['neatlogs.output.value'] } });
  }
  const output = parseNativeDiagnosticEnvelope(projected.find(span => span.node_name === 'tailor.turn')!.data.output)! as any;
  assert.equal(output.diagnostics.steps.length, 1);
  assert.equal(output.diagnostics.steps[0].attributes['tailor.usage.input_tokens'], 4);
  assert.equal(output.diagnostics.truncated, false);
  const expected = { traceId: root.traceId, sessionId: tt.correlationId, turnRef: tt.turnRef, demoRef: tt.demoRef, requestRef: tt.requestRef,
    manifest: tt.evidence.snapshot(), outcome: 'answered', version: 1, nativeDiagnostics: true,
    synthetic: { input: 'SYNTHETIC: fictional question', output: 'SYNTHETIC: fictional response' } };
  const body = { _id: root.traceId, projectId: RUNTIME_PROJECT_ID, spans: projected };
  assert.equal(verifyHostedTrace(body, expected).ok, true, JSON.stringify(verifyHostedTrace(body, expected)));
  const missing = structuredClone(body); const r = missing.spans.find(span => span.node_name === 'tailor.turn')!;
  const tampered = parseNativeDiagnosticEnvelope(r.data.output)! as any; tampered.diagnostics.steps = []; r.data.output = JSON.stringify(tampered);
  assert.equal(verifyHostedTrace(missing, expected).ok, false);
  await telemetry.shutdown();
});

test('full mock proposal diagnostics retain save/readback/response within native bound', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'fake-full-native-secret', syntheticPayloads: true });
  const store = new Store(':memory:', { clock: fixedClock });
  const session = store.create('SYNTHETIC: fictional travel agent', undefined, 'full-native-create');
  const tt = telemetry.forTurn('full-native-turn', session.id, { synthetic: true });
  const tools = createSessionTools(store, session.id, fixedClock, tt);
  tt.evidence.expect('turn');
  const result = await tt.step('turn', {}, async () => {
    const result = await createAgentService().handleTurn({ session: await tools.readSession(), request: { text: travelBuyerTurn1.text, clientTurnId: 'full-native' },
      tools, knowledge: fakeKnowledge(), clock: fixedClock, telemetry: tt, provider: createMockProvider() });
    tt.attachSynthetic({ input: travelBuyerTurn1.text, output: result.messages.map(m => m.text).join('\n') });
    return result;
  });
  assert.equal(result.outcome, 'committed');
  const mask = createSpanMask(telemetryVocabulary({ adapterIds: ['neatlogs'], toolNames: ['publishScenario','explainTrace'], promptVersions: ['neatlogs-prompts-2026-10-12.3'], knowledgeVersions: [fakeKnowledge().version] }), { hostedFields: true, syntheticPayloads: true });
  let native = '';
  for (const span of telemetry.captured()) {
    const mapped = await mask(span as any) as any;
    if (span.name === 'tailor.turn') native = mapped.attributes['neatlogs.output.value'];
  }
  assert.ok(native.length <= 24_000);
  const envelope = parseNativeDiagnosticEnvelope(native)! as any;
  assert.equal(envelope.diagnostics.truncated, false, `native size ${native.length}`);
  const steps = envelope.diagnostics.steps.map((step: any) => step.step);
  for (const step of ['context','guard','load_context','retrieve_knowledge','model','save']) assert.ok(steps.includes(step), `${step} observed`);
  const receipts = [envelope.diagnostics.root, ...envelope.diagnostics.steps].flatMap(record => record.receipts);
  for (const operation of ['save','readback','response']) assert.ok(receipts.some((receipt: any) => receipt[0].startsWith(`${operation}:`)), `${operation} receipt observed`);
  assert.equal(receipts.some((receipt: any) => receipt[0].startsWith('validate:')), false, 'normal publish validates inside save; do not invent a separate observed validation step');
  store.close();
  await telemetry.shutdown();
});
