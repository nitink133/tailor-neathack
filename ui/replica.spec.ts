import { test, expect } from '@playwright/test';
import type { DemoSession } from '../src/contracts.ts';
import { mkdirSync } from 'node:fs';

const ed=process.env.TAILOR_SCREENSHOT_DIR ?? 'test-results/evidence';
mkdirSync(ed,{recursive:true});
test('both fixtures agree across API, trace tree, timeline, navigation, direct links, reload and session boundaries',async({page,browser})=>{
  await page.goto('/');await expect(page.getByRole('heading',{level:1})).toContainText('Your agent is already running.');
  await page.getByRole('link',{name:'Try with your project ↗'}).first().click();
  await page.getByLabel('Fictional project description').fill('Fictional order support shop. Saved text is not personalization.');
  await page.getByRole('button',{name:'Save and explore traces'}).click();
  await expect(page.locator('[data-count]')).toHaveText('1 – 2 of 2');
  const s:DemoSession=await (await page.request.get('/api/session')).json();
  for(const t of s.dataset.traces) {
    await page.goto(`/demo/${s.id}/traces/${t.id}`);
    await expect(page.locator('.root-output')).toContainText(t.outcome);
    await expect(page.locator('[data-span-id]')).toHaveCount(t.spans.length);
    await expect(page.locator('.error-text').filter({hasText:'ERROR'})).toHaveCount(t.scenario==='recovered'?1:2);
    await page.getByRole('button',{name:'Toggle timeline'}).click();
    await expect(page.locator('.timeline-row')).toHaveCount(t.spans.length);
    await page.getByRole('button',{name:'Toggle span tree'}).click();
    await expect(page.getByLabel('Span parent tree').locator('a')).toHaveCount(t.spans.length-1);
    await page.getByLabel('Span parent tree').locator('a').nth(1).click();
    await expect(page.locator('.graph-tree .graph-selected')).toHaveCount(1);
    await expect(page.locator('.span-content')).toHaveCount(0);
    await page.locator('[data-root]').click();await expect(page.locator('[data-span-id]')).toHaveCount(1);
    await page.locator('[data-root]').click();await expect(page.locator('[data-span-id]')).toHaveCount(t.spans.length);
    await page.getByRole('button',{name:'Toggle span tree'}).click();
    await page.getByRole('link',{name:`Select ${t.spans[2]!.name} in timeline`}).click();
    await expect(page.locator('.selected-span')).toHaveAttribute('data-span-id',t.spans[2]!.id);
    await expect(page.locator('.selected-span .error-box')).toContainText('order lookup timed out');
    await page.reload();await expect(page.locator('.selected-span')).toBeVisible();
    await page.goBack();await expect(page.locator('.selected-span')).toHaveCount(0);
    await page.goForward();await expect(page.locator('.selected-span')).toBeVisible();
    const direct=await page.request.get(`/api/sessions/${s.id}/traces/${t.id}/spans/${t.spans[2]!.id}`);expect((await direct.json()).span).toEqual(t.spans[2]);
    const otherTrace=s.dataset.traces.find(x=>x.id!==t.id)!;await page.locator('.trace-picker summary').click();await page.locator('.trace-picker nav a').filter({hasText:otherTrace.scenario==='recovered'?'Retry recovers':'Both attempts fail'}).click();await expect(page.locator('.root-output')).toContainText(otherTrace.outcome);
  }
  await page.goto(`/demo/${s.id}/traces?q=zz-no-match`);await expect(page.getByRole('heading',{name:'No traces found'})).toBeVisible();
  await page.getByRole('link',{name:'Clear filters'}).click();await expect(page.locator('[data-count]')).toHaveText('1 – 2 of 2');
  await page.locator('.filter-popover summary').filter({hasText:'Detections'}).click();await page.getByLabel('Detections',{exact:true}).selectOption('yes');await page.getByRole('button',{name:'Apply filters',exact:true}).click();await expect(page.locator('[data-count]')).toHaveText('1 – 1 of 1');
  await page.locator('tbody tr a').first().click();await expect(page.locator('.root-output')).toContainText('escalation_required');
  await page.locator('.back-link').click();await expect(page.getByLabel('Detections',{exact:true})).toHaveValue('yes');
  await page.goBack();await expect(page.locator('.root-output')).toContainText('escalation_required');await page.goForward();await expect(page.locator('[data-count]')).toHaveText('1 – 1 of 1');
  const foreign=await browser.newContext();const other=await foreign.newPage();await other.goto('/entry');await other.getByLabel('Fictional project description').fill('Fictional other visitor');await other.getByRole('button',{name:'Save and explore traces'}).click();await expect(other.locator('[data-count]')).toHaveText('1 – 2 of 2');
  await other.goto(`/demo/${s.id}/traces/${s.dataset.traces[0]!.id}`);await expect(other.getByRole('heading',{name:'Demo unavailable'})).toBeVisible();await expect(other.locator('[role=alert]')).toContainText('NOT_FOUND');await foreign.close();
  await page.goto(`/demo/${s.id}/traces/unknown`);await expect(page.locator('[role=alert]')).toContainText('Trace not found');
});

