import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync, zipSync } from 'fflate';

async function tavernZip(variant?: 'script' | 'validation' | 'fallback' | 'theme' | 'unsafe-theme'): Promise<Buffer> {
  const root = resolve('fixtures/tavern-at-dusk');
  const entries: Record<string, Uint8Array> = {};
  async function addDirectory(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await addDirectory(path);
      else if (entry.name !== 'README.md' && !path.includes('/saves/')) {
        const archivePath = path.slice(root.length + 1);
        const bytes = new Uint8Array(await readFile(path));
        let contents = bytes;
        if (variant === 'script' && archivePath === 'scripts/keeper.js') contents = new TextEncoder().encode('function main( { invalid syntax');
        if (variant === 'validation' && archivePath === 'world.json') contents = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), entryNodeId: 'Bad Node' }));
        if ((variant === 'theme' || variant === 'unsafe-theme') && archivePath === 'world.json') {
          const world = JSON.parse(new TextDecoder().decode(bytes));
          world.settings.playerStylePath = 'styles/player.css';
          contents = new TextEncoder().encode(JSON.stringify(world));
        }
        if (variant === 'fallback' && archivePath === 'locales/ja-JP.json') {
          const locale = JSON.parse(new TextDecoder().decode(bytes));
          delete locale.strings['taproom-title'];
          contents = new TextEncoder().encode(JSON.stringify(locale));
        }
        entries[archivePath] = contents;
      }
    }
  }
  await addDirectory(root);
  if (variant === 'theme' || variant === 'unsafe-theme') {
    entries['styles/player.css'] = new TextEncoder().encode(variant === 'theme' ? '.ds-player { color: #211; }' : '@import url(https://example.invalid/theme.css);');
  }
  return Buffer.from(zipSync(entries));
}

async function openExportDialog(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Export game ZIP' }).click();
  const acknowledge = page.getByRole('button', { name: 'Acknowledge and continue' });
  if (await acknowledge.isVisible().catch(() => false)) await acknowledge.click();
  await expect(page.getByRole('button', { name: 'Build and download' })).toBeVisible();
}

async function acknowledgeWarnings(page: import('@playwright/test').Page): Promise<void> {
  const acknowledge = page.getByRole('button', { name: 'Acknowledge and continue' });
  if (await acknowledge.isVisible().catch(() => false)) await acknowledge.click();
}

test('create, edit in Sage and Apprentice, reload offline, and round-trip a project ZIP', async ({ page, context }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('The Lantern Crossing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Playtest' }).click();
  await acknowledgeWarnings(page);
  await expect(page.getByRole('heading', { name: 'Sandboxed playtest' })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await expect(page.getByRole('heading', { name: 'The Lantern Crossing' })).toBeVisible();
  await page.getByRole('button', { name: 'Sage' }).click();

  await page.getByRole('button', { name: 'Apprentice' }).click();
  await page.getByRole('button', { name: 'Add scene' }).click();
  await expect(page.getByText('Scene: New scene')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Apprentice changes saved to the project.');

  await page.getByRole('button', { name: 'Sage' }).click();
  await expect(page.getByRole('status')).toContainText('Sage Mode is using the current project snapshot.');
  await page.getByRole('button', { name: 'world.json', exact: true }).click();
  await page.getByLabel('New path').fill('notes.txt');
  await page.getByRole('button', { name: 'New file' }).click();
  await page.locator('.cm-content').fill('Cross-mode note');
  await expect(page.locator('.cm-content')).toContainText('Cross-mode note');

  await expect(page.getByRole('status').filter({ hasText: 'Recovery copy saved locally' })).toBeVisible({ timeout: 10_000 });
  const zipReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const zip = await zipReady;
  const zipPath = await zip.path();
  expect(zipPath).not.toBeNull();
  const files = unzipSync(new Uint8Array(await readFile(zipPath!)));
  const savedWorld = JSON.parse(strFromU8(files['world.json']!)) as { nodes: { title: { text?: string } }[] };
  expect(savedWorld.nodes.some(node => node.title.text === 'New scene')).toBe(true);

  await page.getByRole('button', { name: 'Projects' }).click();
  await page.locator('input[type="file"]').setInputFiles(zipPath!);
  await expect(page.getByText('The Lantern Crossing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sage' }).click();
  await page.getByRole('button', { name: 'notes.txt', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Cross-mode note');
  await expect(page.getByRole('status').filter({ hasText: 'Recovery copy saved locally' })).toBeVisible({ timeout: 10_000 });

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) throw new Error('Studio service worker is not active.');
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Studio offline assets were not cached.')), 10_000);
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'PRECACHE_COMPLETE') { window.clearTimeout(timeout); resolve(); }
      }, { once: true });
      const urls = [...new Set(performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(url => url.startsWith(location.origin) && /\.(?:js|css)(?:$|\?)/u.test(url)))];
      worker.postMessage({ type: 'PRECACHE_URLS', urls });
    });
  });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.getByRole('button', { name: 'Projects' }).click();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'DungeonScrivener' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore recovery' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Restore recovery' }).click();
  await expect(page.getByText('The Lantern Crossing', { exact: true })).toBeVisible();
  await context.setOffline(false);
});

