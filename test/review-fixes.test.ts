import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import type { ProviderRequest } from '../src/agent-contract.ts';
import { ANTHROPIC_FIXED_PARTS, createAnthropicProvider } from '../src/clients/neatlogs/anthropic-provider.ts';
import { CONTEXT_RESERVE, contextBudget, fitContext, type AgentContext } from '../src/clients/neatlogs/context.ts';
import { parseUserMessage, SYSTEM_PROMPT } from '../src/clients/neatlogs/prompts.ts';
import { REQUEST_FRAMING_TOKENS, mapSdkError, maxOutputTokensFor, toAnthropicMessages, type MessagesClientLike } from '../src/tailor/anthropic-transport.ts';
import { CORE_LIMITS } from '../src/tailor/contract.ts';
import { reconcileTurnResult } from '../src/tailor/lifecycle.ts';
import { ProviderError } from '../src/tailor/provider-error.ts';
import { createSpendGuard, WORST_CHARS_PER_TOKEN } from '../src/tailor/spend.ts';
import { countingProvider, harness, type CountingProvider } from './helpers/agent.ts';

const TRAVEL = 'I’m building a travel-booking agent. Show me a booking API timeout followed by a successful retry.';

// ---------------------------------------------------------------------------------------------------------------------
// R1-N1: on the core's timeout backstop, the turn waits (bounded) for the provider call to settle.
// ---------------------------------------------------------------------------------------------------------------------
function slowProvider(settleAfterAbortMs: number | null): CountingProvider & { settled: () => boolean } {
  let settled = false;
  const calls: ProviderRequest[] = [];
  return {
    name: 'slow', model: null, mode: 'mock', calls, settled: () => settled,
    complete(request, signal) {
      calls.push(request);
      return new Promise((_resolve, reject) => {
        if (settleAfterAbortMs === null) return; // ignores abort entirely
        signal?.addEventListener('abort', () => setTimeout(() => { settled = true; reject(new ProviderError('timeout', 'aborted')); }, settleAfterAbortMs));
      });
    },
  };
}

async function runWithBackstop(provider: CountingProvider) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = harness({ provider });
    let done = false;
    const turn = h.say(TRAVEL).finally(() => { done = true; });
    for (let i = 0; i < 20 && provider.calls.length === 0; i++) await new Promise(r => setImmediate(r));
    assert.equal(provider.calls.length, 1, 'the provider call started');
    mock.timers.tick(CORE_LIMITS.providerTimeoutMs + 5_000); // the per-call budget: backstop fires, abort is forwarded
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    const doneRightAfterAbort = done;
    let waitedMs = 0;
    while (!done && waitedMs < 1_000) { mock.timers.tick(5); waitedMs += 5; for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); }
    return { result: await turn, doneRightAfterAbort, waitedMs };
  } finally { mock.timers.reset(); }
}

test('R1-N1: a provider that settles shortly after abort is awaited before the turn returns', async () => {
  const provider = slowProvider(20);
  const { result, doneRightAfterAbort } = await runWithBackstop(provider);
  assert.equal(doneRightAfterAbort, false, 'the turn did not return the instant the backstop fired');
  assert.equal(provider.settled(), true, 'the provider call had settled when the turn returned');
  assert.equal(result.outcome, 'provider_unavailable');
});

test('R1-N1: a provider that ignores abort is abandoned after about 50 ms', async () => {
  const provider = slowProvider(null);
  const { result, waitedMs } = await runWithBackstop(provider);
  assert.ok(waitedMs >= 45 && waitedMs <= 60, `bounded wait, got ${waitedMs} ms`);
  assert.equal(result.outcome, 'provider_unavailable');
});

