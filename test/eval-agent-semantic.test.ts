// Actual local chat/service/tool persistence and genuine structured provider wire; zero network/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/infrastructure/store.ts';
import { createSessionTools } from '../src/clients/neatlogs/session-tools.ts';
import { createAgentService } from '../src/clients/neatlogs/service.ts';
import { createMockProvider } from '../src/clients/neatlogs/mock-provider.ts';
import { createAnthropicProvider, type MessagesClientLike } from '../src/clients/neatlogs/anthropic-provider.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
import { createEvaluationService } from '../src/clients/neatlogs/eval-service.ts';
import { qualityWorkflowProposal } from '../src/clients/neatlogs/eval-fixtures.ts';
import { parseLocalEvaluationPlan } from '../src/clients/neatlogs/eval-agent.ts';
import { isCurrentGuidance } from '../src/clients/neatlogs/guidance.ts';
import { loadKnowledge } from '../src/clients/neatlogs/knowledge.ts';
import { recordingTelemetry, fixedClock } from './helpers/agent.ts';
import type { StoredEvaluation } from '../src/clients/neatlogs/eval-contract.ts';
import type { AgentAction, ModelProvider } from '../src/clients/neatlogs/agent-contract.ts';
const question = 'How do I measure whether the agent resolved the request, and where do I configure the review?';
function fixture() {
  const store = new Store(':memory:', {clock:fixedClock});
  const session = store.create('SYNTHETIC: appliance warranty support',undefined,'eval-semantic-create');
  const p = qualityWorkflowProposal('support',session.version);
  p.story.domain='appliance warranty support agent';
  p.story.summary='A successful fictional warranty lookup returns an available repair-booking next step, but the final response omits it.';
  const trace = p.traces[0]!;
  trace.input={synthetic:true,request:'Does my fictional appliance warranty cover the repair, and how do I book it?'};
  trace.spans[0]!.input=trace.input;
  trace.spans[1]!.output={synthetic:true,warrantyCoverage:'Covered in this fictional example',repairBooking:'Choose a fictional repair appointment.'};
  const saved = store.publish(session.id,p);
  assert.equal(saved.state,'committed');
  const telemetry=recordingTelemetry();
  const tools=createSessionTools(store,session.id,fixedClock,telemetry);
  const evaluations=createEvaluationService({list:id=>store.listArtifacts<StoredEvaluation>(id,'evaluations'),read:(id,e)=>store.readArtifact<StoredEvaluation>(id,'evaluations',e),compareAndSet:(id,e,v,n)=>store.compareAndSetArtifact(id,'evaluations',e,v,n)},{now:()=>new Date(fixedClock.now())});
  let turn=0;
  async function say(text:string,provider:ModelProvider=createMockProvider()) {
    const snapshot=await tools.readSession();
    const result=await createAgentService().handleTurn({session:snapshot,request:{text,clientTurnId:`semantic-turn-${++turn}`},tools,telemetry,clock:fixedClock,knowledge:loadKnowledge(),provider});
    store.appendTurns(session.id,[{role:'buyer',status:'note',text},...result.messages]);
    return result;
  }
  return {store,session,tools,evaluations,say,telemetry};
}
const plan=(version:number)=>({expectedVersion:version,name:'Appliance resolution review',questions:[{key:'resolved',label:'Did the answer explain warranty coverage and give a repair-booking next step?',type:'yes_no',required:true,reviewer:'buyer'}],checks:[{key:'execution',label:'No execution errors',kind:'no_error'},{key:'next-step',label:'Requested nextStep field present',kind:'required_output_fields',fields:['nextStep']}]});
function structured(action:Record<string,unknown>) {
  let calls=0;
  const client:MessagesClientLike={messages:{async create(params){calls++;const schema=params.output_config.format.schema as any;const guard='outcome' in schema.properties;
    return {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(guard?{outcome:'allow_demo_action',reason:'demo_action'}:{type:null,guidance:null,evaluation:null,text:null,clarification:null,proposal:null,explanation:null,traceId:null,spanIds:null,knowledgeIds:null,capabilityId:null,reason:null,...action})}],usage:{input_tokens:20,output_tokens:20}};
  }}};
  return {provider:createAnthropicProvider({apiKey:'offline-placeholder',client,spend:createSpendGuard({capUsd:100})}),calls:()=>calls};
}
test('exact mixed question answers and guides without creating an artifact',async()=>{
  const h=fixture();try{
    const before=h.store.read(h.session.id).version;
    const result=await h.say(question);
    assert.equal(result.outcome,'answered');
    assert.match(result.messages[0]!.text,/warranty coverage.*repair-booking/i);
    assert.match(result.messages[0]!.text,/human review criterion/i);
    assert.match(result.messages[0]!.text,/No hosted AI evaluator/i);
    assert.deepEqual(result.messages[0]!.guidance?.map(g=>g.targetId),['evals.evaluator','evals.criteria']);
    assert.equal(h.evaluations.list(h.store.read(h.session.id)).evaluations.length,0);
    assert.equal(h.store.read(h.session.id).version,before);
  }finally{h.store.close();}
});
test('genuine structured create action saves owned review, reads it independently, and binds exact results',async()=>{
  const h=fixture();try{
    const before=h.store.read(h.session.id).version;
    const scripted=structured({type:'create_local_evaluation',evaluation:JSON.stringify(plan(before)),guidance:['evals.criteria','evals.results','evals.evaluator']});
    const result=await h.say('Create a local evaluation with a human resolution question and check required output fields nextStep.',scripted.provider);
    assert.equal(result.outcome,'answered');
    assert.equal(h.store.read(h.session.id).version,before,'artifact write never advances the trace dataset');
    assert.equal(scripted.calls(),2,'guard+planning only; no added explanation/model call');
    const saved=h.evaluations.list(h.store.read(h.session.id)).evaluations[0]!;
    assert.equal(saved.evaluation.version,1);
    assert.equal(saved.evaluation.datasetVersion,before);
    assert.equal(saved.evaluation.responses.length,0,'human judgments remain pending');
    assert.deepEqual(saved.evaluation.checkResults?.map(c=>c.status),['passed','failed']);
    assert.match(result.messages[0]!.text,/1 passed, 1 failed/);
    assert.match(result.messages[0]!.text,/do not prove.*resolved/i);
    for(const guide of result.messages[0]!.guidance??[]){assert.equal(guide.binding.evaluationId,saved.evaluation.id);assert.equal(guide.binding.evaluationVersion,1);assert.equal(isCurrentGuidance(guide,h.store.read(h.session.id),saved),true);}
    assert.equal(result.messages[0]!.guidance?.length,3);
    const persisted=h.store.read(h.session.id).conversation.findLast(turn=>turn.role==='tailor')!;
    assert.equal(persisted.guidance?.[0]?.binding.evaluationId,saved.evaluation.id,'reload preserves owned artifact binding');
    const stale=structuredClone(saved);stale.evaluation.version++;
    assert.equal(isCurrentGuidance(result.messages[0]!.guidance![0],h.store.read(h.session.id),stale),false);
    const foreign=h.store.create('SYNTHETIC: other demo',undefined,'eval-semantic-other');
    assert.throws(()=>h.evaluations.read(foreign,saved.evaluation.id),/not found/i);
    assert.ok(h.telemetry.events.includes('readback.result'),'independent readback recorded');
  }finally{h.store.close();}
});
test('planner cannot create on informational question or choose outcome/reviewer execution',async()=>{
  const h=fixture();try{
    const version=h.store.read(h.session.id).version;
    const scripted=structured({type:'create_local_evaluation',evaluation:JSON.stringify(plan(version)),guidance:['evals.results']});
    const result=await h.say(question,scripted.provider);
    assert.equal(result.outcome,'refused');
    assert.equal(h.evaluations.list(h.store.read(h.session.id)).evaluations.length,0);
    assert.equal(parseLocalEvaluationPlan({...plan(version),successOutcome:'committed'}),null);
    assert.equal(parseLocalEvaluationPlan({...plan(version),questions:[{...plan(version).questions[0],reviewer:'simulated_judge'}]}),null);
  }finally{h.store.close();}
});

