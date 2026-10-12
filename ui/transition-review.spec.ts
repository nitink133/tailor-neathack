import {test,expect} from '@playwright/test';
const prompt='I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.';

test('first send keeps prompt/progress through creation and authoritative loading, then one turn',async({page})=>{
  await page.setViewportSize({width:980,height:729});
  let releaseCreate!:()=>void,releaseRead!:()=>void,releaseTurn!:()=>void;
  const createGate=new Promise<void>(r=>releaseCreate=r),readGate=new Promise<void>(r=>releaseRead=r),turnGate=new Promise<void>(r=>releaseTurn=r);
  let creates=0,turns=0;
  await page.route('**/api/browser-session/demos',async route=>{creates++;await createGate;await route.continue();});
  await page.route('**/api/sessions/*/traces',async route=>{await readGate;await route.continue();});
  await page.route('**/api/sessions/*/turns',async route=>{turns++;await turnGate;await route.continue();});
  await page.goto('/entry');await page.getByLabel('Ask anything').fill(prompt);await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.locator('.entry-transition')).toBeVisible();
  await expect(page.locator('.chat-stage')).toContainText(prompt);
  await expect(page.locator('.entry-transition')).toContainText('Creating');
  await expect(page.getByRole('button',{name:'Send message'})).toBeDisabled();
  await expect(page.locator('.entry-suggestions')).toBeHidden();
  await page.screenshot({path:'.local/review-evidence/transition-creating.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({path:'.local/review-evidence/transition-creating-mobile.png',fullPage:true});
  await page.setViewportSize({width:980,height:729});
  releaseCreate();
  await expect(page).toHaveURL(/\/demo\/[^/]+\/traces$/);
  await expect(page.locator('.entry-transition')).toBeVisible();
  await expect(page.locator('.chat-stage')).toContainText(prompt);
  await expect(page.locator('.entry-transition')).toContainText('Loading');
  await expect(page.locator('.loading')).toHaveCount(0);
  await page.screenshot({path:'.local/review-evidence/transition-opening.png',fullPage:true});
  releaseRead();
  await expect(page.locator('.chat-panel')).toBeVisible();
  await expect(page.locator('.chat-panel')).toContainText(prompt);
  await expect(page.locator('.chat-panel [role=status]')).toContainText('Working');
  await expect(page.locator('.chat-panel [data-exec-chip]')).toHaveText('Mock-backed');
  await page.screenshot({path:'.local/review-evidence/transition-working.png',fullPage:true});
  releaseTurn();
  await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();
  expect(creates).toBe(1);expect(turns).toBe(1);
  await expect(page.locator('.entry-transition')).toHaveCount(0);
});

test('creation failure restores retryable entry and reuses operation identity',async({page})=>{
  const keys:string[]=[];let fail=true;
  await page.route('**/api/browser-session/demos',async route=>{keys.push(route.request().headers()['idempotency-key']);if(fail){fail=false;await route.abort();}else await route.continue();});
  await page.goto('/entry');await page.getByLabel('Ask anything').fill(prompt);await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.locator('.form-error')).toContainText('Send again');
  await expect(page.locator('.entry-transition')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();
  await expect(page.locator('.chat-stage')).toContainText(prompt);
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await expect(page).toHaveURL(/\/demo\/[^/]+\/traces$/);
  await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
});

test('reduced motion and unsupported view transitions preserve the first-send journey',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(()=>Object.defineProperty(document,'startViewTransition',{value:undefined,configurable:true}));
  await page.setViewportSize({width:390,height:844});
  await page.goto('/entry');await page.getByLabel('Ask anything').fill(prompt);await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();
  await expect(page.locator('.chat-panel')).toContainText(prompt);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('leaving during preparation does not redirect or send a hidden first turn',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let creates=0,turns=0;
 await page.route('**/api/browser-session/demos',async route=>{creates++;await gate;await route.continue();});
 page.on('request',req=>{if(req.method()==='POST'&&/\/turns$/.test(req.url()))turns++;});
 await page.goto('/entry');await page.getByLabel('Ask anything').fill(prompt);await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.entry-transition')).toBeVisible();
 await page.getByRole('link',{name:'← Back to landing'}).click();await expect(page).toHaveURL(/\/$/);
 const completion=page.waitForResponse(r=>r.url().endsWith('/api/browser-session/demos'));
 release();await (await completion).finished();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
 await expect.poll(()=>creates).toBe(1);
 await expect(page.getByRole('heading',{level:1})).toContainText('Your agent is already running.');
 expect(turns).toBe(0);
});

test('unsent first prompt is durable before the post-create ownership read',async({page})=>{
 let created=false,release!:()=>void;const gate=new Promise<void>(r=>release=r);let turns=0;
 await page.route('**/api/browser-session/demos',async route=>{const response=await route.fetch();created=true;await route.fulfill({response});});
 await page.route('**/api/browser-session',async route=>{if(created&&route.request().method()==='GET'){await gate;}await route.continue();});
 page.on('request',req=>{if(req.method()==='POST'&&/\/turns$/.test(req.url()))turns++;});
 await page.goto('/entry');await page.getByLabel('Ask anything').fill(prompt);await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('[data-entry-phase]')).toHaveText('Loading your demo…');
 const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tailor-pending-turn')??'null'));
 expect(pending.text).toBe(prompt);expect(pending.clientTurnId).toBeTruthy();expect(pending.sessionId).toBeTruthy();
 expect(turns).toBe(0);
 await page.getByRole('link',{name:'← Back to landing'}).click();await expect(page).toHaveURL(/\/$/);
 const completion=page.waitForResponse(r=>r.url().endsWith('/api/browser-session')&&r.request().method()==='GET');
 release();await (await completion).finished();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
 await expect(page.getByRole('heading',{level:1})).toContainText('Your agent is already running.');
 expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tailor-pending-turn')??'null'))).toEqual(pending);
});

test('a throwing native transition falls back without blocking the first prompt',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(document,'startViewTransition',{value:()=>{throw new Error('unavailable');},configurable:true}));
 await page.goto('/entry');await page.getByLabel('Ask anything').fill(prompt);await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();
 await expect(page.locator('html')).not.toHaveClass(/entry-view-transition/);
});

test('failed initial trace read dispatches no turn and recovers with the original request',async({page})=>{
 let fail=true,turns=0;
 await page.route('**/api/sessions/*/traces',route=>{if(fail){fail=false;return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'SERVER_FAILURE',message:'Read failed'}})});}return route.continue();});
 page.on('request',req=>{if(req.method()==='POST'&&/\/turns$/.test(req.url()))turns++;});
 await page.goto('/entry');await page.getByLabel('Ask anything').fill(prompt);await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.getByRole('heading',{name:'Demo unavailable'})).toBeVisible();expect(turns).toBe(0);
 const stored=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tailor-pending-turn')??'null'));expect(stored.text).toBe(prompt);
 await page.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(page.locator('.chat-panel .chat-retry')).toBeVisible();
 const sent=page.waitForRequest(r=>r.method()==='POST'&&/\/turns$/.test(r.url()));
 await page.locator('.chat-panel .chat-retry').click();
 expect((await sent).postDataJSON().clientTurnId).toBe(stored.clientTurnId);
 await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible();expect(turns).toBe(1);
});
