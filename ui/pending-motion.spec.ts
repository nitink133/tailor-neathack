import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
const prompt='I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.';
for(const outcome of ['success','clarification','failure','abort'] as const){
 test(`real pending activity clears on ${outcome}`,async({page})=>{
  let release!:()=>void;const held=new Promise<void>(r=>release=r);
  await page.route('**/api/sessions/*/turns',async route=>{await held;if(outcome==='failure')await route.fulfill({status:503,json:{error:{code:'PROVIDER_UNAVAILABLE',message:'Scripted unavailable'}}});else if(outcome==='abort')await route.abort();else await route.continue();});
  await page.goto('/entry');await page.getByLabel('Ask anything').fill(outcome==='clarification'?'Show me something failing.':prompt);await page.getByRole('button',{name:'Send message'}).click();
  const pending=page.locator('.personalised-preparation.is-working');await expect(pending).toBeVisible();await expect(pending).toHaveAttribute('aria-live','polite');await expect(pending).toHaveAttribute('aria-busy','true');
  await expect(page.locator('html')).not.toHaveClass(/entry-view-transition/);
  expect(await pending.locator('.personalised-preparation-mark').evaluate(el=>getComputedStyle(el,'::after').animationName)).toBe('tailor-pending-orbit');
  if(outcome==='success'){
   mkdirSync('docs/contextual-guidance',{recursive:true});await page.screenshot({path:'docs/contextual-guidance/pending-motion-desktop.png'});
   await page.setViewportSize({width:390,height:844});await expect(pending).toBeVisible();await page.screenshot({path:'docs/contextual-guidance/pending-motion-narrow.png'});
   await page.emulateMedia({reducedMotion:'reduce'});expect(await pending.locator('.personalised-preparation-mark').evaluate(el=>getComputedStyle(el,'::after').animationName)).toBe('none');
  }
  if(outcome==='abort')await page.getByRole('button',{name:'End demo'}).click();
  release();
  if(outcome==='success')await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  if(outcome==='clarification')await expect(page.locator('.chat-choices button')).toHaveCount(3);
  if(outcome==='failure')await expect(page.locator('.personalised-preparation')).toContainText('not ready');
  if(outcome==='abort')await expect(page).toHaveURL(/\/entry$/);
  await expect(page.locator('.personalised-preparation.is-working,.chat-pending-indicator')).toHaveCount(0);
 });
}
