import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntimeProject, TAILOR_RUNTIME_PROJECT } from '../src/infrastructure/telemetry-project.ts';
const config = { apiKey: 'fixture-not-a-key', projectId: TAILOR_RUNTIME_PROJECT, probeTraceId: '1'.repeat(32) };
test('runtime identity gate refuses sandbox, arbitrary destination and missing prior probe without a network call', async () => {
  let calls = 0; const read = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  await assert.rejects(verifyRuntimeProject({ ...config, projectId: 'a35a7334-258e-441c-b2e1-b8198a263f21' }, read));
  await assert.rejects(verifyRuntimeProject({ ...config, endpoint: 'https://unverified.invalid' }, read));
  await assert.rejects(verifyRuntimeProject({ ...config, probeTraceId: '' }, read));
  assert.equal(calls, 0);
});
test('runtime project must be established from independent readback using the same key before exporter creation', async () => {
  let method: string | undefined;
  const read = (async (_url, options) => { method = options?.method; assert.equal((options?.headers as Record<string, string>)['x-api-key'], config.apiKey); return Response.json({ projectId: TAILOR_RUNTIME_PROJECT }); }) as typeof fetch;
  await verifyRuntimeProject(config, read); assert.equal(method, undefined);
  for (const response of [new Response('{}', { status: 401 }), Response.json({ projectId: 'wrong' }), new Response('{}', { status: 202 })]) await assert.rejects(verifyRuntimeProject(config, (async () => response) as typeof fetch));
});
