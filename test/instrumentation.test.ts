// Phase 3 instrumentation: one captured `tailor.turn` per buyer turn, driven by the REAL core (Neatlogs adapter with
// the deterministic mock or scripted providers; the CRM adapter for the unpermitted-tool path). Asserts the step and
// event names, the attribute keys per path, and that buyer text, raw session ids and product evidence ids never leave.
// Network-free: captured telemetry only; no provider SDK; no credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTelemetry, type CapturedSpan, type Telemetry } from '../src/infrastructure/telemetry.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { createMockProvider } from '../src/clients/neatlogs/mock-provider.ts';
import { PROMPT_VERSION } from '../src/clients/neatlogs/prompts.ts';
import { createTailorCore } from '../src/tailor/core.ts';
import { ProviderError } from '../src/tailor/provider-error.ts';
import { systemClock } from '../src/tailor/contract.ts';
import type { ModelProvider, SessionSnapshot } from '../src/agent-contract.ts';
import { travelBuyerTurn1, nonProposalRequests } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { countingProvider, fakeKnowledge, fixedClock, SESSION_ID, stubTools, type StubTools } from './helpers/agent.ts';
import { CrmStore, crmAdapter, crmKnowledge, scriptedCrmProvider } from './helpers/crm-adapter.ts';
import { appServer, SYNTHETIC_FIXTURE_PREFIX } from '../src/infrastructure/server.ts';
import { DEV_KEY, stubAgent, stubKnowledge, stubProvider, tempStore } from './helpers/backend.ts';

const SECRET = 'instrumentation-test-secret';
const service = createAgentService();
let n = 0;

interface Captured {
  result: Awaited<ReturnType<typeof service.handleTurn>>;
  spans: CapturedSpan[];
  root: CapturedSpan;
  named(name: string): CapturedSpan[];
  event(name: string): Record<string, unknown> | undefined;
  dump: string;
}

/** `turnRef` is the hashed turn id: the only turn identifier telemetry exports. */
function collect(t: Telemetry, turnRef: string, result: Captured['result']): Captured {
  assert.match(turnRef, /^t[0-9a-f]{16}$/);
  const spans = t.captured().filter(s => s.attributes['tailor.turn_id'] === turnRef);
  const root = spans.find(s => s.name === 'tailor.turn');
  assert.ok(root, 'one tailor.turn root per buyer turn');
  assert.equal(spans.filter(s => s.name === 'tailor.turn').length, 1);
  assert.ok(spans.every(s => s.traceId === root.traceId), 'every step belongs to the turn trace');
  return {
    result, spans, root,
    named: name => spans.filter(s => s.name === name),
    event: name => root.events.find(e => e.name === `tailor.${name}`)?.attributes,
    dump: JSON.stringify(spans),
  };
}

function snapshot(tools: StubTools, text: string): SessionSnapshot {
  return {
    id: SESSION_ID, version: tools.state.version, conversationVersion: 1, story: tools.state.story, dataset: structuredClone(tools.state.dataset),
    conversation: [{ id: 'b1', role: 'buyer', text, status: 'pending', at: '2026-10-11T12:00:00.000Z' }], state: 'active', expiresAt: '2026-10-11T16:00:00.000Z',
  };
}

async function neatlogsTurn(t: Telemetry, text: string, opts: { tools?: StubTools; provider?: ModelProvider } = {}): Promise<Captured> {
  const tools = opts.tools ?? stubTools();
  const original = opts.provider ?? countingProvider();
  // Synthetic accounting fixture, accuracy unverified: explicitly allow this known product journey.
  // Production live providers retain their mandatory separate classifier; these fakes isolate planner accounting.
  const provider: ModelProvider = original.mode === 'live' && !original.classifyPolicy ? { ...original, async classifyPolicy() { return { decision: { outcome: 'allow_demo_action', reason: 'demo_action' }, usage: null, latencyMs: 0, costUsd: 0 }; } } : original;
  const turnId = `turn-${++n}`;
  const tt = t.forTurn(turnId, SESSION_ID);
  const result = await tt.step('turn', { provider: provider.name, providerMode: provider.mode }, () =>
    service.handleTurn({ session: snapshot(tools, text), request: { text, clientTurnId: `ct-${n}` }, tools, knowledge: fakeKnowledge(), telemetry: tt, clock: fixedClock, provider }));
  return collect(t, tt.turnRef, result);
}

