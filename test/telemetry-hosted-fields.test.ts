import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpanMask, telemetryVocabulary, parseNativeDiagnosticEnvelope, createTelemetry } from '../src/infrastructure/telemetry.ts';

const mask = createSpanMask(telemetryVocabulary({ modelIds: ['claude-sonnet-5-5'] }), { hostedFields: true });
const run = async (attributes: Record<string, unknown>, events: unknown[] = []) => await mask({ attributes, events } as any) as any;
test('hosted field mapping preserves reported model/usage and redacted evidence', async () => {
  const attrs = { 'tailor.step': 'model', 'tailor.model': 'claude-sonnet-5-5', 'tailor.provider': 'anthropic', 'tailor.usage.available': true,
    'tailor.usage.input_tokens': 19, 'tailor.usage.output_tokens': 7, 'tailor.usage.cache_read_input_tokens': 4, 'tailor.version': 2 };
  const events = [{ name: 'tailor.provider_latency', attributes: { 'tailor.latency_ms': 5 } }];
  const out = await run(attrs, events);
  assert.equal(out.attributes['neatlogs.llm.model_name'], 'claude-sonnet-5-5');
  assert.equal(out.attributes['neatlogs.span.kind'], 'llm');
  assert.equal(out.attributes['neatlogs.llm.provider'], 'anthropic');
  assert.equal(out.attributes['neatlogs.llm.token_count.prompt'], 19);
  assert.equal(out.attributes['neatlogs.llm.token_count.completion'], 7);
  assert.equal(out.attributes['neatlogs.llm.token_count.total'], 26);
  assert.equal(out.attributes['neatlogs.llm.token_count.cache_read'], 4);
  assert.equal(out.attributes['neatlogs.llm.token_count.reasoning'], undefined);
  for (const [key,value] of Object.entries(attrs)) assert.equal(out.attributes[key], value);
  assert.deepEqual(out.events, events);
  assert.deepEqual(JSON.parse(out.attributes['neatlogs.metadata']), { tailor: { attributes: attrs, events }, sdk: { 'neatlogs.span.kind': 'llm' } });
});
test('hosted metadata is rebuilt from strict validators and never accepts inbound payloads', async () => {
  const buyer = 'Please diagnose my private customer workflow';
  const secret = 'sk-ant-test-private-key';
  const out = await run({ 'neatlogs.metadata': JSON.stringify({ buyer, secret }), 'tailor.version': 1,
    'tailor.model': secret, 'tailor.provider': buyer, 'tailor.anything': buyer, 'tailor.cookie': secret,
    'tailor.synthetic_input': buyer, 'neatlogs.llm.token_count.prompt': buyer }, [
    { name: 'tailor.provider_error', attributes: { 'tailor.reason': 'auth', 'tailor.text': buyer, 'tailor.cookie': secret } },
    { name: 'tailor.' + buyer, attributes: { 'tailor.version': 1 } },
  ]);
  const metadata = JSON.parse(out.attributes['neatlogs.metadata']);
  assert.deepEqual(metadata, { tailor: { attributes: { 'tailor.version': 1 }, events: [{ name: 'tailor.provider_error', attributes: { 'tailor.reason': 'auth' } }] } });
  assert.equal(JSON.stringify(metadata).includes(buyer), false);
  assert.equal(JSON.stringify(out.attributes).includes(secret), false);
  assert.equal(out.attributes['neatlogs.llm.token_count.prompt'], undefined);
});
test('unavailable usage remains absent and malformed SDK model/provider/counts are denied', async () => {
  const out = await run({ 'tailor.usage.available': false, 'neatlogs.llm.model_name': 'unapproved-model',
    'neatlogs.llm.provider': 'free text', 'neatlogs.llm.token_count.completion': -1 });
  assert.equal(out.attributes['neatlogs.llm.model_name'], undefined);
  assert.equal(out.attributes['neatlogs.llm.provider'], undefined);
  assert.equal(out.attributes['neatlogs.llm.token_count.prompt'], undefined);
  assert.equal(out.attributes['neatlogs.llm.token_count.total'], undefined);
  assert.equal(out.attributes['neatlogs.llm.token_count.completion'], undefined);
});

