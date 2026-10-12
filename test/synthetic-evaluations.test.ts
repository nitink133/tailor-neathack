import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvaluationService, EvaluationError } from '../src/clients/neatlogs/eval-service.ts';
import type { EvaluationRepository, StoredEvaluation } from '../src/clients/neatlogs/eval-contract.ts';
import { qualityWorkflowProposal } from '../src/clients/neatlogs/eval-fixtures.ts';
import { fixtures } from '../src/clients/neatlogs/fixtures.ts';
import type { DemoSession } from '../src/clients/neatlogs/contracts.ts';
import { validateProposal } from '../src/clients/neatlogs/validator.ts';

const now = new Date('2026-10-12T12:00:00Z');
function session(id='demo-a'): DemoSession {
  return { id,description:'fictional demo',createdAt:now.toISOString(),version:1,dataset:fixtures(id),conversation:[],conversationVersion:1,
    conversationTruncated:false,story:null,state:'active',lastActiveAt:now.toISOString(),expiresAt:'2026-10-12T16:00:00Z',lastClientTurnId:null };
}
function setup() {
  const values = new Map<string,StoredEvaluation>();
  const key = (demo:string,id:string) => `${demo}/${id}`;
  const repo: EvaluationRepository = {
    list(demo) { return [...values.entries()].filter(([k]) => k.startsWith(`${demo}/`)).map(([,v]) => structuredClone(v)); },
    read(demo,id) { const v=values.get(key(demo,id)); return v ? structuredClone(v) : null; },
    compareAndSet(demo,id,version,next) {
      const old = values.get(key(demo,id));
      if ((version === null && old) || (version !== null && (!old || old.evaluation.version !== version))) return false;
      values.set(key(demo,id),structuredClone(next)); return true;
    },
  };
  const service=createEvaluationService(repo,{now:()=>now});
  const s=session();
  const body={clientOperationId:'create-eval-0001',datasetVersion:1,name:'SYNTHETIC quality review',traceIds:s.dataset.traces.map(t=>t.id)};
  return {service,s,body,repo};
}
const error = (code:string) => (e:unknown) => e instanceof EvaluationError && e.code===code;

test('mixed form keeps simulated provenance, null unscored values and independent immutable snapshot', () => {
  const {service,s,body}=setup();
  const result=service.create(s,body);
  assert.equal(result.evaluation.mode,'synthetic');
  assert.equal(result.evaluation.state,'pending');
  assert.deepEqual(result.evaluation.responses.map(r=>r.source),['simulated_judge','simulated_judge']);
  assert.equal(result.evaluation.aggregates[0]!.value,0.5);
  assert.equal(result.evaluation.aggregates[1]!.value,null);
  assert.equal(result.evaluation.aggregates[1]!.answeredCount,0);
  for (const r of result.evaluation.responses) assert.ok(r.evidenceSpanIds.every(id=>result.evaluation.traceSnapshot.find(t=>t.id===r.traceId)!.spans.some(s=>s.id===id)));
  s.dataset.traces[0]!.output={changed:true};
  result.evaluation.traceSnapshot[0]!.output={tampered:true};
  assert.notDeepEqual(service.read(s,result.evaluation.id).evaluation.traceSnapshot[0]!.output,{changed:true});
  assert.notDeepEqual(service.read(s,result.evaluation.id).evaluation.traceSnapshot[0]!.output,{tampered:true});
  assert.ok(!JSON.stringify(result).includes('fingerprint'));
});

test('buyer scores derive aggregates and replay does not increment version or duplicate responses', () => {
  const {service,s,body}=setup(); const e=service.create(s,body).evaluation;
  const review={clientOperationId:'review-eval-0001',datasetVersion:1,expectedVersion:1,responses:e.traceIds.map((traceId,i)=>({traceId,questionKey:'quality',value:i?3:5}))};
  const saved=service.review(s,e.id,review);
  assert.equal(saved.evaluation.version,2); assert.equal(saved.evaluation.state,'completed');
  assert.deepEqual(saved.evaluation.aggregates[1],{questionKey:'quality',answeredCount:2,totalCount:2,value:4,source:'buyer'});
  assert.equal(saved.evaluation.responses.filter(r=>r.source==='buyer').length,2);
  assert.deepEqual(service.review(s,e.id,review),saved);
  assert.throws(()=>service.review(s,e.id,{...review,responses:[{traceId:e.traceIds[0],questionKey:'quality',value:2}]}),error('IDEMPOTENCY_MISMATCH'));
});

test('create replay is stable, operation mismatch is rejected, partial reviews remain pending', () => {
  const {service,s,body}=setup(); const saved=service.create(s,body);
  assert.deepEqual(service.create(s,{name:body.name,traceIds:body.traceIds,datasetVersion:body.datasetVersion,clientOperationId:body.clientOperationId}),saved);
  assert.throws(()=>service.create(s,{...body,name:'changed'}),error('IDEMPOTENCY_MISMATCH'));
  const partial=service.review(s,saved.evaluation.id,{clientOperationId:'partial-review-0001',datasetVersion:1,expectedVersion:1,responses:[{traceId:body.traceIds[0],questionKey:'quality',value:4}]});
  assert.equal(partial.evaluation.state,'pending');
  assert.equal(partial.evaluation.aggregates[1]!.answeredCount,1);
});

