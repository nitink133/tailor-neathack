import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
const cases=[
 {name:'approved',status:{enabled:true,reason:'approved_synthetic_session',maxTextChars:2000},label:'on',why:'Approved synthetic session'},
 {name:'not-approved',status:{enabled:false,reason:'session_not_approved',maxTextChars:2000},label:'off',why:'Timing and token usage are still recorded'},
 {name:'hosted-disabled',status:{enabled:false,reason:'hosted_export_disabled',maxTextChars:2000},label:'off',why:'off in this local preview'},
 {name:'missing',status:undefined,label:'off',why:'approval for this session is unavailable'},
 {name:'inconsistent',status:{enabled:true,reason:'session_not_approved',maxTextChars:2000},label:'off',why:'has not been approved'},
] as const;
for(const fixture of cases)test(`trace text capture status ${fixture.name} is session-scoped and honest`,async({page})=>{
 await page.goto('/entry');await page.request.post('/api/browser-session');
 const created=await page.request.post('/api/browser-session/demos',{data:{description:'Synthetic capture indicator fixture',conversation:[]},headers:{'Idempotency-Key':crypto.randomUUID()}}).then(r=>r.json());
 await page.route(`**/api/sessions/${created.id}`,async route=>{const response=await route.fetch();const data=await response.json();delete data.payloadCapture;if(fixture.status)data.payloadCapture=fixture.status;await route.fulfill({response,json:data});});
 await page.goto(`/demo/${created.id}/traces`);
 const status=page.locator('.payload-capture-status');await expect(status).toHaveAttribute('data-payload-capture',fixture.label);await expect(status.locator('summary')).toHaveText(`Trace text capture ${fixture.label} ⓘ`);
 await status.locator('summary').click();await expect(status.locator('p')).toContainText(fixture.why);await expect(page.getByLabel('Ask anything')).toBeVisible();
 if(fixture.name==='approved'||fixture.name==='not-approved'){
  mkdirSync('docs/contextual-guidance',{recursive:true});await page.screenshot({path:`docs/contextual-guidance/payload-capture-${fixture.name}-desktop.png`});await page.setViewportSize({width:390,height:844});await expect(page.getByLabel('Ask anything')).toBeVisible();await expect(status).toBeVisible();await page.screenshot({path:`docs/contextual-guidance/payload-capture-${fixture.name}-narrow.png`});
 }
});
