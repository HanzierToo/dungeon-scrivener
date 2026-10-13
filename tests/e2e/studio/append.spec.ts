import { expect, test, type Page } from '@playwright/test';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync, zipSync } from 'fflate';

async function warnings(page: Page) {
  const acknowledge = page.getByRole('button', { name: 'Acknowledge and continue' });
  if (await acknowledge.isVisible()) await acknowledge.click();
}

test('append: authoring preserves response text when switching modes and builds a transcript without return actions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const invitation = page.getByRole('button', { name: 'Not now', exact: true });
  if (await invitation.isVisible()) await invitation.click();
  const guide = page.getByRole('button', { name: 'Dismiss starter guide' });
  if (await guide.isVisible()) await guide.click();
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  await inspector.getByRole('button', { name: 'Add choice', exact: true }).click();
  const choice = inspector.locator('.apprentice-choice');
  await choice.getByRole('group', { name: 'Choice label', exact: true }).getByRole('textbox', { name: 'Text', exact: true }).fill('Listen to the room');
  const response = choice.getByRole('combobox', { name: 'Scene text response' });
  await response.selectOption('show-scene-text');
  const text = choice.getByRole('group', { name: 'Response text', exact: true }).getByRole('textbox', { name: 'Text', exact: true });
  await text.fill('The terminal hums quietly.');
  await response.selectOption('append-scene-text');
  await expect(text).toHaveValue('The terminal hums quietly.');
  await response.selectOption('show-scene-text');
  await expect(text).toHaveValue('The terminal hums quietly.');
  await response.selectOption('append-scene-text');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await warnings(page);
  const archive = unzipSync(new Uint8Array(await readFile((await (await downloading).path())!)));
  const world = JSON.parse(strFromU8(archive['world.json']!));
  expect(world.nodes[0].actions.choices.at(-1).effects).toEqual([{ kind: 'append-scene-text', text: { kind: 'literal', text: 'The terminal hums quietly.' } }]);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await warnings(page);
  const content = page.locator('.ds-player__content');
  const opening = await content.innerText();
  for (let index = 0; index < 3; index++) await page.getByLabel('Game player').getByRole('button', { name: /Listen to the room/ }).click();
  await expect(content).toContainText(opening);
  await expect(content.getByText('The terminal hums quietly.', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('button', { name: /Return to/ })).toHaveCount(0);
});