test('loading, failure recovery, interrupted navigation, repeated entry and browser version readback',async({page})=>{
  await page.goto('/entry');await page.getByLabel('Fictional project description').fill('Fictional resilient visit');
  await page.getByRole('button',{name:'Save and explore traces'}).dblclick();await expect(page.locator('[data-count]')).toHaveText('1 – 2 of 2');
  const s:DemoSession=await (await page.request.get('/api/session')).json();
  await page.route('**/api/sessions/**',async route=>{await new Promise(r=>setTimeout(r,250));await route.continue();});
  await page.goto(`/demo/${s.id}/traces`);await expect(page.getByRole('status')).toContainText('Loading');
  await page.goto(`/demo/${s.id}/traces/${s.dataset.traces[1]!.id}`);await expect(page.locator('.root-output')).toContainText('escalation_required');await page.unrouteAll({behavior:'wait'});
  await page.route('**/api/sessions/**',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'SERVER_FAILURE',message:'Synthetic local failure'}})}));
  await page.reload();await expect(page.locator('[role=alert]')).toContainText('Synthetic local failure');await page.unrouteAll();await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.locator('.root-output')).toContainText('escalation_required');
  const updated=structuredClone(s.dataset);updated.activeScenario='exhausted';
  const accepted=await page.request.post(`/api/dev/sessions/${s.id}/proposal`,{headers:{'x-tailor-dev-key':'local-review-key'},data:{expectedVersion:s.version,dataset:updated}});expect(accepted.status()).toBe(200);
  await page.reload();await expect(page.locator('.demo-notice')).toContainText('v2 · active fixture: exhausted');
  expect((await (await page.request.get('/api/session')).json()).description).toBe(s.description);
});

test('dated desktop/mobile evidence',async({page})=>{
  await page.setViewportSize({width:1710,height:1318});await page.goto('/');await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:ed+'/replica-public-desktop.png'});
  await page.goto('/entry');await page.getByLabel('Fictional project description').fill('Fictional review project');await page.getByRole('button',{name:'Save and explore traces'}).click();await expect(page.locator('[data-count]')).toHaveText('1 – 2 of 2');const s:DemoSession=await (await page.request.get('/api/session')).json();
  await page.screenshot({path:ed+'/replica-list-desktop.png'});
  await page.goto(`/demo/${s.id}/traces/${s.dataset.traces[0]!.id}`);await expect(page.locator('.root-output')).toBeVisible();await page.getByRole('button',{name:'Toggle timeline'}).click();await page.screenshot({path:ed+'/replica-recovered-desktop.png'});
  await page.goto(`/demo/${s.id}/traces/${s.dataset.traces[1]!.id}`);await expect(page.locator('.root-output')).toBeVisible();await page.getByRole('button',{name:'Toggle timeline'}).click();await page.screenshot({path:ed+'/replica-exhausted-desktop.png'});
  await page.getByRole('button',{name:'Toggle span tree'}).click();await page.screenshot({path:ed+'/replica-graph-desktop.png'});await page.getByRole('button',{name:'Toggle span tree'}).click();
  await page.getByRole('link',{name:`Select ${s.dataset.traces[1]!.spans[2]!.name} in timeline`}).click();await expect(page.locator('.selected-span .error-box')).toBeVisible();await page.screenshot({path:ed+'/replica-error-desktop.png'});
  await page.goto(`/demo/${s.id}/traces?q=zz-no-match`);await expect(page.getByRole('heading',{name:'No traces found'})).toBeVisible();await page.screenshot({path:ed+'/replica-empty-desktop.png'});
  await page.goto(`/demo/${s.id}/traces?q=recovered`);await expect(page.locator('[data-count]')).toHaveText('1 – 1 of 1');await page.screenshot({path:ed+'/replica-search-desktop.png'});
  await page.goto(`/demo/${s.id}/traces?minMs=45`);await expect(page.locator('[data-count]')).toHaveText('1 – 1 of 1');await page.screenshot({path:ed+'/replica-latency-desktop.png'});
  await page.goto(`/demo/${s.id}/traces/${s.dataset.traces[1]!.id}`);await expect(page.locator('.root-output')).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:ed+'/replica-detail-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto(`/demo/${s.id}/traces`);await expect(page.locator('[data-count]')).toBeVisible();await page.screenshot({path:ed+'/replica-list-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto('/');await page.screenshot({path:ed+'/replica-public-mobile.png',fullPage:true});
});

// Regression for the annotated public setup control: assets, live motion and fallback.
test('official setup control assets, comet motion and reduced-motion fallback',async({page})=>{
  await page.setViewportSize({width:980,height:729});await page.goto('/');await page.evaluate(()=>document.fonts.ready);
  const button=page.getByRole('button',{name:'Copy setup prompt',exact:true});
  await expect(button.locator('img')).toHaveCount(3);
  expect(await button.locator('img').evaluateAll(xs=>xs.every(x=>(x as HTMLImageElement).complete&&(x as HTMLImageElement).naturalWidth>0))).toBe(true);
  expect(await button.evaluate(el=>Math.round(el.getBoundingClientRect().width))).toBe(360);
  const motion=page.locator('.setup-comet');
  expect(await motion.evaluate(el=>el.getAnimations()[0]!.effect!.getTiming())).toMatchObject({duration:2900,easing:'linear',iterations:Infinity});
  const initial=await motion.evaluate(el=>getComputedStyle(el).transform);
  await expect.poll(()=>motion.evaluate(el=>getComputedStyle(el).transform)).not.toBe(initial);
  await page.screenshot({path:ed+'/setup-prompt-980.png'});
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.locator('.setup-border')).toBeHidden();expect(await motion.evaluate(el=>el.getAnimations().length)).toBe(0);
  await page.setViewportSize({width:390,height:844});await expect(button).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
