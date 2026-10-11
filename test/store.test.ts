import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS } from '../src/agent-contract.ts';
import { travelProposalV1, travelProposalV2 } from '../src/examples/travel-booking.ts';
import { Store, Failure, TOMBSTONE_TTL_MS } from '../src/store.ts';
import { createSessionTools } from '../src/session-tools.ts';
import { MINUTE, op, tempStore } from './helpers/backend.ts';

const failureCode = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof Failure ? `${e.status} ${e.code}` : String(e); } return 'no error'; };
const rowCount = (store: Store) => (store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

test('create defaults to the recovered fixture sample with lifecycle fields from the server clock', () => {
  const t = tempStore();
  try {
    const s = t.store.create('Fictional travel agent', undefined, op());
    assert.equal(s.version, 1); assert.equal(s.conversationVersion, 1); assert.equal(s.story, null); assert.equal(s.state, 'active');
    assert.equal(s.dataset.activeScenario, 'recovered'); assert.equal(s.dataset.traces.length, 2);
    assert.equal(s.lastActiveAt, new Date(t.clock.now()).toISOString());
    assert.equal(Date.parse(s.expiresAt) - Date.parse(s.createdAt), LIMITS.lifetimeMs);
    t.clock.advance(59 * MINUTE);
    assert.deepEqual(t.store.read(s.id).dataset, s.dataset, 'reload before expiry restores the saved version');
    assert.equal(failureCode(() => t.store.create('', undefined, op())), '422 INVALID_SESSION');
  } finally { t.cleanup(); }
});

test('idle expiry after 60 minutes deletes the row; access answers 410 then 404', () => {
  const t = tempStore();
  try {
    const s = t.store.create('Idle demo', 'recovered', op());
    t.clock.advance(LIMITS.idleMs + 1);
    assert.equal(failureCode(() => t.store.read(s.id)), '410 SESSION_EXPIRED');
    assert.equal(rowCount(t.store), 0, 'row deleted on access');
    assert.equal(failureCode(() => t.store.read(s.id)), '404 NOT_FOUND');
  } finally { t.cleanup(); }
});

test('4 hour lifetime expires even when the buyer is active every 30 minutes', () => {
  const t = tempStore();
  try {
    const s = t.store.create('Busy demo', undefined, op());
    for (let i = 0; i < 7; i++) { t.clock.advance(30 * MINUTE); t.store.touch(s.id); }
    assert.equal(t.store.read(s.id).id, s.id, 'still live at 3h30');
    t.clock.advance(30 * MINUTE);
    assert.equal(failureCode(() => t.store.touch(s.id)), '410 SESSION_EXPIRED');
    assert.equal(rowCount(t.store), 0);
  } finally { t.cleanup(); }
});

test('End demo is idempotent, deletes content immediately and leaves a 410 tombstone that is swept', () => {
  const t = tempStore();
  try {
    const s = t.store.create('Ending demo', undefined, op());
    t.store.appendTurns(s.id, [{ role: 'buyer', text: 'Fictional message', status: 'note' }]);
    assert.deepEqual(t.store.end(s.id), { ended: true });
    assert.deepEqual(t.store.end(s.id), { ended: true }, 'second end is a no-op');
    const row = { ...t.store.db.prepare('SELECT document, state, last_turn FROM sessions WHERE id=?').get(s.id) } as { document: string; state: string; last_turn: string | null };
    assert.deepEqual(row, { document: '{}', state: 'ended', last_turn: null }, 'no description, dataset or conversation remains');
    assert.equal(failureCode(() => t.store.read(s.id)), '410 SESSION_ENDED');
    assert.equal(failureCode(() => t.store.appendTurns(s.id, [{ role: 'buyer', text: 'late', status: 'note' }])), '410 SESSION_ENDED');
    assert.deepEqual(t.store.publish(s.id, travelProposalV1), { state: 'expired' }, 'no late publish');
    t.clock.advance(TOMBSTONE_TTL_MS + 1);
    assert.deepEqual(t.store.sweep(), { expired: 0, tombstones: 1 });
    assert.equal(failureCode(() => t.store.read(s.id)), '404 NOT_FOUND');
  } finally { t.cleanup(); }
});

test('sweep deletes expired sessions nobody revisits and keeps live ones', () => {
  const t = tempStore();
  try {
    const old = t.store.create('Abandoned demo', undefined, op());
    t.clock.advance(30 * MINUTE);
    const fresh = t.store.create('Fresh demo', undefined, op());
    t.clock.advance(31 * MINUTE);
    assert.deepEqual(t.store.sweep(), { expired: 1, tombstones: 0 });
    assert.equal(rowCount(t.store), 1);
    assert.equal(t.store.read(fresh.id).id, fresh.id);
    assert.equal(failureCode(() => t.store.read(old.id)), '404 NOT_FOUND');
  } finally { t.cleanup(); }
});

test('restart (close/reopen) preserves active sessions; expired rows are swept at startup', () => {
  const t = tempStore();
  try {
    const a = t.store.create('Survives restart', undefined, op());
    t.store.publish(a.id, travelProposalV1);
    t.store.close();
    const reopened = new Store(t.path, { clock: t.clock });
    assert.equal(reopened.read(a.id).version, 2);
    t.clock.advance(LIMITS.idleMs + 1);
    reopened.close();
    const again = new Store(t.path, { clock: t.clock });
    assert.equal(rowCount(again), 0, 'startup sweep removed the idle session');
    again.close();
  } finally { t.cleanup(); }
});

test('legacy NIT-265 rows migrate: columns added, lifetime derived from createdAt', () => {
  const t = tempStore();
  try {
    t.store.close();
    const legacyPath = `${t.path}.legacy`;
    const db = new DatabaseSync(legacyPath);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, operation TEXT UNIQUE NOT NULL, document TEXT NOT NULL)');
    const created = new Date(t.clock.now() - 7 * 24 * 60 * MINUTE).toISOString();
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('legacy-1', 'legacy-operation-0001', JSON.stringify({ id: 'legacy-1', description: 'old', createdAt: created, version: 1, dataset: {}, conversation: [] }));
    db.close();
    const migrated = new Store(legacyPath, { clock: t.clock });
    const cols = (migrated.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name);
    for (const c of ['state', 'last_active_at', 'expires_at', 'last_turn']) assert.ok(cols.includes(c), c);
    assert.equal(rowCount(migrated), 0, 'week-old legacy session is past its lifetime and swept');
    assert.equal(failureCode(() => migrated.read('legacy-1')), '404 NOT_FOUND');
    migrated.close();
  } finally { t.cleanup(); }
});

