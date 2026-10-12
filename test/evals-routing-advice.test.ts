import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers/agent.ts';
import { loadKnowledge } from '../src/clients/neatlogs/knowledge.ts';

test('eval advice stays grounded across buyer industries and offers the saved review page', async () => {
  for(const buyer of ['insurance claims agent','warehouse reconciliation agent','coding assistant']) {
    const h=harness({knowledge:loadKnowledge()});
    await h.say(`Show my ${buyer} with a tool error and no retries`);
    h.tools.calls.length=0;
    const r=await h.say(`How do Neatlogs evals fit my ${buyer}, and how do I know the evals work?`);
    assert.equal(r.outcome,'answered');
    const m=r.messages.find(m=>m.role==='tailor')!;
    assert.match(m.text,/eval|review/i);
    assert.match(m.text,/Sources:/);
    assert.doesNotMatch(m.text,/evaluation completed|perfect quality|AI evaluator ran/i);
    assert.ok(m.guidance?.some(g=>g.targetId==='evals.overview'));
    assert.equal(h.tools.calls.filter(c=>c.name==='publishScenario').length,0);
  }
});
test('update me asks the product-specific distinction and sends nothing',async()=>{
  const h=harness({knowledge:loadKnowledge()});const r=await h.say('Update me when there is an issue');
  assert.equal(r.outcome,'clarification');assert.match(r.clarification!.question,/alert rule.*personal.*evaluation/i);
  assert.equal(r.clarification!.choices.length,3);assert.equal(h.tools.calls.length,0);
});
test('routing preview points to local alerts while real connections and hosted judges stay unsupported',async()=>{
  const h=harness({knowledge:loadKnowledge()});
  await h.say('Show my documentation agent with a tool error and no retries');
  const r=await h.say('Preview alert routing to the right people');assert.equal(r.outcome,'answered');
  assert.ok(r.messages.find(m=>m.role==='tailor')?.guidance?.some(g=>g.targetId==='alerts.overview'));
  for(const q of ['Set up Slack alerts for this project.','Can you run a hosted AI evaluation of this production trace here?']) {
    const rejected=await h.say(q);assert.equal(rejected.outcome,'unsupported');
  }
});