// ---------------------------------------------------------------------------------------------------------------------
// R1-F9: the opt-in provider debug log carries status, request id and kind only.
// ---------------------------------------------------------------------------------------------------------------------
test('R1-F9: TAILOR_PROVIDER_DEBUG never prints the API message or body (they can echo buyer text)', t => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const before = process.env.TAILOR_PROVIDER_DEBUG;
  process.env.TAILOR_PROVIDER_DEBUG = '1';
  try {
    const echo = 'BUYER-SECRET my card is 4111 1111 1111 1111';
    mapSdkError(new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: `messages.0: ${echo}` } }, `400 ${echo}`, new Headers({ 'request-id': 'req_debug123' })));
    mapSdkError(new Anthropic.APIError(529, { type: 'error', error: { type: 'overloaded_error', message: echo } }, echo, new Headers()));
  } finally {
    if (before === undefined) delete process.env.TAILOR_PROVIDER_DEBUG; else process.env.TAILOR_PROVIDER_DEBUG = before;
  }
  assert.deepEqual(lines, ['[tailor provider] HTTP 400 req_debug123 kind=invalid_request', '[tailor provider] HTTP 529 - kind=overloaded']);
  assert.ok(lines.every(l => !l.includes('BUYER-SECRET') && !l.includes('4111')));
});

// ---------------------------------------------------------------------------------------------------------------------
// R1-F3: readback_uncertain and expired always carry code-owned copy.
// ---------------------------------------------------------------------------------------------------------------------
test('R1-F3: readback_uncertain and expired replace agent-authored text with code-owned copy', () => {
  const label = { mode: 'mock', provider: 'tailor-mock', model: null, effort: null } as const;
  const modelText = [{ role: 'tailor' as const, status: 'applied' as const, text: 'Neatlogs can page Opsgenie and it saved 37 traces.' }];
  const uncertain = reconcileTurnResult({ outcome: 'readback_uncertain', messages: modelText, steps: [], execution: label }, 2, 2, label);
  assert.equal(uncertain.messages.length, 1);
  assert.equal(uncertain.messages[0]!.status, 'uncertain');
  assert.match(uncertain.messages[0]!.text, /could not confirm whether this request was saved.*version 2/);
  const expired = reconcileTurnResult({ outcome: 'expired', messages: modelText, steps: [], execution: label }, 2, 2, label);
  assert.equal(expired.messages.length, 1);
  assert.equal(expired.messages[0]!.status, 'failed');
  assert.match(expired.messages[0]!.text, /ended or expired/);
  for (const r of [uncertain, expired]) assert.ok(!/Opsgenie|37/.test(r.messages[0]!.text));
});

// ---------------------------------------------------------------------------------------------------------------------
// R1-F2: input estimate = ceil(conversation chars / 3) + fixed per-kind overhead computed at provider creation.
// ---------------------------------------------------------------------------------------------------------------------
function reservingProvider() {
  const guard = createSpendGuard({ capUsd: 100 });
  const reserved: number[] = [];
  const spend = { ...guard, reserve: (usd: number, meta: Parameters<typeof guard.reserve>[1]) => { reserved.push(usd); return guard.reserve(usd, meta); } };
  const client: MessagesClientLike = { messages: { create: async () => { throw new Anthropic.BadRequestError(400, {}, 'nope', new Headers()); } } };
  return { provider: createAnthropicProvider({ apiKey: 'sk-ant-placeholder-not-a-key', spend, client }), reserved, guard };
}

test('R1-F2: the plan reservation is conversation chars / 3 plus the fixed wire-notes + schema + framing overhead', async () => {
  const { provider, reserved, guard } = reservingProvider();
  const user = 'x'.repeat(30_000);
  const request: ProviderRequest = { messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], responseSchema: 'agent_action', maxOutputTokens: 99_999 };
  await assert.rejects(provider.complete(request));
  const fixed = ANTHROPIC_FIXED_PARTS.plan;
  const overhead = Math.ceil((fixed.extraSystem.length + 2 + JSON.stringify(fixed.schema).length) / WORST_CHARS_PER_TOKEN) + REQUEST_FRAMING_TOKENS;
  const conv = toAnthropicMessages(request.messages).chars;
  const maxTokens = maxOutputTokensFor('medium')!;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0], guard.worstCaseUsd(conv, maxTokens, 'claude-sonnet-5-5', overhead));
  assert.equal(reserved[0], ((Math.ceil(conv / 3) + overhead) * 2 + maxTokens * 10) / 1e6);
});

