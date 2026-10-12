import { test, expect, type Page } from '@playwright/test';
async function send(page: Page, text: string) {
  await page.getByLabel('Ask anything').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}
async function start(page: Page) {
  await page.goto('/entry');
  await send(page, 'Show a customer support agent with a polite answer that does not resolve the request.');
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  return page.request.get('/api/session').then(r => r.json());
}

for (const area of ['evals', 'alerts'] as const) test(`${area} guidance survives rerender, repeats safely, dismisses with focus and clears on navigation`, async ({ page }) => {
  const s = await start(page);
  const prompt = area === 'evals' ? 'How do Neatlogs evals fit this agent and how can I know they work?' : 'How does Neatlogs route alerts to the right people?';
  const label = area === 'evals' ? 'Configure the local review' : 'Preview alert routing';
  const target = area === 'evals' ? '.eval-reviewer-selection' : '.routing-create';
  await send(page, prompt);
  const card = page.getByRole('button', { name: new RegExp(label) }).last();
  await expect(card).toBeVisible(); await card.click();
  await expect(page.locator(`${target}.contextual-guide-target`)).toHaveCount(1);
  const depth = await page.evaluate(() => history.length);
  await card.click(); await expect(page.locator(`${target}.contextual-guide-target`)).toHaveCount(1);
  expect(await page.evaluate(() => history.length)).toBe(depth);
  if (area === 'alerts') {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Which signals should we match?' })).toBeVisible();
    await expect(page.locator(`${target}.contextual-guide-target`)).toHaveCount(1);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What should trigger this alert?' })).toBeVisible();
    await expect(page.locator(`${target}.contextual-guide-target`)).toHaveCount(1);
  }
  const answered = page.waitForResponse(r => r.url().endsWith('/turns') && r.request().method() === 'POST');
  await send(page, 'What does trace detail show?'); await (await answered).finished();
  await expect(page.locator(`${target}.contextual-guide-target`)).toHaveCount(1);
  await expect(page.locator('.contextual-guide-note')).toContainText('Showing in your playground');
  await page.setViewportSize({ width: 390, height: 844 }); await card.click();
  await expect(page.locator(`${target}.contextual-guide-target`)).toHaveCount(1);
  const heading=await (area==='evals'?page.locator(target+'.contextual-guide-target'):page.getByRole('heading',{name:'What should trigger this alert?',exact:true})).boundingBox();
  const workspace=await page.locator('.workspace').boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual(workspace!.y);
  expect(heading!.y+heading!.height).toBeLessThanOrEqual(workspace!.y+workspace!.height);
  await page.screenshot({ path: `.local/review-evidence/${area}-guidance-recovery-narrow.png` });
  await page.keyboard.press('Escape'); await expect(card).toBeFocused();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await card.click(); await expect(page.locator(`${target}.contextual-guide-target`)).toHaveCount(1);
  if (area === 'evals') {
    const created = page.waitForResponse(r => r.url().endsWith('/evaluations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create evaluation' }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Workflow review' })).toBeVisible();
    await expect(page.locator('.contextual-guide-note')).toHaveCount(0);
  } else {
    await page.goBack(); await expect(page).toHaveURL(`/demo/${s.id}/traces/${s.dataset.traces[0].id}`);
    await expect(page.locator('.contextual-guide-note')).toHaveCount(0);
  }
});

test('buyer-only evaluation omits optional checks and remains reviewable after reload', async ({ page }) => {
  const s = await start(page); await page.goto(`/demo/${s.id}/evals`);
  const sent = page.waitForRequest(r => r.url().endsWith('/evaluations') && r.method() === 'POST');
  const created = page.waitForResponse(r => r.url().endsWith('/evaluations') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create evaluation' }).click();
  expect((await sent).postDataJSON()).not.toHaveProperty('checks');
  const response = await created; expect(response.status()).toBe(201);
  const saved = await response.json(); expect(saved.evaluation.questions.length).toBeGreaterThan(0);
  expect(saved.evaluation.checks).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'Workflow review' })).toBeVisible();
  await page.getByRole('button', { name: 'Results', exact: true }).click();
  await expect(page.locator('.eval-results')).toContainText('No deterministic checks were selected');
  await page.reload(); await expect(page.locator('.eval-results')).toContainText('No deterministic checks were selected');
});

for (const reason of ['stale', 'missing'] as const) test(`alert guidance ${reason} recovery removes the shown claim and returns usable focus`, async ({ page }) => {
  const s = await start(page); await send(page, 'How does Neatlogs route alerts to the right people?');
  const card = page.getByRole('button', { name: /Preview alert routing/ }).last();
  await expect(card).toBeVisible(); await card.click();
  await expect(page.locator('.routing-create.contextual-guide-target')).toHaveCount(1);
  await page.getByRole('button', { name: 'Dismiss highlight' }).click();
  if (reason === 'stale') {
    await page.route(`**/api/sessions/${s.id}`, async route => {
      const response = await route.fetch(); const saved = await response.json(); saved.version++;
      await route.fulfill({ response, json: saved });
    });
  } else {
    await page.evaluate(() => {
      const remove = () => document.querySelectorAll('.routing-create').forEach(el => el.remove());
      new MutationObserver(remove).observe(document.body, { childList: true, subtree: true }); remove();
    });
  }
  await card.click();
  await expect(page.locator('.contextual-guide-note')).toContainText(reason === 'stale' ? 'no longer current' : 'unavailable');
  await expect(page.locator('.contextual-guide-note')).not.toContainText('Showing in your playground');
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(reason === 'stale' ? page.getByLabel('Ask anything') : card).toBeFocused();
  expect((await page.request.get('/api/session').then(r => r.json())).version).toBe(s.version);
});
