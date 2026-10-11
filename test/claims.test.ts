// Truthfulness/grounding tests (audit L1-03, L1-04, L1-05). Pure functions: no provider, no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReadbackEvidence } from '../src/agent-contract.ts';
import type { Trace } from '../src/contracts.ts';
import { loadKnowledge } from '../src/clients/neatlogs/knowledge.ts';
import { filteredLead, composeAnswer } from '../src/clients/neatlogs/answer.ts';
import { groundNarrative, groundNarrativeOrFallback, safeNarrative } from '../src/clients/neatlogs/explain.ts';
import { hasPricingClaim, sanitiseClarificationText, splitSentences, stripUngroundedClaims, allWordsGroundedIn } from '../src/clients/neatlogs/claims.ts';

// -- L1-03: refuse / unsupported text -------------------------------------------------------------------------------
test('L1-03: the audit probe sentences for unsupported/refuse replies are removed', () => {
  assert.equal(stripUngroundedClaims('Slack alerts are on the Neatlogs Pro plan for $49/month; I can’t wire them here.'), '');
  assert.equal(stripUngroundedClaims('I won’t change your real project, but Neatlogs Enterprise ($999/yr) can do that automatically.'), '');
  assert.equal(stripUngroundedClaims('Slack alerts need the Neatlogs Pro plan at $49/month; I can wire them for you on Pro.'), '');
  assert.equal(stripUngroundedClaims('I won’t do that here, but the Enterprise plan ($999/yr) does it automatically.'), '');
});

test('L1-03: each claim class is dropped on its own, and only the offending sentence goes', () => {
  const claims = [
    'It costs 20 EUR a month.', // price
    'Slack alerts are included in the Team plan.', // plan name
    'Every plan has this.', // blanket plan
    'It is available on all plans at no extra charge.',
    'Neatlogs offers SSO out of the box.', // capability assertion
    'Neatlogs would page your on-call team in PagerDuty.',
    'It automatically retries failed steps.',
    'The platform supports Slack and PagerDuty.',
    'Neatlogs keeps your traces for 90 days.', // retention number
    'Retention is up to 30 days.',
    'See https://neatlogs.example/pricing for details.',
  ];
  for (const c of claims) assert.equal(stripUngroundedClaims(c), '', c);
  assert.equal(stripUngroundedClaims(`${claims[4]} I can’t set that up here. Nothing was changed.`), 'I can’t set that up here. Nothing was changed.');
});

test('L1-03: neutral refusal and unsupported copy survives untouched', () => {
  for (const ok of [
    'I can’t set that up here. Nothing was changed.',
    'That’s outside what this demo can do.',
    'Replay isn’t something this demo can do.',
    'I won’t change anything in a real project; this demo only edits synthetic traces.',
    'Alerts and notifications is explain-only in this demo: I can describe it but not run it.',
    'Could you tell me which step should fail?',
  ]) assert.equal(stripUngroundedClaims(ok), ok, ok);
});

test('L1-03: a capability claim is not excused by a demo-scope clause bolted onto it', () => {
  assert.equal(stripUngroundedClaims('Neatlogs can page PagerDuty, but I can’t do that here.'), '');
  assert.equal(stripUngroundedClaims('Neatlogs would page your team; nothing was changed.'), '');
});

test('L1-03: empty and all-claims input return an empty string', () => {
  assert.equal(stripUngroundedClaims(''), '');
  assert.equal(stripUngroundedClaims('Neatlogs Pro costs $49/month. Enterprise is $999/yr. It automatically fixes everything.'), '');
  assert.equal(stripUngroundedClaims('```json\n{"price": 1}\n``` Neatlogs offers a Pro plan.'), '');
});

test('L1-03: code-fence contents never survive', () => {
  assert.equal(stripUngroundedClaims('Nothing was changed. ```Neatlogs costs $5``` Done.'), 'Nothing was changed. Done.');
});

test('hasPricingClaim covers "no extra charge" and "free of charge" and keeps plain "pricing" copy', () => {
  for (const s of ['It comes at no extra charge.', 'Alerts are free of charge.', 'It is $5.', 'Billed per seat.']) assert.equal(hasPricingClaim(s), true, s);
  for (const s of ['Pricing details are published by the vendor.', 'I don’t have verified prices.']) assert.equal(hasPricingClaim(s), false, s);
});

test('splitSentences keeps decimals and identifiers together', () => {
  assert.deepEqual(splitSentences('It took 2.86 s. call_api_1 failed! Why?'), ['It took 2.86 s.', 'call_api_1 failed!', 'Why?']);
});

