import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAnthropicTransport, reportedUsage, type MessagesClientLike, type RawMessageLike } from '../src/tailor/anthropic-transport.ts';
import { createAnthropicProvider } from '../src/clients/neatlogs/anthropic-provider.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
import { ProviderError } from '../src/tailor/provider-error.ts';
import { providerMetadataAttrs } from '../src/tailor/accounting.ts';
import { cleanAttributes, createSpanMask, createTelemetry, parseNativeDiagnosticEnvelope, summariseObservedDiagnostics, telemetryVocabulary } from '../src/infrastructure/telemetry.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { fakeKnowledge, fixedClock, SESSION_ID, stubTools } from './helpers/agent.ts';

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
  cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens_details: { thinking_tokens: 15 } };
const response = (extra: Partial<RawMessageLike> = {}): RawMessageLike => ({ model: 'claude-sonnet-5-5-20261001', stop_reason: 'end_turn', usage,
  _request_id: 'req_metadata123', content: [{ type: 'text', text: '{"ok":true}' }], ...extra });
const client = (value: RawMessageLike): MessagesClientLike => ({ messages: { create: async () => value } });
const request = { kind: 'plan' as const, messages: [{ role: 'system' as const, content: 'Static system é' }, { role: 'user' as const, content: 'Private buyer text' }],
  schema: { type: 'object' }, maxTokens: 100, extract: (v: unknown) => v };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('provider metadata preserves requested/resolved ids and whitelisted raw counters without changing spend', async () => {
  const spend = createSpendGuard({ capUsd: 10 });
  const transport = createAnthropicTransport({ apiKey: 'placeholder', client: client(response()), spend });
  const result = await transport.call(request);
  assert.deepEqual(result.providerMetadata, { requestedModel: 'claude-sonnet-5-5', resolvedModel: 'claude-sonnet-5-5-20261001', reportedUsage: usage, outputTokensIncludeThinking: true });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.inputAccounting.system.bytes, Buffer.byteLength('Static system é'));
  assert.equal(result.inputAccounting.messageCount, 1);
  assert.equal(result.inputAccounting.systemPrefixSha256, sha('Static system é'));
  assert.equal(result.inputAccounting.schemaSha256, sha(JSON.stringify(request.schema)));
  // Existing financial guard deliberately still prices all writes at its conservative 1h rate.
  assert.equal(result.costUsd, (100 * 2 + 50 * 10 + 20 * .1 + 30 * 4) / 1_000_000);
  assert.equal(spend.summary().outputTokens, 50, 'inclusive output is not inflated by thinking');
  const second = await transport.call({ ...request, messages: [request.messages[0]!, { role: 'user', content: 'Different buyer' }] });
  assert.equal(second.inputAccounting.systemPrefixSha256, result.inputAccounting.systemPrefixSha256);
  assert.notEqual(second.inputAccounting.conversation.bytes, result.inputAccounting.conversation.bytes);
});

test('missing optional counters remain absent, explicit zero survives, unknown raw fields never survive', () => {
  assert.deepEqual(reportedUsage({ input_tokens: 1, output_tokens: 2 }), { input_tokens: 1, output_tokens: 2 });
  assert.deepEqual(reportedUsage({ input_tokens: 1, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 0 } }),
    { input_tokens: 1, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 0 } });
  const hostile = { input_tokens: 1, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 1.5 },
    output_tokens_details: { thinking_tokens: 3, hidden_reasoning: 'must not escape' }, arbitrary: 'sk-ant-private' };
  assert.deepEqual(reportedUsage(hostile), { input_tokens: 1, output_tokens: 2 });
  for (const value of [NaN, Infinity, -1, .5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(reportedUsage({ input_tokens: value, output_tokens: 2 }), undefined);
    assert.deepEqual(reportedUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: value }), { input_tokens: 1, output_tokens: 2 });
  }
});

