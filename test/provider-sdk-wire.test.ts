// Live provider against the REAL @anthropic-ai/sdk client. The transport is a scripted `fetch` (no network) and the key
// is a placeholder, so this exercises what the SDK actually does with a response (parsing, request ids, retries,
// timeouts) instead of a hand-written fake. No credentials, no environment reads, no paid calls.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { systemClock, type AgentTurnResult, type ProviderRequest, type SessionSnapshot } from '../src/agent-contract.ts';
import { travelBuyerTurn1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { ProviderError, createAnthropicProvider, maxOutputTokensFor, type MessagesClientLike } from '../src/clients/neatlogs/anthropic-provider.ts';
import { AGENT_LIMITS, createAgentService } from '../src/clients/neatlogs/service.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
import { fakeKnowledge, recordingTelemetry, stubTools } from './helpers/agent.ts';

const PLACEHOLDER_KEY = 'placeholder-not-a-key';
type Script = (attempt: number, init: RequestInit) => Promise<Response>;

function sdk(script: Script, opts: { maxRetries?: number; timeout?: number } = {}): { client: MessagesClientLike; attempts: () => number } {
  let attempts = 0;
  const fetchFn = async (_url: unknown, init: RequestInit) => script(++attempts, init);
  // maxRetries 2 is the SDK default: the provider must override it per request so Tailor owns retries.
  const client = new Anthropic({ apiKey: PLACEHOLDER_KEY, fetch: fetchFn as never, maxRetries: opts.maxRetries ?? 2, timeout: opts.timeout ?? 600_000, logLevel: 'off' });
  return { client: client as unknown as MessagesClientLike, attempts: () => attempts };
}

const reply = (stop_reason: string, content: unknown[], usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 4000 }, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason, stop_sequence: null, usage, ...extra }),
    { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_wire_1' } });

const answerWire = { type: 'answer', text: 'ok', clarification: null, proposal: null, explanation: null, traceId: null, spanIds: null, knowledgeIds: [], capabilityId: null, reason: null };
const planRequest: ProviderRequest = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hello' }], responseSchema: 'agent_action', maxOutputTokens: 4000 };

async function settle(p: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: ProviderError }> {
  try { return { ok: true, value: await p }; }
  catch (error) { assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`); return { ok: false, error }; }
}

const usd = (input: number, output: number) => (input * 2 + output * 10) / 1e6;

test('L1-01: max_tokens with cut-off JSON is `truncated` and the billed usage is recorded (+1 call)', async () => {
  const spend = createSpendGuard({ capUsd: 100 });
  const { client } = sdk(async () => reply('max_tokens', [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '{"type":"propose","text":null,"proposal":{"expectedVersion":1,"mode":"new"' }]));
  const r = await settle(createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client }).complete(planRequest));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, 'truncated');
  assert.equal(r.error.retryable, false);
  assert.equal(r.error.requestId, 'req_wire_1');
  const s = spend.summary();
  assert.deepEqual([s.calls, s.inputTokens, s.outputTokens, s.pendingCalls, s.unreconciledUsd], [1, 1000, 4000, 0, 0]);
  assert.ok(Math.abs(s.spentUsd - usd(1000, 4000)) < 1e-12, String(s.spentUsd));
});

test('L1-01: refusal with prose text is `refusal` (category from stop_details) and recorded', async () => {
  const spend = createSpendGuard({ capUsd: 100 });
  const { client } = sdk(async () => reply('refusal', [{ type: 'text', text: 'I can’t help with that.' }], { input_tokens: 900, output_tokens: 20 }, { stop_details: { type: 'refusal', category: 'cyber', explanation: null } }));
  const r = await settle(createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client }).complete(planRequest));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, 'refusal');
  assert.match(r.error.message, /cyber/);
  assert.equal(r.error.requestId, 'req_wire_1');
  assert.deepEqual([spend.summary().calls, spend.summary().inputTokens, spend.summary().outputTokens], [1, 900, 20]);
});

test('L1-01: refusal with empty content is `refusal` and recorded', async () => {
  const spend = createSpendGuard({ capUsd: 100 });
  const { client } = sdk(async () => reply('refusal', [], { input_tokens: 900, output_tokens: 0 }));
  const r = await settle(createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client }).complete(planRequest));
  assert.equal(r.ok ? 'resolved' : r.error.kind, 'refusal');
  assert.equal(spend.summary().calls, 1);
});

test('L1-01 / L1-08: end_turn with thinking + valid JSON resolves, is recorded, and carries the request-id header', async () => {
  const spend = createSpendGuard({ capUsd: 100 });
  const { client } = sdk(async () => reply('end_turn', [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: JSON.stringify(answerWire) }], { input_tokens: 10, output_tokens: 30, output_tokens_details: { thinking_tokens: 20 } }));
  const r = await settle(createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client }).complete(planRequest));
  assert.equal(r.ok, true, r.ok ? '' : r.error.kind);
  if (!r.ok) return;
  const out = r.value as { action: unknown; requestId?: string; usage: unknown };
  assert.deepEqual(out.action, { type: 'answer', text: 'ok', knowledgeIds: [] });
  assert.equal(out.requestId, 'req_wire_1');
  const s = spend.summary();
  assert.deepEqual([s.calls, s.outputTokens, s.thinkingTokens], [1, 30, 20]);
  assert.ok(Math.abs(s.spentUsd - usd(10, 30)) < 1e-12, 'thinking is inside output_tokens: never billed twice');
});

test('L1-01: end_turn with non-JSON text is `malformed` (retryable) and still recorded', async () => {
  const spend = createSpendGuard({ capUsd: 100 });
  const { client } = sdk(async () => reply('end_turn', [{ type: 'text', text: 'Sure! Here is the plan' }], { input_tokens: 10, output_tokens: 10 }));
  const r = await settle(createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client }).complete(planRequest));
  assert.equal(r.ok ? 'resolved' : `${r.error.kind}:${r.error.retryable}`, 'malformed:true');
  assert.equal(spend.summary().calls, 1);
});

test('L1-01: pause_turn / stop_sequence / tool_use are `malformed` and recorded; context window -> context_exceeded', async () => {
  for (const [stop, kind] of [['pause_turn', 'malformed'], ['stop_sequence', 'malformed'], ['tool_use', 'malformed'], ['model_context_window_exceeded', 'context_exceeded']] as const) {
    const spend = createSpendGuard({ capUsd: 100 });
    const { client } = sdk(async () => reply(stop, [{ type: 'text', text: '{}' }], { input_tokens: 10, output_tokens: 10 }));
    const r = await settle(createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client }).complete(planRequest));
    assert.equal(r.ok ? 'resolved' : r.error.kind, kind, stop);
    assert.equal(spend.summary().calls, 1, `${stop}: recorded`);
  }
});

test('the evidence explanation call parses its own JSON the same way (truncated -> truncated, recorded)', async () => {
  const spend = createSpendGuard({ capUsd: 100 });
  const { client } = sdk(async () => reply('max_tokens', [{ type: 'text', text: '{"text":"The booking' }], { input_tokens: 50, output_tokens: 800 }));
  const p = createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client });
  const r = await settle(p.explain!({ messages: [{ role: 'user', content: 'evidence' }], responseSchema: 'evidence_explanation', maxOutputTokens: 800 }));
  assert.equal(r.ok ? 'resolved' : r.error.kind, 'truncated');
  assert.equal(spend.summary().byKind.explain?.calls, 1);
});

test('the SDK never retries internally: one HTTP attempt per provider call, even for a 529 (Tailor owns retries)', async () => {
  const spend = createSpendGuard({ capUsd: 100 });
  const { client, attempts } = sdk(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529, headers: { 'content-type': 'application/json', 'retry-after-ms': '1', 'request-id': 'req_529' } }));
  const r = await settle(createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client }).complete(planRequest));
  assert.equal(r.ok ? 'resolved' : r.error.kind, 'overloaded');
  assert.equal(attempts(), 1);
  const s = spend.summary();
  assert.deepEqual([s.calls, s.pendingCalls, s.unreconciledUsd], [0, 0, 0], 'an HTTP error response is not billed: the reservation is released');
});

test('the wire request carries the untransformed schema, adaptive thinking, and an effort-aware max_tokens', async () => {
  let body: Record<string, unknown> = {};
  const { client } = sdk(async (_n, init) => { body = JSON.parse(String(init.body)) as Record<string, unknown>; return reply('end_turn', [{ type: 'text', text: JSON.stringify(answerWire) }], { input_tokens: 1, output_tokens: 1 }); });
  await createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend: createSpendGuard({ capUsd: 100 }), client }).complete({ ...planRequest, maxOutputTokens: 1_000_000 });
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.max_tokens, maxOutputTokensFor('medium'));
  const config = body.output_config as { effort: string; format: { type: string; schema: { properties: Record<string, unknown> } } };
  assert.equal(config.effort, 'medium');
  assert.equal(config.format.type, 'json_schema');
  assert.ok(config.format.schema.properties.type);
  const raw = JSON.stringify(body);
  for (const forbidden of ['budget_tokens', '"disabled"', '"enabled"', 'tool_choice', '"tools"']) assert.ok(!raw.includes(forbidden), forbidden);
});

test('L1-06: max_tokens is effort-aware; xhigh/max are refused because the ceiling does not cover them', () => {
  assert.equal(maxOutputTokensFor('low'), 4000);
  assert.equal(maxOutputTokensFor('medium'), 8000);
  assert.ok((maxOutputTokensFor('high') ?? 0) >= 8000);
  assert.equal(maxOutputTokensFor('xhigh'), null);
  assert.equal(maxOutputTokensFor('max'), null);
  const { client } = sdk(async () => reply('end_turn', []));
  assert.throws(() => createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend: createSpendGuard({ capUsd: 1 }), client, effort: 'xhigh' }), /effort/i);
});

// ---------------------------------------------------------------------------------------------------------------------
// Timeouts (fake timers): one attempt, kind timeout, turn ends before the deadline, one unreconciled reservation.
// ---------------------------------------------------------------------------------------------------------------------
function sessionFor(text: string): SessionSnapshot {
  return {
    id: 'sess-test', version: 1, conversationVersion: 1, story: null, dataset: { activeScenario: '', traces: [] },
    conversation: [{ id: 'b1', role: 'buyer', text, status: 'pending', at: '2026-10-11T12:00:00.000Z' }], state: 'active', expiresAt: '2026-10-11T16:00:00.000Z',
  };
}

test('L1-02 / L4-02: a hung live call is ONE attempt, kind timeout, ends before the turn deadline, and leaves one unreconciled reservation', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_760_000_000_000 });
  try {
    const spend = createSpendGuard({ capUsd: 100 });
    let aborted = 0;
    const { client, attempts } = sdk((_n, init) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => { aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    }));
    const live = createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client });
    // Independent allowed-scope fixture so this case isolates the real SDK planner timeout.
    const provider = { ...live, async classifyPolicy() { return { decision: { outcome: 'allow_demo_action' as const, reason: 'demo_action' as const }, usage: null, latencyMs: 0, costUsd: 0 }; } };
    const telemetry = recordingTelemetry();
    const started = Date.now();
    let result: AgentTurnResult | undefined;
    const done = createAgentService().handleTurn({
      session: sessionFor(travelBuyerTurn1.text), request: { text: travelBuyerTurn1.text, clientTurnId: 'ct-1' },
      tools: stubTools(), knowledge: fakeKnowledge(), telemetry, clock: systemClock, provider,
    }).then(r => { result = r; });
    for (let i = 0; i < 200 && !result; i++) { await new Promise(r => setImmediate(r)); mock.timers.tick(1000); }
    await done;
    assert.ok(result, 'the turn finished');
    const elapsed = Date.now() - started;
    assert.equal(result!.outcome, 'provider_unavailable');
    assert.ok(elapsed < AGENT_LIMITS.turnDeadlineMs, `turn ended after ${elapsed} ms`);
    assert.equal(attempts(), 1, 'no SDK-internal retry and no service retry of a timeout');
    assert.equal(aborted, 1);
    assert.equal(result!.steps.find(s => s.name === 'model')?.detail, 'timeout');
    assert.deepEqual(result!.execution, { mode: 'live', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' });
    const s = spend.summary();
    assert.equal(s.pendingCalls, 0);
    assert.equal(s.unreconciledCalls, 1);
    assert.ok(s.unreconciledUsd > 0, 'an unanswered call is never counted as $0');
    assert.equal(s.calls, 1);
    assert.ok(Math.abs(s.spentUsd - s.unreconciledUsd) < 1e-12, 'the conservative (worst-case) amount is kept');
  } finally { mock.timers.reset(); }
});

test('L1-02: a provider timeout is a ProviderError("timeout") that is not retried within the turn', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const spend = createSpendGuard({ capUsd: 100 });
    const { client } = sdk((_n, init) => new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }));
    const pending = settle(createAnthropicProvider({ apiKey: PLACEHOLDER_KEY, spend, client, timeoutMs: 5000 }).complete(planRequest));
    await new Promise(r => setImmediate(r));
    mock.timers.tick(5000);
    const r = await pending;
    assert.equal(r.ok ? 'resolved' : `${r.error.kind}:${r.error.retryable}`, 'timeout:false');
    assert.equal(spend.summary().unreconciledCalls, 1);
  } finally { mock.timers.reset(); }
});
