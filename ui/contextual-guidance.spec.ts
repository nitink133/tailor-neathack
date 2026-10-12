import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { DemoSession } from '../src/contracts.ts';

const evidenceDir = 'docs/contextual-guidance';
const send = async (page: Page, text: string) => { await page.getByLabel('Ask anything').fill(text); await page.getByRole('button', { name: 'Send message' }).click(); };
async function start(page: Page): Promise<DemoSession> {
  await page.goto('/entry');
  await page.getByLabel('Ask anything').fill('I am building a travel-booking agent. Show a booking API timeout followed by a successful retry.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForURL(/\/demo\/[^/]+\/traces$/);
  await expect(page.locator('.chat-panel [data-status=applied]').first()).toBeVisible({ timeout: 15000 });
  return page.request.get('/api/session').then(r => r.json());
}

test('contextual guidance: cards reveal one current area, survive reload, repeat safely and dismiss with focus', async ({ page }) => {
  const s = await start(page);
  const cards = page.locator('.contextual-suggestion');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeLessThanOrEqual(3);
  const version = s.version;
  await cards.first().click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await expect(page.locator('.contextual-guide-note')).toContainText('Showing in your playground');
  await expect(page.locator('.chat-panel')).toBeVisible();
  await cards.first().click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await page.getByRole('button', { name: 'Dismiss highlight' }).click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await expect(cards.first()).toBeFocused();
  await page.reload();
  await expect(cards.first()).toBeVisible();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await cards.first().click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  expect((await page.request.get('/api/session').then(r => r.json())).version).toBe(version);
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator('.chat-panel')).toBeVisible();
  await page.locator('.contextual-suggestion').first().click();
  await expect(page.locator('.contextual-guide-note')).toContainText('Showing in your playground');
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await page.screenshot({ path: `${evidenceDir}/narrow.png` });
});

test('contextual guidance: manual navigation and changed scenarios clear the old highlight', async ({ page }) => {
  const s = await start(page);
  await page.locator('.contextual-suggestion').first().click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await page.goto(`/demo/${s.id}/traces`);
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await page.locator('.contextual-suggestion').first().click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await send(page, 'Make the retry fail too.');
  await expect(page.locator('.demo-notice')).toContainText('v3');
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  const oldCards = page.locator('.chat-turn.is-tailor').filter({ hasText: 'Saved and verified as version 2' }).locator('.contextual-suggestion');
  if (await oldCards.count()) await expect(oldCards.first()).toBeDisabled();
});

test('contextual guidance: absent current target reports recovery without claiming it showed', async ({ page }) => {
  await start(page);
  // Use a genuine saved suggestion, then remove its rendered target after navigation has completed.
  const card = page.locator('.contextual-suggestion').first();
  await card.click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await page.getByRole('button', { name: 'Dismiss highlight' }).click();
  await page.evaluate(() => {
    const remove = () => document.querySelectorAll('.steps').forEach(el => el.remove());
    new MutationObserver(remove).observe(document.body, { childList: true, subtree: true });
    remove();
  });
  await card.click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await expect(page.locator('.contextual-guide-note')).toContainText(/unavailable|no longer current/);
  await expect(page.locator('.contextual-guide-note')).not.toContainText('Showing in your playground');
});

test('contextual guidance: rerender preserves a target, explicit collapse removes the shown claim', async ({ page }) => {
  await start(page);
  await send(page, 'Explain this trace and its timing.');
  const card = page.getByRole('button', { name: /Inspect the slowest step/ });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await page.getByRole('button', { name: 'Toggle local theme' }).click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(1);
  await page.locator('[data-root]').first().click();
  await expect(page.locator('.contextual-guide-target')).toHaveCount(0);
  await expect(page.locator('.contextual-guide-note')).toContainText('Suggestion unavailable');
  await expect(page.locator('.contextual-guide-note')).not.toContainText('Showing in your playground');
  await page.keyboard.press('Escape');
  await expect(card).toBeFocused();
});
