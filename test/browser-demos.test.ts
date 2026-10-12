import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { harness, tempStore, op, type Harness } from './helpers/backend.ts';
import { travelProposalV1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import type { DemoSwitchChoice } from '../src/tailor/demo-contract.ts';
import { Store, Failure } from '../src/infrastructure/store.ts';
import { qualityWorkflowProposal } from '../src/clients/neatlogs/eval-fixtures.ts';
import { createProvider } from '../src/clients/neatlogs/provider.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { loadKnowledge } from '../src/clients/neatlogs/knowledge.ts';
import { travelProposalV2 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { CORE_LIMITS } from '../src/tailor/contract.ts';

const turn = (text: string) => ({ text, clientTurnId: randomUUID() });
async function established(h: Harness) {
  const created = await h.call('/api/browser-session/demos', 'POST', { description: 'Fictional travel-booking agent' });
  assert.equal(created.status, 201);
  const built = await h.call(`/api/sessions/${created.data.id}/turns`, 'POST', turn('Build a travel-booking agent'), created.cookie);
  assert.equal(built.data.outcome, 'committed');
  return created;
}
async function askSwitch(h: Harness, id: string, cookie: string) {
  h.agent.script = async input => {
    const proposal = { ...structuredClone(travelProposalV1), expectedVersion: input.session.version,
      story: { domain: 'insurance claims agent', summary: 'A fictional insurance lookup with a retry.', assumptions: [] },
    };
    const prepared = await input.tools.prepareScenario!(proposal);
    assert.equal(prepared.state, 'confirmation_required');
    if (prepared.state !== 'confirmation_required') throw new Error('Expected confirmation');
    return { outcome: 'clarification', clarification: prepared.confirmation,
      messages: [{ role: 'tailor', status: 'question', text: prepared.confirmation.question, clarification: prepared.confirmation }],
      steps: [], execution: { mode: 'mock', provider: 'stub', model: null },
    };
  };
  const asked = await h.call(`/api/sessions/${id}/turns`, 'POST', turn('Switch to an insurance claims agent'), cookie);
  assert.equal(asked.data.outcome, 'clarification');
  assert.deepEqual(asked.data.clarification.choices.map((c: any) => c.id), ['adapt_current', 'start_separate', 'keep_current']);
  return asked.data.clarification;
}

test('browser owner preserves separate demos, upgrades verified legacy cookies and isolates other visitors', async () => {
  const h = await harness();
  try {
    const legacy = await h.call('/api/sessions', 'POST', { description: 'Legacy fictional workflow' });
    const upgraded = await h.call('/api/browser-session', 'GET', undefined, legacy.cookie);
    assert.equal(upgraded.status, 200); assert.equal(upgraded.data.demos.length, 1);
    const second = await h.call('/api/browser-session/demos', 'POST', { description: 'Second fictional workflow' }, upgraded.cookie);
    assert.equal(second.status, 201);
    const browser = await h.call('/api/browser-session', 'GET', undefined, second.cookie);
    assert.deepEqual(browser.data.demos.map((d: any) => d.id), [legacy.data.id, second.data.id]);
    assert.equal(browser.data.activeDemoId, second.data.id);
    assert.equal((await h.call(`/api/sessions/${legacy.data.id}`, 'GET', undefined, second.cookie)).status, 200);
    const stranger = await h.call('/api/browser-session/demos', 'POST', { description: 'Another visitor' });
    assert.equal((await h.call(`/api/sessions/${legacy.data.id}`, 'GET', undefined, stranger.cookie)).status, 404);
    assert.equal((await h.call('/api/browser-session/active-demo', 'POST', { demoId: legacy.data.id, expectedVersion: 1 }, stranger.cookie)).status, 409);
    const selected = await h.call('/api/browser-session/active-demo', 'POST', { demoId: legacy.data.id, expectedVersion: browser.data.version }, second.cookie);
    assert.equal(selected.data.activeDemoId, legacy.data.id);
    await h.restart();
    assert.equal((await h.call('/api/session', 'GET', undefined, second.cookie)).data.id, legacy.data.id);
    const ended = await h.call(`/api/sessions/${legacy.data.id}/end`, 'POST', undefined, second.cookie);
    assert.equal(ended.status, 200); assert.equal(ended.setCookie, null, 'ending one child retains ownership cookie');
    assert.equal((await h.call(`/api/sessions/${second.data.id}`, 'GET', undefined, second.cookie)).status, 200);
  } finally { await h.close(); }
});

for (const choice of ['adapt_current', 'start_separate', 'keep_current'] as DemoSwitchChoice[]) test(`persisted material switch ${choice} is explicit, version-bound and idempotent`, async () => {
  const h = await harness();
  try {
    const created = await established(h); const id = created.data.id;
    const before = h.store.read(id);
    const confirmation = await askSwitch(h, id, created.cookie);
    assert.deepEqual(h.store.read(id).dataset, before.dataset);
    assert.deepEqual(h.store.read(id).story, before.story);
    assert.equal(h.store.read(id).version, before.version);
    await h.restart();
    const calls = h.agent.calls;
    const req = { ...turn(choice), choiceId: choice, confirmationRef: confirmation.referenceId };
    const result = await h.call(`/api/sessions/${id}/turns`, 'POST', req, created.cookie);
    assert.equal(result.status, 200);
    assert.equal(h.agent.calls, calls, 'a confirmed candidate does not invoke the model again');
    assert.equal(result.data.outcome, choice === 'keep_current' ? 'answered' : 'committed');
    const replay = await h.call(`/api/sessions/${id}/turns`, 'POST', req, created.cookie);
    assert.deepEqual(replay.data, result.data);
    const changed = await h.call(`/api/sessions/${id}/turns`, 'POST', { ...req, confirmationRef: randomUUID() }, created.cookie);
    assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'IDEMPOTENCY_MISMATCH');
    const source = h.store.read(id);
    if (choice === 'adapt_current') {
      assert.equal(result.data.demoId, id); assert.equal(source.version, before.version + 1);
      assert.equal(source.story?.domain, 'insurance claims agent');
    } else {
      assert.deepEqual(source.dataset, before.dataset); assert.deepEqual(source.story, before.story);
      assert.equal(source.version, before.version);
    }
    if (choice === 'start_separate') {
      assert.notEqual(result.data.demoId, id);
      const target = h.store.read(result.data.demoId);
      assert.equal(target.story?.domain, 'insurance claims agent');
      assert.equal(target.version, 2);
      assert.match(target.conversation[0]!.text, /insurance claims/);
      assert.equal(h.store.browserSession(result.data.sessionId).demos.length, 2);
      assert.ok(target.dataset.traces.every(t => t.id.startsWith(target.id)));
      assert.ok(result.data.evidence.traceIds.every((t: string) => t.startsWith(target.id)));
    }
  } finally { await h.close(); }
});

test('stale selection and foreign references cannot confirm or overwrite a managed demo', async () => {
  const h = await harness();
  try {
    const created = await established(h); const id = created.data.id;
    const confirmation = await askSwitch(h, id, created.cookie);
    const original = h.store.read(id);
    const refused = h.store.publish(id, { ...travelProposalV1, expectedVersion: original.version });
    assert.equal(refused.state, 'rejected', 'an adapter cannot bypass confirmation by omitting prepareScenario');
    assert.deepEqual(h.store.read(id).dataset, original.dataset);
    const other = await h.call('/api/browser-session/demos', 'POST', { description: 'Another owned workflow' }, created.cookie);
    const result = await h.call(`/api/sessions/${id}/turns`, 'POST', { ...turn('Start separate'), choiceId: 'start_separate', confirmationRef: confirmation.referenceId }, other.cookie);
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'STALE_CONFIRMATION');
    const foreign = await h.call(`/api/sessions/${other.data.id}/turns`, 'POST', { ...turn('Adapt'), choiceId: 'adapt_current', confirmationRef: confirmation.referenceId }, other.cookie);
    assert.equal(foreign.status, 409);
    assert.deepEqual(h.store.read(id).dataset, original.dataset);
  } finally { await h.close(); }
});