/** Buyer text, the raw session id (also embedded in product ids) and secrets must never be exported. */
function assertPrivate(c: Captured, buyerText: string) {
  for (const forbidden of [buyerText, SESSION_ID, SECRET]) assert.equal(c.dump.includes(forbidden), false, `telemetry leaks ${forbidden.slice(0, 40)}`);
  for (const s of c.spans) {
    for (const key of Object.keys(s.attributes)) assert.ok(key.startsWith('tailor.') || /^(neatlogs\.|openinference\.|session\.id$|service\.name$|telemetry\.sdk\.)/.test(key) || !/input|output|prompt|message|content/i.test(key), `${s.name}.${key}`);
  }
}

function attrs(span: CapturedSpan | undefined): Record<string, unknown> {
  assert.ok(span, 'span present');
  return span.attributes;
}

test('committed turn: context, attempt, tool, readback and response are recorded with ids/counts/versions only', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const c = await neatlogsTurn(t, travelBuyerTurn1.text);
    assert.equal(c.result.outcome, 'committed');
    const root = c.root.attributes;
    assert.equal(root['tailor.adapter_id'], 'neatlogs');
    assert.equal(root['tailor.knowledge_version'], 'test-1');
    assert.equal(root['tailor.prompt_version'], PROMPT_VERSION);
    assert.equal(root['tailor.decision'], 'plan→publishScenario v2→readback ok→committed');
    assert.equal(root['tailor.provider_calls'], 1);
    assert.equal(root['tailor.grounding_drops'], 0);

    const names = c.spans.filter(s => s.parentSpanId === c.root.spanId).map(s => s.name);
    assert.deepEqual(names, ['load_context', 'guard', 'retrieve_knowledge', 'context', 'model', 'guard', 'tool', 'readback'], 'child steps in execution order');

    const retrieval = attrs(c.named('retrieve_knowledge')[0]);
    assert.equal(retrieval['tailor.adapter_id'], 'neatlogs');
    assert.equal(retrieval['tailor.knowledge_version'], 'test-1');
    assert.equal(retrieval['tailor.prompt_version'], PROMPT_VERSION);
    assert.equal(typeof retrieval['tailor.record_count'], 'number');
    if ((retrieval['tailor.record_count'] as number) > 0) assert.match(String(retrieval['tailor.source_ids']), /^[a-z0-9-]+(,[a-z0-9-]+)*$/);

    const model = attrs(c.named('model')[0]);
    assert.equal(model['openinference.span.kind'], 'CHAIN');
    assert.equal(model['tailor.attempt'], 1);
    assert.equal(model['tailor.purpose'], 'plan');
    assert.equal(model['tailor.attempt_result'], 'ok');
    assert.equal(model['tailor.cost_known'], true, 'the mock is free: cost known');
    assert.equal(model['tailor.cost_usd'], 0);
    assert.equal(model['tailor.usage.available'], false, 'mock usage is not reported (unavailable, never zero tokens)');
    assert.equal(model['tailor.prompt_caching'], false);
    assert.equal(typeof model['tailor.latency_ms'], 'number');

    const tool = attrs(c.named('tool').find(s => s.attributes['tailor.result_state'] !== undefined));
    assert.equal(tool['openinference.span.kind'], 'TOOL');
    assert.equal(tool['tailor.tool_name'], 'publishScenario');
    assert.equal(tool['tailor.permitted'], true);
    assert.equal(tool['tailor.mutates'], true);
    assert.equal(tool['tailor.result_state'], 'committed');
    assert.equal(tool['tailor.version_before'], 1);
    assert.equal(tool['tailor.version_after'], 2);
    assert.equal(tool['tailor.arg_keys'], undefined, 'argument key names never leave the core');
    assert.ok((tool['tailor.arg_count'] as number) > 0);
    assert.ok((tool['tailor.arg_bytes'] as number) > 0);

    const readback = attrs(c.named('readback')[0]);
    assert.equal(readback['tailor.state'], 'ok');
    assert.equal(readback['tailor.version'], 2);
    assert.ok((readback['tailor.evidence_count'] as number) > 0);
    assert.match(String(readback['tailor.evidence_refs']), /^r[0-9a-f]{10}(,r[0-9a-f]{10})*$/, 'evidence ids are exported only as keyed hashes');

    assert.equal(c.event('validation')?.['tailor.state'], 'ok');
    assert.equal(c.event('commit')?.['tailor.version'], 2);
    assert.equal(c.event('commit')?.['tailor.version_before'], 1);
    const response = c.event('response')!;
    assert.equal(response['tailor.outcome'], 'committed');
    assert.equal(response['tailor.status'], 'applied');
    assert.ok((response['tailor.reply_chars'] as number) > 0);
    assert.equal(response['tailor.evidence_count'], 1);
    assert.equal(response['tailor.decision'], root['tailor.decision']);
    for (const k of ['tailor.grounding_drops', 'tailor.provider_calls', 'tailor.repairs', 'tailor.escalation_count', 'tailor.tool_calls', 'tailor.total_ms']) assert.equal(typeof response[k], 'number', k);
    assertPrivate(c, travelBuyerTurn1.text);
    assert.equal(t.diagnostics().droppedAttributes, 0, 'the core sends only allowlisted keys');
  } finally { await t.shutdown(); }
});

