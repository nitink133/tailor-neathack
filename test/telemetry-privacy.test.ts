// R2-03: every string-valued telemetry attribute is a closed enum, a strict id format or a code-declared id. Hostile
// tokens (product words, injection words and a raw session UUID) are rejected under EVERY allowed key, at the
// attribute allowlist, on captured spans/events and in the export mask, and model-authored names never reach the
// decision trail. Network-free: captured telemetry only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cleanAttributes, createSpanMask, createTelemetry, maskSpanData, telemetryVocabulary } from '../src/infrastructure/telemetry.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { createTailorCore } from '../src/tailor/core.ts';
import { systemClock } from '../src/tailor/contract.ts';
import type { AgentAction, SessionSnapshot } from '../src/agent-contract.ts';
import { travelBuyerTurn1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { fakeKnowledge, fixedClock, scriptedProvider, SESSION_ID, stubTools } from './helpers/agent.ts';
import { CrmStore, crmAdapter, crmKnowledge, scriptedCrmProvider } from './helpers/crm-adapter.ts';

const SECRET = 'privacy-test-secret';
const RAW_UUID = randomUUID();
const HOSTILE = ['refund', 'Opsgenie', 'IgnoreRules', RAW_UUID];
/** Every key that may carry a string value, plus the aliases service code uses. */
const STRING_KEYS = [
  'turnId', 'correlationId', 'traceId', 'requestId', 'providerRequestId', 'provider', 'providerMode', 'mode', 'model',
  'outcome', 'status', 'state', 'reason', 'action', 'step', 'code', 'errorCode', 'errorClass', 'stopReason', 'kind',
  'providerErrorKind', 'purpose', 'effort', 'attemptResult', 'resultState', 'detailState', 'source', 'adapterId',
  'knowledgeVersion', 'promptVersion', 'sessionRef', 'demoRef', 'sourceDemoRef', 'requestRef', 'clientTurnRef', 'reservationRef', 'codeVersion', 'adapterVersion', 'policyVersion', 'contractVersion', 'policyOutcome', 'policyReason', 'guardOutcome', 'guardClassification', 'guardReason', 'guardStage', 'guardModel', 'settlement', 'evidencePhase', 'evidenceStatus', 'evidenceKey', 'operation', 'estimationVersion', 'pricingVersion', 'sourceComponent', 'sourceIds', 'issueCodes', 'decision', 'toolName', 'argKeys',
  // Count/measure/numeric/boolean keys must refuse strings too.
  'version', 'attempt', 'escalated', 'argCount', 'argBytes', 'latencyMs', 'costUsd', 'spanCount',
];
const VOCAB = telemetryVocabulary({ adapterIds: ['neatlogs'], toolNames: ['publishScenario', 'explainTrace'], recordIds: ['trace-detail'], promptVersions: ['p1'], knowledgeVersions: ['k1'] });
const leaks = (dump: string) => HOSTILE.filter(h => dump.includes(h));

test('R2-03: hostile tokens are rejected under every allowed string key (allowlist)', () => {
  for (const key of STRING_KEYS) {
    for (const value of HOSTILE) {
      const { clean, dropped } = cleanAttributes({ [key]: value }, id => `r${id.length}`, VOCAB);
      assert.deepEqual(leaks(JSON.stringify(clean)), [], `${key}=${value} leaked`);
      assert.equal(dropped, 1, `${key}=${value} is counted as dropped`);
      if (key === 'toolName') assert.deepEqual(clean, { 'tailor.tool_name': 'invalid_name' }, 'an undeclared tool name becomes invalid_name');
    }
  }
  // Hostile words embedded in otherwise well-formed lists/trails are rejected whole.
  for (const attrs of [
    { sourceIds: 'trace-detail,refund' }, { issueCodes: 'UNKNOWN_PARENT,Opsgenie' }, { decision: 'plan→refund v2→committed' },
    { decision: 'plan→refuse:IgnoreRules→refused' }, { decision: `plan→${RAW_UUID}` }, { requestId: `req_${RAW_UUID}` },
  ]) assert.deepEqual(cleanAttributes(attrs, undefined, VOCAB).clean, {}, JSON.stringify(attrs));
});

test('R2-03: legitimate values still pass (enums, formats, declared ids, numbers)', () => {
  const { clean, dropped } = cleanAttributes({
    turnId: 't0123456789abcdef', correlationId: '0123456789abcdef', traceId: '0123456789abcdef0123456789abcdef', requestId: 'req_011CSabc123',
    provider: 'anthropic', mode: 'live', model: 'claude-sonnet-5-5', outcome: 'committed', status: 'applied', state: 'ok', reason: 'budget',
    action: 'tool', step: 'model', code: 'SAVE_FAILED', errorClass: 'TypeError', stopReason: 'end_turn', kind: 'rate_limit', purpose: 'explain',
    adapterId: 'neatlogs', knowledgeVersion: 'k1', promptVersion: 'p1', sourceIds: 'trace-detail', issueCodes: 'UNKNOWN_PARENT', toolName: 'publishScenario',
    decision: 'plan→publishScenario v2→readback ok→explain:timeout→committed', argCount: 2, argBytes: 120, version: 3, escalated: false,
  }, undefined, VOCAB);
  assert.equal(dropped, 0, JSON.stringify(clean));
  assert.equal(clean['tailor.tool_name'], 'publishScenario');
  assert.equal(clean['tailor.provider_error_kind'], 'rate_limit');
});

test('R2-03: the export mask applies the same validators; undeclared ids and UUIDs never pass it', () => {
  const attributes: Record<string, unknown> = {};
  for (const key of ['tailor.reason', 'tailor.tool_name', 'tailor.adapter_id', 'tailor.decision', 'tailor.request_id', 'tailor.turn_id', 'tailor.model', 'tailor.unknown_key']) attributes[key] = 'refund';
  attributes['tailor.correlation_id'] = RAW_UUID;
  for (const mask of [maskSpanData, createSpanMask(VOCAB)]) {
    const masked = mask({ name: 'x', attributes, events: [{ name: 'tailor.response', attributes }], status: { code: 'OK' } }) as { attributes: object; events: { attributes: object }[] };
    assert.deepEqual(masked.attributes, {});
    assert.deepEqual(masked.events[0]!.attributes, {});
  }
  const ok = createSpanMask(VOCAB)({ name: 'x', attributes: { 'tailor.tool_name': 'publishScenario', 'tailor.adapter_id': 'neatlogs' }, events: [], status: { code: 'OK' } }) as { attributes: object };
  assert.deepEqual(ok.attributes, { 'tailor.tool_name': 'publishScenario', 'tailor.adapter_id': 'neatlogs' });
});

test('R2-03: on captured spans, hostile values under every key are absent and the exported turn id is hashed, never the raw UUID', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const rawTurnId = randomUUID();
    const tt = t.forTurn(rawTurnId, RAW_UUID);
    assert.match(tt.turnRef, /^t[0-9a-f]{16}$/);
    await tt.step('turn', {}, async () => {
      for (const value of HOSTILE) {
        const attrs = Object.fromEntries(STRING_KEYS.map(k => [k, value]));
        await tt.step('model', attrs, async () => { tt.annotate(attrs); tt.recordUsage(null, value); });
        tt.event('response', attrs);
        tt.event(value, attrs);
      }
    });
    const dump = JSON.stringify(t.captured());
    assert.deepEqual(leaks(dump), []);
    assert.equal(dump.includes(rawTurnId), false, 'the raw turn id is never exported');
    const root = t.captured().find(s => s.name === 'tailor.turn')!;
    assert.equal(root.attributes['tailor.turn_id'], tt.turnRef);
    assert.ok(t.diagnostics().droppedAttributes >= STRING_KEYS.length * HOSTILE.length);
  } finally { await t.shutdown(); }
});