test('confirmed separate save/readback failure is truthful and never retries the publication', async () => {
  let failSave = false; let failReadback = false;
  const h = await harness({ faults: { failSave: () => failSave, failReadback: () => failReadback }, telemetry: 'captured' });
  try {
    const created = await established(h); const id = created.data.id;
    const before = h.store.read(id);
    let confirmation = await askSwitch(h, id, created.cookie);
    failSave = true;
    const failed = await h.call(`/api/sessions/${id}/turns`, 'POST', { ...turn('Separate'), choiceId: 'start_separate', confirmationRef: confirmation.referenceId }, created.cookie);
    assert.equal(failed.data.outcome, 'save_failed');
    assert.equal((await h.call('/api/browser-session', 'GET', undefined, created.cookie)).data.demos.length, 1);
    assert.deepEqual(h.store.read(id).dataset, before.dataset);
    failSave = false;
    confirmation = await askSwitch(h, id, created.cookie); failReadback = true;
    const req = { ...turn('Separate'), choiceId: 'start_separate', confirmationRef: confirmation.referenceId };
    const uncertain = await h.call(`/api/sessions/${id}/turns`, 'POST', req, created.cookie);
    assert.equal(uncertain.data.outcome, 'readback_uncertain');
    assert.notEqual(uncertain.data.demoId, id);
    assert.equal(h.store.read(uncertain.data.demoId).version, 2);
    assert.deepEqual((await h.call(`/api/sessions/${id}/turns`, 'POST', req, created.cookie)).data, uncertain.data);
    assert.equal((await h.call('/api/browser-session', 'GET', undefined, created.cookie)).data.demos.length, 2);
    const manifest = h.store.readTurnEvidence(id, req.clientTurnId)!;
    assert.ok(manifest.expected.some(e => e.operation === 'readback'));
    assert.ok(manifest.observed.some(e => e.operation === 'readback' && e.phase === 'end' && e.status === 'failed'));
  } finally { await h.close(); }
});

