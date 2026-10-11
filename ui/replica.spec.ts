import { test, expect } from '@playwright/test';
import type { DemoSession } from '../src/contracts.ts';
import { mkdirSync } from 'node:fs';

// NIT-272: NOT RUN by the agent/UI lane. Updated for the agent-driven buyer flow; needs a pass at integration
// (real backend + mock provider). Trace content now comes from the mock agent, so assertions derive from the API
// response instead of fixed fixtures. Entry is a conversation: POST /api/sessions, then POST /turns.
const ed=process.env.TAILOR_SCREENSHOT_DIR ?? 'test-results/evidence';
mkdirSync(ed,{recursive:true});
const BUILD='I\'m building a travel-booking agent. Show me a booking API timeout followed by a successful retry.';
const EDIT='Make the retry fail too.';
type Pg=import('@playwright/test').Page;
async function enter(page:Pg){await page.goto('/entry');await page.getByLabel('Ask anything').fill(BUILD);await page.getByRole('button',{name:'Send message'}).click();await expect(page.locator('[data-count]')).toBeVisible();await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();}
async function session(page:Pg):Promise<DemoSession>{return await (await page.request.get('/api/session')).json();}
const countText=(n:number)=>`1 – ${n} of ${n}`;
const errSpans=(t:DemoSession['dataset']['traces'][number])=>t.spans.filter(x=>x.status==='ERROR');
test('every generated scenario agrees across API, trace tree, timeline, navigation, direct links, reload and session boundaries',async({page,browser})=>{
  await page.goto('/');await expect(page.getByRole('heading',{level:1})).toContainText('Your agent is already running.');
  await expect(page.locator('.hack')).toHaveCSS('background-color','rgb(2, 141, 194)');
  await expect(page.locator('.hack')).toHaveCSS('height','32px');
  await expect(page.locator('.hack-date')).toHaveText('Oct 10–12');
  await expect(page.locator('.nav-current')).toContainText('Manifesto');
  await expect(page.locator('.nav-caret')).toContainText('Product');
  await expect(page.locator('.nav-out')).toContainText('Docs');
  await expect(page.locator('.nav-rule')).toBeVisible();
  expect(await page.locator('.public-nav .wordmark').evaluate(el=>getComputedStyle(el).fontFamily)).toContain('GeistMono');
  expect(await page.evaluate(()=>document.documentElement.scrollHeight<=document.documentElement.clientHeight+1)).toBe(true);
  await page.getByRole('link',{name:'Try with your project ↗'}).first().click();
  await expect(page.getByRole('heading',{name:'hello'})).toBeVisible();
  await page.getByLabel('Ask anything').fill(BUILD);await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.locator('[data-count]')).toBeVisible();
  const barRatio=await page.locator('.day').nth(12).evaluate(el=>{const bar=el.querySelector('.day-bar');if(!bar)return 1;return bar.getBoundingClientRect().height/el.getBoundingClientRect().height;});
  expect(barRatio).toBeGreaterThan(0.05);expect(barRatio).toBeLessThan(0.5);
  const noticeBox=await page.locator('.demo-notice').boundingBox();const pagerBox=await page.locator('[data-count]').boundingBox();
  expect(noticeBox!.y+noticeBox!.height).toBeLessThanOrEqual(pagerBox!.y+1);
  await page.getByRole('button',{name:'Expand sidebar'}).click();
  await expect(page.locator('.rail.is-labeled')).toContainText('setup');
  await expect(page.locator('.rail.is-labeled')).toContainText('1/2');
  await expect(page.locator('.rail.is-labeled')).toContainText('experiments');
  await page.getByRole('button',{name:'Collapse sidebar'}).click();
  await expect(page.locator('.rail.is-labeled')).toHaveCount(0);
  await page.locator('.chat-panel textarea').fill(EDIT);await page.locator('.chat-panel').getByRole('button',{name:'Send message'}).click();await expect(page.locator('.chat-panel [data-status=applied]').nth(1)).toBeVisible();
  const s:DemoSession=await session(page);const n=s.dataset.traces.length;expect(n).toBeGreaterThanOrEqual(2);
  for(const t of s.dataset.traces) {
    await page.goto(`/demo/${s.id}/traces/${t.id}`);
    await expect(page.locator('.root-output')).toContainText(t.outcome);
    await expect(page.locator('[data-span-id]')).toHaveCount(t.spans.length);
    await expect(page.locator('.error-text').filter({hasText:'ERROR'})).toHaveCount(errSpans(t).length);
    await page.getByRole('button',{name:'Toggle timeline'}).click();
    await expect(page.locator('.timeline-row')).toHaveCount(t.spans.length);
    await expect(page.locator('.steps header')).toBeVisible();
    await page.getByRole('button',{name:'Toggle span tree'}).click();
    // Model-authored scenarios vary in shape: derive the expected tree classes from this trace's non-root spans.
    const children=t.spans.filter(x=>x.parentId!==null);
    await expect(page.locator('.graph-children a.kind-filled')).toHaveCount(children.filter(x=>x.kind==='WORKFLOW'||x.kind==='CHAIN').length);
    await expect(page.locator('.graph-children a.kind-light')).toHaveCount(children.filter(x=>x.kind!=='WORKFLOW'&&x.kind!=='CHAIN').length);
    const det=t.spans.filter(x=>x.detection).length;
    if(det){await expect(page.locator('.span-detection.is-dot')).toHaveCount(det);await expect(page.locator('.span-detection.failure')).toHaveCount(0);}
    await expect(page.getByLabel('Span parent tree').locator('a')).toHaveCount(t.spans.length-1);
    await page.getByLabel('Span parent tree').locator('a').nth(1).click();
    await expect(page.locator('.graph-tree .graph-selected')).toHaveCount(1);
    await expect(page.locator('.span-content')).toHaveCount(0);
    await page.locator('[data-root]').click();await expect(page.locator('[data-span-id]')).toHaveCount(1);
    await page.locator('[data-root]').click();await expect(page.locator('[data-span-id]')).toHaveCount(t.spans.length);
    await page.getByRole('button',{name:'Toggle span tree'}).click();
    if(det){await expect(page.locator('.span-detection.failure')).toHaveCount(det);await expect(page.locator('.span-detection.is-dot')).toHaveCount(0);}
    const pick=errSpans(t)[0]??t.spans[1]!;
    await page.getByRole('link',{name:`Select ${pick.name} in timeline`}).click();
    await expect(page.locator('.selected-span')).toHaveAttribute('data-span-id',pick.id);
    if(pick.error)await expect(page.locator('.selected-span .error-box')).toContainText(pick.error.slice(0,40));
    await page.reload();await expect(page.locator('.selected-span')).toBeVisible();
    await page.goBack();await expect(page.locator('.selected-span')).toHaveCount(0);
    await page.goForward();await expect(page.locator('.selected-span')).toBeVisible();
    const direct=await page.request.get(`/api/sessions/${s.id}/traces/${t.id}/spans/${pick.id}`);expect((await direct.json()).span).toEqual(pick);
    const otherTrace=s.dataset.traces.find(x=>x.id!==t.id)!;await page.locator('.trace-picker summary').click();await page.locator('.trace-picker nav a').filter({hasText:otherTrace.label}).click();await expect(page.locator('.root-output')).toContainText(otherTrace.outcome);
  }
  const exhausted=s.dataset.traces[0]!;
  await page.goto(`/demo/${s.id}/traces/${exhausted.id}`);
  await page.getByRole('button',{name:'EXPAND ALL'}).click();
  await expect(page.locator('.span-content')).toHaveCount(exhausted.spans.filter(x=>x.parentId).length);
  await expect(page.locator(`[data-span-id="${exhausted.spans[0]!.id}"] .span-content`)).toHaveCount(0);
  await page.goto(`/demo/${s.id}/traces?q=zz-no-match`);await expect(page.getByRole('heading',{name:'No traces found'})).toBeVisible();
  await expect(page.locator('.empty-mark')).toBeVisible();await expect(page.locator('.empty-clear')).toBeVisible();
  await page.getByRole('link',{name:'Clear filters'}).click();await expect(page.locator('[data-count]')).toHaveText(countText(n));
  await page.locator('.filter-popover summary').filter({hasText:'Detections'}).click();await page.getByLabel('Detections',{exact:true}).selectOption('yes');await page.getByRole('button',{name:'Apply filters',exact:true}).click();const withDet=s.dataset.traces.filter(t=>t.spans.some(x=>x.detection));await expect(page.locator('[data-count]')).toHaveText(countText(withDet.length));
  await expect(page.locator('.filter-popover.is-selected')).toHaveCount(1);
  await page.locator('tbody tr a').first().click();await expect(page.locator('.root-output')).toBeVisible();
  await page.locator('.back-link').click();await expect(page.getByLabel('Detections',{exact:true})).toHaveValue('yes');
  await page.goBack();await expect(page.locator('[data-count]')).toHaveText(countText(n));
  await page.goForward();await expect(page.locator('[data-count]')).toHaveText(countText(withDet.length));
  await page.goForward();await expect(page.locator('.root-output')).toBeVisible();
  await page.goBack();await expect(page.locator('[data-count]')).toHaveText(countText(withDet.length));
  const foreign=await browser.newContext();const other=await foreign.newPage();await enter(other);
  await other.goto(`/demo/${s.id}/traces/${s.dataset.traces[0]!.id}`);await expect(other.getByRole('heading',{name:'Demo unavailable'})).toBeVisible();await expect(other.locator('[role=alert]')).toContainText('NOT_FOUND');await foreign.close();
  await page.goto(`/demo/${s.id}/traces/unknown`);await expect(page.locator('[role=alert]')).toContainText('Trace not found');
});

