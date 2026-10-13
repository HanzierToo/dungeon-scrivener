import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { zipSync, unzipSync, strFromU8 } from 'fflate';

async function dismiss(page: Page) {
  const invite = page.getByRole('button', { name: 'Not now', exact: true });
  if (await invite.isVisible()) await invite.click();
  const guide = page.getByRole('button', { name: 'Dismiss starter guide' });
  if (await guide.isVisible()) await guide.click();
}
async function warnings(page: Page) {
  const button = page.getByRole('button', { name: 'Acknowledge and continue' });
  if (await button.isVisible()) await button.click();
}

test('outcomes: authoring orders outcomes, shares routes, opens branches, removes sole routes, and preserves ZIP data', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await dismiss(page);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  await inspector.getByRole('button', { name: 'Add choice', exact: true }).click();
  const choice = inspector.locator('.apprentice-choice');
  await choice.getByRole('group', { name: 'Choice label', exact: true }).getByRole('textbox', { name: 'Text', exact: true }).fill('Inspect the gate');
  const fallback = choice.locator('.apprentice-fallback');
  await fallback.getByRole('combobox', { name: 'Scene text response' }).selectOption('show-scene-text');
  await fallback.getByRole('group', { name: 'Response text', exact: true }).getByRole('textbox', { name: 'Text', exact: true }).fill('First inspection.');
  await fallback.getByRole('button', { name: 'Add effect', exact: true }).click();
  await fallback.getByRole('combobox', { name: 'State key', exact: true }).selectOption('lantern-lit');
  await fallback.getByRole('combobox', { name: 'Value', exact: true }).selectOption('true');
  const browser = choice.getByLabel('Conditional outcomes browser');
  for (const [name, destination] of [['Repeat inspection', 'watchtower'], ['Later repeat', 'lantern-house']]) {
    await browser.getByRole('button', { name: 'Add conditional outcome', exact: true }).click();
    const outcome = choice.locator('.apprentice-outcome');
    await outcome.getByRole('textbox', { name: 'Outcome name' }).fill(name!);
    await outcome.getByRole('combobox', { name: 'Requirement', exact: true }).selectOption('compare-state');
    await outcome.getByRole('combobox', { name: 'State key', exact: true }).selectOption('lantern-lit');
    await outcome.getByRole('combobox', { name: 'Compared value' }).selectOption('true');
    await outcome.getByRole('combobox', { name: 'Outcome destination', exact: true }).selectOption(destination!);
  }
  await choice.getByRole('button', { name: 'Check earlier', exact: true }).click();
  await expect(browser.locator('.apprentice-collection__list button').first()).toContainText('Later repeat');
  await expect(choice.getByRole('textbox', { name: 'Outcome name' })).toHaveValue('Later repeat');
  await choice.getByRole('button', { name: 'Check later', exact: true }).click();
  await expect(browser.locator('.apprentice-collection__list button').first()).toContainText('Repeat inspection');
  const uniqueRoute = page.locator('.react-flow__edge').filter({ hasText: 'Inspect the gate: Later repeat' });
  await expect(uniqueRoute).toHaveCount(1);
  await uniqueRoute.getByRole('button', { name: 'Route action: Inspect the gate: Later repeat' }).click();
  await expect(choice.getByRole('textbox', { name: 'Outcome name' })).toHaveValue('Later repeat');
  await choice.getByRole('button', { name: 'Remove outcome', exact: true }).click();
  await expect(page.locator('.react-flow__edge').filter({ hasText: 'Inspect the gate: Later repeat' })).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await warnings(page);
  const files = unzipSync(new Uint8Array(await readFile((await (await pending).path())!)));
  const world = JSON.parse(strFromU8(files['world.json']!));
  const authored = world.nodes[0].actions.choices.find((item: { label: { text?: string } }) => item.label.text === 'Inspect the gate');
  expect(authored.outcomes).toHaveLength(1);
  expect(authored.outcomes[0]).toMatchObject({ name: 'Repeat inspection', navigationEdgeId: 'gate-to-tower' });
  expect(world.navigationEdges).toHaveLength(4);
  await page.screenshot({ path: test.info().outputPath('conditional-outcomes-editor.png') });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await warnings(page);
  const player = page.getByLabel('Game player');
  await player.getByRole('button', { name: /Inspect the gate/ }).click();
  await expect(player).toContainText('First inspection.');
  await player.getByRole('button', { name: /Inspect the gate/ }).click();
  await expect(page.locator('.ds-player__scene h2')).toHaveText('The Watchtower');
});