test('public capability map and scoped synthetic evaluations survive restart and become stale on dataset edits', async () => {
  const h = await harness();
  try {
    const map = await h.call('/api/capabilities'); assert.equal(map.status, 200); assert.ok(map.data.starters.length >= 3);
    const created = await established(h); const id = created.data.id; const s = h.store.read(id);
    const body = { clientOperationId: randomUUID(), datasetVersion: s.version, name: 'Fictional outcome review', traceIds: [s.dataset.traces[0]!.id] };
    const made = await h.call(`/api/sessions/${id}/evaluations`, 'POST', body, created.cookie);
    assert.equal(made.status, 201); assert.equal(made.data.evaluation.mode, 'synthetic');
    assert.deepEqual((await h.call(`/api/sessions/${id}/evaluations`, 'POST', body, created.cookie)).data, made.data);
    await h.restart();
    const detail = await h.call(`/api/sessions/${id}/evaluations/${made.data.evaluation.id}`, 'GET', undefined, created.cookie);
    assert.deepEqual(detail.data, made.data);
    const stranger = await h.call('/api/browser-session/demos', 'POST', { description: 'Other visitor' });
    assert.equal((await h.call(`/api/sessions/${id}/evaluations`, 'GET', undefined, stranger.cookie)).status, 404);
    h.store.applyScenario(id, 'exhausted', s.version);
    const stale = await h.call(`/api/sessions/${id}/evaluations/${made.data.evaluation.id}`, 'GET', undefined, created.cookie);
    assert.equal(stale.data.stale, true); assert.deepEqual(stale.data.evaluation.traceSnapshot, made.data.evaluation.traceSnapshot);
    await h.call(`/api/sessions/${id}/end`, 'POST', undefined, created.cookie);
    assert.equal((h.store.db.prepare("SELECT COUNT(*) n FROM demo_artifacts WHERE namespace='evaluations'").get() as {n:number}).n, 0);
  } finally { await h.close(); }
});