test('loading, failure recovery, interrupted navigation, repeated entry and browser version readback',async({page})=>{
  await enter(page);
  const s:DemoSession=await session(page);const last=s.dataset.traces[s.dataset.traces.length-1]!;
  await page.route('**/api/sessions/**',async route=>{await new Promise(r=>setTimeout(r,250));await route.continue();});
  await page.goto(`/demo/${s.id}/traces`);await expect(page.getByRole('status')).toContainText('Loading');
  await page.goto(`/demo/${s.id}/traces/${last.id}`);await expect(page.locator('.root-output')).toContainText(last.outcome);await page.unrouteAll({behavior:'wait'});
  await page.route('**/api/sessions/**',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'SERVER_FAILURE',message:'Synthetic local failure'}})}));
  await page.reload();await expect(page.locator('[role=alert]')).toContainText('Synthetic local failure');await page.unrouteAll();await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.locator('.root-output')).toContainText(last.outcome);
  // Version readback: an edit turn publishes version+1; a reload shows the same version from the server, not from the browser.
  await page.locator('.chat-panel textarea').fill(EDIT);await page.locator('.chat-panel').getByRole('button',{name:'Send message'}).click();await expect(page.locator('.demo-notice')).toContainText(`v${s.version+1} ·`);
  await page.reload();await expect(page.locator('.demo-notice')).toContainText(`v${s.version+1} ·`);
  expect((await session(page)).description).toBe(s.description);
});

