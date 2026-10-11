import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry, correlationIdFor, maskSpanData, cleanAttributes } from '../src/telemetry.ts';

const SECRET = 'test-secret-for-correlation';
const SESSION = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const COOKIE = `${SESSION}.deadbeefcafebabe`;
const BUYER = 'I am building a travel-booking agent for Acme Travel';

async function runTurn(t: Awaited<ReturnType<typeof createTelemetry>>) {
  const tt = t.forTurn('turn-0001', SESSION);
  const value = await tt.step('turn', { provider: 'mock', providerMode: 'mock' }, async () => {
    await tt.step('load_context', { conversationVersion: 2 }, async () => ({ text: BUYER }));
    await tt.step('retrieve_knowledge', { recordCount: 2, query: BUYER } as any, async () => [{ content: BUYER, id: 'k1' }]);
    await tt.step('model', { provider: 'mock', model: 'mock-1', prompt: BUYER, cookie: COOKIE } as any, async () => { tt.recordUsage(null, 'mock-1'); return { text: BUYER }; });
    await tt.step('validate', { problemCount: 0 }, async () => ({ ok: true }));
    await tt.step('save', { expectedVersion: 1 }, async () => ({ state: 'committed', version: 2 }));
    tt.event('publish.result', { state: 'committed', version: 2, detail: BUYER } as any);
    return { outcome: 'committed', version: 2, conversationVersion: 3, echo: BUYER };
  });
  return { tt, value };
}

test('captured mode records a WORKFLOW turn span and child step spans with allowlisted attributes only', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const { tt, value } = await runTurn(t);
    assert.equal(value.outcome, 'committed', 'step returns the wrapped value untouched');
    assert.equal(tt.correlationId, correlationIdFor(SECRET, SESSION));
    assert.equal(tt.correlationId.length, 16);
    const spans = t.captured();
    const root = spans.find(s => s.name === 'tailor.turn');
    assert.ok(root, 'turn span captured');
    assert.equal(root.parentSpanId, null);
    assert.equal(root.attributes['openinference.span.kind'], 'WORKFLOW');
    assert.equal(root.attributes['tailor.outcome'], 'committed');
    assert.equal(root.attributes['tailor.version'], 2);
    assert.equal(root.attributes['tailor.correlation_id'], tt.correlationId);
    assert.equal(typeof root.attributes['tailor.duration_ms'], 'number');
    const children = spans.filter(s => s.parentSpanId === root.spanId);
    assert.deepEqual(children.map(s => s.name).sort(), ['load_context', 'model', 'retrieve_knowledge', 'save', 'validate']);
    const kind = (n: string) => children.find(s => s.name === n)!.attributes['openinference.span.kind'];
    assert.deepEqual([kind('model'), kind('retrieve_knowledge'), kind('validate'), kind('save'), kind('load_context')], ['CHAIN', 'RETRIEVER', 'GUARDRAIL', 'TOOL', 'CHAIN']);
    const model = children.find(s => s.name === 'model')!;
    assert.equal(model.attributes['tailor.model_call'], true);
    assert.equal(model.attributes['tailor.usage.available'], false, 'missing usage is unavailable, not zero');
    assert.equal(model.attributes['tailor.usage.input_tokens'], undefined);
    assert.equal(model.attributes['tailor.dropped_attributes'], 2, 'prompt and cookie attributes were dropped');
    assert.ok(root.events.some(e => e.name === 'tailor.publish.result' && e.attributes['tailor.state'] === 'committed'));
    for (const s of spans) {
      for (const [key, v] of Object.entries(s.attributes)) {
        if (key.startsWith('tailor.')) assert.ok(typeof v !== 'string' || /^[A-Za-z0-9_.:\/-]{0,64}$/.test(v), `${key} is token-like`);
      }
      const dump = JSON.stringify(s);
      for (const secret of [BUYER, 'Acme', COOKIE, SESSION, 'deadbeef']) assert.equal(dump.includes(secret), false, `${s.name} leaks ${secret}`);
    }
  } finally { await t.shutdown(); }
});

