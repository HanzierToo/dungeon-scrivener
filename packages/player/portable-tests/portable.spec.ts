import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

const fixtureUrl = pathToFileURL(resolve('portable-tests/index.html')).href;
const bundlePath = resolve('dist/dungeon-scrivener-player.js');
const cssPath = resolve('dist/dungeon-scrivener-player.css');
const compatibleSave = JSON.parse(await readFile(resolve('../../fixtures/tavern-at-dusk/saves/compatible-save.json'), 'utf8'));
const incompatibleSave = JSON.parse(await readFile(resolve('../../fixtures/tavern-at-dusk/saves/incompatible-game-version-save.json'), 'utf8'));
const tavernData = {
  manifest: JSON.parse(await readFile(resolve('../../fixtures/tavern-at-dusk/project.json'), 'utf8')),
  world: JSON.parse(await readFile(resolve('../../fixtures/tavern-at-dusk/world.json'), 'utf8')),
  locales: [JSON.parse(await readFile(resolve('../../fixtures/tavern-at-dusk/locales/en-GB.json'), 'utf8'))],
  compiledScripts: { format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts: [] },
  sessionStart: { wallClockEpochMilliseconds: 1000, visibility: 'visible', focused: true },
  saveCompatibility: {
    manifest: { projectId: compatibleSave.projectId, gameVersion: compatibleSave.gameVersion },
    engineVersion: compatibleSave.engineVersion,
    contentFingerprint: compatibleSave.contentFingerprint,
  },
};

