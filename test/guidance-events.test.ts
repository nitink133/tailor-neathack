import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers/backend.ts';
import { resolveGuidance } from '../src/clients/neatlogs/guidance.ts';

test('guidance observations are session-owned, redacted and reject stale success without mutation', async () => {
  const h = await harness({ telemetry: 'captured' });
  try {
    const a = await h.call('/api/sessions', 'POST', { description: 'Synthetic support fixture' });
    const b = await h.call('/api/sessions', 'POST', { description: 'Other synthetic fixture' });
    const snapshot = h.store.snapshot(a.data.id);
    const guidance = resolveGuidance([{ targetId: 'trace.slowest-span' }], snapshot);
    assert.equal(guidance.length, 1);
    const appended = h.store.appendTurns(a.data.id, [{ role: 'tailor', status: 'note', text: 'Saved timing.', guidance }]);
    const messageId = appended.appended[0]!.id;
    const suggestionId = guidance[0]!.id;
    const route = `/api/sessions/${a.data.id}/guidance-events`;
    const observation = { messageId, suggestionId, outcome: 'shown' };
    assert.equal((await h.call(route, 'POST', observation, b.cookie)).status, 404);
    assert.equal((await h.call(route, 'POST', { ...observation, selector: '.anything' }, a.cookie)).status, 422);
    assert.equal((await h.call(route, 'POST', { ...observation, suggestionId: 'foreign' }, a.cookie)).status, 404);
    for (const outcome of ['selected', 'shown', 'dismissed']) {
      const response = await h.call(route, 'POST', { ...observation, outcome }, a.cookie);
      assert.equal(response.status, 200); assert.equal(response.data.recorded, true);
      assert.equal(response.data.receiptState, 'unverified');
    }
    const before = h.store.read(a.data.id);
    assert.equal(before.version, snapshot.version);
    const spans = h.telemetry.captured().filter(s => s.name === 'tailor.guidance');
    assert.equal(spans.length, 3);
    assert.deepEqual(spans.map(s => s.attributes['tailor.guidance_outcome']), ['selected', 'shown', 'dismissed']);
    const dump = JSON.stringify(spans);
    for (const raw of [a.data.id, messageId, suggestionId, guidance[0]!.binding.traceId]) assert.equal(dump.includes(raw), false);
    assert.equal(spans[1]!.attributes['tailor.guidance_target'], 'trace.slowest-span');
    h.store.applyScenario(a.data.id, 'exhausted', before.version);
    assert.equal((await h.call(route, 'POST', observation, a.cookie)).status, 409);
    assert.equal((await h.call(route, 'POST', { ...observation, outcome: 'failed', reason: 'stale' }, a.cookie)).status, 200);
    assert.equal(h.telemetry.captured().filter(s => s.name === 'tailor.guidance').length, 4);
  } finally { await h.close(); }
});