test('append: conditional and scripted passages retain order and translations through export/save, replace/reset/travel, and rollback', async ({ page, context }) => {
  const world = JSON.parse(await readFile('fixtures/linear-three-nodes/world.json', 'utf8'));
  const locale = JSON.parse(await readFile('fixtures/linear-three-nodes/locales/en-GB.json', 'utf8'));
  locale.strings['first-note'] = 'The desk holds a folded note.';
  locale.strings['heard'] = 'A clock ticks in the dark.';
  const french = { ...locale, locale: 'fr-FR', strings: { ...locale.strings, 'gate-content': 'Vous êtes dans une pièce sombre.', 'first-note': 'Le bureau porte une note pliée.', 'heard': 'Une horloge sonne dans le noir.' } };
  world.savePolicy = { enabled: true, slotCount: 1, allowedLocation: 'anywhere' };
  world.stateDefinitions.push({ key: 'looked', scopeKind: 'world', valueType: 'boolean', defaultValue: false }); world.worldState.looked = false;
  world.scripts = [{ id: 'append-note', language: 'javascript', entrypoint: 'main', path: 'scripts/append-note.js' }];
  world.nodes[0].actions = { choices: [
    { id: 'look', label: { kind: 'literal', text: 'Look at the desk' }, effects: [
      { kind: 'append-scene-text', text: { kind: 'locale-key', key: 'first-note' } },
      { kind: 'set-state', target: { scope: { kind: 'world' }, key: 'looked' }, value: true },
    ], outcomes: [{ id: 'look-again', name: 'Already looked', condition: { kind: 'compare-state', left: { scope: { kind: 'world' }, key: 'looked' }, operator: 'eq', right: true }, effects: [{ kind: 'append-scene-text', text: { kind: 'literal', text: 'You have already checked the desk.' } }] }] },
    { id: 'replace', label: { kind: 'literal', text: 'Clear and show a new screen' }, effects: [{ kind: 'show-scene-text', text: { kind: 'literal', text: 'A fresh screen.' } }] },
    { id: 'restore', label: { kind: 'literal', text: 'Restore the opening' }, effects: [{ kind: 'reset-scene-text' }] },
    { id: 'travel', label: { kind: 'literal', text: 'Leave the room' }, effects: [], navigationEdgeId: 'gate-to-bridge' },
  ], commands: [{ id: 'listen', patterns: ['listen'], parameters: [], effects: [{ kind: 'run-script', scriptId: 'append-note' }] }] };
  const files = {
    'project.json': new Uint8Array(await readFile('fixtures/linear-three-nodes/project.json')),
    'world.json': new TextEncoder().encode(JSON.stringify(world)),
    'locales/en-GB.json': new TextEncoder().encode(JSON.stringify(locale)),
    'locales/fr-FR.json': new TextEncoder().encode(JSON.stringify(french)),
    'scripts/append-note.js': new TextEncoder().encode('function main() { api.request({ kind: "append-scene-text", text: { kind: "locale-key", key: "heard" } }); }'),
  };
  await page.goto('/');
  await page.getByLabel('Import project ZIP').setInputFiles({ name: 'append-project.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) });
  const exporting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export game ZIP' }).click();
  await warnings(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  const exported = unzipSync(new Uint8Array(await readFile((await (await exporting).path())!)));
  const directory = await mkdtemp(join(tmpdir(), 'ds-append-'));
  await writeFile(join(directory, 'index.html'), exported['index.html']!);
  const portable = await context.newPage();
  await portable.goto(pathToFileURL(join(directory, 'index.html')).href);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await warnings(page);
  for (const surface of [page, portable]) {
    const content = surface.locator('.ds-player__content');
    await surface.getByRole('button', { name: /Look at the desk/ }).click();
    await surface.getByRole('button', { name: /Look at the desk/ }).click();
    await surface.getByRole('textbox', { name: 'Type an action' }).fill('listen');
    await surface.getByRole('textbox', { name: 'Type an action' }).press('Enter');
    await expect(content).toContainText('A clock ticks in the dark.');
    const transcript = await content.innerText();
    expect(transcript.indexOf('The desk holds a folded note.')).toBeLessThan(transcript.indexOf('You have already checked the desk.'));
    expect(transcript.indexOf('You have already checked the desk.')).toBeLessThan(transcript.indexOf('A clock ticks in the dark.'));
    await surface.getByRole('button', { name: 'Settings', exact: true }).click();
    await surface.getByRole('combobox', { name: 'Language', exact: true }).selectOption('fr-FR');
    await expect(content).toContainText('Vous êtes dans une pièce sombre.');
    await expect(content).toContainText('Le bureau porte une note pliée.');
    await expect(content).toContainText('Une horloge sonne dans le noir.');
    await expect(content).toContainText('You have already checked the desk.');
    await surface.getByRole('button', { name: 'Close settings', exact: true }).click();
    const saving = surface.waitForEvent('download');
    await surface.getByRole('button', { name: 'Save game', exact: true }).click();
    const savePath = (await (await saving).path())!;
    const save = JSON.parse(strFromU8(unzipSync(new Uint8Array(await readFile(savePath)))['save.json']!));
    expect(save.session.sceneText).toEqual({ nodeId: 'old-gate', text: { kind: 'locale-key', key: 'gate-content' }, appended: [
      { kind: 'locale-key', key: 'first-note' }, { kind: 'literal', text: 'You have already checked the desk.' }, { kind: 'locale-key', key: 'heard' },
    ] });
    await surface.getByRole('button', { name: /Clear and show a new screen/ }).click();
    await expect(content).toHaveText('A fresh screen.');
    await surface.getByRole('textbox', { name: 'Type an action' }).fill('listen');
    await surface.getByRole('textbox', { name: 'Type an action' }).press('Enter');
    await expect(content).toContainText('A fresh screen.');
    await expect(content).toContainText('Une horloge sonne dans le noir.');
    await surface.getByRole('button', { name: /Restore the opening/ }).click();
    await expect(content).toHaveText('Vous êtes dans une pièce sombre.');
    await surface.getByLabel('Choose a game save file').setInputFiles(savePath);
    await expect(content).toContainText('Le bureau porte une note pliée.');
    await expect(content).toContainText('Une horloge sonne dans le noir.');
    await surface.getByRole('button', { name: /Leave the room/ }).click();
    await expect(surface.locator('.ds-player__scene h2')).toHaveText('The Stone Bridge');
    await expect(content).not.toContainText('Une horloge sonne dans le noir.');
  }
  const proof = await portable.evaluate(() => {
    const global = window as unknown as Record<string, any>;
    const runtime = global.DungeonScrivenerPlayer.portablePlayerRuntime ?? global.DungeonScrivenerPlayer;
    const data = JSON.parse(document.getElementById('dungeon-scrivener-game-data')!.textContent!);
    const engine = runtime.engine.createGameEngine({ scriptExecutor: new global.DungeonScrivenerExecutor.ScriptExecutor(), seededSeedSource: { nextUint32: () => 0 }, mediaAssets: { resolveAsset: () => ({ ok: false }) } }, data.scripts);
    const created = engine.createSession(data.manifest.projectId, data.world, { wallClockEpochMilliseconds: 1000, visibility: 'visible', focused: true });
    if (!created.ok) throw Error(JSON.stringify(created.diagnostics));
    const changed = structuredClone(data.world);
    changed.nodes[0].actions.choices[0].effects = [{ kind: 'show-scene-text', text: { kind: 'literal', text: '```\nUnclosed code fence' } }, { kind: 'append-scene-text', text: { kind: 'literal', text: '**Independent passage**' } }];
    const safe = engine.dispatchAction(changed, created.snapshot, { kind: 'choice', actionId: 'look' });
    const view = engine.getPlayerView(data.manifest, changed, data.locales, safe.snapshot);
    const invalid = structuredClone(changed);
    invalid.nodes[0].actions.choices[0].effects = [{ kind: 'append-scene-text', text: { kind: 'literal', text: 'Must roll back.' } }, { kind: 'navigate', edgeId: 'bridge-to-home' }];
    const failure = engine.dispatchAction(invalid, safe.snapshot, { kind: 'choice', actionId: 'look' });
    return { blocks: view.currentNode.blocks.map((block: any) => block.kind), rollback: JSON.stringify(failure.snapshot) === JSON.stringify(safe.snapshot), errors: failure.diagnostics.diagnostics.length };
  });
  expect(proof).toEqual({ blocks: ['code-block', 'paragraph'], rollback: true, errors: 1 });
});

test('append: autoscroll shows new output without moving controls or keyboard focus in hosted and exported desktop/mobile play', async ({ page, context }) => {
  const world = JSON.parse(await readFile('fixtures/linear-three-nodes/world.json', 'utf8'));
  const paragraphs = Array.from({ length: 24 }, (_, index) => `Passage ${index + 1}. The terminal records a detailed observation of the room, its desk, and the quiet machinery around you.`).join('\n\n');
  world.nodes[0].content = { kind: 'literal', text: `Opening screen.\n\n${paragraphs}` };
  world.nodes[0].actions = { choices: [
    { id: 'report', label: { kind: 'literal', text: 'Add a short report' }, effects: [{ kind: 'append-scene-text', text: { kind: 'literal', text: 'New report.' } }] },
    { id: 'long-report', label: { kind: 'literal', text: 'Add a long report' }, effects: [{ kind: 'append-scene-text', text: { kind: 'literal', text: `## Response starts here\n\n${paragraphs}\n\nResponse ends here.` } }] },
    { id: 'replace', label: { kind: 'literal', text: 'Replace the screen' }, effects: [{ kind: 'show-scene-text', text: { kind: 'literal', text: `Replacement starts here.\n\n${paragraphs}` } }] },
    { id: 'restore', label: { kind: 'literal', text: 'Restore the screen' }, effects: [{ kind: 'reset-scene-text' }] },
  ], commands: [
    { id: 'report-command', patterns: ['report'], parameters: [], effects: [{ kind: 'append-scene-text', text: { kind: 'literal', text: 'Command report.' } }] },
    { id: 'empty-report', patterns: ['empty'], parameters: [], effects: [{ kind: 'append-scene-text', text: { kind: 'literal', text: '' } }] },
  ] };
  const files = {
    'project.json': new Uint8Array(await readFile('fixtures/linear-three-nodes/project.json')),
    'world.json': new TextEncoder().encode(JSON.stringify(world)),
    'locales/en-GB.json': new Uint8Array(await readFile('fixtures/linear-three-nodes/locales/en-GB.json')),
  };
  await page.goto('/');
  await page.getByLabel('Import project ZIP').setInputFiles({ name: 'autoscroll-project.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export game ZIP' }).click();
  await warnings(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  const exported = unzipSync(new Uint8Array(await readFile((await (await downloading).path())!)));
  const directory = await mkdtemp(join(tmpdir(), 'ds-autoscroll-'));
  await writeFile(join(directory, 'index.html'), exported['index.html']!);
  const portable = await context.newPage();
  await portable.goto(pathToFileURL(join(directory, 'index.html')).href);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await warnings(page);
  const invitation = page.getByRole('button', { name: 'Not now', exact: true });
  if (await invitation.isVisible()) await invitation.click();
  for (const surface of [page, portable]) {
    await surface.bringToFront();
    await surface.emulateMedia({ reducedMotion: 'reduce' });
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
      await surface.setViewportSize(viewport);
      // Dynamic viewport units settle on the next frame after a browser resize.
      await surface.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const content = surface.getByRole('region', { name: 'Scene text', exact: true });
      const unusedWidth = await content.evaluate(element => {
        const scene = element.closest('.ds-player__scene')!;
        const style = getComputedStyle(scene);
        return scene.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - element.getBoundingClientRect().width;
      });
      expect(Math.abs(unusedWidth)).toBeLessThan(2);
      const controls = surface.locator('.ds-player__choices');
      const position = () => controls.evaluate(element => element.getBoundingClientRect().top + window.scrollY);
      const before = await position();
      const height = await content.evaluate(element => element.clientHeight);
      const visible = (text: string) => content.evaluate((element, value) => {
        const target = [...element.children].filter(child => child.textContent === value).at(-1);
        if (!target) return false;
        const bounds = target.getBoundingClientRect();
        const pane = element.getBoundingClientRect();
        return bounds.top >= Math.max(0, pane.top) - 2 && bounds.bottom <= Math.min(window.innerHeight, pane.bottom) + 2;
      }, text);
      // Content presence alone cannot prove scroll behavior. Check its actual visible geometry.
      for (let index = 0; index < 3; index++) {
        await content.evaluate(element => { element.scrollTop = 0; });
        await surface.getByRole('button', { name: /Add a short report/ }).click();
        await expect.poll(() => visible('New report.')).toBe(true);
        const after = await position();
        expect(Math.abs(after - before), JSON.stringify({ surface: surface === page ? 'hosted' : 'exported', viewport, before, after })).toBeLessThan(2);
        expect(await content.evaluate(element => element.clientHeight)).toBe(height);
      }
      const input = surface.getByRole('textbox', { name: 'Type an action' });
      await input.fill('report');
      await input.press('Enter');
      await expect.poll(() => visible('Command report.')).toBe(true);
      await expect(input).toBeFocused();
      await surface.getByRole('button', { name: /Add a long report/ }).click();
      await expect.poll(() => visible('Response starts here')).toBe(true);
      expect(Math.abs(await position() - before)).toBeLessThan(2);
      await surface.screenshot({ path: test.info().outputPath(`${surface === page ? 'hosted' : 'exported'}-${viewport.width}-autoscroll.png`) });
      // The first paragraph is visible even when a single new response is taller than the pane.
      await content.evaluate(element => { element.scrollTop = 0; });
      await surface.getByRole('button', { name: 'Settings', exact: true }).click();
      await surface.getByRole('button', { name: 'Close settings', exact: true }).click();
      expect(await content.evaluate(element => element.scrollTop)).toBe(0);
      await content.evaluate(element => { element.scrollTop = 100; });
      await input.fill('empty');
      await input.press('Enter');
      await expect(input).toHaveValue('');
      await surface.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await content.evaluate(element => element.scrollTop)).toBe(100);
      await surface.getByRole('button', { name: /Replace the screen/ }).click();
      await expect.poll(() => content.evaluate(element => element.scrollTop)).toBe(0);
      await expect.poll(() => visible('Replacement starts here.')).toBe(true);
      await surface.getByRole('button', { name: /Add a short report/ }).click();
      await expect.poll(() => visible('New report.')).toBe(true);
      await surface.getByRole('button', { name: /Restore the screen/ }).click();
      await expect.poll(() => content.evaluate(element => element.scrollTop)).toBe(0);
      await expect.poll(() => visible('Opening screen.')).toBe(true);
    }
  }
});
