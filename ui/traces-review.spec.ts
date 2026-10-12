import {test,expect} from '@playwright/test';
const prompt='I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.';
async function enter(page:import('@playwright/test').Page){await page.goto('/entry');await page.getByLabel('Ask anything').fill(prompt);await page.getByRole('button',{name:'Send message'}).click();await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();}

test('filters and date control fit the available workspace; filter editors are usable',async({page})=>{
 await enter(page);
 for(const [width,height]of[[980,729],[1440,900],[390,844]]){
  await page.setViewportSize({width,height});
  const work=page.locator('.trace-workspace');await expect(work).toBeVisible();
  const filter=page.locator('.filter-scroll');await expect(filter).toHaveCSS('flex-wrap','nowrap');
  const date=page.locator('.trace-date-range');await expect(date).toBeVisible();
  const box=await date.boundingBox(),workBox=await work.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(workBox!.x);expect(box!.x+box!.width).toBeLessThanOrEqual(workBox!.x+workBox!.width+1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.locator('.filter-popover summary').filter({hasText:'Detections'}).click();
  const editor=page.locator('.filter-popover[open] .filter-editor');await expect(editor).toBeVisible();
  const e=await editor.boundingBox();expect(e!.x).toBeGreaterThanOrEqual(workBox!.x);expect(e!.x+e!.width).toBeLessThanOrEqual(workBox!.x+workBox!.width+1);
  const anchor=await page.locator('.filter-popover[open] summary').boundingBox();
  const targetX=Math.max(Math.max(8,workBox!.x),Math.min(anchor!.x,Math.min(width-8,workBox!.x+workBox!.width)-e!.width));expect(Math.abs(e!.x-targetX)).toBeLessThanOrEqual(1);
  await page.getByLabel('Detections',{exact:true}).selectOption('yes');await editor.getByRole('button',{name:'Apply filters'}).click();
  await expect(page).toHaveURL(/detection=yes/);
  await page.locator('#filters a').filter({hasText:'Clear'}).click();
  await expect(page).not.toHaveURL(/detection=/);
  await expect(page.locator('.trace-workspace')).toBeVisible();await expect(page.locator('.trace-guide')).toBeVisible();
  if(width===390){const action=await page.locator('.trace-guide a').boundingBox(),dock=await page.locator('.chat-panel').boundingBox();expect(action!.y+action!.height).toBeLessThanOrEqual(dock!.y);}
  await page.screenshot({path:`.local/review-evidence/traces-after-${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:980,height:729});
 await page.getByRole('button',{name:'Toggle local theme'}).click();
 await expect(page.locator('.trace-guide .trace-start-link')).toHaveCSS('color','rgb(142, 186, 255)');
 await expect(page.locator('tr.is-active-fixture')).toHaveCSS('background-color','rgb(24, 37, 59)');
 await expect(page.locator('.trace-row-label').first()).toHaveCSS('color','rgb(238, 238, 240)');
 await page.screenshot({path:'.local/review-evidence/traces-after-dark.png',fullPage:true});
 await page.getByRole('button',{name:'Toggle local theme'}).click();
 const url=page.url();await page.locator('.trace-date-range').click();await expect(page.locator('.toast')).toContainText('fixed date range');expect(page.url()).toBe(url);
});

test('guide explains saved traces and opens the real failed step',async({page})=>{
 await enter(page);
 const state=await(await page.request.get('/api/session')).json();
 const guide=page.locator('.trace-guide');await expect(guide).toContainText('Start with a trace');
 await expect(guide).toContainText(/processed/i);
 await expect(page.locator('tbody tr .trace-row-description')).toHaveCount(state.dataset.traces.length);
 const link=guide.locator('a').first(),href=await link.getAttribute('href');
 const path=new URL(href!,'http://127.0.0.1:4322');const t=state.dataset.traces.find((x:{id:string})=>path.pathname.endsWith(x.id));
 expect(t).toBeTruthy();expect(t.spans.some((s:{id:string,status:string})=>s.id===path.searchParams.get('span')&&s.status==='ERROR')).toBe(true);
 await link.click();await expect(page.locator('.selected-span .span-content')).toBeVisible();
 await expect(page.locator('.trace-detail-guide')).toBeVisible();await expect(page.locator('.trace-detail-guide')).toContainText(/step/i);
 await expect(page.locator('.root-output')).toBeVisible();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await page.screenshot({path:'.local/review-evidence/traces-detail-guide-mobile.png',fullPage:true});
});

test('field help works with keyboard and guide dismissal persists only for its demo',async({page})=>{
 await enter(page);
 const help=page.getByRole('button',{name:'About Status',exact:true});await help.focus();
 await expect(page.getByRole('tooltip').filter({hasText:/processed/i})).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.getByRole('tooltip').filter({hasText:/processed/i})).toBeHidden();
 await page.locator('[data-trace-guide-dismiss]').click();await expect(page.locator('.trace-guide')).toBeHidden();
 await page.reload();await expect(page.locator('.trace-guide')).toBeHidden();
 await page.locator('[data-trace-guide-show]').click();await expect(page.locator('.trace-guide')).toBeVisible();
 await page.locator('[data-trace-guide-dismiss]').click();await enter(page);await expect(page.locator('.trace-guide')).toBeVisible();
});

test('recommended step reopens collapsed ancestors without preventing explicit collapse',async({page})=>{
 await enter(page);const state=await(await page.request.get('/api/session')).json();
 const listUrl=page.url(),href=await page.locator('.trace-guide a').first().getAttribute('href');
 const detailUrl=new URL(href!,'http://127.0.0.1:4322');detailUrl.search='';
 await page.goto(detailUrl.toString());await page.locator('[data-root]').first().click();
 await expect(page.locator('[data-root]').first()).toHaveAttribute('aria-expanded','false');
 await page.locator('.back-link').click();await expect(page).toHaveURL(listUrl);
 await page.locator('.trace-guide a').first().click();await expect(page.locator('.selected-span .span-content')).toBeVisible();
 await page.locator('[data-root]').first().click();await expect(page.locator('[data-root]').first()).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('.trace-detail-guide a')).toBeVisible();await page.locator('.trace-detail-guide a').click();
 await expect(page.locator('.selected-span .span-content')).toBeVisible();
});

test('field help fallback closes on Escape',async({page})=>{
 await page.addInitScript(()=>{Object.defineProperty(HTMLElement.prototype,'showPopover',{value:undefined,configurable:true});Object.defineProperty(HTMLElement.prototype,'hidePopover',{value:undefined,configurable:true});});
 await enter(page);
 // Simulate both missing native hiding and an unrecognized native pseudo-class.
 const css=await(await page.request.get('/style.css')).text();
 await page.locator('link[href="/style.css"]').evaluate(el=>el.remove());
 await page.addStyleTag({content:css.replaceAll(':popover-open',':unsupported-popover-state')});
 await page.locator('.trace-tooltip').evaluateAll(nodes=>nodes.forEach(node=>node.removeAttribute('popover')));
 const tip=page.getByRole('tooltip').filter({hasText:/processed/i});await expect(tip).toBeHidden();
 const help=page.getByRole('button',{name:'About Status',exact:true});await help.click();
 await expect(tip).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.getByRole('tooltip').filter({hasText:/processed/i})).toBeHidden();
});

test.describe('touch field help',()=>{
 test.use({hasTouch:true,viewport:{width:390,height:844}});
 test('tap opens header explanation',async({page})=>{
  await enter(page);
  await page.getByRole('button',{name:'Collapse conversation'}).tap();
  await page.getByRole('button',{name:'About Status',exact:true}).tap();
  await expect(page.getByRole('tooltip').filter({hasText:/processed/i})).toBeVisible();
 });
});
