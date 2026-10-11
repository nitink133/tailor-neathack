import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { LIMITS } from '../src/agent-contract.ts';
import { travelBuyerTurn1, travelBuyerTurn2, travelProposalV1 } from '../src/clients/neatlogs/examples/travel-booking.ts';
import { TURN_DEADLINE_MS, TURN_RUNS_PER_SESSION } from '../src/infrastructure/store.ts';
import { harness, MINUTE, never, type Harness } from './helpers/backend.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(4); }
  throw new Error(`Timed out waiting for ${label}`);
}
/** A turn request the browser abandons (tab closed / network drop); resolves once the request is aborted. */
function abandonedTurn(h: Harness, id: string, cookie: string, body: unknown) {
  const ctl = new AbortController();
  const done = fetch(`http://127.0.0.1:${h.port}/api/sessions/${id}/turns`, { method: 'POST', signal: ctl.signal, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  return { abort: async () => { ctl.abort(); await done; } };
}
const statuses = (s: any) => s.conversation.map((m: any) => `${m.role}:${m.status}`);

test('HTTP contract: coherent fixtures, transactional CAS, capability isolation, restart and malformed requests', async () => {
  const h = await harness();
  const { call } = h;
  try {
    const op = randomUUID(); const payload = { description: 'Fictional order support project A', scenario: 'recovered' };
    const a = await call('/api/sessions', 'POST', payload, '', { 'idempotency-key': op });
    const repeat = await call('/api/sessions', 'POST', payload, '', { 'idempotency-key': op });
    assert.equal(a.status, 201); assert.equal(repeat.data.id, a.data.id); assert.equal(repeat.cookie, a.cookie);
    assert.match(a.setCookie ?? '', /HttpOnly; SameSite=Strict; Path=\/; Max-Age=14400$/, 'cookie lives 4 hours, not 7 days');
    const b = await call('/api/sessions', 'POST', { description: 'Fictional B', scenario: 'exhausted' });
    const noScenario = await call('/api/sessions', 'POST', { description: 'Fictional C without a fixture choice' });
    assert.equal(noScenario.status, 201); assert.equal(noScenario.data.dataset.activeScenario, 'recovered');
    const id = a.data.id; const dataset = a.data.dataset;
    assert.equal(dataset.traces.length, 2);
    for (const t of dataset.traces) {
      assert.equal(t.sessionId, id); assert.equal(t.status, 'Ready');
      const root = t.spans.find((s: any) => s.parentId === null); assert(root);
      for (const span of t.spans) { assert(span.startMs >= 0); assert(span.startMs + span.durationMs <= root.durationMs); if (span.parentId) assert(t.spans.some((x: any) => x.id === span.parentId)); assert.equal(span.status === 'ERROR', span.error !== null); }
      assert.equal(t.spans.filter((s: any) => s.status === 'ERROR').length, t.scenario === 'recovered' ? 1 : 2);
      const detail = await call(`/api/sessions/${id}/traces/${t.id}`, 'GET', undefined, a.cookie); assert.deepEqual(detail.data.trace, t);
      const span = await call(`/api/sessions/${id}/traces/${t.id}/spans/${root.id}`, 'GET', undefined, a.cookie); assert.deepEqual(span.data.span, root);
      assert.deepEqual(root.output, t.output);
    }
    for (const [query, count] of [['', 2], ['?scenario=recovered', 1], ['?detection=yes', 1], ['?q=zz-no-match', 0], ['?minMs=45', 1], ['?tag=synthetic', 2]] as const) {
      const r = await call(`/api/sessions/${id}/traces${query}`, 'GET', undefined, a.cookie); assert.equal(r.data.filtered, count); assert.equal(r.data.total, 2); assert.equal(r.data.traces.length, count);
    }
    assert.equal((await call(`/api/sessions/${id}/traces?scenario=booking-timeout-retry-ok`, 'GET', undefined, a.cookie)).status, 400, 'scenario filter uses this dataset’s keys');
    assert.equal((await call(`/api/sessions/${id}`, 'GET', undefined, b.cookie)).status, 404);
    assert.equal((await call(`/api/sessions/${id}/traces/${dataset.traces[0].id}`, 'GET', undefined, b.cookie)).status, 404);
    const proposalPath = `/api/dev/sessions/${id}/proposal`;
    const bad = structuredClone(dataset); bad.traces[0].spans[1].parentId = 'other-session';
    const badResult = await call(proposalPath, 'POST', { expectedVersion: 1, dataset: bad }, a.cookie);
    assert.equal(badResult.status, 422); assert.match(badResult.data.error.message, /UNKNOWN_PARENT/);
    assert.deepEqual((await call(`/api/sessions/${id}`, 'GET', undefined, a.cookie)).data, a.data);
    const foreign = structuredClone(b.data.dataset);
    assert.equal((await call(proposalPath, 'POST', { expectedVersion: 1, dataset: foreign }, a.cookie)).status, 422, 'cross-session dataset IDs rejected');
    const good = structuredClone(dataset); good.activeScenario = 'exhausted';
    assert.equal((await call(proposalPath, 'POST', { expectedVersion: 1, dataset: good }, b.cookie)).status, 404);
    assert.equal((await call(proposalPath, 'POST', { expectedVersion: 1, dataset: good }, a.cookie, { 'x-tailor-dev-key': '' })).status, 403);
    const concurrent = await Promise.all([call(proposalPath, 'POST', { expectedVersion: 1, dataset: good }, a.cookie), call(proposalPath, 'POST', { expectedVersion: 1, dataset: good }, a.cookie)]);
    assert.deepEqual(concurrent.map(x => x.status).sort(), [200, 409]);
    const accepted = await call(`/api/sessions/${id}`, 'GET', undefined, a.cookie); assert.equal(accepted.data.version, 2); assert.deepEqual(accepted.data.dataset, good);
    assert.equal((await call(`/api/sessions/${id}/traces?unknown=1`, 'GET', undefined, a.cookie)).status, 400);
    assert.equal((await call(`/api/sessions/${id}/traces?minMs=abc`, 'GET', undefined, a.cookie)).status, 400);
    assert.equal((await call(`/api/sessions/${id}/traces/unknown`, 'GET', undefined, a.cookie)).status, 404);
    assert.equal((await call(`/api/sessions/${id}`, 'DELETE', undefined, a.cookie)).status, 405);
    assert.equal((await call(`/api/sessions/${id}/conversation`, 'POST', { conversation: [] }, a.cookie)).status, 405, 'transcript replacement removed');
    const malformed = await fetch(`http://127.0.0.1:${h.port}${proposalPath}`, { method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-tailor-dev-key': 'local-test-key' }, body: '{"expectedVersion":2,' }); assert.equal(malformed.status, 400);
    await new Promise<void>(resolve => { const req = httpRequest({ hostname: '127.0.0.1', port: h.port, path: proposalPath, method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-tailor-dev-key': 'local-test-key', 'content-length': 1000 } }); req.on('error', () => resolve()); req.write('{"expectedVersion":2,'); setTimeout(() => req.destroy(), 15); });
    assert.deepEqual((await call(`/api/sessions/${id}`, 'GET', undefined, a.cookie)).data, accepted.data);
    const csrf = await fetch(`http://127.0.0.1:${h.port}/api/sessions`, { method: 'POST', headers: { origin: 'https://foreign.test', 'content-type': 'application/json' }, body: JSON.stringify(payload) }); assert.equal(csrf.status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/agent.js`)).status === 500, false, 'missing static bundle is never a 500');
    await h.restart();
    assert.deepEqual((await call(`/api/sessions/${id}`, 'GET', undefined, a.cookie)).data, accepted.data);
    assert.equal((await call('/api/dev/sessions')).data.length, 3);
  } finally { await h.close(); }
});

test('turns: personalised publish with independent readback, idempotent replay, append-only transcript', async () => {
  const h = await harness();
  const { call } = h;
  try {
    const created = await call('/api/sessions', 'POST', { description: 'Fictional travel-booking agent' });
    assert.equal(created.status, 201);
    const id = created.data.id; const cookie = created.cookie;
    const t1 = await call(`/api/sessions/${id}/turns`, 'POST', travelBuyerTurn1, cookie);
    assert.equal(t1.status, 200);
    assert.equal(t1.data.outcome, 'committed');
    assert.equal(t1.data.version, 2);
    assert.equal(t1.data.conversationVersion, 3, 'buyer append + tailor append');
    assert.deepEqual(t1.data.messages.map((m: any) => [m.role, m.status]), [['buyer', 'applied'], ['tailor', 'applied']]);
    assert.equal(t1.data.messages[0].text, travelBuyerTurn1.text);
    assert.deepEqual(t1.data.execution, { mode: 'mock', provider: 'stub', model: null });
    const list = await call(`/api/sessions/${id}/traces`, 'GET', undefined, cookie);
    assert.equal(list.data.version, 2);
    assert.deepEqual(t1.data.evidence.traceIds, list.data.traces.map((t: any) => t.id));
    assert.deepEqual(t1.data.evidence.traceIds, [`${id}-booking-timeout-retry-ok`]);
    const detail = await call(`/api/sessions/${id}/traces/${t1.data.evidence.traceIds[0]}`, 'GET', undefined, cookie);
    assert.deepEqual(t1.data.evidence.spanIds, detail.data.trace.spans.map((s: any) => s.id));
    assert.equal(t1.data.evidence.spanIds.length, 7);
    assert.equal(t1.data.evidence.traces[0].rootDurationMs, 2860);
    const errorSpan = await call(`/api/sessions/${id}/traces/${detail.data.trace.id}/spans/${t1.data.evidence.traces[0].errorSpanIds[0]}`, 'GET', undefined, cookie);
    assert.equal(errorSpan.data.span.status, 'ERROR'); assert.match(errorSpan.data.span.error, /^SYNTHETIC: /);

    const replay = await call(`/api/sessions/${id}/turns`, 'POST', travelBuyerTurn1, cookie);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, t1.data, 'same clientTurnId returns the identical response');
    assert.equal(h.agent.calls, 1, 'agent not re-invoked on replay');
    assert.equal((await call(`/api/sessions/${id}`, 'GET', undefined, cookie)).data.version, 2);

    const t2 = await call(`/api/sessions/${id}/turns`, 'POST', travelBuyerTurn2, cookie);
    assert.equal(t2.data.outcome, 'committed');
    assert.equal(t2.data.version, 3);
    assert.equal(t2.data.conversationVersion, 5);
    const session = await call(`/api/sessions/${id}`, 'GET', undefined, cookie);
    assert.equal(session.data.version, 3);
    assert.equal(session.data.dataset.activeScenario, 'booking-timeout-retry-fails');
    assert.equal(session.data.story.domain, 'travel-booking agent');
    assert.equal(session.data.lastClientTurnId, travelBuyerTurn2.clientTurnId);
    assert.deepEqual(session.data.conversation.map((m: any) => m.text), [travelBuyerTurn1.text, t1.data.messages[1].text, travelBuyerTurn2.text, t2.data.messages[1].text], 'transcript is append-only');
    const list2 = await call(`/api/sessions/${id}/traces`, 'GET', undefined, cookie);
    assert.deepEqual(t2.data.evidence.traceIds, list2.data.traces.map((t: any) => t.id));
    const fails = list2.data.traces.find((t: any) => t.scenario === 'booking-timeout-retry-fails');
    assert.deepEqual(t2.data.evidence.traces[1].errorSpanIds, fails.spans.filter((s: any) => s.status === 'ERROR').map((s: any) => s.id));
    assert.equal((await call(`/api/sessions/${id}/traces?detection=yes`, 'GET', undefined, cookie)).data.filtered, 1);
  } finally { await h.close(); }
});

test('turns: validation, one in flight per session, cross-session 404 and truthful agent failures', async () => {
  const h = await harness();
  const { call } = h;
  try {
    const a = await call('/api/sessions', 'POST', { description: 'Fictional A' });
    const b = await call('/api/sessions', 'POST', { description: 'Fictional B' });
    const turns = `/api/sessions/${a.data.id}/turns`;
    assert.equal((await call(turns, 'POST', { text: '', clientTurnId: randomUUID() }, a.cookie)).data.error.code, 'TURN_TEXT_INVALID');
    assert.equal((await call(turns, 'POST', { text: 'x'.repeat(LIMITS.maxTurnTextChars + 1), clientTurnId: randomUUID() }, a.cookie)).status, 422);
    assert.equal((await call(turns, 'POST', { text: 'hello', clientTurnId: 'no' }, a.cookie)).status, 422);
    assert.equal((await call(turns, 'POST', travelBuyerTurn1, b.cookie)).status, 404, 'another session’s cookie');
    assert.equal(h.agent.calls, 0);

    let release!: () => void;
    h.agent.gate = new Promise<void>(r => { release = r; });
    const first = call(turns, 'POST', travelBuyerTurn1, a.cookie);
    while (h.agent.calls === 0) await new Promise(r => setTimeout(r, 2));
    const second = await call(turns, 'POST', { text: 'Make the retry fail too.', clientTurnId: randomUUID() }, a.cookie);
    assert.equal(second.status, 409); assert.equal(second.data.error.code, 'TURN_IN_FLIGHT');
    release(); h.agent.gate = null;
    assert.equal((await first).data.outcome, 'committed');

    h.agent.throwAfter = 'nothing';
    const failed = await call(turns, 'POST', { text: 'travel-booking again please', clientTurnId: randomUUID() }, a.cookie);
    assert.equal(failed.data.outcome, 'provider_unavailable');
    assert.equal(failed.data.version, 2);
    assert.deepEqual(failed.data.messages.map((m: any) => [m.role, m.status]), [['buyer', 'failed'], ['tailor', 'failed']]);
    assert.match(failed.data.messages[1].text, /nothing changed\. Version 2 is still live/);

    h.agent.throwAfter = 'publish';
    const b2 = await call('/api/sessions', 'POST', { description: 'Fictional uncertain' });
    const uncertain = await call(`/api/sessions/${b2.data.id}/turns`, 'POST', travelBuyerTurn1, b2.cookie);
    assert.equal(uncertain.data.outcome, 'readback_uncertain', 'state moved during a failed turn: never claim unchanged');
    assert.equal(uncertain.data.version, 2);
    assert.deepEqual(uncertain.data.messages.map((m: any) => m.status), ['uncertain', 'uncertain']);
    h.agent.throwAfter = null;
    const conv = (await call(`/api/sessions/${a.data.id}`, 'GET', undefined, a.cookie)).data;
    assert.equal(conv.conversationVersion, 5);
  } finally { await h.close(); }
});

test('lifecycle over HTTP: expiry 410 deletes the row, End demo is idempotent, legacy cookies are unknown', async () => {
  const h = await harness();
  const { call } = h;
  try {
    const a = await call('/api/sessions', 'POST', { description: 'Fictional expiring' });
    h.clock.advance(59 * MINUTE);
    assert.equal((await call(`/api/sessions/${a.data.id}/traces`, 'GET', undefined, a.cookie)).status, 200, 'reads refresh lastActiveAt');
    h.clock.advance(59 * MINUTE);
    assert.equal((await call('/api/session', 'GET', undefined, a.cookie)).status, 200);
    h.clock.advance(LIMITS.idleMs + 1);
    const expired = await call(`/api/sessions/${a.data.id}`, 'GET', undefined, a.cookie);
    assert.equal(expired.status, 410); assert.equal(expired.data.error.code, 'SESSION_EXPIRED');
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id=?').get(a.data.id)!.n, 0, 'row gone');
    assert.equal((await call(`/api/sessions/${a.data.id}/turns`, 'POST', travelBuyerTurn1, a.cookie)).status, 404);

    const e = await call('/api/sessions', 'POST', { description: 'Fictional ending' });
    const ended = await call(`/api/sessions/${e.data.id}/end`, 'POST', undefined, e.cookie);
    assert.equal(ended.status, 200); assert.deepEqual(ended.data, { ended: true });
    assert.match(ended.setCookie ?? '', /^tailor=; .*Max-Age=0/);
    assert.deepEqual((await call(`/api/sessions/${e.data.id}/end`, 'POST', undefined, e.cookie)).data, { ended: true }, 'idempotent');
    const after = await call(`/api/sessions/${e.data.id}`, 'GET', undefined, e.cookie);
    assert.equal(after.status, 410); assert.equal(after.data.error.code, 'SESSION_ENDED');
    assert.equal((await call(`/api/sessions/${e.data.id}/turns`, 'POST', travelBuyerTurn1, e.cookie)).data.error.code, 'SESSION_ENDED');
    assert.equal((await call(`/api/sessions/${e.data.id}/end`, 'POST', undefined, a.cookie)).status, 404, 'cannot end another session');

    const legacyId = randomUUID();
    const legacyCookie = `tailor=${legacyId}.${h.store.token(legacyId)}`;
    assert.equal((await call(`/api/sessions/${legacyId}`, 'GET', undefined, legacyCookie)).status, 404);
    assert.equal((await call('/api/session', 'GET', undefined, legacyCookie)).status, 404);
  } finally { await h.close(); }
});

test('turn route is wrapped in runtime telemetry without exporting buyer text, cookies or session IDs', async () => {
  const h = await harness({ telemetry: 'captured' });
  try {
    const created = await h.call('/api/sessions', 'POST', { description: 'Fictional Zephyr Hotels travel desk' });
    const t1 = await h.call(`/api/sessions/${created.data.id}/turns`, 'POST', travelBuyerTurn1, created.cookie);
    assert.equal(t1.data.outcome, 'committed');
    const spans = h.telemetry.captured();
    const turn = spans.find(s => s.name === 'tailor.turn');
    assert.ok(turn);
    assert.equal(turn.attributes['tailor.outcome'], 'committed');
    assert.equal(turn.attributes['tailor.version'], 2);
    assert.ok(turn.events.some(e => e.name === 'tailor.turn.result' && typeof e.attributes['tailor.latency_ms'] === 'number'));
    const save = spans.find(s => s.name === 'save');
    assert.equal(save?.attributes['openinference.span.kind'], 'TOOL');
    const dump = JSON.stringify(spans);
    for (const secret of [travelBuyerTurn1.text, 'Zephyr', created.data.id, created.cookie.split('.')[1]!]) assert.equal(dump.includes(secret), false);
  } finally { await h.close(); }
});

test('NIT-265 regression: fixture scenario switch keeps CAS semantics inside one session', async () => {
  const h = await harness();
  const { call } = h;
  try {
    const created = await call('/api/sessions', 'POST', { description: 'Fictional chat project', scenario: 'recovered' });
    const id = created.data.id;
    const switched = await call(`/api/sessions/${id}/scenario`, 'POST', { expectedVersion: 1, scenario: 'exhausted' }, created.cookie);
    assert.equal(switched.status, 200); assert.equal(switched.data.version, 2); assert.equal(switched.data.dataset.activeScenario, 'exhausted');
    assert.equal((await call(`/api/sessions/${id}/scenario`, 'POST', { expectedVersion: 1, scenario: 'recovered' }, created.cookie)).status, 409);
    const other = await call('/api/sessions', 'POST', { description: 'Fictional other chat' });
    assert.equal((await call(`/api/sessions/${id}/scenario`, 'POST', { expectedVersion: 2, scenario: 'recovered' }, other.cookie)).status, 404);
  } finally { await h.close(); }
});

test('crash after publish (L2-03/L4-07): story is saved with the dataset; a retry after restart never publishes again', async () => {
  const h = await harness();
  try {
    const created = await h.call('/api/sessions', 'POST', { description: 'Fictional crash-after-publish agent' });
    const id = created.data.id; const cookie = created.cookie;
    h.agent.script = async input => { await input.tools.publishScenario(travelProposalV1); return never(); };
    const turn = abandonedTurn(h, id, cookie, travelBuyerTurn1);
    await until(() => h.store.read(id).version === 2, 'the publish to commit');
    const mid = h.store.read(id);
    assert.deepEqual(mid.story, travelProposalV1.story, 'story commits in the same transaction as the dataset');
    assert.deepEqual(statuses(mid), ['buyer:pending']);
    await turn.abort();
    await h.crash();
    h.agent.script = null;
    const calls = h.agent.calls;
    const retry = await h.call(`/api/sessions/${id}/turns`, 'POST', travelBuyerTurn1, cookie);
    assert.equal(retry.status, 200);
    assert.equal(h.agent.calls, calls, 'the agent is not run again for an interrupted turn');
    assert.equal(retry.data.outcome, 'readback_uncertain');
    assert.equal(retry.data.version, 2, 'no second publish');
    assert.deepEqual(retry.data.messages.map((m: any) => `${m.role}:${m.status}`), ['buyer:uncertain', 'tailor:uncertain']);
    assert.match(retry.data.messages[1].text, /version 2/);
    assert.doesNotMatch(retry.data.messages[1].text, /nothing changed|verified/i);
    const after = (await h.call(`/api/sessions/${id}`, 'GET', undefined, cookie)).data;
    assert.equal(after.version, 2);
    assert.deepEqual(statuses(after), ['buyer:uncertain', 'tailor:uncertain'], 'no permanent Pending bubble, no duplicate buyer turn');
    assert.deepEqual((await h.call(`/api/sessions/${id}/turns`, 'POST', travelBuyerTurn1, cookie)).data, retry.data, 'the settlement itself replays');
  } finally { await h.close(); }
});

test('crash before publish: retry settles as provider_unavailable with nothing changed; startup sweep settles stale runs', async () => {
  const h = await harness();
  try {
    const a = await h.call('/api/sessions', 'POST', { description: 'Fictional crash-before-publish A' });
    h.agent.gate = never();
    let turn = abandonedTurn(h, a.data.id, a.cookie, travelBuyerTurn1);
    await until(() => h.agent.calls === 1, 'the agent to start');
    await turn.abort();
    await h.crash();
    h.agent.gate = null;
    const retry = await h.call(`/api/sessions/${a.data.id}/turns`, 'POST', travelBuyerTurn1, a.cookie);
    assert.equal(h.agent.calls, 1);
    assert.equal(retry.data.outcome, 'provider_unavailable');
    assert.equal(retry.data.version, 1);
    assert.match(retry.data.messages[1].text, /nothing changed\. Version 1 is still live/);
    assert.deepEqual(statuses((await h.call(`/api/sessions/${a.data.id}`, 'GET', undefined, a.cookie)).data), ['buyer:failed', 'tailor:failed']);

    const b = await h.call('/api/sessions', 'POST', { description: 'Fictional crash-before-publish B' });
    h.agent.gate = never();
    turn = abandonedTurn(h, b.data.id, b.cookie, travelBuyerTurn1);
    await until(() => h.agent.calls === 2, 'the second agent run');
    await turn.abort();
    h.clock.advance(TURN_DEADLINE_MS + 1);
    await h.crash();
    h.agent.gate = null;
    const swept = (await h.call(`/api/sessions/${b.data.id}`, 'GET', undefined, b.cookie)).data;
    assert.deepEqual(statuses(swept), ['buyer:failed', 'tailor:failed'], 'startup sweep resolves the orphaned Pending bubble without a retry');
    const late = await h.call(`/api/sessions/${b.data.id}/turns`, 'POST', travelBuyerTurn1, b.cookie);
    assert.equal(late.data.outcome, 'provider_unavailable');
    assert.equal(h.agent.calls, 2);
  } finally { await h.close(); }
});

test('client disconnect while the server finishes: in-flight retry is 409, then the stored response replays', async () => {
  const h = await harness();
  try {
    const created = await h.call('/api/sessions', 'POST', { description: 'Fictional disconnect agent' });
    const id = created.data.id; const cookie = created.cookie;
    let release!: () => void;
    h.agent.gate = new Promise<void>(r => { release = r; });
    const turn = abandonedTurn(h, id, cookie, travelBuyerTurn1);
    await until(() => h.agent.calls === 1, 'the agent to start');
    await turn.abort();
    const busy = await h.call(`/api/sessions/${id}/turns`, 'POST', travelBuyerTurn1, cookie);
    assert.equal(busy.status, 409); assert.equal(busy.data.error.code, 'TURN_IN_FLIGHT', 'a live run is never settled as interrupted');
    release(); h.agent.gate = null;
    await until(() => !statuses(h.store.read(id)).includes('buyer:pending'), 'the turn to settle');
    const replay = await h.call(`/api/sessions/${id}/turns`, 'POST', travelBuyerTurn1, cookie);
    assert.equal(replay.data.outcome, 'committed');
    assert.equal(replay.data.version, 2);
    assert.equal(h.agent.calls, 1);
    assert.deepEqual((await h.call(`/api/sessions/${id}/turns`, 'POST', travelBuyerTurn1, cookie)).data, replay.data);
  } finally { await h.close(); }
});

test('idempotency (L2-02): request hash mismatch is 409 and older turns replay from a bounded ring', async () => {
  const h = await harness();
  try {
    const created = await h.call('/api/sessions', 'POST', { description: 'Fictional idempotency agent' });
    const id = created.data.id; const cookie = created.cookie; const turns = `/api/sessions/${id}/turns`;
    const t1 = await h.call(turns, 'POST', travelBuyerTurn1, cookie);
    const t2 = await h.call(turns, 'POST', travelBuyerTurn2, cookie);
    assert.equal(t2.data.version, 3);
    const old = await h.call(turns, 'POST', travelBuyerTurn1, cookie);
    assert.deepEqual(old.data, t1.data, 'an older retry replays instead of running again');
    assert.equal(h.agent.calls, 2);
    const mismatch = await h.call(turns, 'POST', { ...travelBuyerTurn1, text: 'Delete everything and build me a payments agent' }, cookie);
    assert.equal(mismatch.status, 409); assert.equal(mismatch.data.error.code, 'IDEMPOTENCY_MISMATCH');
    assert.equal((await h.call(turns, 'POST', { ...travelBuyerTurn1, choiceId: 'c1' }, cookie)).data.error.code, 'IDEMPOTENCY_MISMATCH');
    assert.equal(h.agent.calls, 2);
    for (let i = 0; i < TURN_RUNS_PER_SESSION + 4; i++) assert.equal((await h.call(turns, 'POST', { text: `hello ${i}`, clientTurnId: randomUUID() }, cookie)).status, 200);
    const runs = h.store.db.prepare('SELECT COUNT(*) AS n FROM turn_runs WHERE session_id=?').get(id) as { n: number };
    assert.equal(runs.n, TURN_RUNS_PER_SESSION, 'the replay ring is bounded per session');
  } finally { await h.close(); }
});

test('sanitise (L4-08/L4-09): no "unchanged" claim at an advanced version; downgraded commits lose success copy', async () => {
  const h = await harness();
  try {
    const exec = { mode: 'mock' as const, provider: 'stub', model: null };
    const lie = (outcome: 'provider_unavailable' | 'answered' | 'rejected') => async (input: any) => {
      await input.tools.publishScenario({ ...travelProposalV1, expectedVersion: input.session.version });
      return { outcome, messages: [{ role: 'tailor' as const, status: 'failed' as const, text: "Something went wrong on my side, so I haven't changed anything." }], steps: [], execution: exec };
    };
    for (const outcome of ['provider_unavailable', 'answered', 'rejected'] as const) {
      const s = await h.call('/api/sessions', 'POST', { description: `Fictional ${outcome} after commit` });
      h.agent.script = lie(outcome);
      const r = await h.call(`/api/sessions/${s.data.id}/turns`, 'POST', { text: 'travel-booking', clientTurnId: randomUUID() }, s.cookie);
      assert.equal(r.data.outcome, 'readback_uncertain', outcome);
      assert.equal(r.data.version, 2);
      assert.deepEqual(r.data.messages.map((m: any) => m.status), ['uncertain', 'uncertain']);
      assert.doesNotMatch(r.data.messages[1].text, /haven't changed|nothing changed/);
    }
    const s = await h.call('/api/sessions', 'POST', { description: 'Fictional mismatched commit' });
    h.agent.script = async input => {
      const p = await input.tools.publishScenario(travelProposalV1);
      assert.equal(p.state, 'committed');
      const evidence = p.state === 'committed' ? { ...p.readback, version: 99 } : undefined;
      return { outcome: 'committed', messages: [{ role: 'tailor', status: 'applied', text: 'Saved and verified as version 2.' }], steps: [], execution: exec, ...(evidence ? { evidence } : {}), story: travelProposalV1.story };
    };
    const r = await h.call(`/api/sessions/${s.data.id}/turns`, 'POST', { text: 'travel-booking', clientTurnId: randomUUID() }, s.cookie);
    assert.equal(r.data.outcome, 'readback_uncertain');
    assert.equal(r.data.evidence, undefined);
    assert.doesNotMatch(r.data.messages[1].text, /verified/i, 'uncertain label never carries success text');
    const u = await h.call('/api/sessions', 'POST', { description: 'Fictional unchanged rejection' });
    h.agent.script = async () => ({ outcome: 'rejected', messages: [{ role: 'tailor', status: 'failed', text: 'Rejected; nothing changed.' }], steps: [], execution: exec });
    const kept = await h.call(`/api/sessions/${u.data.id}/turns`, 'POST', { text: 'anything', clientTurnId: randomUUID() }, u.cookie);
    assert.equal(kept.data.outcome, 'rejected', 'distinct outcomes survive when the version did not move');
    assert.equal(kept.data.messages[1].text, 'Rejected; nothing changed.');
    h.agent.script = null;
  } finally { await h.close(); }
});

test('execution label (L5-01): GET /api/execution and session reads carry mode, provider, model and effort', async () => {
  const live = { name: 'anthropic', model: 'claude-sonnet-5-5', mode: 'live' as const, effort: 'medium', async complete(): Promise<never> { throw new Error('never called'); } };
  const h = await harness({ provider: live });
  try {
    const expected = { mode: 'live', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' };
    const info = await h.call('/api/execution');
    assert.equal(info.status, 200);
    assert.deepEqual(info.data, { execution: expected }, 'no session or cookie needed');
    const created = await h.call('/api/sessions', 'POST', { description: 'Fictional labelled agent' });
    assert.deepEqual(created.data.execution, expected);
    assert.deepEqual((await h.call('/api/session', 'GET', undefined, created.cookie)).data.execution, expected);
    assert.deepEqual((await h.call(`/api/sessions/${created.data.id}`, 'GET', undefined, created.cookie)).data.execution, expected);
    h.agent.throwAfter = 'nothing';
    const failed = await h.call(`/api/sessions/${created.data.id}/turns`, 'POST', { text: 'hi', clientTurnId: randomUUID() }, created.cookie);
    assert.deepEqual(failed.data.execution, expected, 'the server fallback label includes effort');
  } finally { await h.close(); }
  const m = await harness();
  try { assert.deepEqual((await m.call('/api/execution')).data, { execution: { mode: 'mock', provider: 'stub', model: null, effort: null } }); } finally { await m.close(); }
});

test('openTraceId (L5-02): validated, scoped to this session, hashed and passed to the agent', async () => {
  const h = await harness();
  try {
    const a = await h.call('/api/sessions', 'POST', { description: 'Fictional open-trace A' });
    const b = await h.call('/api/sessions', 'POST', { description: 'Fictional open-trace B' });
    const turns = `/api/sessions/${a.data.id}/turns`;
    const foreign = await h.call(turns, 'POST', { text: 'Explain this trace', clientTurnId: randomUUID(), openTraceId: b.data.dataset.traces[0].id }, a.cookie);
    assert.equal(foreign.status, 422); assert.equal(foreign.data.error.code, 'TRACE_NOT_FOUND');
    assert.doesNotMatch(foreign.data.error.message, new RegExp(b.data.id));
    for (const bad of ['has space', 'x'.repeat(121), 42]) assert.equal((await h.call(turns, 'POST', { text: 'Explain', clientTurnId: randomUUID(), openTraceId: bad }, a.cookie)).data.error.code, 'TRACE_NOT_FOUND');
    assert.equal(h.agent.calls, 0);
    assert.equal(h.store.read(a.data.id).conversation.length, 0, 'rejected before the buyer turn is stored');
    const open = a.data.dataset.traces[1].id;
    const req = { text: 'Explain this trace', clientTurnId: randomUUID(), openTraceId: open };
    assert.equal((await h.call(turns, 'POST', req, a.cookie)).status, 200);
    assert.equal(h.agent.lastInput?.request.openTraceId, open);
    assert.equal((await h.call(turns, 'POST', { ...req, openTraceId: a.data.dataset.traces[0].id }, a.cookie)).data.error.code, 'IDEMPOTENCY_MISMATCH');
  } finally { await h.close(); }
});

test('request bodies (L2-08/L2-09): chunked multibyte UTF-8 survives and the media type must match exactly', async () => {
  const h = await harness();
  try {
    const description = '€'.repeat(3999);
    const raw = Buffer.from(JSON.stringify({ description }));
    const created = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: h.port, path: '/api/sessions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': raw.length, 'idempotency-key': randomUUID() } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      (async () => { for (let i = 0; i < raw.length; i += 1001) { req.write(raw.subarray(i, i + 1001)); await sleep(2); } req.end(); })();
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.description, description, 'no U+FFFD from split code points');
    for (const [type, status] of [['application/jsonxyz', 415], ['text/plain', 415], ['Application/JSON; charset=utf-8', 201]] as const) {
      assert.equal((await h.call('/api/sessions', 'POST', { description: 'Fictional media type' }, '', { 'content-type': type })).status, status, type);
    }
  } finally { await h.close(); }
});

test('developer routes (L2-12): constant-time key check, metadata-only session list, telemetry diagnostics', async () => {
  const h = await harness();
  try {
    const created = await h.call('/api/sessions', 'POST', { description: 'Fictional SECRET-MARKER desk' });
    await h.call(`/api/sessions/${created.data.id}/turns`, 'POST', { text: 'hello SECRET-MARKER', clientTurnId: randomUUID() }, created.cookie);
    for (const key of ['', 'wrong', 'local-test-key-but-longer']) assert.equal((await h.call('/api/dev/sessions', 'GET', undefined, '', { 'x-tailor-dev-key': key })).status, 403, key);
    const list = await h.call('/api/dev/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].id, created.data.id);
    assert.equal(JSON.stringify(list.data).includes('SECRET-MARKER'), false, 'no description or conversation');
    const diag = await h.call('/api/dev/telemetry');
    assert.equal(diag.status, 200);
    assert.deepEqual(diag.data, h.telemetry.diagnostics());
    assert.equal((await h.call('/api/dev/telemetry', 'GET', undefined, '', { 'x-tailor-dev-key': 'nope' })).status, 403);
  } finally { await h.close(); }
});
