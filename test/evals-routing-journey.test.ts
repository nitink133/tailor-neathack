import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { harness } from './helpers/backend.ts';
import { qualityWorkflowProposal } from '../src/clients/neatlogs/eval-fixtures.ts';

for (const workflow of ['retrieval', 'extraction', 'support'] as const) {
  test(`${workflow} buyer: executed checks and human quality review survive restart with immutable, scoped evidence`, async () => {
    const h = await harness();
    try {
      const owner = await h.call('/api/browser-session/demos', 'POST', { description: `Fictional ${workflow} agent` });
      const id = owner.data.id;
      assert.equal(h.store.publish(id, qualityWorkflowProposal(workflow, 1)).state, 'committed');
      const saved = h.store.read(id);
      const body = {
        clientOperationId: randomUUID(), datasetVersion: saved.version, name: `${workflow} acceptance review`,
        traceIds: saved.dataset.traces.map(t => t.id),
        questions: [{ key: 'useful', label: 'Does this answer meet the user requirement?', type: 'yes_no', required: true, reviewer: 'buyer' }],
        checks: [{ key: 'execution', label: 'No execution errors', kind: 'no_error' },
          { key: 'latency', label: 'Under 200 ms', kind: 'latency', maxDurationMs: 200 },
          { key: 'fields', label: 'Required outcome field', kind: 'required_output_fields', fields: [workflow === 'extraction' ? 'dueDate' : 'answer'] }],
      };
      const created = await h.call(`/api/sessions/${id}/evaluations`, 'POST', body, owner.cookie);
      assert.equal(created.status, 201);
      const evaluation = created.data.evaluation;
      assert.equal(evaluation.responses.length, 0, 'executed checks never masquerade as a human or AI judgment');
      assert.equal(evaluation.checkResults.length, 3);
      assert.equal(evaluation.checkResults.find((r: any) => r.checkKey === 'execution').passed, true);
      assert.equal(evaluation.checkResults.find((r: any) => r.checkKey === 'latency').observed.elapsedMs, 100);
      assert.equal(evaluation.checkResults.find((r: any) => r.checkKey === 'fields').passed, workflow !== 'extraction');
      assert.ok(evaluation.checkResults.every((r: any) => r.source === 'deterministic_check' && r.provenance === 'local_trace_snapshot'));
      assert.deepEqual((await h.call(`/api/sessions/${id}/evaluations`, 'POST', body, owner.cookie)).data, created.data);
      const review = { clientOperationId: randomUUID(), datasetVersion: saved.version, expectedVersion: 1,
        responses: [{ traceId: evaluation.traceIds[0], questionKey: 'useful', value: false }] };
      const reviewed = await h.call(`/api/sessions/${id}/evaluations/${evaluation.id}/reviews`, 'POST', review, owner.cookie);
      assert.equal(reviewed.status, 200); assert.equal(reviewed.data.evaluation.state, 'completed');
      assert.equal(reviewed.data.evaluation.aggregates[0].value, 0, 'a technical pass can accompany a failed human quality review');
      assert.deepEqual(reviewed.data.evaluation.checkResults, evaluation.checkResults);
      await h.restart();
      assert.deepEqual((await h.call(`/api/sessions/${id}/evaluations/${evaluation.id}`, 'GET', undefined, owner.cookie)).data, reviewed.data);
      const stranger = await h.call('/api/browser-session/demos', 'POST', { description: 'Another buyer' });
      assert.equal((await h.call(`/api/sessions/${id}/evaluations/${evaluation.id}`, 'GET', undefined, stranger.cookie)).status, 404);
      const other = await h.call('/api/browser-session/demos', 'POST', { description: 'Other owned agent' }, owner.cookie);
      assert.equal((await h.call(`/api/sessions/${other.data.id}/evaluations/${evaluation.id}`, 'GET', undefined, owner.cookie)).status, 404);
      const dataset = structuredClone(saved.dataset); dataset.traces[0]!.output = { synthetic: true, changed: true };
      dataset.traces[0]!.spans.find(s => s.parentId === null)!.output = dataset.traces[0]!.output;
      assert.equal((await h.call(`/api/dev/sessions/${id}/proposal`, 'POST', { expectedVersion: saved.version, dataset }, owner.cookie)).status, 200);
      const stale = await h.call(`/api/sessions/${id}/evaluations/${evaluation.id}`, 'GET', undefined, owner.cookie);
      assert.equal(stale.data.stale, true);
      assert.deepEqual(stale.data.evaluation.checkResults, evaluation.checkResults);
      assert.deepEqual(stale.data.evaluation.traceSnapshot, evaluation.traceSnapshot);
      assert.equal((await h.call(`/api/sessions/${id}/evaluations/${evaluation.id}/reviews`, 'POST', { ...review, clientOperationId: randomUUID(), expectedVersion: 2, datasetVersion: saved.version + 1 }, owner.cookie)).status, 409);
      assert.equal(h.agent.calls, 0, 'this complete review journey requires no model calls');
    } finally { await h.close(); }
  });
}

