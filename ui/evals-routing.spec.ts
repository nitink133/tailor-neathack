import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { DemoSession } from '../src/contracts.ts';

const evidence = process.env.TAILOR_SCREENSHOT_DIR ?? 'test-results/evidence';
mkdirSync(evidence, { recursive: true });
async function build(page: Page, prompt: string): Promise<DemoSession> {
  await page.goto('/entry');
  await page.getByLabel('Ask anything').fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.chat-panel [data-status=applied]').last()).toBeVisible();
  return await (await page.request.get('/api/session')).json();
}

test('buyer creates and reviews real local checks, keeps results across navigation, and cannot share another browser’s demo', async ({ page, browser }) => {
  const s = await build(page, 'Show a documentation retrieval agent that invents an unsupported answer absent from the source.');
  await page.goto(`/demo/${s.id}/evals`);
  await expect(page.getByRole('heading', { name: 'Evals', exact: true })).toBeVisible();
  await page.locator('input[name=name]').fill('Source grounded answer review');
  await page.getByRole('checkbox', { name: 'No execution errors', exact: true }).check();
  await page.locator('input[name=check-latency]').check();
  await page.locator('input[name=check-max-ms]').fill('200');
  await page.locator('input[name=check-fields]').check();
  await page.locator('input[name=check-fields-list]').fill('answer, citations');
  await page.getByRole('button', { name: 'Create evaluation' }).click();
  await expect(page.getByRole('heading', { name: 'Source grounded answer review' })).toBeVisible();
  const detailUrl = page.url();
  await page.getByRole('button', { name: 'Results', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Executed sample checks' })).toBeVisible();
  await expect(page.locator('.eval-results')).toContainText('does not prove answer quality');
  const response = await page.request.get(`/api/sessions/${s.id}/evaluations`);
  const e = (await response.json()).evaluations[0].evaluation;
  expect(e.checkResults).toHaveLength(3);
  expect(e.checkResults.every((r: { passed: boolean }) => r.passed)).toBe(true);
  await page.getByRole('button', { name: 'Questions', exact: true }).click();
  await page.getByLabel(`How useful and accurate is the answer? for ${s.dataset.traces[0]!.id}`).fill('1');
  await page.getByLabel(`What should change? for ${s.dataset.traces[0]!.id}`).fill('The answer claims offline support that the source does not establish.');
  await page.getByRole('button', { name: 'Save review' }).click();
  await expect(page.locator('.eval-results')).toContainText('The answer claims offline support');
  await expect(page.locator('.eval-results')).toContainText('Simulated score — no AI evaluator ran');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Results', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.eval-results')).toContainText('The answer claims offline support');
  await page.getByRole('link', { name: '← Evals', exact: true }).click();
  await expect(page.locator('.eval-list')).toContainText('Source grounded answer review');
  await page.goBack();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.locator('.eval-results')).toContainText('The answer claims offline support');
  await page.screenshot({ path: `${evidence}/evals-executed-review-desktop.png`, fullPage: true });
  const secondTab = await page.context().newPage();
  await secondTab.goto(detailUrl);
  await expect(secondTab.getByRole('heading', { name: 'Source grounded answer review' })).toBeVisible();
  await secondTab.getByRole('button', { name: 'Results', exact: true }).click();
  await expect(secondTab.locator('.eval-results')).toContainText('The answer claims offline support');
  await secondTab.close();
  const stranger = await browser.newContext(); const other = await stranger.newPage();
  await other.goto(detailUrl);
  await expect(other.getByRole('heading', { name: 'Demo unavailable' })).toBeVisible();
  expect((await other.request.get(`/api/sessions/${s.id}/evaluations/${e.id}`)).status()).toBe(404);
  await stranger.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidence}/evals-executed-review-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('buyer questions guide to adapter-owned eval and alert areas without changing traces', async ({ page }) => {
  const s = await build(page, 'Show a customer support agent with a polite answer that does not resolve the request.');
  for (const [prompt, label, path, target] of [
    ['How do Neatlogs evals fit this agent and how can I know they work?', 'Explore evals for this agent', 'evals', '.eval-create'],
    ['How does Neatlogs route alerts to the right people?', 'Preview alert routing', 'alerts', '.routing-create'],
  ]) {
    await page.getByLabel('Ask anything').fill(prompt);
    const completed = page.waitForResponse(r => r.url().includes(`/api/sessions/${s.id}/turns`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send message' }).click();
    expect((await completed).status()).toBe(200);
    const card = page.getByRole('button', { name: new RegExp(label) }).last();
    await expect(card).toBeVisible(); await card.click();
    await expect(page).toHaveURL(`/demo/${s.id}/${path}`);
    await expect(page.locator(`${target}.contextual-guide-target`)).toHaveCount(1);
    await expect(page.locator('.contextual-guide-note')).toContainText('Showing in your playground');
    expect((await (await page.request.get('/api/session')).json()).version).toBe(s.version);
    await page.getByRole('button', { name: 'Dismiss highlight' }).click();
    await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'What should trigger this alert?' })).toBeVisible();
  await page.screenshot({ path: `${evidence}/routing-guidance-desktop.png`, fullPage: true });
});

