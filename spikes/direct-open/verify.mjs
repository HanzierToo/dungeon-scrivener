import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const root = path.dirname(fileURLToPath(import.meta.url));
const indexUrl = pathToFileURL(path.join(root, 'index.html')).href;
const reports = [];
const engines = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit]
];

for (const [name, engine] of engines) {
  let browser;
  let context;
  let tempDir;
  let runtime;
  let beforeSave;
  let afterImport;
  let saveZip;
  const telemetry = { networkRequests: [], failedRequests: [], consoleMessages: [], pageErrors: [] };
  try {
    browser = await engine.launch({ headless: true });
    telemetry.version = browser.version();
    context = await browser.newContext({ acceptDownloads: true });
    await context.setOffline(true);
    const page = await context.newPage();
    page.on('console', (message) => telemetry.consoleMessages.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', (error) => telemetry.pageErrors.push(error.message));
    page.on('request', (request) => telemetry.networkRequests.push({ url: request.url(), resourceType: request.resourceType() }));
    page.on('requestfailed', (request) => telemetry.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }));

    await page.goto(indexUrl, { waitUntil: 'load' });
    assert.equal(await page.title(), 'The Lantern at Dusk . Direct-open feasibility');
    await page.waitForFunction(() => document.getElementById('media-status').textContent.includes('WAV loaded'), null, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('isolation-status').textContent.startsWith('PASS:'), null, { timeout: 10000 });

    runtime = await page.evaluate(() => ({
      url: location.href,
      protocol: location.protocol,
      unicode: document.getElementById('story').textContent.includes('夜が来る前に') && document.getElementById('story').textContent.includes('Mind the wet stones'),
      scripts: [...document.scripts].map((script) => ({ type: script.type || 'classic', src: script.src })),
      modules: [...document.scripts].filter((script) => script.type === 'module').length,
      media: document.getElementById('media-status').textContent,
      isolation: document.getElementById('isolation-status').textContent,
      trace: document.getElementById('trace').textContent,
      runtimeReport: document.getElementById('runtime-report').textContent,
      imageSize: [document.getElementById('map').naturalWidth, document.getElementById('map').naturalHeight]
    }));
    assert.equal(runtime.protocol, 'file:');
    assert.equal(runtime.unicode, true);
    assert.equal(runtime.modules, 0);
    assert.equal(runtime.scripts.length, 1);
    assert.equal(runtime.scripts[0].src, '');
    assert.deepEqual(runtime.imageSize, [192, 128]);
    assert.match(runtime.runtimeReport, /sandbox origin: "null" \(opaque\)/);
    assert.match(runtime.trace, /sandbox origin: "null"/);
    assert.match(runtime.trace, /parent DOM: blocked/);
    assert.match(runtime.trace, /localStorage: blocked/);
    assert.match(runtime.trace, /network fetch: blocked/);
    assert.match(runtime.trace, /other local file: blocked/);
    assert.match(runtime.trace, /CSP blocked connect-src/);
    assert.deepEqual(telemetry.pageErrors, []);

    await page.getByRole('button', { name: 'Light the lantern' }).click();
    await page.getByRole('button', { name: 'Follow the blue trail' }).click();
    beforeSave = await page.evaluate(() => ({
      scene: document.getElementById('action-status').textContent,
      courage: document.getElementById('courage').value,
      chaptersSeen: document.getElementById('chapters').value
    }));
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download save ZIP' }).click();
    const download = await downloadPromise;
    saveZip = { suggestedFilename: download.suggestedFilename() };
    tempDir = await mkdtemp(path.join(os.tmpdir(), `ds-${name}-`));
    const savePath = path.join(tempDir, 'roundtrip.zip');
    await download.saveAs(savePath);
    const downloadedZip = await readFile(savePath);
    assert.ok(download.suggestedFilename().endsWith('.zip'));
    assert.equal(downloadedZip.readUInt32LE(0), 0x04034b50);

    await page.getByRole('button', { name: 'Light the lantern' }).click();
    await page.getByLabel('Import save ZIP:').setInputFiles(savePath);
    await page.waitForFunction(() => document.getElementById('save-status').textContent.startsWith('PASS: imported'));
    afterImport = await page.evaluate(() => ({
      courage: document.getElementById('courage').value,
      chaptersSeen: document.getElementById('chapters').value
    }));
    assert.deepEqual(afterImport, { courage: beforeSave.courage, chaptersSeen: beforeSave.chaptersSeen });

    assert.deepEqual(telemetry.networkRequests.filter(({ url }) => /^https?:/.test(url)), []);
    assert.deepEqual(telemetry.failedRequests.filter(({ url }) => /^https?:/.test(url)), []);
    reports.push({
      browser: name,
      result: 'PASS',
      directFileOpen: runtime.protocol,
      storyAndActions: 'PASS',
      localMedia: runtime.media,
      saveZipDownload: `${download.suggestedFilename()} (${downloadedZip.length} bytes)`,
      saveZipImport: 'PASS, restored state ' + JSON.stringify(afterImport),
      scriptIsolation: runtime.isolation,
      bridgeTrace: runtime.trace.trim().split('\n'),
      topLevelScripts: runtime.scripts,
      ...telemetry
    });
  } catch (error) {
    reports.push({
      browser: name,
      result: 'FAIL',
      error: error.stack || error.message,
      runtime,
      beforeSave,
      afterImport,
      saveZip,
      ...telemetry
    });
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await context?.close();
    await browser?.close();
  }
}

console.log(JSON.stringify(reports, null, 2));
const evidenceDir = path.join(root, 'evidence');
await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, 'browser-results.json'), JSON.stringify(reports, null, 2) + '\n');
if (reports.some((item) => item.result !== 'PASS')) process.exitCode = 1;