test('rejected → repair → committed: two attempts, two tool executions, issue codes and the repair in the decision trail', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const tools = stubTools();
    tools.script.push({ state: 'rejected', problems: [{ path: 'traces[0].spans[plan]', code: 'UNKNOWN_PARENT', message: `parent missing: ${travelBuyerTurn1.text}` }], version: 1 });
    const c = await neatlogsTurn(t, travelBuyerTurn1.text, { tools });
    assert.equal(c.result.outcome, 'committed');
    assert.equal(c.root.attributes['tailor.decision'], 'plan→publishScenario rejected→repair→publishScenario v2→readback ok→committed');
    const [plan, repair] = [attrs(c.named('model')[0]), attrs(c.named('repair')[0])];
    assert.deepEqual([plan['tailor.attempt'], plan['tailor.purpose']], [1, 'plan']);
    assert.deepEqual([repair['tailor.attempt'], repair['tailor.purpose'], repair['tailor.attempt_result']], [2, 'repair', 'ok']);
    const tools_ = c.named('tool').filter(s => s.attributes['tailor.result_state'] !== undefined).map(attrs);
    assert.deepEqual(tools_.map(a => [a['tailor.attempt'], a['tailor.result_state']]), [[1, 'rejected'], [2, 'committed']]);
    const validation = c.root.events.filter(e => e.name === 'tailor.validation').map(e => e.attributes);
    assert.equal(validation[0]!['tailor.state'], 'rejected');
    assert.equal(validation[0]!['tailor.issue_codes'], 'UNKNOWN_PARENT');
    assert.equal(validation[0]!['tailor.issue_count'], 1);
    assert.equal(validation[0]!['tailor.source'], 'tool');
    assert.equal(validation[1]!['tailor.state'], 'ok');
    assert.equal(c.event('response')!['tailor.repairs'], 1);
    assertPrivate(c, travelBuyerTurn1.text);
  } finally { await t.shutdown(); }
});

