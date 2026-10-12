import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRoutingPanel } from '../src/clients/neatlogs/routing-renderer.ts';
import type { DemoSession } from '../src/clients/neatlogs/contracts.ts';
const session = { id:'demo-1', dataset:{traces:[{id:'trace-1',label:'Saved failure'}]} } as DemoSession;
const draft = {name:'Local <review>',type:'threshold',threshold:'1',severity:'critical',cooldown:'60000',recipient:'Engineering on-call',destination:'in_app',traceIds:['trace-1']};
test('native stages retain five-step structure and local form integration fields',()=>{
  for(let step=0;step<5;step++){
    const html=renderRoutingPanel({session,draft,step});
    assert.match(html,/role="dialog" aria-modal="true"/);
    assert.match(html,/id="routing-form"/);
    assert.match(html,new RegExp(`STEP ${step+1} OF 5`));
    assert.match(html,/Local simulation/);
    assert.match(html,/data-routing-close/);
  }
  assert.match(renderRoutingPanel({session,draft,step:1}),/name="traceId" value="trace-1" checked/);
  assert.match(renderRoutingPanel({session,draft,step:4}),/Local &lt;review&gt;/);
});
test('hosted-only types, info severity, and destination connections cannot be selected',()=>{
  const type=renderRoutingPanel({session,draft,step:0});
  for(const value of ['metric','compound','health'])assert.match(type,new RegExp(`value="${value}"[^>]*disabled`));
  const details=renderRoutingPanel({session,draft,step:2});
  assert.match(details,/value="info"[^>]*disabled/);
  const response=renderRoutingPanel({session,draft,step:3});
  assert.match(response,/aria-label="Toggle Slack for this rule" disabled/);
  assert.match(response,/No webhooks configured/);
  assert.match(response,/Local simulated destination/);
  assert.doesNotMatch(response,/mailto:|api\.slack|name="email"/);
});
test('dismissed wizard leaves saved list and reopen action without a modal',()=>{
  const html=renderRoutingPanel({session,draft,step:3,open:false});
  assert.doesNotMatch(html,/role="dialog"/);
  assert.match(html,/data-routing-open/);
  assert.match(html,/Saved previews/);
});
test('snapshot-only threshold and cooldown limits remain visible',()=>{
  const html=renderRoutingPanel({session,draft,step:1});
  assert.match(html,/value="Saved snapshot" disabled/);
  assert.match(html,/Counts failure outcomes only/);
  assert.match(html,/name="threshold"[^>]*max="4"/);
  assert.match(html,/value="600000"/);
});
