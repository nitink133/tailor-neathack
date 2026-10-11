import { randomUUID } from 'node:crypto';
import type { DemoSession } from '../src/contracts.ts';

const origin = process.env.TAILOR_URL ?? 'http://127.0.0.1:4321';
const key = process.env.TAILOR_DEV_KEY;
const action = process.argv[2] ?? 'validate';
async function call(path:string,method='GET',data?:unknown,cookie='') {
  const res = await fetch(origin+path,{method,headers:{'content-type':'application/json', 'x-tailor-dev-key':key ?? '',cookie,'idempotency-key':randomUUID()},body:data ? JSON.stringify(data) : undefined});
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0] ?? cookie};
}
if (!key) throw new Error('Set TAILOR_DEV_KEY to the same local developer key used by the server. It is never printed.');
if(action==='inspect') {
  const result=await call('/api/dev/sessions');if(result.status!==200)throw new Error(result.data.error?.message);
  console.log(JSON.stringify(result.data,null,2));
} else if(action==='validate') {
  const a=await call('/api/sessions','POST',{description:'Fictional validation shop A',scenario:'recovered'});
  const b=await call('/api/sessions','POST',{description:'Fictional validation shop B',scenario:'exhausted'});
  if(a.status!==201||b.status!==201)throw new Error('Session creation failed.');
  const s:DemoSession=a.data;
  const path=`/api/dev/sessions/${s.id}/proposal`;
  const bad=structuredClone(s.dataset);bad.traces[0]!.spans[1]!.parentId='unknown-parent';
  const invalid=await call(path,'POST',{expectedVersion:1,dataset:bad},a.cookie);
  const intact=await call(`/api/sessions/${s.id}`,'GET',undefined,a.cookie);
  const corrected=structuredClone(s.dataset);corrected.activeScenario='exhausted';
  const accepted=await call(path,'POST',{expectedVersion:1,dataset:corrected},a.cookie);
  const stale=await call(path,'POST',{expectedVersion:1,dataset:corrected},a.cookie);
  const readback=await call(`/api/sessions/${s.id}`,'GET',undefined,a.cookie);
  const foreignRead=await call(`/api/sessions/${s.id}`,'GET',undefined,b.cookie);
  const foreignWrite=await call(path,'POST',{expectedVersion:2,dataset:corrected},b.cookie);
  const checks={invalidRejected:invalid.status===422,invalidLeavesVersion:intact.data.version===1,correctedAccepted:accepted.status===200,readbackVersion:readback.data.version===2,readbackScenario:readback.data.dataset.activeScenario==='exhausted',staleRejected:stale.status===409,foreignReadDenied:foreignRead.status===404,foreignWriteDenied:foreignWrite.status===404};
  console.log(JSON.stringify({synthetic:true,sessions:[s.id,b.data.id],checks},null,2));
  if(Object.values(checks).some(x=>!x))process.exitCode=1;
} else throw new Error('Supported harness actions: validate, inspect. No arbitrary personalization.');
