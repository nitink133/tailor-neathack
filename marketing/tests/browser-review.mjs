import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_PACKAGE || '/tmp/tailor-live-feature-review/node_modules/playwright-core/index.mjs');

const base = process.env.TAILOR_TEST_URL || 'http://127.0.0.1:4348';
const output = new URL('./evidence/', import.meta.url);
await mkdir(output, {recursive:true});
const browser = await chromium.launch({headless:true});
const results = [];
try {
  for (const viewport of [{width:1440,height:1000},{width:980,height:900},{width:390,height:844},{width:320,height:768}]) {
    const context = await browser.newContext({viewport});
    const page = await context.newPage();
    const errors=[], badRequests=[], mutations=[];
    page.on('pageerror', e=>errors.push(e.message));
    page.on('response',r=>{if(r.status()>=400 && !r.url().endsWith('/api/browser-session')) badRequests.push({url:r.url(),status:r.status()});});
    await page.route('**/*',route=>{
      const request=route.request();
      if(!['GET','HEAD'].includes(request.method())) {mutations.push({method:request.method(),url:request.url()});return route.abort();}
      return route.continue();
    });
    for(const path of ['/','/manifesto','/how-it-works']) {
      await page.goto(base+path,{waitUntil:'networkidle'});
      await page.locator('h1').waitFor();
      const heading=await page.locator('h1').innerText();
      assert(heading.trim().length>10,`Missing ${path} heading`);
      const layout=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,images:[...document.images].map(i=>({src:i.getAttribute('src'),loaded:i.complete && i.naturalWidth>0})),deadLinks:[...document.querySelectorAll('a[href]')].filter(a=>['','#'].includes(a.getAttribute('href'))).length}));
      assert(layout.width<=layout.viewport+1,`${path} horizontally overflows at ${viewport.width}: ${layout.width}`);
      assert(layout.images.every(i=>i.loaded),`${path} image failed to load`);
      assert.equal(layout.deadLinks,0,`${path} empty link`);
      const tabs=page.getByRole('tab');
      const count=await tabs.count();
      for(let i=0;i<count;i++) {
        await tabs.nth(i).click();
        await page.waitForTimeout(80);
        assert.equal(await tabs.nth(i).getAttribute('aria-selected'),'true',`Tab ${i} selection missing`);
      }
      if(count>1) {
        await tabs.first().focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(await tabs.nth(1).getAttribute('aria-selected'),'true','ArrowRight did not select next tab');
        await page.keyboard.press('End');
        assert.equal(await tabs.last().getAttribute('aria-selected'),'true','End did not select final tab');
        await page.keyboard.press('Home');
        assert.equal(await tabs.first().getAttribute('aria-selected'),'true','Home did not select first tab');
      }
      await page.screenshot({path:new URL(`${viewport.width}-${path==='/'?'landing':path.slice(1)}.png`,output).pathname,fullPage:true});
      results.push({viewport:viewport.width,path,heading,tabCount:count,layout});
    }
    await page.goto(base+'/',{waitUntil:'networkidle'});
    await page.locator('[data-demo-link]').first().click();
    await page.waitForURL('**/entry');
    await page.getByRole('heading',{name:'See your agent in action'}).waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('.chat-home').count(),1,'Neatlogs entry did not render');
    assert.equal(await page.locator('.landing').count(),0,'Marketing markup leaked into demo');
    await page.screenshot({path:new URL(`${viewport.width}-demo-handoff.png`,output).pathname,fullPage:true});
    await page.goBack({waitUntil:'networkidle'});
    await page.waitForURL(base+'/');
    await page.getByRole('heading',{name:/Give buyers a first demo/}).waitFor();
    assert.equal(await page.locator('.chat-home').count(),0,'Browser back failed to return to Tailor');
    assert.equal(errors.length,0,`Browser errors: ${errors}`);
    assert.equal(badRequests.length,0,`Failed assets/API: ${JSON.stringify(badRequests)}`);
    assert.equal(mutations.length,0,`Unexpected writes: ${JSON.stringify(mutations)}`);
    results.push({viewport:viewport.width,path:'/entry',handoff:'pass',browserBack:'pass',errors,badRequests,mutations});
    await context.close();
  }
  await writeFile(new URL('browser-results.json',output),JSON.stringify({base,results},null,2));
  console.log(JSON.stringify({status:'passed',base,checked:results.length,evidence:output.pathname}));
} finally {await browser.close();}
