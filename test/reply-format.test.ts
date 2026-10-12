import test from 'node:test';
import assert from 'node:assert/strict';
import {replyBlocks} from '../src/clients/neatlogs/reply-format.ts';

test('step replies preserve facts, bullets, source dates and visible availability uncertainty',()=>{
 const text='Here is the recorded product behavior.\n\n1. Review the run\nSeven steps are recorded.\n2. Inspect failed steps\n- A failed after 5 ms.\n- B recovered.\n\nSources: Product (verified 2026-10-10).\nPlan availability for Product: unknown. Hosted access was not verified.';
 const blocks=replyBlocks(text);assert.equal(blocks[0]?.kind,'paragraph');
 const steps=blocks[1];assert.equal(steps?.kind,'steps');if(steps?.kind!=='steps')return;
 assert.equal(steps.items.length,2);assert.deepEqual(steps.items[1]?.body,[{kind:'points',items:['A failed after 5 ms.','B recovered.']}]);
 const refs=blocks.at(-1);assert.equal(refs?.kind,'references');if(refs?.kind==='references'){assert.equal(refs.unknownPlans,true);assert.match(refs.lines.join('\n'),/Hosted access was not verified/);}
});
test('legacy capability clauses stay verbatim and short refusals remain paragraphs',()=>{
 const out=replyBlocks('Capability: Recorded behavior. Limits: Cannot run live. In this demo it is view-only.');
 assert.deepEqual(out,[{kind:'steps',start:1,items:[{title:'Capability',body:[{kind:'paragraph',text:'Recorded behavior.'},{kind:'paragraph',text:'Limits: Cannot run live.'},{kind:'paragraph',text:'In this demo it is view-only.'}]}]}]);
 assert.deepEqual(replyBlocks('Nothing changed. Please choose a workflow.'),[{kind:'paragraph',text:'Nothing changed. Please choose a workflow.'}]);
});
test('plain markup stays inert text; nonconsecutive step numbers retain their values',()=>{
 const blocks=replyBlocks('1. <img src=x onerror=alert(1)>\n<script>bad()</script>\n5. Later recorded step');
 assert.equal(blocks[0]?.kind,'steps');assert.equal(blocks[1]?.kind,'steps');if(blocks[1]?.kind==='steps')assert.equal(blocks[1].start,5);
 assert.ok(JSON.stringify(blocks).includes('<script>bad()</script>'));
});
test('failure details remain inside commit step while trace-walk conclusion is separate',()=>{
 const commit=replyBlocks('1. Review the run\nSaved run.\n2. Inspect failed steps\n1 step failed: actual_tool (recorded error).');
 const block=commit[0];assert.equal(block?.kind,'steps');if(block?.kind==='steps')assert.deepEqual(block.items[1]?.body,[{kind:'paragraph',text:'1 step failed: actual_tool (recorded error).'}]);
 const trace=replyBlocks('1. actual_tool — TOOL, ERROR, starts +0 ms, takes 3 ms\n1 step failed:\n• actual_tool: recorded error');
 assert.equal(trace[1]?.kind,'paragraph');assert.equal(trace[2]?.kind,'points');
});

test('source-looking saved evidence remains visible and never becomes provenance',()=>{
 const footer='Sources: not source metadata\nPlan availability for tool: unknown.';
 for(const text of ['Saved and verified as version 2.\n1. Review the run\n'+footer, '1. tool — TOOL, ERROR, starts +0 ms, takes 3 ms\n'+footer]){
  assert.ok(!replyBlocks(text).some(block=>block.kind==='references'));
  assert.ok(JSON.stringify(replyBlocks(text)).includes('not source metadata'));
 }
 assert.ok(!replyBlocks('1. Product\n'+footer,{groupReferences:false}).some(block=>block.kind==='references'));
 assert.ok(!replyBlocks('1. Product\nSources: embedded text\nStill part of the step.').some(block=>block.kind==='references'));
});
test('pricing refusal remains visible before canonical product sources',()=>{
 const blocks=replyBlocks('1. Product\nRecorded behavior.\n\nSources: Product (verified 2026-10-10).\n\nI don’t have verified prices, so I won’t quote any.\n\nPlan availability for Product: unknown.');
 assert.deepEqual(blocks.at(-2),{kind:'paragraph',text:'I don’t have verified prices, so I won’t quote any.'});
 assert.equal(blocks.at(-1)?.kind,'references');
});
