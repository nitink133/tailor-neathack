import { test, expect, type Page } from '@playwright/test';
const prompt = 'I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.';
async function send(page: Page, text: string) {
  await page.getByLabel('Ask anything').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}
async function start(page: Page) {
  await page.goto('/entry'); await send(page, prompt);
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  return page.request.get('/api/session').then(r => r.json());
}

test('repeating a shown suggestion preserves navigation history and Back reaches the list', async ({ page }) => {
  const s = await start(page);
  const depth = await page.evaluate(() => history.length);
  await page.locator('.contextual-suggestion[aria-pressed=true]').click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await page.locator('.contextual-suggestion[aria-pressed=true]').click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  expect(await page.evaluate(() => history.length)).toBe(depth);
  await page.goBack();
  await expect(page).toHaveURL(`/demo/${s.id}/traces`);
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
});

test('leaving while a turn is in flight preserves landing and allows saved-demo recovery', async ({ page }) => {
  const s = await start(page);
  let release!: () => void; const gate = new Promise<void>(r => release = r);
  await page.route('**/api/sessions/*/turns', async route => { await gate; await route.continue(); });
  await send(page, 'Make the retry fail too.');
  await expect(page.locator('.chat-pending-indicator')).toBeVisible();
  await page.getByRole('link', { name: 'Landing page' }).click();
  await expect(page).toHaveURL(/\/$/);
  const completed = page.waitForResponse(r => /\/turns$/.test(r.url()) && r.request().method() === 'POST');
  release(); await (await completed).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect.poll(async () => (await page.request.get(`/api/sessions/${s.id}`).then(r => r.json())).version).toBe(3);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('See where your agent workflow can fail');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/entry'); await page.locator('#resume').click();
  await expect(page.locator('.demo-notice')).toContainText('v3');
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await expect(page.getByLabel('Ask anything')).toBeEnabled();
});

test('a delayed response cannot cross into another owned demo or disable its composer', async ({ page }) => {
  const first = await start(page);
  const second = await start(page);
  await page.goto(`/demo/${first.id}/traces/${first.dataset.traces[0].id}`);
  let release!: () => void; const gate = new Promise<void>(r => release = r);
  await page.route(`**/api/sessions/${first.id}/turns`, async route => { await gate; await route.continue(); });
  await send(page, 'Make the retry fail too.');
  await expect(page.locator('.chat-pending-indicator')).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.locator('details.demo-picker summary').click();
  await page.locator(`[data-select-demo="${second.id}"]`).click();
  await expect(page).toHaveURL(`/demo/${second.id}/traces`);
  await expect(page.getByLabel('Ask anything')).toBeEnabled();
  const completed = page.waitForResponse(r => r.url().endsWith(`/sessions/${first.id}/turns`));
  release(); await (await completed).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect.poll(async () => (await page.request.get(`/api/sessions/${first.id}`).then(r => r.json())).version).toBe(3);
  await expect(page).toHaveURL(`/demo/${second.id}/traces`);
  await expect(page.locator('.demo-notice')).toContainText('v2');
  await expect(page.locator('.chat-panel')).not.toContainText('Make the retry fail too.');
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
});

for (const count of [0, 1, 2, 3, 4]) test(`stored guidance renders a bounded ${count > 3 ? 0 : count} suggestions from ${count} entries without auto-opening on reload`, async ({ page }) => {
  const s = await start(page);
  const trace = s.dataset.traces[0];
  const slowest = trace.spans.filter((span: { parentId: string | null }) => span.parentId).sort((a: { durationMs: number }, b: { durationMs: number }) => b.durationMs - a.durationMs)[0];
  const targets = ['trace.overview', 'trace.output', 'trace.slowest-span', 'trace.overview'];
  await page.route(`**/api/sessions/${s.id}`, async route => {
    const response = await route.fetch(); const saved = await response.json();
    const answer = saved.conversation.filter((turn: { role: string }) => turn.role === 'tailor').at(-1);
    answer.guidance = targets.slice(0, count).map(targetId => ({ id: `${targetId}:${s.version}:${trace.id}`, targetId, binding: { sessionId: s.id, version: s.version, scenario: s.dataset.activeScenario, traceId: trace.id, spanId: targetId === 'trace.slowest-span' ? slowest.id : null, openTraceId: null } }));
    await route.fulfill({ response, json: saved });
  });
  await page.reload();
  await expect(page.locator('.contextual-suggestion')).toHaveCount(count > 3 ? 0 : count);
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  if (count > 0 && count <= 3) {
    await page.locator('.contextual-suggestion').last().click();
    await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.contextual-suggestion').last()).toBeFocused();
  }
  expect((await page.request.get('/api/session').then(r => r.json())).version).toBe(s.version);
});

test('an old demo expiring during a switch cannot end the newly selected demo', async ({ page }) => {
  const first = await start(page), second = await start(page);
  await page.goto(`/demo/${first.id}/traces/${first.dataset.traces[0].id}`);
  let release!: () => void; const gate = new Promise<void>(r => release = r);
  await page.route(`**/api/sessions/${first.id}/turns`, async route => { await gate; await route.fulfill({ status: 410, json: { error: { code: 'SESSION_EXPIRED', message: 'Old demo expired' } } }); });
  await send(page, 'Make the retry fail too.');
  await expect(page.locator('.chat-pending-indicator')).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.locator('details.demo-picker summary').click();
  await page.locator(`[data-select-demo="${second.id}"]`).click();
  await expect(page).toHaveURL(`/demo/${second.id}/traces`);
  const completed = page.waitForResponse(r => r.url().endsWith(`/sessions/${first.id}/turns`));
  release(); await (await completed).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(page.getByLabel('Ask anything')).toBeEnabled();
  await expect(page.locator('.demo-notice')).toContainText('v2');
  await expect(page.locator('.ended')).toHaveCount(0);
  await expect(page).toHaveURL(`/demo/${second.id}/traces`);
});