test('opaque artifact persistence supports a second adapter without product evidence shapes', () => {
  const t = tempStore();
  interface CrmDocument { deal: { id: string; amount: number; stage: string }; version: number }
  try {
    const owned = t.store.createOwned(null, 'Fictional CRM demo', undefined, op());
    const other = t.store.createOwned(owned.ownerId, 'Other fictional CRM demo', undefined, op());
    const deal: CrmDocument = { deal: { id: 'deal-1', amount: 12000, stage: 'lead' }, version: 1 };
    assert.equal(t.store.compareAndSetArtifact(owned.session.id, 'crm', 'deal-1', null, deal), true);
    assert.equal(t.store.compareAndSetArtifact(owned.session.id, 'crm', 'deal-1', null, deal), false);
    assert.equal(t.store.readArtifact(other.session.id, 'crm', 'deal-1'), null);
    assert.equal(t.store.compareAndSetArtifact(owned.session.id, 'crm', 'deal-1', 1, { ...deal, version: 2, deal: { ...deal.deal, stage: 'won' } }), true);
    assert.equal(t.store.compareAndSetArtifact(owned.session.id, 'crm', 'deal-1', 1, deal), false);
    t.store.close(); const reopened = new Store(t.path, { clock: t.clock });
    assert.equal(reopened.readArtifact<CrmDocument>(owned.session.id, 'crm', 'deal-1')!.deal.stage, 'won');
    t.clock.advance(CORE_LIMITS.idleMs + 1);
    assert.throws(() => reopened.authorize(other.session.id, reopened.browserCookie(owned.ownerId)), (e: unknown) => e instanceof Failure && e.code === 'SESSION_EXPIRED');
    assert.equal((reopened.db.prepare('SELECT COUNT(*) n FROM demo_artifacts').get() as {n:number}).n, 0);
    reopened.close();
  } finally { t.cleanup(); }
});

test('crash after separate publication recovers the same child and original context without rerunning', () => {
  const t = tempStore();
  try {
    const created = t.store.createOwned(null, 'Fictional travel agent', undefined, op());
    const id = created.session.id;
    assert.equal(t.store.publish(id, travelProposalV1).state, 'committed');
    const before = t.store.read(id);
    t.store.appendTurns(id, [{ role: 'buyer', text: 'Switch to insurance claims', status: 'pending' }]);
    const prepared = t.store.prepareScenario(id, { ...travelProposalV1, expectedVersion: 2, story: { domain: 'insurance claims', summary: 'Fictional insurance lookup.', assumptions: [] } }, 'Switch to insurance claims');
    assert.equal(prepared.state, 'confirmation_required');
    if (prepared.state !== 'confirmation_required') return;
    t.store.appendTurns(id, [{ role: 'tailor', text: prepared.confirmation.question, status: 'question', clarification: prepared.confirmation }]);
    const clientTurnId = randomUUID();
    t.store.assertSwitch(id, prepared.confirmation.referenceId, 'start_separate');
    t.store.beginTurn(id, { clientTurnId, requestHash: 'confirmed-request', text: 'Start separate demo', turnId: randomUUID(), execution: { mode: 'mock', provider: 'stub', model: null } });
    const resolved = t.store.resolveSwitch(id, prepared.confirmation.referenceId, 'start_separate', clientTurnId);
    assert.equal(resolved.result?.state, 'committed');
    t.store.close(); const reopened = new Store(t.path, { clock: t.clock });
    const recovered = reopened.recoverRun(id, clientTurnId);
    assert.equal(recovered.outcome, 'readback_uncertain'); assert.equal(recovered.demoId, resolved.demoId);
    assert.equal(reopened.browserSession(created.ownerId).demos.length, 2);
    assert.deepEqual(reopened.read(id).dataset, before.dataset);
    assert.equal(reopened.read(resolved.demoId).conversation[0]!.text, 'Switch to insurance claims');
    assert.deepEqual(reopened.recoverRun(id, clientTurnId), recovered);
    reopened.close();
  } finally { t.cleanup(); }
});

