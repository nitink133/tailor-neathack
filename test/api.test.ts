import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Store } from '../src/store.ts';
import { appServer } from '../src/server.ts';

test('HTTP contract: coherent fixtures, transactional CAS, capability isolation, restart and malformed requests',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tailor-api-'));const path=join(dir,'sessions.sqlite');
  let store=new Store(path);let server=appServer(store,'local-test-key');
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  let port=(server.address() as {port:number}).port;
  const call=async(path:string,method='GET',data?:unknown,cookie='',operation=randomUUID(),dev='local-test-key')=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{cookie,'content-type':'application/json','idempotency-key':operation,'x-tailor-dev-key':dev},body:data!==undefined?JSON.stringify(data):undefined});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0] ?? cookie};
  };
  try {
    const op=randomUUID();const payload={description:'Fictional order support project A',scenario:'recovered'};
    const a=await call('/api/sessions','POST',payload,'',op);const repeat=await call('/api/sessions','POST',payload,'',op);
    assert.equal(a.status,201);assert.equal(repeat.data.id,a.data.id);assert.equal(repeat.cookie,a.cookie);
    const b=await call('/api/sessions','POST',{description:'Fictional B',scenario:'exhausted'});
    const id=a.data.id;const dataset=a.data.dataset;
    assert.equal(dataset.traces.length,2);
    for(const t of dataset.traces){
      assert.equal(t.sessionId,id);assert.equal(t.status,'Ready');
      const root=t.spans.find((s:any)=>s.parentId===null);assert(root);
      for(const span of t.spans){assert(span.startMs>=0);assert(span.startMs+span.durationMs<=root.durationMs);if(span.parentId)assert(t.spans.some((x:any)=>x.id===span.parentId));assert.equal(span.status==='ERROR',span.error!==null);}
      assert.equal(t.spans.filter((s:any)=>s.status==='ERROR').length,t.scenario==='recovered'?1:2);
      const detail=await call(`/api/sessions/${id}/traces/${t.id}`,'GET',undefined,a.cookie);assert.deepEqual(detail.data.trace,t);
      const span=await call(`/api/sessions/${id}/traces/${t.id}/spans/${root.id}`,'GET',undefined,a.cookie);assert.deepEqual(span.data.span,root);
      assert.deepEqual(root.output,t.output);
      if(t.scenario==='recovered'){assert.equal(t.output.orderId,'SYN-ORDER-103');assert.equal(t.output.status,'shipped');}
      else {assert.equal(t.output.ticketSent,false);assert.equal(t.output.totalCents,undefined);}
    }
    for(const [query,count] of [['',2],['?scenario=recovered',1],['?detection=yes',1],['?q=zz-no-match',0],['?minMs=45',1],['?tag=synthetic',2]]) {
      const r=await call(`/api/sessions/${id}/traces${query}`,'GET',undefined,a.cookie);assert.equal(r.data.filtered,count);assert.equal(r.data.total,2);assert.equal(r.data.traces.length,count);
    }
    assert.equal((await call(`/api/sessions/${id}`,'GET',undefined,b.cookie)).status,404);
    assert.equal((await call(`/api/sessions/${id}/traces/${dataset.traces[0].id}`,'GET',undefined,b.cookie)).status,404);
    const proposalPath=`/api/dev/sessions/${id}/proposal`;
    const bad=structuredClone(dataset);bad.traces[0].spans[1].parentId='other-session';
    assert.equal((await call(proposalPath,'POST',{expectedVersion:1,dataset:bad},a.cookie)).status,422);
    assert.deepEqual((await call(`/api/sessions/${id}`,'GET',undefined,a.cookie)).data,a.data);
    const good=structuredClone(dataset);good.activeScenario='exhausted';
    assert.equal((await call(proposalPath,'POST',{expectedVersion:1,dataset:good},b.cookie)).status,404);
    assert.equal((await call(proposalPath,'POST',{expectedVersion:1,dataset:good},a.cookie,randomUUID(),'')).status,403);
    const concurrent=await Promise.all([call(proposalPath,'POST',{expectedVersion:1,dataset:good},a.cookie),call(proposalPath,'POST',{expectedVersion:1,dataset:good},a.cookie)]);
    assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);
    const accepted=await call(`/api/sessions/${id}`,'GET',undefined,a.cookie);assert.equal(accepted.data.version,2);assert.deepEqual(accepted.data.dataset,good);
    assert.equal((await call(`/api/sessions/${id}/traces?unknown=1`,'GET',undefined,a.cookie)).status,400);
    assert.equal((await call(`/api/sessions/${id}/traces?minMs=abc`,'GET',undefined,a.cookie)).status,400);
    assert.equal((await call(`/api/sessions/${id}/traces/unknown`,'GET',undefined,a.cookie)).status,404);
    assert.equal((await call(`/api/sessions/${id}`,'DELETE',undefined,a.cookie)).status,405);
    const malformed=await fetch(`http://127.0.0.1:${port}${proposalPath}`,{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json','x-tailor-dev-key':'local-test-key'},body:'{"expectedVersion":2,'});assert.equal(malformed.status,400);
    await new Promise<void>(resolve=>{const req=httpRequest({hostname:'127.0.0.1',port,path:proposalPath,method:'POST',headers:{cookie:a.cookie,'content-type':'application/json','x-tailor-dev-key':'local-test-key','content-length':1000}});req.on('error',()=>resolve());req.write('{"expectedVersion":2,');setTimeout(()=>req.destroy(),15);});
    assert.deepEqual((await call(`/api/sessions/${id}`,'GET',undefined,a.cookie)).data,accepted.data);
    const csrf=await fetch(`http://127.0.0.1:${port}/api/sessions`,{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(csrf.status,403);
    await new Promise<void>(r=>server.close(()=>r()));store.close();store=new Store(path);server=appServer(store,'local-test-key');await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address() as {port:number}).port;
    assert.deepEqual((await call(`/api/sessions/${id}`,'GET',undefined,a.cookie)).data,accepted.data);
    assert.equal((await call('/api/dev/sessions')).data.length,2);
  } finally {await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
