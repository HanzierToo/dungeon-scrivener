import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { DiagnosticReport, GameEngineApi, MediaAssetApi, PlayerInput, PlayerInputTransitionResult, ProjectManifest, SessionSnapshot, WorldDocument, PlayerView } from '@dungeon-scrivener/model';
import { EnginePlayer, Player } from '../src/index.js';
import wavPath from './assets/tavern.wav?url';
import pngPath from './assets/tavern.png?url';

const fixture: PlayerView = {
  format: 'dungeon-scrivener-player-view', schemaVersion: 1, projectId: 'tavern-at-dusk', locale: 'en-GB',
  gameTitle: 'The Lantern at Dusk', currentNode: { id: 'old-gate', title: 'The old gate', blocks: [
    { kind: 'paragraph', children: [{ kind: 'emphasis', children: [{ kind: 'text', text: 'Rain' }] }, { kind: 'text', text: ' taps the stone. <script>window.compromised = true</script>' }] },
    { kind: 'table', header: [[{ kind: 'text', text: 'Place' }], [{ kind: 'text', text: 'Sound' }]], rows: [[[{ kind: 'text', text: 'Gate' }], [{ kind: 'code', text: 'creak' }]]] },
    { kind: 'paragraph', children: [{ kind: 'asset', assetId: 'sha256:db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399', mediaType: 'image/png', alt: 'Tavern lantern' }, { kind: 'text', text: ' ' }, { kind: 'asset', assetId: 'sha256:dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690', mediaType: 'audio/wav', alt: 'Tavern ambience' }] },
  ] },
  choices: [{ id: 'enter-cellar', label: 'Enter cellar', enabled: true }, { id: 'script-success', label: 'Ask for the silver song', enabled: true }, { id: 'script-broken', label: 'Cast the unstable spell', enabled: true }],
  commands: [{ id: 'count-candles', patterns: ['count candles {count}'], parameters: [], enabled: true }],
  dialogue: { conversationId: 'mira-story', lineId: 'mira-first', speakerEntityId: 'mira', speakerName: 'Mira', text: 'The rain remembers every traveler.', options: [{ id: 'ask-about-rain', label: 'Ask about the rain', enabled: true }], canResume: false },
  inventory: [{ stackId: 'stack-0', itemId: 'silver-key', owner: { kind: 'world' }, label: 'Silver key', quantity: 1, fields: {} }],
  clock: { gameTimeMilliseconds: 120000, display: '00:02' },
  typingSounds: { mappings: [{ target: { kind: 'group', group: 'letters' }, asset: { assetId: 'sha256:dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690', mediaType: 'audio/wav', byteLength: 35324 }, volume: 0.25 }], fallback: { kind: 'silent' } }, diagnostics: [],
};

function App() {
  const [view, setView] = useState(fixture);
  const [lastInput, setLastInput] = useState('');
  const [locale, setLocale] = useState('en-GB');
  const [trust, setTrust] = useState(0);
  const [snapshotUpdates, setSnapshotUpdates] = useState(0);
  const hostSnapshot = {} as SessionSnapshot;
  const hostEngine = { getPlayerView: () => view, dispatchPlayerInput: (_world: WorldDocument, _snapshot: SessionSnapshot, playerInput: PlayerInput) => input(playerInput) } as unknown as GameEngineApi;
  const [mediaAssets, setMediaAssets] = useState<MediaAssetApi>();
  useEffect(() => {
    void Promise.all([fetch(wavPath).then(response => response.arrayBuffer()), fetch(pngPath).then(response => response.arrayBuffer())]).then(([wav, png]) => {
      const assets = new Map([
        ['sha256:dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690', { bytes: new Uint8Array(wav), mediaType: 'audio/wav', byteLength: wav.byteLength }],
        ['sha256:db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399', { bytes: new Uint8Array(png), mediaType: 'image/png', byteLength: png.byteLength }],
      ]);
      setMediaAssets({ resolveAsset(assetId) { const asset = assets.get(assetId); return asset ? { ok: true, asset: { ...asset, assetId } } : { ok: false, diagnostic: { code: 'missing', severity: 'error', message: 'Missing fixture asset.', blocks: ['play'] } }; } });
    });
  }, []);
  function input(value: PlayerInput): PlayerInputTransitionResult | undefined {
    setLastInput(JSON.stringify(value));
    if (value.kind === 'choice' && value.actionId === 'script-success') {
      setTrust(current => current + 1);
      return {
        snapshot: {} as PlayerInputTransitionResult['snapshot'],
        resolution: { kind: 'choice', actionId: value.actionId },
        trace: [{ sequence: 0, kind: 'script', source: { kind: 'script', scriptId: 'trust-effect' }, reason: 'Script trust-effect changed world.trust from 0 to 1.' }],
        diagnostics: { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics: [] },
      };
    }
    if (value.kind === 'choice' && value.actionId === 'script-broken') {
      return {
        snapshot: {} as PlayerInputTransitionResult['snapshot'],
        resolution: { kind: 'invalid-input', diagnostic: { code: 'DS-SCRIPT-EXEC-001', severity: 'error', message: 'Script execution failed: unsupported runtime value.', entityId: 'broken-script', path: 'scripts/broken.js', sourceSpan: { path: 'scripts/broken.js', startLine: 4, startColumn: 7, endLine: 4, endColumn: 20 }, blocks: ['play', 'script-execution'] } },
        trace: [{ sequence: 0, kind: 'script', source: { kind: 'script', scriptId: 'broken-script' }, reason: 'Script failed at scripts/broken.js:4:7.' }],
        diagnostics: { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics: [{ code: 'DS-SCRIPT-EXEC-001', severity: 'error', message: 'Script execution failed: unsupported runtime value.', entityId: 'broken-script', path: 'scripts/broken.js', sourceSpan: { path: 'scripts/broken.js', startLine: 4, startColumn: 7, endLine: 4, endColumn: 20 }, blocks: ['play', 'script-execution'] }] },
      };
    }
    return undefined;
  }
  const query = new URLSearchParams(location.search);
  const themeCss = query.has('unsafe') ? '@import url(https://example.invalid/theme.css);' : query.has('aggressive') ? '#root * { display: none !important; }' : '.ds-player { --ds-player-accent: #d67bff; } .ds-player__scene { border: 1px solid var(--ds-player-accent); }';
  if (query.has('startup-failure')) {
    const startupFailure: DiagnosticReport = { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics: [{ code: 'DS-ENG-013', severity: 'error', message: 'Compiled script bundle is missing a required script.', path: 'scripts/required.js', blocks: ['play'] }] };
    return <Player startupFailure={startupFailure} onInput={input} />;
  }
  return <><EnginePlayer engine={hostEngine} manifest={{} as ProjectManifest} world={{} as WorldDocument} locales={[]} requestedLocale={view.locale} snapshot={hostSnapshot} onSnapshot={() => setSnapshotUpdates(current => current + 1)} mediaAssets={mediaAssets} themeCss={themeCss} localeOptions={[{ locale: 'en-GB', label: 'English' }, { locale: 'fr-FR', label: 'Français' }]} onLocaleChange={value => { setLocale(value); setView(current => ({ ...current, locale: value })); }} onLoad={file => { document.body.dataset['loadedFile'] = file.name; }} onOpenSettings={() => undefined} />
    <div data-testid="last-player-input">{lastInput}</div><div data-testid="selected-locale">{locale}</div><div data-testid="host-trust">{trust}</div><div data-testid="snapshot-updates">{snapshotUpdates}</div></>;
}

createRoot(document.getElementById('root')!).render(<App />);