test('bootstrap precedes first creation so a lost creation response retries with authenticated ownership', async () => {
  const h = await harness();
  try {
    const bootstrap = await h.call('/api/browser-session', 'POST');
    assert.equal(bootstrap.status, 200); assert.deepEqual(bootstrap.data.demos, []);
    const operation = randomUUID(); const data = { description: 'Fictional first workflow' };
    // Discard every creation response byte and its Set-Cookie; retain only the cookie already acknowledged by bootstrap.
    const lost = await fetch(`http://127.0.0.1:${h.port}/api/browser-session/demos`, { method: 'POST',
      headers: { cookie: bootstrap.cookie, 'content-type': 'application/json', 'idempotency-key': operation }, body: JSON.stringify(data) });
    await lost.arrayBuffer();
    const replay = await h.call('/api/browser-session/demos', 'POST', data, bootstrap.cookie, { 'idempotency-key': operation });
    assert.equal(replay.status, 201);
    const browser = await h.call('/api/browser-session', 'GET', undefined, bootstrap.cookie);
    assert.equal(browser.data.id, bootstrap.data.id); assert.equal(browser.data.demos.length, 1);
    assert.equal(browser.data.demos[0].id, replay.data.id);
    const stranger = await h.call('/api/browser-session', 'POST');
    const wrongOwner = await h.call('/api/browser-session/demos', 'POST', data, stranger.cookie, { 'idempotency-key': operation });
    assert.equal(wrongOwner.status, 409, 'operation possession never transfers ownership');
    assert.equal((await h.call('/api/browser-session', 'POST', undefined, bootstrap.cookie)).data.id, bootstrap.data.id, 'bootstrap reuses an authenticated owner');
  } finally { await h.close(); }
});

test('material edit-mode domain replacement asks before publication, including forged Story identity', async () => {
  for (const forged of [false, true]) {
    const h = await harness();
    try {
      const created = await established(h); const id = created.data.id; const before = h.store.read(id);
      const proposal = { ...qualityWorkflowProposal('extraction', before.version), mode: 'edit' as const,
        removeTraceKeys: before.dataset.traces.map(t => t.scenario),
      };
      if (forged) proposal.story.domain = before.story!.domain;
      const core = createAgentService();
      h.agent.script = input => core.handleTurn({ ...input, knowledge: loadKnowledge(), provider: { name: 'tailor-mock', mode: 'mock', model: null,
        async complete() { return { action: { type: 'propose', proposal, explanation: 'Created a fictional extraction example.' }, usage: null, latencyMs: 0 }; },
      } });
      const asked = await h.call(`/api/sessions/${id}/turns`, 'POST', turn('Show an invoice extraction workflow that omits the due date'), created.cookie);
      assert.equal(asked.data.outcome, 'clarification'); assert.equal(asked.data.clarification.kind, 'demo_switch');
      assert.deepEqual(h.store.read(id).dataset, before.dataset); assert.deepEqual(h.store.read(id).story, before.story);
      assert.equal(h.store.publish(id, proposal).state, 'rejected', 'the direct publication seam enforces the same normalized-state decision');
      const choice = await h.call(`/api/sessions/${id}/turns`, 'POST', { ...turn('Start separate demo'), choiceId: 'start_separate', confirmationRef: asked.data.clarification.referenceId }, created.cookie);
      assert.equal(choice.data.outcome, 'committed'); assert.notEqual(choice.data.demoId, id);
      assert.deepEqual(h.store.read(id).dataset, before.dataset);
      assert.match(h.store.read(choice.data.demoId).dataset.traces[0]!.name, /extraction/i);
    } finally { await h.close(); }
  }
});