test('outcomes: choices and commands vary text, items, and destinations in hosted and exported play, with atomic rollback', async ({ page, context }) => {
  const world = JSON.parse(await readFile('fixtures/linear-three-nodes/world.json', 'utf8'));
  const compare = (key: string, right: boolean) => ({ kind: 'compare-state', left: { scope: { kind: 'world' }, key }, operator: 'eq', right });
  const state = (key: string, value: boolean) => ({ kind: 'set-state', target: { scope: { kind: 'world' }, key }, value });
  const response = (text: string) => ({ kind: 'show-scene-text', text: { kind: 'literal', text } });
  const item = (itemId: string) => ({ kind: 'add-item', owner: { kind: 'world' }, itemId, quantity: 1 });
  for (const key of ['desk-checked', 'night']) {
    world.stateDefinitions.push({ key, scopeKind: 'world', valueType: 'boolean', defaultValue: false }); world.worldState[key] = false;
  }
  world.itemDefinitions = ['copper-token', 'silver-token'].map(id => ({ id, name: { kind: 'literal', text: id === 'copper-token' ? 'Copper token' : 'Silver token' }, stackLimit: 10, canContain: false, fields: [] }));
  world.nodes[0].actions = { choices: [
    { id: 'inspect', label: { kind: 'literal', text: 'Inspect the desk' }, effects: [state('desk-checked', true), response('A token lies on the desk.'), item('copper-token')], outcomes: [
      { id: 'repeat', name: 'Already inspected', condition: compare('desk-checked', true), effects: [response('The desk is now empty.')] },
      { id: 'overlap', name: 'Later overlapping match', condition: compare('desk-checked', true), effects: [response('This later match must not run.'), item('silver-token')] },
    ] },
    { id: 'nightfall', label: { kind: 'literal', text: 'Wait until night' }, effects: [state('night', true)] },
    { id: 'depart', label: { kind: 'literal', text: 'Leave the gate' }, effects: [item('copper-token')], navigationEdgeId: 'gate-to-bridge', outcomes: [
      { id: 'night-route', name: 'At night', condition: compare('night', true), effects: [item('silver-token')], navigationEdgeId: 'gate-to-home' },
    ] },
  ], commands: [{ id: 'check', patterns: ['check desk'], parameters: [], effects: [response('Command fallback.')], outcomes: [
    { id: 'unchecked', name: 'First check', condition: compare('desk-checked', false), effects: [state('desk-checked', true), response('Command first check.')] },
    { id: 'checked', name: 'Repeat check', condition: compare('desk-checked', true), effects: [response('Command repeat check.')] },
  ] }] };
  world.navigationEdges.push({ id: 'gate-to-home', fromNodeId: 'old-gate', toNodeId: 'lantern-house' }, { id: 'bridge-to-gate', fromNodeId: 'stone-bridge', toNodeId: 'old-gate' }, { id: 'home-to-gate', fromNodeId: 'lantern-house', toNodeId: 'old-gate' });
  for (const [node, edge] of [[world.nodes[1], 'bridge-to-gate'], [world.nodes[2], 'home-to-gate']]) node.actions = { choices: [{ id: `return-${node.id}`, label: { kind: 'literal', text: 'Return to gate' }, effects: [], navigationEdgeId: edge }] };
  const files = { 'world.json': new TextEncoder().encode(JSON.stringify(world)), 'project.json': new Uint8Array(await readFile('fixtures/linear-three-nodes/project.json')), 'locales/en-GB.json': new Uint8Array(await readFile('fixtures/linear-three-nodes/locales/en-GB.json')) };
  await page.goto('/');
  await page.getByLabel('Import project ZIP').setInputFiles({ name: 'conditional-outcomes.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export game ZIP' }).click();
  await warnings(page);
  await page.getByRole('button', { name: 'Build and download' }).click();
  const exported = unzipSync(new Uint8Array(await readFile((await (await pending).path())!)));
  const directory = await mkdtemp(join(tmpdir(), 'ds-outcomes-'));
  await writeFile(join(directory, 'index.html'), exported['index.html']!);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await warnings(page);
  const portable = await context.newPage();
  await portable.goto(pathToFileURL(join(directory, 'index.html')).href);
  for (const surface of [page, portable]) {
    await surface.getByRole('button', { name: /Inspect the desk/ }).click();
    await expect(surface.locator('.ds-player__scene')).toContainText('A token lies on the desk.');
    await surface.getByRole('button', { name: /Inspect the desk/ }).click();
    await expect(surface.locator('.ds-player__scene')).toContainText('The desk is now empty.');
    await expect(surface.locator('.ds-player')).not.toContainText('This later match must not run.');
    await surface.getByRole('textbox', { name: 'Type an action' }).fill('check desk');
    await surface.getByRole('textbox', { name: 'Type an action' }).press('Enter');
    await expect(surface.locator('.ds-player__scene')).toContainText('Command repeat check.');
    await surface.getByRole('button', { name: /Leave the gate/ }).click();
    await expect(surface.locator('.ds-player__scene h2')).toHaveText('The Stone Bridge');
    await surface.getByRole('button', { name: /Return to gate/ }).click();
    await surface.getByRole('button', { name: /Wait until night/ }).click();
    await surface.getByRole('button', { name: /Leave the gate/ }).click();
    await expect(surface.locator('.ds-player__scene h2')).toHaveText('Home Before Dark');
    await expect(surface.locator('.ds-player')).toContainText('Silver token');
  }
  const proof = await portable.evaluate(() => {
    const global = window as unknown as Record<string, any>;
    const runtime = global.DungeonScrivenerPlayer.portablePlayerRuntime ?? global.DungeonScrivenerPlayer;
    const data = JSON.parse(document.getElementById('dungeon-scrivener-game-data')!.textContent!);
    const engine = runtime.engine.createGameEngine({ seededSeedSource: { nextUint32: () => 0 }, unseededRandomSource: { nextUint32: () => 0 }, mediaAssets: { resolveAsset: () => ({ ok: false }) } }, data.scripts);
    const created = engine.createSession(data.manifest.projectId, data.world, { wallClockEpochMilliseconds: 1000, visibility: 'visible', focused: true });
    if (!created.ok) throw Error(JSON.stringify(created.diagnostics));
    const first = engine.dispatchPlayerInput(data.world, created.snapshot, { kind: 'command-text', rawText: 'check desk' });
    const changed = structuredClone(data.world);
    changed.nodes[0].actions.commands[0].outcomes[1].effects = [{ kind: 'set-state', target: { scope: { kind: 'world' }, key: 'desk-checked' }, value: false }, { kind: 'navigate', edgeId: 'home-to-gate' }];
    const failed = engine.dispatchPlayerInput(changed, first.snapshot, { kind: 'command-text', rawText: 'check desk' });
    return { first: first.snapshot.sceneText.text.text, firstState: first.snapshot.state.world['desk-checked'], firstErrors: first.diagnostics.diagnostics, trace: first.trace.map((record: any) => record.reason), rolledBack: JSON.stringify(failed.snapshot) === JSON.stringify(first.snapshot), failureCount: failed.diagnostics.diagnostics.length };
  });
  expect(proof).toMatchObject({ first: 'Command first check.', firstState: true, firstErrors: [], rolledBack: true, failureCount: 1 });
  expect(proof.trace.some((reason: string) => reason.includes('First check') && reason.includes('matched and selected'))).toBe(true);
  await page.screenshot({ path: test.info().outputPath('conditional-outcomes-player.png') });
});
