// Hosted Neatlogs verification for the instrumented Tailor turn. SYNTHETIC data and the deterministic mock provider
// only: no model calls, no buyer data. Never prints a key.
//
//   Hosted:  TAILOR_TELEMETRY=neatlogs TAILOR_PROVIDER=mock node --env-file-if-exists=.env.local scripts/verify-hosted.ts --probe-trace=<doctor trace id>
//            Refuses unless the Doctor probe trace reads back in the Tailor project (identity gate), then boots the real
//            server on an ephemeral 127.0.0.1 port (temp SQLite under /tmp), runs clarify, build, explain and one refused turn, flushes
//            and reads every trace back by id.
//   Failure: env -u NEATLOGS_API_KEY -u ANTHROPIC_API_KEY node scripts/verify-hosted.ts --expect-failure
//            Fully offline: a 127.0.0.1 listener answers 401 to a fake key; delivery must be `failing` and flush not ok.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/infrastructure/store.ts';
import { appServer, SYNTHETIC_FIXTURE_PREFIX } from '../src/infrastructure/server.ts';
import { createTelemetry } from '../src/infrastructure/telemetry.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { createProvider } from '../src/clients/neatlogs/provider.ts';
import { loadKnowledge } from '../src/clients/neatlogs/knowledge.ts';
import { PROMPT_VERSION } from '../src/clients/neatlogs/prompts.ts';
import { travelBuyerTurn1, nonProposalRequests } from '../src/clients/neatlogs/examples/travel-booking.ts';
import type { DemoSession } from '../src/contracts.ts';

const EXPECTED_PROJECT = '18c4b4b6-0b1e-4d41-9405-7960fc2d0aa8';
const FORBIDDEN_PROJECT = 'a35a7334-258e-441c-b2e1-b8198a263f21';
const KNOWN_ORG = '8186e5df-b745-4e66-a01d-94c420459c43';
const HOSTED_ORIGIN = 'https://ingest.neatlogs.com';
const READBACK_MS = 60_000;

const args = process.argv.slice(2);
const expectFailure = args.includes('--expect-failure');
const probeTrace = args.find(a => a.startsWith('--probe-trace='))?.slice('--probe-trace='.length) ?? '';
// This script never needs a model key: drop it before any module could see it.
delete process.env.ANTHROPIC_API_KEY;
const apiKey = expectFailure ? 'nl_fake' : process.env.NEATLOGS_API_KEY ?? '';