test('small same-workflow edits remain direct and do not ask a material switch question', () => {
  const t = tempStore();
  try {
    const created = t.store.createOwned(null, 'Fictional travel agent', undefined, op());
    assert.equal(t.store.publish(created.session.id, travelProposalV1).state, 'committed');
    const edit = structuredClone(travelProposalV2);
    assert.deepEqual(t.store.prepareScenario(created.session.id, edit, 'Make the retry fail too'), { state: 'ready' });
    assert.equal(t.store.publish(created.session.id, edit).state, 'committed');
    assert.equal(t.store.read(created.session.id).dataset.traces.length, 2);
  } finally { t.cleanup(); }
});

test('reusing trace keys, domain and root names cannot disguise a complete payload-shape replacement', () => {
  const t = tempStore();
  try {
    const created = t.store.createOwned(null, 'Fictional travel agent', undefined, op());
    assert.equal(t.store.publish(created.session.id, travelProposalV1).state, 'committed');
    const saved = t.store.read(created.session.id); const original = saved.dataset.traces[0]!;
    const proposal = qualityWorkflowProposal('extraction', saved.version);
    proposal.mode = 'edit'; proposal.story.domain = saved.story!.domain;
    proposal.traces[0]!.key = original.scenario; proposal.activeScenario = original.scenario;
    proposal.traces[0]!.name = original.name;
    proposal.traces[0]!.spans.find(s => s.parentKey === null)!.name = original.spans.find(s => s.parentId === null)!.name;
    assert.equal(t.store.prepareScenario(saved.id, proposal, 'Switch the workflow').state, 'confirmation_required');
    assert.equal(t.store.publish(saved.id, proposal).state, 'rejected');
    assert.deepEqual(t.store.read(saved.id).dataset, saved.dataset);
  } finally { t.cleanup(); }
});

