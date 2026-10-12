import { test, expect, type Page } from '@playwright/test';
import type { DemoSession } from '../src/contracts.ts';
import type { EvaluationDetail } from '../src/clients/neatlogs/eval-contract.ts';
async function fixture(page: Page): Promise<{session:DemoSession;detail:EvaluationDetail}> {
  await page.goto('/entry');
  await page.getByLabel('Ask anything').fill('Show a customer support agent with a polite answer that does not resolve the request.');
  await page.getByRole('button',{name:'Send message'}).click();await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  const session:DemoSession=await page.request.get('/api/session').then(r=>r.json());const trace=session.dataset.traces[0]!;
  const created=await page.request.post(`/api/sessions/${session.id}/evaluations`,{data:{clientOperationId:crypto.randomUUID(),datasetVersion:session.version,name:'SCRIPTED support-resolution review',description:'Scripted review fixture: a polite answer can still leave the request unresolved.',traceIds:[trace.id],questions:[{key:'resolved',label:'Did the answer resolve the customer request?',type:'yes_no',required:true,reviewer:'buyer'},{key:'tone',label:'Was the response polite?',type:'rating',min:1,max:5,required:true,reviewer:'simulated_judge'}],checks:[{key:'no-error',label:'No execution errors',kind:'no_error'}]}});
  expect(created.status()).toBe(201);const first:EvaluationDetail=await created.json();
  const reviewed=await page.request.post(`/api/sessions/${session.id}/evaluations/${first.evaluation.id}/reviews`,{data:{clientOperationId:crypto.randomUUID(),datasetVersion:session.version,expectedVersion:first.evaluation.version,responses:[{traceId:trace.id,questionKey:'resolved',value:false}]}});
  expect(reviewed.status()).toBe(200);return{session,detail:await reviewed.json()};
}
function previewPath(s:DemoSession,e:EvaluationDetail){return `/demo/${s.id}/evals/${e.evaluation.id}?preview=eval-guidance`;}

test('an unavailable evaluation preserves the demo, conversation and useful list/trace recovery',async({page,browser})=>{
  const {session,detail}=await fixture(page);await page.goto(`/demo/${session.id}/evals/does-not-exist`);
  await expect(page.getByRole('heading',{name:'Evaluation unavailable',exact:true})).toBeVisible();
  await expect(page.locator('.chat-panel')).toContainText(session.conversation[0]!.text);
  await expect(page.getByLabel('Ask anything')).toBeEnabled();await expect(page.locator('.demo-notice')).toContainText(`v${session.version}`);
  await page.getByRole('link',{name:'Back to Evals',exact:true}).click();await expect(page.getByRole('heading',{name:'Evals',exact:true})).toBeVisible();
  await expect(page.locator('.eval-list')).toContainText(detail.evaluation.name);
  await page.goto(`/demo/${session.id}/evals/does-not-exist`);await page.getByRole('link',{name:'Explore saved traces',exact:true}).click();
  await expect(page.locator('[data-count]')).toBeVisible();
  const other=await browser.newContext();const foreign=await other.newPage();await foreign.goto(`/demo/${session.id}/evals/does-not-exist`);
  await expect(foreign.getByRole('heading',{name:'Demo unavailable',exact:true})).toBeVisible();await expect(foreign.locator('.chat-panel')).toHaveCount(0);await other.close();
  expect((await page.request.get(`/api/sessions/${session.id}`).then(r=>r.json())).state).toBe('active');
});

test('scripted answer targets reviewer, criteria and actual saved results without running a turn',async({page})=>{
  const {session,detail}=await fixture(page);let turns=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/turns'))turns++;});
  await page.goto(previewPath(session,detail));await expect(page.locator('.eval-preview-label')).toContainText('SCRIPTED UI PREVIEW');
  await expect(page.locator('.chat-panel [data-eval-preview-target]')).toHaveCount(3);await expect(page.locator('.eval-preview-path button')).toHaveCount(4);await expect(page.locator('.eval-preview-dataset')).toBeVisible();await expect(page.getByLabel('Ask anything')).toBeDisabled();
  const before=await page.request.get(`/api/sessions/${session.id}`).then(r=>r.json());
  for(const [target,selector,tab]of[['evals.evaluator','.eval-evaluator-guide','Overview'],['evals.criteria','.eval-criteria-summary','Questions'],['evals.results','.eval-results','Results']]as const){
    const card=page.locator(`.chat-panel [data-eval-preview-target="${target}"]`);const history=await page.evaluate(()=>window.history.length);
    await card.click();await expect(page.locator(`${selector}.evaluation-preview-target`)).toHaveCount(1);await expect(page.locator('.eval-preview-note')).toContainText('Showing this saved evaluation');
    await expect(page.locator(`.eval-preview-path [data-eval-preview-target="${target}"]`)).toHaveAttribute('aria-current','step');
    await card.click();await expect(page.locator('.evaluation-preview-target')).toHaveCount(1);expect(await page.evaluate(()=>window.history.length)).toBe(history);
    await page.getByRole('button',{name:'Dismiss evaluation highlight'}).click();await expect(card).toBeFocused();await expect(page.locator('.evaluation-preview-target')).toHaveCount(0);
  }
  await expect(page.locator('.eval-results')).toContainText('Executed sample checks');await expect(page.locator('.eval-results')).toContainText('Your review');await expect(page.locator('.eval-results')).toContainText('Simulated score — no AI evaluator ran');
  await page.reload();await expect(page.locator('.evaluation-preview-target')).toHaveCount(0);
  expect((await page.request.get(`/api/sessions/${session.id}`).then(r=>r.json())).conversation).toEqual(before.conversation);expect(turns).toBe(0);
  await page.getByRole('link',{name:'Return to saved review',exact:true}).click();await expect(page.locator('.eval-preview-label')).toHaveCount(0);await expect(page.getByLabel('Ask anything')).toBeEnabled();
});

