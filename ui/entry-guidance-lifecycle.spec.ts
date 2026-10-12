import {test,expect,type Page} from '@playwright/test';
import {mkdirSync} from 'node:fs';
const prompt='I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.';
async function send(page:Page,text:string){await page.getByLabel('Ask anything').fill(text);await page.getByRole('button',{name:'Send message'}).click();}

test('entry conceals seed fixtures during a pending turn, then automatically reveals verified guidance once',async({page})=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/sessions/*/turns',async route=>{await held;await route.continue();});
  await page.goto('/entry');await send(page,prompt);
  await expect(page.locator('.personalised-preparation')).toContainText('Working on your workflow');
  await expect(page.locator('tr[data-trace]')).toHaveCount(0);
  await expect(page.locator('.chat-panel')).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/entry-view-transition/);
  mkdirSync('docs/contextual-guidance',{recursive:true});
  await page.screenshot({path:'docs/contextual-guidance/entry-pending-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'docs/contextual-guidance/entry-pending-narrow.png'});
  await page.setViewportSize({width:1440,height:900});
  release();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await expect(page).toHaveURL(/\/traces\/[^/?]+/);
  await page.screenshot({path:'docs/contextual-guidance/entry-committed-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.contextual-suggestion[aria-pressed=true]').click();
  await expect(page.locator('.contextual-guide-note')).toContainText('Showing in your playground');
  await page.screenshot({path:'docs/contextual-guidance/entry-committed-narrow.png'});
  await page.setViewportSize({width:1440,height:900});
  const before=await page.request.get('/api/session').then(r=>r.json());
  await page.getByRole('button',{name:'Dismiss highlight'}).click();
  await page.reload();await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  expect((await page.request.get('/api/session').then(r=>r.json())).version).toBe(before.version);
  await send(page,'Make the retry fail too.');
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await expect(page.locator('.contextual-guide-note')).toContainText('Showing in your playground');
});

test('entry clarification keeps seed traces hidden and accepts a follow-up before guidance',async({page})=>{
  await page.goto('/entry');await send(page,'Show me something failing.');
  await expect(page.locator('.chat-choices button')).toHaveCount(3);
  await expect(page.locator('.personalised-preparation')).toContainText('A little more context');
  await expect(page.locator('tr[data-trace]')).toHaveCount(0);
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await send(page,prompt);await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
});

test('entry transport failure retains truthful conversation and no generic fixtures',async({page})=>{
  await page.route('**/api/sessions/*/turns',route=>route.fulfill({status:503,json:{error:{code:'PROVIDER_UNAVAILABLE',message:'Scripted unavailable transport'}}}));
  await page.goto('/entry');await send(page,prompt);
  await expect(page.locator('.chat-note')).toContainText('server error');
  await expect(page.locator('.personalised-preparation')).toContainText('not ready');
  await expect(page.locator('tr[data-trace]')).toHaveCount(0);
  await expect(page.getByLabel('Ask anything')).toBeEnabled();
  await page.reload();await expect(page.locator('tr[data-trace]')).toHaveCount(0);
});
