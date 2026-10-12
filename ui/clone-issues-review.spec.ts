import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
test('clone chrome separates carets and aligns expanded sidebar controls',async({page})=>{
  await page.goto('/entry');await page.getByLabel('Ask anything').fill('I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.');await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  const session=await page.request.get('/api/session').then(r=>r.json());await page.goto(`/demo/${session.id}/traces`);
  await expect(page.locator('.filter-caret')).toHaveCount(9);
  const margin=await page.locator('.filter-caret').first().evaluate(el=>getComputedStyle(el).marginLeft);expect(parseFloat(margin)).toBeGreaterThanOrEqual(4);
  await page.getByRole('button',{name:'Expand sidebar'}).click();
  const logo=await page.locator('.rail-header .mark').boundingBox();const collapse=await page.getByRole('button',{name:'Collapse sidebar'}).boundingBox();expect(logo).not.toBeNull();expect(collapse).not.toBeNull();expect(Math.abs(logo!.y+logo!.height/2-collapse!.y-collapse!.height/2)).toBeLessThan(3);
  mkdirSync('docs/contextual-guidance',{recursive:true});
  await page.screenshot({path:'docs/contextual-guidance/clone-chrome-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'docs/contextual-guidance/clone-chrome-narrow.png'});
});
