import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRoutingService, RoutingError } from '../src/clients/neatlogs/routing-service.ts';
import type { RoutingRepository, StoredRoutingPreview } from '../src/clients/neatlogs/routing-contract.ts';
import type { DemoSession } from '../src/clients/neatlogs/contracts.ts';
import { fixtures } from '../src/clients/neatlogs/fixtures.ts';
import { harness } from './helpers/backend.ts';

const now=new Date('2026-10-12T12:00:00Z');
const session=(id='demo-a'): DemoSession => ({id,description:'Fictional agent',createdAt:now.toISOString(),version:1,dataset:fixtures(id),conversation:[],conversationVersion:1,conversationTruncated:false,story:null,state:'active',lastActiveAt:now.toISOString(),expiresAt:'2026-10-12T16:00:00Z',lastClientTurnId:null});
function setup() {
  const values=new Map<string,StoredRoutingPreview>();
  const repo: RoutingRepository={list:demo => [...values.entries()].filter(([k]) => k.startsWith(`${demo}/`)).map(([,v]) => structuredClone(v)),
    read:(demo,id) => structuredClone(values.get(`${demo}/${id}`) ?? null),
    compareAndSet:(demo,id,version,next) => { if (version !== null || values.has(`${demo}/${id}`)) return false; values.set(`${demo}/${id}`,structuredClone(next)); return true; }};
  const service=createRoutingService(repo,{now:()=>now}), s=session();
  const body={clientOperationId:'routing-create-01',datasetVersion:1,name:'Error triage',traceIds:s.dataset.traces.map(t=>t.id),rule:{type:'per_event'},recipient:'Engineering on-call',destination:'slack',severity:'warning',cooldownMs:30000};
  return {service,s,body,repo};
}
const error=(code:string)=>(e:unknown)=> e instanceof RoutingError && e.code===code;

test('per-event deterministic matches include errors even when a retry recovers; delivery stays simulated',()=>{
  const {service,s,body}=setup(); const saved=service.create(s,body);
  const expected=s.dataset.traces.filter(t=>t.spans.some(s=>s.status==='ERROR'));
  assert.equal(saved.preview.conditionMet,true); assert.equal(saved.preview.delivery,'simulated');
  assert.deepEqual(saved.preview.matches.map(m=>m.traceId),expected.map(t=>t.id));
  for (const match of saved.preview.matches) assert.deepEqual(match.spanIds,expected.find(t=>t.id===match.traceId)!.spans.filter(s=>s.status==='ERROR').map(s=>s.id));
  assert.ok(saved.preview.matches.every(m=>m.owner==='Engineering on-call'));
  assert.match(saved.preview.deliveryNote,/no message was sent/);
  assert.ok(!JSON.stringify(saved).includes('fingerprint'));
  assert.deepEqual(service.create(s,body),saved);
  assert.throws(()=>service.create(s,{...body,destination:'email'}),error('IDEMPOTENCY_MISMATCH'));
});

test('threshold counts failure outcomes, not any error span, and supports a non-triggered preview',()=>{
  const {service,s,body}=setup();
  s.dataset.traces[1]!.outcomeKind='failure';
  const expected=s.dataset.traces.filter(t=>t.outcomeKind==='failure');
  const passed=service.create(s,{...body,rule:{type:'threshold',failedTraceThreshold:1}}).preview;
  assert.equal(passed.observedFailedTraceCount,expected.length);
  assert.deepEqual(passed.matches.map(m=>m.traceId),expected.map(t=>t.id));
  const quiet=service.create(s,{...body,clientOperationId:'routing-threshold-02',rule:{type:'threshold',failedTraceThreshold:4}}).preview;
  assert.equal(quiet.conditionMet,false); assert.equal(quiet.delivery,'not_triggered'); assert.deepEqual(quiet.matches,[]);
});