test('dataset changes mark snapshots stale and block new reviews without losing prior evidence', () => {
  const {service,s,body}=setup(); const e=service.create(s,body).evaluation;
  s.version=2; s.dataset=fixtures(s.id,'exhausted');
  assert.equal(service.read(s,e.id).stale,true);
  assert.equal(service.list(s).evaluations[0]!.evaluation.datasetVersion,1);
  assert.throws(()=>service.review(s,e.id,{clientOperationId:'review-stale-001',datasetVersion:2,expectedVersion:1,responses:[{traceId:e.traceIds[0],questionKey:'quality',value:4}]}),error('STALE_EVALUATION'));
  assert.throws(()=>service.create(s,{...body,clientOperationId:'create-new-0002'}),error('DATASET_CONFLICT'));
});

test('cross-demo traces and eval IDs are isolated; ended and expired demos reject access', () => {
  const {service,s,body}=setup(); const e=service.create(s,body).evaluation; const other=session('demo-b');
  assert.equal(service.list(other).evaluations.length,0);
  assert.throws(()=>service.read(other,e.id),error('EVALUATION_NOT_FOUND'));
  assert.throws(()=>service.create(other,{...body,clientOperationId:'foreign-trace-01'}),error('TRACE_NOT_FOUND'));
  s.state='ended'; assert.throws(()=>service.read(s,e.id),error('SESSION_EXPIRED'));
  other.expiresAt=now.toISOString(); assert.throws(()=>service.list(other),error('SESSION_EXPIRED'));
});

test('question/answer validation rejects forged source, foreign references and invalid score types', () => {
  const {service,s,body}=setup(); const e=service.create(s,body).evaluation;
  const request={clientOperationId:'invalid-review-01',datasetVersion:1,expectedVersion:1,responses:[{traceId:e.traceIds[0],questionKey:'quality',value:4}]};
  for (const responses of [
    [{...request.responses[0],value:99}], [{...request.responses[0],value:'5'}], [{...request.responses[0],traceId:'foreign'}],
    [{...request.responses[0],source:'simulated_judge'}], [{...request.responses[0],questionKey:'resolved',value:true}],
    [...request.responses,...request.responses],
  ]) assert.throws(()=>service.review(s,e.id,{...request,responses}),error('EVALUATION_INVALID'));
  assert.equal(service.read(s,e.id).evaluation.version,1);
  for (const questions of [[],[{key:'x',label:'x',type:'rating',required:true,reviewer:'buyer',min:5,max:1}],
    [{key:'x',label:'x',type:'choice',required:true,reviewer:'buyer',options:['same','same']}],
    [{key:'x',label:'x',type:'text',required:true,reviewer:'real_ai'}],
  ]) assert.throws(()=>service.create(s,{...body,clientOperationId:'invalid-create-01',questions}),error('EVALUATION_INVALID'));
});

test('supported text/choice/yes-no/rating forms are validated, text aggregates stay null', () => {
  const {service,s,body}=setup(); const questions=[
    {key:'decision',label:'Decision',type:'choice',options:['useful','unclear'],required:true,reviewer:'buyer'},
    {key:'notes',label:'Notes',type:'text',required:false,reviewer:'buyer'},
    {key:'safe',label:'Safe',type:'yes_no',required:true,reviewer:'buyer'},
  ];
  const e=service.create(s,{...body,questions,traceIds:[body.traceIds[0]]}).evaluation;
  const saved=service.review(s,e.id,{clientOperationId:'valid-review-0001',datasetVersion:1,expectedVersion:1,responses:[
    {traceId:e.traceIds[0],questionKey:'decision',value:'unclear'}, {traceId:e.traceIds[0],questionKey:'notes',value:'The answer does not resolve the question.'},
    {traceId:e.traceIds[0],questionKey:'safe',value:false},
  ]});
  assert.equal(saved.evaluation.state,'completed'); assert.equal(saved.evaluation.aggregates[0]!.value,null); assert.equal(saved.evaluation.aggregates[1]!.value,null); assert.equal(saved.evaluation.aggregates[2]!.value,0);
});

test('CAS conflicts do not overwrite concurrent review and stale expectedVersion rejects', () => {
  const {service,s,body,repo}=setup(); const e=service.create(s,body).evaluation;
  const review={clientOperationId:'concurrent-review-01',datasetVersion:1,expectedVersion:1,responses:[{traceId:e.traceIds[0],questionKey:'quality',value:4}]};
  repo.compareAndSet=()=>false;
  assert.throws(()=>service.review(s,e.id,review),error('EVALUATION_CONFLICT'));
  assert.equal(service.read(s,e.id).evaluation.version,1);
  assert.throws(()=>service.review(s,e.id,{...review,expectedVersion:2}),error('EVALUATION_CONFLICT'));
});

test('varied quality scenarios contain substantive flaws while all execution spans remain OK', () => {
  for (const workflow of ['retrieval','extraction','support'] as const) {
    const proposal=qualityWorkflowProposal(workflow,1);
    const verdict=validateProposal('demo-a',fixtures('demo-a'),proposal,{now:()=>now.getTime()});
    assert.equal(verdict.ok,true,JSON.stringify(verdict));
    assert.equal(proposal.traces[0]!.outcomeKind,'degraded');
    assert.ok(proposal.traces[0]!.spans.every(s=>s.status==='OK'));
    assert.notDeepEqual(proposal.traces[0]!.spans[1]!.output,proposal.traces[0]!.output);
    assert.ok(!JSON.stringify(proposal).includes('booking'));
  }
});
