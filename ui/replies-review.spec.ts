import {test,expect} from '@playwright/test';
const question='I am building a travel agent. How can I improve my agent success rate with neatlogs?';
async function send(page:import('@playwright/test').Page,text:string){await page.getByLabel('Ask anything').fill(text);await page.getByRole('button',{name:'Send message'}).click();}

test('capability answers are stepwise in stored API and skim-friendly in the dock',async({page})=>{
 await page.goto('/entry');await send(page,question);
 const reply=page.locator('.chat-panel .chat-turn.is-tailor').last();await expect(reply.locator('ol.reply-steps')).toBeVisible();
 const state=await(await page.request.get('/api/session')).json();const saved=state.conversation.filter((t:{role:string})=>t.role==='tailor').at(-1).text;
 expect(saved).toMatch(/^1\. /);expect(saved).toMatch(/\n- Limits:/);expect(saved).toMatch(/Sources:/);expect(saved).toMatch(/Plan availability.*unknown/);
 await expect(reply.locator('.reply-points').first()).toContainText('Limits:');
 const references=reply.locator('.reply-reference');await expect(references.locator('summary')).toContainText('unverified');
 await references.locator('summary').click();await expect(references).toContainText('Sources:');await expect(references).toContainText('unknown');
 await references.locator('summary').click();
 for(const [width,height]of[[980,729],[1440,900],[390,844]]){await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await page.screenshot({path:`.local/review-evidence/replies-after-${width}.png`,fullPage:true});}
 await page.setViewportSize({width:980,height:729});await page.getByRole('button',{name:'Toggle local theme'}).click();
 await expect(reply.locator('.assistant-reply')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
 await expect(page.locator('.chat-panel')).toHaveCSS('background-color','rgb(21, 21, 24)');
 await expect(reply.locator('.assistant-reply')).toHaveCSS('color','rgb(238, 238, 240)');
 await page.screenshot({path:'.local/review-evidence/replies-after-dark.png',fullPage:true});
 await page.reload();await expect(page.locator('.chat-panel .reply-steps')).toBeVisible();
});

test('save and explain replies retain trace evidence with structured steps',async({page})=>{
 await page.goto('/entry');await send(page,'I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.');
 await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();
 const reply=page.locator('.chat-panel .chat-turn.is-tailor').last();await expect(reply.locator('.assistant-reply>p').first()).toContainText('Saved and verified as version 2.');
 await expect(reply.locator('.reply-step-title').first()).toHaveText('Review the run');
 await expect(reply.locator('.chat-evidence a')).toHaveCount(1);
 const state=await(await page.request.get('/api/session')).json();const trace=state.dataset.traces[0];
 await page.goto(`/demo/${state.id}/traces/${trace.id}`);await send(page,'Explain this trace');
 const explanation=page.locator('.chat-panel .chat-turn.is-tailor').last();await expect(explanation.locator('.reply-steps li strong')).toHaveCount(trace.spans.length);
 await expect(explanation.locator('.assistant-reply')).toContainText(trace.spans.find((s:{status:string})=>s.status==='ERROR').name);
 await expect(explanation.locator('.chat-evidence a')).toHaveAttribute('href',`/demo/${state.id}/traces/${trace.id}`);
});

test('saved legacy replies render safely without rewriting their API text',async({page})=>{
 await page.goto('/entry');await send(page,question);await expect(page.locator('.reply-steps')).toBeVisible();
 const before=await(await page.request.get('/api/session')).json();
 const legacy='Capability: Fictional recorded behavior. Limits: Does not run live. In this demo it is view-only.\n<img src=x onerror=alert(1)>\nSources: Documentation (verified 2026-10-12).\nPlan availability for Capability: unknown. Hosted access unverified.';
 await page.route('**/api/sessions/*',async route=>{const res=await route.fetch();const body=await res.json();if(Array.isArray(body.conversation)){const last=body.conversation.filter((t:{role:string})=>t.role==='tailor').at(-1);last.text=legacy;}await route.fulfill({response:res,json:body});});
 await page.reload();const reply=page.locator('.chat-panel .chat-turn.is-tailor').last();await expect(reply.locator('.reply-step-title')).toHaveText('Capability');
 await expect(reply).toContainText('<img src=x onerror=alert(1)>');await expect(reply.locator('img,script')).toHaveCount(0);
 await expect(reply.locator('.reply-reference summary')).toContainText('unverified');
 const after=await(await page.request.get('/api/session')).json();expect(after.conversation).toEqual(before.conversation);
});
