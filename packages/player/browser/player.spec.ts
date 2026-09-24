import { expect, test } from '@playwright/test';

test('plays the fixture with keyboard-accessible controls and a scoped author theme', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Window & { audioPlayCount: number }).audioPlayCount = 0; HTMLMediaElement.prototype.play = function() { (window as unknown as Window & { audioPlayCount: number }).audioPlayCount += 1; return Promise.resolve(); }; });
  await page.goto('http://127.0.0.1:4181');
  await expect(page.getByRole('heading', { name: 'The Lantern at Dusk' })).toBeVisible();
  await expect(page.getByText('Rain taps the stone. <script>window.compromised = true</script>')).toBeVisible();
  await expect(page.locator('.ds-player__content script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { compromised?: boolean }).compromised)).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'Mira' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  await expect(page.getByLabel('Game time: 00:02')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Tavern lantern' })).toBeVisible();
  await expect(page.locator('audio[controls]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter cellar' })).toBeVisible();
  await expect(page.getByLabel('Type an action')).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible();
  await page.locator('.ds-player__settings select').selectOption('fr-FR');
  await expect(page.getByTestId('selected-locale')).toHaveText('fr-FR');
  await page.getByLabel('Enable typing sounds').uncheck();
  await page.getByLabel('Type an action').focus();
  await page.keyboard.press('a');
  expect(await page.evaluate(() => (window as unknown as Window & { audioPlayCount: number }).audioPlayCount)).toBe(0);
  await page.getByLabel('Enable typing sounds').check();
  await page.getByLabel('Type an action').focus();
  await page.keyboard.press('b');
  expect(await page.evaluate(() => (window as unknown as Window & { audioPlayCount: number }).audioPlayCount)).toBe(1);
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Close settings' }).focus();
  await page.keyboard.press('Enter');

  await page.getByRole('button', { name: 'Enter cellar' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('last-player-input')).toHaveText('{"kind":"choice","actionId":"enter-cellar"}');
  await page.getByRole('button', { name: 'Ask about the rain' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('last-player-input')).toHaveText('{"kind":"dialogue-option","conversationId":"mira-story","lineId":"mira-first","optionId":"ask-about-rain"}');

  await page.getByLabel('Type an action').fill('count candles 3');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('last-player-input')).toHaveText('{"kind":"command-text","rawText":"count candles 3"}');
  await expect(page.locator('.ds-player__scene')).toHaveCSS('border-top-width', '1px');
  await expect(page.getByRole('button', { name: 'Load game' })).toBeVisible();
});

test('rejects remote theme loads and keeps controls available', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('http://127.0.0.1:4181/?unsafe');
  await expect(page.getByRole('status')).toHaveText('Custom theme blocked because it can load external resources or is too large.');
  await expect(page.getByRole('button', { name: 'Enter cellar' })).toBeEnabled();
  expect(requests.some(url => url.includes('example.invalid'))).toBe(false);
});


test('keeps interactive controls visible under a hiding author theme', async ({ page }) => {
  await page.goto('http://127.0.0.1:4181/?aggressive');
  await expect(page.locator('.ds-player__notice')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter cellar' })).toBeVisible();
  await expect(page.getByLabel('Type an action')).toBeVisible();
});


test('shows successful scripted effects and preserves host state after a broken script', async ({ page }) => {
  await page.goto('http://127.0.0.1:4181');
  await page.getByRole('button', { name: 'Ask for the silver song' }).click();
  await expect(page.getByTestId('host-trust')).toHaveText('1');
  await expect(page.getByTestId('snapshot-updates')).toHaveText('1');
  await page.getByText('Recent action trace').click();
  await expect(page.getByText('Script trust-effect changed world.trust from 0 to 1.')).toBeVisible();

  await page.getByRole('button', { name: 'Cast the unstable spell' }).click();
  await expect(page.getByRole('alert', { name: 'Action diagnostics' })).toContainText('Script execution failed: unsupported runtime value.');
  await expect(page.getByRole('alert', { name: 'Action diagnostics' })).toContainText('Node: old-gate · Script: broken-script · scripts/broken.js:4:7');
  await expect(page.getByTestId('host-trust')).toHaveText('1');
  await expect(page.getByTestId('snapshot-updates')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Cast the unstable spell' })).toBeVisible();
});


test('does not render partial play when session creation has diagnostics only', async ({ page }) => {
  await page.goto('http://127.0.0.1:4181/?startup-failure');
  await expect(page.getByRole('heading', { name: 'Game could not be started' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Compiled script bundle is missing a required script.');
  await expect(page.getByRole('heading', { name: 'The Lantern at Dusk' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enter cellar' })).toHaveCount(0);
});