test('dated desktop/mobile evidence',async({page})=>{
  await page.setViewportSize({width:1710,height:1318});await page.goto('/');await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:ed+'/replica-public-desktop.png'});
  await enter(page);await page.locator('.chat-panel textarea').fill(EDIT);await page.locator('.chat-panel').getByRole('button',{name:'Send message'}).click();await expect(page.locator('.chat-panel [data-status=applied]').nth(1)).toBeVisible();const s:DemoSession=await session(page);const lastTrace=s.dataset.traces[s.dataset.traces.length-1]!;
  await page.screenshot({path:ed+'/replica-list-desktop.png'});
  await page.goto(`/demo/${s.id}/traces/${s.dataset.traces[0]!.id}`);await expect(page.locator('.root-output')).toBeVisible();await page.getByRole('button',{name:'Toggle timeline'}).click();await page.screenshot({path:ed+'/replica-recovered-desktop.png'});
  await page.goto(`/demo/${s.id}/traces/${lastTrace.id}`);await expect(page.locator('.root-output')).toBeVisible();await page.getByRole('button',{name:'Toggle timeline'}).click();await page.screenshot({path:ed+'/replica-exhausted-desktop.png'});
  await page.getByRole('button',{name:'Toggle span tree'}).click();await page.screenshot({path:ed+'/replica-graph-desktop.png'});await page.getByRole('button',{name:'Toggle span tree'}).click();
  await page.getByRole('link',{name:`Select ${(errSpans(lastTrace)[0]??lastTrace.spans[1]!).name} in timeline`}).click();await expect(page.locator('.selected-span')).toBeVisible();await page.screenshot({path:ed+'/replica-error-desktop.png'});
  await page.goto(`/demo/${s.id}/traces?q=zz-no-match`);await expect(page.getByRole('heading',{name:'No traces found'})).toBeVisible();await page.screenshot({path:ed+'/replica-empty-desktop.png'});
  await page.goto(`/demo/${s.id}/traces?q=${encodeURIComponent(s.dataset.traces[0]!.label.split(' ')[0]!)}`);await expect(page.locator('[data-count]')).toBeVisible();await page.screenshot({path:ed+'/replica-search-desktop.png'});
  await page.goto(`/demo/${s.id}/traces?minMs=1`);await expect(page.locator('[data-count]')).toBeVisible();await page.screenshot({path:ed+'/replica-latency-desktop.png'});
  await page.goto(`/demo/${s.id}/traces/${lastTrace.id}`);await expect(page.locator('.root-output')).toBeVisible();
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

