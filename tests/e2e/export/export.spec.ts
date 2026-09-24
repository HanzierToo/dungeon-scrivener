import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import type { ContentFingerprint, ExportGameInput, LocaleDocument, ProjectManifest, WorldDocument } from '../../../packages/model/src/public-types.js';
import { exportGame } from '../../../packages/exporter/src/index.js';
import { parseJavaScript } from '../../../packages/scripting/src/frontends/js/index.js';
import { parseLua } from '../../../packages/scripting/src/frontends/lua/index.js';
import { parsePython } from '../../../packages/scripting/src/frontends/python/index.js';

const repository = resolve(import.meta.dirname, '../../..');
const fixtureDirectory = resolve(repository, 'fixtures/tavern-at-dusk');
const outputDirectories: string[] = [];

interface PreparedExport { readonly directory: string; readonly fileUrl: string; readonly checksum: string }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readFixtureJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(fixtureDirectory, path), 'utf8')) as T;
}

async function prepareExport(worldOverride?: WorldDocument): Promise<PreparedExport> {
  const manifest = await readFixtureJson<ProjectManifest>('project.json');
  const fixtureWorld = await readFixtureJson<WorldDocument>('world.json');
  const world = worldOverride ?? fixtureWorld;
  const locales = await Promise.all([
    readFixtureJson<LocaleDocument>('locales/en-GB.json'),
    readFixtureJson<LocaleDocument>('locales/ja-JP.json'),
  ]);
  const scripts = [];
  for (const reference of world.scripts) {
    const source = await readFile(resolve(fixtureDirectory, reference.path), 'utf8');
    const metadata = { scriptId: reference.id, sourcePath: reference.path };
    const compiled = reference.language === 'javascript'
      ? parseJavaScript(source, metadata)
      : reference.language === 'lua'
        ? parseLua(source, metadata)
        : parsePython(source, metadata);
    if (!compiled.ok) throw new Error(`Could not compile ${reference.path}: ${JSON.stringify(compiled.diagnostics)}`);
    scripts.push(compiled.ir);
  }

  const playerJs = await readFile(resolve(repository, 'packages/player/dist/dungeon-scrivener-player.js'), 'utf8');
  const playerCss = await readFile(resolve(repository, 'packages/player/dist/dungeon-scrivener-player.css'), 'utf8');
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${manifest.title}</title><style>${playerCss}</style></head><body><div id="player-root"></div><script>${playerJs}</script><!--DUNGEON_SCRIVENER_EMBEDDED_GAME_DATA--></body></html>`;
  const media = [];
  const fingerprintFiles: { path: string; byteLength: number; sha256: string }[] = [];
  const addFingerprintFile = async (path: string, bytes: Uint8Array): Promise<void> => {
    fingerprintFiles.push({ path, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  await addFingerprintFile('project.json', new Uint8Array(await readFile(resolve(fixtureDirectory, 'project.json'))));
  const worldBytes = worldOverride
    ? new TextEncoder().encode(`${JSON.stringify(world, null, 2)}\n`)
    : new Uint8Array(await readFile(resolve(fixtureDirectory, 'world.json')));
  await addFingerprintFile('world.json', worldBytes);
  for (const localePath of ['locales/en-GB.json', 'locales/ja-JP.json']) {
    await addFingerprintFile(localePath, new Uint8Array(await readFile(resolve(fixtureDirectory, localePath))));
  }
  for (const reference of world.scripts) {
    await addFingerprintFile(reference.path, new Uint8Array(await readFile(resolve(fixtureDirectory, reference.path))));
  }
  for (const [digest, mediaType] of [
    ['dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690', 'audio/wav'],
    ['db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399', 'image/png'],
  ] as const) {
    const bytes = new Uint8Array(await readFile(resolve(fixtureDirectory, `assets/sha256/${digest}`)));
    media.push({ assetId: `sha256:${digest}` as const, mediaType, byteLength: bytes.byteLength, bytes });
    await addFingerprintFile(`assets/sha256/${digest}`, bytes);
  }
  fingerprintFiles.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const fingerprintInput = {
    format: 'dungeon-scrivener-content-fingerprint-input', schemaVersion: 1,
    algorithm: 'sha-256', scope: 'playable-files-v1', files: fingerprintFiles,
  } as const;
  const acceptedContentFingerprint: ContentFingerprint = {
    ...fingerprintInput,
    format: 'dungeon-scrivener-content-fingerprint',
    digest: `sha256:${createHash('sha256').update(canonicalJson(fingerprintInput)).digest('hex')}`,
  };
  if (!worldOverride) {
    const acceptedSave = await readFixtureJson<{ contentFingerprint: string }>('saves/compatible-save.json');
    expect(acceptedContentFingerprint.digest).toBe(acceptedSave.contentFingerprint);
  }
  const input: ExportGameInput = {
    manifest, world, locales,
    scripts: { format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts },
    acceptedContentFingerprint,
    media, authorStyle: { cssText: '' },
    player: { format: 'dungeon-scrivener-portable-player', schemaVersion: 1, engineVersion: '1.0.0', indexHtml: new TextEncoder().encode(shell) },
  };
  const result = await exportGame(input);
  if (!result.ok) throw new Error(`Export failed: ${JSON.stringify(result.diagnostics)}`);
  if (!worldOverride) await writeFile(resolve(tmpdir(), 'dungeon-scrivener-29c-tavern-game.zip'), result.zipBytes);
  const directory = await mkdtemp(resolve(tmpdir(), 'dungeon-scrivener-export-'));
  outputDirectories.push(directory);
  for (const [path, bytes] of Object.entries(unzipSync(result.zipBytes))) {
    const outputPath = resolve(directory, path);
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, bytes);
  }
  return {
    directory,
    fileUrl: pathToFileURL(resolve(directory, 'index.html')).href,
    checksum: createHash('sha256').update(result.zipBytes).digest('hex'),
  };
}

async function blockNetwork(context: BrowserContext, page: Page, attempted: string[]): Promise<void> {
  await context.route(/^https?:\/\//iu, async route => {
    attempted.push(route.request().url());
    await route.abort();
  });
  page.on('request', request => {
    if (/^https?:\/\//iu.test(request.url()) && !attempted.includes(request.url())) attempted.push(request.url());
  });
}

test.afterAll(async () => {
  await Promise.all(outputDirectories.map(directory => rm(directory, { recursive: true, force: true })));
});

test('opens extracted export and exercises the compiled game in the browser', async ({ page, context, browser }, testInfo) => {
  const game = await prepareExport();
  const attemptedNetwork: string[] = [];
  const pageErrors: string[] = [];
  await blockNetwork(context, page, attemptedNetwork);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(game.fileUrl);
  await expect(page.getByRole('heading', { name: 'Tavern at Dusk' })).toBeVisible();
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Taproom');
  await expect(page.locator('img[data-asset-id]')).toHaveCount(1);
  await expect(page.locator('audio[data-asset-id]')).toHaveCount(1);
  const data = JSON.parse((await page.locator('#dungeon-scrivener-game-data').textContent()) ?? 'null');
  expect(data.locales.map((locale: LocaleDocument) => locale.locale)).toEqual(['en-GB', 'ja-JP']);
  expect(data.scripts.scripts.map((script: { sourceLanguage: string }) => script.sourceLanguage)).toEqual(['javascript', 'lua', 'python']);
  expect(data.media.map((asset: { path: string }) => asset.path)).toEqual([
    'assets/dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690.wav',
    'assets/db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399.png',
  ]);
  expect(data.saveCompatibility).toEqual({
    manifest: { projectId: 'tavern-at-dusk', gameVersion: '1.0.0' },
    engineVersion: '1.0.0',
    contentFingerprint: 'sha256:eba68a00f286dd699b6ff737954115d5601c79087b7952c6d8559d8016089897',
  });

  await page.getByRole('button', { name: 'Go down to the cellar' }).click();
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Cellar');
  await page.getByRole('button', { name: 'Return to the taproom' }).click();
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Taproom');

  const engineEvidence = await page.evaluate(() => {
    const global = window as unknown as Record<string, any>;
    const runtime = global['DungeonScrivenerPlayer']?.portablePlayerRuntime;
    const data = JSON.parse(document.getElementById('dungeon-scrivener-game-data')?.textContent ?? 'null');
    const media = new Map(data.media.map((item: any) => {
      const raw = atob(item.base64);
      const bytes = Uint8Array.from(raw, (character: string) => character.charCodeAt(0));
      return [item.assetId, { assetId: item.assetId, mediaType: item.mediaType, byteLength: bytes.byteLength, bytes }];
    }));
    const host = {
      scriptExecutor: new global['DungeonScrivenerExecutor'].ScriptExecutor(),
      mediaAssets: { resolveAsset: (id: string) => ({ ok: true, asset: media.get(id) }) },
      unseededRandomSource: { nextUint32: () => 0 },
    };
    const engine = runtime.engine.createGameEngine(host, data.scripts);
    const created = engine.createSession(data.manifest.projectId, data.world, {
      wallClockEpochMilliseconds: 1_000_000, visibility: 'visible', focused: true,
    });
    if (!created.ok) return { ok: false, message: JSON.stringify(created.diagnostics) };
    let snapshot = created.snapshot;
    const trace: any[] = [];
    for (const input of [
      { kind: 'tick', wallClockEpochMilliseconds: 1_060_000, visibility: 'visible', focused: true },
      { kind: 'visibility-change', wallClockEpochMilliseconds: 1_060_000, visibility: 'hidden', focused: false },
      { kind: 'resume', wallClockEpochMilliseconds: 1_360_000, visibility: 'visible', focused: true },
    ] as const) {
      const transition = engine.observeClock(data.world, snapshot, input);
      snapshot = transition.snapshot;
      trace.push(...transition.trace);
    }
    const japanese = engine.getPlayerView(data.manifest, data.world, data.locales, snapshot, 'ja-JP');
    return {
      ok: true,
      gameTimeMilliseconds: snapshot.gameTimeMilliseconds,
      trust: snapshot.state.world.trust,
      bellEchoes: snapshot.state.world['bell-echoes'],
      randomOutcomes: snapshot.randomOutcomes.length,
      scriptIds: [...new Set(trace.filter(item => item.source.kind === 'script').map(item => item.source.scriptId))].sort(),
      japaneseTitle: japanese.currentNode.title,
    };
  });
  expect(engineEvidence).toMatchObject({
    ok: true, gameTimeMilliseconds: 120_000, trust: 1, randomOutcomes: 1,
    scriptIds: ['echo-check', 'keeper-check', 'witness-check'], japaneseTitle: '酒場の広間',
  });
  expect(engineEvidence.bellEchoes).toBeGreaterThanOrEqual(1);
  expect(engineEvidence.bellEchoes).toBe(1);

  const wikiLink = page.getByRole('link', { name: 'the cellar' });
  const wikiLinkCount = await wikiLink.count();
  expect.soft(wikiLinkCount, 'the authored wiki node link should be actionable').toBe(1);
  if (wikiLinkCount === 1) {
    await wikiLink.click();
    await expect(page.locator('.ds-player__scene h2')).toHaveText('The Cellar');
    await page.getByRole('button', { name: 'Return to the taproom' }).click();
    await expect(page.locator('.ds-player__scene h2')).toHaveText('The Taproom');
  }
  expect(attemptedNetwork).toEqual([]);
  expect(pageErrors).toEqual([]);
  testInfo.annotations.push({ type: 'browser-version', description: `${browser.browserType().name()} ${browser.version()}` });
  testInfo.annotations.push({ type: 'network-requests', description: '0 HTTP(S); local file and blob media only' });
  testInfo.annotations.push({ type: 'sample-game-zip-sha256', description: game.checksum });
});

test('reports a missing entry node as a startup error', async ({ page, context }) => {
  const base = await readFixtureJson<WorldDocument>('world.json');
  const game = await prepareExport({ ...base, entryNodeId: 'missing-entry-node' });
  const attemptedNetwork: string[] = [];
  const pageErrors: string[] = [];
  await blockNetwork(context, page, attemptedNetwork);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(game.fileUrl);
  await expect(page.getByRole('heading', { name: 'Game could not be started' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('entry');
  expect(attemptedNetwork).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('downloads a save ZIP, changes nodes, then imports it to restore the saved node', async ({ page, context }, testInfo) => {
  const world = await readFixtureJson<WorldDocument>('world.json');
  const game = await prepareExport({ ...world, savePolicy: { ...world.savePolicy, enabled: true, slotCount: 1 } });
  const attemptedNetwork: string[] = [];
  const pageErrors: string[] = [];
  await blockNetwork(context, page, attemptedNetwork);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(game.fileUrl);

  const wikiLink = page.getByRole('link', { name: 'the cellar' });
  const wikiLinkCount = await wikiLink.count();
  expect.soft(wikiLinkCount, 'the authored wiki node link should be actionable before saving').toBe(1);
  const saveButton = page.getByRole('button', { name: 'Save game', exact: true });
  const loadButton = page.getByRole('button', { name: 'Load game', exact: true });
  const saveButtonCount = await saveButton.count();
  const loadButtonCount = await loadButton.count();
  expect.soft(saveButtonCount, 'portable player should expose save download').toBe(1);
  expect.soft(loadButtonCount, 'portable player should expose save import').toBe(1);
  if (wikiLinkCount !== 1 || saveButtonCount !== 1 || loadButtonCount !== 1) {
    expect(attemptedNetwork).toEqual([]);
    expect(pageErrors).toEqual([]);
    testInfo.annotations.push({ type: 'sample-game-zip-sha256', description: game.checksum });
    return;
  }
  await wikiLink.click();
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Cellar');

  const downloadPromise = page.waitForEvent('download');
  await saveButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/iu);
  const savePath = await download.path();
  expect(savePath).toBeTruthy();

  await page.getByRole('button', { name: 'Return to the taproom' }).click();
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Taproom');
  await loadButton.click();
  await page.locator('input[type="file"]').setInputFiles(savePath!);
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Cellar');
  expect(attemptedNetwork).toEqual([]);
  expect(pageErrors).toEqual([]);
  testInfo.annotations.push({ type: 'save-zip', description: download.suggestedFilename() });
  testInfo.annotations.push({ type: 'sample-game-zip-sha256', description: game.checksum });
});
