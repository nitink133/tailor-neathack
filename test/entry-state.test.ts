import assert from 'node:assert/strict';
import test from 'node:test';
import { publicCapabilities } from '../src/clients/neatlogs/capabilities.ts';
import { entrySavedState, entrySuggestions, suggestionBatch } from '../src/clients/neatlogs/entry-state.ts';
import { classifyOfflinePolicy } from '../src/clients/neatlogs/entry-policy.ts';
import type { BrowserSession, DemoSummary } from '../src/tailor/demo-contract.ts';

const demo: DemoSummary = { id: 'owned-demo', productId: 'neatlogs', label: 'Invoice', version: 1, conversationVersion: 1, createdAt: '', lastActiveAt: '' };
const session = (activeDemoId: string | null = demo.id): BrowserSession => ({ id: 'browser', state: 'active', createdAt: '', lastActiveAt: '', expiresAt: '', version: 1, activeDemoId, demos: [demo] });

test('entry resume only uses an active server-owned demo; saved choices do not require active selection', () => {
  assert.deepEqual(entrySavedState(), { demos: [], activeDemo: undefined });
  assert.equal(entrySavedState(session()).activeDemo?.id, demo.id);
  assert.equal(entrySavedState(session('stale-local-id')).activeDemo, undefined);
  assert.deepEqual(entrySavedState(session(null)).demos, [demo]);
  assert.equal(entrySavedState({ ...session(), state: 'ended' }).demos.length, 0);
  assert.equal(entrySavedState({ ...session(), state: 'expired' }).activeDemo, undefined);
  assert.equal(entrySavedState({ ...session(), demos: [{ ...demo, id: '' }] }).demos.length, 0);
});

test('six entry questions are grounded in three projected executable starters and cycle predictably', () => {
  const projection = publicCapabilities();
  const suggestions = entrySuggestions(projection);
  assert.equal(suggestions.length, 6);
  assert.equal(new Set(suggestions.map(s => s.prompt)).size, 6);
  assert.ok(suggestions.every(s => projection.starters.some(p => p.capabilityId === s.capabilityId)));
  assert.deepEqual(suggestionBatch(suggestions, 0).map(s => s.id), projection.starters.map(s => s.id));
  assert.equal(suggestionBatch(suggestions, 1).length, 3);
  assert.deepEqual(suggestionBatch(suggestions, 2), suggestionBatch(suggestions, 0));
  assert.deepEqual(entrySuggestions(), []);
  assert.deepEqual(suggestionBatch([], 1), []);
  assert.deepEqual(entrySuggestions({ ...projection, capabilities: projection.capabilities.map(c => ({ ...c, support: 'explain_only' })) }), []);
});

test('all six grounded entry prompts pass the real mock entry gate as fictional workflow actions', () => {
  for (const suggestion of entrySuggestions(publicCapabilities())) {
    const decision = classifyOfflinePolicy({ remit: '', capabilities: '', latestText: suggestion.prompt, session: { hasPublishedState: false, pendingClarification: null, resolvedChoice: null } });
    assert.equal(decision.outcome, 'allow_demo_action', suggestion.id);
  }
});

test('unknown projected starter stays unchanged and acquires no alternate claim', () => {
  const suggestions = entrySuggestions({ starters: [{ id: 'future', capabilityId: 'future', title: 'Future starter', prompt: 'Verified prompt' }], capabilities: [{ id: 'future', support: 'executable' }] });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.prompt, 'Verified prompt');
});
