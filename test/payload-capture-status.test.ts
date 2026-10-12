import{randomUUID}from'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';
import{Store}from'../src/infrastructure/store.ts';import{appServer}from'../src/infrastructure/server.ts';
import{createTelemetry,type Telemetry}from'../src/infrastructure/telemetry.ts';import{stubAgent,stubProvider,stubKnowledge}from'./helpers/backend.ts';
test('capture policy is session-scoped, authenticated and fails closed without hosted export',async()=>{
 const store=new Store(':memory:');const local=await createTelemetry({mode:'captured',secret:'fake-status-secret'});let hostedPayloads=true;const approved=new Set<string>();
 // Injected status seam, no network exporter or hosted ingestion.
 const telemetry:Telemetry={...local,mode:'neatlogs',diagnostics:()=>({...local.diagnostics(),syntheticPayloads:hostedPayloads})};
 const server=appServer(store,{devKey:'fake-local-status-key',agent:stubAgent(),provider:stubProvider,knowledge:stubKnowledge,telemetry,syntheticFixture:id=>approved.has(id)});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address()as any).port;
 async function call(path:string,cookie='',body?:unknown){const r=await fetch('http://127.0.0.1:'+port+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-tailor-dev-key':'fake-local-status-key','idempotency-key':randomUUID(),cookie},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]??cookie};}
 try{
  const a=await call('/api/sessions','',{description:'SYNTHETIC allowed fixture'});const b=await call('/api/sessions','',{description:'SYNTHETIC unapproved fixture'});
  assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(a.body.payloadCapture.enabled,false);assert.equal(a.body.payloadCapture.reason,'session_not_approved');
  approved.add(a.body.id);
  const enabled=await call('/api/sessions/'+a.body.id,a.cookie);assert.deepEqual(enabled.body.payloadCapture,{enabled:true,reason:'approved_synthetic_session',maxTextChars:2000});
  const other=await call('/api/sessions/'+b.body.id,b.cookie);assert.equal(other.body.payloadCapture.enabled,false);
  assert.equal((await call('/api/sessions/'+a.body.id,b.cookie)).status,404);
  hostedPayloads=false;const disabled=await call('/api/sessions/'+a.body.id,a.cookie);assert.equal(disabled.body.payloadCapture.enabled,false);assert.equal(disabled.body.payloadCapture.reason,'hosted_export_disabled');
 }finally{await new Promise<void>(r=>server.close(()=>r()));await local.shutdown();store.close();}
});
