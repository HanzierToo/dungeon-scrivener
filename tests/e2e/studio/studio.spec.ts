import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync, zipSync } from 'fflate';

async function tavernZip(variant?: 'script' | 'validation' | 'fallback' | 'theme' | 'unsafe-theme' | 'save' | 'no-alt' | 'corrupt-asset' | 'large'): Promise<Buffer> {
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
        if (variant === 'large' && archivePath === 'world.json') {
          const world = JSON.parse(new TextDecoder().decode(bytes));
          for (let index = 0; index < 160; index += 1) {
            world.stateDefinitions.push({ key: `scale-state-${index}`, scopeKind: 'world', valueType: 'integer', defaultValue: 0 });
            world.worldState[`scale-state-${index}`] = 0;
            world.nodes.push({ id: `scale-scene-${index}`, parentId: null, visitable: true, title: { kind: 'literal', text: `Scale scene ${index}` }, content: { kind: 'literal', text: `Scene ${index}` } });
            world.navigationEdges.push({ id: `scale-edge-${index}`, fromNodeId: index === 0 ? 'taproom' : `scale-scene-${index - 1}`, toNodeId: `scale-scene-${index}` });
          }
          contents = new TextEncoder().encode(JSON.stringify(world));
        }
        if (variant === 'large' && archivePath === 'locales/en-GB.json') {
          const locale = JSON.parse(new TextDecoder().decode(bytes));
          for (let index = 0; index < 160; index += 1) locale.strings[`scale-text-${index}`] = `Line ${index}`;
          contents = new TextEncoder().encode(JSON.stringify(locale));
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

async function invalidComparisonZip(): Promise<Buffer> {
  const root = resolve('fixtures/linear-three-nodes');
  const world = JSON.parse(await readFile(join(root, 'world.json'), 'utf8'));
  world.stateDefinitions.push({ key: 'start-looked-around', scopeKind: 'world', valueType: 'boolean', defaultValue: false });
  world.worldState['start-looked-around'] = false;
  world.nodes[0].actions.choices[0].condition = { kind: 'compare-state', left: { scope: { kind: 'world' }, key: 'start-looked-around' }, operator: 'eq', right: '' };
  return Buffer.from(zipSync({
    'project.json': new Uint8Array(await readFile(join(root, 'project.json'))),
    'world.json': new TextEncoder().encode(JSON.stringify(world)),
    'locales/en-GB.json': new Uint8Array(await readFile(join(root, 'locales/en-GB.json'))),
  }));
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

async function dismissTourInvite(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('dialog', { name: 'Find your way around the studio' }).getByRole('button', { name: 'Not now' }).click();
}

test('invalid typed condition blocks Play without leaving the editable project or changing its ZIP', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'invalid-condition.zip', mimeType: 'application/zip', buffer: await invalidComparisonZip() });
  await page.getByRole('button', { name: 'Apprentice' }).click();
  await expect(page.locator('#project-diagnostics')).toContainText('DS-MOD-049');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Action could not continue' })).toContainText('start-looked-around');
  await expect(page.getByLabel('Apprentice node graph')).toBeVisible();
  await page.getByRole('dialog', { name: 'Action could not continue' }).getByRole('button', { name: 'Close' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const world = JSON.parse(strFromU8(saved['world.json']!));
  expect(world.nodes[0].actions.choices[0].condition.right).toBe('');

  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  const condition = inspector.getByRole('group', { name: 'Condition' });
  await condition.getByRole('combobox', { name: 'State key' }).selectOption('');
  await condition.getByRole('combobox', { name: 'State key' }).selectOption('start-looked-around');
  await expect(condition.getByRole('combobox', { name: 'Compared value' })).toHaveValue('false');
  await expect(page.locator('#project-diagnostics')).not.toContainText('DS-MOD-049');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByLabel('Game player')).toContainText('The Old Gate');
});

test('an unexpected player error returns to the editor with recent project edits intact', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('textbox', { name: 'Title text (en-GB)' }).fill('Recovered Gate');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByLabel('Game player')).toBeVisible();
  await page.evaluate(() => { void Promise.reject(new Error('simulated player failure')); });
  await expect(page.getByRole('dialog', { name: 'Action could not continue' })).toContainText('simulated player failure');
  await expect(page.getByLabel('Apprentice node graph')).toBeVisible();
  await page.getByRole('dialog', { name: 'Action could not continue' }).getByRole('button', { name: 'Close' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const locale = JSON.parse(strFromU8(saved['locales/en-GB.json']!));
  expect(locale.strings['gate-title']).toBe('Recovered Gate');
});

test('new-project tour is optional, guided, replayable, and remembered', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  const invite = page.getByRole('dialog', { name: 'Find your way around the studio' });
  await expect(invite).toBeVisible();
  expect(await invite.evaluate(element => element.matches(':modal'))).toBe(false);
  await invite.getByRole('button', { name: 'Start tour' }).click();
  const tour = page.getByRole('dialog', { name: 'One project, two ways to write' });
  await expect(tour).toBeVisible();
  await expect(page.locator('.tour-spotlight')).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  const scrollBeforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.move(1, 1);
  await page.mouse.wheel(0, 500);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeWheel);
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('dialog', { name: 'Apprentice or Sage?' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('dialog', { name: 'See where the story leads' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apprentice' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.tour-layer')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dungeon-scrivener-studio-tour-v1'))).toBe('skipped');

  await page.getByRole('button', { name: 'Take the tour' }).click();
  for (let index = 1; index <= 6; index += 1) {
    await expect(page.locator('.tour-progress')).toHaveAttribute('aria-label', `Step ${index} of 7`);
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.locator('.tour-progress')).toHaveAttribute('aria-label', 'Step 7 of 7');
  await page.getByRole('button', { name: 'Finish tour' }).click();
  await expect(page.locator('.tour-layer')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dungeon-scrivener-studio-tour-v1'))).toBe('finished');
  await expect(page.getByLabel('Game tutorial invitation')).toBeVisible();
  await page.getByLabel('Game tutorial invitation').getByRole('button', { name: 'Start tutorial' }).click();
  await expect(page.getByRole('dialog', { name: 'Start with a scene' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit tour' }).click();
  await expect(page.locator('.tour-layer')).toHaveCount(0);

  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(invite).not.toBeVisible();
});

test('narrow-screen tour keeps its spotlight and controls on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('dialog', { name: 'Find your way around the studio' }).getByRole('button', { name: 'Start tour' }).click();
  await expect.poll(() => page.evaluate(() => {
    const target = document.querySelector('[data-tour="project-heading"]')?.getBoundingClientRect();
    const spotlight = document.querySelector('.tour-spotlight')?.getBoundingClientRect();
    const card = document.querySelector('.tour-card')?.getBoundingClientRect();
    return Boolean(target && spotlight && card && target.top >= 0 && target.bottom < innerHeight && Math.abs(target.top - spotlight.top) < 20 && card.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth);
  })).toBe(true);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('dialog', { name: 'Apprentice or Sage?' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit tour' }).click();
  await page.getByRole('button', { name: 'Apprentice' }).click();
  await expect.poll(() => page.locator('.react-flow__node').evaluateAll(nodes => {
    const first = nodes[0]?.getBoundingClientRect();
    const second = nodes[1]?.getBoundingClientRect();
    return Boolean(first && second && (Math.abs(second.y - first.y) > 10 || Math.abs(second.x - first.x) > 50) && first.width > 100);
  })).toBe(true);
});

test('Sage preference leads into the file-based game tutorial', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  const invite = page.getByRole('dialog', { name: 'Find your way around the studio' });
  await invite.getByRole('radio', { name: 'Sage · source files' }).check();
  await invite.getByRole('button', { name: 'Start tour' }).click();
  for (let index = 1; index <= 6; index += 1) {
    await expect(page.locator('.tour-progress')).toHaveAttribute('aria-label', `Step ${index} of 7`);
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.locator('.tour-progress')).toHaveAttribute('aria-label', 'Step 7 of 7');
  await page.getByRole('button', { name: 'Finish tour' }).click();
  await expect(page.getByRole('button', { name: 'Sage' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Game tutorial invitation').getByRole('button', { name: 'Start tutorial' }).click();
  await expect(page.getByRole('dialog', { name: 'Find the game files' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit tour' }).click();
});

test('Sage Explorer supports hierarchy, context actions, closable tabs, and editor indentation', async ({ page }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Sage' }).click();
  const explorer = page.getByRole('complementary', { name: 'Project files' });
  await expect(explorer.getByRole('button', { name: 'locales', exact: true })).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'en-GB.json', exact: true })).toBeVisible();
  await explorer.getByRole('combobox', { name: 'Explorer view' }).selectOption('flat');
  await expect(explorer.getByRole('button', { name: 'locales/en-GB.json', exact: true })).toBeVisible();
  await explorer.getByRole('combobox', { name: 'Explorer sort' }).selectOption('type');
  await explorer.getByRole('button', { name: 'locales/en-GB.json', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'en-GB.json' })).toBeVisible();
  await page.getByRole('button', { name: 'Apprentice' }).click();
  await page.getByRole('button', { name: 'Sage' }).click();
  await expect(page.getByRole('tab', { name: 'en-GB.json' })).toBeVisible();
  await page.getByRole('button', { name: 'Close locales/en-GB.json' }).click();
  await expect(page.getByRole('tab', { name: 'en-GB.json' })).toHaveCount(0);
  await explorer.getByRole('textbox', { name: 'New path' }).fill('notes.txt');
  await explorer.getByRole('button', { name: 'New file' }).click();
  const editor = page.locator('.cm-content');
  await editor.fill('First line');
  await editor.press('Home');
  await editor.press('Tab');
  await expect(editor).toContainText(/\s+First line/u);
  await explorer.getByRole('searchbox', { name: 'Quick open file' }).fill('project.json');
  await explorer.getByRole('searchbox', { name: 'Quick open file' }).press('Enter');
  await expect(page.getByLabel('Editor for project.json')).toBeVisible();
  await explorer.getByRole('searchbox', { name: 'Quick open file' }).fill('notes.txt');
  await explorer.getByRole('searchbox', { name: 'Quick open file' }).press('Enter');
  await expect(editor).toContainText(/\s+First line/u);
  await editor.press('ControlOrMeta+z');
  await expect(editor).toContainText('First line');
  await explorer.getByText('Search project text').click();
  await explorer.getByRole('searchbox', { name: 'Project text query' }).fill('First line');
  await explorer.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(explorer.getByLabel('Project text results')).toContainText('notes.txt:1');
  await explorer.getByRole('button', { name: 'notes.txt', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Actions for notes.txt' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(explorer.getByRole('button', { name: 'notes.txt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'notes.txt' })).toHaveCount(0);
});

test('Sage Explorer background and row menus create in the intended directory', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Sage' }).click();
  const explorer = page.getByRole('complementary', { name: 'Project files' });
  const list = explorer.getByRole('list', { name: 'Explorer entries' });
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await list.click({ button: 'right', position: { x: 12, y: (await list.boundingBox())!.height - 8 } });
  const rootMenu = page.getByRole('menu', { name: 'Explorer background actions' });
  await expect(rootMenu.getByRole('menuitem', { name: 'New file', exact: true })).toBeFocused();
  await rootMenu.getByRole('menuitem', { name: 'New folder', exact: true }).click();
  await rootMenu.getByRole('textbox', { name: 'Folder name' }).fill('chapters');
  await rootMenu.getByRole('textbox', { name: 'Folder name' }).press('Enter');
  await expect(explorer.getByRole('button', { name: 'chapters', exact: true })).toBeVisible();

  await explorer.getByRole('button', { name: 'chapters', exact: true }).click({ button: 'right' });
  const folderMenu = page.getByRole('menu', { name: 'Actions for chapters' });
  await folderMenu.getByRole('menuitem', { name: 'New file in folder' }).click();
  await folderMenu.getByRole('textbox', { name: 'File name' }).fill('notes.txt');
  await folderMenu.getByRole('textbox', { name: 'File name' }).press('Enter');
  await expect(explorer.getByRole('button', { name: 'notes.txt', exact: true })).toBeVisible();
  await expect(page.getByLabel('Editor for chapters/notes.txt')).toBeVisible();

  await explorer.getByRole('button', { name: 'notes.txt', exact: true }).click({ button: 'right' });
  const fileMenu = page.getByRole('menu', { name: 'Actions for chapters/notes.txt' });
  await fileMenu.getByRole('menuitem', { name: 'New file beside this file' }).click();
  await fileMenu.getByRole('textbox', { name: 'File name' }).fill('../escape.txt');
  page.once('dialog', dialog => dialog.accept());
  await fileMenu.getByRole('textbox', { name: 'File name' }).press('Enter');
  await expect(fileMenu).toBeVisible();
  await fileMenu.getByRole('textbox', { name: 'File name' }).fill('sibling.txt');
  await fileMenu.getByRole('textbox', { name: 'File name' }).press('Enter');
  await expect(page.getByLabel('Editor for chapters/sibling.txt')).toBeVisible();
});

test('Sage Explorer selects ranges and deletes a group or focused file from its own surface', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Sage' }).click();
  const explorer = page.getByRole('complementary', { name: 'Project files' });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await explorer.getByRole('textbox', { name: 'New path' }).fill(`notes/${name}`);
    await explorer.getByRole('button', { name: 'New file' }).click();
  }
  await explorer.getByRole('combobox', { name: 'Explorer view' }).selectOption('flat');
  const list = explorer.getByRole('list', { name: 'Explorer entries' });
  const first = list.getByRole('button', { name: 'notes/a.txt', exact: true });
  const middle = list.getByRole('button', { name: 'notes/b.txt', exact: true });
  const last = list.getByRole('button', { name: 'notes/c.txt', exact: true });
  await first.click();
  await last.click({ modifiers: ['Shift'] });
  await expect(explorer.getByLabel('Explorer selection')).toContainText('3 selected');
  await middle.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for notes/b.txt' });
  await expect(menu.getByRole('menuitem', { name: 'Delete selected' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await menu.getByRole('menuitem', { name: 'Delete selected' }).click();
  await expect(first).toHaveCount(0);
  await expect(middle).toHaveCount(0);
  await expect(last).toHaveCount(0);

  await explorer.getByRole('textbox', { name: 'New path' }).fill('notes/d.txt');
  await explorer.getByRole('button', { name: 'New file' }).click();
  const remaining = list.getByRole('button', { name: 'notes/d.txt', exact: true });
  await remaining.click();
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete');
  await expect(remaining).toHaveCount(0);
});

test('The Ashen Bell plays without replacing a project and opens as a copy', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play example' }).click();
  await expect(page.getByRole('heading', { name: 'The Square at Dusk' })).toBeVisible();
  await page.getByRole('button', { name: 'Search the village archive' }).click();
  await expect(page.getByRole('heading', { name: 'The Rain-dark Archive' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to projects' }).click();
  await page.getByRole('button', { name: 'Open editable copy' }).click();
  await expect(page.getByRole('button', { name: 'Apprentice' })).toHaveAttribute('aria-pressed', 'true');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const manifest = JSON.parse(strFromU8(saved['project.json']!)) as { projectId: string; title: string };
  expect(manifest.title).toBe('The Ashen Bell');
  expect(manifest.projectId).not.toBe('the-ashen-bell');
  expect(JSON.parse(strFromU8(saved['studio/graph-layout.json']!)).schemaVersion).toBe(2);
});

test('The Ashen Bell resumes the Keeper after an archive detour', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play example' }).click();
  await page.getByRole('button', { name: 'Visit the bell keeper' }).click();
  await page.getByRole('button', { name: 'Speak to the keeper' }).click();
  await page.getByRole('button', { name: 'Return to the square' }).click();
  await page.getByRole('button', { name: 'Search the village archive' }).click();
  await page.getByRole('button', { name: 'Read the marked ledger' }).click();
  await page.getByRole('button', { name: 'Take the page to the keeper' }).click();
  await expect(page.getByRole('heading', { name: 'Mara, the bell keeper' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Speak to the keeper/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Show her the warning in the ledger' }).click();
  await expect(page.getByText(/Mara reads the page twice/)).toBeVisible();
  await expect(page.locator('.ds-player__inventory li').filter({ hasText: 'Bell key' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Thank Mara' }).click();
  await expect(page.getByRole('heading', { name: 'Mara, the bell keeper' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to the square' }).click();
  await page.getByRole('button', { name: 'Visit the bell keeper' }).click();
  await page.getByRole('button', { name: 'Speak to the keeper' }).click();
  await expect(page.getByRole('button', { name: 'Show her the warning in the ledger' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask about the bell key' }).click();
  await expect(page.getByText(/I have already given you the key/)).toBeVisible();
  await expect(page.locator('.ds-player__inventory li').filter({ hasText: 'Bell key' })).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('The Ashen Bell keeps the ferryman answer visible until acknowledged', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play example' }).click();
  await page.getByRole('button', { name: 'Look for the ferryman' }).click();
  await page.getByRole('textbox', { name: 'Type an action' }).fill('talk to ferryman');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Ask why the bell is silent' }).click();
  await expect(page.getByText(/Mara keeps its key/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Type an action' })).toBeDisabled();
  await page.getByRole('button', { name: 'Thank Ivo' }).click();
  await expect(page.getByRole('heading', { name: 'Ivo, the ferryman' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Type an action' })).toBeEnabled();
});

test('large Apprentice collections keep a bounded list and a searchable editor', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'large-tavern.zip', mimeType: 'application/zip', buffer: await tavernZip('large') });
  await page.getByRole('button', { name: 'Apprentice' }).click();
  const map = page.getByLabel('Apprentice node graph');
  await map.getByRole('searchbox', { name: 'Find scene or logic folder' }).fill('Scale scene 159');
  await map.getByLabel('Map search results').getByRole('button', { name: 'Scale scene 159' }).click();
  await expect(map.getByText('Scene: Scale scene 159')).toBeVisible();
  expect(await map.locator('.react-flow__node').count()).toBeLessThan(100);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
  const translations = inspector.locator('section[aria-label="Translations"]');
  await expect(translations.locator('.apprentice-translations__keys button')).toHaveCount(40);
  await translations.getByRole('searchbox', { name: 'Find a key' }).fill('scale-text-159');
  await translations.getByRole('button', { name: /scale-text-159/ }).click();
  await expect(translations.getByRole('textbox', { name: 'Translation text for scale-text-159 (en-GB)' })).toHaveValue('Line 159');
  await inspector.getByRole('tab', { name: 'World' }).click();
  await inspector.getByRole('navigation', { name: 'World sections' }).getByRole('button', { name: /State/ }).click();
  const definitions = inspector.getByLabel('State definitions browser');
  await expect(definitions.locator('.apprentice-collection__list button')).toHaveCount(40);
  await definitions.getByRole('searchbox', { name: 'Find state definitions' }).fill('scale-state-159');
  await definitions.locator('.apprentice-collection__list').getByRole('button', { name: /scale-state-159/ }).click();
  await expect(definitions.getByRole('group', { name: 'scale-state-159' })).toBeVisible();
  await definitions.getByRole('searchbox', { name: 'Find state definitions' }).fill('trust');
  await definitions.locator('.apprentice-collection__list').getByRole('button', { name: /trust/ }).click();
  await expect(definitions.getByRole('button', { name: 'Remove definition' })).toBeDisabled();
  await definitions.getByRole('textbox', { name: 'State key' }).fill('trust-renamed');
  await definitions.getByRole('button', { name: 'Rename key and references' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const renamedWorld = JSON.parse(strFromU8(saved['world.json']!)) as { worldState: Record<string, number>; stateDefinitions: { key: string }[] };
  expect(renamedWorld.stateDefinitions.some(field => field.key === 'trust-renamed')).toBe(true);
  expect(renamedWorld.worldState['trust-renamed']).toBe(0);
  expect(JSON.stringify(renamedWorld)).not.toContain('"key":"trust"');
});

test('Playtest starts with scene actions and offers its own dismissible tour', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Playtest' }).click();
  await acknowledgeWarnings(page);
  await expect(page.getByRole('region', { name: 'Current test scene' })).toContainText('The Old Gate');
  await expect(page.getByRole('button', { name: 'Raise the lantern and open the gate' })).toBeVisible();
  await page.getByRole('button', { name: 'Tour this view' }).click();
  await expect(page.getByRole('dialog', { name: 'Try a player action' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit tour' }).click();
  await expect(page.locator('.tour-layer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Raise the lantern and open the gate' }).click();
  await expect(page.getByRole('region', { name: 'Current test scene' })).toContainText('The Stone Bridge');
});

test('Apprentice and Play each offer a replayable view tour', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Tour this view' }).click();
  await expect(page.getByRole('dialog', { name: 'Select and arrange' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('dialog', { name: 'Sections and logic' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit tour' }).click();
  await expect(page.locator('.tour-layer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await page.getByRole('button', { name: 'Tour this view' }).click();
  await expect(page.getByRole('dialog', { name: 'Read the scene' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose an action' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit tour' }).click();
});

test('Apprentice inspector edits a scene and keeps the graph in sync', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Apprentice' }).click();
  const inspector = page.getByLabel('Story inspector');
  await expect(inspector.getByRole('tab', { name: 'Scene' })).toHaveAttribute('aria-selected', 'true');
  await inspector.getByRole('textbox', { name: 'Title text (en-GB)' }).fill('The First Gate');
  await expect(page.getByText('Scene: The First Gate')).toBeVisible();
  await page.getByRole('button', { name: 'Add scene' }).click();
  await inspector.getByRole('group', { name: 'Title' }).getByRole('textbox', { name: 'Text', exact: true }).fill('Moonlit Bridge');
  await expect(page.getByText('Scene: Moonlit Bridge')).toBeVisible();
  await inspector.getByRole('tab', { name: 'World' }).click();
  await inspector.getByRole('navigation', { name: 'World sections' }).getByRole('button', { name: /State/ }).click();
  await expect(inspector.getByRole('heading', { name: 'State definitions' })).toBeVisible();
  await inspector.getByRole('tab', { name: 'Scene' }).click();
  await expect(inspector.getByRole('textbox', { name: 'Text', exact: true }).first()).toHaveValue('Moonlit Bridge');
  await page.getByRole('button', { name: 'Sage' }).click();
  await expect(page.getByLabel('Editor for world.json')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const savedWorld = JSON.parse(strFromU8(saved['world.json']!)) as { nodes: { title: { text?: string } }[] };
  const savedLocale = JSON.parse(strFromU8(saved['locales/en-GB.json']!)) as { strings: Record<string, string> };
  expect(savedWorld.nodes.some(node => node.title.text === 'Moonlit Bridge')).toBe(true);
  expect(savedLocale.strings['gate-title']).toBe('The First Gate');
});

test('World translations edit choice labels and longer text in multiple languages', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
  const translations = inspector.locator('section[aria-label="Translations"]');
  await translations.getByRole('button', { name: /open-gate-label/ }).click();
  await translations.getByRole('textbox', { name: 'Translation text for open-gate-label (en-GB)' }).fill('Lift the lantern and enter');
  await translations.getByRole('textbox', { name: 'New translation language' }).fill('fr-FR');
  await translations.getByRole('textbox', { name: 'First translation' }).fill('Levez la lanterne et entrez');
  await translations.getByRole('button', { name: 'Add language' }).click();
  await expect(translations.getByRole('textbox', { name: 'Translation text for open-gate-label (fr-FR)' })).toHaveValue('Levez la lanterne et entrez');

  await inspector.getByRole('tab', { name: 'Scene' }).click();
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  await inspector.getByRole('button', { name: 'Add choice' }).click();
  const newChoice = inspector.locator('.apprentice-choice').last();
  await newChoice.getByRole('combobox', { name: 'Text source' }).selectOption('locale-key');
  await newChoice.getByRole('textbox', { name: 'Locale key' }).fill('new-choice-label');
  await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
  await translations.getByRole('button', { name: /new-choice-label/ }).click();
  const longLabel = 'Follow the lantern-lit path.\nThe bridge is slippery, so take one careful step at a time.';
  await translations.getByRole('textbox', { name: 'Translation text for new-choice-label (en-GB)' }).fill(longLabel);
  await page.getByRole('button', { name: 'Playtest' }).click();
  await acknowledgeWarnings(page);
  await expect(page.getByRole('button', { name: 'Lift the lantern and enter' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Follow the lantern-lit path/ })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const savedPath = await (await download).path();
  expect(savedPath).not.toBeNull();
  const saved = unzipSync(new Uint8Array(await readFile(savedPath!)));
  const english = JSON.parse(strFromU8(saved['locales/en-GB.json']!)) as { strings: Record<string, string> };
  const french = JSON.parse(strFromU8(saved['locales/fr-FR.json']!)) as { strings: Record<string, string> };
  const savedWorld = JSON.parse(strFromU8(saved['world.json']!)) as { nodes: { actions?: { choices?: { label: { key?: string } }[] } }[] };
  expect(english.strings['open-gate-label']).toBe('Lift the lantern and enter');
  expect(english.strings['new-choice-label']).toBe(longLabel);
  expect(french.strings['open-gate-label']).toBe('Levez la lanterne et entrez');
  expect(savedWorld.nodes.some(node => node.actions?.choices?.some(choice => choice.label.key === 'new-choice-label'))).toBe(true);
});

test('Apprentice deletes an in-use starter translation by preserving its player text', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
  const translations = inspector.getByRole('region', { name: 'Translations' });
  await translations.getByLabel('Translation keys').getByRole('button', { name: /gate-title/ }).click();
  await expect(translations.getByText(/In use\. Deleting replaces its references/)).toBeVisible();
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Replace those references with the en-GB text');
    await dialog.accept();
  });
  await translations.getByRole('button', { name: 'Delete translation key gate-title' }).click();
  await expect(translations.getByLabel('Translation keys').getByRole('button', { name: /gate-title/ })).toHaveCount(0);
  await expect(page.getByLabel('Apprentice node graph').getByText('Scene: The Old Gate')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const savedWorld = JSON.parse(strFromU8(saved['world.json']!)) as { nodes: { id: string; title: { kind: string; text?: string; key?: string } }[] };
  const savedLocale = JSON.parse(strFromU8(saved['locales/en-GB.json']!)) as { strings: Record<string, string> };
  expect(savedWorld.nodes.find(node => node.id === 'old-gate')?.title).toEqual({ kind: 'literal', text: 'The Old Gate' });
  expect(savedLocale.strings['gate-title']).toBeUndefined();
});

test('Apprentice selects and deletes multiple translation keys with editor shortcuts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
  const translations = inspector.getByRole('region', { name: 'Translations' });
  const keyList = translations.getByLabel('Translation keys');
  await translations.getByRole('searchbox', { name: 'Find a key' }).fill('gate-');
  const content = keyList.getByRole('button', { name: /gate-content/ });
  const title = keyList.getByRole('button', { name: /gate-title/ });
  await content.click();
  await title.click({ modifiers: ['Shift'] });
  await expect(content).toHaveAttribute('aria-pressed', 'true');
  await expect(title).toHaveAttribute('aria-pressed', 'true');
  await expect(translations.getByLabel('Selected translation keys')).toContainText('2 keys selected');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete');
  await expect(content).toHaveCount(0);
  await expect(title).toHaveCount(0);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const savedWorld = JSON.parse(strFromU8(saved['world.json']!)) as { nodes: { id: string; title: { kind: string; text?: string }; content: { kind: string; text?: string } }[] };
  const savedLocale = JSON.parse(strFromU8(saved['locales/en-GB.json']!)) as { strings: Record<string, string> };
  expect(savedWorld.nodes.find(node => node.id === 'old-gate')?.title).toEqual({ kind: 'literal', text: 'The Old Gate' });
  expect(savedWorld.nodes.find(node => node.id === 'old-gate')?.content.kind).toBe('literal');
  expect(savedLocale.strings['gate-content']).toBeUndefined();
  expect(savedLocale.strings['gate-title']).toBeUndefined();
});

test('Apprentice action lists support additive selection and keyboard deletion', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  const choices = inspector.getByLabel('Choices browser');
  await choices.getByRole('button', { name: 'Add choice' }).click();
  const rows = choices.locator('.apprentice-collection__list button');
  await expect(rows).toHaveCount(3);
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete');
  await expect(rows).toHaveCount(1);
});

test('Apprentice can clear starter scenes, state, and saved locale text before rebuilding', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const graph = page.getByLabel('Apprentice node graph');
  await graph.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByText('Map tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete selected' }).click();
  await expect(graph.getByText('No start scene yet. Add a scene to make this story playable.')).toBeVisible();
  await expect(graph.locator('.react-flow__node:not(.apprentice-section-node)')).toHaveCount(0);

  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Text / Translations' }).click();
  const translations = inspector.getByRole('region', { name: 'Translations' });
  await translations.getByLabel('Translation keys').getByRole('button', { name: /gate-title/ }).click();
  page.once('dialog', dialog => dialog.accept());
  await translations.getByRole('button', { name: 'Delete translation key gate-title' }).click();
  await inspector.getByRole('tab', { name: 'World' }).click();
  await inspector.getByRole('navigation', { name: 'World sections' }).getByRole('button', { name: /State/ }).click();
  await inspector.getByRole('button', { name: 'Remove definition' }).click();
  await expect(inspector.getByText('lantern-lit')).toHaveCount(0);

  await page.getByRole('button', { name: 'Add scene' }).click();
  await expect(graph.getByText('Scene: New scene')).toBeVisible();
  await expect(graph.locator('.apprentice-node-kind').getByText('Start scene')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const savedWorld = JSON.parse(strFromU8(saved['world.json']!)) as { entryNodeId: string; nodes: { id: string }[]; navigationEdges: unknown[]; stateDefinitions: unknown[]; worldState: Record<string, unknown> };
  const savedLocale = JSON.parse(strFromU8(saved['locales/en-GB.json']!)) as { strings: Record<string, string> };
  expect(savedWorld.nodes).toHaveLength(1);
  expect(savedWorld.entryNodeId).toBe(savedWorld.nodes[0]?.id);
  expect(savedWorld.navigationEdges).toEqual([]);
  expect(savedWorld.stateDefinitions).toEqual([]);
  expect(savedWorld.worldState['lantern-lit']).toBeUndefined();
  expect(savedLocale.strings['gate-title']).toBeUndefined();
});

test('Apprentice map keeps dragged positions and connects scenes through handles', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const graph = page.getByLabel('Apprentice node graph');
  const entry = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Old Gate' });
  await page.getByRole('button', { name: 'Add scene' }).click();
  const newScene = graph.locator('.react-flow__node').filter({ hasText: 'Scene: New scene' });
  await expect(newScene).toHaveClass(/selected/);
  await expect(newScene.getByText('Selected')).toBeVisible();
  await expect(page.locator('#project-diagnostics')).toContainText('DS-MOD-031');

  await graph.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top - 80));
  const before = await newScene.boundingBox();
  expect(before).not.toBeNull();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + 80, before!.y + before!.height / 2 + 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await newScene.boundingBox())?.x).toBeGreaterThan(before!.x + 40);

  const source = await entry.locator('.react-flow__handle-bottom').boundingBox();
  const target = await newScene.locator('.react-flow__handle-top').boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 12 });
  await page.mouse.up();
  const connection = page.getByRole('dialog', { name: 'Connect scenes' });
  await expect(connection).toContainText('The Old Gate → New scene');
  await connection.getByRole('textbox', { name: 'Choice text' }).fill('Take the new path');
  await connection.getByRole('button', { name: 'Create connection' }).click();
  await expect.poll(() => graph.locator('.react-flow__edge').count()).toBe(5);
  await expect(entry).toContainText('Take the new path → New scene');
  await expect(page.locator('#project-diagnostics')).not.toContainText('DS-MOD-031');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await page.getByRole('button', { name: 'Take the new path' }).click();
  await expect(page.getByLabel('Game player')).toContainText('New scene');
  await page.getByRole('button', { name: 'Apprentice' }).click();

  await page.getByText('Map tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Add logic folder' }).click();
  await page.getByText('Map tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Fit all scenes in view' }).click();
  const folder = graph.locator('.react-flow__node').filter({ hasText: 'Logic folder: New logic folder' });
  await expect(folder.locator('.react-flow__handle-bottom')).toBeVisible();
  await expect(page.getByLabel('Apprentice forms').getByRole('heading', { name: 'Logic folder details' })).toBeVisible();
  await page.getByRole('button', { name: 'Fit all scenes in view' }).click();
  await page.waitForTimeout(150); // React Flow applies the new viewport on its next paint.
  const folderSource = await folder.locator('.react-flow__handle-bottom').boundingBox();
  const childTarget = await newScene.locator('.react-flow__handle-top').boundingBox();
  expect(folderSource).not.toBeNull();
  expect(childTarget).not.toBeNull();
  await page.mouse.move(folderSource!.x + folderSource!.width / 2, folderSource!.y + folderSource!.height / 2);
  await page.mouse.down();
  await page.mouse.move(childTarget!.x + childTarget!.width / 2, childTarget!.y + childTarget!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => graph.locator('.react-flow__edge').count()).toBe(6);
  await expect(page.getByLabel('Story inspector')).toContainText('Inside this folder (1): New scene');
  await expect(page.getByLabel('Story inspector').getByText('Advanced folder content and action defaults')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Markdown formatting' })).toBeHidden();

  await newScene.click();
  const inspector = page.getByLabel('Story inspector');
  await inspector.getByRole('tab', { name: 'Actions', exact: true }).click();
  await inspector.getByRole('button', { name: 'Add choice' }).click();
  const destination = inspector.getByRole('combobox', { name: 'Choice destination' });
  await expect(destination.getByRole('option', { name: 'The Old Gate' })).toBeAttached();
  await destination.selectOption({ label: 'The Old Gate' });
  await expect.poll(() => graph.locator('.react-flow__edge').count()).toBe(7);
  await expect(newScene).toContainText('New choice → The Old Gate');
  await inspector.getByRole('button', { name: 'Help: Condition' }).hover();
  const conditionTip = inspector.getByRole('tooltip');
  expect(await conditionTip.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await conditionTip.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(page.viewportSize()!.height);
  await inspector.getByRole('tab', { name: 'Logic', exact: true }).click();
  const checkboxRows = inspector.locator('label:has(> input[type="checkbox"])');
  expect(await checkboxRows.count()).toBeGreaterThanOrEqual(2);
  const misalignedRows = await checkboxRows.evaluateAll(rows => rows.map(row => {
    const box = row.querySelector('input[type="checkbox"]')!.getBoundingClientRect();
    const label = row.getBoundingClientRect();
    return { text: row.textContent, display: getComputedStyle(row).display, delta: Math.abs(box.y + box.height / 2 - (label.y + label.height / 2)), visible: box.width > 0 && box.height > 0 };
  }).filter(row => row.visible && (row.display !== 'flex' || row.delta >= 4)));
  expect(misalignedRows).toEqual([]);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const world = JSON.parse(strFromU8(saved['world.json']!)) as { nodes: { id: string; parentId: string | null; title: { text?: string } }[]; navigationEdges: { fromNodeId: string; toNodeId: string }[] };
  const layout = JSON.parse(strFromU8(saved['studio/graph-layout.json']!)) as { positions: Record<string, { x: number; y: number }> };
  const added = world.nodes.find(node => node.title.text === 'New scene');
  expect(added).toBeDefined();
  expect(layout.positions[added!.id]?.x).toBeGreaterThan(320);
  expect(world.navigationEdges.some(edge => edge.fromNodeId === world.nodes[0]!.id && edge.toNodeId === added!.id)).toBe(true);
  expect(added!.parentId).toBe(world.nodes.find(node => node.title.text === 'New logic folder')?.id);

  const containment = graph.locator('.react-flow__edge[data-id^="contains:"]');
  await expect(containment).toHaveCount(1);
  await containment.locator('.react-flow__edge-textwrapper').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from logic folder' }).click();
  await expect(containment).toHaveCount(0);
  await page.getByText('Map tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(containment).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(containment).toHaveCount(0);
});

test('connecting a scene can reuse an existing unbound choice without duplicating it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Add scene' }).click();
  const graph = page.getByLabel('Apprentice node graph');
  const entry = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Old Gate' });
  await entry.click({ position: { x: 12, y: 12 } });
  await page.getByLabel('Story inspector').getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByLabel('Story inspector').getByRole('button', { name: 'Add choice' }).click();
  await page.getByText('Map tools', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Navigation destination' }).selectOption({ label: 'New scene' });
  const connection = page.getByRole('dialog', { name: 'Connect scenes' });
  await connection.getByRole('combobox', { name: 'Route interaction' }).selectOption({ label: 'Use existing choice: New choice' });
  await connection.getByRole('button', { name: 'Create connection' }).click();
  await expect(entry).toContainText('New choice → New scene');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const world = JSON.parse(strFromU8(saved['world.json']!)) as { nodes: { id: string; title: { text?: string }; actions?: { choices: { label: { text?: string }; navigationEdgeId?: string }[] } }[]; navigationEdges: { id: string; fromNodeId: string; toNodeId: string }[] };
  const choices = world.nodes.find(node => node.id === 'old-gate')?.actions?.choices ?? [];
  expect(choices.filter(choice => choice.label.text === 'New choice')).toHaveLength(1);
  expect(world.navigationEdges.find(edge => edge.id === choices.find(choice => choice.label.text === 'New choice')?.navigationEdgeId)?.toNodeId).toBe(world.nodes.find(node => node.title.text === 'New scene')?.id);
});

test('a route-only arrow can gain a playable command from its own menu', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Add scene' }).click();
  const graph = page.getByLabel('Apprentice node graph');
  const entry = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Old Gate' });
  await entry.click({ position: { x: 12, y: 12 } });
  await page.getByText('Map tools', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Navigation destination' }).selectOption({ label: 'New scene' });
  const connection = page.getByRole('dialog', { name: 'Connect scenes' });
  await connection.getByRole('combobox', { name: 'Route interaction' }).selectOption('route-only');
  await connection.getByRole('button', { name: 'Create connection' }).click();
  const route = graph.locator('.react-flow__edge').last();
  await expect(route).toContainText('Advanced route only');
  await expect(page.locator('.apprentice-graph-tools')).not.toHaveAttribute('open');
  await route.locator('.react-flow__edge-textwrapper').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add player action to route' }).click();
  await connection.getByRole('combobox', { name: 'Route interaction' }).selectOption('command');
  await connection.getByRole('textbox', { name: 'Command words' }).fill('enter the new scene');
  await connection.getByRole('button', { name: 'Create connection' }).click();
  await expect(route).toContainText('enter the new scene');
  await expect(entry).toContainText('enter the new scene → New scene');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await page.getByRole('textbox', { name: 'Type an action' }).fill('enter the new scene');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByLabel('Game player')).toContainText('New scene');
});

test('Apprentice canvas menu places a root scene and a visual section without changing logic', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const graph = page.getByLabel('Apprentice node graph');
  const pane = graph.locator('.react-flow__pane');
  const box = (await pane.boundingBox())!;
  await pane.click({ button: 'right', position: { x: box.width - 70, y: box.height - 70 } });
  await page.getByRole('menu', { name: 'Map actions' }).getByRole('menuitem', { name: 'New logic folder here' }).click();
  await expect(page.getByLabel('Story inspector')).toContainText('Logic folder details');
  await pane.click({ button: 'right', position: { x: 120, y: box.height - 110 } });
  const menu = page.getByRole('menu', { name: 'Map actions' });
  await expect(menu.getByRole('menuitem', { name: 'New scene here' })).toBeFocused();
  const viewportBefore = await graph.locator('.react-flow__viewport').getAttribute('style');
  await menu.getByRole('menuitem', { name: 'New scene here' }).click();
  const newScene = graph.locator('.react-flow__node').filter({ hasText: 'Scene: New scene' });
  await expect(newScene).toBeVisible();
  expect(await graph.locator('.react-flow__viewport').getAttribute('style')).toBe(viewportBefore);
  await page.getByText('Map tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Add section' }).click();
  await page.getByText('Map tools', { exact: true }).click();
  await expect(graph.getByRole('button', { name: 'Collapse section New section' })).toBeVisible();
  await graph.locator('.apprentice-section-border--right').click({ button: 'right', position: { x: 3, y: 55 } });
  await expect(page.getByRole('menu', { name: 'Map actions' }).getByRole('menuitem', { name: 'Delete section' })).toBeVisible();
  await page.keyboard.press('Escape');
  await graph.getByRole('button', { name: 'Collapse section New section' }).click();
  await expect(newScene).toHaveCount(0);
  await graph.getByRole('searchbox', { name: 'Find scene or logic folder' }).fill('New scene');
  await graph.getByLabel('Map search results').getByRole('button', { name: 'New scene' }).click();
  await expect(newScene).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const world = JSON.parse(strFromU8(saved['world.json']!)) as { nodes: { id: string; parentId: string | null; title: { text?: string } }[] };
  const layout = JSON.parse(strFromU8(saved['studio/graph-layout.json']!)) as { schemaVersion: number; sections: { nodeIds: string[] }[] };
  const created = world.nodes.find(node => node.title.text === 'New scene');
  expect(created?.parentId).toBeNull();
  expect(layout.schemaVersion).toBe(2);
  expect(layout.sections[0]?.nodeIds).toContain(created?.id);
  await graph.locator('.apprentice-section-header').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Map actions' }).getByRole('menuitem', { name: 'Delete section' }).click();
  const secondDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const ungrouped = unzipSync(new Uint8Array(await readFile((await (await secondDownload).path())!)));
  expect(JSON.parse(strFromU8(ungrouped['studio/graph-layout.json']!)).sections).toEqual([]);
  expect(JSON.parse(strFromU8(ungrouped['world.json']!)).nodes.some((node: { id: string }) => node.id === created?.id)).toBe(true);
});

test('Apprentice map shortcuts and menu keyboard access respect deletion guards', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const graph = page.getByLabel('Apprentice node graph');
  await graph.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(graph.getByRole('status')).toContainText('map items selected');
  await page.keyboard.press('Escape');
  await expect(graph.getByRole('status')).toHaveCount(0);
  await graph.focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Map actions' });
  await expect(menu.getByRole('menuitem', { name: 'New scene here' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'New section here' })).toBeFocused();
  const rect = await menu.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Old Gate' }).click({ position: { x: 12, y: 12 } });
  await graph.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete');
  await expect(graph.getByRole('alert')).toContainText('entry scene cannot be deleted');
  await expect(graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Old Gate' })).toBeVisible();
});

test('starter scene deletion retains external actions and the start scene can be replaced', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const graph = page.getByLabel('Apprentice node graph');
  const tower = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Watchtower' });
  await tower.click({ button: 'right' });
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('Climb to the watchtower'); await dialog.dismiss(); });
  await page.getByRole('menu', { name: 'Map actions' }).getByRole('menuitem', { name: 'Delete node' }).click();
  await expect(tower).toBeVisible();
  await tower.click({ button: 'right' });
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('Climb to the watchtower'); await dialog.accept(); });
  await page.getByRole('menu', { name: 'Map actions' }).getByRole('menuitem', { name: 'Delete node' }).click();
  await expect(tower).toHaveCount(0);

  const bridge = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Stone Bridge' });
  await bridge.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Map actions' }).getByRole('menuitem', { name: 'Make start scene' }).click();
  await expect(bridge).toContainText('Start scene');
  const gate = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Old Gate' });
  await gate.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Map actions' }).getByRole('menuitem', { name: 'Delete node' }).click();
  await expect(gate).toHaveCount(0);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const saved = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  const world = JSON.parse(strFromU8(saved['world.json']!)) as { entryNodeId: string; nodes: { id: string }[]; navigationEdges: { id: string }[] };
  expect(world.entryNodeId).toBe('stone-bridge');
  expect(world.nodes.map(node => node.id)).toEqual(['stone-bridge', 'lantern-house']);
  expect(world.navigationEdges.map(edge => edge.id)).toEqual(['bridge-to-home']);
});

test('Apprentice empty drag selects while a modifier drag pans', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const graph = page.getByLabel('Apprentice node graph');
  const pane = graph.locator('.react-flow__pane');
  await pane.scrollIntoViewIfNeeded();
  const bounds = (await pane.boundingBox())!;
  const viewport = graph.locator('.react-flow__viewport');
  const before = await viewport.getAttribute('style');
  const start = { x: bounds.x + bounds.width - 170, y: Math.min(bounds.y + bounds.height - 90, page.viewportSize()!.height - 90) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 70, start.y + 40, { steps: 6 });
  await expect(graph.locator('.react-flow__selection')).toBeVisible();
  await page.mouse.up();
  expect(await viewport.getAttribute('style')).toBe(before);
  await page.keyboard.down('Shift');
  await expect(graph).toHaveAttribute('data-map-tool', 'pan');
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element?.getAttribute('class') ?? element?.tagName ?? 'none';
  }, start);
  expect(hit).toContain('react-flow__pane');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 70, start.y - 40, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);
});

test('Apprentice group drag moves both nodes and undoes in one step', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const graph = page.getByLabel('Apprentice node graph');
  const gate = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Old Gate' });
  const bridge = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Stone Bridge' });
  await gate.click({ position: { x: 12, y: 12 } });
  await bridge.click({ modifiers: ['Shift'], position: { x: 12, y: 12 } });
  await expect(graph.getByRole('status')).toContainText('2 map items selected');
  const gateBefore = (await gate.boundingBox())!;
  const bridgeBefore = (await bridge.boundingBox())!;
  await page.mouse.move(bridgeBefore.x + bridgeBefore.width / 2, bridgeBefore.y + 12);
  await page.mouse.down();
  await page.mouse.move(bridgeBefore.x + bridgeBefore.width / 2 + 60, bridgeBefore.y + 12 + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await gate.boundingBox())!.x).toBeGreaterThan(gateBefore.x + 30);
  await expect.poll(async () => (await bridge.boundingBox())!.x).toBeGreaterThan(bridgeBefore.x + 30);
  await page.getByText('Map tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await gate.boundingBox())!.x).toBeLessThan(gateBefore.x + 4);
  await expect.poll(async () => (await bridge.boundingBox())!.x).toBeLessThan(bridgeBefore.x + 4);
  await bridge.click({ modifiers: ['Shift'], position: { x: 12, y: 12 } });
  await expect(graph.getByRole('status')).toHaveCount(0);
  await expect(gate.getByText('Selected')).toBeVisible();
});

test('Apprentice right-clicks on a group open group actions instead of the browser menu', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const graph = page.getByLabel('Apprentice node graph');
  const bridge = graph.locator('.react-flow__node').filter({ hasText: 'Scene: The Stone Bridge' });
  const home = graph.locator('.react-flow__node').filter({ hasText: 'Scene: Home Before Dark' });
  await bridge.click({ position: { x: 12, y: 12 } });
  await home.click({ modifiers: ['Shift'], position: { x: 12, y: 12 } });
  await expect(graph.getByRole('status')).toContainText('2 map items selected');
  await page.evaluate(() => document.addEventListener('contextmenu', event => { document.documentElement.dataset.mapContextPrevented = String(event.defaultPrevented); }, { once: true }));
  await bridge.click({ button: 'right' });
  await expect(page.locator('html')).toHaveAttribute('data-map-context-prevented', 'true');
  const menu = page.getByRole('menu', { name: 'Map actions' });
  await expect(menu).toContainText('2 map items selected');
  await menu.getByRole('menuitem', { name: 'Create section around selected' }).click();
  await expect(graph.getByRole('button', { name: 'Collapse section New section' })).toBeVisible();
  await bridge.click({ position: { x: 12, y: 12 } });
  await home.click({ modifiers: ['Shift'], position: { x: 12, y: 12 } });
  await bridge.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Move selected to section: New section' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Clear selection' }).click();
  await expect(graph.getByRole('status')).toHaveCount(0);
});

test('Apprentice starter and workspace controls stay usable without a tour', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
  const map = page.getByLabel('Apprentice node graph');
  const inspector = page.getByLabel('Story inspector');
  await expect(map.getByText('Scene: The Watchtower')).toBeVisible();
  await map.locator('.react-flow__node').filter({ hasText: 'Scene: The Old Gate' }).click({ button: 'right', position: { x: 20, y: 20 } });
  await expect(page.getByRole('menuitem', { name: 'Add scene nearby' })).toBeVisible();
  await map.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
  await expect(inspector).toContainText('Select a node to edit its content and actions.');
  await map.locator('.react-flow__node[data-id="old-gate"]').click({ position: { x: 20, y: 20 } });
  await expect(page.getByLabel('Start making your game')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fit all scenes in view' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fit View' })).toHaveCount(0);
  await page.getByText('Map tools', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Navigation destination' })).toBeVisible();
  await page.getByText('Map tools', { exact: true }).click();
  await inspector.getByRole('button', { name: 'Help: Scene content' }).hover();
  await expect(inspector.getByText('The title and content are what the player sees')).toBeVisible();
  const tip = inspector.getByRole('tooltip');
  expect(await tip.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await inspector.getByRole('button', { name: 'Hide inspector' }).click();
  await expect(inspector.getByRole('tab', { name: 'Scene' })).toHaveCount(0);
  await inspector.getByRole('button', { name: 'Show inspector' }).click();
  const divider = page.getByRole('separator', { name: 'Resize inspector' });
  const initialWidth = await inspector.evaluate(element => element.getBoundingClientRect().width);
  await divider.press('ArrowLeft');
  await expect.poll(() => inspector.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(initialWidth);
  await inspector.getByRole('button', { name: 'Workspace full screen' }).click();
  await expect(map).toBeVisible();
  await expect(inspector).toBeVisible();
  await expect(page.locator('.apprentice-workbench')).toHaveCSS('width', `${page.viewportSize()!.width}px`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('separator', { name: 'Resize inspector' })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss starter guide' }).click();
  await expect(page.getByLabel('Start making your game')).toHaveCount(0);
  await page.getByRole('button', { name: 'Playtest' }).click();
  await page.getByRole('button', { name: 'Climb to the watchtower' }).click();
  await expect(page.getByRole('region', { name: 'Current test scene' })).toContainText('The Watchtower');
  await page.getByRole('textbox', { name: 'Or type a command' }).fill('descend');
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByRole('region', { name: 'Current test scene' })).toContainText('The Stone Bridge');
});

test('create, edit in Sage and Apprentice, and round-trip a project ZIP', async ({ page }) => {
  await page.goto('/');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
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
});

test('restores a recovery copy after an offline reload', async ({ page, context, browserName }) => {
  // Playwright WebKit fails internally at page.reload() after setOffline(true).
  // Accepted scope: do not investigate this Playwright WebKit error unless browser support policy changes.
  test.skip(browserName === 'webkit', 'Accepted WebKit offline-reload coverage gap: Playwright reports an internal error.');
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project' }).click();
  await dismissTourInvite(page);
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
  await expect(page.getByLabel('Project diagnostics', { exact: true })).not.toContainText('DS-MD-005');
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
  await expect(page.getByLabel('Project diagnostics', { exact: true })).not.toContainText('DS-MD-005');
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
  await expect(page.getByLabel('Project diagnostics', { exact: true })).toContainText('DS-MEDIA-001');
});

test('playtest clock runs configured scripts and accepts node-link input', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles({ name: 'tavern.zip', mimeType: 'application/zip', buffer: await tavernZip() });
  await page.clock.install();
  await page.getByRole('button', { name: 'Playtest' }).click();
  await acknowledgeWarnings(page);
  await page.clock.runFor(121_000);
  await page.getByText('Playtest debugger', { exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search traces and availability' }).fill('Script');
  await expect(page.getByLabel('Chronological engine trace')).toContainText('Script echo-check');
  await expect(page.getByLabel('Chronological engine trace')).toContainText('Script keeper-check');
  await expect(page.getByLabel('Chronological engine trace')).toContainText('Script witness-check');
  await page.getByText('Advanced: send PlayerInput JSON').click();
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
  await dismissTourInvite(page);
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


test('route correction preserves identity, removal preserves the choice, and reconnect survives ZIP import', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await dismissTourInvite(page);
  await page.getByRole('button', { name: 'Workspace full screen', exact: true }).click();
  const graph = page.getByLabel('Apprentice node graph');
  await graph.getByRole('button', { name: 'Fit all scenes in view' }).click();
  const route = graph.locator('.react-flow__edge[data-id="gate-to-bridge"]');
  await route.locator('.react-flow__edge-textwrapper').click();
  const target = graph.locator('.react-flow__node[data-id="lantern-house"] .react-flow__handle-top');
  const endpoint = route.locator('.react-flow__edgeupdater-target');
  await expect(endpoint).toBeVisible();
  const start = (await endpoint.boundingBox())!;
  const end = (await target.boundingBox())!;
  expect(end.y + end.height).toBeLessThan(page.viewportSize()!.height);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 16 });
  await page.mouse.up();
  await expect(route).toHaveAttribute('aria-label', /to Home Before Dark/);
  await graph.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(route).toHaveAttribute('aria-label', /to The Stone Bridge/);
  await route.locator('.react-flow__edge-textwrapper').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change destination…' }).click();
  const editor = page.getByRole('dialog', { name: 'Change route destination' });
  await editor.getByRole('combobox', { name: 'Route destination' }).selectOption('watchtower');
  await editor.getByRole('button', { name: 'Apply destination' }).click();
  await expect(editor.getByRole('alert')).toContainText('already exists');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(route).toHaveAttribute('aria-label', /to The Stone Bridge/);
  await route.locator('.react-flow__edge-textwrapper').click({ button: 'right' });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', { name: 'Remove route, keep actions' }).click();
  await expect(route).toHaveCount(0);
  const choice = graph.getByRole('button', { name: /Raise the lantern and open the gate.*no direct destination/ });
  await expect(choice).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('retained-choice.png') });
  await choice.click();
  const action = page.getByRole('dialog', { name: 'Edit player action' });
  await action.getByRole('combobox', { name: 'Action destination' }).selectOption('lantern-house');
  await action.getByRole('button', { name: 'Save action' }).click();
  await expect(graph.getByRole('button', { name: /Raise the lantern and open the gate.*Home Before Dark/ })).toBeVisible();
  await page.getByRole('button', { name: 'Exit workspace full screen', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project ZIP' }).click();
  await acknowledgeWarnings(page);
  const savedPath = (await (await download).path())!;
  const saved = unzipSync(new Uint8Array(await readFile(savedPath)));
  const world = JSON.parse(strFromU8(saved['world.json']!));
  const retained = world.nodes.find((node: { id: string }) => node.id === 'old-gate').actions.choices.find((item: { id: string }) => item.id === 'open-gate');
  expect(retained.label).toEqual({ kind: 'locale-key', key: 'open-gate-label' });
  expect(retained.effects.length).toBeGreaterThan(0);
  expect(world.navigationEdges.find((edge: { id: string }) => edge.id === retained.navigationEdgeId).toNodeId).toBe('lantern-house');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Import project ZIP').setInputFiles(savedPath);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await acknowledgeWarnings(page);
  await page.getByRole('button', { name: /Raise the lantern and open the gate/ }).click();
  await expect(page.getByRole('heading', { name: 'Home Before Dark', exact: true })).toBeVisible();
});
