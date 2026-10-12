import assert from 'node:assert/strict';
import test from 'node:test';
import type { DemoSession, Trace } from '../src/clients/neatlogs/contracts.ts';
import type { EvaluationCheck, EvaluationRepository, StoredEvaluation } from '../src/clients/neatlogs/eval-contract.ts';
import { executeChecks } from '../src/clients/neatlogs/eval-fixtures.ts';
import { createEvaluationService, EvaluationError } from '../src/clients/neatlogs/eval-service.ts';
import { fixtures } from '../src/clients/neatlogs/fixtures.ts';

const checks: EvaluationCheck[] = [
  {key:'execution',label:'No execution errors',kind:'no_error'},
  {key:'latency',label:'Elapsed time within threshold',kind:'latency',maxDurationMs:100},
  {key:'fields',label:'Required output fields',kind:'required_output_fields',fields:['answer','resolved']},
];
function trace(): Trace {
  const t = structuredClone(fixtures('demo-a').traces[0]!);
  t.output = {answer:'A fictional answer',resolved:false};
  t.spans = [{id:'root',parentId:null,name:'workflow',kind:'WORKFLOW',startMs:0,durationMs:100,status:'OK',input:null,output:t.output,error:null,detection:false},
    {id:'child',parentId:'root',name:'retrieve',kind:'RETRIEVAL',startMs:10,durationMs:80,status:'OK',input:null,output:null,error:null,detection:false}];
  return t;
}
function setup() {
  const now = new Date('2026-10-12T12:00:00Z');
  const s: DemoSession = {id:'demo-a',description:'fictional agent',createdAt:now.toISOString(),version:1,dataset:{activeScenario:'quality',traces:[trace()]},
    conversation:[],conversationVersion:1,conversationTruncated:false,story:null,state:'active',lastActiveAt:now.toISOString(),expiresAt:'2026-10-12T16:00:00Z',lastClientTurnId:null};
  const rows = new Map<string,StoredEvaluation>();
  const repo: EvaluationRepository = {
    list(demo) {return [...rows.entries()].filter(([k])=>k.startsWith(`${demo}/`)).map(([,v])=>structuredClone(v));},
    read(demo,id) {const v=rows.get(`${demo}/${id}`);return v ? structuredClone(v) : null;},
    compareAndSet(demo,id,version,next) {const k=`${demo}/${id}`,old=rows.get(k);if (version===null ? !!old : old?.evaluation.version!==version) return false;rows.set(k,structuredClone(next));return true;},
  };
  const service=createEvaluationService(repo,{now:()=>now});
  const body={clientOperationId:'check-create-0001',datasetVersion:1,name:'SYNTHETIC bounded checks',traceIds:[s.dataset.traces[0]!.id],checks};
  return {s,service,body};
}
test('executes real fixed predicates with exact observations, preserving false and zero output values',()=>{
  const results=executeChecks([trace()],checks);
  assert.deepEqual(results.map(r=>r.passed),[true,true,true]);
  assert.equal(results[1]!.observed.elapsedMs,100); // overlapping spans are not summed
  assert.deepEqual(results[0]!.observed.errorSpanIds,[]);
  assert.deepEqual(results[2]!.observed.missingFields,[]);
  assert.ok(results.every(r=>r.source==='deterministic_check' && r.provenance==='local_trace_snapshot'));
  const t=trace();t.output={answer:0,resolved:false};
  assert.equal(executeChecks([t],checks)[2]!.passed,true);
});
test('checks fail on execution errors, elapsed thresholds and missing/null/empty fields',()=>{
  const t=trace();t.spans[1]!.status='ERROR';t.spans[1]!.error='fictional error';t.spans[1]!.durationMs=101;
  t.output={answer:'',resolved:null};
  const result=executeChecks([t],checks);
  assert.deepEqual(result.map(r=>r.status),['failed','failed','failed']);
  assert.deepEqual(result[0]!.observed.errorSpanIds,['child']);
  assert.equal(result[1]!.observed.elapsedMs,111);
  assert.deepEqual(result[2]!.observed.missingFields,['answer','resolved']);
  t.spans[1]!.status='OK';assert.equal(executeChecks([t],checks)[0]!.passed,false);
});
test('missing spans and invalid timing are unavailable rather than a fabricated pass',()=>{
  const t=trace();t.spans=[];
  assert.deepEqual(executeChecks([t],checks).slice(0,2).map(r=>r.passed),[null,null]);
  t.spans=trace().spans;t.spans[0]!.durationMs=NaN;
  assert.equal(executeChecks([t],checks)[1]!.status,'unavailable');
});
test('saved results are independent of judge illustrations, survive readback and immutable snapshot changes',()=>{
  const {s,service,body}=setup();const saved=service.create(s,body);
  assert.equal(saved.evaluation.responses[0]!.source,'simulated_judge');
  assert.equal(saved.evaluation.checkResults!.length,3);
  assert.deepEqual(service.create(s,body),saved);
  s.dataset.traces[0]!.spans[0]!.durationMs=999;
  saved.evaluation.checkResults![1]!.observed.elapsedMs=999;
  assert.equal(service.read(s,saved.evaluation.id).evaluation.checkResults![1]!.observed.elapsedMs,100);
  s.version=2;
  assert.equal(service.read(s,saved.evaluation.id).stale,true);
  assert.equal(service.read(s,saved.evaluation.id).evaluation.checkResults![1]!.observed.elapsedMs,100);
});
test('fixed check validation rejects executable/forged/session fields and unbounded inputs',()=>{
  const {s,service,body}=setup();
  const invalidChecks: unknown[]=[[],null,[{...checks[0],code:'return true'}],[{...checks[0],sessionId:'foreign'}],
    [{key:'x',label:'x',kind:'javascript'}],[{...checks[1],maxDurationMs:Infinity}],[{...checks[1],maxDurationMs:0}],
    [{...checks[1],maxDurationMs:600001}],[{...checks[2],fields:['answer.nested']}],[{...checks[2],fields:['constructor']}],
    [{...checks[2],fields:['answer','answer']}],[{...checks[2],fields:[]}],[checks[0],checks[0]],
    Array.from({length:9},(_,i)=>({...checks[0],key:`check-${i}`})),
  ];
  for (const candidate of invalidChecks) assert.throws(()=>service.create(s,{...body,checks:candidate}),e=>e instanceof EvaluationError && e.code==='EVALUATION_INVALID');
  assert.equal(service.list(s).evaluations.length,0);
});
test('checks use authorized trace IDs and cannot be forged through review',()=>{
  const {s,service,body}=setup();const saved=service.create(s,body);
  assert.throws(()=>service.create(s,{...body,clientOperationId:'foreign-check-001',traceIds:['foreign']}),e=>e instanceof EvaluationError && e.code==='TRACE_NOT_FOUND');
  assert.throws(()=>service.review(s,saved.evaluation.id,{clientOperationId:'forge-review-001',datasetVersion:1,expectedVersion:1,responses:[],checkResults:[{passed:true}]}),e=>e instanceof EvaluationError && e.code==='EVALUATION_INVALID');
  const other={...s,id:'demo-other'};assert.equal(service.list(other).evaluations.length,0);
  assert.throws(()=>service.read(other,saved.evaluation.id),e=>e instanceof EvaluationError && e.code==='EVALUATION_NOT_FOUND');
});