test('hosted LLM kind requires a code-owned paid step and actual reported usage', async () => {
  for (const step of ['guard', 'model', 'repair', 'escalate']) {
    const out = await run({ 'tailor.step': step, 'tailor.model': 'claude-sonnet-5-5', 'tailor.usage.available': true,
      'tailor.usage.input_tokens': 3, 'tailor.usage.output_tokens': 1, 'neatlogs.span.kind': 'chain' });
    assert.equal(out.attributes['neatlogs.span.kind'], 'llm');
  }
  for (const [step,available] of [['model',false],['save',true]]) {
    const out = await run({ 'tailor.step': step, 'tailor.model': 'claude-sonnet-5-5', 'tailor.usage.available': available,
      'neatlogs.span.kind': 'chain' });
    assert.equal(out.attributes['neatlogs.span.kind'], 'chain');
  }
  const capturedMask = createSpanMask(telemetryVocabulary({ modelIds: ['claude-sonnet-5-5'] }));
  const raw = await capturedMask({ attributes: { 'tailor.step': 'model', 'tailor.model': 'claude-sonnet-5-5', 'tailor.usage.available': true,
    'tailor.usage.input_tokens': 3, 'tailor.usage.output_tokens': 1, 'neatlogs.span.kind': 'chain' }, events: [] } as any) as any;
  assert.equal(raw.attributes['neatlogs.span.kind'], 'chain');
  assert.equal(raw.attributes['neatlogs.metadata'], undefined);
});

test('trusted synthetic envelope needs both operator option and synthetic turn flag', async () => {
  const attrs = { 'tailor.step': 'turn', 'tailor.synthetic': true, 'tailor.synthetic_input': 'SYNTHETIC: inspect a fictional support request', 'tailor.synthetic_output': 'SYNTHETIC: saved fixture explanation' };
  const approved = createSpanMask(telemetryVocabulary({}), { hostedFields: true, syntheticPayloads: true });
  const allowed = await approved({ attributes: attrs, events: [] } as any) as any;
  assert.equal((parseNativeDiagnosticEnvelope(allowed.attributes['neatlogs.input.value'])! as any).text.value, attrs['tailor.synthetic_input']);
  assert.equal((parseNativeDiagnosticEnvelope(allowed.attributes['neatlogs.output.value'])! as any).text.value, attrs['tailor.synthetic_output']);
  assert.equal((parseNativeDiagnosticEnvelope(allowed.attributes['neatlogs.workflow.input'])! as any).text.value, attrs['tailor.synthetic_input']);
  assert.deepEqual(JSON.parse(allowed.attributes['neatlogs.metadata']).synthetic, { input: attrs['tailor.synthetic_input'], output: attrs['tailor.synthetic_output'] });
  const denied = await mask({ attributes: attrs, events: [] } as any) as any;
  assert.equal(JSON.parse(denied.attributes['neatlogs.metadata']).synthetic, undefined);
  assert.equal(denied.attributes['neatlogs.input.value'], undefined);
  const untrusted = await approved({ attributes: { ...attrs, 'tailor.synthetic': false }, events: [] } as any) as any;
  assert.equal(JSON.parse(untrusted.attributes['neatlogs.metadata']).synthetic, undefined);
});

test('native input/output aliases are always denied as inbound attributes', async () => {
  const approved = createSpanMask(telemetryVocabulary({}), { hostedFields: true, syntheticPayloads: true });
  const out = await approved({ attributes: { 'tailor.step': 'turn', 'tailor.synthetic': true,
    'input.value': 'ordinary buyer text', 'output.value': 'ordinary reply', 'neatlogs.input.value': 'ordinary buyer text',
    'neatlogs.output.value': 'ordinary reply', 'neatlogs.workflow.input': 'ordinary buyer text' }, events: [] } as any) as any;
  for (const key of ['input.value','neatlogs.input.value','neatlogs.workflow.input']) assert.equal(out.attributes[key], undefined);
  assert.equal(JSON.stringify(out.attributes).includes('ordinary buyer text'), false);
  assert.equal(JSON.stringify(out.attributes).includes('ordinary reply'), false);
});

test('hosted cost uses the existing reported-usage estimate and metadata aliases stay generated', async () => {
  const out = await run({ 'tailor.step': 'model', 'tailor.model': 'claude-sonnet-5-5', 'tailor.usage.available': true,
    'tailor.usage.input_tokens': 3, 'tailor.usage.output_tokens': 1, 'tailor.cost_known': true, 'tailor.cost_usd': 0.00002,
    metadata: 'ordinary buyer data' });
  assert.equal(out.attributes['neatlogs.llm.cost_usd'], 0.00002);
  assert.equal(out.attributes['tailor.estimated'], true);
  assert.equal(out.attributes.metadata, out.attributes['neatlogs.metadata']);
  assert.equal(out.attributes.metadata.includes('ordinary buyer data'), false);
  const absent = await run({ 'tailor.step': 'model', 'tailor.model': 'claude-sonnet-5-5', 'tailor.usage.available': true,
    'tailor.cost_known': false, 'tailor.cost_usd': 0.2, 'neatlogs.llm.cost_usd': -1 });
  assert.equal(absent.attributes['neatlogs.llm.cost_usd'], undefined);
});