test('recordUsage records provider-reported tokens only when given', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const tt = t.forTurn('turn-0002', SESSION);
    await tt.step('turn', {}, async () => tt.step('model', {}, async () => tt.recordUsage({ inputTokens: 120, outputTokens: 40 }, 'mock-1')));
    const model = t.captured().find(s => s.name === 'model')!;
    assert.equal(model.attributes['tailor.usage.available'], true);
    assert.equal(model.attributes['tailor.usage.input_tokens'], 120);
    assert.equal(model.attributes['tailor.usage.output_tokens'], 40);
    assert.equal(model.attributes['tailor.model'], 'mock-1');
  } finally { await t.shutdown(); }
});

test('step failures propagate the original error while the span records only a safe code', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    const tt = t.forTurn('turn-0003', SESSION);
    const original = Object.assign(new Error(`payload: ${BUYER}`), { code: 'SAVE_FAILED' });
    await assert.rejects(tt.step('turn', {}, async () => tt.step('save', {}, async () => { throw original; })), (e) => e === original);
    const save = t.captured().find(s => s.name === 'save')!;
    assert.equal(save.attributes['tailor.status'], 'failed');
    assert.equal(save.attributes['tailor.error_code'], 'SAVE_FAILED');
    assert.equal(JSON.stringify(t.captured()).includes(BUYER), false);
  } finally { await t.shutdown(); }
});

test('a throwing exporter never breaks step(); failures are counted with bounded retries', async () => {
  let attempts = 0;
  const exporter = {
    export() { attempts++; throw new Error('exporter down'); },
    async shutdown() { throw new Error('shutdown down'); },
  };
  const t = await createTelemetry({ mode: 'captured', secret: SECRET, exporter });
  try {
    const { value } = await runTurn(t);
    assert.equal(value.outcome, 'committed');
    const d = t.diagnostics();
    assert.ok(d.exportFailures >= 1);
    assert.equal(attempts, d.exportFailures * 3, 'one try plus LIMITS.telemetryExportRetries (2) per export');
    assert.equal(typeof (await t.flush()), 'boolean');
  } finally { await t.shutdown(); }
});

test('disabled mode is a no-op that still returns values and errors', async () => {
  const t = await createTelemetry({ mode: 'disabled', secret: SECRET });
  const tt = t.forTurn('turn-0004', SESSION);
  assert.equal(await tt.step('turn', {}, async () => 42), 42);
  await assert.rejects(tt.step('save', {}, async () => { throw new Error('x'); }), /x/);
  tt.event('anything', {}); tt.recordUsage(null, null);
  assert.deepEqual(t.captured(), []);
  assert.equal(await t.flush(), true);
  await t.shutdown();
  await assert.rejects(createTelemetry({ mode: 'neatlogs', secret: SECRET }), /apiKey/, 'neatlogs mode requires an explicit key');
});

test('mask and attribute allowlist drop payload-bearing keys and free text', () => {
  const { clean, dropped } = cleanAttributes({ outcome: 'committed', recordCount: 3, text: BUYER, provider: 'has spaces here', version: 2 });
  assert.deepEqual(clean, { 'tailor.outcome': 'committed', 'tailor.record_count': 3, 'tailor.version': 2 });
  assert.equal(dropped, 2);
  const masked = maskSpanData({
    name: 'model',
    attributes: { 'tailor.step': 'model', 'tailor.bad': BUYER, 'input.value': BUYER, 'output.value': '{}', 'neatlogs.span.kind': 'chain', 'neatlogs.retriever.query': BUYER, 'neatlogs.session.id': 'abc123' },
    events: [{ name: 'exception', attributes: { 'exception.message': BUYER } }, { name: 'tailor.note', attributes: { 'tailor.state': 'ok' } }],
    status: { code: 'ERROR', description: BUYER },
  }) as Record<string, any>;
  assert.deepEqual(masked.attributes, { 'tailor.step': 'model', 'neatlogs.span.kind': 'chain', 'neatlogs.session.id': 'abc123' });
  assert.deepEqual(masked.events.map((e: any) => e.name), ['tailor.note']);
  assert.equal(masked.status.description, null);
});
