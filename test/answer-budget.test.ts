import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswer } from '../src/clients/neatlogs/answer.ts';
import { loadKnowledge } from '../src/clients/neatlogs/knowledge.ts';

const question = 'What kind of eval I can implement in my agent and how neatlogs can help?';
test('broad evaluation answer fits the buyer reply ceiling with complete grounded sentences and sources', () => {
  const k = loadKnowledge();
  const records = ['official-traces-and-spans', 'official-ai-evaluators', 'official-human-review', 'official-evals'].map(id => k.get(id)).filter(r => r !== undefined);
  assert.ok(records.length >= 3);
  const answer = composeAnswer(records, question, 'Neatlogs guarantees perfect evaluation and runs every judge for free.', k.version);
  assert.ok(answer.length <= 2000, `${answer.length} chars`);
  assert.match(answer, /Neatlogs AI evaluators/);
  assert.match(answer, /Human reviewers/);
  assert.match(answer, /Sources:/);
  assert.match(answer, /knowledge version/);
  assert.match(answer, /Plan availability.*unknown\.$/);
  assert.doesNotMatch(answer, /guarantees perfect|for free|…/);
  for (const paragraph of answer.split('\n').filter(x => x && !/^\d+\./.test(x))) assert.match(paragraph, /[.!?]$/, paragraph);
});
test('exact buyer evaluation question keeps the most relevant cited capabilities instead of an unrelated dump', () => {
  const k = loadKnowledge();
  const records = k.select(question);
  const answer = composeAnswer(records, question, '', k.version);
  assert.ok(answer.length <= 2000);
  assert.match(answer, /Neatlogs AI evaluators/);
  assert.doesNotMatch(answer, /Experimental session replay|Versioned prompt management/);
  assert.match(answer, /Sources:.*Neatlogs AI evaluators/);
});