test('R1-F2: medium worst case at the 60k-char input limit is $0.12435', () => {
  const guard = createSpendGuard({ capUsd: 100 });
  const fixed = ANTHROPIC_FIXED_PARTS.plan;
  const wire = fixed.extraSystem.length + 2;
  const overhead = Math.ceil((wire + JSON.stringify(fixed.schema).length) / 3) + REQUEST_FRAMING_TOKENS;
  const usd = guard.worstCaseUsd(CORE_LIMITS.maxInputCharsPerCall - wire, maxOutputTokensFor('medium')!, 'claude-sonnet-5-5', overhead);
  assert.equal(Math.round(usd * 1e5) / 1e5, 0.12435);
});

// ---------------------------------------------------------------------------------------------------------------------
// L4-06: the planning context is trimmed to fit the per-call input limit.
// ---------------------------------------------------------------------------------------------------------------------
async function realContext(): Promise<{ context: AgentContext; buyerText: string }> {
  const provider = countingProvider();
  await harness({ provider }).say(TRAVEL);
  const parsed = parseUserMessage(provider.calls[0]!.messages.find(m => m.role === 'user')!.content);
  assert.ok(parsed);
  return parsed;
}

test('L4-06: an oversized context is trimmed to the budget and keeps the structure follow-ups need', async () => {
  const { context, buyerText } = await realContext();
  const big = structuredClone(context);
  const long = (tag: string) => `${tag} ${'lorem ipsum '.repeat(170)}`.slice(0, 2_000);
  big.recentTurns = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'tailor' : 'buyer', status: 'note', text: long(`turn-${i}`) }));
  big.buyerStatements = Array.from({ length: 50 }, (_, i) => long(`statement-${i}`));
  for (const t of big.dataset.traces) { t.errors = Array.from({ length: 6 }, (_, i) => long(`err-${i}`)); for (const s of t.spans) s.error = long('err'); }
  if (big.activeTrace) { big.activeTrace.input = long('ai'); big.activeTrace.output = long('ao'); for (const s of big.activeTrace.spans) { s.input = long('si'); s.output = long('so'); } }
  const budget = contextBudget(buyerText);
  assert.ok(JSON.stringify(big).length > CORE_LIMITS.maxInputCharsPerCall, 'the untrimmed context exceeds the per-call limit');
  const fitted = fitContext(big, budget);
  assert.ok(JSON.stringify(fitted).length <= budget, `fitted ${JSON.stringify(fitted).length} <= ${budget}`);
  assert.equal(fitted.activeScenario, big.activeScenario);
  assert.deepEqual(fitted.dataset.traces.map(t => t.key), big.dataset.traces.map(t => t.key));
  assert.deepEqual(fitted.activeTrace?.spans.map(s => s.key), big.activeTrace?.spans.map(s => s.key));
  assert.equal(fitted.buyerStatements.at(-1)?.slice(0, 12), 'statement-49', 'the latest buyer statement survives');
  const system = SYSTEM_PROMPT.length + CONTEXT_RESERVE.providerNotesChars;
  assert.ok(system + JSON.stringify(fitted).length + buyerText.length + CONTEXT_RESERVE.framingChars + CONTEXT_RESERVE.repairChars <= CORE_LIMITS.maxInputCharsPerCall);
});

test('L4-06: a long real conversation still produces a planning request under the per-call input limit', async () => {
  const provider = countingProvider();
  const h = harness({ provider });
  for (let i = 0; i < 120; i++) h.conversation.push({ id: `old${i}`, role: i % 2 ? 'tailor' : 'buyer', status: 'note', text: `older turn ${i} ${'detail '.repeat(280)}`.slice(0, CORE_LIMITS.maxTurnTextChars), at: '2026-10-11T11:00:00.000Z' });
  await h.say(TRAVEL);
  const chars = provider.calls[0]!.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars + CONTEXT_RESERVE.providerNotesChars + CONTEXT_RESERVE.repairChars <= CORE_LIMITS.maxInputCharsPerCall, `planning request ${chars} chars`);
});
