import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync, zipSync } from 'fflate';

async function tavernZip(variant?: 'script' | 'validation' | 'fallback' | 'theme' | 'unsafe-theme' | 'save' | 'no-alt' | 'corrupt-asset'): Promise<Buffer> {
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
        if (variant === 'corrupt-asset' && archivePath.startsWith('assets/sha256/')) contents = new Uint8Array([1, 2, 3]);
        if (variant === 'validation' && archivePath === 'world.json') contents = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), entryNodeId: 'Bad Node' }));
        if (variant === 'save' && archivePath === 'world.json') {
          const world = JSON.parse(new TextDecoder().decode(bytes));
          world.savePolicy = { enabled: true, slotCount: 1, allowedLocation: 'anywhere' };
          contents = new TextEncoder().encode(JSON.stringify(world));
        }
        if (variant === 'no-alt' && archivePath.startsWith('locales/')) {
          contents = new TextEncoder().encode(new TextDecoder().decode(bytes)
            .replace(/(!\[\[asset:sha256:[a-f0-9]{64})\|[^\]]*\]\]/gu, '$1]]'));
        }
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

  await page.getByRole('button', { name: 'Sage' }).click();
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
  await expect(page.getByLabel('Project diagnostics')).not.toContainText('DS-MD-005');
  await page.clock.install();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await expect(page.locator('.ds-player__clock')).toBeVisible();
  await expect.poll(() => page.locator('style[data-player-theme="author"]').evaluate(style => style.textContent)).toBe('.ds-player { color: #211; }');
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

test('hosted and direct-open games exchange the same save ZIP', async ({ page, context }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'tavern-save.zip', mimeType: 'application/zip', buffer: await tavernZip('save') });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await expect(page.getByRole('button', { name: 'Save game' })).toBeVisible();
  await page.getByRole('button', { name: 'Go down to the cellar' }).click();
  const hostedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save game' }).click();
  const hostedSave = await hostedDownload;
  const hostedSavePath = (await hostedSave.path())!;
  expect(Object.keys(unzipSync(new Uint8Array(await readFile(hostedSavePath))))).toEqual(['save.json']);
  await page.locator('.ds-player__toolbar input[type="file"]').setInputFiles({
    name: 'invalid-save.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'player-save.json': new Uint8Array([123, 125]) })),
  });
  await expect(page.getByRole('alert')).toContainText('DS-SAVE-005');
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Cellar');

  const gameDownload = page.waitForEvent('download', download => download.suggestedFilename().endsWith('-game.zip'));
  await openExportDialog(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  const game = await gameDownload;
  const index = strFromU8(unzipSync(new Uint8Array(await readFile((await game.path())!)))['index.html']!);
  const directOpenPath = join(tmpdir(), `dungeon-scrivener-save-${Date.now()}.html`);
  await import('node:fs/promises').then(fs => fs.writeFile(directOpenPath, index));
  const directOpen = await context.newPage();
  await directOpen.goto(pathToFileURL(directOpenPath).href);
  await expect(directOpen.getByRole('button', { name: 'Load game' })).toBeVisible();
  await directOpen.locator('.ds-player__toolbar input[type="file"]').setInputFiles(hostedSavePath);
  await expect(directOpen.locator('.ds-player__scene h2')).toHaveText('The Cellar');

  await directOpen.getByRole('button', { name: 'Return to the taproom' }).click();
  const portableDownload = directOpen.waitForEvent('download');
  await directOpen.getByRole('button', { name: 'Save game' }).click();
  const portableSavePath = (await (await portableDownload).path())!;
  await page.locator('.ds-player__toolbar input[type="file"]').setInputFiles(portableSavePath);
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Taproom');
  await directOpen.close();
});

test('asset embeds without alt text render in hosted play and export', async ({ page, context }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'no-alt.zip', mimeType: 'application/zip', buffer: await tavernZip('no-alt') });
  await expect(page.getByLabel('Project diagnostics')).not.toContainText('DS-MD-005');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await expect(page.locator('img[data-asset-id]')).toHaveCount(1);
  await expect(page.locator('audio[data-asset-id]')).toHaveCount(1);
  const gameDownload = page.waitForEvent('download', download => download.suggestedFilename().endsWith('-game.zip'));
  await openExportDialog(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  const index = strFromU8(unzipSync(new Uint8Array(await readFile((await (await gameDownload).path())!)))['index.html']!);
  const directOpenPath = join(tmpdir(), `dungeon-scrivener-no-alt-${Date.now()}.html`);
  await import('node:fs/promises').then(fs => fs.writeFile(directOpenPath, index));
  const directOpen = await context.newPage();
  await directOpen.goto(pathToFileURL(directOpenPath).href);
  await expect(directOpen.locator('img[data-asset-id]')).toHaveCount(1);
  await expect(directOpen.locator('audio[data-asset-id]')).toHaveCount(1);
  await directOpen.close();
});

test('corrupt managed assets produce visible diagnostics', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'corrupt-asset.zip', mimeType: 'application/zip', buffer: await tavernZip('corrupt-asset') });
  await expect(page.getByLabel('Project diagnostics')).toContainText('DS-MEDIA-001');
});

test('playtest clock runs configured scripts and accepts node-link input', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'tavern.zip', mimeType: 'application/zip', buffer: await tavernZip() });
  await page.clock.install();
  await page.getByRole('button', { name: 'Playtest' }).click();
  await acknowledgeWarnings(page);
  await page.clock.fastForward(121_000);
  await page.getByText('Playtest debugger', { exact: true }).click();
  await expect(page.getByLabel('Chronological engine trace')).toContainText('Script echo-check');
  await expect(page.getByLabel('Chronological engine trace')).toContainText('Script keeper-check');
  await expect(page.getByLabel('Chronological engine trace')).toContainText('Script witness-check');
  await page.getByLabel('Step with PlayerInput JSON').fill('{"kind":"node-link","nodeId":"cellar"}');
  await page.getByRole('button', { name: 'Step session' }).click();
  await expect(page.getByText('Current test state: node')).toContainText('cellar');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Step with PlayerInput JSON').fill('{"kind":"choice","actionId":"missing-action"}');
  await page.getByRole('button', { name: 'Step session' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Current test state: node')).toContainText('cellar');
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