test('Tavern scripts run in hosted play and export opens directly from file URL', async ({ page, context }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({ name: 'tavern.zip', mimeType: 'application/zip', buffer: await tavernZip('theme') });
  await expect(page.getByText('Tavern at Dusk', { exact: true })).toBeVisible();
  await page.clock.install();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await expect(page.locator('.ds-player__clock')).toBeVisible();
  await expect(page.locator('style[data-player-theme="author"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#ds-player-settings select').selectOption('ja-JP');
  await expect(page.getByLabel('Current language: ja-JP')).toBeVisible();
  await page.clock.fastForward(121_000);
  await expect(page.getByTestId('hosted-play-activity')).toContainText('Hosted play ran scripts: echo-check, keeper-check, witness-check.');

  const downloads: import('@playwright/test').Download[] = [];
  page.on('download', item => downloads.push(item));
  await openExportDialog(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  await expect.poll(() => downloads.length).toBe(2);
  const game = downloads.find(item => item.suggestedFilename().endsWith('-game.zip'))!;
  const readme = downloads.find(item => item.suggestedFilename().endsWith('-README.md'))!;
  expect(readme.suggestedFilename()).toBe('tavern-at-dusk-README.md');
  expect(await readFile((await readme.path())!, 'utf8')).toContain('# Tavern at Dusk');
  const zipped = unzipSync(new Uint8Array(await readFile((await game.path())!)));
  const index = strFromU8(zipped['index.html']!);
  expect(index).toContain('dungeon-scrivener-game-data');
  expect(index).not.toMatch(/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=/iu);
  const directOpenPath = join(tmpdir(), `dungeon-scrivener-tavern-${Date.now()}.html`);
  await import('node:fs/promises').then(fs => fs.writeFile(directOpenPath, index));
  const directOpen = await context.newPage();
  await directOpen.setViewportSize({ width: 375, height: 812 });
  const externalRequests: string[] = [];
  directOpen.on('request', request => { if (/^https?:/iu.test(request.url())) externalRequests.push(request.url()); });
  await directOpen.route(/^https?:/iu, route => route.abort());
  await directOpen.goto(pathToFileURL(directOpenPath).href);
  await expect(directOpen.getByRole('heading', { name: 'Tavern at Dusk' })).toBeVisible();
  await expect.poll(() => directOpen.locator('style[data-player-theme="author"]').evaluate(style => style.textContent)).toBe('.ds-player { color: #211; }');
  await expect(directOpen.getByRole('alert')).toHaveCount(0);
  expect(await directOpen.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(externalRequests).toEqual([]);
  await directOpen.close();
});

test('invalid Tavern script compilation does not produce a game ZIP', async ({ page }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({ name: 'invalid-tavern.zip', mimeType: 'application/zip', buffer: await tavernZip('script') });
  await expect(page.getByText('Tavern at Dusk', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download', { timeout: 2_000 }).catch(() => undefined);
  await openExportDialog(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  await expect(page.getByRole('alert')).toContainText('DS-SCRIPT');
  expect(await downloadPromise).toBeUndefined();
});

test('invalid Tavern validation does not produce a game ZIP', async ({ page }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({ name: 'invalid-world.zip', mimeType: 'application/zip', buffer: await tavernZip('validation') });
  await expect(page.getByText('Tavern at Dusk', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download', { timeout: 2_000 }).catch(() => undefined);
  await openExportDialog(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  await expect(page.getByRole('alert')).toContainText('DS-MOD-');
  expect(await downloadPromise).toBeUndefined();
});

test('unsafe author CSS cannot start or export a game', async ({ page }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({ name: 'unsafe-theme.zip', mimeType: 'application/zip', buffer: await tavernZip('unsafe-theme') });
  await expect(page.getByText('Tavern at Dusk', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download', { timeout: 2_000 }).catch(() => undefined);
  await openExportDialog(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  await expect(page.getByRole('alert')).toContainText('not accepted for offline play or export');
  expect(await downloadPromise).toBeUndefined();
});

test('missing selected-locale text falls back to the project default language', async ({ page }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({ name: 'locale-fallback.zip', mimeType: 'application/zip', buffer: await tavernZip('fallback') });
  await expect(page.getByText('Tavern at Dusk', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#ds-player-settings select').selectOption('ja-JP');
  await expect(page.getByRole('heading', { name: 'The Taproom' })).toBeVisible();
  await expect(page.getByLabel('Current language: ja-JP')).toBeVisible();
});

test('keyboard skip link and nonblocking unsaved-work reminder are usable', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  const skipLink = page.getByRole('link', { name: 'Skip to project workspace' });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#studio-workspace')).toBeFocused();
  await page.clock.fastForward(10 * 60_000);
  const reminder = page.getByLabel('Unsaved work reminder');
  await expect(reminder).toBeVisible();
  await expect(reminder.getByRole('button', { name: 'Download project ZIP' })).toBeVisible();
  await reminder.getByRole('button', { name: 'Dismiss reminder' }).click();
  await expect(reminder).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(page.getByLabel('Unsaved work reminder')).toHaveCount(0);
});
