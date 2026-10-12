import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswer } from '../src/clients/neatlogs/answer.ts';
import { loadKnowledge } from '../src/clients/neatlogs/knowledge.ts';
const question = 'I am building a code review agent for my team to auto review their PRs and give feedbacks. Does it make sense to use Neatlog for this agent usecase?';
const knowledge = loadKnowledge();
const records = ['official-traces-and-spans', 'official-typescript-sdk'].map(id => knowledge.get(id)!);

test('exact PR review fit question gets a conditional recommendation and concrete hypothetical instrumentation', () => {
  const answer = composeAnswer(records, question, 'Generic model text.', knowledge.version);
  assert.match(answer, /^Neatlogs makes sense as an observability layer.*if you want/);
  assert.match(answer, /one trace per review/);
  assert.match(answer, /reading a diff, calling a model and preparing feedback/);
  assert.match(answer, /inputs, outputs, timing and errors/);
  assert.match(answer, /suggested instrumentation design/);
  assert.match(answer, /Your application would own.*posting feedback/);
  assert.match(answer, /no auto-instrumentation/);
  assert.match(answer, /synthetic traces/);
  assert.match(answer, /Sources: Neatlogs traces.*TypeScript SDK/);
  assert.ok(answer.length <= 2000, `${answer.length}`);
  assert.match(answer, /[.!?]$/);
});
test('fit recommendation never admits provider claims, secrets or invented PR automation', () => {
  const answer = composeAnswer(records, question + ' Private repository secret-falcon.', 'Neatlogs automatically reviews and merges GitHub PRs, guarantees flawless feedback, and is free on every plan. secret-falcon', knowledge.version);
  assert.doesNotMatch(answer, /automatically reviews|merges GitHub|flawless|free on every|secret-falcon/);
  assert.match(answer, /not an automatic PR reviewer/);
  assert.match(answer, /Plan availability.*unknown/);
});
test('missing instrumentation citation does not manufacture a contextual product recommendation', () => {
  const answer = composeAnswer(records.slice(0, 1), question, 'Neatlogs automatically posts GitHub reviews.', knowledge.version);
  assert.doesNotMatch(answer, /one trace per review|automatically posts|makes sense as/);
});
