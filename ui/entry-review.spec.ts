import { test, expect } from '@playwright/test';

test('annotations: clean entry hierarchy and no empty saved controls at review viewports', async ({ page }) => {
  for (const [width, height] of [[790,729], [1440,900], [390,844]]) {
    await page.setViewportSize({ width, height });
    await page.goto('/entry');
    await expect(page.locator('[data-exec-chip]')).toHaveText('Mock-backed');
    await expect(page.getByRole('heading', { level:1 })).toHaveText('See your agent in action');
    await expect(page.locator('.entry-intro p')).toHaveText('Explore a workflow. See what happens at every step.');
    await expect(page.locator('.tailor-attribution')).toHaveText('Powered by Tailor');
    await expect(page.locator('.tailor-pill')).toHaveText('Tailor');
    await expect(page.locator('[data-exec-line]')).toHaveCount(0);
    await expect(page.locator('.chat-tools')).toContainText('Synthetic data');
    await expect(page.locator('.saved-demos')).toBeHidden();
    await expect(page.locator('#resume')).toBeHidden();
    await expect(page.locator('[data-starter-list] button')).toHaveCount(3);
    expect(await page.locator('.chat-home').evaluate(el=>getComputedStyle(el).backgroundImage)).toContain('ai-search-background.webp');
    const composer = await page.locator('.chat-composer').boundingBox();
    const attribution = await page.locator('.tailor-attribution').boundingBox();
    expect(attribution!.y).toBeGreaterThan(composer!.y + composer!.height);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path:`.local/review-evidence/after-${width}.png`, fullPage:true });
  }
});

test('saved picker and resume reflect browser ownership and active selection', async ({ page, browser }) => {
  await page.goto('/entry');
  await page.getByLabel('Ask anything').fill('I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.');
  await page.getByRole('button', {name:'Send message'}).click();
  await expect(page).toHaveURL(/\/demo\/[^/]+\/traces$/);
  const demoUrl=page.url();
  await page.goto('/entry');
  await expect(page.locator('.saved-demos')).toBeVisible();
  await expect(page.locator('[data-select-demo]')).toHaveCount(1);
  await expect(page.locator('#resume')).toBeVisible();
  await page.locator('#resume').click();
  await expect(page).toHaveURL(demoUrl);
  const other=await browser.newContext();
  const isolated=await other.newPage();
  await isolated.goto('/entry');
  await expect(isolated.locator('.saved-demos')).toBeHidden();
  await expect(isolated.locator('#resume')).toBeHidden();
  await other.close();
});

test('suggestions rotate without submitting and remain stable during keyboard editing', async ({page})=>{
  await page.clock.install();
  await page.goto('/entry');
  const suggestions=page.locator('[data-starter-list] button');
  await expect(suggestions).toHaveCount(3);
  const first=await suggestions.allTextContents();
  await page.clock.fastForward(8100);
  await expect.poll(()=>suggestions.allTextContents()).not.toEqual(first);
  const second=await suggestions.allTextContents();
  await suggestions.first().focus();
  await page.clock.fastForward(8100);
  expect(await suggestions.allTextContents()).toEqual(second);
  const prompt=await suggestions.first().getAttribute('data-example');
  await suggestions.first().click();
  await expect(page.getByLabel('Ask anything')).toHaveValue(prompt!);
  await expect(page.getByLabel('Ask anything')).toBeFocused();
  await expect(page).toHaveURL(/\/entry$/);
  await page.getByLabel('Ask anything').fill('My edited question');
  await page.clock.fastForward(8100);
  await expect(page.getByLabel('Ask anything')).toHaveValue('My edited question');
});

test('reduced motion keeps questions stable',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.clock.install();
  await page.goto('/entry');
  const suggestions=page.locator('[data-starter-list] button');
  await expect(suggestions).toHaveCount(3);
  const initial=await suggestions.allTextContents();
  await page.clock.fastForward(20000);
  expect(await suggestions.allTextContents()).toEqual(initial);
});

test('restoring entry restarts one rotation and navigation stops stale updates',async({page})=>{
  await page.clock.install();
  await page.goto('/entry');
  const suggestions=page.locator('[data-starter-list] button');
  await expect(suggestions).toHaveCount(3);
  const first=await suggestions.allTextContents();
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  await page.clock.fastForward(8100);
  expect(await suggestions.allTextContents()).toEqual(first);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await page.clock.fastForward(8100);
  await expect.poll(()=>suggestions.allTextContents()).not.toEqual(first);
  await page.getByRole('link',{name:'← Back to landing'}).click();
  await page.clock.fastForward(16000);
  await expect(page.locator('[data-starter-list]')).toHaveCount(0);
  await expect(page.getByRole('heading',{level:1})).toContainText('See where your agent workflow can fail');
});

test('empty, expired, failed and stale selections never show a resume action',async({page})=>{
  for(const state of [
    {state:'active',demos:[],activeDemoId:'old'},
    {state:'expired',demos:[{id:'old',label:'Old',version:1}],activeDemoId:'old'},
    {state:'active',demos:[{id:'owned',label:'Owned',version:1}],activeDemoId:'stale'},
    null,
  ]){
    await page.route('**/api/browser-session',route=>route.fulfill({status:state?200:500,contentType:'application/json',body:JSON.stringify(state??{})}));
    const response=page.waitForResponse('**/api/browser-session');
    await page.goto('/entry');await response;
    await expect(page.locator('[data-exec-chip]')).toHaveText('Mock-backed');
    await expect(page.locator('#resume')).toBeHidden();
    if(state?.state==='active'&&state.demos.length) await expect(page.locator('.saved-demos')).toBeVisible();
    else await expect(page.locator('.saved-demos')).toBeHidden();
    await page.unroute('**/api/browser-session');
  }
});

test('choosing current direct-linked demo updates active selection used by resume',async({page})=>{
  const build=async(prompt:string)=>{
    await page.goto('/entry');
    await page.getByLabel('Ask anything').fill(prompt);
    await page.getByRole('button',{name:'Send message'}).click();
    await expect(page).toHaveURL(/\/demo\/[^/]+\/traces$/);
    await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();
    return page.url();
  };
  const a=await build('I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.');
  const b=await build('I am building an invoice extraction workflow. Show a valid JSON output missing the due date.');
  expect(a).not.toEqual(b);
  const aId=/\/demo\/([^/]+)/.exec(a)![1];
  await page.goto(a);
  await expect(page.locator('[data-count]')).toBeVisible();
  // SPA return preserves current A while the server still selects B.
  await page.evaluate(()=>{history.pushState(null,'','/entry');window.dispatchEvent(new PopStateEvent('popstate'));});
  await expect(page).toHaveURL(/\/entry$/);
  await page.locator(`[data-select-demo="${aId}"]`).click();
  await expect(page).toHaveURL(a);
  const owned=await (await page.request.get('/api/browser-session')).json();
  expect(owned.activeDemoId).toEqual(aId);
  await page.goto('/entry');await page.locator('#resume').click();
  await expect(page).toHaveURL(a);
});