test('publish: committed with independent readback, stale conflict, rejection leaves state unchanged', () => {
  const t = tempStore();
  try {
    const s = t.store.create('Publishing demo', undefined, op());
    const r1 = t.store.publish(s.id, travelProposalV1);
    assert.equal(r1.state, 'committed');
    if (r1.state !== 'committed') return;
    assert.equal(r1.version, 2);
    const saved = t.store.read(s.id);
    assert.deepEqual(r1.readback.traceIds, saved.dataset.traces.map(x => x.id));
    assert.deepEqual(r1.readback.spanIds, saved.dataset.traces.flatMap(x => x.spans.map(y => y.id)));
    assert.equal(r1.readback.traces[0]!.rootDurationMs, 2860);
    assert.deepEqual(r1.readback.traces[0]!.errorSpanIds, [`${s.id}-booking-timeout-retry-ok-attempt-1`]);
    assert.deepEqual(t.store.publish(s.id, travelProposalV1), { state: 'conflict', currentVersion: 2 }, 'stale expectedVersion');
    const broken = structuredClone(travelProposalV2); broken.traces[0]!.spans[1]!.parentKey = 'ghost';
    const rejected = t.store.publish(s.id, broken);
    assert.equal(rejected.state, 'rejected');
    if (rejected.state === 'rejected') { assert.equal(rejected.version, 2); assert.ok(rejected.problems.some(p => p.code === 'UNKNOWN_PARENT')); }
    assert.deepEqual(t.store.read(s.id).dataset, saved.dataset);
    const r2 = t.store.publish(s.id, travelProposalV2);
    assert.equal(r2.state, 'committed');
    if (r2.state === 'committed') { assert.equal(r2.version, 3); assert.equal(r2.readback.activeScenario, 'booking-timeout-retry-fails'); assert.equal(r2.readback.traceIds.length, 2); }
  } finally { t.cleanup(); }
});

test('appendTurns: append-only versions, one 409 for a concurrent append, settle + story, trimming at the cap', () => {
  const t = tempStore();
  try {
    const s = t.store.create('Chat demo', undefined, op());
    const first = t.store.appendTurns(s.id, [{ role: 'buyer', text: '  Show a timeout  ', status: 'pending' }], { expectedConversationVersion: 1 });
    assert.equal(first.session.conversationVersion, 2);
    assert.equal(first.appended[0]!.text, 'Show a timeout');
    assert.ok(first.appended[0]!.id && first.appended[0]!.at);
    assert.equal(failureCode(() => t.store.appendTurns(s.id, [{ role: 'buyer', text: 'racing', status: 'pending' }], { expectedConversationVersion: 1 })), '409 CONVERSATION_CONFLICT');
    const second = t.store.appendTurns(s.id, [{ role: 'tailor', text: 'Saved.', status: 'applied' }], { expectedConversationVersion: 2, settle: { id: first.appended[0]!.id, status: 'applied' }, story: travelProposalV1.story });
    assert.equal(second.session.conversationVersion, 3);
    assert.deepEqual(second.session.conversation.map(c => c.status), ['applied', 'applied']);
    assert.deepEqual(t.store.read(s.id).story, travelProposalV1.story);
    assert.equal(failureCode(() => t.store.appendTurns(s.id, [{ role: 'buyer', text: 'x'.repeat(LIMITS.maxTurnTextChars + 1), status: 'note' }])), '422 TURN_TEXT_INVALID');
    assert.equal(failureCode(() => t.store.appendTurns(s.id, Array.from({ length: LIMITS.maxConversationTurns + 1 }, () => ({ role: 'buyer' as const, text: 'x', status: 'note' as const })))), '413 CONVERSATION_FULL');
    for (let i = 0; i < 60; i++) t.store.appendTurns(s.id, [{ role: 'buyer', text: `b${i}`, status: 'note' }, { role: 'tailor', text: `t${i}`, status: 'note' }]);
    const full = t.store.read(s.id);
    assert.equal(full.conversation.length, LIMITS.maxConversationTurns);
    assert.equal(full.conversationTruncated, true);
    assert.equal(full.conversation[0]!.text, 'b0', 'oldest turns trimmed first');
    assert.equal(full.conversationVersion, 3 + 60);
  } finally { t.cleanup(); }
});

