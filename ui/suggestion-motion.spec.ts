import { test, expect, type Page } from '@playwright/test';

const track = (page: Page) => page.locator('.entry-suggestions');
const questions = (page: Page) => track(page).locator('button');
const luminance = (rgb: string) => {
  const channels = rgb.match(/[\d.]+/g)!.slice(0, 3).map(value => {
    const channel = Number(value) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
};

async function openEntry(page: Page) {
  await page.clock.install();
  await page.goto('/entry');
  await expect(track(page).locator('.suggestion-row')).toHaveCount(3);
  await page.mouse.move(0, 0);
}

async function sampleMotion(page: Page, time: number) {
  return track(page).evaluate((target, currentTime) => {
    const rows = [...target.querySelectorAll<HTMLElement>('.suggestion-row')];
    // Hold a deliberate sample frame; this is separate from the natural video test.
    for (const row of rows) for (const animation of row.getAnimations()) { animation.pause(); animation.currentTime = currentTime; }
    return rows.map(row => {
      const style = getComputedStyle(row);
      return { transform: style.transform, shiftY: style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m42, opacity: Number(style.opacity), blur: Number(/blur\(([\d.]+)px\)/.exec(style.filter)?.[1] ?? 0), animations: row.getAnimations().length };
    });
  }, time);
}

async function expectRestingRows(page: Page) {
  await expect(track(page)).not.toHaveAttribute('data-rotating', /.+/);
  await expect.poll(() => track(page).evaluate(target => [...target.querySelectorAll<HTMLElement>('.suggestion-row')].every(row => {
    const style = getComputedStyle(row);
    const unshifted = style.transform === 'none' || (() => { const matrix = new DOMMatrixReadOnly(style.transform); return Math.abs(matrix.m41) < 0.01 && Math.abs(matrix.m42) < 0.01; })();
    return unshifted && Number(style.opacity) === 1 && /^(?:none|blur\(0px\))$/.test(style.filter) && row.getAnimations().length === 0;
  }))).toBe(true);
}

test('suggestion rows exit before text changes, then enter in the bounded masked viewport without sending', async ({ page }) => {
  let sends = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:browser-session\/demos|sessions\/[^/]+\/turns)(?:\?|$)/.test(request.url())) sends++; });
  await page.setViewportSize({ width: 980, height: 729 });
  await openEntry(page);
  await page.evaluate(() => document.fonts.ready);
  const typography = await questions(page).first().evaluate(button => {
    const style = getComputedStyle(button);
    return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, checked: document.fonts.check('13px "Instrument Sans"'), loaded: [...document.fonts].some(font => font.family.replaceAll(/["']/g, '') === 'Instrument Sans' && font.status === 'loaded') };
  });
  expect(typography.family).toContain('Instrument Sans');
  expect(typography.size).toBe('13px');
  expect(typography.lineHeight).toBe('20px');
  expect(typography.checked && typography.loaded).toBe(true);
  const pill = await page.locator('.tailor-attribution .tailor-pill').evaluate(element => { const style = getComputedStyle(element); return { color: style.color, background: style.backgroundColor }; });
  expect(pill.color).toBe('rgb(255, 255, 255)');
  expect(pill.background).toBe('rgb(29, 78, 137)');
  const light = luminance(pill.color), dark = luminance(pill.background);
  expect((Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)).toBeGreaterThanOrEqual(4.5);
  const first = await questions(page).allTextContents();
  await expectRestingRows(page);
  expect(await track(page).evaluate(target => target.getBoundingClientRect().height)).toBe(100);
  expect(await track(page).evaluate(target => getComputedStyle(target).maskImage)).not.toBe('none');
  await page.screenshot({ path: '.local/review-evidence/motion-after-980.png', fullPage: true });
  await page.clock.fastForward(8000);
  await expect(track(page)).toHaveAttribute('data-rotating', 'out');
  const outgoing = await sampleMotion(page, 120);
  expect(await questions(page).allTextContents()).toEqual(first);
  expect(outgoing.every(row => row.animations > 0 && row.shiftY < 0 && row.blur > 0 && row.opacity < 1)).toBe(true);
  await page.screenshot({ path: '.local/review-evidence/motion-after-980-exit.png', fullPage: true });
  await page.clock.runFor(330);
  await expect.poll(() => questions(page).allTextContents()).not.toEqual(first);
  await expect(track(page)).toHaveAttribute('data-rotating', 'in');
  const incoming = await sampleMotion(page, 150);
  expect(incoming.every(row => row.animations > 0 && row.shiftY > 0 && row.blur > 0 && row.opacity < 1)).toBe(true);
  await page.screenshot({ path: '.local/review-evidence/motion-after-980-enter.png', fullPage: true });
  await page.clock.runFor(600);
  await expectRestingRows(page);
  const second = await questions(page).allTextContents();
  expect(new Set([...first, ...second]).size).toBe(6);
  await expect(questions(page)).toHaveCount(3);
  await expect(page).toHaveURL(/\/entry$/);
  await expect(page.getByLabel('Ask anything')).toHaveValue('');
  expect(sends).toBe(0);
});

for (const interruption of ['hover', 'focus'] as const) {
  test(`${interruption} during exit cancels replacement and returns every row to clear text`, async ({ page }) => {
    await openEntry(page);
    const first = await questions(page).allTextContents();
    await page.clock.fastForward(8000);
    await expect(track(page)).toHaveAttribute('data-rotating', 'out');
    expect((await sampleMotion(page, 100)).some(row => row.opacity < 1)).toBe(true);
    if (interruption === 'hover') await page.locator('.chat-stage').hover({ position: { x: 10, y: 10 } });
    else await page.getByLabel('Ask anything').focus();
    await expectRestingRows(page);
    await page.clock.runFor(900);
    expect(await questions(page).allTextContents()).toEqual(first);
    await page.clock.fastForward(8100);
    await expectRestingRows(page);
    expect(await questions(page).allTextContents()).toEqual(first);
    await expect(page).toHaveURL(/\/entry$/);
  });
}

test('reduced motion does not animate or replace suggestion rows', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openEntry(page);
  const first = await questions(page).allTextContents();
  await page.clock.fastForward(20000);
  await page.clock.runFor(900);
  await expectRestingRows(page);
  expect(await questions(page).allTextContents()).toEqual(first);
  await expect(page).toHaveURL(/\/entry$/);
});

