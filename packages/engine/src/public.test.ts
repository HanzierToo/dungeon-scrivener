import { describe, expect, it } from 'vitest';
import type {
  CompiledScriptBundle, GameEngineHost, LocaleDocument, ProjectManifest, SessionStartOptions, WorldDocument,
} from '@dungeon-scrivener/model';
import tavernManifestJson from '../../../fixtures/tavern-at-dusk/project.json';
import tavernWorldJson from '../../../fixtures/tavern-at-dusk/world.json';
import enGbJson from '../../../fixtures/tavern-at-dusk/locales/en-GB.json';
import { createGameEngine } from './index.js';

const manifest = tavernManifestJson as unknown as ProjectManifest;
const sourceWorld = tavernWorldJson as unknown as WorldDocument;
const locales = [enGbJson] as unknown as readonly LocaleDocument[];
const scripts: CompiledScriptBundle = { format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts: [] };

describe('@dungeon-scrivener/engine public entry point', () => {
  it('creates a Tavern session and localized PlayerView through the exported factory', () => {
    let mediaRequests = 0;
    const host: GameEngineHost = {
      scriptExecutor: {
        executeScript: () => ({ ok: true, instructionsExecuted: 0, trace: [] }),
      },
      mediaAssets: {
        resolveAsset: (assetId) => {
          mediaRequests += 1;
          return { ok: false, diagnostic: { code: 'test-missing-asset', severity: 'warning', message: `Missing ${assetId}.` } };
        },
      },
    };
    const engine = createGameEngine(host, scripts);
    const world = { ...sourceWorld, scripts: [] };
    const options: SessionStartOptions = {
      wallClockEpochMilliseconds: 1_000_000,
      visibility: 'visible',
      focused: true,
    };
    const session = engine.createSession('tavern-at-dusk', world, options);
    if (!session.ok) throw new Error(session.diagnostics.diagnostics.map((item) => item.message).join('\n'));
    expect(session.ok).toBe(true);

    const view = engine.getPlayerView(manifest, world, locales, session.snapshot);
    expect(view).toMatchObject({
      format: 'dungeon-scrivener-player-view',
      projectId: 'tavern-at-dusk',
      locale: 'en-GB',
      gameTitle: 'Tavern at Dusk',
      currentNode: { id: 'taproom', title: 'The Taproom' },
      clock: { gameTimeMilliseconds: 0, display: '00:00' },
      typingSounds: { fallback: { kind: 'silent' } },
    });
    expect(view.currentNode.blocks.length).toBeGreaterThan(0);
    expect(view.choices.map((choice) => choice.label)).toContain('Go down to the cellar');
    expect(view.commands.length).toBeGreaterThan(0);
    expect(view.inventory).toEqual([]);
    expect(mediaRequests).toBeGreaterThan(0);
    expect(view.diagnostics.some((item) => item.code === 'test-missing-asset')).toBe(true);
  });
});