test('invalid check configuration keeps the buyer on creation without publishing an evaluation', async ({ page }) => {
  const s = await build(page, 'Show an invoice extraction agent that misses the due date.');
  await page.goto(`/demo/${s.id}/evals`);
  await page.locator('input[name=check-fields]').check();
  await page.getByRole('button', { name: 'Create evaluation' }).click();
  await expect(page).toHaveURL(`/demo/${s.id}/evals`);
  await expect(page.locator('body')).toContainText('Select 1–8 top-level output fields.');
  expect((await (await page.request.get(`/api/sessions/${s.id}/evaluations`)).json()).evaluations).toHaveLength(0);
  await page.locator('input[name=check-fields-list]').fill('dueDate');
  await page.getByRole('button', { name: 'Create evaluation' }).click();
  await page.getByRole('button', { name: 'Results', exact: true }).click();
  await expect(page.locator('.eval-results')).toContainText('dueDate');
  const e = (await (await page.request.get(`/api/sessions/${s.id}/evaluations`)).json()).evaluations[0].evaluation;
  expect(e.checkResults[0].passed).toBe(false);
  await page.screenshot({ path: `${evidence}/evals-missing-field-desktop.png`, fullPage: true });
});

test('routing wizard previews a fictional owner with trace context and keeps the saved preview scoped', async ({ page, browser }) => {
  const s = await build(page, 'Show an inventory agent where an API timeout is followed by a failed retry.');
  await page.goto(`/demo/${s.id}/alerts`);
  await expect(page.getByRole('heading', { name: 'What should trigger this alert?' })).toBeVisible();
  await page.locator('select[name=type]').selectOption('per_event');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which signals should we match?' })).toBeVisible();
  await expect(page.locator('.routing-create')).toContainText('Successful retries can still contain an error signal');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Inventory timeout ownership');
  await page.locator('select[name=severity]').selectOption('critical');
  await page.getByLabel('Cooldown (ms)', { exact: true }).fill('1000');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.locator('select[name=recipient]').selectOption('Engineering on-call');
  await page.locator('select[name=destination]').selectOption('slack');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm synthetic preview' })).toBeVisible();
  await expect(page.locator('.routing-create')).toContainText('Engineering on-call via slack');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('select[name=destination]')).toHaveValue('slack');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Save simulated preview' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory timeout ownership' })).toBeVisible();
  await expect(page.locator('.routing-create')).toContainText('Simulated delivery preview · no notification sent');
  await expect(page.getByRole('heading', { name: 'Action context' })).toBeVisible();
  const detailUrl = page.url();
  const list = await (await page.request.get(`/api/sessions/${s.id}/routing`)).json();
  const p = list.previews[0].preview;
  expect(p.recipient).toBe('Engineering on-call'); expect(p.destination).toBe('slack');
  expect(p.delivery).toBe('simulated'); expect(p.matches.length).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('.routing-create')).toContainText('Inventory timeout ownership');
  await page.getByRole('link', { name: '← Alerts', exact: true }).click();
  await expect(page.locator('.eval-list')).toContainText('Inventory timeout ownership');
  await page.goBack(); await expect(page).toHaveURL(detailUrl);
  await expect(page.locator('.routing-create')).toContainText('no notification sent');
  await page.screenshot({ path: `${evidence}/routing-simulated-owner-desktop.png`, fullPage: true });
  const stranger = await browser.newContext(); const other = await stranger.newPage();
  await other.goto(detailUrl); await expect(other.getByRole('heading', { name: 'Demo unavailable' })).toBeVisible();
  expect((await other.request.get(`/api/sessions/${s.id}/routing/${p.id}`)).status()).toBe(404);
  await stranger.close();
});
