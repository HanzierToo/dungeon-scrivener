import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync, zipSync } from 'fflate';

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  const invite = page.getByRole('button', { name: 'Not now', exact: true });
  if (await invite.isVisible()) await invite.click();
  const guide = page.getByRole('button', { name: 'Dismiss starter guide' });
  if (await guide.isVisible()) await guide.click();
}
async function warnings(page: Page) {
  const acknowledge = page.getByRole('button', { name: 'Acknowledge and continue' });
  if (await acknowledge.isVisible()) await acknowledge.click();
}
async function projectBytes(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await warnings(page);
  return unzipSync(new Uint8Array(await readFile((await (await pending).path())!)));
}

test('feedback: phrases preserve spaces and escaped separators; incomplete creations can be deleted', async ({ page }) => {
  await start(page);
  const inspector = page.getByLabel('Story inspector');
  const diagnostics = page.getByLabel('Project diagnostics', { exact: true });
  const initialHeight = (await diagnostics.boundingBox())!.height;
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  await inspector.getByRole('button', { name: 'Add command', exact: true }).click();
  const command = inspector.locator('.apprentice-command');
  const phrases = command.getByRole('textbox', { name: 'Command phrases' });
  await phrases.fill(String.raw`say help, say Help | say hello\, friend | say a\|b`);
  await expect(phrases).toHaveValue(String.raw`say help, say Help | say hello\, friend | say a\|b`);
  await expect(command.getByText('Values captured from player input (optional)', { exact: true })).toBeVisible();
  await command.getByRole('button', { name: 'Add input value' }).click();
  await command.getByRole('button', { name: 'Remove input value' }).click();
  await inspector.getByRole('tab', { name: 'World' }).click();
  await inspector.getByRole('button', { name: 'Add world state', exact: true }).click();
  await expect(inspector.getByRole('combobox', { name: 'Type', exact: true })).toHaveValue('boolean');
  await expect(inspector.getByRole('combobox', { name: 'Default', exact: true })).toHaveValue('false');
  await inspector.getByRole('navigation', { name: 'World sections' }).getByRole('button', { name: /Actors & events/ }).click();
  const events = inspector.getByLabel('Events browser');
  await events.getByRole('button', { name: 'Add event', exact: true }).click();
  await events.getByRole('button', { name: 'Add state field' }).click();
  await events.getByRole('textbox', { name: 'Key', exact: true }).fill('');
  await events.getByRole('button', { name: 'Add event', exact: true }).click();
  await events.getByRole('textbox', { name: 'Event ID' }).fill('');
  await events.locator('.apprentice-collection__list button').last().click();
  await events.getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(events.locator('.apprentice-collection__list button')).toHaveCount(1);
  await events.locator('.apprentice-collection__list button').click();
  await events.getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(events).toContainText('No events yet.');
  expect((await diagnostics.boundingBox())!.height).toBe(initialHeight);
  const files = await projectBytes(page);
  const world = JSON.parse(strFromU8(files['world.json']!));
  expect(world.nodes[0].actions.commands[0].patterns).toEqual(['say help', 'say Help', 'say hello, friend', 'say a|b']);
  expect(world.nodes[0].actions.commands[0].parameters).toEqual([]);
  expect(world.eventDefinitions).toEqual([]);
  expect(world.stateDefinitions.at(-1)).toMatchObject({ valueType: 'boolean', defaultValue: false });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await warnings(page);
  const input = page.getByRole('textbox', { name: 'Type an action' });
  await input.fill('say hello, friend');
  await input.press('Enter');
  await expect(page.getByLabel('Game player')).not.toContainText('No matching command');
});