test('routing API previews real matched evidence, rejects real destinations, and persists without dispatch or models', async () => {
  const h = await harness();
  try {
    const owner = await h.call('/api/sessions', 'POST', { description: 'Fictional operations agent', scenario: 'recovered' });
    const s = owner.data;
    const body = { clientOperationId: randomUUID(), datasetVersion: s.version, name: 'Error ownership preview',
      traceIds: s.dataset.traces.map((t: any) => t.id), rule: { type: 'per_event' }, recipient: 'Engineering on-call',
      destination: 'slack', severity: 'warning', cooldownMs: 1000 };
    const created = await h.call(`/api/sessions/${s.id}/routing`, 'POST', body, owner.cookie);
    assert.equal(created.status, 201);
    const p = created.data.preview;
    assert.equal(p.delivery, 'simulated'); assert.equal(p.mode, 'synthetic');
    assert.ok(p.matches.length > 0);
    for (const match of p.matches) {
      const trace = p.traceSnapshot.find((t: any) => t.id === match.traceId);
      assert.deepEqual(match.spanIds, trace.spans.filter((span: any) => span.status === 'ERROR').map((span: any) => span.id));
      assert.equal(match.owner, 'Engineering on-call');
    }
    assert.match(p.deliveryNote, /no message was sent/i);
    assert.deepEqual((await h.call(`/api/sessions/${s.id}/routing`, 'POST', body, owner.cookie)).data, created.data);
    for (const forbidden of [{ recipient: 'real.person@example.com' }, { destination: 'https://example.com/webhook' }, { rule: { type: 'javascript', code: 'fetch("https://example.com")' } }]) {
      assert.equal((await h.call(`/api/sessions/${s.id}/routing`, 'POST', { ...body, clientOperationId: randomUUID(), ...forbidden }, owner.cookie)).status, 400);
    }
    const threshold = await h.call(`/api/sessions/${s.id}/routing`, 'POST', { ...body, clientOperationId: randomUUID(), rule: { type: 'threshold', failedTraceThreshold: 4 } }, owner.cookie);
    assert.equal(threshold.status, 201); assert.equal(threshold.data.preview.conditionMet, false);
    assert.equal(threshold.data.preview.delivery, 'not_triggered'); assert.deepEqual(threshold.data.preview.matches, []);
    await h.restart();
    assert.deepEqual((await h.call(`/api/sessions/${s.id}/routing/${p.id}`, 'GET', undefined, owner.cookie)).data, created.data);
    const stranger = await h.call('/api/browser-session/demos', 'POST', { description: 'Another buyer' });
    assert.equal((await h.call(`/api/sessions/${s.id}/routing/${p.id}`, 'GET', undefined, stranger.cookie)).status, 404);
    h.store.applyScenario(s.id, 'exhausted', s.version);
    const stale = await h.call(`/api/sessions/${s.id}/routing/${p.id}`, 'GET', undefined, owner.cookie);
    assert.equal(stale.data.stale, true); assert.deepEqual(stale.data.preview, p);
    assert.equal(h.agent.calls, 0);
  } finally { await h.close(); }
});
