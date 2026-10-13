import { expect, test } from '@playwright/test';

async function startProject(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('dialog', { name: 'Find your way around the studio' }).getByRole('button', { name: 'Not now' }).click();
}

async function expectInViewport(locator: import('@playwright/test').Locator, width: number, height: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`UX gate: home, Inspector help, and expanded workspace fit ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expectInViewport(page.locator('.home-intro h1'), viewport.width, viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('dialog', { name: 'Find your way around the studio' }).getByRole('button', { name: 'Not now' }).click();
    const inspector = page.getByLabel('Story inspector');
    await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
    const help = inspector.getByRole('button', { name: 'Help: Translations' });
    await help.hover();
    await expectInViewport(page.getByRole('tooltip'), viewport.width, viewport.height);
    await inspector.getByRole('button', { name: 'Workspace full screen' }).click();
    await expect(page.getByLabel('Apprentice node graph')).toBeVisible();
    await expect(inspector).toBeVisible();
    await expectInViewport(page.locator('.apprentice-workbench'), viewport.width, viewport.height);
    await page.keyboard.press('Escape');
    await expect(inspector.getByRole('button', { name: 'Workspace full screen' })).toBeVisible();
  });
}

test('UX gate: list shortcuts act on focused lists and preserve text-field editing', async ({ page }) => {
  await startProject(page);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
  const translations = inspector.getByRole('region', { name: 'Translations' });
  const search = translations.getByRole('searchbox', { name: 'Find a key' });
  await search.fill('gate-title');
  await search.press('ControlOrMeta+a');
  await search.press('Backspace');
  await expect(search).toHaveValue('');
  await expect(translations.getByLabel('Selected translation keys')).toHaveCount(0);
  await expect(translations.getByLabel('Translation keys').getByRole('button', { name: /gate-title/ })).toBeVisible();
});
