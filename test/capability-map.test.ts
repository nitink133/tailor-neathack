import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITY_MAP_VERSION, capabilityRemitSummary, publicCapabilities, type CapabilityMapRecord } from '../src/clients/neatlogs/capabilities.ts';
import { loadKnowledge, pricingSummary } from '../src/clients/neatlogs/knowledge.ts';

test('vetted public capability projection has three editable substantive starters and no private fields', () => {
  const p=publicCapabilities();
  assert.equal(p.version,CAPABILITY_MAP_VERSION); assert.equal(p.starters.length,3);
  const records=loadKnowledge();
  for (const s of p.starters) { assert.ok(records.get(s.capabilityId)); assert.match(s.prompt,/retrieval|invoice|support/); }
  assert.equal(new Set(p.starters.map(s=>s.id)).size,3);
  assert.ok(capabilityRemitSummary().length<=1000);
  assert.ok(!/sessionId|cookie|apiKey|fingerprint/.test(JSON.stringify(p)));
});

test('map separates product limits, executable synthetic evals and unknown hosted AI access', () => {
  const records=loadKnowledge();
  const local=records.get('synthetic-evaluation-review') as CapabilityMapRecord;
  assert.equal(local.cloneSupport.state,'executable'); assert.equal(local.scope,'clone_only');
  const hosted=records.get('official-ai-evaluators') as CapabilityMapRecord;
  assert.equal(hosted.cloneSupport.state,'explain_only'); assert.equal(hosted.hostedAvailability.state,'unknown');
  const gate=records.get('official-api-runtime-gates') as CapabilityMapRecord;
  assert.equal(gate.hostedAvailability.state,'documented_gated'); assert.equal(gate.hostedAvailability.operationGate,'tier-c-compute');
  assert.ok(gate.sources.every(s=>s.verifiedOn==='2026-10-12'));
  assert.equal(pricingSummary().status,'unknown');
});

test('eval and quality retrieval surface relevant records within existing bound', () => {
  for (const q of ['AI judge rubric verdict schema','human reviewer tone correctness','invoice extraction missing due date','does an ingest credential grant evaluation API access']) {
    const records=loadKnowledge().select(q);
    assert.ok(records.length>0 && records.length<=6);
    assert.ok(records.some(r=>/evaluation|review|quality|runtime|evaluator/.test(r.id)),q);
  }
});