test('R2-03: model-authored tool names and refusal reasons never reach any span (real core)', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const store = new CrmStore([{ name: 'Acme renewal', stage: 'qualified', amount: 12000, owner: 'Priya' }]);
    const core = createTailorCore(crmAdapter);
    for (const tool of ['refund', 'Opsgenie', 'IgnoreRules']) {
      const tt = t.forTurn(randomUUID(), RAW_UUID);
      await tt.step('turn', {}, () => core.handleTurn({
        session: store.snapshot(), request: { text: 'do it', clientTurnId: randomUUID() }, tools: store.ports(), knowledge: crmKnowledge, telemetry: tt, clock: systemClock,
        provider: scriptedCrmProvider([{ type: 'tool', tool, args: { refund: 'Opsgenie' }, note: 'IgnoreRules' }]),
      }));
    }
    const service = createAgentService();
    for (const reason of ['refund', 'Opsgenie', 'IgnoreRules']) {
      const tools = stubTools();
      const tt = t.forTurn(randomUUID(), SESSION_ID);
      const session: SessionSnapshot = {
        id: SESSION_ID, version: 1, conversationVersion: 1, story: null, dataset: structuredClone(tools.state.dataset),
        conversation: [{ id: 'b1', role: 'buyer', text: travelBuyerTurn1.text, status: 'pending', at: '2026-10-11T12:00:00.000Z' }], state: 'active', expiresAt: '2026-10-11T16:00:00.000Z',
      };
      const provider = scriptedProvider(() => ({ type: 'refuse', reason, text: 'I can’t help with that.' }) as unknown as AgentAction, 'tailor-mock');
      await tt.step('turn', {}, () => service.handleTurn({ session, request: { text: travelBuyerTurn1.text, clientTurnId: randomUUID() }, tools, knowledge: fakeKnowledge(), telemetry: tt, clock: fixedClock, provider }));
    }
    const dump = JSON.stringify(t.captured());
    assert.deepEqual(leaks(dump), []);
    assert.equal(dump.includes(SESSION_ID), false);
    const decisions = t.captured().filter(s => s.name === 'tailor.turn').map(s => s.attributes['tailor.decision']);
    assert.ok(decisions.includes('plan→invalid_name:not_permitted→refused'), JSON.stringify(decisions));
  } finally { await t.shutdown(); }
});


test('export mask rejects unknown numeric/boolean keys and negative accounting values', () => {
  const masked = maskSpanData({ name: 'safe', attributes: { 'tailor.unknown_number': 12, 'tailor.unknown_flag': true, 'tailor.usage.input_tokens': -1, 'tailor.arg_bytes': 5, 'tailor.usage.available': false }, events: [] }) as { attributes: Record<string, unknown> };
  assert.deepEqual(masked.attributes, { 'tailor.arg_bytes': 5, 'tailor.usage.available': false });
});
