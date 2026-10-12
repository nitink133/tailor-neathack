import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryPreflight } from '../src/clients/neatlogs/entry-policy.ts';
import type { DemoSwitchConfirmation, SessionSnapshot } from '../src/clients/neatlogs/agent-contract.ts';
import { harness, scriptedProvider } from './helpers/agent.ts';

const switchQuestion: DemoSwitchConfirmation = {
  kind: 'demo_switch', referenceId: 'pending-switch-reference', sourceDemoId: 'sess-test', sourceVersion: 2,
  browserSessionVersion: 2, sourceConversationVersion: 4, requestedSummary: 'warehouse shift scheduling agent',
  question: 'This changes the workflow. Adapt the current demo, start a separate demo, or keep the current one?',
  choices: [{ id: 'adapt_current', label: 'Adapt current demo' }, { id: 'start_separate', label: 'Start separate demo' }, { id: 'keep_current', label: 'Keep current demo' }], allowFreeText: true,
};

test('intervening explanation acknowledges unapplied material switch without republishing expired confirmation controls', async () => {
  const h = harness();
  await h.say('Show a travel-booking agent with an API timeout.');
  h.conversation.push({ role: 'buyer', id: 'correction', status: 'note', text: 'Start over: my agent actually schedules warehouse shifts. Show a calendar API timeout instead.', at: '2026-10-12T12:00:00Z' },
    { role: 'tailor', id: 'confirmation', status: 'question', text: switchQuestion.question, clarification: structuredClone(switchQuestion), at: '2026-10-12T12:00:01Z' });
  const saved = structuredClone(h.tools.state), calls = h.provider.calls.length;
  const response = await h.say('Explain the current workflow.');
  assert.equal(response.outcome, 'clarification');
  const q = response.messages[0]!.clarification!;
  assert.match(q.question, /change has not been applied/);
  assert.match(q.question, /travel-booking agent.*version 2/);
  assert.match(q.question, /describe the change again to request a fresh confirmation/);
  assert.equal(q.referenceId, undefined);
  assert.notEqual(q.kind, 'demo_switch');
  assert.ok(q.choices.every(c => !['adapt_current', 'start_separate', 'keep_current'].includes(c.id)));
  assert.match(q.choices[1].label, /restate/);
  assert.equal(h.provider.calls.length, calls);
  assert.deepEqual(h.tools.state, saved);
  const explained = await h.say(q.choices[0].label, { choiceId: q.choices[0].id });
  assert.equal(explained.outcome, 'answered');
  assert.deepEqual(h.tools.state, saved);
});

test('foreign and stale material-switch metadata cannot produce owned pending-change recovery', async () => {
  const h = harness(); await h.say('Show a travel-booking agent with an API timeout.');
  for (const change of [{ sourceDemoId: 'foreign-session' }, { sourceVersion: 1 }]) {
    const clarification = { ...structuredClone(switchQuestion), ...change };
    const session: SessionSnapshot = { id: 'sess-test', ...structuredClone(h.tools.state), conversationVersion: 4, state: 'active', expiresAt: '2026-10-12T23:00:00Z',
      conversation: [{ id: 'confirmation', role: 'tailor', status: 'question', text: clarification.question, clarification, at: '2026-10-12T12:00:00Z' }] };
    const text = 'Explain the current workflow.';
    const result = await entryPreflight({ session, buyerText: text, request: { text, clientTurnId: 'explain-current' }, choice: null, provider: scriptedProvider(() => { throw Error('preflight must not plan'); }) });
    assert.equal(result.kind, 'continue');
  }
});