// -- clarification path ---------------------------------------------------------------------------------------------
test('clarification questions and choice labels pass through the same claim filter', () => {
  assert.equal(sanitiseClarificationText('Which step should fail?'), 'Which step should fail?');
  assert.equal(sanitiseClarificationText('The payment step'), 'The payment step');
  assert.equal(sanitiseClarificationText('Do you want the Pro plan ($49/month) or Enterprise?'), '');
  assert.equal(sanitiseClarificationText('Neatlogs Pro plan'), '');
  assert.equal(sanitiseClarificationText('Enterprise'), '');
  assert.equal(sanitiseClarificationText('Neatlogs will page you automatically'), '');
  assert.equal(sanitiseClarificationText('Keep 90 days of traces'), '');
  assert.equal(sanitiseClarificationText('Neatlogs offers SSO. Which step should fail?'), 'Which step should fail?');
});

test('clarification choices that describe the buyer’s own workflow are not treated as product claims', () => {
  // These are the mock provider’s real choice labels; "it escalates" / "the retry fails" describe the scenario, not Neatlogs.
  for (const label of [
    'A guardrail blocks the step and it escalates',
    'The API rate-limits the call and the retry fails',
    'A credential is rejected and the agent gives up',
    'Which kind of failure should I show for your insurance claims desk?',
  ]) assert.equal(sanitiseClarificationText(label), label);
});

// -- L1-04: groundNarrative -----------------------------------------------------------------------------------------
const trace = {
  id: 'sess-t1', scenario: 'travel', label: 'Travel booking', name: 'SYNTHETIC travel request', outcome: 'escalated', outcomeKind: 'escalation', tags: ['travel'],
  input: {}, output: {},
  spans: [
    { id: 'sess-root', parentId: null, name: 'book_trip', kind: 'WORKFLOW', startMs: 0, durationMs: 3000, status: 'OK', input: {}, output: {}, error: null, detection: false },
    { id: 'sess-pay', parentId: 'sess-root', name: 'charge_card', kind: 'TOOL', startMs: 500, durationMs: 1500, status: 'ERROR', input: {}, output: {}, error: 'SYNTHETIC: gateway timeout', detection: true },
  ],
} as unknown as Trace;

test('L1-04: the exact audit probe sentences are dropped', () => {
  for (const s of [
    'The payment step retried 3 times over 2 minutes before giving up.',
    'PaymentGateway returned HTTP 503 for 4 of 5 attempts.',
    'Neatlogs would page your on-call team in PagerDuty and Slack when this happens.',
    'Neatlogs automatically fixes failing retries for you.',
    'This happened in 87 percent of runs last week.',
    'The fraud_check step failed after 1500 ms.',
    'Neatlogs Enterprise includes this detection.',
    'It cost the customer 49 dollars.',
  ]) assert.equal(groundNarrative(s, trace, null), '', s);
});

test('L1-04: further invented measures are dropped (words, hours, counts, quoted and CamelCase names)', () => {
  for (const s of [
    'It retried three times.',
    'It retried twice.',
    'The run took 2 hours.',
    'It took 4 min to finish.',
    'It failed in 87% of runs.',
    'The “Fraud Gate” step rejected the card.',
    'The StripeClient timed out.',
    'It failed with status 500.',
    'This was version 9 of the scenario.',
    'The charge failed 3 attempts in a row.',
    'Step 7 failed.',
  ]) assert.equal(groundNarrative(s, trace, null), '', s);
});

test('L1-04: grounded sentences survive (durations, percentages, status text, span names, step positions, counts)', () => {
  const ok = [
    'The charge_card step failed after 1500 ms.', // durationMs
    'It took 1.5 s to fail.', // seconds from ms
    'charge_card was 50% of the run.', // 1500 / 3000
    'The error says gateway timeout.',
    'Step 2 is where it breaks.',
    'The run has 2 steps and 1 failed.',
    'The “Travel booking” run ended as escalated.',
  ];
  for (const s of ok) assert.equal(groundNarrative(s, trace, null), s, s);
});

test('L1-04: a status code is kept only when the span error text or output carries it', () => {
  const withCode = { ...trace, spans: trace.spans.map(s => (s.id === 'sess-pay' ? { ...s, error: 'SYNTHETIC: gateway returned HTTP 503', output: { status: 503 } } : s)) } as unknown as Trace;
  assert.equal(groundNarrative('The gateway returned HTTP 503.', withCode, null), 'The gateway returned HTTP 503.');
  assert.equal(groundNarrative('The gateway returned HTTP 502.', withCode, null), '');
  assert.equal(groundNarrative('The gateway returned HTTP 503.', trace, null), '');
});