test('changing to reduced motion during exit cancels blur and preserves the displayed questions', async ({ page }) => {
  await openEntry(page);
  const first = await questions(page).allTextContents();
  await page.clock.fastForward(8000);
  await expect(track(page)).toHaveAttribute('data-rotating', 'out');
  expect((await sampleMotion(page, 100)).some(row => row.blur > 0)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectRestingRows(page);
  await page.clock.runFor(900);
  expect(await questions(page).allTextContents()).toEqual(first);
  await page.clock.fastForward(16000);
  await expectRestingRows(page);
  expect(await questions(page).allTextContents()).toEqual(first);
});

test('a touch hold cancels exit until release, then a tap fills the stable prompt without sending', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    let sends = 0;
    page.on('request', request => { if (request.method() === 'POST') sends++; });
    await openEntry(page);
    const first = await questions(page).allTextContents();
    await page.clock.fastForward(8000);
    await expect(track(page)).toHaveAttribute('data-rotating', 'out');
    await page.locator('.chat-stage').evaluate(stage => stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true })));
    await expectRestingRows(page);
    await page.clock.runFor(8500);
    expect(await questions(page).allTextContents()).toEqual(first);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true })));
    await page.clock.fastForward(8100);
    await page.clock.runFor(900);
    await expect.poll(() => questions(page).allTextContents()).not.toEqual(first);
    await expectRestingRows(page);
    const prompt = await questions(page).first().getAttribute('data-example');
    await questions(page).first().tap();
    await expect(page.getByLabel('Ask anything')).toHaveValue(prompt!);
    await expect(page.getByLabel('Ask anything')).toBeFocused();
    await expect(page).toHaveURL(/\/entry$/);
    expect(sends).toBe(0);
  } finally { await context.close(); }
});

test('captures mobile entry and one natural desktop motion cycle', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/entry');
  await expect(questions(page)).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: '.local/review-evidence/motion-after-390.png', fullPage: true });
  const context = await browser.newContext({ baseURL, reducedMotion: 'no-preference', viewport: { width: 980, height: 729 }, recordVideo: { dir: '.local/review-evidence/motion-video', size: { width: 980, height: 729 } } });
  const natural = await context.newPage();
  const video = natural.video()!;
  try {
    await natural.goto('/entry');
    await natural.mouse.move(0, 0);
    await expect(questions(natural)).toHaveCount(3);
    await natural.evaluate(() => document.fonts.ready);
    const first = await questions(natural).allTextContents();
    // No installed clock or animation seeking in this context: record actual timing.
    await expect.poll(() => track(natural).getAttribute('data-rotating'), { timeout: 11000, intervals: [50] }).toBe('out');
    await expect.poll(() => track(natural).getAttribute('data-rotating'), { timeout: 2000, intervals: [25] }).toBe('in');
    await expectRestingRows(natural);
    expect(await questions(natural).allTextContents()).not.toEqual(first);
  } finally { await context.close(); }
  await video.saveAs('.local/review-evidence/motion-natural.webm');
});
