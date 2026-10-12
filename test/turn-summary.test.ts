import assert from 'node:assert/strict';
import test from 'node:test';
import { turnSummary } from '../src/clients/neatlogs/turn-summary.ts';
import type { TurnOutcome, TurnStep } from '../src/clients/neatlogs/agent-contract.ts';

const step = (name: TurnStep['name'], status: TurnStep['status'] = 'ok'): TurnStep => ({ name, status });
const confirmed = [step('load_context'), step('retrieve_knowledge'), step('model'), step('save'), step('readback')];

test('committed summary requires successful save and independent confirmation, while earlier repaired failures do not erase the latest result', () => {
  const saved = 'Saved your synthetic demo and confirmed the saved trace.';
  assert.equal(turnSummary(confirmed, 'committed'), saved);
  assert.equal(turnSummary([step('save', 'failed'), step('readback', 'failed'), ...confirmed, step('explain', 'failed')], 'committed'), saved);
  assert.equal(turnSummary([step('save', 'skipped'), step('readback', 'skipped')], 'committed'), '');
  assert.equal(turnSummary([step('readback')], 'committed'), '');
  assert.match(turnSummary([step('save'), step('readback', 'failed')], 'committed'), /saved, but I couldn’t confirm/);
  assert.match(turnSummary([step('save'), step('readback', 'skipped')], 'committed'), /saved, but I couldn’t confirm/);
});

test('uncertain outcome overrides successful intermediate steps and never presents a confirmed save', () => {
  const summary = turnSummary(confirmed, 'readback_uncertain');
  assert.equal(summary, 'Your demo may have been saved, but I couldn’t verify the saved trace.');
  assert.doesNotMatch(summary, /and confirmed|unchanged|Nothing was changed/);
});

test('failure outcomes retain their own result even when earlier stages succeeded', () => {
  const cases: [TurnOutcome, string][] = [
    ['save_failed', 'I couldn’t save your changes, so your demo is unchanged.'],
    ['rejected', 'Your request didn’t pass the demo’s checks, so nothing was changed.'],
    ['refused', 'I declined that request. Nothing was changed.'],
    ['unsupported', 'That action isn’t available in this demo. Nothing was changed.'],
    ['conflict', 'The demo changed before I could save your request. Your changes weren’t applied.'],
    ['expired', 'This demo has ended or expired. Start a new demo to continue.'],
    ['provider_unavailable', 'I couldn’t finish this request. Nothing was changed.'],
  ];
  for (const [outcome, expected] of cases) {
    assert.equal(turnSummary(confirmed, outcome), expected);
    assert.doesNotMatch(turnSummary(confirmed, outcome), /and confirmed|Verified|Fixed a problem/);
  }
});

test('clarification asks for a choice without implying that a repair or change happened', () => {
  const summary = turnSummary([step('model'), step('repair', 'failed')], 'clarification');
  assert.equal(summary, 'Choose an option or describe what you want next. No demo changes have been made.');
});

test('answers distinguish recorded knowledge lookup from trace lookup and failed reads', () => {
  assert.equal(turnSummary([step('load_context'), step('retrieve_knowledge'), step('model')], 'answered'), 'I checked the product knowledge for your question. Nothing was changed.');
  assert.equal(turnSummary([...confirmed.slice(0, 3), step('explain')], 'answered'), 'I checked for the saved trace to help explain your request. Nothing was changed.');
  assert.equal(turnSummary([step('retrieve_knowledge'), step('explain', 'failed')], 'answered'), 'I couldn’t read the saved trace. Nothing was changed.');
  assert.equal(turnSummary([step('explain')], 'answered'), '');
  assert.equal(turnSummary([step('retrieve_knowledge', 'skipped'), step('explain', 'skipped')], 'answered'), '');
});

test('partial or unknown outcomes produce no guessed success and step details never leak into the summary', () => {
  assert.equal(turnSummary([], undefined), '');
  assert.equal(turnSummary(confirmed), '');
  assert.equal(turnSummary(confirmed, 'pending' as TurnOutcome), '');
  assert.equal(turnSummary([{ ...step('retrieve_knowledge'), detail: 'PRIVATE_DETAIL_MARKER' }], 'answered').includes('PRIVATE_DETAIL_MARKER'), false);
});
