import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.goto('/assets/guided-preview.html');
  await expect(page.getByText('Scripted design preview')).toBeVisible();
});

test('suggestions reveal one target, repeat safely, dismiss with focus, and allow navigation', async ({ page }) => {
  const lookup = page.locator('#suggest-lookup');
  await expect(page.locator('.suggestion:visible')).toHaveCount(2);
  await lookup.click();
  await expect(page.locator('#lookup-target')).toHaveClass(/guide-target/);
  await expect(page.locator('#step-details')).toBeVisible();
  await expect(page.locator('#guide-note')).toContainText('timing alone doesn’t identify the cause');
  await lookup.click();
  await expect(page.locator('.guide-target')).toHaveCount(1);
  await page.locator('#dismiss-guide').click();
  await expect(lookup).toBeFocused();
  await expect(page.locator('.guide-target')).toHaveCount(0);
  await expect(page.locator('#guide-note')).toBeHidden();
  await page.locator('#suggest-output').click();
  await expect(page.locator('#output-target')).toHaveClass(/guide-target/);
  await expect(page.locator('#lookup-target')).not.toHaveClass(/guide-target/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#suggest-output')).toBeFocused();
  await page.locator('#suggest-output').click();
  await page.locator('#tab-overview').click();
  await expect(page.locator('#guide-note')).toBeHidden();
  await expect(page.locator('.guide-target')).toHaveCount(0);
  await page.locator('#back-traces').click();
  await expect(page.locator('#trace-list')).toBeVisible();
  await page.locator('#open-trace').click();
  await expect(page.locator('#trace-detail')).toBeVisible();
  await expect(page.locator('.preview-chat')).toBeVisible();
});

test('scripted answers offer only relevant suggestions', async ({ page }) => {
  await page.locator('#question-output').click();
  await expect(page.locator('.suggestion:visible')).toHaveCount(1);
  await expect(page.locator('#suggest-output')).toBeVisible();
  await expect(page.locator('#suggest-lookup')).toBeHidden();
  await page.locator('#question-slow').click();
  await expect(page.locator('.suggestion:visible')).toHaveCount(2);
  await expect(page.locator('.attribution')).toContainText('Powered by Tailor');
  await expect(page.locator('.attribution')).toContainText('No live AI');
});

test('a removed target recovers to the current trace list without a broken highlight', async ({ page }) => {
  await page.locator('#suggest-lookup').click();
  await page.locator('#remove-lookup').click();
  await expect(page.locator('#guide-note')).toContainText('no longer available');
  await expect(page.locator('.guide-target')).toHaveCount(0);
  await expect(page.locator('#lookup-target')).toBeHidden();
  await expect(page.locator('#step-details')).toBeHidden();
  await page.locator('#recover-guide').click();
  await expect(page.locator('#trace-list')).toBeVisible();
  await expect(page.locator('#open-trace')).toBeFocused();
  await expect(page.locator('#guide-note')).toBeHidden();
});

test('a scenario change invalidates old suggestions and refreshes grounded guidance', async ({ page }) => {
  await page.locator('#suggest-lookup').click();
  await page.locator('#change-scenario').click();
  await expect(page.locator('#scenario-notice')).toBeVisible();
  await expect(page.locator('.guide-target')).toHaveCount(0);
  await page.locator('#suggest-lookup').click();
  await expect(page.locator('#guide-note')).toContainText('earlier request');
  await expect(page.locator('#trace-list')).toBeVisible();
  await page.locator('#recover-guide').click();
  await expect(page.locator('#scenario-notice')).toBeHidden();
  await expect(page.locator('#answer-copy')).toContainText('0.64 s');
  await expect(page.locator('.suggestion:visible')).toHaveCount(1);
  await expect(page.locator('#suggest-output')).toBeFocused();
  await page.locator('#open-trace').click();
  await expect(page.locator('.timeline-row').first()).toContainText('0.64 s');
});

test('desktop and narrow target plus chat layouts fit and provide review screenshots', async ({ page }) => {
  await mkdir('docs/guided-preview', { recursive: true });
  for (const [width, height, name] of [[1440, 900, 'desktop'], [390, 844, 'narrow']] as const) {
    await page.setViewportSize({ width, height });
    await page.locator('#suggest-lookup').click();
    await expect(page.locator('#lookup-target')).toBeVisible();
    await expect(page.locator('.preview-chat')).toBeVisible();
    await expect(page.locator('#guide-note')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const workspace = await page.locator('.preview-main').boundingBox();
    const chat = await page.locator('.preview-chat').boundingBox();
    expect(workspace!.width).toBeGreaterThan(0);
    expect(chat!.width).toBeGreaterThan(0);
    if (name === 'narrow') expect(workspace!.y + workspace!.height).toBeLessThanOrEqual(chat!.y + 1);
    await page.locator('#guide-note').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `docs/guided-preview/${name}.png`, fullPage: true });
    await page.locator('#dismiss-guide').click();
    await expect(page.locator('#suggest-lookup')).toBeFocused();
  }
});
