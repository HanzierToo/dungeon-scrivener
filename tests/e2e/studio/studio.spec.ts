import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

test('create, edit in Sage and Apprentice, reload offline, and round-trip a project ZIP', async ({ page, context }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('The Lantern Crossing', { exact: true })).toBeVisible();

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
  await page.getByRole('button', { name: 'Save ZIP' }).click();
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
  await page.getByRole('button', { name: 'Playtest' }).click();
  await expect(page.getByRole('heading', { name: 'Sandboxed playtest' })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The Lantern Crossing' })).toBeVisible();
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('status')).toContainText('fingerprint operation and scripting executor are missing');
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