test('clarification, unsupported and refused paths: no tool step, outcome and decision recorded', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const cases: [string, string, string, string][] = [
      [nonProposalRequests.ambiguous.text, 'clarification', 'clarification', 'question'],
      [nonProposalRequests.explainOnly.text, 'unsupported', 'plan→unsupported', 'note'],
      [nonProposalRequests.injection.text, 'refused', 'refused', 'note'],
    ];
    for (const [text, outcome, decision, status] of cases) {
      const c = await neatlogsTurn(t, text);
      assert.equal(c.result.outcome, outcome);
      assert.equal(c.root.attributes['tailor.decision'], decision, outcome);
      assert.equal(c.named('tool').filter(s => s.attributes['tailor.result_state'] !== undefined).length, 0, `${outcome}: nothing executed`);
      assert.equal(c.event('response')!['tailor.outcome'], outcome);
      assert.equal(c.event('response')!['tailor.status'], status);
      if (outcome === 'unsupported') assert.equal(attrs(c.named('model')[0])['tailor.attempt_result'], 'ok');
      else { assert.equal(c.named('model').length, 0, 'blocking guard prevents planner dispatch'); assert.equal(c.named('retrieve_knowledge').length, 0, 'blocking guard prevents retrieval'); }
      assertPrivate(c, text);
    }
  } finally { await t.shutdown(); }
});

test('provider timeout (live-shaped provider): error kind, timeout flag, unknown cost with the reservation, provider_unavailable', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const provider: ModelProvider = {
      name: 'anthropic', model: 'claude-sonnet-5-5', mode: 'live', effort: 'medium',
      async complete() {
        const e = new ProviderError('timeout', 'The model call did not finish within the per-call time limit', { retryable: false, requestId: 'req_timeout01' });
        e.reservationUsd = 0.0925;
        throw e;
      },
    };
    const c = await neatlogsTurn(t, travelBuyerTurn1.text, { provider });
    assert.equal(c.result.outcome, 'provider_unavailable');
    assert.equal(c.root.attributes['tailor.decision'], 'plan:timeout→provider_unavailable');
    const model = attrs(c.named('model')[0]);
    assert.equal(model['tailor.status'], 'failed');
    assert.equal(model['tailor.attempt_result'], 'error');
    assert.equal(model['tailor.provider_error_kind'], 'timeout');
    assert.equal(model['tailor.timeout'], true);
    assert.equal(model['tailor.retryable'], false);
    assert.equal(model['tailor.cost_known'], false, 'a timed-out live call may have been billed: cost unknown');
    assert.equal(model['tailor.cost_usd'], undefined);
    assert.equal(model['tailor.reservation_usd'], 0.0925);
    assert.equal(model['tailor.request_id'], 'req_timeout01');
    assert.equal(model['tailor.model'], 'claude-sonnet-5-5');
    assert.equal(model['tailor.effort'], 'medium');
    assert.equal(c.named('tool').filter(s => s.attributes['tailor.result_state'] !== undefined).length, 0);
    assert.equal(c.event('response')!['tailor.status'], 'failed');
    assertPrivate(c, travelBuyerTurn1.text);
  } finally { await t.shutdown(); }
});

test('live-shaped success: token categories, known cost, reservation, stop reason and request id land on the attempt', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const provider: ModelProvider = {
      name: 'anthropic', model: 'claude-sonnet-5-5', mode: 'live', effort: 'medium',
      async complete() {
        return {
          action: { type: 'answer', text: 'Trace detail shows each step as a span.', knowledgeIds: ['trace-detail'] },
          usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, thinkingTokens: 120 },
          latencyMs: 812, requestId: 'req_live01', stopReason: 'end_turn', costUsd: 0.0054, reservationUsd: 0.0925,
        };
      },
    };
    const c = await neatlogsTurn(t, 'What does trace detail show?', { provider });
    assert.equal(c.result.outcome, 'answered');
    assert.equal(c.root.attributes['tailor.decision'], 'plan→answer:1_sources→answered');
    const model = attrs(c.named('model')[0]);
    assert.deepEqual(
      ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'thinking_tokens'].map(k => model[`tailor.usage.${k}`]),
      [1200, 300, 50, 0, 120]);
    assert.equal(model['tailor.cost_known'], true);
    assert.equal(model['tailor.cost_usd'], 0.0054);
    assert.equal(model['tailor.reservation_usd'], 0.0925);
    assert.equal(model['tailor.stop_reason'], 'end_turn');
    assert.equal(model['tailor.request_id'], 'req_live01');
    assert.equal(model['tailor.latency_ms'], 812);
  } finally { await t.shutdown(); }
});