test('buyer conversation: clarify, build, edit, explain, answer; a failed send retries without duplicating; End demo clears the session',async({page})=>{
  await page.goto('/entry');
  await expect(page.locator('.chat-stage')).toContainText('Powered by Tailor · synthetic data');
  await page.getByLabel('Ask anything').fill('Show me something failing.');
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.locator('[data-count]')).toBeVisible();
  await expect(page.locator('.chat-panel')).toContainText('Mock-backed');
  const choices=page.locator('.chat-choices button');await expect(choices).toHaveCount(3);
  await page.reload();await expect(page.locator('.chat-choices button')).toHaveCount(3);
  await page.locator('.chat-choices button').first().click();
  await expect(page.locator('.chat-panel [data-status=applied]').last()).toBeVisible();
  await expect(page.locator('.demo-notice')).toContainText('Synthetic demo · Powered by Tailor');
  const s:DemoSession=await session(page);expect(s.dataset.traces.length).toBeGreaterThanOrEqual(1);
  const traceUrl=page.url();
  await page.locator('tbody tr a').first().click();
  await expect(page.locator('.chat-panel')).toBeVisible();
  await page.goBack();await expect(page).toHaveURL(traceUrl);
  await page.reload();await expect(page.locator('.chat-panel')).toContainText('Applied');
  await page.getByRole('button',{name:'Collapse conversation'}).click();
  await expect(page.locator('.chat-panel')).toHaveCount(0);
  await page.getByRole('button',{name:'Open conversation'}).click();
  await expect(page.locator('.chat-panel')).toContainText('Applied');
  await page.locator('.chat-panel textarea').fill('explain this trace');
  await page.locator('.chat-panel').getByRole('button',{name:'Send message'}).click();
  await expect(page.locator('.chat-evidence').last()).toContainText('Evidence');
  // A dropped request keeps the buyer's message, offers Retry and sends once.
  let dropped=0;await page.route('**/turns',route=>dropped++===0?route.abort():route.continue());
  await page.locator('.chat-panel textarea').fill('Can Neatlogs detect failed retries?');
  await page.locator('.chat-panel').getByRole('button',{name:'Send message'}).click();
  await expect(page.locator('.chat-retry')).toBeVisible();
  await page.locator('.chat-retry').click();
  await expect(page.locator('.chat-retry')).toHaveCount(0);
  await expect(page.locator('.chat-thread .chat-turn.is-buyer',{hasText:'Can Neatlogs detect failed retries?'})).toHaveCount(1);
  await page.unrouteAll();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator('.chat-panel')).toBeVisible();
  await page.getByRole('button',{name:'End demo'}).click();
  await expect(page.locator('.entry-notice')).toContainText('Demo ended');
  expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tailor')))).toEqual([]);
  // End demo clears the session cookie, so an unauthenticated follow-up must not reveal that the session existed (404, not 410).
  expect((await page.context().cookies()).filter(c=>c.name==='tailor')).toEqual([]);
  expect((await page.request.get(`/api/sessions/${s.id}`)).status()).toBe(404);
});