test('feedback: translation CRUD supports empty languages and an entirely literal project', async ({ page }) => {
  await start(page);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'World' }).click();
  await expect(inspector.getByRole('navigation', { name: 'World sections' }).getByRole('button', { name: 'Translations', exact: true })).toHaveCount(0);
  await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
  const translations = inspector.getByRole('region', { name: 'Translations' });
  await translations.getByRole('textbox', { name: 'New translation key' }).fill('scratch-text');
  await translations.getByRole('button', { name: 'Add key', exact: true }).click();
  await translations.getByRole('textbox', { name: 'Translation text for scratch-text (en-GB)' }).fill('A spare description.');
  await translations.getByRole('textbox', { name: 'Rename translation key' }).fill('room-detail');
  await translations.getByRole('button', { name: 'Rename key and references' }).click();
  await expect(translations.getByRole('textbox', { name: 'Translation text for room-detail (en-GB)' })).toHaveValue('A spare description.');
  await translations.getByRole('textbox', { name: 'New translation language' }).fill('fr-FR');
  await translations.getByRole('button', { name: 'Add language' }).click();
  const keys = translations.getByLabel('Translation keys');
  await keys.locator('button').first().click();
  await keys.locator('button').first().press('ControlOrMeta+a');
  page.once('dialog', dialog => dialog.accept());
  await translations.getByRole('button', { name: 'Delete selected keys' }).click();
  await expect(keys.locator('button')).toHaveCount(0);
  const files = await projectBytes(page);
  expect(JSON.parse(strFromU8(files['locales/en-GB.json']!)).strings).toEqual({});
  expect(JSON.parse(strFromU8(files['locales/fr-FR.json']!)).strings).toEqual({});
  const world = JSON.parse(strFromU8(files['world.json']!));
  expect(world.nodes.every((node: { title: { kind: string }; content: { kind: string } }) => node.title.kind === 'literal' && node.content.kind === 'literal')).toBe(true);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByLabel('Game player')).toContainText('The Old Gate');
});

test('feedback: more actions and routes focus their own action; geometry persists and deselection clears details', async ({ page }) => {
  await start(page);
  const inspector = page.getByLabel('Story inspector');
  const graph = page.getByLabel('Apprentice node graph');
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  for (let index = 0; index < 4; index++) {
    await inspector.getByRole('button', { name: 'Add choice', exact: true }).click();
    await inspector.locator('.apprentice-choice').getByRole('textbox', { name: 'Text', exact: true }).fill(`Inspect detail ${index}`);
  }
  await graph.getByRole('button', { name: '+3 more actions', exact: true }).click();
  await expect(inspector.locator('.apprentice-choice').getByRole('textbox', { name: 'Text', exact: true })).toHaveValue('Inspect detail 1');
  const route = graph.locator('.react-flow__edge[data-id="gate-to-tower"]');
  const label = route.getByRole('button', { name: 'Route action: Climb to the watchtower' });
  await label.click();
  await expect(inspector.locator('.apprentice-choice').getByRole('textbox', { name: 'Text', exact: true })).toHaveValue('Climb to the watchtower');
  const original = await route.locator('.react-flow__edge-path').getAttribute('d');
  await label.press('ArrowRight');
  await expect(route.locator('.react-flow__edge-path')).not.toHaveAttribute('d', original!);
  const center = (await label.boundingBox())!;
  await page.mouse.move(center.x + center.width / 2, center.y + center.height / 2);
  await page.mouse.down();
  await page.mouse.move(center.x + center.width / 2 + 30, center.y + center.height / 2 + 25, { steps: 8 });
  await page.mouse.up();
  await page.screenshot({ path: test.info().outputPath('route-center-and-action.png') });
  const files = await projectBytes(page);
  const layout = JSON.parse(strFromU8(files['studio/graph-layout.json']!));
  expect(layout.routeCenters['gate-to-tower']).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  const path = (await (await pending).path())!;
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Import project ZIP').setInputFiles(path);
  await page.getByRole('button', { name: 'Apprentice', exact: true }).click();
  await expect(graph.locator('.react-flow__edge[data-id="gate-to-tower"] .react-flow__edge-path')).not.toHaveAttribute('d', original!);
  await graph.locator('.react-flow__pane').click({ position: { x: 8, y: 80 } });
  await expect(inspector).toContainText('Select a node to edit its content and actions.');
  await expect(inspector.locator('.apprentice-choice')).toHaveCount(0);
});

