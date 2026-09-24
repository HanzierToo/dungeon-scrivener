import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { createSnapshot } from '@dungeon-scrivener/vfs';
import { diagnoseSageScript, SageWorkspace } from './index.js';

const enc = new TextEncoder();

describe('Sage workspace', () => {
  it('keeps invalid world bytes exportable while retaining the last valid parsed view across tabs', async () => {
    const binary = new Uint8Array([0, 255, 1, 128]);
    const originalWorld = new Uint8Array(readFileSync('fixtures/linear-three-nodes/world.json'));
    const workspace = new SageWorkspace(createSnapshot([
      { path: 'project.json', bytes: new Uint8Array(readFileSync('fixtures/linear-three-nodes/project.json')), role: 'manifest' },
      { path: 'world.json', bytes: originalWorld, role: 'world' },
      { path: 'notes.md', bytes: enc.encode('A note'), role: 'arbitrary' },
      { path: 'archive.bin', bytes: binary, role: 'arbitrary' }
    ]));
    workspace.editText('notes.md', 'Updated note');
    workspace.createFile('new-unrelated.bin', binary);
    const lastKnownView = workspace.getState().parsedProject;
    workspace.editText('world.json', '{ invalid');
    expect(workspace.getState().diagnostics.some(item => item.path === 'world.json')).toBe(true);
    expect(workspace.getState().parsedProject).toBe(lastKnownView);
    workspace.open('archive.bin');
    workspace.open('world.json');

    const archive = unzipSync(await workspace.exportZip());
    expect(archive['notes.md']).toEqual(enc.encode('Updated note'));
    expect(archive['archive.bin']).toEqual(binary);
    expect(archive['new-unrelated.bin']).toEqual(binary);
    expect(archive['world.json']).toEqual(enc.encode('{ invalid'));
  });

  it('creates, renames, and deletes arbitrary paths through the VFS', () => {
    const workspace = new SageWorkspace(createSnapshot([]));
    workspace.createFile('draft.txt', enc.encode('draft'));
    workspace.rename('draft.txt', 'notes/draft.txt');
    expect(workspace.getState().snapshot.files.has('notes/draft.txt')).toBe(true);
    workspace.delete('notes/draft.txt');
    expect(workspace.getState().snapshot.files.has('notes/draft.txt')).toBe(false);
  });

  it('reports Lua syntax locations and edits only selected Python and locale files', async () => {
    const project = new Uint8Array(readFileSync('fixtures/linear-three-nodes/project.json'));
    const world = new Uint8Array(readFileSync('fixtures/linear-three-nodes/world.json'));
    const locale = new Uint8Array(readFileSync('fixtures/linear-three-nodes/locales/en-GB.json'));
    const python = new Uint8Array(readFileSync('fixtures/tavern-at-dusk/scripts/witness.py'));
    const lua = new Uint8Array(readFileSync('fixtures/tavern-at-dusk/scripts/echo.lua'));
    const workspace = new SageWorkspace(createSnapshot([
      { path: 'project.json', bytes: project, role: 'manifest' },
      { path: 'world.json', bytes: world, role: 'world' },
      { path: 'locales/en-GB.json', bytes: locale, role: 'locale' },
      { path: 'scripts/witness.py', bytes: python, role: 'script' },
      { path: 'scripts/echo.lua', bytes: lua, role: 'script' }
    ]));
    const luaErrors = diagnoseSageScript('function main()\n  local = 2\nend', 'scripts/echo.lua');
    expect(luaErrors[0]?.sourceSpan).toMatchObject({ path: 'scripts/echo.lua', startLine: 2 });
    workspace.setScriptDiagnostics('scripts/echo.lua', luaErrors);
    workspace.open('scripts/witness.py');
    workspace.open('scripts/echo.lua');
    expect(workspace.getState().diagnostics).toContainEqual(luaErrors[0]);

    const pythonText = new TextDecoder().decode(python);
    workspace.editText('scripts/witness.py', `${pythonText}\n# reviewed\n`);
    expect([...workspace.getState().dirtyPaths]).toEqual(['scripts/witness.py']);
    const localeDocument = JSON.parse(new TextDecoder().decode(locale)) as { strings: Record<string, string> };
    const key = Object.keys(localeDocument.strings)[0];
    expect(key).toBeDefined();
    localeDocument.strings[key!] = `${localeDocument.strings[key!]} updated`;
    workspace.editText('locales/en-GB.json', JSON.stringify(localeDocument, null, 2));
    expect([...workspace.getState().dirtyPaths].sort()).toEqual(['locales/en-GB.json', 'scripts/witness.py']);

    const archive = unzipSync(await workspace.exportZip());
    expect(archive['scripts/witness.py']).toEqual(enc.encode(`${pythonText}\n# reviewed\n`));
    expect(archive['scripts/echo.lua']).toEqual(lua);
    expect(archive['world.json']).toEqual(world);
    expect(archive['project.json']).toEqual(project);
  });
});