test('faults: save_failed leaves the version unchanged; readback_uncertain reports attemptedVersion and the next read shows the truth', () => {
  let failSave = false; let failReadback = false;
  const t = tempStore({ faults: { failSave: () => failSave, failReadback: () => failReadback } });
  try {
    const s = t.store.create('Fault demo', undefined, op());
    failSave = true;
    const saveFailed = t.store.publish(s.id, travelProposalV1);
    assert.equal(saveFailed.state, 'save_failed');
    if (saveFailed.state === 'save_failed') assert.equal(saveFailed.version, 1);
    const reread = t.store.read(s.id);
    assert.equal(reread.version, 1); assert.equal(reread.dataset.activeScenario, 'recovered');
    failSave = false; failReadback = true;
    const uncertain = t.store.publish(s.id, travelProposalV1);
    assert.deepEqual({ ...uncertain, reason: undefined }, { state: 'readback_uncertain', attemptedVersion: 2, lastKnownVersion: 1, reason: undefined });
    failReadback = false;
    const truth = t.store.read(s.id);
    assert.equal(truth.version, 2, 'the commit did happen');
    assert.equal(truth.dataset.activeScenario, 'booking-timeout-retry-ok');
  } finally { t.cleanup(); }
});

test('in-flight expiry: the session expires between the agent read and publish -> expired, nothing written', async () => {
  const t = tempStore();
  try {
    const s = t.store.create('Slow agent demo', undefined, op());
    const tools = createSessionTools(t.store, s.id, t.clock);
    const snapshot = await tools.readSession();
    assert.equal(snapshot.version, 1);
    assert.equal(JSON.stringify(snapshot).includes('token'), false);
    t.clock.advance(LIMITS.idleMs + 1);
    assert.deepEqual(await tools.publishScenario(travelProposalV1), { state: 'expired' });
    assert.equal(rowCount(t.store), 0, 'expired session deleted, not resurrected');
  } finally { t.cleanup(); }
});

test('in-transaction recheck: expiry detected inside BEGIN IMMEDIATE does not write', () => {
  const t = tempStore();
  let advanced = false;
  const s = t.store.create('Race demo', undefined, op());
  // Expire the session after validation but before the transaction re-reads the row.
  const original = t.store.clock.now;
  let calls = 0;
  t.store.clock.now = () => { calls++; if (calls === 3 && !advanced) { advanced = true; t.clock.advance(LIMITS.idleMs + 1); } return original(); };
  try {
    assert.deepEqual(t.store.publish(s.id, travelProposalV1), { state: 'expired' });
    assert.ok(advanced, 'clock advanced mid-publish');
    assert.equal(rowCount(t.store), 0);
  } finally { t.store.clock.now = original; t.cleanup(); }
});

test('session tools are bound to one session and share HTTP filter semantics', async () => {
  const t = tempStore();
  try {
    const a = t.store.create('Tools A', undefined, op());
    const b = t.store.create('Tools B', 'exhausted', op());
    const tools = createSessionTools(t.store, a.id, t.clock);
    assert.equal((await tools.readTraces({ scenario: 'recovered' })).filtered, 1);
    assert.equal((await tools.readTraces({ detection: 'yes' })).filtered, 1);
    assert.equal((await tools.readTraces({ minMs: 45 })).filtered, 1);
    await assert.rejects(tools.readTraces({ scenario: 'booking-timeout-retry-ok' }), (e: Failure) => e.code === 'INVALID_FILTER');
    assert.equal(await tools.readTrace(b.dataset.traces[0]!.id), null, 'another session’s trace is invisible');
    assert.deepEqual(await tools.validateProposal(travelProposalV1), { ok: true });
    assert.equal(t.store.read(a.id).version, 1, 'validateProposal never writes');
    await tools.publishScenario(travelProposalV1);
    assert.equal((await tools.readTraces({ scenario: 'booking-timeout-retry-ok' })).filtered, 1, 'scenario filter follows the dataset keys');
  } finally { t.cleanup(); }
});
