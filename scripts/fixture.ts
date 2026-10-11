// Developer harness: exercises only create / developer-proposal / readback routes. No agent turns, no models.
// `--in-process` starts a disposable server (temp SQLite, random dev key, disabled telemetry) on an ephemeral
// loopback port; otherwise it targets TAILOR_URL with TAILOR_DEV_KEY.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoSession } from '../src/contracts.ts';

const args = process.argv.slice(2);
const inProcess = args.includes('--in-process');
const action = args.find(a => !a.startsWith('--')) ?? 'validate';
let origin = process.env.TAILOR_URL ?? 'http://127.0.0.1:4321';
let key = process.env.TAILOR_DEV_KEY;
let stop = async () => {};

if (inProcess) {
  const { Store } = await import('../src/store.ts');
  const { appServer } = await import('../src/server.ts');
  const { createTelemetry } = await import('../src/telemetry.ts');
  const dir = mkdtempSync(join(tmpdir(), 'tailor-fixture-'));
  const store = new Store(join(dir, 'sessions.sqlite'));
  key = randomBytes(32).toString('hex');
  const telemetry = await createTelemetry({ mode: 'disabled', secret: randomBytes(32).toString('hex') });
  const unused = async (): Promise<never> => { throw new Error('The fixture harness never runs agent turns.'); };
  const server = appServer(store, {
    devKey: key, telemetry,
    agent: { handleTurn: unused },
    provider: { name: 'none', model: null, mode: 'mock', complete: unused },
    knowledge: { version: 'none', select: () => [], get: () => undefined, all: () => [] },
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  stop = async () => { await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); };
}

async function call(path: string, method = 'GET', data?: unknown, cookie = '') {
  const res = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', 'x-tailor-dev-key': key ?? '', cookie, 'idempotency-key': randomUUID() }, body: data ? JSON.stringify(data) : undefined });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] ?? cookie };
}
try {
  if (!key) throw new Error('Set TAILOR_DEV_KEY to the same local developer key used by the server, or pass --in-process. It is never printed.');
  if (action === 'inspect') {
    const result = await call('/api/dev/sessions'); if (result.status !== 200) throw new Error(result.data.error?.message);
    console.log(JSON.stringify(result.data, null, 2));
  } else if (action === 'validate') {
    const a = await call('/api/sessions', 'POST', { description: 'Fictional validation shop A', scenario: 'recovered' });
    const b = await call('/api/sessions', 'POST', { description: 'Fictional validation shop B', scenario: 'exhausted' });
    if (a.status !== 201 || b.status !== 201) throw new Error('Session creation failed.');
    const s: DemoSession = a.data;
    const path = `/api/dev/sessions/${s.id}/proposal`;
    const bad = structuredClone(s.dataset); bad.traces[0]!.spans[1]!.parentId = 'unknown-parent';
    const invalid = await call(path, 'POST', { expectedVersion: 1, dataset: bad }, a.cookie);
    const intact = await call(`/api/sessions/${s.id}`, 'GET', undefined, a.cookie);
    const foreignIds = await call(path, 'POST', { expectedVersion: 1, dataset: b.data.dataset }, a.cookie);
    const corrected = structuredClone(s.dataset); corrected.activeScenario = 'exhausted';
    const accepted = await call(path, 'POST', { expectedVersion: 1, dataset: corrected }, a.cookie);
    const stale = await call(path, 'POST', { expectedVersion: 1, dataset: corrected }, a.cookie);
    const readback = await call(`/api/sessions/${s.id}`, 'GET', undefined, a.cookie);
    const foreignRead = await call(`/api/sessions/${s.id}`, 'GET', undefined, b.cookie);
    const foreignWrite = await call(path, 'POST', { expectedVersion: 2, dataset: corrected }, b.cookie);
    const checks = { invalidRejected: invalid.status === 422, invalidLeavesVersion: intact.data.version === 1, crossSessionIdsRejected: foreignIds.status === 422, correctedAccepted: accepted.status === 200, readbackVersion: readback.data.version === 2, readbackScenario: readback.data.dataset.activeScenario === 'exhausted', staleRejected: stale.status === 409, foreignReadDenied: foreignRead.status === 404, foreignWriteDenied: foreignWrite.status === 404 };
    console.log(JSON.stringify({ synthetic: true, sessions: [s.id, b.data.id], checks }, null, 2));
    if (Object.values(checks).some(x => !x)) process.exitCode = 1;
  } else throw new Error('Supported harness actions: validate, inspect. No arbitrary personalization.');
} finally { await stop(); }
