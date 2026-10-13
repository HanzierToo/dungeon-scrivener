import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GameEngineApi, LocaleDocument, ProjectManifest, SessionSnapshot, WorldDocument } from '@dungeon-scrivener/model';
import manifestJson from '../../../fixtures/linear-three-nodes/project.json';
import worldJson from '../../../fixtures/linear-three-nodes/world.json';
import localeJson from '../../../fixtures/linear-three-nodes/locales/en-GB.json';
import { EnginePlayer } from './EnginePlayer.js';

describe('EnginePlayer recovery', () => {
  it('renders a diagnostic instead of throwing when the engine cannot create a view', () => {
    const engine = { getPlayerView: () => { throw new Error('Condition references invalid state start-looked-around.'); } } as unknown as GameEngineApi;
    const html = renderToStaticMarkup(createElement(EnginePlayer, {
      engine,
      manifest: manifestJson as ProjectManifest,
      world: worldJson as WorldDocument,
      locales: [localeJson as LocaleDocument],
      snapshot: { currentNodeId: 'old-gate' } as SessionSnapshot,
      onSnapshot: () => undefined,
      recoveryAction: { label: 'Return to editor', onClick: () => undefined },
    }));
    expect(html).toContain('Game could not be started');
    expect(html).toContain('Condition references invalid state start-looked-around.');
    expect(html).toContain('Return to editor');
  });
});