function emit(label: string, value: unknown) {
  let line = `${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  if (apiKey && line.includes(apiKey)) line = line.replaceAll(apiKey, '[redacted]');
  console.log(line);
}
function refuse(message: string, code = 2): never { emit('REFUSED', message); process.exit(code); }

type TraceRead = { status: number; body?: Record<string, any> };
async function readTrace(origin: string, traceId: string): Promise<TraceRead> {
  const res = await fetch(`${origin}/api/traces/v3/${encodeURIComponent(traceId)}`, { headers: { 'x-api-key': apiKey }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!res.ok || res.status === 202) return { status: res.status };
  return { status: res.status, body: await res.json() as Record<string, any> };
}

emit('mode', expectFailure ? 'expect-failure (offline 401 listener, fake key)' : 'hosted (synthetic fixture, mock provider)');
emit('env', { TAILOR_TELEMETRY: process.env.TAILOR_TELEMETRY ?? 'unset', TAILOR_PROVIDER: process.env.TAILOR_PROVIDER ?? 'unset', NEATLOGS_API_KEY: process.env.NEATLOGS_API_KEY ? 'set' : 'missing', ANTHROPIC_API_KEY: 'removed from process env' });

let endpoint: string;
let stopListener = async () => {};
if (expectFailure) {
  if (process.env.NEATLOGS_API_KEY) refuse('--expect-failure is offline: run it with env -u NEATLOGS_API_KEY.');
  const listener = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); }); });
  await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  stopListener = () => new Promise<void>(r => listener.close(() => r()));
} else {
  if (process.env.TAILOR_TELEMETRY !== 'neatlogs') refuse('TAILOR_TELEMETRY must be neatlogs.');
  if (process.env.TAILOR_PROVIDER !== 'mock') refuse('TAILOR_PROVIDER must be mock (no paid model calls).');
  if (!apiKey) refuse('NEATLOGS_API_KEY is missing.');
  endpoint = process.env.NEATLOGS_ENDPOINT?.trim() || HOSTED_ORIGIN;
  if (new URL(endpoint).origin !== HOSTED_ORIGIN) refuse(`NEATLOGS_ENDPOINT must be unset or ${HOSTED_ORIGIN} for hosted verification.`);
  if (!/^[0-9a-f]{32}$/.test(probeTrace)) refuse('Pass --probe-trace=<trace id from `npm run doctor:probe`> so the key\'s project can be verified before sending.');
  // Identity gate: the Doctor trace exported with this key must read back in the Tailor project.
  const probe = await readTrace(HOSTED_ORIGIN, probeTrace);
  const projectId = probe.body?.projectId ?? null;
  emit('identity', { probeTraceId: probeTrace, httpStatus: probe.status, projectId, orgId: probe.body?.orgId ?? probe.body?.organizationId ?? null, expected: EXPECTED_PROJECT });
  if (projectId === FORBIDDEN_PROJECT) refuse('The key belongs to the learning sandbox project; nothing was sent.', 4);
  if (projectId !== EXPECTED_PROJECT) refuse('The key\'s project could not be confirmed as the Tailor project; nothing was sent.', 4);
}
const origin = new URL(endpoint).origin;

const dir = mkdtempSync(join('/tmp', 'tailor-verify-hosted-'));
const store = new Store(join(dir, 'sessions.sqlite'));
const devKey = randomBytes(32).toString('hex');
const telemetry = await createTelemetry({ mode: 'neatlogs', secret: store.secret, apiKey, endpoint, log: line => emit('stderr', line) });
const knowledge = loadKnowledge();
const provider = createProvider({ kind: 'mock' });
if (provider.mode !== 'mock') refuse('Provider is not the mock; aborting.');
const server = appServer(store, { devKey, agent: createAgentService(), provider, knowledge, telemetry });
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
emit('server', { url: base, provider: `${provider.name} (${provider.mode})`, telemetry: telemetry.mode, endpoint: origin, knowledge: knowledge.version, prompts: PROMPT_VERSION, data: dir });

async function call(path: string, method = 'GET', data?: unknown, cookie = '') {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-tailor-dev-key': devKey, cookie, 'idempotency-key': randomUUID() }, body: data ? JSON.stringify(data) : undefined });
  return { status: res.status, data: await res.json() as any, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? cookie };
}

let exitCode = 0;
try {
  const created = await call('/api/sessions', 'POST', { description: `${SYNTHETIC_FIXTURE_PREFIX}: fictional travel-booking agent` });
  if (created.status !== 201) throw new Error(`session create failed (${created.status})`);
  const cookie = created.cookie;
  const s: DemoSession = created.data;
  const relabelled = structuredClone(s.dataset);
  for (const t of relabelled.traces) t.label = `${SYNTHETIC_FIXTURE_PREFIX} ${t.label}`.slice(0, 60);
  const relabel = await call(`/api/dev/sessions/${s.id}/proposal`, 'POST', { expectedVersion: s.version, dataset: relabelled }, cookie);
  emit('fixture', { relabelHttp: relabel.status, labelsSynthetic: relabel.status === 200 && relabel.data.dataset.traces.every((t: { label: string }) => t.label.startsWith(SYNTHETIC_FIXTURE_PREFIX)) });

  const turns: { name: string; text: string; openTrace?: boolean }[] = expectFailure
    ? [{ name: 'clarify', text: nonProposalRequests.ambiguous.text }]
    : [
      { name: 'clarify', text: nonProposalRequests.ambiguous.text },
      { name: 'build', text: travelBuyerTurn1.text },
      { name: 'explain', text: 'Walk me through what happened in this trace.', openTrace: true },
      { name: 'refused', text: nonProposalRequests.injection.text },
    ];
  const outcomes: Record<string, unknown>[] = [];
  for (const turn of turns) {
    const current = await call(`/api/sessions/${s.id}`, 'GET', undefined, cookie);
    const openTraceId = turn.openTrace ? current.data.dataset.traces.find((t: { scenario: string }) => t.scenario === current.data.dataset.activeScenario)?.id ?? current.data.dataset.traces[0]?.id : undefined;
    const r = await call(`/api/sessions/${s.id}/turns`, 'POST', { text: turn.text, clientTurnId: randomUUID(), ...(openTraceId ? { openTraceId } : {}) }, cookie);
    outcomes.push({ turn: turn.name, http: r.status, outcome: r.data.outcome ?? r.data.error?.code, version: r.data.version });
  }
  emit('turns', outcomes);

  const flush = await telemetry.flush();
  emit('flush', flush);
  const diagnostics = (await call('/api/dev/telemetry')).data;
  emit('diagnostics', diagnostics);

  if (expectFailure) {
    const shown = diagnostics.deliveryState === 'failing' && flush.ok === false && flush.state === 'failing';
    emit('failure-demo', { deliveryState: diagnostics.deliveryState, flushOk: flush.ok, lastExportErrorStatus: diagnostics.lastExportError?.status ?? null, expectedFailureShown: shown });
    if (!shown) exitCode = 1;
  } else {
    if (!flush.ok) exitCode = 1;
    const traceIds: string[] = diagnostics.recentTurns.map((t: { traceId: string | null }) => t.traceId).filter(Boolean);
    if (traceIds.length !== turns.length) { emit('error', `expected ${turns.length} trace ids, got ${traceIds.length}`); exitCode = 1; }
    const deadline = Date.now() + READBACK_MS;
    const results = new Map<string, Record<string, unknown>>();
    while (Date.now() < deadline && results.size < traceIds.length) {
      for (const id of traceIds.filter(id => !results.has(id))) {
        try {
          const r = await readTrace(origin, id);
          if (r.body) {
            const spans: any[] = r.body.spans ?? [];
            const orgId = r.body.orgId ?? r.body.organizationId ?? KNOWN_ORG;
            results.set(id, {
              traceId: id, found: true, idMatches: r.body._id === id, projectId: r.body.projectId ?? null, status: r.body.status ?? null, spanCount: spans.length,
              spanNames: [...new Set(spans.map(sp => sp?.node_name))],
              dashboard: `https://app.neatlogs.com/traces?orgId=${orgId}&projectId=${r.body.projectId ?? EXPECTED_PROJECT}`,
            });
          } else if (r.status === 401 || r.status === 403) { results.set(id, { traceId: id, found: false, httpStatus: r.status }); }
        } catch (e) { emit('readback-retry', { traceId: id, error: (e as Error).name }); }
      }
      if (results.size < traceIds.length) await new Promise(r => setTimeout(r, 3000));
    }
    for (const id of traceIds) {
      const r = results.get(id) ?? { traceId: id, found: false, reason: 'not visible within 60 s' };
      emit('trace', r);
      if (!r.found || r.projectId !== EXPECTED_PROJECT) exitCode = 1;
    }
  }
} catch (e) {
  emit('error', (e as Error).message);
  exitCode = 1;
} finally {
  await new Promise<void>(r => server.close(() => r()));
  emit('shutdown', await telemetry.shutdown());
  store.close();
  rmSync(dir, { recursive: true, force: true });
  await stopListener();
}
emit('result', exitCode === 0 ? 'PASS' : 'FAIL');
process.exit(exitCode);