test('feedback: clicking diagnostics opens the affected Apprentice action without changing panel height', async ({ page }) => {
  const world = JSON.parse(await readFile('fixtures/linear-three-nodes/world.json', 'utf8'));
  world.nodes[0].actions.choices[0].condition = { kind: 'compare-state', left: { scope: { kind: 'world' }, key: 'lantern-lit' }, operator: 'eq', right: '' };
  const buffer = Buffer.from(zipSync({
    'project.json': new Uint8Array(await readFile('fixtures/linear-three-nodes/project.json')),
    'world.json': new TextEncoder().encode(JSON.stringify(world)),
    'locales/en-GB.json': new Uint8Array(await readFile('fixtures/linear-three-nodes/locales/en-GB.json')),
  }));
  await page.goto('/');
  await page.getByLabel('Import project ZIP').setInputFiles({ name: 'invalid-condition.zip', mimeType: 'application/zip', buffer });
  await page.getByRole('button', { name: 'Apprentice', exact: true }).click();
  const diagnostics = page.getByLabel('Project diagnostics', { exact: true });
  await diagnostics.getByRole('button').filter({ hasText: 'DS-MOD-049' }).click();
  const inspector = page.getByLabel('Story inspector');
  await expect(inspector.getByRole('tab', { name: 'Actions', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(inspector.locator('.apprentice-choice')).toContainText('open-gate');
  const initial = (await diagnostics.boundingBox())!.height;
  const condition = inspector.getByRole('group', { name: 'Condition', exact: true });
  await condition.getByRole('combobox', { name: 'State key' }).selectOption('');
  await condition.getByRole('combobox', { name: 'State key' }).selectOption('lantern-lit');
  expect((await diagnostics.boundingBox())!.height).toBe(initial);
  await expect(diagnostics).not.toContainText('DS-MOD-049');
});

test('feedback: an action replaces scene text in place, resets on travel, and survives export and save', async ({ page, context }) => {
  await start(page);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  await inspector.getByRole('button', { name: 'Add choice', exact: true }).click();
  const choice = inspector.locator('.apprentice-choice');
  await choice.getByRole('textbox', { name: 'Text', exact: true }).fill('Look at the table');
  await choice.getByRole('combobox', { name: 'Scene text response' }).selectOption('show-scene-text');
  await choice.getByRole('group', { name: 'Response text', exact: true }).getByRole('textbox', { name: 'Text', exact: true }).fill('A small brass key lies on the table.');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByLabel('Game player').getByRole('button', { name: /Look at the table/ }).click();
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Old Gate');
  await expect(page.locator('.ds-player__scene')).toContainText('A small brass key lies on the table.');
  await page.screenshot({ path: test.info().outputPath('in-place-response.png') });
  await expect(page.getByLabel('Game player').getByRole('button', { name: /Climb to the watchtower/ })).toBeVisible();
  await page.getByRole('button', { name: 'Apprentice', exact: true }).click();
  const files = await projectBytes(page);
  const world = JSON.parse(strFromU8(files['world.json']!));
  world.savePolicy = { enabled: true, slotCount: 1, allowedLocation: 'anywhere' };
  files['world.json'] = new TextEncoder().encode(JSON.stringify(world));
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Import project ZIP').setInputFiles({ name: 'responses.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export game ZIP' }).click();
  await warnings(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  const exported = unzipSync(new Uint8Array(await readFile((await (await pending).path())!)));
  const directory = await mkdtemp(join(tmpdir(), 'ds-response-'));
  const indexPath = join(directory, 'index.html');
  await writeFile(indexPath, exported['index.html']!);
  const player = await context.newPage();
  await player.goto(pathToFileURL(indexPath).href);
  await player.getByRole('button', { name: /Look at the table/ }).click();
  await expect(player.locator('.ds-player__scene')).toContainText('A small brass key lies on the table.');
  const saving = player.waitForEvent('download');
  await player.getByRole('button', { name: 'Save game', exact: true }).click();
  const savePath = (await (await saving).path())!;
  const save = JSON.parse(strFromU8(unzipSync(new Uint8Array(await readFile(savePath)))['save.json']!));
  expect(save.session.sceneText).toEqual({ nodeId: 'old-gate', text: { kind: 'literal', text: 'A small brass key lies on the table.' } });
  await player.getByRole('button', { name: /Climb to the watchtower/ }).click();
  await expect(player.locator('.ds-player__scene h2')).toHaveText('The Watchtower');
  await expect(player.locator('.ds-player__scene')).not.toContainText('A small brass key lies on the table.');
  await player.getByLabel('Choose a game save file').setInputFiles(savePath);
  await expect(player.locator('.ds-player__scene h2')).toHaveText('The Old Gate');
  await expect(player.locator('.ds-player__scene')).toContainText('A small brass key lies on the table.');
});

test('feedback: global notifications dismiss in three seconds and remain visible over fullscreen', async ({ page }) => {
  await start(page);
  const initial = page.locator('.studio-toast');
  if (await initial.isVisible()) await initial.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(initial).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Title text (en-GB)' }).fill('The Quiet Gate');
  await expect(initial).toBeVisible();
  await page.getByRole('button', { name: 'Workspace full screen', exact: true }).click();
  await expect(initial).toBeVisible();
  await expect(page.getByLabel('Project diagnostics', { exact: true })).toBeVisible();
  await expect(initial).toHaveCount(0, { timeout: 4500 });
});
