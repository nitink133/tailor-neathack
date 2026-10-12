// Delivery-path tests (NIT-269 audit lane 3: L3-01..05, L4-10 follow-ups). NEVER touches the hosted service:
// a throwaway HTTP listener on 127.0.0.1 and the FAKE key `nl_fake_test_key` are the only export target.
// Run with: env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY node --test test/telemetry-delivery.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { verifyHostedTrace, RUNTIME_PROJECT_ID } from '../src/infrastructure/hosted-verification.ts';
import { createTelemetry, type Telemetry } from '../src/infrastructure/telemetry.ts';

const FAKE_KEY = 'nl_fake_test_key';
const HOST = '127.0.0.1';
const SECRET = 'delivery-test-secret';
const SESSION = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const BUYER = 'I am building a travel-booking agent for Acme Travel';

interface Seen { method: string | undefined; path: string | undefined; contentType: string | undefined; contentEncoding: string | undefined; hasApiKeyHeader: boolean; apiKeyIsFake: boolean; protobuf: Buffer }
interface Listener { seen: Seen[]; status: number; endpoint: string; close(): Promise<void> }

/** Dummy OTLP receiver on an ephemeral port (listen(0)). `status === 0` accepts the request and never answers (hang). */
async function listen(status: number): Promise<Listener> {
  const state: Listener = { seen: [], status, endpoint: '', close: async () => {} };
  const sockets = new Set<Socket>();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const wire = Buffer.concat(chunks);
    state.seen.push({
      method: req.method, path: req.url,
      contentType: req.headers['content-type'], contentEncoding: req.headers['content-encoding'],
      hasApiKeyHeader: typeof req.headers['x-api-key'] === 'string',
      apiKeyIsFake: req.headers['x-api-key'] === FAKE_KEY,
      protobuf: req.headers['content-encoding'] === 'gzip' ? gunzipSync(wire) : wire,
    });
    if (state.status === 0) return;
    res.writeHead(state.status, { 'content-type': 'application/x-protobuf' });
    res.end();
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  state.endpoint = `http://${HOST}:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });
  return state;
}

function hostedLike(rx: Listener, lines: string[], extra: Record<string, unknown> = {}) {
  // Safety: this suite must never be able to reach the hosted service.
  assert.equal(process.env.NEATLOGS_API_KEY, undefined, 'run with env -u NEATLOGS_API_KEY');
  assert.ok(rx.endpoint.startsWith('http://127.0.0.1:'));
  return { mode: 'neatlogs' as const, secret: SECRET, apiKey: FAKE_KEY, endpoint: rx.endpoint, flushIntervalSeconds: 60, log: (l: string) => { lines.push(l); }, ...extra };
}

async function runTurn(t: Telemetry, turnId = 'turn-0001') {
  const tt = t.forTurn(turnId, SESSION);
  return tt.step('turn', { provider: 'tailor-mock', providerMode: 'mock' }, async () => {
    await tt.step('model', { provider: 'tailor-mock', model: 'claude-sonnet-5-5', prompt: BUYER } as never, async () => { tt.recordUsage(null, 'claude-sonnet-5-5'); return { text: BUYER }; });
    return { outcome: 'answered', version: 1, conversationVersion: 1, echo: BUYER };
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('401 receiver: failures reach diagnostics, flush is NOT ok (also on the empty second flush), state is failing, one log line', async () => {
  const rx = await listen(401);
  const lines: string[] = [];
  const t = await createTelemetry(hostedLike(rx, lines));
  try {
    assert.equal(t.diagnostics().deliveryState, 'unknown', 'nothing delivered yet');
    const value = await runTurn(t);
    assert.equal(value.outcome, 'answered', 'exporter trouble never changes the turn result');

    const first = await t.flush();
    assert.equal(first.ok, false);
    assert.ok(first.failed > 0);
    assert.equal(first.state, 'failing');

    const d = t.diagnostics();
    assert.ok(d.exportFailures > 0, 'SDK delivery failures are folded into Tailor diagnostics');
    assert.equal(d.mode, 'neatlogs');
    assert.equal(d.deliveryState, 'failing');
    assert.equal(d.lastSuccessfulExportAt, null);
    assert.equal(d.lastExportError?.status, 401);

    // The failed batch is gone; an empty retry must not be mistaken for recovery.
    const second = await t.flush();
    assert.equal(second.ok, false, 'second (empty) flush must not report success after a rejected batch');
    assert.equal(second.state, 'failing');

    assert.equal(lines.length, 1, 'exactly one bounded stderr line per failure burst');
    assert.match(lines[0]!, /401/);
    for (const forbidden of [FAKE_KEY, BUYER, SESSION, SECRET]) assert.equal(lines[0]!.includes(forbidden), false);
    assert.ok(lines[0]!.length <= 200);

    assert.ok(rx.seen.length >= 1);
    assert.ok(rx.seen.every((s) => s.hasApiKeyHeader && s.apiKeyIsFake), 'the key header is sent (value never logged)');
  } finally { await t.shutdown(); await rx.close(); }
});

test('200 receiver: flush ok, healthy, gzip OTLP protobuf to /v1/traces with an x-api-key header, no payload leaks', async () => {
  const rx = await listen(200);
  const lines: string[] = [];
  const t = await createTelemetry(hostedLike(rx, lines));
  try {
    await runTurn(t);
    const r = await t.flush();
    assert.equal(r.ok, true);
    assert.ok(r.exported > 0);
    assert.equal(r.failed, 0);
    assert.equal(r.state, 'healthy');
    const d = t.diagnostics();
    assert.equal(d.deliveryState, 'healthy');
    assert.equal(d.exportFailures, 0);
    assert.equal(d.droppedSpans, 0);
    assert.equal(d.queued, 0, 'the SDK batch queue is inspectable and drained');
    assert.equal(d.lastExportError, null);
    assert.equal(typeof d.lastSuccessfulExportAt, 'string');
    assert.equal(lines.length, 0, 'healthy export logs nothing');

    assert.ok(rx.seen.length >= 1);
    for (const s of rx.seen) {
      assert.equal(s.method, 'POST');
      assert.equal(s.path, '/v1/traces');
      assert.equal(s.contentEncoding, 'gzip');
      assert.equal(s.contentType, 'application/x-protobuf');
      assert.equal(s.hasApiKeyHeader, true);
    }
    const body = Buffer.concat(rx.seen.map((s) => s.protobuf)).toString('latin1');
    assert.ok(body.includes('tailor.turn'), 'turn span name is on the wire');
    for (const forbidden of [BUYER, 'Acme', SESSION, SECRET, FAKE_KEY]) assert.equal(body.includes(forbidden), false, `wire payload leaks ${forbidden === FAKE_KEY ? 'the api key' : forbidden}`);
  } finally { await t.shutdown(); await rx.close(); }
});

test('background batch failures are surfaced without any flush(); a burst logs once', async () => {
  const rx = await listen(401);
  const lines: string[] = [];
  const t = await createTelemetry(hostedLike(rx, lines, { flushIntervalSeconds: 0.2 }));
  try {
    await runTurn(t, 'turn-bg-1');
    for (let i = 0; i < 40 && t.diagnostics().exportFailures === 0; i++) await wait(100);
    assert.ok(t.diagnostics().exportFailures > 0, 'background failure visible in diagnostics');
    assert.equal(t.diagnostics().deliveryState, 'failing');
    await runTurn(t, 'turn-bg-2');
    for (let i = 0; i < 20 && rx.seen.length < 2; i++) await wait(100);
    t.diagnostics();
    assert.equal(lines.length, 1, 'second failing batch in the same burst does not log again');
  } finally { await t.shutdown(); await rx.close(); }
});

test('recovery after a failure burst is degraded (history), and a new burst logs again', async () => {
  const rx = await listen(401);
  const lines: string[] = [];
  const t = await createTelemetry(hostedLike(rx, lines));
  try {
    await runTurn(t, 'turn-r-1');
    assert.equal((await t.flush()).state, 'failing');
    rx.status = 200;
    await runTurn(t, 'turn-r-2');
    const ok = await t.flush();
    assert.equal(ok.ok, true);
    assert.ok(ok.exported > 0);
    assert.equal(ok.state, 'degraded', 'delivery works again but the earlier loss is still reported');
    assert.equal(t.diagnostics().deliveryState, 'degraded');
    assert.equal(typeof t.diagnostics().lastSuccessfulExportAt, 'string');
    rx.status = 401;
    await runTurn(t, 'turn-r-3');
    assert.equal((await t.flush()).state, 'failing');
    assert.equal(lines.length, 2, 'one line for each distinct burst');
  } finally { await t.shutdown(); await rx.close(); }
});

test('a failing hosted exporter never changes a turn result or error identity', async () => {
  const rx = await listen(401);
  const lines: string[] = [];
  const t = await createTelemetry(hostedLike(rx, lines, { flushIntervalSeconds: 0.2 }));
  const reference = await createTelemetry({ mode: 'disabled', secret: SECRET });
  try {
    const expected = await runTurn(reference);
    const actual = await runTurn(t);
    assert.deepEqual(actual, expected);
    const tt = t.forTurn('turn-err-1', SESSION);
    const boom = Object.assign(new Error('save blew up'), { code: 'SAVE_FAILED' });
    await assert.rejects(tt.step('turn', {}, async () => { throw boom; }), (e) => e === boom);
    await wait(500);
    assert.deepEqual(await runTurn(t, 'turn-err-2'), expected);
  } finally { await t.shutdown(); await reference.shutdown(); await rx.close(); }
});

test('shutdown is bounded: a receiver that never answers cannot hang it, and the final state is reported', async () => {
  const rx = await listen(0);
  const lines: string[] = [];
  const t = await createTelemetry(hostedLike(rx, lines, { shutdownTimeoutMs: 400 }));
  try {
    await runTurn(t);
    const started = performance.now();
    const result = await t.shutdown();
    const took = performance.now() - started;
    assert.ok(took < 4000, `shutdown took ${Math.round(took)}ms`);
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.notEqual(result.state, 'healthy');
    assert.equal(lines.length, 1, 'one shutdown summary line');
    assert.equal(lines[0]!.includes(FAKE_KEY), false);
    assert.deepEqual(await t.shutdown(), result, 'repeat shutdown is a no-op returning the same result');
  } finally { await rx.close(); }
});

test('shutdown reports the final delivery state to stderr exactly once; diagnostics name the endpoint origin only', async () => {
  const rx = await listen(200);
  const lines: string[] = [];
  const t = await createTelemetry(hostedLike(rx, lines, { endpoint: `${rx.endpoint}/` }));
  try {
    const d = t.diagnostics();
    assert.equal(d.endpoint, rx.endpoint);
    assert.equal(d.syntheticPayloads, false);
    assert.equal(d.redactedValues, 0);
    await runTurn(t);
    assert.equal(lines.length, 0, 'a healthy run logs nothing before shutdown');
    const result = await t.shutdown();
    assert.equal(result.ok, true);
    assert.equal(result.state, 'healthy');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[tailor:telemetry\] shutdown: delivery state=healthy ok=true exported=\d+ failed=0 /);
    for (const forbidden of [FAKE_KEY, BUYER, SESSION, SECRET]) assert.equal(lines[0]!.includes(forbidden), false);
    await t.shutdown();
    assert.equal(lines.length, 1, 'a repeat shutdown does not log again');
  } finally { await rx.close(); }
});

test('captured mode is truly bounded: no InMemorySpanExporter is attached and 1,000 spans stay within the queue limit', async () => {
  const originalExport = InMemorySpanExporter.prototype.export;
  let inMemoryExports = 0;
  InMemorySpanExporter.prototype.export = function (this: InMemorySpanExporter, ...args: Parameters<InMemorySpanExporter['export']>) { inMemoryExports++; return originalExport.apply(this, args); };
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    for (let i = 0; i < 1000; i++) {
      const tt = t.forTurn(`turn-${String(i).padStart(4, '0')}`, SESSION);
      await tt.step('turn', {}, async () => ({ outcome: 'answered' }));
    }
    assert.equal(inMemoryExports, 0, 'no unbounded InMemorySpanExporter receives spans');
    assert.ok(t.captured().length <= 200, `captured stays bounded (got ${t.captured().length})`);
    assert.ok(t.captured().length > 0);
    const d = t.diagnostics();
    assert.equal(d.mode, 'captured');
    assert.equal(d.deliveryState, 'captured');
    assert.equal(d.queued, 0);
    const r = await t.flush();
    assert.equal(r.ok, true);
    assert.equal(r.state, 'captured');
  } finally { InMemorySpanExporter.prototype.export = originalExport; await t.shutdown(); }
});

test('recentTurns exposes opaque correlation ids (bounded, no secret or raw session id)', async () => {
  const t = await createTelemetry({ mode: 'captured', secret: SECRET });
  try {
    for (let i = 0; i < 30; i++) {
      const tt = t.forTurn(`turn-c-${i}`, SESSION);
      await tt.step('turn', {}, async () => ({ outcome: 'committed', version: 1 }));
    }
    const d = t.diagnostics();
    assert.equal(d.recentTurns.length, 20);
    const last = d.recentTurns.at(-1)!;
    assert.equal(last.turnId, 'turn-c-29');
    assert.match(last.correlationId, /^[0-9a-f]{16}$/);
    assert.equal(last.outcome, 'committed');
    assert.equal(last.status, 'ok');
    assert.equal(t.forTurn('x', SESSION).correlationId, last.correlationId);
    const dump = JSON.stringify(d);
    for (const forbidden of [SECRET, SESSION]) assert.equal(dump.includes(forbidden), false);
  } finally { await t.shutdown(); }
});

// R1-F1: the SDK adds one internal `neatlogs.trace.complete` marker span per trace. Decode what actually reached a 200
// receiver (the SDK's own generated OTLP proto root) and check that exportedSpans counts Tailor spans only.
const otlpRoot = createRequire(import.meta.url)('@opentelemetry/otlp-transformer/build/src/generated/root.js');
const ExportRequest = otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
interface WireSpan { name: string; internal: boolean }
function decodeWire(rx: Listener): WireSpan[] {
  const out: WireSpan[] = [];
  for (const seen of rx.seen) {
    const msg = ExportRequest.decode(seen.protobuf);
    for (const rs of msg.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) {
      const internal = (sp.attributes ?? []).some((a: { key: string; value?: { boolValue?: boolean } }) => a.key === 'neatlogs.internal' && a.value?.boolValue === true);
      out.push({ name: sp.name, internal });
    }
  }
  return out;
}

test('R1-F1: exportedSpans counts Tailor spans only; SDK marker spans are reported apart (decoded OTLP from a 200 receiver)', async () => {
  const rx = await listen(200);
  const lines: string[] = [];
  const t = await createTelemetry(hostedLike(rx, lines));
  try {
    await runTurn(t, 'turn-m-1');
    await runTurn(t, 'turn-m-2');
    const r = await t.flush();
    assert.equal(r.ok, true);
    const wire = decodeWire(rx);
    const tailor = wire.filter(w => !w.internal);
    const markers = wire.filter(w => w.internal);
    assert.equal(tailor.length, 4, `two turns x (tailor.turn + model): ${wire.map(w => w.name).join(',')}`);
    const d = t.diagnostics();
    assert.equal(d.exportedSpans, tailor.length, 'exportedSpans equals the Tailor spans on the wire');
    assert.equal(r.exported, tailor.length);
    assert.equal(d.markerSpans, markers.length, 'marker spans are counted separately');
    assert.equal(markers.length, 2, 'one SDK marker per trace reached the wire');
    assert.ok(markers.every(m => m.name === 'neatlogs.trace.complete'), markers.map(m => m.name).join(','));
  } finally { await t.shutdown(); await rx.close(); }
});


test('decoded offline OTLP proves native session grouping and independent complete receipts without hosted delivery claims', async () => {
  const rx = await listen(200);
  const t = await createTelemetry(hostedLike(rx, [], { versions: { codeVersion: 'test-build-1', adapterVersion: 'adapter-1', contractVersion: 'contract-1' } }));
  const expected = [];
  try {
    for (let n = 1; n <= 3; n++) {
      const tt = t.forTurn(`turn-wire-${n}`, SESSION, { demoId: 'demo-wire', requestId: `request-${n}`, clientTurnId: `client-${n}` });
      for (const op of ['turn', 'guard', 'context', 'model', 'repair', 'save', 'readback'] as const) tt.evidence.expect(op);
      await tt.step('turn', {}, async () => {
        await tt.step('guard', { policyOutcome: 'allow_demo_action', policyReason: 'demo_action', preventedDispatch: false }, async () => null);
        await tt.step('context', { contextBeforeBytes: 200, contextAfterBytes: 150, trimmedTurns: 1 }, async () => null);
        await assert.rejects(tt.step('model', { purpose: 'plan', attempt: 1 }, async () => { tt.recordUsage({ inputTokens: 10, outputTokens: 5 }, 'claude-sonnet-5-5'); throw new Error('PRIVATE_BUYER_WIRE_TEXT'); }));
        await tt.step('repair', { purpose: 'repair', attempt: 2 }, async () => null);
        await tt.step('save', { versionBefore: 1, versionAfter: 2 }, async () => null);
        await tt.step('readback', { version: 2 }, async () => null);
        return { outcome: 'committed', version: 2 };
      });
      expected.push({ tt, manifest: tt.evidence.snapshot() });
    }
    const flushed = await t.flush();
    assert.equal(flushed.ok, true); assert.equal(flushed.receiptState, 'unverified');
    const wireSpans: any[] = [];
    for (const packet of rx.seen) {
      const decoded = ExportRequest.decode(packet.protobuf);
      for (const rs of decoded.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) {
        wireSpans.push({ ...sp, traceId: Buffer.from(sp.traceId).toString('hex'), spanId: Buffer.from(sp.spanId).toString('hex'), parentSpanId: sp.parentSpanId?.length ? Buffer.from(sp.parentSpanId).toString('hex') : null });
      }
    }
    for (const { tt, manifest } of expected) {
      const traceId = t.diagnostics().recentTurns.find(turn => turn.turnRef === tt.turnRef)!.traceId!;
      const traceSpans = wireSpans.filter(s => s.traceId === traceId);
      const result = verifyHostedTrace({ _id: traceId, projectId: RUNTIME_PROJECT_ID, spans: traceSpans }, { traceId, sessionId: tt.correlationId, turnRef: tt.turnRef, demoRef: tt.demoRef, requestRef: tt.requestRef, manifest, outcome: 'committed', version: 2, requiredRootAttributes: ['tailor.code_version', 'tailor.adapter_version', 'tailor.contract_version'] });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.completeness.failed, ['model:1:end']);
    }
    assert.equal(new Set(expected.map(e => e.tt.sessionRef)).size, 1);
    assert.equal(JSON.stringify(wireSpans).includes('PRIVATE_BUYER_WIRE_TEXT'), false);
    assert.ok(rx.seen.every(packet => packet.apiKeyIsFake));
  } finally { await t.shutdown(); await rx.close(); }
});
