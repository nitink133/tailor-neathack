import { test, expect } from '@playwright/test';

test('Playground header, honest composer labels and scrollable suggestions at each size',async({page})=>{
  await page.goto('/entry');
  await page.getByLabel('Ask anything').fill('I am building a travel agent. How can I improve my agent success rate with neatlogs?');
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page).toHaveURL(/\/demo\/[^/]+\/traces$/);
  const panel=page.getByRole('complementary',{name:'Playground'});
  await expect(panel.locator('.chat-turn.is-tailor').last()).toBeVisible();
  for(const [width,height] of [[980,729],[1440,900],[390,844]]){
    await page.setViewportSize({width,height});
    await expect(panel.locator('header strong')).toHaveText('Playground');
    await expect(panel.locator('.playground-attribution')).toHaveText('Powered by Tailor');
    await expect(panel.locator('.tailor-pill')).toHaveText('Tailor');
    await expect(panel.locator('[data-exec-line]')).toHaveCount(0);
    await expect(panel.locator('.chat-tools .chat-chip').first()).toBeVisible();
    await expect(panel.locator('[data-exec-chip]')).toHaveText('Mock-backed');
    const list=panel.locator('.chat-examples');
    await expect(list).toBeVisible();
    await expect(list.locator('button')).toHaveCount(3);
    await expect(list).toHaveCSS('overflow-x','auto');
    await expect(list).toHaveCSS('flex-wrap','nowrap');
    await expect.poll(()=>list.evaluate(el=>({overflow:getComputedStyle(el).overflowX,wrap:getComputedStyle(el).flexWrap,overflows:el.scrollWidth>el.clientWidth,singleRow:new Set(Array.from(el.children).map(c=>c.getBoundingClientRect().y)).size===1}))).toEqual({overflow:'auto',wrap:'nowrap',overflows:true,singleRow:true});
    await list.locator('button').last().focus();
    const scroll=await list.evaluate(el=>el.scrollLeft);expect(scroll).toBeGreaterThan(0);
    const last=list.locator('button').last(),prompt=await last.getAttribute('data-example');
    await last.click();await expect(panel.getByLabel('Ask anything')).toHaveValue(prompt!);
    await expect(panel.getByLabel('Ask anything')).toBeFocused();
    const composer=await panel.locator('.chat-composer').boundingBox(),thread=await panel.locator('.chat-thread').boundingBox();
    expect(thread!.height).toBeGreaterThan(0);expect(composer!.y+composer!.height).toBeLessThanOrEqual(height);
    await panel.getByLabel('Ask anything').fill('');
    await page.screenshot({path:`.local/review-evidence/panel-after-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:980,height:729});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await expect(panel.locator('.tailor-pill')).toBeVisible();
  await expect(panel.locator('.chat-tools .chat-chip').first()).toBeVisible();
  await expect(panel.locator('.chat-composer')).toHaveCSS('background-color','rgb(21, 21, 24)');
  await expect(panel.locator('[data-exec-chip]')).toHaveCSS('color','rgb(238, 238, 240)');
  await page.screenshot({path:'.local/review-evidence/panel-after-dark.png',fullPage:true});
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.getByRole('button',{name:'Collapse conversation'}).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button',{name:'Open conversation'}).click();
  await expect(panel.locator('header strong')).toHaveText('Playground');
});