test('approved guidance observation is a distinct diagnostic envelope without turn claims', async () => {
  const approved = createSpanMask(telemetryVocabulary({}), { hostedFields: true, syntheticPayloads: true });
  const out = await approved({ name: 'tailor.guidance', attributes: { 'tailor.synthetic': true, 'tailor.guidance_outcome': 'shown', 'tailor.guidance_target': 'trace.overview' },
    events: [{ name: 'tailor.guidance', attributes: { 'tailor.guidance_outcome': 'shown' } }] } as any) as any;
  const envelope = parseNativeDiagnosticEnvelope(out.attributes['neatlogs.output.value'])! as any;
  assert.equal(envelope.schema, 'tailor-guidance-diagnostics-v1');
  assert.equal(envelope.text, null);
  assert.equal(envelope.diagnostics.root.attributes['tailor.turn_id'], undefined);
  assert.equal(envelope.diagnostics.root.events[0].attributes['tailor.guidance_outcome'], 'shown');
});

test('guidance diagnostics expose exact independent trace IDs and share canonical turn session ref', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'fake-observation-secret' });
  const turn = telemetry.forTurn('turn-local', 'owner-local');
  await telemetry.guidanceEvent!('owner-local', 'demo-local', { messageId: 'message-local', suggestionId: 'suggestion-local', targetId: 'trace.overview', targetKey: 'target-local', version: 1, outcome: 'shown' });
  const span = telemetry.captured().find(span => span.name === 'tailor.guidance')!;
  assert.equal(span.attributes['tailor.session_ref'], turn.sessionRef);
  assert.equal(span.attributes['tailor.turn_id'], undefined);
  assert.deepEqual(telemetry.diagnostics().recentGuidance, [{ traceId: span.traceId, outcome: 'shown', demoRef: span.attributes['tailor.demo_ref'], messageRef: span.attributes['tailor.message_ref'] }]);
  assert.equal(JSON.stringify(telemetry.diagnostics().recentGuidance).includes('owner-local'), false);
  await telemetry.shutdown();
});

test('trusted 1040-character final reply is preserved, with a flagged 2000-character cap', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'fake-reply-preservation', syntheticPayloads: true });
  const tt = telemetry.forTurn('payload-turn', 'payload-owner', { synthetic: true });
  await tt.step('turn', {}, async () => { tt.attachSynthetic({ input: 'SYNTHETIC: a fictional request', output: 'x'.repeat(1040) }); });
  const root = telemetry.captured().find(span => span.name === 'tailor.turn')!;
  assert.equal(String(root.attributes['tailor.synthetic_output']).length, 1040);
  assert.equal(root.attributes['tailor.synthetic_output_truncated'], false);
  const mask = createSpanMask(telemetryVocabulary({}), { hostedFields: true, syntheticPayloads: true });
  const out = await mask(root as any) as any;
  const envelope = parseNativeDiagnosticEnvelope(out.attributes['neatlogs.output.value'])! as any;
  assert.equal(envelope.text.value.length, 1040);
  assert.equal(envelope.text.truncated, false);
  assert.equal(envelope.diagnostics.summaries.action.plannerType, null, 'missing planner action is unavailable');
  await telemetry.shutdown();
});

test('bounded structured planner selection is allowlisted without raw proposal or model prose', async () => {
  const mask = createSpanMask(telemetryVocabulary({ recordIds: ['trace-detail'] }), { hostedFields: true, syntheticPayloads: true });
  const out = await mask({ name: 'tailor.turn', attributes: { 'tailor.step': 'turn', 'tailor.synthetic': true }, events: [
    { name: 'tailor.planner_selected', attributes: { 'tailor.planner_action': 'propose', 'tailor.proposal_mode': 'new',
      'tailor.proposal_trace_count': 2, 'tailor.proposal_span_count': 8, 'tailor.expected_version': 1, 'tailor.suggestion_count': 2,
      'tailor.raw_action': 'private free text', 'tailor.proposal': '{raw payload}' } },
  ] } as any) as any;
  const envelope = parseNativeDiagnosticEnvelope(out.attributes['neatlogs.output.value'])! as any;
  assert.equal(envelope.diagnostics.summaries.action.plannerType, 'propose');
  assert.equal(envelope.diagnostics.summaries.action.structuredSelections[0]['tailor.proposal_mode'], 'new');
  assert.equal(envelope.diagnostics.summaries.action.structuredSelections[0]['tailor.proposal_trace_count'], 2);
  assert.equal(out.attributes['neatlogs.output.value'].includes('private free text'), false);
  assert.equal(out.attributes['neatlogs.output.value'].includes('raw payload'), false);
});