for(const fault of ['missing','stale','dataset','render']as const)test(`scripted evaluation ${fault} target never claims it showed`,async({page})=>{
  const {session,detail}=await fixture(page);await page.goto(previewPath(session,detail));await expect(page.locator('.chat-panel [data-eval-preview-target]')).toHaveCount(3);
  if(fault==='dataset')await page.route(`**/api/sessions/${session.id}`,async route=>{const response=await route.fetch();const saved=await response.json();saved.version++;await route.fulfill({response,json:saved});});
  else if(fault==='render')await page.evaluate(()=>{const remove=()=>document.querySelectorAll('.eval-results').forEach(el=>el.remove());new MutationObserver(remove).observe(document.body,{childList:true,subtree:true});remove();});
  else await page.route(`**/api/sessions/${session.id}/evaluations/${detail.evaluation.id}`,async route=>{if(fault==='missing')return route.fulfill({status:404,json:{error:{code:'EVALUATION_NOT_FOUND',message:'Scripted missing evaluation'}}});const response=await route.fetch();const saved=await response.json();saved.evaluation.version++;await route.fulfill({response,json:saved});});
  await page.locator('.chat-panel [data-eval-preview-target="evals.results"]').click();await expect(page.locator('.eval-preview-note')).toContainText(/unavailable|could not be shown/);await expect(page.locator('.eval-preview-note')).not.toContainText('Showing this saved evaluation');await expect(page.locator('.evaluation-preview-target')).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(page.locator('.chat-panel [data-eval-preview-target="evals.results"]')).toBeFocused();expect((await page.request.get(`/api/sessions/${session.id}`).then(r=>r.json())).version).toBe(session.version);
});

test('the preview bundle is served but only loaded by an explicitly opted-in evaluation page',async({page})=>{
  const requests:string[]=[];page.on('request',r=>{if(r.url().endsWith('/eval-guidance-preview.js'))requests.push(r.url());});
  const {session,detail}=await fixture(page);await page.goto(`/demo/${session.id}/evals/${detail.evaluation.id}`);
  await expect(page.getByRole('heading',{name:detail.evaluation.name,exact:true})).toBeVisible();expect(requests).toHaveLength(0);
  const source=await page.request.get('/eval-guidance-preview.js');expect(source.status()).toBe(200);expect(await source.text()).toContain('createScriptedEvaluationPreviewAnswer');
  await page.goto(previewPath(session,detail));await expect(page.locator('.chat-panel [data-eval-preview-target]')).toHaveCount(3);expect(requests).toHaveLength(1);
});


test('narrow scripted criteria begins below the actual wrapped sticky workflow tabs',async({page})=>{
 await page.setViewportSize({width:390,height:844});const {session,detail}=await fixture(page);await page.goto(previewPath(session,detail));
 await page.locator('.chat-panel [data-eval-preview-target="evals.criteria"]').click();await expect(page.locator('.eval-criteria-summary.evaluation-preview-target')).toBeVisible();
 const bounds=await page.evaluate(()=>({tabs:document.querySelector('.eval-preview-path')!.getBoundingClientRect().bottom,question:document.querySelector('.eval-criteria-summary .ne-field')!.getBoundingClientRect().top}));expect(bounds.question).toBeGreaterThan(bounds.tabs+8);
 await expect(page.getByLabel('Question 1',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Dismiss evaluation highlight'}).click();await expect(page.locator('.chat-panel [data-eval-preview-target="evals.criteria"]')).toBeFocused();
});