test('classic bundle boots embedded data from file:// with the validated executor and no network', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.addInitScript(() => {
    (window as Window & { fetchCount: number }).fetchCount = 0;
    window.fetch = (() => {
      (window as Window & { fetchCount: number }).fetchCount += 1;
      return Promise.reject(new Error('fetch is disabled in this test'));
    }) as typeof fetch;
  });
  await page.goto(fixtureUrl);

  const boot = await page.evaluate(() => {
    const runtime = (window as unknown as { DungeonScrivenerPlayer: { parseEmbeddedData(id: string): any; startFromEmbeddedData(target: HTMLElement, data: any, options: any): { unmount(): void } } }).DungeonScrivenerPlayer;
    const data = runtime.parseEmbeddedData('game-data');
    const context = {
      origin: { kind: 'action', actionId: 'portable-test' },
      limits: { maxInstructions: 50000, maxCallDepth: 16, maxLoopIterations: 1000, maxAllocatedBytes: 1048576, maxStringBytes: 16384, maxCollectionMembers: 1024, maxValueDepth: 32, maxCapabilityCalls: 10000, maxRequestedEffects: 256, maxTraceRecords: 20000 },
      capabilities: { read: () => 0, hasTag: () => false, request: () => undefined, emit: () => undefined, randomInt: (minimum: number) => minimum, randomFloat: () => 0.5 },
    };
    let scriptPassed = false;
    const factory = {
      createGameEngine(host: any, bundle: any) {
        scriptPassed = host.scriptExecutor.executeScript(bundle.scripts[0], context).ok;
        let session: any;
        return {
          createSession(projectId: string) { session = { projectId, currentNodeId: 'start', trust: 0 }; return { ok: true, snapshot: session }; },
          getPlayerView(_manifest: unknown, _world: unknown, _locales: unknown, snapshot: any) {
            return { ...data.playerView, currentNode: { ...data.playerView.currentNode, title: snapshot.lastKind === 'node-link' ? 'Followed link' : snapshot.trust ? 'Script effect applied' : 'The beginning' } };
          },
          dispatchPlayerInput(_world: unknown, snapshot: any, input: any) {
            const next = { ...snapshot, trust: snapshot.trust + 1, lastKind: input.kind };
            return { snapshot: next, resolution: { kind: 'choice', actionId: input.actionId }, trace: [{ sequence: 0, kind: 'state-change', source: { kind: 'script', scriptId: 'test-script' }, reason: 'Script incremented trust.' }], diagnostics: { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics: [] } };
          },
        };
      },
    };
    const host = { mediaAssets: { resolveAsset: () => ({ ok: false, diagnostic: { code: 'missing', severity: 'error', message: 'not used', blocks: ['play'] } }) } };
    const handle = runtime.startFromEmbeddedData(document.getElementById('player-root')!, data, { factory, host });
    (window as unknown as { portableHandle: { unmount(): void }; scriptPassed: boolean }).portableHandle = handle;
    (window as unknown as { scriptPassed: boolean }).scriptPassed = scriptPassed;
    return { scriptPassed, protocol: location.protocol };
  });

  expect(boot).toEqual({ scriptPassed: true, protocol: 'file:' });
  await expect(page.getByRole('heading', { name: 'Portable fixture' })).toBeVisible();
  await expect(page.getByText('Embedded game data opened from file.')).toBeVisible();
  await page.getByRole('link', { name: 'Visit the cellar' }).click();
  await expect(page.getByRole('heading', { name: 'Followed link' })).toBeVisible();
  const minHeight = await page.locator('.ds-player').evaluate(element => getComputedStyle(element).minHeight);
  expect(minHeight).toBe(`${await page.evaluate(() => window.innerHeight)}px`);
  await page.getByRole('button', { name: 'Apply scripted effect' }).click();
  await expect(page.getByRole('heading', { name: 'Script effect applied' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { fetchCount: number }).fetchCount)).toBe(0);
  expect(requests.every(url => url.startsWith('file:'))).toBe(true);

  const bundle = await readFile(bundlePath, 'utf8');
  const css = await readFile(cssPath, 'utf8');
  expect(bundle).not.toMatch(/^\s*(?:import|export)\s/m);
  expect(bundle).not.toMatch(/\bimport\s*\(/u);
  expect(css).not.toMatch(/@import\b|url\s*\(/iu);
});

test('portable runtime starts the Tavern data with Agent 13 public factory', async ({ page }) => {
  await page.goto(fixtureUrl);
  const result = await page.evaluate(data => {
    const runtime = (window as unknown as { DungeonScrivenerPlayer: { startFromEmbeddedData(target: HTMLElement, data: any, options: any): { getSnapshot(): any } } }).DungeonScrivenerPlayer;
    const host = { mediaAssets: { resolveAsset: () => ({ ok: false, diagnostic: { code: 'portable-test-missing', severity: 'warning', message: 'asset omitted in portable test' } }) } };
    data.world = { ...data.world, scripts: [], savePolicy: { enabled: true, slotCount: 1, allowedLocation: 'anywhere' } };
    const handle = runtime.startFromEmbeddedData(document.getElementById('player-root')!, data, { factory: (window as any).DungeonScrivenerPlayer.engine, host });
    return { projectId: handle.getSnapshot()?.projectId, nodeId: handle.getSnapshot()?.currentNodeId };
  }, tavernData);
  expect(result).toEqual({ projectId: 'tavern-at-dusk', nodeId: 'taproom' });
  await expect(page.getByRole('heading', { name: 'Tavern at Dusk' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The Taproom' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save game' }).click();
  const download = await downloadPromise;
  const savePath = await download.path();
  expect(savePath).toBeTruthy();
  await page.getByRole('link', { name: 'the cellar' }).click();
  await expect(page.getByRole('heading', { name: 'The Cellar' })).toBeVisible();
  const incompatibleZip = zipSync({ 'player-save.json': strToU8(JSON.stringify(incompatibleSave)) });
  await page.locator('input[type="file"]').setInputFiles({ name: 'incompatible-save.zip', mimeType: 'application/zip', buffer: Buffer.from(incompatibleZip) });
  await expect(page.getByRole('alert')).toContainText('gameVersion');
  await expect(page.getByRole('heading', { name: 'The Cellar' })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(savePath!);
  await expect(page.getByRole('heading', { name: 'The Taproom' })).toBeVisible();
});
