import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {once} from 'node:events';
import {createWebsiteServer} from '../server.mjs';

async function listen(server) { server.listen(0,'127.0.0.1'); await once(server,'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
function raw(url,options={}) {return new Promise((resolve,reject)=>{const req=request(url,options,res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(options.body);});}

test('demo handoff preserves same-origin authority, body, cookie and query; static routes stay isolated',async()=>{
  const seen=[];
  const demo=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const item={path:req.url,method:req.method,host:req.headers.host,origin:req.headers.origin,cookie:req.headers.cookie,body:Buffer.concat(chunks).toString()};seen.push(item);res.writeHead(200,{'content-type':'application/json','set-cookie':'tailor=opaque; HttpOnly; SameSite=Strict; Path=/'});res.end(JSON.stringify(item));});
  const upstream=await listen(demo);
  const website=createWebsiteServer({demoOrigin:upstream,demoEntryPath:'/entry?source=tailor'});
  const origin=await listen(website);
  try {
    const redirect=await raw(origin+'/try-demo');assert.equal(redirect.status,302);assert.equal(redirect.headers.location,'/entry?source=tailor');assert.equal(seen.length,0);
    const payload=JSON.stringify({message:'synthetic contract only'});
    const response=await raw(origin+'/api/browser-session?test=1',{method:'POST',headers:{Origin:origin,Cookie:'tailor=opaque', 'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},body:payload});
    assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{path:'/api/browser-session?test=1',method:'POST',host:new URL(origin).host,origin,cookie:'tailor=opaque',body:payload});assert.equal(response.headers['set-cookie'][0],'tailor=opaque; HttpOnly; SameSite=Strict; Path=/');
    for(const path of ['/style.css','/app.js','/assets/portrait.webp','/demo/id/traces/trace-id']) {await raw(origin+path);assert.equal(seen.at(-1).path,path);}
    const previous=seen.length;
    const art=await raw(origin+'/assets/landing.png');assert.equal(art.status,200);assert.equal(art.headers['content-type'],'image/png');assert.equal(seen.length,previous);
    for(const [path,type] of [['/marketing/motion.js','text/javascript; charset=utf-8'],['/marketing/motion.css','text/css; charset=utf-8']]) {
      const asset=await raw(origin+path);assert.equal(asset.status,200);assert.equal(asset.headers['content-type'],type);assert.equal(seen.length,previous,'animation assets must not reach the demo upstream');
    }
    assert.equal((await raw(origin+'/api/test',{headers:{Host:'evil.example'}})).status,403);
    assert.equal((await raw(origin+'/api/test',{headers:{Origin:'http://evil.example'}})).status,403);
    assert.equal(seen.length,previous);
    assert.equal((await raw(origin+'/try-demo',{method:'POST'})).status,405);
  } finally {await close(website);await close(demo);}
});

test('unsafe upstreams and redirected marketing-loop entry paths are rejected',()=>{
  for(const demoOrigin of ['https://127.0.0.1:4328','http://example.com','http://u:p@localhost:4328','http://localhost:4328/path'])assert.throws(()=>createWebsiteServer({demoOrigin}));
  for(const demoEntryPath of ['https://example.com','//example.com','/','/try-demo','/manifesto','/how-it-works'])assert.throws(()=>createWebsiteServer({demoEntryPath}));
});

test('unavailable demo has recoverable error page',async()=>{
  const unavailable=createServer();const target=await listen(unavailable);await close(unavailable);
  const website=createWebsiteServer({demoOrigin:target});const origin=await listen(website);
  try {const result=await raw(origin+'/entry');assert.equal(result.status,502);assert.match(result.body,/Return to Tailor/);}finally{await close(website);}
});
