import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

function run(env: Record<string,string>) {
  const child=spawn(process.execPath,['src/main.ts'],{env:{PATH:process.env.PATH,NODE_ENV:'production',...env},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  return {child, output:()=>output};
}
async function raw(port:number,path:string,headers:Record<string,string>={},method='GET') {
  return await new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body}));});req.on('error',reject);req.end();
  });
}

test('production boot serves marketing and isolated demo through one process; graceful shutdown',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tailor-prod-test-'));
  const {child,output}=run({PORT:'0',TAILOR_PUBLIC_ORIGIN:'https://tailor.example',TAILOR_PROVIDER:'mock',TAILOR_TELEMETRY:'captured',TAILOR_DATA_PATH:join(dir,'demo.sqlite'),TAILOR_SPEND_LEDGER:join(dir,'spend.json')});
  try {
    let port=0;
    for(let i=0;i<200;i++){port=Number(/public listener ready on PORT=(\d+)/.exec(output())?.[1]);if(port)break;if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(port,output());
    const host={Host:'tailor.example'};
    assert.equal((await raw(port,'/healthz',{Host:'healthcheck.railway.app'})).status,200);
    for(const path of ['/','/manifesto','/how-it-works','/entry','/app.js','/style.css']) assert.equal((await raw(port,path,host)).status,200,path);
    assert.equal((await raw(port,'/api/execution',host)).body.includes('mock'),true);
    const one=await raw(port,'/api/browser-session',{...host,Origin:'https://tailor.example'},'POST');
    const two=await raw(port,'/api/browser-session',{...host,Origin:'https://tailor.example'},'POST');
    assert.equal(one.status,200);assert.notEqual(JSON.parse(one.body).id,JSON.parse(two.body).id);
    assert.match(one.headers['set-cookie']![0]!,/HttpOnly; SameSite=Strict;.*Secure/);
    assert.equal((await raw(port,'/api/browser-session',host)).status,404);
    assert.equal((await raw(port,'/api/browser-session',{...host,Cookie:one.headers['set-cookie']![0]!.split(';')[0]!})).body.includes(JSON.parse(one.body).id),true);
    assert.equal((await raw(port,'/api/dev/spend',host)).status,404);
    const ended=once(child,'exit');child.kill('SIGTERM');assert.equal((await ended)[0],0);
  } finally {if(child.exitCode===null)child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});

test('production refuses absent origin, raw synthetic capture and a fresh live ledger before clients initialize',async()=>{
  const base={TAILOR_PUBLIC_ORIGIN:'https://tailor.example',TAILOR_DATA_PATH:'/tmp/tailor-refusal-test.sqlite',TAILOR_SPEND_LEDGER:'/tmp/tailor-nonexistent-ledger-test.json'};
  for(const [env,message] of [
    [{},'Production requires TAILOR_PUBLIC_ORIGIN'],
    [{...base,TAILOR_SYNTHETIC_REVIEW_IDS:'operator-id'},'cannot enable synthetic payload capture'],
    [{...base,TAILOR_PROVIDER:'anthropic',TAILOR_LIVE_CAP_USD:'19'},'requires the existing cumulative spend ledger'],
    [{...base,TAILOR_PROVIDER:'anthropic',TAILOR_LIVE_CAP_USD:'20'},'cannot increase the approved cumulative'],
  ] as const){const {child,output}=run(env);const [code]=await once(child,'exit');assert.equal(code,2);assert.ok(output().includes(message),output());}
});
