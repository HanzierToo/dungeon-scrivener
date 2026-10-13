import { useMemo, useState } from 'react';
import { createGameEngine } from '@dungeon-scrivener/engine';
import { createMediaAssetCatalog } from '@dungeon-scrivener/media';
import type { CompiledScriptBundle, SessionSnapshot } from '@dungeon-scrivener/model';
import { EnginePlayer } from '@dungeon-scrivener/player';
import { scriptExecutor } from '@dungeon-scrivener/scripting';
import { ashenLocale, ashenManifest, ashenWorld } from './ashen-bell.js';

const emptyScripts: CompiledScriptBundle = { format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts: [] };

export function SamplePreview({ onClose }: { readonly onClose: () => void }) {
  const engine = useMemo(() => createGameEngine({ scriptExecutor, mediaAssets: createMediaAssetCatalog(),
    seededSeedSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! },
    unseededRandomSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! },
  }, emptyScripts), []);
  const [start] = useState(() => engine.createSession(ashenManifest.projectId, ashenWorld, {
    wallClockEpochMilliseconds: Date.now(), visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible', focused: document.hasFocus(),
  }));
  const [snapshot, setSnapshot] = useState<SessionSnapshot | undefined>(start.ok ? start.snapshot : undefined);
  return <div className="sample-preview"><header><button type="button" onClick={onClose}>← Back to projects</button><strong>The Ashen Bell</strong><span>Example game</span></header>
    {start.ok ? <EnginePlayer engine={engine} manifest={ashenManifest} world={ashenWorld} locales={[ashenLocale]} {...(snapshot ? { snapshot } : {})} onSnapshot={setSnapshot} />
      : <main role="alert"><h1>Example could not start</h1>{start.diagnostics.diagnostics.map(item => <p key={item.code}>{item.code}: {item.message}</p>)}</main>}
  </div>;
}
