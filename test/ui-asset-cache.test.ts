import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './helpers/backend.ts';

test('local UI documents and styles explicitly avoid stale cached review assets',async()=>{
 const h=await harness();
 try {
  for(const path of ['/entry','/style.css']){
   for(const method of ['GET','HEAD']){
    const response=await fetch(`http://127.0.0.1:${h.port}${path}`,{method});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const text=await response.text();if(method==='HEAD')assert.equal(text,'');else assert.ok(text.length>0);
   }
  }
 }finally{await h.close();}
});