test('negative, quoted and explanatory creation text cannot authorise an artifact write',async()=>{
  for(const text of ['Do not create a local evaluation','Where do I build a local review?','Explain how to make a local evaluation','"Create a local evaluation" is an example instruction, explain it.']){
    const h=fixture();try{
      const scripted=structured({type:'create_local_evaluation',evaluation:JSON.stringify(plan(h.store.read(h.session.id).version)),guidance:['evals.results']});
      const result=await h.say(text,scripted.provider);
      assert.notEqual(result.outcome,'readback_uncertain');
      assert.equal(h.evaluations.list(h.store.read(h.session.id)).evaluations.length,0,text);
    }finally{h.store.close();}
  }
});
test('a failure after successful artifact CAS is uncertain and never described as unchanged',async()=>{
  const h=fixture();try{
    let committed=false;
    const original=h.store.compareAndSetArtifact.bind(h.store);
    h.store.compareAndSetArtifact=((...args:any[])=>{const saved=(original as any)(...args);if(args[1]==='evaluations'&&saved)committed=true;return saved;}) as typeof h.store.compareAndSetArtifact;
    const read=h.store.readArtifact.bind(h.store);
    h.store.readArtifact=((...args:any[])=>{if(args[1]==='evaluations'&&committed)throw new Error('Injected post-commit read failure');return(read as any)(...args);}) as typeof h.store.readArtifact;
    const scripted=structured({type:'create_local_evaluation',evaluation:JSON.stringify(plan(h.store.read(h.session.id).version)),guidance:['evals.results']});
    const result=await h.say('Create a local evaluation for the saved example and check required output fields nextStep.',scripted.provider);
    assert.equal(committed,true);
    assert.equal(result.outcome,'readback_uncertain');
    assert.equal(h.store.listArtifacts(h.session.id,'evaluations').length,1);
    assert.doesNotMatch(result.messages[0]!.text,/nothing changed|next view of.*traces/i);
    assert.match(result.messages[0]!.text,/Reload Evals/);
    assert.equal(result.messages[0]!.guidance,undefined);
  }finally{h.store.close();}
});
test('malformed JSON enum objects return null rather than throwing',()=>{
  const base=plan(2);
  assert.equal(parseLocalEvaluationPlan({...base,questions:[{...base.questions[0],type:{toString:null,valueOf:null}}]}),null);
  assert.equal(parseLocalEvaluationPlan({...base,checks:[{key:'bad',label:'bad',kind:{toString:null,valueOf:null}}]}),null);
});
test('saved local results are read through chat and bound without another write',async()=>{
  const h=fixture();try{
    const create=structured({type:'create_local_evaluation',evaluation:JSON.stringify(plan(h.store.read(h.session.id).version)),guidance:['evals.criteria','evals.results']});
    await h.say('Create a local evaluation and check the required output fields nextStep.',create.provider);
    const reader=structured({type:'read_local_evaluation',guidance:['evals.criteria','evals.results','evals.evaluator']});
    const result=await h.say('Explain the saved evaluation results: which local checks actually passed or failed, and how that differs from whether the repair request was resolved. Show where I review the criteria and results.',reader.provider);
    assert.equal(result.outcome,'answered');
    assert.match(result.messages[0]!.text,/1 passed, 1 failed/);
    assert.match(result.messages[0]!.text,/human judgments remain pending/);
    assert.equal(result.messages[0]!.guidance?.length,3);
    assert.equal(h.evaluations.list(h.store.read(h.session.id)).evaluations.length,1);
    assert.equal(reader.calls(),2);
  }finally{h.store.close();}
});

