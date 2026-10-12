import test from 'node:test';import assert from 'node:assert/strict';
import{composeAnswer}from'../src/clients/neatlogs/answer.ts';import{loadKnowledge}from'../src/clients/neatlogs/knowledge.ts';
const k=loadKnowledge();const r=(ids:string[])=>ids.map(id=>k.get(id)!);
test('claims quality question gets a proposed criterion and separates structural checks from correctness',()=>{
 const answer=composeAnswer(r(['synthetic-evaluation-review','official-ai-evaluators']),'What would a useful quality eval ask for this claims agent, beyond checking whether a tool threw an error?','An AI judge already approved your claim.',k.version);
 assert.match(answer,/malformed information.*manual review/);assert.match(answer,/neither alone establishes/);assert.match(answer,/No hosted AI judge ran/);assert.match(answer,/Sources:/);assert.ok(answer.length<=2000);assert.doesNotMatch(answer,/already approved/);
});
test('calibration answer gives a proposed held-out disagreement procedure without claiming measured calibration',()=>{
 const answer=composeAnswer(r(['official-evaluations','official-human-review']),'How would I calibrate a human reviewer and an AI judge for that question?','The judge is calibrated and improves conversion.',k.version);
 for(const pattern of [/good, failing and ambiguous/,/have a person label/,/verified access/,/Inspect disagreements/,/held-out/,/has not been measured/])assert.match(answer,pattern);
 assert.match(answer,/Sources:/);assert.ok(answer.length<=2000);assert.doesNotMatch(answer,/is calibrated|improves conversion/);
});
test('criteria advice does not echo private buyer strings or admit unsupported provider promises',()=>{
 const answer=composeAnswer(r(['official-human-review']),'Which question should a person answer and which check can be automated here? secret-falcon','Run hosted judges for free. secret-falcon',k.version);
 assert.match(answer,/supported by the provided evidence/);assert.match(answer,/proposed structural check/);assert.doesNotMatch(answer,/secret-falcon|for free/);
 assert.match(answer,/does not run that review workflow/);assert.doesNotMatch(answer,/In the local Evals form/);
 const withoutSource=composeAnswer(r(['official-traces-and-spans']),'How would I calibrate a human reviewer and an AI judge?','The judge has run.',k.version);
 assert.doesNotMatch(withoutSource,/Suggested calibration procedure|judge has run/);
});
test('beginner and guarantee answers address the question without admitting provider promises',()=>{
 const cited=r(['official-traces-and-spans']);
 const beginner=composeAnswer(cited,'Please use simple English and explain one trace and one span with this example.','Everything is configured.',k.version);
 assert.match(beginner,/one whole run/);assert.match(beginner,/one step inside/);assert.match(beginner,/suggested example/);assert.doesNotMatch(beginner,/Everything is configured/);
 const guarantee=composeAnswer(cited,'Does that guarantee our customer answers are correct and improve conversion?','It guarantees conversion.',k.version);
 assert.match(guarantee,/does not establish/);assert.match(guarantee,/Green execution alone establishes neither/);assert.doesNotMatch(guarantee,/It guarantees conversion/);
 for(const answer of [beginner,guarantee]){assert.ok(answer.length<=2000);assert.match(answer,/Sources:/);}
 const evalGuarantee=composeAnswer(r(['official-evaluations']),'Does that guarantee our customer answers are correct and improve conversion?','It guarantees conversion.',k.version);
 assert.match(evalGuarantee,/does not establish/);
 const setup=composeAnswer(r(['official-evaluations']),'Then explain what setup would be needed and what evidence would prove it ran.','It ran successfully.',k.version);
 assert.match(setup,/actual evaluator execution record/);assert.match(setup,/has not run a hosted AI evaluator/);assert.doesNotMatch(setup,/It ran successfully/);assert.ok(setup.length<=2000);
 const checks=composeAnswer(r(['official-ai-evaluators']),'Compare an execution-success check with a required-due-date check. Is either enough to prove accuracy?','Both prove accuracy.',k.version);
 assert.match(checks,/Neither execution success nor required-field presence proves accuracy/);assert.match(checks,/compare the extracted due date/);assert.doesNotMatch(checks,/Both prove accuracy/);assert.ok(checks.length<=2000);
});