test('snapshots are immutable, stale reads retain old evidence, and demos stay isolated',()=>{
  const {service,s,body}=setup(); const saved=service.create(s,body), other=session('demo-b');
  s.dataset.traces[0]!.spans[0]!.status='ERROR'; s.version=2;
  saved.preview.traceSnapshot[0]!.output={tampered:true};
  const read=service.read(s,saved.preview.id); assert.equal(read.stale,true);
  assert.notDeepEqual(read.preview.traceSnapshot[0]!.output,{tampered:true});
  assert.equal(service.list(other).previews.length,0);
  assert.throws(()=>service.read(other,saved.preview.id),error('ROUTING_NOT_FOUND'));
  assert.throws(()=>service.create(other,body),error('TRACE_NOT_FOUND'));
  assert.throws(()=>service.create(s,{...body,clientOperationId:'stale-routing-02'}),error('DATASET_CONFLICT'));
  assert.equal(service.create(s,body).stale,true,'accepted retry survives dataset changes');
  s.state='ended'; assert.throws(()=>service.list(s),error('SESSION_EXPIRED'));
  other.expiresAt=now.toISOString(); assert.throws(()=>service.list(other),error('SESSION_EXPIRED'));
});

test('bounded validation rejects real addresses, connections, executable rules and forged delivery',()=>{
  const {service,s,body}=setup();
  for (const patch of [{recipient:'alice@example.com'},{destination:'https://hook.invalid'}, {cooldownMs:-1},{cooldownMs:600001},{cooldownMs:1.5},
    {rule:{type:'threshold',failedTraceThreshold:0}},{rule:{type:'threshold',failedTraceThreshold:5}},{rule:{type:'per_event',expression:'eval()'}},
    {rule:{type:'per_event',failedTraceThreshold:1}},{delivery:'sent'},{traceIds:[]},{traceIds:[body.traceIds[0],body.traceIds[0]]}, {datasetVersion:0},{severity:'info'}]) {
    assert.throws(()=>service.create(s,{...body,...patch}),error('ROUTING_INVALID'));
  }
  assert.equal(service.list(s).previews.length,0);
});

test('preview cap and CAS conflict are enforced without overwriting evidence',()=>{
  const {service,s,body,repo}=setup();
  repo.compareAndSet=()=>false;
  assert.throws(()=>service.create(s,body),error('ROUTING_CONFLICT'));
  const fresh=setup();
  for(let i=0;i<8;i++) fresh.service.create(fresh.s,{...fresh.body,clientOperationId:`routing-preview-${i}`});
  assert.throws(()=>fresh.service.create(fresh.s,{...fresh.body,clientOperationId:'routing-preview-9'}),error('ROUTING_LIMIT'));
});

test('HTTP routing persists through restart, authenticates session ownership, and makes no model call',async()=>{
  const h=await harness();
  try {
    const owner=await h.call('/api/browser-session/demos','POST',{description:'Fictional document extraction agent',scenario:'exhausted'});
    const s=h.store.read(owner.data.id), path=`/api/sessions/${s.id}/routing`;
    const body={clientOperationId:randomUUID(),datasetVersion:s.version,name:'Failure triage',traceIds:s.dataset.traces.map(t=>t.id),rule:{type:'per_event'},recipient:'Quality reviewer',destination:'in_app',severity:'critical',cooldownMs:0};
    const saved=await h.call(path,'POST',body,owner.cookie); assert.equal(saved.status,201);
    assert.equal(saved.data.preview.delivery,'simulated');
    await h.restart();
    assert.deepEqual((await h.call(`${path}/${saved.data.preview.id}`,'GET',undefined,owner.cookie)).data,saved.data);
    assert.deepEqual((await h.call(path,'GET',undefined,owner.cookie)).data.previews,[saved.data]);
    const stranger=await h.call('/api/browser-session/demos','POST',{description:'Other buyer'});
    assert.equal((await h.call(path,'GET',undefined,stranger.cookie)).status,404);
    const sibling=await h.call('/api/browser-session/demos','POST',{description:'Another owned demo'},owner.cookie);
    assert.equal((await h.call(`/api/sessions/${sibling.data.id}/routing/${saved.data.preview.id}`,'GET',undefined,owner.cookie)).status,404);
    assert.equal((await h.call(path,'POST',{...body,clientOperationId:randomUUID()},owner.cookie,{origin:'https://foreign.invalid'})).status,403);
    assert.equal((await h.call(path,'POST',{...body,clientOperationId:randomUUID(),recipient:'real@example.com'},owner.cookie)).status,400);
    assert.equal((await h.call(`${path}/${saved.data.preview.id}`,'POST',body,owner.cookie)).status,405);
    assert.equal(h.agent.calls,0);
  } finally {await h.close();}
});
