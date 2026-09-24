import type { ProjectVfsSnapshot, TypingSoundFallback, TypingSoundMapping, TypingSoundTarget, WorldDocument } from '@dungeon-scrivener/model';
import type { RegisteredAsset } from '../../media/src/index.js';

export interface ApprenticeAuthorSettingsProps {
  readonly world: WorldDocument;
  readonly project?: ProjectVfsSnapshot | undefined;
  readonly assets?: readonly RegisteredAsset[] | undefined;
  readonly onWorldChange: (world: WorldDocument) => void;
}

const groups: readonly Extract<TypingSoundTarget, { kind: 'group' }>['group'][] = ['letters', 'digits', 'space', 'punctuation', 'editing', 'other'];
const soundHash = (assetId: string) => assetId.startsWith('sha256:') ? assetId.slice('sha256:'.length) : assetId;

export function ApprenticeAuthorSettings({ world, project, assets = [], onWorldChange }: ApprenticeAuthorSettingsProps) {
  const soundAssets = assets.filter((asset) => asset.mediaType === 'audio/wav');
  const sounds = world.settings.typingSounds ?? { mappings: [], fallback: { kind: 'silent' as const } };
  const assetFallback = sounds.fallback.kind === 'asset' ? sounds.fallback : undefined;
  const usedGroups = new Set(sounds.mappings.flatMap((mapping) => mapping.target.kind === 'group' ? [mapping.target.group] : []));
  const nextGroup = groups.find((group) => !usedGroups.has(group));
  const cssPaths = [...(project?.files.keys() ?? [])].filter((path) => path.toLowerCase().endsWith('.css')).sort();
  const updateSounds = (mappings: readonly TypingSoundMapping[], fallback: TypingSoundFallback) => onWorldChange({
    ...world,
    settings: { ...world.settings, typingSounds: { ...sounds, mappings, fallback } },
  });
  const updateMapping = (index: number, mapping: TypingSoundMapping) => updateSounds(sounds.mappings.map((item, i) => i === index ? mapping : item), sounds.fallback);

  return <section aria-label="Author theme and typing sounds" style={{ display: 'grid', gap: 10 }}>
    <h2>Author theme and typing sounds</h2>
    <fieldset>
      <legend>Player CSS theme</legend>
      <label>Stylesheet <select value={world.settings.playerStylePath ?? ''} onChange={(event) => {
        const { playerStylePath: _previousPath, ...baseSettings } = world.settings;
        const settings = event.target.value ? { ...baseSettings, playerStylePath: event.target.value } : baseSettings;
        onWorldChange({ ...world, settings });
      }}><option value="">Use default player theme</option>{cssPaths.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>
      <p>CSS files remain project files and can be edited in Sage. Only a project-local stylesheet path is stored in the world model.</p>
    </fieldset>
    <fieldset>
      <legend>Typing sound mappings</legend>
      {sounds.mappings.map((mapping, index) => <div key={index} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end', margin: '8px 0' }}>
        <label>Target <select value={mapping.target.kind === 'group' ? `group:${mapping.target.group}` : 'key'} onChange={(event) => {
          const [kind, value] = event.target.value.split(':');
          const target: TypingSoundTarget = kind === 'group' ? { kind: 'group', group: (value ?? 'letters') as typeof groups[number] } : { kind: 'key', code: mapping.target.kind === 'key' ? mapping.target.code : 'KeyA' };
          updateMapping(index, { ...mapping, target });
        }}><optgroup label="Key groups">{groups.map((group) => <option key={group} value={`group:${group}`}>{group}</option>)}</optgroup><option value="key">Exact key</option></select></label>
        {mapping.target.kind === 'key' && <label>KeyboardEvent.code <input value={mapping.target.code} onChange={(event) => updateMapping(index, { ...mapping, target: { kind: 'key', code: event.target.value } })} /></label>}
        <label>WAV asset <select value={`sha256:${mapping.assetHash}`} onChange={(event) => updateMapping(index, { ...mapping, assetHash: soundHash(event.target.value) })}><option value="">Choose WAV</option>{!soundAssets.some((asset) => soundHash(asset.assetId) === mapping.assetHash) && <option value={`sha256:${mapping.assetHash}`}>{mapping.assetHash} · unavailable</option>}{soundAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.originalFilenames.join(', ')} · {asset.assetId}</option>)}</select></label>
        <label>Volume <input type="number" min="0" max="1" step="0.01" value={mapping.volume} onChange={(event) => updateMapping(index, { ...mapping, volume: Number(event.target.value) })} /></label>
        <button type="button" onClick={() => updateSounds(sounds.mappings.filter((_item, i) => i !== index), sounds.fallback)}>Remove mapping</button>
      </div>)}
      <button type="button" disabled={!soundAssets.length || !nextGroup} onClick={() => {
        const asset = soundAssets[0];
        if (!asset || !nextGroup) return;
        updateSounds([...sounds.mappings, { target: { kind: 'group', group: nextGroup }, assetHash: soundHash(asset.assetId), volume: 1 }], sounds.fallback);
      }}>Add key-group mapping</button>
      {!soundAssets.length && <p>No registered WAV assets are available. Add one through the media library to assign a typing sound.</p>}
    </fieldset>
    <fieldset>
      <legend>Fallback typing sound</legend>
      <label>Fallback <select value={sounds.fallback.kind} onChange={(event) => updateSounds(sounds.mappings, event.target.value === 'silent' ? { kind: 'silent' } : { kind: 'asset', assetHash: soundAssets[0] ? soundHash(soundAssets[0].assetId) : '', volume: 1 })}><option value="silent">Silent</option><option value="asset" disabled={!soundAssets.length}>Use WAV asset</option></select></label>
      {assetFallback && <><label>WAV asset <select value={`sha256:${assetFallback.assetHash}`} onChange={(event) => updateSounds(sounds.mappings, { ...assetFallback, assetHash: soundHash(event.target.value) })}>{!soundAssets.some((asset) => soundHash(asset.assetId) === assetFallback.assetHash) && <option value={`sha256:${assetFallback.assetHash}`}>{assetFallback.assetHash} · unavailable</option>}{soundAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.originalFilenames.join(', ')} · {asset.assetId}</option>)}</select></label><label>Volume <input type="number" min="0" max="1" step="0.01" value={assetFallback.volume} onChange={(event) => updateSounds(sounds.mappings, { ...assetFallback, volume: Number(event.target.value) })} /></label></>}
    </fieldset>
  </section>;
}
