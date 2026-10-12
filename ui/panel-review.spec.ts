import { test, expect } from '@playwright/test';

test('Approved Tailor header, honest pinned composer and follow-up prompts at each size',async({page})=>{
  await page.goto('/entry');
  await page.getByLabel('Ask anything').fill('I am building a travel agent. How can I improve my agent success rate with neatlogs?');
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page).toHaveURL(/\/demo\/[^/]+\/traces$/);
  const panel=page.getByRole('complementary',{name:'Playground'});
  await expect(panel.locator('.chat-turn.is-tailor').last()).toBeVisible();
  for(const [width,height] of [[980,729],[1440,900],[390,844]]){
    await page.setViewportSize({width,height});
    await expect(panel.locator('header strong')).toHaveText('Tailor');
    await expect(panel.locator('.contextual-tailor-subtitle')).toHaveText('Explore this product with me');
    await expect(panel.locator('.contextual-powered')).toContainText('Powered by Tailor');
    await expect(panel.locator('[data-exec-line]')).toHaveCount(0);
    await expect(panel.locator('.chat-tools .chat-chip').first()).toBeVisible();
    await expect(panel.locator('[data-exec-chip]')).toHaveText('Mock-backed');
    const list=panel.locator('.chat-examples');
    if(width>900){
      await expect(list).toBeVisible();await expect(list.locator('button')).toHaveCount(3);
      const last=list.locator('button').last(),prompt=await last.getAttribute('data-example');
      await last.click();await expect(panel.getByLabel('Ask anything')).toHaveValue(prompt!);
      await expect(panel.getByLabel('Ask anything')).toBeFocused();
    } else await expect(list).toBeHidden();
    const composer=await panel.locator('.chat-composer').boundingBox(),thread=await panel.locator('.chat-thread').boundingBox();
    expect(thread!.height).toBeGreaterThan(0);expect(composer!.y+composer!.height).toBeLessThanOrEqual(height);
    await panel.getByLabel('Ask anything').fill('');
    await page.screenshot({path:`.local/review-evidence/panel-after-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:980,height:729});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await expect(panel.locator('.contextual-powered')).toBeVisible();
  await expect(panel.locator('.chat-tools .chat-chip').first()).toBeVisible();
  await expect(panel.locator('.chat-composer')).toHaveCSS('background-color','rgb(21, 21, 24)');
  await expect(panel.locator('[data-exec-chip]')).toHaveCSS('color','rgb(238, 238, 240)');
  await page.screenshot({path:'.local/review-evidence/panel-after-dark.png',fullPage:true});
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.getByRole('button',{name:'Collapse conversation'}).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button',{name:'Open conversation'}).click();
  await expect(panel.locator('header strong')).toHaveText('Tailor');
});
