import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GameEngineHost, WorldDocument } from '@dungeon-scrivener/model';
import tavernWorldJson from '../../../fixtures/tavern-at-dusk/world.json';
import { createGameEngine } from '../../engine/src/index.js';
import { compileScript, compileWorldScripts, ScriptExecutor, scriptCompiler } from '@dungeon-scrivener/scripting';

const world = tavernWorldJson as unknown as WorldDocument;

function sourceForPath(path: string): string | undefined {
  try {
    return readFileSync(new URL(`../../../fixtures/tavern-at-dusk/${path}`, import.meta.url), 'utf8');
  } catch {
    return undefined;
  }
}

function engineHost(): GameEngineHost {
  return {
    scriptExecutor: new ScriptExecutor(),
    seededSeedSource: { nextUint32: () => 123 },
    unseededRandomSource: { nextUint32: () => 0x8000_0000 },
    mediaAssets: {
      resolveAsset: (assetId) => ({
        ok: false,
        diagnostic: { code: 'test-missing-asset', severity: 'error', message: `Missing ${assetId}.` },
      }),
    },
  };
}

describe('public scripting package', () => {
  it('compiles each world declaration into the engine bundle contract', () => {
    const bundle = compileWorldScripts(world, sourceForPath);
    expect('diagnostics' in bundle).toBe(false);
    if ('diagnostics' in bundle) throw new Error(JSON.stringify(bundle.diagnostics));

    expect(bundle).toMatchObject({
      format: 'dungeon-scrivener-compiled-script-bundle',
      schemaVersion: 1,
      scripts: world.scripts.map((reference) => ({
        scriptId: reference.id,
        sourcePath: reference.path,
        sourceLanguage: reference.language,
        entrypoint: reference.entrypoint,
      })),
    });
    expect(bundle.scripts).toHaveLength(world.scripts.length);

    const session = createGameEngine(engineHost(), bundle).createSession('tavern-at-dusk', world, {
      wallClockEpochMilliseconds: 1_000_000,
      visibility: 'visible',
      focused: true,
    });
    expect(session.ok, session.ok ? undefined : JSON.stringify(session.diagnostics)).toBe(true);
  });

  it('exposes the canonical single-script compiler and preserves frontend diagnostics', () => {
    expect(scriptCompiler.compileScript).toBe(compileScript);
    const reference = world.scripts.find((entry) => entry.language === 'javascript')!;
    const invalid = compileScript('function main( {', reference);
    expect('diagnostics' in invalid).toBe(true);
    if (!('diagnostics' in invalid)) throw new Error('Invalid source compiled successfully.');
    expect(invalid.format).toBe('dungeon-scrivener-diagnostics');
    expect(invalid.diagnostics[0]).toMatchObject({
      path: reference.path,
      sourceSpan: { path: reference.path },
      blocks: ['script-execution', 'play', 'export'],
    });
  });

  it('returns a missing-source diagnostic tied to the declaration', () => {
    const missing = compileWorldScripts({ scripts: [world.scripts[0]!] }, () => undefined);
    expect('diagnostics' in missing).toBe(true);
    if (!('diagnostics' in missing)) throw new Error('Missing source did not produce diagnostics.');
    expect(missing.diagnostics[0]).toMatchObject({
      path: world.scripts[0]!.path,
      entityId: world.scripts[0]!.id,
    });
  });
});