test('invalid resolved ids are absent rather than replaced with the requested alias', async () => {
  for (const model of [undefined, 'private buyer text', 'claude-sk-ant-private', 'claude-sonnet-user@example.com']) {
    const r = await createAnthropicTransport({ apiKey: 'placeholder', client: client(response({ model, usage: undefined })), spend: createSpendGuard({ capUsd: 10 }) }).call(request);
    assert.equal(r.providerMetadata.resolvedModel, undefined);
    assert.equal(r.providerMetadata.reportedUsage, undefined);
    assert.equal(r.settlement, 'settled_unreconciled');
  }
});

test('billed truncation keeps metadata and stop reason; timeout keeps request-only metadata', async () => {
  const transport = createAnthropicTransport({ apiKey: 'placeholder', client: client(response({ stop_reason: 'max_tokens', content: [{ type: 'thinking', text: 'private hidden reasoning' }] })), spend: createSpendGuard({ capUsd: 10 }) });
  await assert.rejects(transport.call(request), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.stopReason, 'max_tokens');
    assert.equal(error.providerMetadata?.resolvedModel, 'claude-sonnet-5-5-20261001');
    assert.deepEqual(error.providerMetadata?.reportedUsage, usage);
    assert.equal(JSON.stringify(error).includes('private hidden reasoning'), false);
    return true;
  });
  const timeout = createAnthropicTransport({ apiKey: 'placeholder', timeoutMs: 1, client: { messages: { create: async () => new Promise(() => {}) } }, spend: createSpendGuard({ capUsd: 10 }) });
  await assert.rejects(timeout.call(request), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'timeout');
    assert.deepEqual(error.providerMetadata, { requestedModel: 'claude-sonnet-5-5', outputTokensIncludeThinking: true });
    assert.equal(error.inputAccounting?.messageCount, 1);
    return true;
  });
});

test('Neatlogs provider carries metadata through guard, planning and explanation codecs', async () => {
  const replies = [ { outcome: 'allow_product_question', reason: 'product_question' },
    { type: 'answer', text: 'Trace details show steps.', knowledgeIds: ['trace-detail'] }, { text: 'The step failed.', spanIds: ['one'] } ];
  const p = createAnthropicProvider({ apiKey: 'placeholder', spend: createSpendGuard({ capUsd: 10 }), client: { messages: { create: async () => response({ content: [{ type: 'text', text: JSON.stringify(replies.shift()) }] }) } } });
  const guard = await p.classifyPolicy!({ messages: request.messages, responseSchema: 'entry_policy', maxOutputTokens: 100 });
  const plan = await p.complete({ messages: request.messages, responseSchema: 'agent_action', maxOutputTokens: 100 });
  const explain = await p.explain!({ messages: request.messages, responseSchema: 'evidence_explanation', maxOutputTokens: 100 });
  for (const r of [guard, plan, explain]) {
    assert.deepEqual(r.providerMetadata?.reportedUsage, usage);
    assert.equal(r.providerMetadata?.resolvedModel, 'claude-sonnet-5-5-20261001');
    assert.equal(r.stopReason, 'end_turn');
  }
});