test('L1-04: version numbers and counts come from the read-back evidence', () => {
  const readback = { version: 4, traceIds: ['sess-t1'], spanIds: ['sess-root', 'sess-pay'], activeScenario: 'travel', traces: [{ id: 'sess-t1', key: 'travel', label: 'Travel booking', outcome: 'escalated', outcomeKind: 'escalation', spanCount: 2, rootDurationMs: 3000, errorSpanIds: ['sess-pay'] }] } as unknown as ReadbackEvidence;
  assert.equal(groundNarrative('This is saved as version 4.', trace, readback), 'This is saved as version 4.');
  assert.equal(groundNarrative('This is saved as version 5.', trace, readback), '');
  assert.equal(groundNarrative('The run took 3 s.', null, readback), 'The run took 3 s.');
});

test('L1-04: the safe fallback is built from the evidence and only used when model text was fully dropped', () => {
  assert.equal(safeNarrative(trace, null), 'In the saved trace, charge_card is marked ERROR.');
  assert.equal(groundNarrativeOrFallback('Neatlogs automatically fixes failing retries for you.', trace, null), 'In the saved trace, charge_card is marked ERROR.');
  assert.equal(groundNarrativeOrFallback('The charge_card step failed after 1500 ms.', trace, null), 'The charge_card step failed after 1500 ms.');
  assert.equal(groundNarrativeOrFallback(undefined, trace, null), '', 'no model text: nothing is invented');
  assert.equal(safeNarrative(null, null), '');
});

// -- L1-05: knowledge answer lead sentence --------------------------------------------------------------------------
test('L1-05: the audit probe lead sentences are dropped, using the real knowledge records', () => {
  const k = loadKnowledge();
  const cited = [k.get('official-alerts-and-slack')!, k.get('official-detections')!];
  assert.ok(cited[0] && cited[1], 'real records exist');
  for (const s of [
    'Neatlogs offers SSO and SOC 2 compliance out of the box.',
    'Neatlogs can page PagerDuty and Microsoft Teams as well.',
    'Neatlogs is available on every plan at no extra charge.',
    'Neatlogs alerts can go to PagerDuty.',
    'Neatlogs keeps your traces for 90 days.',
    'Enterprise customers get this.',
    'Neatlogs provides unlimited retention.',
    'Neatlogs includes anomaly scoring.',
    'Neatlogs stores prompts for audits.',
    'Neatlogs pages the on-call engineer.',
    'This is available to all plans.',
  ]) assert.equal(filteredLead(s, cited, 'BODY'), '', s);
});

test('L1-05: a lead made only of words from the cited records survives; one stray word drops it', () => {
  const k = loadKnowledge();
  const cited = [k.get('official-detections')!];
  const words = `${cited[0]!.title} ${cited[0]!.behaviour}`;
  const first = splitSentences(cited[0]!.behaviour)[0]!;
  assert.ok(allWordsGroundedIn(first, words));
  assert.equal(allWordsGroundedIn(`${first} Also quarterly snowflakes.`, words), false);
  assert.equal(allWordsGroundedIn('Retention lasts 90 days.', words), false);
});

test('L1-05: pricing answers stay unknown / not verified whatever the lead says', () => {
  const k = loadKnowledge();
  const cited = k.select('How much does Neatlogs cost?');
  assert.ok(cited.length > 0);
  const out = composeAnswer(cited, 'How much does Neatlogs cost?', 'Neatlogs is available on every plan at no extra charge. It costs $49/month.');
  assert.doesNotMatch(out, /every plan|no extra charge|\$|49/);
  assert.match(out, /I don’t have verified prices/);
  assert.match(out.split('\n').at(-1)!, /unknown/i);
});

test('L1-04: attempt counts are grounded only by retry/attempt-named spans', () => {
  const attempts = { ...trace, spans: [
    { id: 'a-root', parentId: null, name: 'book_trip', kind: 'WORKFLOW', startMs: 0, durationMs: 3000, status: 'OK', input: {}, output: {}, error: null, detection: false },
    { id: 'a-1', parentId: 'a-root', name: 'charge_attempt_1', kind: 'TOOL', startMs: 100, durationMs: 800, status: 'ERROR', input: {}, output: {}, error: 'SYNTHETIC: declined', detection: false },
    { id: 'a-2', parentId: 'a-root', name: 'charge_attempt_2', kind: 'TOOL', startMs: 1000, durationMs: 800, status: 'ERROR', input: {}, output: {}, error: 'SYNTHETIC: declined', detection: true },
  ] } as unknown as Trace;
  assert.equal(groundNarrative('The charge was tried 2 times.', attempts, null), 'The charge was tried 2 times.');
  assert.equal(groundNarrative('The charge was tried 3 times.', attempts, null), '');
  assert.equal(groundNarrative('The charge was tried 2 times.', trace, null), '', 'the other trace has no attempt spans');
});

test('"charge" in a payment trace is not a price, but an amount still is', () => {
  assert.equal(hasPricingClaim('The card was charged after 1500 ms.'), false);
  assert.equal(hasPricingClaim('The card was charged $5.'), true);
  assert.equal(hasPricingClaim('It was billed 20 a month.'), true);
});
