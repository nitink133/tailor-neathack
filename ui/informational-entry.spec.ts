import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
test('informational answer without a story retires old clarification copy and keeps seeds hidden',async({page})=>{
 await page.goto('/entry');await page.getByLabel('Ask anything').fill('Show me something failing.');await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.personalised-preparation')).toContainText('A little more context');
 const before=await page.request.get('/api/session').then(r=>r.json());expect(before.story).toBeNull();
 const seed=before.dataset.traces[0];
 const oldGuidance={id:`trace.overview:${before.version}:${seed.id}`,targetId:'trace.overview',label:'Inspect this request',purpose:'See the saved steps and timing for this synthetic request.',binding:{sessionId:before.id,version:before.version,scenario:before.dataset.activeScenario,traceId:seed.id,spanId:null,openTraceId:null}};
 const execution=(await page.request.get('/api/execution').then(r=>r.json())).execution;
 let release!:()=>void;const held=new Promise<void>(r=>release=r);
 await page.route('**/api/sessions/*/turns',async route=>{
  await held;
  const request=route.request().postDataJSON();
  await route.fulfill({status:200,json:{turnId:request.clientTurnId,outcome:'answered',version:before.version,conversationVersion:before.conversationVersion+2,steps:[],execution,messages:[{id:'scripted-info-buyer',role:'buyer',text:request.text,status:'note',at:new Date().toISOString()},{id:'scripted-info-answer',role:'tailor',text:'Neatlogs can help you inspect the inputs, outputs and timing recorded by your workflow instrumentation.',status:'note',guidance:[oldGuidance],at:new Date().toISOString()}]}});
 });
 await page.getByLabel('Ask anything').fill('Does Neatlogs make sense for my code review agent?');await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.personalised-preparation.is-working')).toBeVisible();release();
 const workspace=page.locator('.personalised-preparation');await expect(workspace).toContainText('Ask about your workflow');await expect(workspace).not.toContainText('Answer Tailor’s question');await expect(workspace).not.toContainText('A little more context');
 await expect(page.locator('tr[data-trace],.contextual-suggestion,.contextual-guide-target,.personalised-preparation.is-working')).toHaveCount(0);
 await expect(page.getByLabel('Ask anything')).toBeEnabled();await expect(page.locator('.chat-panel')).toContainText('Neatlogs can help you inspect');
 mkdirSync('docs/contextual-guidance',{recursive:true});await page.screenshot({path:'docs/contextual-guidance/informational-entry-desktop.png'});
 await page.setViewportSize({width:390,height:844});await expect(workspace).toBeVisible();await expect(page.getByLabel('Ask anything')).toBeVisible();await page.locator('.chat-turn.is-tailor').last().scrollIntoViewIfNeeded();await page.screenshot({path:'docs/contextual-guidance/informational-entry-narrow.png'});
 await page.route(`**/api/sessions/${before.id}`,async route=>{const response=await route.fetch();const saved=await response.json();saved.conversation.push({id:'historical-info-answer',role:'tailor',text:'Saved informational answer with an old seed suggestion.',status:'note',guidance:[oldGuidance],at:new Date().toISOString()});await route.fulfill({response,json:saved});});
 await page.reload();await expect(page.locator('.chat-panel')).toContainText('Saved informational answer');await expect(page.locator('.contextual-suggestion,.contextual-guide-target')).toHaveCount(0);
 // A stale detached control still cannot activate a hidden seed-bound suggestion.
 await page.evaluate(({id,messageId})=>{const button=document.createElement('button');button.textContent='Historical stale suggestion';button.dataset.guidanceId=id;button.dataset.guidanceMessage=messageId;document.querySelector('.chat-panel .chat-thread')!.append(button);},{id:oldGuidance.id,messageId:'historical-info-answer'});
 await page.getByRole('button',{name:'Historical stale suggestion'}).click();await expect(page.locator('.contextual-guide-target,.contextual-guide-note')).toHaveCount(0);
 expect((await page.request.get('/api/session').then(r=>r.json())).version).toBe(before.version);
});