test('R1-F8: the evidence explanation call is a `model` span with purpose=explain; the read tool keeps its `explain` span', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const plan = createMockProvider();
    const provider: ModelProvider = {
      name: 'anthropic', model: 'claude-sonnet-5-5', mode: 'live', effort: 'medium',
      complete: (request, signal) => plan.complete(request, signal),
      async explain() { return { explanation: { text: 'The attempt took 1500 ms.', spanIds: [] }, usage: null, latencyMs: 5 }; },
    };
    const c = await neatlogsTurn(t, travelBuyerTurn1.text, { provider });
    assert.equal(c.result.outcome, 'committed');
    const children = c.spans.filter(s => s.parentSpanId === c.root.spanId);
    assert.deepEqual(children.map(s => s.name), ['load_context', 'guard', 'retrieve_knowledge', 'context', 'model', 'guard', 'tool', 'readback', 'model']);
    assert.deepEqual(c.named('model').map(s => s.attributes['tailor.purpose']), ['plan', 'explain']);
    const read = c.named('explain');
    assert.equal(read.length, 1, 'only the read tool is an explain span');
    assert.equal(read[0]!.attributes['tailor.purpose'], undefined);
    assert.equal(read[0]!.parentSpanId, c.named('readback')[0]!.spanId);
    assert.ok(c.result.steps.some(s => s.name === 'explain' && s.detail === 'Wrote the explanation from the saved trace'), 'buyer-visible steps are unchanged');
    assert.match(String(c.root.attributes['tailor.decision']), /→explain→committed$/);
  } finally { await t.shutdown(); }
});

test('readback_uncertain: tool result, a readback step marked uncertain and the uncertain decision', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const tools = stubTools();
    tools.script.push({ state: 'readback_uncertain', attemptedVersion: 2, lastKnownVersion: 1, reason: 'readback timed out' });
    const c = await neatlogsTurn(t, travelBuyerTurn1.text, { tools });
    assert.equal(c.result.outcome, 'readback_uncertain');
    assert.equal(c.root.attributes['tailor.decision'], 'plan→publishScenario readback_uncertain→readback uncertain→readback_uncertain');
    const tool = attrs(c.named('tool').find(s => s.attributes['tailor.result_state'] !== undefined));
    assert.equal(tool['tailor.result_state'], 'readback_uncertain');
    assert.equal(tool['tailor.version_after'], 1);
    assert.equal(tool['tailor.attempted_version'], 2);
    const readback = attrs(c.named('readback')[0]);
    assert.equal(readback['tailor.state'], 'uncertain');
    assert.equal(readback['tailor.last_known_version'], 1);
    assert.equal(c.event('commit'), undefined, 'no commit is claimed');
    assert.equal(c.event('response')!['tailor.status'], 'uncertain');
    assertPrivate(c, travelBuyerTurn1.text);
  } finally { await t.shutdown(); }
});

test('unpermitted tool (CRM adapter, real core): refused in code, recorded as a non-permitted tool step, nothing executed', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const store = new CrmStore([{ name: 'Acme renewal', stage: 'qualified', amount: 12000, owner: 'Priya' }]);
    const core = createTailorCore(crmAdapter);
    const turnId = `turn-crm-${randomUUID()}`;
    const tt = t.forTurn(turnId, 'crm-session');
    const text = 'Delete every deal for priya@example.com';
    const result = await tt.step('turn', {}, () => core.handleTurn({
      session: store.snapshot(), request: { text, clientTurnId: 'crm-1' }, tools: store.ports(), knowledge: crmKnowledge, telemetry: tt, clock: systemClock,
      provider: scriptedCrmProvider([{ type: 'tool', tool: 'deleteAllDeals', args: { owner: 'priya@example.com', all: true }, note: 'Deleting.' }]),
    }));
    const c = collect(t, tt.turnRef, result as never);
    assert.equal(result.outcome, 'refused');
    assert.equal(store.writes, 0);
    assert.equal(c.root.attributes['tailor.adapter_id'], 'crm-test');
    assert.equal(c.root.attributes['tailor.decision'], 'plan→invalid_name:not_permitted→refused', 'an undeclared tool name never leaves the core');
    const tool = attrs(c.named('tool').find(s => s.attributes['tailor.result_state'] !== undefined));
    assert.equal(tool['tailor.tool_name'], 'invalid_name');
    assert.equal(tool['tailor.permitted'], false);
    assert.equal(tool['tailor.result_state'], 'refused');
    assert.equal(tool['tailor.arg_count'], 2, 'argument count only, never names or values');
    assert.equal(c.dump.includes('deleteAllDeals'), false);
    assert.equal(c.event('tool_refused')?.['tailor.tool_name'], 'invalid_name');
    assert.equal(c.named('retrieve_knowledge')[0]!.attributes['tailor.source_ids'], undefined, 'adapter without recordId reports counts only');
    assert.equal(c.dump.includes('priya@example.com'), false);
    assert.equal(c.dump.includes(text), false);
  } finally { await t.shutdown(); }
});