test('safe metadata survives core guard/planner telemetry and native envelopes without prompts or reasoning', async () => {
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'metadata-test-only' });
  try {
    const p = createAnthropicProvider({ apiKey: 'placeholder', spend: createSpendGuard({ capUsd: 10 }), client: { messages: { create: async params => response({ content: [
      { type: 'thinking', text: 'private hidden reasoning' },
      { type: 'text', text: JSON.stringify('outcome' in (params.output_config.format.schema.properties as object)
        ? { outcome: 'allow_product_question', reason: 'product_question' }
        : { type: 'answer', text: 'Trace detail shows each step as a span.', knowledgeIds: ['trace-detail'] }) },
    ] }) } } });
    const tt = telemetry.forTurn(randomUUID(), SESSION_ID);
    const tools = stubTools();
    await tt.step('turn', {}, () => createAgentService().handleTurn({
      session: { id: SESSION_ID, version: 1, conversationVersion: 1, story: null, dataset: tools.state.dataset, conversation: [], state: 'active', expiresAt: '2026-10-12T20:00:00.000Z' },
      request: { text: 'How can Neatlogs show trace steps?', clientTurnId: randomUUID() }, tools, provider: p, knowledge: fakeKnowledge(), telemetry: tt, clock: fixedClock,
    }));
    const attempts = telemetry.captured().filter(s => s.attributes['tailor.requested_model']);
    assert.equal(attempts.length, 2);
    for (const a of attempts) {
      assert.equal(a.attributes['tailor.resolved_model'], 'claude-sonnet-5-5-20261001');
      assert.equal(a.attributes['tailor.reported_cache_write5m_tokens'], 10);
      assert.equal(a.attributes['tailor.reported_cache_write1h_tokens'], 20);
      assert.equal(a.attributes['tailor.reported_output_tokens'], 50);
      assert.equal(a.attributes['tailor.output_tokens_include_thinking'], true);
      assert.equal(a.attributes['tailor.stop_reason'], 'end_turn');
      assert.match(String(a.attributes['tailor.system_prefix_sha256']), /^[0-9a-f]{64}$/);
    }
    assert.equal(attempts.find(a => a.attributes['tailor.step'] === 'guard')?.attributes['tailor.effort'], 'low');
    const mask = createSpanMask(telemetryVocabulary({ modelIds: ['claude-sonnet-5-5'] }), { hostedFields: true, syntheticPayloads: true });
    for (const a of attempts) await mask({ ...a, attributes: { ...a.attributes, 'tailor.trace_id': 'a'.repeat(32) } } as any);
    const root = await mask({ name: 'tailor.turn', attributes: { 'tailor.step': 'turn', 'tailor.turn_id': tt.turnRef, 'tailor.trace_id': 'a'.repeat(32), 'tailor.synthetic': true, 'tailor.synthetic_output': 'SYNTHETIC: done' }, events: [] } as any) as any;
    const envelope = parseNativeDiagnosticEnvelope(root.attributes['neatlogs.output.value']) as any;
    assert.equal(envelope.diagnostics.summaries.providerAttempts.length, 2);
    assert.equal(envelope.diagnostics.summaries.providerAttempts[0]['tailor.reported_cache_write5m_tokens'], 10);
    const dump = JSON.stringify([attempts, root]);
    for (const forbidden of ['private hidden reasoning', 'How can Neatlogs show trace steps?', 'placeholder', 'Static system']) assert.equal(dump.includes(forbidden), false);
  } finally { await telemetry.shutdown(); }
});

test('metadata allowlist rejects hostile ids, raw objects, noninteger counters and forged fingerprints', async () => {
  const vocab = telemetryVocabulary({ modelIds: ['claude-sonnet-5-5'] });
  const good = cleanAttributes({ ...providerMetadataAttrs({ requestedModel: 'claude-sonnet-5-5', resolvedModel: 'claude-sonnet-5-5-20261001', reportedUsage: usage, outputTokensIncludeThinking: true }), systemPrefixSha256: sha('static') }, undefined, vocab);
  assert.equal(good.dropped, 0);
  const bad = cleanAttributes({ resolvedModel: 'claude-sk-ant-private', requestedModel: 'buyer text', systemPrefixSha256: 'sk-ant-private', schemaSha256: 'a'.repeat(63), reportedUsage: usage, reportedCacheWrite5mTokens: .5, reportedInputTokens: -1 }, undefined, vocab);
  assert.deepEqual(bad.clean, {});
  assert.equal(bad.dropped, 7);
  const masked = await createSpanMask(vocab)({ attributes: { ...good.clean, 'tailor.resolved_model': 'claude-sk-ant-private', 'tailor.reported_cache_write1h_tokens': -1 }, events: [] } as any) as any;
  assert.equal(masked.attributes['tailor.resolved_model'], undefined);
  assert.equal(masked.attributes['tailor.reported_cache_write1h_tokens'], undefined);
  assert.equal(masked.attributes['tailor.system_prefix_sha256'], sha('static'));
  const unavailable = summariseObservedDiagnostics([{ attributes: cleanAttributes(providerMetadataAttrs({ requestedModel: 'claude-sonnet-5-5', outputTokensIncludeThinking: true }), undefined, vocab).clean }]) as any;
  assert.equal(unavailable.providerAttempts[0]['tailor.reported_usage_available'], false);
  assert.equal(unavailable.providerAttempts[0]['tailor.reported_input_tokens'], undefined);
});
