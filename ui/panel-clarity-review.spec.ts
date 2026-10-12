import {test,expect} from '@playwright/test';

test('saved demo summary and Playground header remain clear at desktop, mobile and dark widths',async({page})=>{
 await page.goto('/entry');
 await page.getByLabel('Ask anything').fill('Create a fictional documentation question-answering workflow with a relevant retrieval and an answer that claims an unsupported feature absent from the source.');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page).toHaveURL(/\/demo\/[^/]+\/traces$/);
 const panel=page.getByRole('complementary',{name:'Playground'});
 const summary=panel.getByLabel('Latest request');
 await expect(summary).toHaveText('Saved your synthetic demo and confirmed the saved trace.');
 await expect(summary).not.toContainText(/Checked|Verified ✓|Read the trace|·/);
 await page.reload();await expect(summary).toHaveText('Saved your synthetic demo and confirmed the saved trace.');
 for(const [width,height] of [[980,729],[1440,900],[390,844],[320,720]]){
  await page.setViewportSize({width,height});
  const header=panel.locator('header'),title=header.locator('strong'),attribution=header.locator('.playground-attribution');
  await expect(title).toHaveText('Playground');await expect(attribution).toHaveText('Powered by Tailor');
  await expect(title).toHaveCSS('font-size','14px');
  const geometry=await header.evaluate(header=>{
   const title=header.querySelector('strong')!.getBoundingClientRect();const attribution=header.querySelector('.playground-attribution')!.getBoundingClientRect();const actions=header.querySelector('.chat-actions')!.getBoundingClientRect();const bounds=header.getBoundingClientRect();
   return {stacked:attribution.top>=title.bottom,notOverlapping:attribution.right<=actions.left,contained:actions.right<=bounds.right+1&&title.left>=bounds.left,fullyVisible:(header.querySelector('.playground-attribution') as HTMLElement).scrollWidth<=(header.querySelector('.playground-attribution') as HTMLElement).clientWidth};
  });
  expect(geometry).toEqual({stacked:true,notOverlapping:true,contained:true,fullyVisible:true});
  const close=header.getByRole('button',{name:'Collapse conversation'});
  const box=await close.boundingBox();expect(box!.width).toBeGreaterThanOrEqual(32);expect(box!.height).toBeGreaterThanOrEqual(32);
  await close.focus();await expect(close).toBeFocused();
  await expect(header.getByRole('button',{name:'End demo'})).toBeVisible();
  const thread=await panel.locator('.chat-thread').boundingBox();expect(thread!.height).toBeGreaterThan(50);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({path:`.local/review-evidence/clarity-after-${width}.png`,fullPage:false});
 }
 await page.setViewportSize({width:980,height:729});await page.getByRole('button',{name:'Toggle local theme'}).click();
 await expect(panel.locator('.tailor-pill')).toHaveCSS('background-color','rgb(29, 78, 137)');await expect(panel.locator('.tailor-pill')).toHaveCSS('color','rgb(255, 255, 255)');
 await expect(summary).toBeVisible();await page.screenshot({path:'.local/review-evidence/clarity-after-dark.png',fullPage:false});
 await page.getByRole('button',{name:'Collapse conversation'}).click();await expect(panel).toHaveCount(0);
 await page.getByRole('button',{name:'Open conversation'}).click();await expect(panel.locator('header strong')).toHaveText('Playground');await expect(panel.getByLabel('Latest request')).toHaveText('Saved your synthetic demo and confirmed the saved trace.');
});