test('server: /api/dev/telemetry passes the new diagnostics through, with trace ids per turn; synthetic payloads are opt-in only', async () => {
  for (const syntheticPayloads of [false, true]) {
    const { store, cleanup } = tempStore();
    const telemetry = await createTelemetry({ mode: 'captured', secret: SECRET, syntheticPayloads });
    const trustedFixtures = new Set<string>();
    const server = appServer(store, { devKey: DEV_KEY, agent: stubAgent(), provider: stubProvider, knowledge: stubKnowledge, telemetry, syntheticFixture: id => trustedFixtures.has(id) });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const call = async (path: string, method = 'GET', data?: unknown, cookie = '') => {
        const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-tailor-dev-key': DEV_KEY, cookie, 'idempotency-key': randomUUID() }, body: data ? JSON.stringify(data) : undefined });
        return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] ?? cookie };
      };
      const plain = await call('/api/sessions', 'POST', { description: 'A fictional support bot' });
      const fixture = await call('/api/sessions', 'POST', { description: `${SYNTHETIC_FIXTURE_PREFIX}: fictional order bot` });
      trustedFixtures.add(fixture.data.id);
      const spoof = await call('/api/sessions', 'POST', { description: `${SYNTHETIC_FIXTURE_PREFIX}: buyer-authored label only` });
      const text = 'What does this demo show?';
      await call(`/api/sessions/${plain.data.id}/turns`, 'POST', { text, clientTurnId: randomUUID() }, plain.cookie);
      await call(`/api/sessions/${fixture.data.id}/turns`, 'POST', { text, clientTurnId: randomUUID() }, fixture.cookie);
      await call(`/api/sessions/${spoof.data.id}/turns`, 'POST', { text, clientTurnId: randomUUID() }, spoof.cookie);
      const d = (await call('/api/dev/telemetry')).data;
      for (const key of ['deliveryState', 'redactedValues', 'syntheticPayloads', 'endpoint', 'recentTurns']) assert.ok(key in d, key);
      assert.equal(d.syntheticPayloads, syntheticPayloads);
      assert.equal(d.recentTurns.length, 3);
      for (const r of d.recentTurns) assert.match(r.traceId, /^[0-9a-f]{32}$/);
      const roots = telemetry.captured().filter(s => s.name === 'tailor.turn');
      const withPayload = roots.filter(s => s.attributes['tailor.synthetic_input'] !== undefined);
      if (!syntheticPayloads) assert.equal(withPayload.length, 0, 'default off: no turn carries payloads, fixture or not');
      else {
        assert.equal(withPayload.length, 1, 'only the synthetic fixture session carries payloads');
        assert.equal(withPayload[0]!.attributes['tailor.synthetic_input'], text);
        assert.equal(withPayload[0]!.attributes['tailor.synthetic'], true);
        assert.equal(typeof withPayload[0]!.attributes['tailor.synthetic_output'], 'string');
      }
      const dump = JSON.stringify(telemetry.captured());
      assert.equal(dump.includes(plain.data.id), false);
      assert.equal(dump.includes(fixture.data.id), false);
      assert.equal(dump.includes(spoof.data.id), false);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
      await telemetry.shutdown();
      cleanup();
    }
  }
});