for (const route of ['selection', 'evaluation'] as const) test(`${route} body cannot race a newly started owner turn`, async () => {
  const h = await harness(); let release = () => {};
  try {
    const created = await established(h); const id = created.data.id;
    await h.call('/api/browser-session/demos', 'POST', { description: 'Other owned demo' }, created.cookie);
    const browser = await h.call('/api/browser-session', 'GET', undefined, created.cookie);
    const s = h.store.read(id);
    const path = route === 'selection' ? '/api/browser-session/active-demo' : `/api/sessions/${id}/evaluations`;
    const payload = route === 'selection' ? { demoId: id, expectedVersion: browser.data.version }
      : { clientOperationId: randomUUID(), datasetVersion: s.version, name: 'Concurrent review', traceIds: [s.dataset.traces[0]!.id] };
    let entered = false;
    if (route === 'selection') {
      const original = h.store.browserForCookie.bind(h.store);
      h.store.browserForCookie = (cookie, upgrade) => { const owner = original(cookie, upgrade); entered = true; return owner; };
    } else {
      const original = h.store.read.bind(h.store);
      h.store.read = demoId => { const session = original(demoId); entered = true; return session; };
    }
    let slow!: ReturnType<typeof httpRequest>;
    const completed = new Promise<{status:number;body:any}>((resolve, reject) => {
      slow = httpRequest({ hostname: '127.0.0.1', port: h.port, path, method: 'POST', headers: { cookie: created.cookie, 'content-type': 'application/json', connection: 'close' } }, response => {
        const chunks: Buffer[] = []; response.on('data', c => chunks.push(c)); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      slow.on('error', reject);
    });
    slow.write('{');
    for (let n = 0; !entered && n < 500; n++) await new Promise(r => setTimeout(r, 2));
    assert.equal(entered, true, 'the mutation route reached its pre-body read');
    const priorCalls = h.agent.calls;
    h.agent.gate = new Promise<void>(r => { release = r; });
    const running = h.call(`/api/sessions/${id}/turns`, 'POST', turn('Explain this fictional workflow'), created.cookie);
    for (let n = 0; h.agent.calls === priorCalls && n < 500; n++) await new Promise(r => setTimeout(r, 2));
    assert.ok(h.agent.calls > priorCalls, 'a turn now holds the owner gate');
    slow.end(JSON.stringify(payload).slice(1));
    const response = await completed;
    assert.equal(response.status, 409); assert.equal(response.body.error.code, 'TURN_IN_FLIGHT');
    release(); h.agent.gate = null; await running;
    assert.equal(h.store.browserSession(browser.data.id).activeDemoId, browser.data.activeDemoId);
    assert.equal(h.store.listArtifacts(id, 'evaluations').length, 0);
  } finally { release(); h.agent.gate = null; await h.close(); }
});

test('real offline mock insurance switch and return to travel both require explicit confirmation', async () => {
  const h = await harness(); const core = createAgentService(); const provider = createProvider({ kind: 'mock' });
  h.agent.script = input => core.handleTurn({ ...input, provider, knowledge: loadKnowledge() });
  try {
    const owner = await h.call('/api/browser-session', 'POST');
    const created = await h.call('/api/browser-session/demos', 'POST', { description: 'Fictional travel-booking agent' }, owner.cookie);
    const id = created.data.id;
    const travel = "I'm building a travel-booking agent. Show a booking API timeout followed by a successful retry.";
    assert.equal((await h.call(`/api/sessions/${id}/turns`, 'POST', turn(travel), created.cookie)).data.outcome, 'committed');
    const claims = 'Switch to an insurance claims agent. Show a policy lookup timing out, then a successful retry.';
    for (const choice of ['keep_current', 'adapt_current'] as const) {
      const before = h.store.read(id);
      const asked = await h.call(`/api/sessions/${id}/turns`, 'POST', turn(claims), created.cookie);
      assert.equal(asked.data.outcome, 'clarification'); assert.equal(asked.data.clarification.kind, 'demo_switch');
      assert.deepEqual(h.store.read(id).dataset, before.dataset);
      const confirmed = await h.call(`/api/sessions/${id}/turns`, 'POST', { ...turn(choice), choiceId: choice, confirmationRef: asked.data.clarification.referenceId }, created.cookie);
      assert.equal(confirmed.data.outcome, choice === 'keep_current' ? 'answered' : 'committed');
    }
    const adapted = h.store.read(id);
    const returned = await h.call(`/api/sessions/${id}/turns`, 'POST', turn('Switch to a travel-booking agent. Show a booking API timeout followed by a successful retry.'), created.cookie);
    assert.equal(returned.data.outcome, 'clarification'); assert.equal(returned.data.clarification.kind, 'demo_switch');
    assert.deepEqual(h.store.read(id).dataset, adapted.dataset);
    const separate = await h.call(`/api/sessions/${id}/turns`, 'POST', { ...turn('Separate'), choiceId: 'start_separate', confirmationRef: returned.data.clarification.referenceId }, created.cookie);
    assert.equal(separate.data.outcome, 'committed'); assert.notEqual(separate.data.demoId, id);
    assert.deepEqual(h.store.read(id).dataset, adapted.dataset);
  } finally { await h.close(); }
});

test('real offline same-workflow guardrail, retry and backoff edits stay direct', async () => {
  const h = await harness(); const core = createAgentService(); const provider = createProvider({ kind: 'mock' });
  h.agent.script = input => core.handleTurn({ ...input, provider, knowledge: loadKnowledge() });
  try {
    const owner = await h.call('/api/browser-session', 'POST');
    const created = await h.call('/api/browser-session/demos', 'POST', { description: 'Fictional travel-booking agent' }, owner.cookie);
    const id = created.data.id;
    const initial = await h.call(`/api/sessions/${id}/turns`, 'POST', turn("I'm building a travel-booking agent. Show a booking API timeout followed by a successful retry."), created.cookie);
    assert.equal(initial.data.outcome, 'committed');
    for (const text of ['Add a guardrail step before calling booking_api.', 'Make the retry fail too.', 'Add a longer retry backoff.']) {
      const result = await h.call(`/api/sessions/${id}/turns`, 'POST', turn(text), created.cookie);
      assert.notEqual(result.data.clarification?.kind, 'demo_switch', text);
      assert.equal(result.data.outcome, 'committed', text);
    }
  } finally { await h.close(); }
});
