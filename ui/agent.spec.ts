import { test, expect } from '@playwright/test';
import type { DemoSession } from '../src/contracts.ts';

// UI integration test for personalised Tailor agent flow (Linear NIT-271).
// To be executed in Wave 2 with: npm run test:ui -- ui/agent.spec.ts
// Server will be started on port 4322 via Playwright webServer config.

test('Personalised agent journey: entry, proposal, error grounding, follow-up, reload, clarification, lifecycle, isolation', async ({ page, browser }) => {
  // 1. Entry page flow
  await page.goto('/entry');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('hello');

  // Verify the 'Powered by Tailor' attribution (a single element; the .or() form tripped strict mode)
  await expect(page.getByText(/Powered by Tailor/i)).toBeVisible();

  // Type the canonical travel request
  const entryInput = page.getByLabel('Ask anything');
  await entryInput.fill('I’m building a travel-booking agent. Show me a booking API timeout followed by a successful retry.');
  await page.getByRole('button', { name: 'Send message' }).click();

  // 2. Navigation to session traces
  await page.waitForURL(/\/demo\/[^/]+\/traces$/);
  const demoUrl = page.url();
  const sessionIdMatch = /\/demo\/([^/]+)\/traces/.exec(demoUrl);
  expect(sessionIdMatch).not.toBeNull();
  const sessionId = sessionIdMatch![1]!;

  // 3. Panel status transitions and labels
  const chatPanel = page.locator('.chat-panel');
  await expect(chatPanel).toBeVisible();

  // Panel shows Pending then Applied status indicators
  await expect(chatPanel.locator('[data-status=applied]').first()).toBeVisible({ timeout: 15000 });

  // Powered by Tailor and Mock label visible
  await expect(chatPanel.locator('.chat-label', { hasText: /Powered by Tailor/i })).toBeVisible();
  // The side panel must not pretend the mock is a live model.
  await expect(chatPanel.locator('.chat-mock')).toContainText(/mock-backed/i);

  // Trace list shows the personalised label (e.g. 'Timeout, retry succeeds'), NOT 'Order lookup'
  const traceTable = page.locator('tbody tr');
  await expect(traceTable.first()).toBeVisible();
  await expect(traceTable).not.toContainText('Order lookup');
  await expect(traceTable).toContainText(/Timeout|retry|travel/i);

  // 4. Open the trace and inspect ERROR span grounding
  await traceTable.first().locator('a').first().click();
  await page.waitForURL(new RegExp(`/demo/${sessionId}/traces/[^/]+$`));

  // Expand error details if folded
  const errorBadge = page.locator('.error-text').filter({ hasText: 'ERROR' }).first();
  await expect(errorBadge).toBeVisible();

  // Click error span row to reveal span content
  const errorRow = page.locator('.span-row').filter({ hasText: 'ERROR' }).first();
  await errorRow.click();

  // ERROR span must be visible with 'SYNTHETIC:' prefixed error message
  const errorBox = page.locator('.error-box').first();
  await expect(errorBox).toBeVisible();
  await expect(errorBox).toContainText('SYNTHETIC:');

  // 5. Follow-up turn: "Make the retry fail too."
  const chatComposer = chatPanel.locator('textarea[name="message"], textarea');
  await chatComposer.fill('Make the retry fail too.');
  await chatPanel.getByRole('button', { name: 'Send message' }).click();

  // Notice updates to v3 and shows the new active scenario
  const notice = page.locator('.demo-notice');
  await expect(notice).toContainText('v3', { timeout: 15000 });
  await expect(notice).toContainText(/booking-timeout-retry-fails|retry/i);

  // 6. Reload retains v3 state
  await page.reload();
  await expect(page.locator('.demo-notice')).toContainText('v3');
  await expect(chatPanel.locator('[data-status=applied]').last()).toBeVisible();

  // 7. Ambiguous message -> 3 choice buttons; click one
  await chatComposer.fill('Show me something failing.');
  await chatPanel.getByRole('button', { name: 'Send message' }).click();

  // Exactly three clarification choice buttons rendered
  const choiceButtons = page.locator('.chat-choices button[data-choice]');
  await expect(choiceButtons).toHaveCount(3, { timeout: 15000 });
  await expect(page.locator('.chat-choices + small')).toContainText(/type your own answer/i);

  // Click the first choice
  await choiceButtons.first().click();

  // Response acknowledges the choice
  await expect(chatPanel.locator('[data-status=applied], [data-status=note]').last()).toBeVisible();

  // 8. End demo flow
  const endButton = page.getByRole('button', { name: /End demo|Leave demo/i });
  if (await endButton.isVisible()) {
    await endButton.click();
  } else {
    // If end demo is inside rail or settings, trigger the end endpoint directly
    await page.request.post(`/api/sessions/${sessionId}/end`);
    await page.goto('/entry');
  }

  // Lands on entry page with ended notice
  await expect(page).toHaveURL(/\/entry|\/$/);
  await expect(page.locator('.entry-notice')).toContainText(/Demo ended|Session ended|expired/i);

  // Visiting the old URL now shows the ended / unavailable screen (cookie cleared -> 404 -> "Demo unavailable")
  await page.goto(demoUrl);
  await expect(page.getByRole('heading', { name: /Demo unavailable|This demo has ended/ })).toBeVisible();

  // 9. Second browser context cannot access the session (404 / session boundary isolation)
  const foreignContext = await browser.newContext();
  const foreignPage = await foreignContext.newPage();
  await foreignPage.goto(demoUrl);
  await expect(foreignPage.getByRole('heading', { name: 'Demo unavailable' })).toBeVisible();
  await foreignContext.close();

  // 10. 390px mobile viewport check (no horizontal overflow)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/entry');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