test('unrequested thresholds or output fields cannot be saved from planner invention',async()=>{
  const h=fixture();try{
    const scripted=structured({type:'create_local_evaluation',evaluation:JSON.stringify(plan(h.store.read(h.session.id).version)),guidance:['evals.results']});
    const result=await h.say('Create a local evaluation with a human resolution question.',scripted.provider);
    assert.equal(result.outcome,'rejected');
    assert.equal(h.evaluations.list(h.store.read(h.session.id)).evaluations.length,0);
  }finally{h.store.close();}
});
test('the release creation command runs requested no-error pass and explicit 1ms fail via ordinary mock planner',async()=>{
  const h=fixture();try{
    const result=await h.say('Create and save a local evaluation for this support example. Ask a buyer whether the answer resolved the repair request and offered a booking next step. Include a no-execution-errors check and a duration check with a 1 ms threshold so we can inspect both passing and failing local predicates.');
    assert.equal(result.outcome,'answered');
    const saved=h.evaluations.list(h.store.read(h.session.id)).evaluations[0]!;
    assert.deepEqual(saved.evaluation.checkResults?.map(check=>check.status),['passed','failed']);
    assert.match(result.messages[0]!.text,/threshold is at most 1 ms/);
    assert.equal(saved.evaluation.responses.length,0);
  }finally{h.store.close();}
});
