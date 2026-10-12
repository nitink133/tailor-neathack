import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedSpendLedger } from '../src/infrastructure/ledger-bootstrap.ts';
import { createSpendGuard } from '../src/tailor/spend.ts';
const bucket={calls:10,inputTokens:100,outputTokens:20,thinkingTokens:0,cacheReadTokens:0,cacheWriteTokens:0,spentUsd:4};
const bytes=Buffer.from(JSON.stringify({version:2,total:bucket,byKind:{guard:bucket},unreconciled:{calls:1,usd:0.02},pending:[{id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',kind:'plan',model:'claude-sonnet-5-5',usd:0.1,at:1}],updatedAt:1})+'\n');
function environment(path:string) {return {TAILOR_PROVIDER:'anthropic',TAILOR_PUBLIC_ORIGIN:'https://tailor.example',TAILOR_SPEND_LEDGER:path,TAILOR_SPEND_LEDGER_SEED_BASE64:bytes.toString('base64'),TAILOR_SPEND_LEDGER_SEED_SHA256:createHash('sha256').update(bytes).digest('hex')};}
test('one-time seed retains exact bytes, unknown and pending reservations; never overwrites',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tailor-seed-'));const path=join(dir,'spend.json');
 try {const env=environment(path);assert.equal(seedSpendLedger(env)?.alreadyPresent,false);assert.deepEqual(readFileSync(path),bytes);assert.equal(seedSpendLedger(env)?.alreadyPresent,true);
 const summary=createSpendGuard({capUsd:19,ledgerPath:path}).summary();assert.equal(summary.spentUsd,4);assert.ok(Math.abs(summary.unreconciledUsd-0.12)<1e-12);assert.equal(summary.pendingCalls,1);assert.equal(summary.remainingUsd,14.9);
 writeFileSync(path,'different');assert.throws(()=>seedSpendLedger(env),/Refusing overwrite/);assert.equal(readFileSync(path,'utf8'),'different');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('seed refuses other providers, mismatch and content outside numeric accounting',()=>{
 const env=environment('/tmp/unused-seed-refusal.json');assert.throws(()=>seedSpendLedger({...env,TAILOR_PROVIDER:'mock'}),/explicit anthropic/);assert.throws(()=>seedSpendLedger({...env,TAILOR_SPEND_LEDGER_SEED_SHA256:'0'.repeat(64)}),/mismatch/);
 const unsafe=Buffer.from(JSON.stringify({...JSON.parse(bytes.toString()),privatePrompt:'must never migrate'}));assert.throws(()=>seedSpendLedger({...env,TAILOR_SPEND_LEDGER_SEED_BASE64:unsafe.toString('base64'),TAILOR_SPEND_LEDGER_SEED_SHA256:createHash('sha256').update(unsafe).digest('hex')}),/numeric version-2/);
 assert.equal(seedSpendLedger({}),null);
});
