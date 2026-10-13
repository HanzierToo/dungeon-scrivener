import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type {
  ActionOutcome,
  ActionSet,
  ChoiceDefinition,
  CommandDefinition,
  Condition,
  ConversationDefinition,
  DialogueLine,
  DialogueOption,
  Effect,
  EntityDefinition,
  EntityInstance,
  EventDefinition,
  ItemDefinition,
  NodeDefinition,
  LocaleDocument,
  MediaAssetApi,
  ProjectVfsSnapshot,
  RuleDefinition,
  Scalar,
  StateFieldDefinition,
  StateReference,
  StateScope,
  TextSource,
  ValueType,
  WorldDocument,
} from '@dungeon-scrivener/model';
import { resolveNodeActions, resolveNodeRules } from '@dungeon-scrivener/model';
import type { RegisteredAsset } from '../../media/src/index.js';
import { RichContentEditor } from './rich-content.js';
import { CollectionBrowser } from './CollectionBrowser.js';
import { ApprenticeAuthorSettings } from './author-settings.js';
import { applyGraphCommand, referencesNavigationEdge, updateNodeDefinition } from './commands.js';
import { publishRemoval } from './removal.js';
import { removeLocaleKeys, renameLocaleKey } from './locale-keys.js';
import { formatPatternInput, parsePatternInput } from './pattern-input.js';

export interface ApprenticeFormsProps {
  readonly world: WorldDocument;
  readonly view?: 'scene' | 'actions' | 'text' | 'logic' | 'world' | 'all';
  readonly selectedNodeId?: string;
  readonly actionFocus?: { readonly kind: 'choice' | 'command'; readonly id: string; readonly outcomeId?: string | undefined; readonly request: number } | undefined;
  readonly requestedWorldSection?: { readonly section: string; readonly entityId?: string | undefined; readonly request: number } | undefined;
  readonly onWorldChange: (world: WorldDocument) => void;
  readonly project?: ProjectVfsSnapshot | undefined;
  readonly locales?: readonly LocaleDocument[] | undefined;
  readonly defaultLocale?: string | undefined;
  readonly assets?: readonly RegisteredAsset[] | undefined;
  readonly mediaAssets?: MediaAssetApi | undefined;
  readonly onLocalesChange?: ((locales: readonly LocaleDocument[]) => void) | undefined;
  readonly onProjectContentChange?: ((world: WorldDocument, locales: readonly LocaleDocument[]) => void) | undefined;
  readonly onImportAsset?: ((file: File) => Promise<RegisteredAsset>) | undefined;
}

type ContentSettings = Pick<ApprenticeFormsProps, 'project' | 'locales' | 'defaultLocale' | 'assets' | 'mediaAssets' | 'onLocalesChange' | 'onImportAsset'>;

const uid = () => `id-${crypto.randomUUID().replaceAll('-', '')}`;
const fieldStyle = { display: 'grid' } as const;
const inputStyle = { maxWidth: 480, width: '100%' } as const;

function HelpTip({ label, children }: { label: string; children: string }) {
  const id = useId();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const show = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const width = Math.min(256, window.innerWidth - 16);
    const height = Math.min(160, window.innerHeight - 16);
    const preferredTop = window.innerHeight - rect.bottom - 8 >= height ? rect.bottom + 8 : rect.top - height - 8;
    setPosition({
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8)),
    });
  };
  return <span className="apprentice-help">
    <button type="button" aria-label={`Help: ${label}`} aria-describedby={position ? id : undefined}
      onMouseEnter={event => show(event.currentTarget)} onMouseLeave={() => setPosition(null)}
      onFocus={event => show(event.currentTarget)} onBlur={() => setPosition(null)}
      onKeyDown={event => { if (event.key === 'Escape') { setPosition(null); event.currentTarget.blur(); } }}>?</button>
    {position && <span id={id} role="tooltip" className="apprentice-help__tooltip"
      style={{ left: position.left, top: position.top }}>{children}</span>}
  </span>;
}

function TextSourceField({ label, value, onChange, multiline = false }: { multiline?: boolean; label: string; value: TextSource; onChange: (next: TextSource) => void }) {
  return <fieldset className="apprentice-text-source" style={fieldStyle}><legend>{label}</legend>
    <label>Text source <select value={value.kind} onChange={(event) => onChange(event.target.value === 'literal' ? { kind: 'literal', text: '' } : { kind: 'locale-key', key: '' })}>
      <option value="literal">Literal text</option><option value="locale-key">Locale key</option>
    </select></label>
    <label>{value.kind === 'literal' ? 'Text' : 'Locale key'} {multiline && value.kind === 'literal' ? <textarea rows={6} value={value.text} onChange={event => onChange({ kind: 'literal', text: event.target.value })} /> : <input style={inputStyle} value={value.kind === 'literal' ? value.text : value.key} onChange={(event) => onChange(value.kind === 'literal' ? { kind: 'literal', text: event.target.value } : { kind: 'locale-key', key: event.target.value })} />}</label>
    {value.kind === 'locale-key' && <p className="apprentice-text-source__hint">Edit this key’s player-facing text in Text / Translations.</p>}
  </fieldset>;
}

function ScopeField({ value, onChange, world }: { value: StateScope; onChange: (next: StateScope) => void; world: WorldDocument }) {
  return <label>Scope <select value={`${value.kind}:${value.kind === 'world' ? '' : value.ownerId}`} onChange={(event) => {
    const [kind, ownerId] = event.target.value.split(':');
    if (kind === 'world') onChange({ kind: 'world' });
    else if (kind === 'node') onChange({ kind: 'node', ownerId: ownerId ?? '' });
    else onChange({ kind: 'entity', ownerId: ownerId ?? '' });
  }}>
    <option value="world:">World</option>
    {world.nodes.map((node) => <option key={`node:${node.id}`} value={`node:${node.id}`}>Node: {sourceLabel(node.title)}</option>)}
    {world.entities.map((entity) => <option key={`entity:${entity.id}`} value={`entity:${entity.id}`}>Actor: {sourceLabel(entity.name)}</option>)}
  </select></label>;
}

function sourceLabel(text: TextSource): string { return text.kind === 'literal' ? text.text : text.key || '(untranslated)'; }
function sceneLabel(world: WorldDocument, nodeId: string, strings: Readonly<Record<string, string>> = {}): string {
  const title = world.nodes.find(node => node.id === nodeId)?.title;
  return title ? title.kind === 'literal' ? title.text : strings[title.key] ?? title.key : 'Missing scene';
}
function routeLabel(world: WorldDocument, edge: WorldDocument['navigationEdges'][number], strings: Readonly<Record<string, string>> = {}): string {
  return `${sceneLabel(world, edge.fromNodeId, strings)} → ${sceneLabel(world, edge.toNodeId, strings)}`;
}

function StateFieldsEditor({ fields, onChange, allowAdd = true, showKey = true, allowRemove = true }: { fields: readonly StateFieldDefinition[]; onChange: (fields: readonly StateFieldDefinition[]) => void; allowAdd?: boolean; showKey?: boolean; allowRemove?: boolean }) {
  return <fieldset style={fieldStyle}><legend>State fields</legend><HelpTip label="State fields">These are facts remembered about this actor or event. True or false suits flags such as unlocked; whole numbers suit counts. A key is the name used by conditions and effects.</HelpTip>
    {fields.map((field, index) => <div key={`${field.key}-${index}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
      {showKey && <label>Key <input value={field.key} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} /></label>}
      <label>Type <select value={typeof field.valueType === 'string' ? field.valueType : 'enum'} onChange={(event) => {
        const kind = event.target.value;
        const valueType = kind === 'enum' ? { kind: 'enum' as const, values: [] } : kind as 'string' | 'number' | 'integer' | 'boolean';
        const defaultValue: Scalar = kind === 'boolean' ? false : kind === 'number' || kind === 'integer' ? 0 : '';
        onChange(fields.map((item, i) => i === index ? { ...item, valueType, defaultValue } : item));
      }}><option value="string">Text</option><option value="number">Number</option><option value="integer">Whole number</option><option value="boolean">True or false</option><option value="enum">One of a list</option></select></label>
      {typeof field.valueType !== 'string' && <label>Allowed values <input value={field.valueType.values.join(', ')} onChange={(event) => onChange(fields.map((item, i) => i === index && typeof item.valueType !== 'string' ? { ...item, valueType: { ...item.valueType, values: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } } : item))} /></label>}
      <label>Default {typeof field.defaultValue === 'boolean' ? <select value={String(field.defaultValue)} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, defaultValue: event.target.value === 'true' } : item))}><option value="false">false</option><option value="true">true</option></select> : <input type={typeof field.defaultValue === 'number' ? 'number' : 'text'} value={field.defaultValue} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, defaultValue: typeof item.defaultValue === 'number' ? Number(event.target.value) : event.target.value } : item))} />}</label>
      {allowRemove && <button type="button" onClick={() => onChange(fields.filter((_item, i) => i !== index))}>Remove field</button>}
    </div>)}
    {allowAdd && <button type="button" onClick={() => onChange([...fields, { key: uid(), valueType: 'boolean', defaultValue: false }])}>Add state field</button>}
  </fieldset>;
}

function stateReferencePaths(world: WorldDocument): Map<string, string[]> {
  const references = new Map<string, string[]>();
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, `${path}[${index}]`)); return; }
    const object = value as Record<string, unknown>;
    const scope = object['scope'];
    if (scope && typeof scope === 'object' && 'kind' in scope && typeof object['key'] === 'string') {
      const kind = (scope as { kind: string }).kind;
      if (kind === 'world' || kind === 'node') {
        const identity = `${kind}:${object['key']}`;
        const paths = references.get(identity) ?? [];
        paths.push(path);
        references.set(identity, paths);
      }
    }
    for (const [key, child] of Object.entries(object)) visit(child, `${path}.${key}`);
  };
  visit(world.actionDefaults, 'actionDefaults');
  visit(world.nodes, 'nodes');
  visit(world.rules, 'rules');
  visit(world.conversations, 'conversations');
  visit(world.eventDefinitions, 'eventDefinitions');
  return references;
}

function renameStateDefinition(world: WorldDocument, index: number, name: string): WorldDocument {
  const old = world.stateDefinitions[index]!;
  const copy = structuredClone(world) as unknown as Record<string, unknown>;
  const definitions = copy['stateDefinitions'] as Array<Record<string, unknown>>;
  definitions[index]!['key'] = name;
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const object = value as Record<string, unknown>;
    const scope = object['scope'];
    if (scope && typeof scope === 'object' && (scope as { kind?: string }).kind === old.scopeKind && object['key'] === old.key) object['key'] = name;
    Object.values(object).forEach(visit);
  };
  visit(copy['actionDefaults']);
  visit(copy['nodes']);
  visit(copy['rules']);
  visit(copy['conversations']);
  visit(copy['eventDefinitions']);
  const move = (values: Record<string, unknown>) => { if (Object.hasOwn(values, old.key)) { values[name] = values[old.key]; delete values[old.key]; } };
  if (old.scopeKind === 'world') move(copy['worldState'] as Record<string, unknown>);
  else for (const node of copy['nodes'] as Array<Record<string, unknown>>) if (node['state'] && typeof node['state'] === 'object') move(node['state'] as Record<string, unknown>);
  return copy as unknown as WorldDocument;
}

function changeStateDefinitionScope(world: WorldDocument, index: number, scopeKind: 'world' | 'node'): WorldDocument {
  const field = world.stateDefinitions[index]!;
  const worldState = { ...world.worldState };
  if (scopeKind === 'node') delete worldState[field.key];
  else worldState[field.key] = field.defaultValue;
  return { ...world, worldState, stateDefinitions: world.stateDefinitions.map((item, position) => position === index ? { ...item, scopeKind } : item) };
}

function removeStateDefinition(world: WorldDocument, index: number): WorldDocument {
  const field = world.stateDefinitions[index]!;
  const worldState = { ...world.worldState };
  if (field.scopeKind === 'world') delete worldState[field.key];
  const nodes = field.scopeKind === 'node' ? world.nodes.map(node => {
    if (!node.state || !Object.hasOwn(node.state, field.key)) return node;
    const state = { ...node.state };
    delete state[field.key];
    return { ...node, state };
  }) : world.nodes;
  return { ...world, worldState, nodes, stateDefinitions: world.stateDefinitions.filter((_item, position) => position !== index) };
}

function RenameStateField({ field, inUse, names, onRename }: { field: WorldDocument['stateDefinitions'][number]; inUse: readonly string[]; names: ReadonlySet<string>; onRename: (key: string) => void }) {
  const [draft, setDraft] = useState(field.key);
  const target = draft.trim();
  const conflict = names.has(`${field.scopeKind}:${target}`) && target !== field.key;
  return <div className="apprentice-state-rename"><label>State key<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <button type="button" disabled={!target || target === field.key || conflict} onClick={() => onRename(target)}>Rename key and references</button>
    {conflict && <p role="alert">That key already exists in this scope.</p>}
    <p>{inUse.length} structured condition or effect references will follow this name. {inUse.slice(0, 5).join(', ')}{inUse.length > 5 ? ', …' : ''} Script source is not rewritten; check it in Sage.</p>
  </div>;
}

function WorldStateEditor({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  const references = useMemo(() => stateReferencePaths(world), [world]);
  const names = useMemo(() => new Set(world.stateDefinitions.map(field => `${field.scopeKind}:${field.key}`)), [world.stateDefinitions]);
  return <section><div className="apprentice-section-title"><h2>State definitions</h2><HelpTip label="State definitions">State fields store facts your game remembers, such as whether a lantern is lit. Choices and commands can change them with effects.</HelpTip></div>
    <CollectionBrowser name="State definitions" items={world.stateDefinitions} title={field => field.key} summary={field => `${field.scopeKind} · ${typeof field.valueType === 'string' ? field.valueType : 'enum'} · ${references.get(`${field.scopeKind}:${field.key}`)?.length ?? 0} references`}
      addLabel="Add world state" onAdd={() => { const key = uid(); onWorldChange({ ...world, stateDefinitions: [...world.stateDefinitions, { key, scopeKind: 'world', valueType: 'boolean', defaultValue: false }], worldState: { ...world.worldState, [key]: false } }); }}
      canDeleteSelected={indices => indices.every(index => { const field = world.stateDefinitions[index]; return !!field && (references.get(`${field.scopeKind}:${field.key}`)?.length ?? 0) === 0; })}
      deleteBlockedText="Remove condition and effect references to the selected definitions before deleting them."
      onDeleteSelected={indices => onWorldChange([...indices].sort((a, b) => b - a).reduce((next, index) => removeStateDefinition(next, index), world))}
      renderEditor={(field, index) => <fieldset style={fieldStyle}><legend>{field.key}</legend>
      <RenameStateField key={`${field.scopeKind}:${field.key}`} field={field} inUse={references.get(`${field.scopeKind}:${field.key}`) ?? []} names={names} onRename={key => onWorldChange(renameStateDefinition(world, index, key))} />
      <label>Scope <select value={field.scopeKind} disabled={(references.get(`${field.scopeKind}:${field.key}`)?.length ?? 0) > 0 || field.scopeKind === 'node' && world.nodes.some(node => !!node.state && Object.hasOwn(node.state, field.key))} onChange={(event) => {
        const nextScope = event.target.value as 'world' | 'node';
        if (!names.has(`${nextScope}:${field.key}`)) onWorldChange(changeStateDefinitionScope(world, index, nextScope));
      }}><option value="world" disabled={names.has(`world:${field.key}`) && field.scopeKind !== 'world'}>World</option><option value="node" disabled={names.has(`node:${field.key}`) && field.scopeKind !== 'node'}>Node</option></select></label>
      <StateFieldsEditor fields={[field]} allowAdd={false} allowRemove={false} showKey={false} onChange={(fields) => { const next = fields[0]; if (next) onWorldChange({ ...world, stateDefinitions: world.stateDefinitions.map((item, i) => i === index ? { ...next, scopeKind: field.scopeKind } : item), worldState: field.scopeKind === 'world' && Object.is(world.worldState[field.key], field.defaultValue) ? { ...world.worldState, [field.key]: next.defaultValue } : world.worldState }); }} />
      <button type="button" disabled={(references.get(`${field.scopeKind}:${field.key}`)?.length ?? 0) > 0} onClick={() => onWorldChange(removeStateDefinition(world, index))}>Remove definition</button>
      {(references.get(`${field.scopeKind}:${field.key}`)?.length ?? 0) > 0 && <p>Remove the listed condition and effect references before deleting this definition.</p>}
    </fieldset>} />
  </section>;
}

function StateReferenceFields({ value, onChange, world }: { value: StateReference; onChange: (next: StateReference) => void; world: WorldDocument }) {
  const [keyQuery, setKeyQuery] = useState('');
  const scope = value.scope;
  const definitions = scope.kind === 'entity'
    ? world.entityDefinitions.find((definition) => definition.id === world.entities.find((entity) => entity.id === scope.ownerId)?.definitionId)?.fields ?? []
    : world.stateDefinitions.filter((definition) => definition.scopeKind === scope.kind);
  const matchingDefinitions = keyQuery.trim() ? definitions.filter(definition => definition.key.toLocaleLowerCase().includes(keyQuery.trim().toLocaleLowerCase())) : definitions;
  const shownDefinitions = matchingDefinitions.slice(0, 50);
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    <ScopeField value={value.scope} world={world} onChange={(scope) => onChange({ ...value, scope })} />
    {definitions.length > 25 && <label>Find state key<input type="search" value={keyQuery} onChange={event => setKeyQuery(event.target.value)} /></label>}
    <label>State key <select value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })}>
      <option value="">Choose a key</option>
      {value.key && !shownDefinitions.some(definition => definition.key === value.key) && <option value={value.key}>{value.key} · selected</option>}
      {shownDefinitions.map((definition) => <option key={definition.key} value={definition.key}>{definition.key}</option>)}
    </select></label>
    {matchingDefinitions.length > 50 && <small>Showing 50 of {matchingDefinitions.length} keys. Narrow your search.</small>}
  </div>;
}

function stateDefinition(world: WorldDocument, reference: StateReference): StateFieldDefinition | undefined {
  const scope = reference.scope;
  if (scope.kind === 'entity') {
    const entity = world.entities.find((candidate) => candidate.id === scope.ownerId);
    const definition = world.entityDefinitions.find((candidate) => candidate.id === entity?.definitionId);
    return definition?.fields.find((field) => field.key === reference.key);
  }
  return world.stateDefinitions.find((candidate) => candidate.key === reference.key && candidate.scopeKind === scope.kind);
}

function stateValueType(world: WorldDocument, reference: StateReference): ValueType {
  return stateDefinition(world, reference)?.valueType ?? 'string';
}

function comparisonValue(world: WorldDocument, reference: StateReference, current: Scalar): Scalar {
  const field = stateDefinition(world, reference);
  if (!field) return current;
  const type = field.valueType;
  const compatible = typeof type === 'object' ? typeof current === 'string' && type.values.includes(current)
    : type === 'boolean' ? typeof current === 'boolean'
      : type === 'string' ? typeof current === 'string'
        : typeof current === 'number' && Number.isFinite(current) && (type !== 'integer' || Number.isSafeInteger(current));
  return compatible ? current : field.defaultValue;
}

function ScalarField({ label, value, valueType, onChange }: { label: string; value: Scalar; valueType: ValueType; onChange: (value: Scalar) => void }) {
  if (typeof valueType === 'object') return <label>{label} <select value={String(value)} onChange={(event) => onChange(event.target.value)}>{valueType.values.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
  if (valueType === 'boolean') return <label>{label} <select value={String(value)} onChange={(event) => onChange(event.target.value === 'true')}><option value="false">false</option><option value="true">true</option></select></label>;
  if (valueType === 'number' || valueType === 'integer') return <label>{label} <input type="number" step={valueType === 'integer' ? 1 : 'any'} value={Number(value)} onChange={(event) => onChange(Number(event.target.value))} /></label>;
  return <label>{label} <input style={inputStyle} value={String(value)} onChange={(event) => onChange(event.target.value)} /></label>;
}

const emptyCondition = (): Condition => ({ kind: 'at-node', nodeId: '' });
function ConditionField({ label = 'Condition', value, onChange, world, required = false }: { required?: boolean; label?: string; value?: Condition | undefined; onChange: (next?: Condition) => void; world: WorldDocument }) {
  const current = value ?? emptyCondition();
  const set = (patch: Partial<Condition>) => onChange({ ...current, ...patch } as Condition);
  return <fieldset className="apprentice-condition" style={fieldStyle}><legend>{label}</legend><HelpTip label={label}>{required ? 'This requirement selects an outcome when the action runs. Outcomes are checked from top to bottom. It does not hide or disable the action.' : 'A condition controls when this action is available. Leave it off to make the action always available.'}</HelpTip>
    {!required && <label><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked ? emptyCondition() : undefined)} /> Enabled</label>}
    {value && <>
      <label>Requirement <select value={current.kind} onChange={(event) => {
        const kind = event.target.value;
        const defaults: Record<string, Condition> = {
          'at-node': { kind: 'at-node', nodeId: '' },
          'event-is': { kind: 'event-is', eventId: '' },
          'time-at-least': { kind: 'time-at-least', milliseconds: 0 },
          'compare-state': { kind: 'compare-state', left: { scope: { kind: 'world' }, key: '' }, operator: 'eq', right: '' },
          'has-tag': { kind: 'has-tag', entityId: '', tag: '' },
          'has-item': { kind: 'has-item', owner: { kind: 'world' }, itemId: '', quantity: 1 },
          'all': { kind: 'all', conditions: [] },
          'any': { kind: 'any', conditions: [] },
          'not': { kind: 'not', condition: emptyCondition() },
          'has-seen-line': { kind: 'has-seen-line', conversationId: '', lineId: '' },
          'has-selected-dialogue-option': { kind: 'has-selected-dialogue-option', conversationId: '', optionId: '' },
        };
        onChange(defaults[kind]);
      }}>
        <option value="at-node">Player is in a scene</option><option value="event-is">Responding to an event</option><option value="time-at-least">Time at least</option><option value="compare-state">Compare a remembered value</option><option value="has-tag">Actor has tag</option><option value="has-item">Has item</option><option value="all">Every requirement</option><option value="any">At least one requirement</option><option value="not">Requirement is false</option><option value="has-seen-line">Has seen dialogue line</option><option value="has-selected-dialogue-option">Has selected dialogue option</option>
      </select></label>
      {current.kind === 'at-node' && <label>Node <select value={current.nodeId} onChange={(event) => set({ nodeId: event.target.value })}><option value="">Choose node</option>{world.nodes.map((node) => <option key={node.id} value={node.id}>{sourceLabel(node.title)}</option>)}</select></label>}
      {current.kind === 'event-is' && <label>Event <select value={current.eventId} onChange={(event) => set({ eventId: event.target.value })}><option value="">Choose event</option>{world.eventDefinitions.map((event) => <option key={event.id} value={event.id}>{event.id}</option>)}</select></label>}
      {current.kind === 'time-at-least' && <label>Milliseconds <input type="number" min="0" value={current.milliseconds} onChange={(event) => set({ milliseconds: Number(event.target.value) })} /></label>}
      {current.kind === 'compare-state' && <><StateReferenceFields value={current.left} world={world} onChange={(left) => { const type = stateValueType(world, left); set({ left, right: comparisonValue(world, left, current.right), operator: type === 'number' || type === 'integer' || current.operator === 'eq' || current.operator === 'neq' ? current.operator : 'eq' }); }} /><label>Comparison <select value={current.operator} onChange={(event) => set({ operator: event.target.value as typeof current.operator })}>{(stateValueType(world, current.left) === 'number' || stateValueType(world, current.left) === 'integer' ? ['eq','neq','lt','lte','gt','gte'] : ['eq','neq']).map((operator) => <option key={operator} value={operator}>{{ eq: 'equals', neq: 'does not equal', lt: 'is less than', lte: 'is at most', gt: 'is greater than', gte: 'is at least' }[operator]}</option>)}</select></label><ScalarField label="Compared value" value={current.right} valueType={stateValueType(world, current.left)} onChange={(right) => set({ right })} /></>}
      {current.kind === 'has-tag' && <><label>Actor <select value={current.entityId} onChange={(event) => set({ entityId: event.target.value })}><option value="">Choose actor</option>{world.entities.map((entity) => <option key={entity.id} value={entity.id}>{sourceLabel(entity.name)}</option>)}</select></label><label>Tag <input value={current.tag} onChange={(event) => set({ tag: event.target.value })} /></label></>}
      {current.kind === 'has-item' && <><ScopeField value={current.owner} world={world} onChange={(owner) => set({ owner })} /><label>Item <select value={current.itemId} onChange={(event) => set({ itemId: event.target.value })}><option value="">Choose item</option>{world.itemDefinitions.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item.name)}</option>)}</select></label><label>Minimum quantity <input type="number" min="1" value={current.quantity} onChange={(event) => set({ quantity: Number(event.target.value) })} /></label></>}
      {current.kind === 'has-seen-line' && <><label>Conversation <select value={current.conversationId} onChange={(event) => set({ conversationId: event.target.value, lineId: '' })}><option value="">Choose conversation</option>{world.conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.id}</option>)}</select></label><label>Line <select value={current.lineId} onChange={(event) => set({ lineId: event.target.value })}><option value="">Choose line</option>{world.conversations.find((conversation) => conversation.id === current.conversationId)?.lines.map((line) => <option key={line.id} value={line.id}>{line.id}</option>)}</select></label></>}
      {current.kind === 'has-selected-dialogue-option' && <><label>Conversation ID <input value={current.conversationId} onChange={(event) => set({ conversationId: event.target.value })} /></label><label>Option ID <input value={current.optionId} onChange={(event) => set({ optionId: event.target.value })} /></label></>}
      {(current.kind === 'all' || current.kind === 'any') && <div><p>{current.kind === 'all' ? 'Every requirement must match.' : 'At least one requirement must match.'}</p>{current.conditions.map((condition, index) => <ConditionField key={index} value={condition} world={world} onChange={(next) => set({ conditions: current.conditions.map((old, i) => i === index ? (next ?? emptyCondition()) : old) })} />)}<button type="button" onClick={() => set({ conditions: [...current.conditions, emptyCondition()] })}>Add requirement</button></div>}
      {current.kind === 'not' && <ConditionField value={current.condition} world={world} onChange={(condition) => { if (condition) set({ condition }); }} />}
    </>}
  </fieldset>;
}

const emptyEffect = (): Effect => ({ kind: 'set-state', target: { scope: { kind: 'world' }, key: '' }, value: false });
function EffectList({ effects, onChange, world }: { effects: readonly Effect[]; onChange: (next: readonly Effect[]) => void; world: WorldDocument }) {
  const update = (index: number, effect: Effect) => onChange(effects.map((current, currentIndex) => currentIndex === index ? effect : current));
  return <fieldset className="apprentice-effects" style={fieldStyle}><legend>Effects</legend><HelpTip label="Effects">Effects change state, inventory, or another part of the game after an action runs. They execute from top to bottom.</HelpTip>
    {effects.length === 0 && <p className="apprentice-empty">No effects. This action can still navigate to another scene.</p>}
    <CollectionBrowser name="Effects" items={effects} title={(effect, index) => `${index + 1}. ${effect.kind.replaceAll('-', ' ')}`}
      addLabel="Add effect" onAdd={() => onChange([...effects, emptyEffect()])}
      onDeleteSelected={indices => onChange(effects.filter((_effect, index) => !indices.includes(index)))}
      renderEditor={(effect, index) => <fieldset className="apprentice-effect" style={fieldStyle}><legend>Effect {index + 1}</legend>
      <label>Operation <select value={effect.kind} onChange={(event) => {
        const kinds: Record<string, Effect> = {
          'set-state': emptyEffect(), 'increment-state': { kind: 'increment-state', target: { scope: { kind: 'world' }, key: '' }, amount: 1 },
          'navigate': { kind: 'navigate', edgeId: '' }, 'emit-event': { kind: 'emit-event', eventId: '', payload: {} },
          'add-item': { kind: 'add-item', owner: { kind: 'world' }, itemId: '', quantity: 1 }, 'remove-item': { kind: 'remove-item', stackId: '', quantity: 1 },
          'transfer-item': { kind: 'transfer-item', stackId: '', quantity: 1, destination: { owner: { kind: 'world' } } },
          'equip-item': { kind: 'equip-item', stackId: '', slotId: '' }, 'unequip-item': { kind: 'unequip-item', stackId: '', slotId: '' },
          'use-item': { kind: 'use-item', stackId: '' }, 'add-tag': { kind: 'add-tag', entityId: '', tag: '' }, 'remove-tag': { kind: 'remove-tag', entityId: '', tag: '' },
          'start-conversation': { kind: 'start-conversation', conversationId: '' }, 'interrupt-conversation': { kind: 'interrupt-conversation', conversationId: '' }, 'resume-conversation': { kind: 'resume-conversation', conversationId: '' },
          'run-script': { kind: 'run-script', scriptId: '' }, 'show-scene-text': { kind: 'show-scene-text', text: { kind: 'literal', text: '' } }, 'append-scene-text': { kind: 'append-scene-text', text: { kind: 'literal', text: '' } }, 'reset-scene-text': { kind: 'reset-scene-text' },
        };
        const next = kinds[event.target.value]; if (next) update(index, next);
      }}>
        <option value="show-scene-text">Replace this scene’s description</option><option value="append-scene-text">Append to this scene’s description</option><option value="reset-scene-text">Restore this scene’s original description</option><option value="set-state">Set a remembered value</option><option value="increment-state">Increment state</option><option value="navigate">Navigate</option><option value="emit-event">Emit event</option><option value="add-item">Add item</option><option value="remove-item">Remove item</option><option value="transfer-item">Transfer item</option><option value="use-item">Use item</option><option value="equip-item">Equip item</option><option value="unequip-item">Unequip item</option><option value="add-tag">Add actor tag</option><option value="remove-tag">Remove actor tag</option><option value="start-conversation">Start conversation</option><option value="interrupt-conversation">Interrupt conversation</option><option value="resume-conversation">Resume conversation</option><option value="run-script">Run script</option>
      </select></label>
      {(effect.kind === 'show-scene-text' || effect.kind === 'append-scene-text') && <TextSourceField multiline label="Response text" value={effect.text} onChange={text => update(index, { ...effect, text })} />}
      {(effect.kind === 'set-state' || effect.kind === 'increment-state') && <><StateReferenceFields value={effect.target} world={world} onChange={(target) => update(index, { ...effect, target })} />{effect.kind === 'set-state' ? <ScalarField label="Value" value={effect.value} valueType={stateValueType(world, effect.target)} onChange={(value) => update(index, { ...effect, value })} /> : <label>Amount <input type="number" value={effect.amount} onChange={(event) => update(index, { ...effect, amount: Number(event.target.value) })} /></label>}</>}
      {effect.kind === 'navigate' && <label>Travel along route <select value={effect.edgeId} onChange={(event) => update(index, { ...effect, edgeId: event.target.value })}><option value="">Choose route</option>{world.navigationEdges.map((edge) => <option key={edge.id} value={edge.id}>{routeLabel(world, edge)}</option>)}</select></label>}
      {effect.kind === 'emit-event' && <label>Event <select value={effect.eventId} onChange={(event) => { const definition = world.eventDefinitions.find((item) => item.id === event.target.value); update(index, { ...effect, eventId: event.target.value, payload: Object.fromEntries((definition?.payloadFields ?? []).map((field) => [field.key, field.defaultValue])) }); }}><option value="">Choose event</option>{world.eventDefinitions.map((event) => <option key={event.id} value={event.id}>{event.id}</option>)}</select></label>}
      {effect.kind === 'emit-event' && world.eventDefinitions.find((event) => event.id === effect.eventId)?.payloadFields.map((field) => <ScalarField key={field.key} label={`Payload: ${field.key}`} value={(effect.payload[field.key] as Scalar | undefined) ?? field.defaultValue} valueType={field.valueType} onChange={(value) => update(index, { ...effect, payload: { ...effect.payload, [field.key]: value } })} />)}
      {effect.kind === 'add-item' && <><ScopeField value={effect.owner} world={world} onChange={(owner) => update(index, { ...effect, owner })} /><label>Item <select value={effect.itemId} onChange={(event) => update(index, { ...effect, itemId: event.target.value })}><option value="">Choose item</option>{world.itemDefinitions.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item.name)}</option>)}</select></label><label>Quantity <input type="number" min="1" value={effect.quantity} onChange={(event) => update(index, { ...effect, quantity: Number(event.target.value) })} /></label></>}
      {effect.kind === 'remove-item' && <><label>Stack ID <input value={effect.stackId} onChange={(event) => update(index, { ...effect, stackId: event.target.value })} /></label><label>Quantity <input type="number" min="1" value={effect.quantity} onChange={(event) => update(index, { ...effect, quantity: Number(event.target.value) })} /></label></>}
      {effect.kind === 'transfer-item' && <><label>Stack ID <input value={effect.stackId} onChange={(event) => update(index, { ...effect, stackId: event.target.value })} /></label><label>Quantity <input type="number" min="1" value={effect.quantity} onChange={(event) => update(index, { ...effect, quantity: Number(event.target.value) })} /></label><ScopeField value={effect.destination.owner} world={world} onChange={(owner) => update(index, { ...effect, destination: { ...effect.destination, owner } })} /><label>Move into inventory stack (optional) <input value={effect.destination.containerStackId ?? ''} onChange={(event) => { const destination = { ...effect.destination }; if (event.target.value) destination.containerStackId = event.target.value; else delete (destination as { containerStackId?: string }).containerStackId; update(index, { ...effect, destination }); }} /></label></>}
      {effect.kind === 'use-item' && <label>Stack ID <input value={effect.stackId} onChange={(event) => update(index, { ...effect, stackId: event.target.value })} /></label>}
      {(effect.kind === 'equip-item' || effect.kind === 'unequip-item') && <><label>Stack ID <input value={effect.stackId} onChange={(event) => update(index, { ...effect, stackId: event.target.value })} /></label><label>Equipment slot <input value={effect.slotId} onChange={(event) => update(index, { ...effect, slotId: event.target.value })} /></label></>}
      {(effect.kind === 'add-tag' || effect.kind === 'remove-tag') && <><label>Actor <select value={effect.entityId} onChange={(event) => update(index, { ...effect, entityId: event.target.value })}><option value="">Choose actor</option>{world.entities.map((entity) => <option key={entity.id} value={entity.id}>{sourceLabel(entity.name)}</option>)}</select></label><label>Tag <input value={effect.tag} onChange={(event) => update(index, { ...effect, tag: event.target.value })} /></label></>}
      {(effect.kind === 'start-conversation' || effect.kind === 'interrupt-conversation' || effect.kind === 'resume-conversation') && <label>Conversation <select value={effect.conversationId} onChange={(event) => update(index, { ...effect, conversationId: event.target.value })}><option value="">Choose conversation</option>{world.conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.id}</option>)}</select></label>}
      {effect.kind === 'run-script' && <label>Script <select value={effect.scriptId} onChange={(event) => update(index, { ...effect, scriptId: event.target.value })}><option value="">Choose script</option>{world.scripts.map((script) => <option key={script.id} value={script.id}>{script.id}</option>)}</select></label>}
      <div className="apprentice-order-controls"><button type="button" disabled={index === 0} onClick={() => { const next = [...effects]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; onChange(next); }}>Move earlier</button><button type="button" disabled={index === effects.length - 1} onClick={() => { const next = [...effects]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; onChange(next); }}>Move later</button></div>
      <button type="button" className="apprentice-remove" onClick={() => onChange(effects.filter((_item, currentIndex) => currentIndex !== index))}>Remove effect</button>
    </fieldset>} />
  </fieldset>;
}

function CommandPhrasesField({ command, onChange }: { command: CommandDefinition; onChange: (command: CommandDefinition) => void }) {
  const [draft, setDraft] = useState(() => formatPatternInput(command.patterns));
  const published = useRef(JSON.stringify(command.patterns));
  useEffect(() => { const value = JSON.stringify(command.patterns); if (value !== published.current) { setDraft(formatPatternInput(command.patterns)); published.current = value; } }, [command.patterns]);
  return <fieldset><legend>Words the player can type</legend><HelpTip label="Command phrases">Enter complete phrases, including spaces. Separate alternatives with a comma or |. Escape a literal comma or bar with a backslash. The first phrase appears as the command hint.</HelpTip>
    <label>Command phrases<input value={draft} placeholder="say help | ask for help" onChange={event => { const value = event.target.value; const patterns = parsePatternInput(value); setDraft(value); published.current = JSON.stringify(patterns); onChange({ ...command, patterns }); }} /></label>
    <p>Spaces are allowed. Separate alternatives with a comma or |. Use \, or \| for a literal separator.</p>
  </fieldset>;
}

function CommandInputsEditor({ command, onChange }: { command: CommandDefinition; onChange: (command: CommandDefinition) => void }) {
  return <fieldset><legend>Values captured from player input (optional)</legend><HelpTip label="Command input values">Use a placeholder such as take &#123;item&#125; in a command phrase, then add an input named item here. It captures one word from what the player types. Plain commands such as say help need no input values. Values are passed to action scripts.</HelpTip>
    <p>For example, “take {'{item}'}” captures one word named “item”. Leave this empty for fixed phrases.</p>
    {command.parameters.map((parameter, index) => <div key={index} className="apprentice-command-input">
      <label>Placeholder name<input value={parameter.id} onChange={event => onChange({ ...command, parameters: command.parameters.map((item, position) => position === index ? { ...item, id: event.target.value } : item) })} /></label>
      <label>Expected value<select value={typeof parameter.valueType === 'string' ? parameter.valueType : 'enum'} onChange={event => onChange({ ...command, parameters: command.parameters.map((item, position) => position === index ? { ...item, valueType: event.target.value === 'enum' ? { kind: 'enum', values: [] } : event.target.value as 'string' | 'number' | 'integer' | 'boolean' } : item) })}><option value="string">Text word</option><option value="integer">Whole number</option><option value="number">Number</option><option value="boolean">True or false</option><option value="enum">One of a list</option></select></label>
      {typeof parameter.valueType !== 'string' && <label>Allowed words<input value={parameter.valueType.values.join(', ')} onChange={event => onChange({ ...command, parameters: command.parameters.map((item, position) => position === index ? { ...item, valueType: { kind: 'enum', values: parsePatternInput(event.target.value) } } : item) })} /></label>}
      <button type="button" onClick={() => onChange({ ...command, parameters: command.parameters.filter((_item, position) => position !== index) })}>Remove input value</button>
    </div>)}
    <button type="button" onClick={() => onChange({ ...command, parameters: [...command.parameters, { id: `input${command.parameters.length + 1}`, valueType: 'string' }] })}>Add input value</button>
  </fieldset>;
}

function otherActionEffects(effects: readonly Effect[]): readonly Effect[] { return effects.filter(effect => effect.kind !== 'show-scene-text' && effect.kind !== 'append-scene-text' && effect.kind !== 'reset-scene-text'); }
function replaceOtherActionEffects(previous: readonly Effect[], next: readonly Effect[]): readonly Effect[] {
  const remaining = [...next];
  const effects = previous.flatMap(effect => effect.kind === 'show-scene-text' || effect.kind === 'append-scene-text' || effect.kind === 'reset-scene-text' ? [effect] : remaining.length ? [remaining.shift()!] : []);
  return [...effects, ...remaining];
}

function SceneResponseEditor({ effects, onChange }: { effects: readonly Effect[]; onChange: (effects: readonly Effect[]) => void }) {
  const response = effects.find(effect => effect.kind === 'show-scene-text' || effect.kind === 'append-scene-text' || effect.kind === 'reset-scene-text');
  const otherEffects = effects.filter(effect => effect.kind !== 'show-scene-text' && effect.kind !== 'append-scene-text' && effect.kind !== 'reset-scene-text');
  return <fieldset className="apprentice-scene-response"><legend>Scene text after this action</legend><HelpTip label="Scene text after this action">Replace the description, or append a new passage below the text already displayed. Appending keeps earlier passages so the scene reads like a terminal transcript, without a return action. Restore clears the accumulated text and shows the authored description. Leaving the scene clears its transcript; saving retains it. Conditions can choose different responses.</HelpTip>
    <label>Text response<select aria-label="Scene text response" value={response?.kind ?? ''} onChange={event => onChange(event.target.value === 'show-scene-text' || event.target.value === 'append-scene-text' ? [...otherEffects, { kind: event.target.value as 'show-scene-text' | 'append-scene-text', text: response && 'text' in response ? response.text : { kind: 'literal', text: '' } }] : event.target.value === 'reset-scene-text' ? [...otherEffects, { kind: 'reset-scene-text' }] : otherEffects)}><option value="">Keep the current description</option><option value="show-scene-text">Replace the description</option><option value="append-scene-text">Append to the description</option><option value="reset-scene-text">Restore the original description</option></select></label>
    {(response?.kind === 'show-scene-text' || response?.kind === 'append-scene-text') && <><TextSourceField multiline label="Response text" value={response.text} onChange={text => onChange(effects.map(effect => effect === response ? { ...response, text } : effect))} /><p>Markdown is supported. Append adds a separate passage after the current text. Leave Destination set to “Stay in this scene” to keep it displayed.</p></>}
  </fieldset>;
}

function ActionOutcomesEditor({ outcomes = [], onChange, world, ownerNodeId, chooseDestination, actionFocus, localeStrings }: {
  localeStrings: Readonly<Record<string, string>>; outcomes?: readonly ActionOutcome[] | undefined; onChange: (outcomes: readonly ActionOutcome[]) => void; world: WorldDocument;
  ownerNodeId?: string | undefined; chooseDestination: (outcomeId: string, nodeId: string) => void; actionFocus?: ApprenticeFormsProps['actionFocus'];
}) {
  const [focusedOutcomeId, setFocusedOutcomeId] = useState<string | undefined>();
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => { setFocusedOutcomeId(actionFocus?.outcomeId); setFocusRequest(value => value + 1); }, [actionFocus?.request, actionFocus?.outcomeId]);
  const update = (index: number, outcome: ActionOutcome) => onChange(outcomes.map((current, position) => position === index ? outcome : current));
  const move = (index: number, offset: number) => { const next = [...outcomes]; const [outcome] = next.splice(index, 1); next.splice(index + offset, 0, outcome!); setFocusedOutcomeId(outcome!.id); setFocusRequest(value => value + 1); onChange(next); };
  return <fieldset className="apprentice-outcomes"><legend>Conditional outcomes</legend>
    <HelpTip label="Conditional outcomes">Keep one player action and vary what happens. The first matching outcome supplies all its effects and its destination. If none match, Otherwise runs. Each condition reads the game state before this action starts changing it.</HelpTip>
    <p>Check these outcomes from top to bottom. Run the first match; otherwise use the result below. Each outcome has its own response, effects, and destination.</p>
    <CollectionBrowser name="Conditional outcomes" items={outcomes} title={outcome => outcome.name} summary={(_outcome, index) => `Checked ${index + 1}${index === 0 ? ' (first)' : ''}`}
      requestedIndex={focusedOutcomeId ? outcomes.findIndex(outcome => outcome.id === focusedOutcomeId) : undefined} requestKey={focusRequest}
      addLabel="Add conditional outcome" {...(outcomes.length < 64 ? { onAdd: () => onChange([...outcomes, { id: uid(), name: `Outcome ${outcomes.length + 1}`, condition: { kind: 'at-node' as const, nodeId: ownerNodeId ?? world.entryNodeId }, effects: [] }]) } : {})}
      onDeleteSelected={indices => onChange(outcomes.filter((_outcome, index) => !indices.includes(index)))}
      renderEditor={(outcome, index) => <fieldset className="apprentice-outcome" key={outcome.id}><legend>{outcome.name}</legend>
        <label>Outcome name<input maxLength={128} value={outcome.name} onChange={event => update(index, { ...outcome, name: event.target.value })} /></label>
        <ConditionField label="When this outcome applies" required value={outcome.condition} world={world} onChange={condition => { if (condition) update(index, { ...outcome, condition }); }} />
        {ownerNodeId ? <label>Outcome destination<select aria-label="Outcome destination" value={world.navigationEdges.find(edge => edge.id === outcome.navigationEdgeId)?.toNodeId ?? ''} onChange={event => chooseDestination(outcome.id, event.target.value)}><option value="">Stay in this scene</option>{world.nodes.filter(node => node.visitable && node.id !== ownerNodeId).map(node => <option key={node.id} value={node.id}>{sceneLabel(world, node.id, localeStrings)}</option>)}</select></label>
          : <label>Outcome route<select value={outcome.navigationEdgeId ?? ''} onChange={event => { const next = { ...outcome }; if (event.target.value) next.navigationEdgeId = event.target.value; else delete (next as { navigationEdgeId?: string }).navigationEdgeId; update(index, next); }}><option value="">No route</option>{world.navigationEdges.map(edge => <option key={edge.id} value={edge.id}>{routeLabel(world, edge, localeStrings)}</option>)}</select></label>}
        <SceneResponseEditor effects={outcome.effects} onChange={effects => update(index, { ...outcome, effects })} />
        <EffectList effects={otherActionEffects(outcome.effects)} world={world} onChange={effects => update(index, { ...outcome, effects: replaceOtherActionEffects(outcome.effects, effects) })} />
        <div className="apprentice-outcome-order"><button type="button" disabled={index === 0} onClick={() => move(index, -1)}>Check earlier</button><button type="button" disabled={index === outcomes.length - 1} onClick={() => move(index, 1)}>Check later</button><button type="button" onClick={() => onChange(outcomes.filter((_item, position) => position !== index))}>Remove outcome</button></div>
      </fieldset>} />
  </fieldset>;
}

function ActionEditors({ actions, onChange, world, ownerNodeId, onWorldChange, localeStrings = {}, onLocaleTextChange, actionFocus }: { actionFocus?: ApprenticeFormsProps['actionFocus']; actions: ActionSet; onChange: (actions: ActionSet) => void; world: WorldDocument; ownerNodeId?: string; onWorldChange?: (world: WorldDocument) => void; localeStrings?: Readonly<Record<string, string>>; onLocaleTextChange?: ((key: string, text: string) => void) | undefined }) {
  const updateChoice = (index: number, choice: ChoiceDefinition) => onChange({ ...actions, choices: actions.choices.map((item, i) => i === index ? choice : item) });
  const updateCommand = (index: number, command: CommandDefinition) => onChange({ ...actions, commands: actions.commands.map((item, i) => i === index ? command : item) });
  const actionSection = useRef<HTMLElement>(null);
  useEffect(() => { if (actionFocus) actionSection.current?.querySelector<HTMLElement>(`[data-action-kind="${actionFocus.kind}"]`)?.scrollIntoView({ block: 'nearest' }); }, [actionFocus]);
  const [routeError, setRouteError] = useState('');
  const chooseDestination = (kind: 'choice' | 'command', actionId: string, toNodeId: string, outcomeId?: string) => {
    if (!ownerNodeId || !onWorldChange) return;
    const result = applyGraphCommand(world, { kind: 'set-action-destination', sourceNodeId: ownerNodeId, actionKind: kind, actionId, ...(outcomeId ? { outcomeId } : {}), toNodeId: toNodeId || null, newEdgeId: `link-${crypto.randomUUID().replaceAll('-', '')}` });
    if (result.ok) { setRouteError(''); onWorldChange(result.world); }
    else setRouteError(result.message);
  };
  const publishOutcomes = (kind: 'choice' | 'command', action: ChoiceDefinition | CommandDefinition, outcomes: readonly ActionOutcome[]) => {
    const key = kind === 'choice' ? 'choices' : 'commands';
    const next = { ...action, outcomes };
    const nextActions = { ...actions, [key]: actions[key].map(item => item.id === action.id ? next : item) } as ActionSet;
    const removedRoutes = new Set((action.outcomes ?? []).filter(outcome => !outcomes.some(item => item.id === outcome.id)).flatMap(outcome => outcome.navigationEdgeId ? [outcome.navigationEdgeId] : []));
    if (removedRoutes.size && onWorldChange) {
      const changed = ownerNodeId ? updateNodeDefinition(world, ownerNodeId, node => ({ ...node, actions: { ...node.actions, [key]: nextActions[key] } }))! : { ...world, actionDefaults: nextActions };
      onWorldChange({ ...changed, navigationEdges: changed.navigationEdges.filter(edge => !removedRoutes.has(edge.id) || referencesNavigationEdge({ ...changed, navigationEdges: [] }, new Set([edge.id]))) });
    } else onChange(nextActions);
  };
  const destinationFor = (edgeId?: string) => world.navigationEdges.find(edge => edge.id === edgeId && (!ownerNodeId || edge.fromNodeId === ownerNodeId))?.toNodeId ?? '';
  const actionSummary = (id: string, edgeId?: string, outcomes?: readonly ActionOutcome[]) => {
    if (outcomes?.length) return `${outcomes.length} conditional outcome${outcomes.length === 1 ? '' : 's'} · Otherwise ${edgeId ? 'has a destination' : 'stays in this scene'}`;
    if (!edgeId) return 'No direct destination';
    const edge = world.navigationEdges.find(item => item.id === edgeId);
    if (!edge) return 'Missing destination';
    if (ownerNodeId && edge.fromNodeId !== ownerNodeId) return 'Route belongs to another scene';
    return `→ ${sceneLabel(world, edge.toNodeId, localeStrings)}`;
  };
  const destinationChoices = ownerNodeId ? world.nodes.filter(node => node.visitable && node.id !== ownerNodeId) : [];
  return <section ref={actionSection} className="apprentice-actions"><div className="apprentice-section-title"><h3>Player actions</h3><HelpTip label="Player actions">Choices are buttons players can select. Commands are words players type. Select a destination to create or reuse a map route. Conditions and effects can add requirements and consequences.</HelpTip></div>
    {routeError && <p role="alert">{routeError}</p>}
    {actions.choices.length === 0 && actions.commands.length === 0 && <p className="apprentice-empty">No actions yet. Add a choice to give the player something to do.</p>}
    <CollectionBrowser name="Choices" requestedIndex={actionFocus?.kind === 'choice' ? actions.choices.findIndex(action => action.id === actionFocus.id) : undefined} requestKey={actionFocus?.request} items={actions.choices} title={choice => choice.label.kind === 'literal' ? choice.label.text || 'Unnamed choice' : localeStrings[choice.label.key] ?? choice.label.key} summary={choice => actionSummary(choice.id, choice.navigationEdgeId, choice.outcomes)}
      addLabel="Add choice" onAdd={() => onChange({ ...actions, choices: [...actions.choices, { id: uid(), label: { kind: 'literal', text: 'New choice' }, effects: [] }] })}
      onDeleteSelected={indices => onChange({ ...actions, choices: actions.choices.filter((_choice, index) => !indices.includes(index)) })}
      renderEditor={(choice, index) => <fieldset key={choice.id} data-action-kind="choice" className="apprentice-choice" style={fieldStyle}><legend><span className="apprentice-kind">Choice {index + 1}</span> <span className="apprentice-id">{choice.id}</span></legend>
      <TextSourceField label="Choice label" value={choice.label} onChange={(label) => updateChoice(index, { ...choice, label })} />
      {choice.label.kind === 'locale-key' && onLocaleTextChange && (() => { const key = choice.label.key; return <label>Choice text (default language)<textarea rows={3} value={localeStrings[key] ?? ''} onChange={event => onLocaleTextChange(key, event.target.value)} /></label>; })()}
      <ConditionField value={choice.condition} world={world} onChange={(condition) => { const next = { ...choice }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; updateChoice(index, next); }} />
      <label>When condition is false <select value={choice.falsePolicy ?? 'hide'} onChange={(event) => updateChoice(index, { ...choice, falsePolicy: event.target.value as 'hide' | 'disable' })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
      <ActionOutcomesEditor outcomes={choice.outcomes} localeStrings={localeStrings} world={world} ownerNodeId={ownerNodeId} actionFocus={actionFocus} onChange={outcomes => publishOutcomes('choice', choice, outcomes)} chooseDestination={(outcomeId, toNodeId) => chooseDestination('choice', choice.id, toNodeId, outcomeId)} />
      <fieldset className="apprentice-fallback"><legend>{choice.outcomes?.length ? 'Otherwise' : 'Result'}</legend>
      {choice.outcomes?.length ? <p>This result runs only when no conditional outcome matches.</p> : null}
      {ownerNodeId ? <label>Destination <select aria-label="Choice destination" value={destinationFor(choice.navigationEdgeId)} onChange={event => chooseDestination('choice', choice.id, event.target.value)}><option value="">Stay in this scene</option>{destinationChoices.map(node => <option key={node.id} value={node.id}>{sceneLabel(world, node.id, localeStrings)}</option>)}</select></label>
        : <label>Route <select value={choice.navigationEdgeId ?? ''} onChange={(event) => { const next = { ...choice }; if (event.target.value) next.navigationEdgeId = event.target.value; else delete (next as { navigationEdgeId?: string }).navigationEdgeId; updateChoice(index, next); }}><option value="">No route</option>{world.navigationEdges.map(edge => <option key={edge.id} value={edge.id}>{routeLabel(world, edge, localeStrings)}</option>)}</select></label>}
      <SceneResponseEditor effects={choice.effects} onChange={effects => updateChoice(index, { ...choice, effects })} />
      <EffectList effects={otherActionEffects(choice.effects)} world={world} onChange={(effects) => updateChoice(index, { ...choice, effects: replaceOtherActionEffects(choice.effects, effects) })} />
      </fieldset>
      <button type="button" className="apprentice-remove" onClick={() => onChange({ ...actions, choices: actions.choices.filter((_item, i) => i !== index) })}>Remove choice</button>
    </fieldset>} />
    <CollectionBrowser name="Commands" requestedIndex={actionFocus?.kind === 'command' ? actions.commands.findIndex(action => action.id === actionFocus.id) : undefined} requestKey={actionFocus?.request} items={actions.commands} title={command => command.patterns[0] || command.id} summary={command => actionSummary(command.id, command.navigationEdgeId, command.outcomes)}
      addLabel="Add command" onAdd={() => onChange({ ...actions, commands: [...actions.commands, { id: uid(), patterns: ['new command'], parameters: [], effects: [] }] })}
      onDeleteSelected={indices => onChange({ ...actions, commands: actions.commands.filter((_command, index) => !indices.includes(index)) })}
      renderEditor={(command, index) => <fieldset data-action-kind="command" className="apprentice-command" style={fieldStyle}><legend><span className="apprentice-kind">Command {index + 1}</span> <span className="apprentice-id">{command.id}</span></legend>
      <label>Command ID <input value={command.id} onChange={(event) => updateCommand(index, { ...command, id: event.target.value })} /></label>
      <CommandPhrasesField key={command.id} command={command} onChange={next => updateCommand(index, next)} />
      <CommandInputsEditor command={command} onChange={next => updateCommand(index, next)} />
      <ConditionField value={command.condition} world={world} onChange={(condition) => { const next = { ...command }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; updateCommand(index, next); }} />
      <label>When condition is false <select value={command.falsePolicy ?? 'hide'} onChange={(event) => updateCommand(index, { ...command, falsePolicy: event.target.value as 'hide' | 'disable' })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
      <ActionOutcomesEditor outcomes={command.outcomes} localeStrings={localeStrings} world={world} ownerNodeId={ownerNodeId} actionFocus={actionFocus} onChange={outcomes => publishOutcomes('command', command, outcomes)} chooseDestination={(outcomeId, toNodeId) => chooseDestination('command', command.id, toNodeId, outcomeId)} />
      <fieldset className="apprentice-fallback"><legend>{command.outcomes?.length ? 'Otherwise' : 'Result'}</legend>
      {command.outcomes?.length ? <p>This result runs only when no conditional outcome matches.</p> : null}
      {ownerNodeId ? <label>Destination <select aria-label="Command destination" value={destinationFor(command.navigationEdgeId)} onChange={event => chooseDestination('command', command.id, event.target.value)}><option value="">Stay in this scene</option>{destinationChoices.map(node => <option key={node.id} value={node.id}>{sceneLabel(world, node.id, localeStrings)}</option>)}</select></label>
        : <label>Route <select value={command.navigationEdgeId ?? ''} onChange={(event) => { const next = { ...command }; if (event.target.value) next.navigationEdgeId = event.target.value; else delete (next as { navigationEdgeId?: string }).navigationEdgeId; updateCommand(index, next); }}><option value="">No route</option>{world.navigationEdges.map(edge => <option key={edge.id} value={edge.id}>{routeLabel(world, edge, localeStrings)}</option>)}</select></label>}
      <SceneResponseEditor effects={command.effects} onChange={effects => updateCommand(index, { ...command, effects })} />
      <EffectList key={command.id} effects={otherActionEffects(command.effects)} world={world} onChange={(effects) => updateCommand(index, { ...command, effects: replaceOtherActionEffects(command.effects, effects) })} />
      </fieldset>
      <button type="button" className="apprentice-remove" onClick={() => onChange({ ...actions, commands: actions.commands.filter((_item, i) => i !== index) })}>Remove command</button>
    </fieldset>} />
  </section>;
}

function NodeEditor({ world, node, onChange, onWorldChange, contentSettings, actionFocus, section = 'all' }: { actionFocus?: ApprenticeFormsProps['actionFocus']; world: WorldDocument; node: NodeDefinition; onChange: (node: NodeDefinition) => void; onWorldChange: (world: WorldDocument) => void; contentSettings: ContentSettings; section?: 'all' | 'scene' | 'actions' | 'logic' }) {
  const defaultTitleLocale = contentSettings.locales?.find(locale => locale.locale === contentSettings.defaultLocale);
  const titleKey = node.title.kind === 'locale-key' ? node.title.key : undefined;
  const inheritedActions = node.inheritance?.defaults && node.parentId !== null
    ? resolveNodeActions(world, node.parentId).value ?? world.actionDefaults
    : world.actionDefaults;
  const inheritedRules = node.inheritance?.rules && node.parentId !== null
    ? resolveNodeRules(world, node.parentId).value ?? []
    : [];
  const localRules = (node.ruleIds ?? []).map((id) => world.rules.find((rule) => rule.id === id)).filter((rule): rule is RuleDefinition => rule !== undefined);
  const localChoices = node.actions?.choices ?? inheritedActions.choices;
  const localCommands = node.actions?.commands ?? inheritedActions.commands;
  const authoredFields = <>
    {section === 'actions' && <p>{node.actions?.choices === undefined || node.actions?.commands === undefined ? 'Inherited categories are shown here. Editing one creates a local copy of that category; other scenes keep their inherited actions.' : 'Actions belong to this scene. A destination is optional; effects can run without travel.'}</p>}
    {section !== 'actions' && section !== 'logic' && <RichContentEditor value={node.content} onChange={(content) => onChange({ ...node, content })} world={world} {...contentSettings} />}
    {(section === 'all' || section === 'actions') && <ActionEditors actionFocus={actionFocus} actions={{ choices: localChoices, commands: localCommands }} world={world} {...(node.visitable ? { ownerNodeId: node.id } : {})} onWorldChange={onWorldChange} onLocaleTextChange={contentSettings.onLocalesChange ? (key, text) => contentSettings.onLocalesChange?.((contentSettings.locales ?? []).map(locale => locale.locale === contentSettings.defaultLocale ? { ...locale, strings: { ...locale.strings, [key]: text } } : locale)) : undefined} localeStrings={contentSettings.locales?.find(locale => locale.locale === contentSettings.defaultLocale)?.strings ?? {}} onChange={(actions) => {
      const nextActions = { ...node.actions };
      if (actions.choices !== localChoices) nextActions.choices = actions.choices;
      if (actions.commands !== localCommands) nextActions.commands = actions.commands;
      onChange({ ...node, actions: nextActions });
    }} />}
  </>;
  return <section className="apprentice-scene-editor"><div className="apprentice-section-title"><h2>{node.visitable ? 'Scene content' : 'Logic folder details'}</h2><HelpTip label={node.visitable ? 'Scene content' : 'Logic folder details'}>{node.visitable ? 'The title and content are what the player sees on entering this scene. Select a box on the map to edit a different scene.' : 'Logic folders organize scenes and other logic folders. A logic folder is not a playable location. Draw from its lower dot to another box’s upper dot to put that box inside it; nest logic folders the same way. Player routes connect scenes only.'}</HelpTip></div>
    {!node.visitable && <div className="apprentice-folder-note"><p>Organize a chapter here. Connect this folder’s lower dot to a scene or another folder’s upper dot. Players follow scene routes, not folder links.</p><p>{(() => { const children = world.nodes.filter(child => child.parentId === node.id); return `Inside this folder (${children.length}): ${children.slice(0, 8).map(child => sourceLabel(child.title)).join(', ') || 'nothing yet'}${children.length > 8 ? ', …' : ''}.`; })()} A folder may be nested in another folder.</p></div>}
    {(section === 'scene' || section === 'all') && <><TextSourceField label="Title" value={node.title} onChange={(title) => onChange({ ...node, title })} />
    {titleKey !== undefined && defaultTitleLocale && contentSettings.onLocalesChange && <label>Title text ({defaultTitleLocale.locale})
      <input value={defaultTitleLocale.strings[titleKey] ?? ''} onChange={event => contentSettings.onLocalesChange?.((contentSettings.locales ?? []).map(locale => locale.locale === defaultTitleLocale.locale
        ? { ...locale, strings: { ...locale.strings, [titleKey]: event.target.value } } : locale))} />
    </label>}
    </>}
    {node.visitable ? authoredFields : <details className="apprentice-advanced"><summary>Advanced folder content and action defaults</summary><div><p>Folder text is stored in the project but is not shown during play. Child scenes can inherit folder actions when their inheritance setting is enabled.</p>{authoredFields}</div></details>}
    {(section === 'logic' || section === 'all') && <details open={section === 'logic'} className="apprentice-advanced"><summary>{node.visitable ? 'Advanced scene settings' : 'Advanced folder settings'}</summary><div><p>Use inheritance, node state, and rules when the basic scene and action fields are not enough.</p>
    <label><input type="checkbox" checked={node.inheritance?.defaults ?? false} onChange={(event) => onChange({ ...node, inheritance: { defaults: event.target.checked, rules: node.inheritance?.rules ?? false } })} /> Inherit action defaults</label>
    <label><input type="checkbox" checked={node.inheritance?.rules ?? false} onChange={(event) => onChange({ ...node, inheritance: { defaults: node.inheritance?.defaults ?? false, rules: event.target.checked } })} /> Inherit rules</label>
    <fieldset style={fieldStyle}><legend>Remembered values for this scene</legend><HelpTip label="Scene state">These values are remembered separately for every scene. Their definitions live in World / State. Changing one here sets the starting value for this scene.</HelpTip><CollectionBrowser name="Node state fields" items={world.stateDefinitions.filter(field => field.scopeKind === 'node')} title={field => field.key} summary={field => `Current ${String(node.state?.[field.key] ?? field.defaultValue)} · default ${String(field.defaultValue)}`} renderEditor={field => <ScalarField label={`${field.key} (default ${String(field.defaultValue)})`} value={node.state?.[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={value => onChange({ ...node, state: { ...node.state, [field.key]: value } })} />} /></fieldset>
    <p>Inherited choices ({inheritedActions.choices.length}): {inheritedActions.choices.length ? inheritedActions.choices.slice(0, 5).map(choice => sourceLabel(choice.label)).join(', ') : 'none'}{inheritedActions.choices.length > 5 ? ', …' : ''}. {node.actions?.choices === undefined ? 'Using inherited choices.' : `Local choices replace them (${localChoices.length}).`}</p>
    <p>Inherited commands ({inheritedActions.commands.length}): {inheritedActions.commands.length ? inheritedActions.commands.slice(0, 5).map(command => command.patterns[0]).join(', ') : 'none'}{inheritedActions.commands.length > 5 ? ', …' : ''}. {node.actions?.commands === undefined ? 'Using inherited commands.' : `Local commands replace them (${localCommands.length}).`}</p>
    <fieldset style={fieldStyle}><legend>Rules in this scene</legend><HelpTip label="Rules in this scene">Rules run automatically at the chosen moment. Assign a rule here to make it available in this scene; inherited rules come from its logic folder.</HelpTip><p>{inheritedRules.length} inherited rules. {inheritedRules.slice(0, 5).map(rule => rule.id).join(', ')}{inheritedRules.length > 5 ? ', …' : ''}</p><CollectionBrowser name="Available rules" items={world.rules} title={rule => rule.id} summary={rule => `Priority ${rule.priority}${(node.ruleIds ?? []).includes(rule.id) ? ' · assigned' : ''}`} renderEditor={rule => <label><input type="checkbox" checked={(node.ruleIds ?? []).includes(rule.id)} onChange={(event) => onChange({ ...node, ruleIds: event.target.checked ? [...(node.ruleIds ?? []), rule.id] : (node.ruleIds ?? []).filter((id) => id !== rule.id) })} /> Use {rule.id} on this node</label>} /></fieldset>
    </div></details>}
  </section>;
}

function RuleEditor({ requested, world, onChange }: { requested?: ApprenticeFormsProps['requestedWorldSection']; world: WorldDocument; onChange: (rules: readonly RuleDefinition[]) => void }) {
  const remove = (indices: readonly number[]) => publishRemoval(world, { ...world, rules: world.rules.filter((_item, index) => !indices.includes(index)) }, next => onChange(next.rules));
  const update = (index: number, rule: RuleDefinition) => onChange(world.rules.map((item, i) => i === index ? rule : item));
  return <section><div className="apprentice-section-title"><h2>Rules</h2><HelpTip label="Rules">Rules react to game events or phases. Use them for behavior that should run beyond one scene action.</HelpTip></div>
    <CollectionBrowser requestedIndex={requested?.entityId ? world.rules.findIndex(item => item.id === requested.entityId) : undefined} requestKey={requested?.request} name="Rules" onDeleteSelected={remove} items={world.rules} title={rule => rule.id} summary={rule => `${rule.trigger.kind === 'event' ? rule.trigger.eventId : rule.trigger.phase} · priority ${rule.priority}`}
      addLabel="Add rule" onAdd={() => onChange([...world.rules, { id: uid(), trigger: { kind: 'phase', phase: 'action-start' }, priority: 0, effects: [] }])}
      renderEditor={(rule, index) => <fieldset style={fieldStyle}><legend>{rule.id}</legend>
      <label>Rule ID <input value={rule.id} onChange={(event) => update(index, { ...rule, id: event.target.value })} /></label>
      <HelpTip label="Rule timing">Choose when the rule checks its condition, such as entering a scene or receiving an event. Higher priority rules run first. A guarded rule runs only once per playthrough.</HelpTip><label>Trigger <select value={rule.trigger.kind === 'event' ? `event:${rule.trigger.eventId}` : `phase:${rule.trigger.phase}`} onChange={(event) => {
        const [kind, value] = event.target.value.split(':');
        update(index, { ...rule, trigger: kind === 'event' ? { kind: 'event', eventId: value ?? '' } : { kind: 'phase', phase: (value ?? 'action-start') as Extract<RuleDefinition['trigger'], { kind: 'phase' }>['phase'] } });
      }}><optgroup label="Events">{world.eventDefinitions.map((event) => <option key={event.id} value={`event:${event.id}`}>{event.id}</option>)}</optgroup><optgroup label="Phases">{['action-start','node-entry','node-revisit','node-exit','time-advanced'].map((phase) => <option key={phase} value={`phase:${phase}`}>{phase}</option>)}</optgroup></select></label>
      <label>Priority <input type="number" value={rule.priority} onChange={(event) => update(index, { ...rule, priority: Number(event.target.value) })} /></label>
      <ConditionField value={rule.condition} world={world} onChange={(condition) => { const next = { ...rule }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; update(index, next); }} />
      <EffectList key={rule.id} effects={rule.effects} world={world} onChange={(effects) => update(index, { ...rule, effects })} />
      <button type="button" onClick={() => remove([index])}>Remove rule</button>
    </fieldset>} />
    <p>Rules run by descending priority; equal priorities retain authored order. Inherited rules run parent before child.</p>
  </section>;
}

function ConversationEditor({ requested, world, onChange }: { requested?: ApprenticeFormsProps['requestedWorldSection']; world: WorldDocument; onChange: (conversations: readonly ConversationDefinition[]) => void }) {
  const remove = (next: readonly ConversationDefinition[]) => publishRemoval(world, { ...world, conversations: next }, updated => onChange(updated.conversations));
  const removeLines = (conversationIndex: number, indices: readonly number[]) => {
    const conversation = world.conversations[conversationIndex]!;
    const lines = conversation.lines.filter((_line, index) => !indices.includes(index));
    const entryLineId = lines.some(line => line.id === conversation.entryLineId) ? conversation.entryLineId : lines[0]?.id ?? '';
    remove(world.conversations.map((item, index) => index === conversationIndex ? { ...item, entryLineId, lines } : item));
  };
  const removeOptions = (conversationIndex: number, lineIndex: number, indices: readonly number[]) => remove(world.conversations.map((conversation, index) => index === conversationIndex ? { ...conversation, lines: conversation.lines.map((line, index) => index === lineIndex ? { ...line, options: (line.options ?? []).filter((_option, index) => !indices.includes(index)) } : line) } : conversation));
  const updateConversation = (index: number, value: ConversationDefinition) => onChange(world.conversations.map((conversation, i) => i === index ? value : conversation));
  return <section><div className="apprentice-section-title"><h2>Dialogue</h2><HelpTip label="Dialogue">Conversations contain spoken lines and responses. An action can start a conversation.</HelpTip></div>
    <CollectionBrowser requestedIndex={requested?.entityId ? world.conversations.findIndex(item => item.id === requested.entityId) : undefined} requestKey={requested?.request} name="Conversations" onDeleteSelected={indices => remove(world.conversations.filter((_item, index) => !indices.includes(index)))} items={world.conversations} title={conversation => conversation.id} summary={conversation => `${conversation.lines.length} lines`}
      addLabel="Add conversation" onAdd={() => { const lineId = uid(); onChange([...world.conversations, { id: uid(), participantEntityIds: [], entryLineId: lineId, interruptible: true, resumeOnReturn: true, lines: [{ id: lineId, speakerEntityId: '', text: { kind: 'literal', text: 'New dialogue line' } }] }]); }}
      renderEditor={(conversation, index) => <fieldset style={fieldStyle}><legend>Conversation: {conversation.id}</legend>
      <label>ID <input value={conversation.id} onChange={(event) => updateConversation(index, { ...conversation, id: event.target.value })} /></label>
      <label>First dialogue line <select value={conversation.entryLineId} onChange={(event) => updateConversation(index, { ...conversation, entryLineId: event.target.value })}>{conversation.lines.map((line) => <option key={line.id} value={line.id}>{line.id}</option>)}</select></label>
      <label><input type="checkbox" checked={conversation.interruptible} onChange={(event) => updateConversation(index, { ...conversation, interruptible: event.target.checked })} /> Can be interrupted</label>
      <label><input type="checkbox" checked={conversation.resumeOnReturn} onChange={(event) => updateConversation(index, { ...conversation, resumeOnReturn: event.target.checked })} /> Resume when returning to the node</label>
      <label>Actors in this conversation <select multiple value={[...conversation.participantEntityIds]} onChange={(event) => updateConversation(index, { ...conversation, participantEntityIds: [...event.target.selectedOptions].map((option) => option.value) })}>{world.entities.map((actor) => <option key={actor.id} value={actor.id}>{sourceLabel(actor.name)}</option>)}</select></label>
      <CollectionBrowser name="Lines" onDeleteSelected={indices => removeLines(index, indices)} items={conversation.lines} title={line => line.id} summary={line => sourceLabel(line.text)}
        addLabel="Add line" onAdd={() => { const line: DialogueLine = { id: uid(), speakerEntityId: conversation.participantEntityIds[0] ?? '', text: { kind: 'literal', text: 'New dialogue line' } }; updateConversation(index, { ...conversation, lines: [...conversation.lines, line] }); }}
        renderEditor={(line, lineIndex) => <fieldset style={fieldStyle}><legend>Line: {line.id}</legend>
        <label>Speaker <select value={line.speakerEntityId} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, speakerEntityId: event.target.value } : item) })}><option value="">Choose actor</option>{world.entities.map((actor) => <option key={actor.id} value={actor.id}>{sourceLabel(actor.name)}</option>)}</select></label>
        <TextSourceField label="Line text" value={line.text} onChange={(text) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, text } : item) })} />
        <label>Next line <select value={line.nextLineId ?? ''} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => { if (i !== lineIndex) return item; const next = { ...item }; if (event.target.value) next.nextLineId = event.target.value; else delete (next as { nextLineId?: string }).nextLineId; return next; }) })}><option value="">End conversation</option>{conversation.lines.filter((item) => item.id !== line.id).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
        <ConditionField value={line.condition} world={world} onChange={(condition) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => { if (i !== lineIndex) return item; const next = { ...item }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; return next; }) })} />
        <h4>Dialogue options</h4><HelpTip label="Dialogue options">These are responses the player can choose while a dialogue line is shown. Each response may have its own condition, effects, and next line.</HelpTip>
        <CollectionBrowser name="Options" onDeleteSelected={indices => removeOptions(index, lineIndex, indices)} items={line.options ?? []} title={option => sourceLabel(option.text) || option.id} summary={option => option.id}
          addLabel="Add option" onAdd={() => { const option: DialogueOption = { id: uid(), text: { kind: 'literal', text: 'New option' }, effects: [] }; updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: [...(item.options ?? []), option] } : item) }); }}
          renderEditor={(option, optionIndex) => <fieldset style={fieldStyle}><legend>Option: {option.id}</legend>
          <TextSourceField label="Option text" value={option.text} onChange={(text) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, text } : value) } : item) })} />
          <ConditionField value={option.condition} world={world} onChange={(condition) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => { if (j !== optionIndex) return value; const next = { ...value }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; return next; }) } : item) })} />
          <label>When unavailable <select value={option.falsePolicy ?? 'hide'} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, falsePolicy: event.target.value as 'hide' | 'disable' } : value) } : item) })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
          {option.falsePolicy === 'disable' && <TextSourceField label="Disabled reason" value={option.disabledReason ?? { kind: 'literal', text: '' }} onChange={(disabledReason) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, disabledReason } : value) } : item) })} />}
          <label>Next line <select value={option.nextLineId ?? ''} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => { if (j !== optionIndex) return value; const next = { ...value }; if (event.target.value) next.nextLineId = event.target.value; else delete (next as { nextLineId?: string }).nextLineId; return next; }) } : item) })}><option value="">Use line continuation</option>{conversation.lines.filter((item) => item.id !== line.id).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
          <EffectList key={option.id} effects={option.effects} world={world} onChange={(effects) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, effects } : value) } : item) })} />
          <button type="button" onClick={() => removeOptions(index, lineIndex, [optionIndex])}>Remove option</button>
        </fieldset>} />
        <button type="button" onClick={() => removeLines(index, [lineIndex])}>Remove line</button>
      </fieldset>} />
      <button type="button" onClick={() => remove(world.conversations.filter((_item, i) => i !== index))}>Remove conversation</button>
    </fieldset>} />
  </section>;
}

function EventActorEditors({ requested, world, onWorldChange }: { requested?: ApprenticeFormsProps['requestedWorldSection']; world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  return <section><div className="apprentice-section-title"><h2>Actors and events</h2><HelpTip label="Actors and events">Actors are people or objects with state. Events let actions and rules communicate.</HelpTip></div>
    <h3>Actor types</h3><HelpTip label="Actor types">An actor type declares which remembered values and tags its actors can have. Create an actor instance when you need a specific person or object in the story.</HelpTip><CollectionBrowser requestedIndex={requested?.entityId ? world.entityDefinitions.findIndex(item => item.id === requested.entityId) : undefined} requestKey={requested?.request} name="Actor types" onDeleteSelected={indices => publishRemoval(world, { ...world, entityDefinitions: world.entityDefinitions.filter((_item, index) => !indices.includes(index)) }, onWorldChange)} items={world.entityDefinitions} title={definition => sourceLabel(definition.name) || definition.id} summary={definition => definition.id}
      addLabel="Add actor type" onAdd={() => onWorldChange({ ...world, entityDefinitions: [...world.entityDefinitions, { id: uid(), name: { kind: 'literal', text: 'Actor type' }, fields: [], allowedTags: [] }] })}
      renderEditor={(definition, index) => <fieldset style={fieldStyle}><legend>{definition.id}</legend>
      <label>Actor type ID <input value={definition.id} onChange={(event) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label>
      <TextSourceField label="Actor type name" value={definition.name} onChange={(name) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, name } : item) })} />
      <StateFieldsEditor fields={definition.fields} onChange={(fields) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, fields } : item) })} />
      <label>Allowed tags <input style={inputStyle} value={definition.allowedTags.join(', ')} onChange={(event) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, allowedTags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) } : item) })} /></label>
    </fieldset>} />
    <h3>Actor instances</h3><HelpTip label="Actor instances">Each actor is a specific person or object. Choose its actor type, then set its starting values and tags.</HelpTip><CollectionBrowser requestedIndex={requested?.entityId ? world.entities.findIndex(item => item.id === requested.entityId) : undefined} requestKey={requested?.request} name="Actor instances" onDeleteSelected={indices => publishRemoval(world, { ...world, entities: world.entities.filter((_item, index) => !indices.includes(index)) }, onWorldChange)} items={world.entities} title={entity => sourceLabel(entity.name) || entity.id} summary={entity => entity.id}
      addLabel="Add actor" addDisabled={!world.entityDefinitions.length} onAdd={() => { const definition = world.entityDefinitions[0]; if (!definition) return; const actor: EntityInstance = { id: uid(), definitionId: definition.id, name: { kind: 'literal', text: 'New actor' }, tags: [], state: {} }; onWorldChange({ ...world, entities: [...world.entities, actor] }); }}
      renderEditor={(entity, index) => <fieldset style={fieldStyle}><legend>{sourceLabel(entity.name) || entity.id}</legend>
      <label>Actor ID <input value={entity.id} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label>
      <label>Type <select value={entity.definitionId} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, definitionId: event.target.value } : item) })}><option value="">Choose type</option>{world.entityDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{sourceLabel(definition.name)}</option>)}</select></label>
      <TextSourceField label="Actor name" value={entity.name} onChange={(name) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, name } : item) })} />
      <label>Tags <input value={entity.tags.join(', ')} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) } : item) })} /></label>
      <fieldset style={fieldStyle}><legend>Actor state</legend><HelpTip label="Actor state">These values belong to this particular actor. Its actor type supplies the available fields and their defaults.</HelpTip>{world.entityDefinitions.find((definition) => definition.id === entity.definitionId)?.fields.map((field) => <ScalarField key={field.key} label={`${field.key} (default ${String(field.defaultValue)})`} value={entity.state[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={(value) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, state: { ...item.state, [field.key]: value } } : item) })} />)}</fieldset>
    </fieldset>} />
    <h3>Events</h3><HelpTip label="Events">Events are named signals that actions send and rules respond to. Payload fields describe values sent with that signal. Empty events need no fields.</HelpTip><CollectionBrowser requestedIndex={requested?.entityId ? world.eventDefinitions.findIndex(item => item.id === requested.entityId) : undefined} requestKey={requested?.request} name="Events" onDeleteSelected={indices => publishRemoval(world, { ...world, eventDefinitions: world.eventDefinitions.filter((_item, index) => !indices.includes(index)) }, onWorldChange)} items={world.eventDefinitions} title={definition => definition.id} summary={definition => `${definition.payloadFields.length} payload fields`}
      addLabel="Add event" onAdd={() => onWorldChange({ ...world, eventDefinitions: [...world.eventDefinitions, { id: uid(), payloadFields: [] }] })}
      renderEditor={(definition, index) => <fieldset style={fieldStyle}><legend>{definition.id}</legend><label>Event ID <input value={definition.id} onChange={(event) => onWorldChange({ ...world, eventDefinitions: world.eventDefinitions.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label><StateFieldsEditor fields={definition.payloadFields} onChange={(payloadFields) => onWorldChange({ ...world, eventDefinitions: world.eventDefinitions.map((item, i) => i === index ? { ...item, payloadFields } : item) })} /></fieldset>} />
  </section>;
}

function InventoryEditor({ requested, world, onWorldChange }: { requested?: ApprenticeFormsProps['requestedWorldSection']; world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  return <section><div className="apprentice-section-title"><h2>Inventory</h2><HelpTip label="Inventory">Define items here, then use action effects to give, remove, or use them.</HelpTip></div>
    <CollectionBrowser requestedIndex={requested?.entityId ? world.itemDefinitions.findIndex(item => item.id === requested.entityId) : undefined} requestKey={requested?.request} name="Item definitions" onDeleteSelected={indices => publishRemoval(world, { ...world, itemDefinitions: world.itemDefinitions.filter((_item, index) => !indices.includes(index)) }, onWorldChange)} items={world.itemDefinitions} title={item => sourceLabel(item.name) || item.id} summary={item => item.id}
      addLabel="Add item definition" onAdd={() => onWorldChange({ ...world, itemDefinitions: [...world.itemDefinitions, { id: uid(), name: { kind: 'literal', text: 'New item' }, stackLimit: 1, canContain: false, fields: [] }] })}
      renderEditor={(item, index) => <fieldset style={fieldStyle}><legend>{sourceLabel(item.name) || item.id}</legend>
      <label>Item ID <input value={item.id} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, id: event.target.value } : value) })} /></label>
      <TextSourceField label="Item name" value={item.name} onChange={(name) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, name } : value) })} />
      <label>Maximum items in one stack <input type="number" min="1" value={item.stackLimit} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, stackLimit: Number(event.target.value) } : value) })} /></label>
      <label><input type="checkbox" checked={item.canContain} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, canContain: event.target.checked } : value) })} /> Can contain items</label>
      <label>Event sent when used <select value={item.useEventId ?? ''} onChange={(event) => { const next = { ...item }; if (event.target.value) next.useEventId = event.target.value; else delete (next as { useEventId?: string }).useEventId; onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? next : value) }); }}><option value="">Not usable</option>{world.eventDefinitions.map((event) => <option key={event.id} value={event.id}>{event.id}</option>)}</select></label>
      <label>Equipment slot <input value={item.equipmentSlot ?? ''} onChange={(event) => { const next = { ...item }; if (event.target.value) next.equipmentSlot = event.target.value; else delete (next as { equipmentSlot?: string }).equipmentSlot; onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? next : value) }); }} /></label>
      <StateFieldsEditor fields={item.fields} onChange={(fields) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, fields } : value) })} />
    </fieldset>} />
    <h3>Initial stacks</h3><HelpTip label="Initial stacks">Starting inventory entries. A stack is one group of identical items held together, such as three coins. Choose who owns it and how many items it contains.</HelpTip><CollectionBrowser requestedIndex={requested?.entityId ? world.initialInventory.findIndex(item => item.id === requested.entityId) : undefined} requestKey={requested?.request} name="Initial stacks" onDeleteSelected={indices => publishRemoval(world, { ...world, initialInventory: world.initialInventory.filter((_item, index) => !indices.includes(index)) }, onWorldChange)} items={world.initialInventory} title={stack => `${stack.quantity} × ${stack.itemId}`} summary={stack => stack.id}
      addLabel="Add initial stock" addDisabled={!world.itemDefinitions.length} onAdd={() => { const item = world.itemDefinitions[0]; if (!item) return; onWorldChange({ ...world, initialInventory: [...world.initialInventory, { id: uid(), owner: { kind: 'world' }, itemId: item.id, quantity: 1, fields: {} }] }); }}
      renderEditor={(stack, index) => <fieldset style={fieldStyle}><legend>{stack.id}</legend>
      <label>Item <select value={stack.itemId} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, itemId: event.target.value } : value) })}>{world.itemDefinitions.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item.name)}</option>)}</select></label>
      <ScopeField value={stack.owner} world={world} onChange={(owner) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, owner } : value) })} />
      <label>Quantity <input type="number" min="1" value={stack.quantity} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, quantity: Number(event.target.value) } : value) })} /></label>
      <label>Container stack <select value={stack.containerStackId ?? ''} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => { if (i !== index) return value; const next = { ...value }; if (event.target.value) next.containerStackId = event.target.value; else delete (next as { containerStackId?: string }).containerStackId; return next; }) })}><option value="">No container</option>{world.initialInventory.filter((value) => value.id !== stack.id && world.itemDefinitions.find((item) => item.id === value.itemId)?.canContain).map((value) => <option key={value.id} value={value.id}>{value.id}</option>)}</select></label>
      {world.itemDefinitions.find((item) => item.id === stack.itemId)?.fields.map((field) => <ScalarField key={field.key} label={`Stack field: ${field.key}`} value={stack.fields[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={(value) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((entry, i) => i === index ? { ...entry, fields: { ...entry.fields, [field.key]: value } } : entry) })} />)}
      <button type="button" onClick={() => publishRemoval(world, { ...world, initialInventory: world.initialInventory.filter((_value, i) => i !== index) }, onWorldChange)}>Remove stack</button>
    </fieldset>} />
  </section>;
}

function TimeEditor({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  const time = world.settings.time;
  const change = (patch: Partial<typeof time>) => onWorldChange({ ...world, settings: { ...world.settings, time: { ...time, ...patch } } });
  return <section><div className="apprentice-section-title"><h2>Time</h2><HelpTip label="Time">Choose how the game clock advances. Per-action time is simplest for a first story.</HelpTip></div>
    <label>Clock mode <select value={time.mode} onChange={(event) => change({ mode: event.target.value as typeof time.mode })}><option value="per-action">Per action</option><option value="elapsed">Elapsed time</option></select></label>
    {time.mode === 'per-action' && <><HelpTip label="Game clock">Turn-based time advances once for every accepted action. Elapsed time follows the clock while playing. These values are milliseconds; 1000 is one second.</HelpTip><label>Milliseconds per action <input type="number" min="0" value={time.millisecondsPerAction ?? 0} onChange={(event) => change({ millisecondsPerAction: Number(event.target.value) })} /></label></>}
    <label>When hidden <select value={time.hiddenBehavior} onChange={(event) => change({ hiddenBehavior: event.target.value as typeof time.hiddenBehavior })}><option value="pause">Pause</option><option value="bounded-catch-up">Bounded catch-up</option></select></label>
    <label>Maximum catch-up milliseconds <input type="number" min="0" value={time.maxCatchUpMilliseconds} onChange={(event) => change({ maxCatchUpMilliseconds: Number(event.target.value) })} /></label>
    <label><input type="checkbox" checked={time.showClockHud} onChange={(event) => change({ showClockHud: event.target.checked })} /> Show clock in player HUD</label>
  </section>;
}

function referencedLocaleKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) referencedLocaleKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record['kind'] === 'locale-key' && typeof record['key'] === 'string' && record['key']) keys.add(record['key']);
    for (const child of Object.values(record)) referencedLocaleKeys(child, keys);
  }
  return keys;
}

function TranslationEditor({ world, locales, defaultLocale, onLocalesChange, onProjectContentChange }: Pick<ApprenticeFormsProps, 'world' | 'locales' | 'defaultLocale' | 'onLocalesChange' | 'onProjectContentChange'>) {
  const [language, setLanguage] = useState(defaultLocale ?? '');
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<readonly string[]>([]);
  const [selectionAnchor, setSelectionAnchor] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'missing' | 'used' | 'unused'>('all');
  const [page, setPage] = useState(0);
  const [newKey, setNewKey] = useState('');
  const [renameKey, setRenameKey] = useState('');
  const [newLanguage, setNewLanguage] = useState('');
  const [firstTranslation, setFirstTranslation] = useState('');
  const [deleteMessage, setDeleteMessage] = useState('');
  const documents = locales ?? [];
  const activeDocument = documents.find(document => document.locale === language)
    ?? documents.find(document => document.locale === defaultLocale)
    ?? documents[0];
  const referenced = useMemo(() => referencedLocaleKeys(world), [world]);
  const keys = [...new Set([...referenced, ...documents.flatMap(document => Object.keys(document.strings))])].sort((a, b) => a.localeCompare(b));
  const selection = selectedKeys.filter(key => keys.includes(key));
  const activeKey = selection.length === 1 ? selection[0] : keys.includes(selectedKey) ? selectedKey : keys[0];
  const defaultLanguage = defaultLocale ?? activeDocument?.locale ?? '';
  const defaultText = activeKey ? documents.find(document => document.locale === defaultLanguage)?.strings[activeKey] : undefined;
  const visibleKeys = keys.filter(key => key.toLowerCase().includes(search.trim().toLowerCase()) && (
    filter === 'all' || filter === 'missing' && activeDocument?.strings[key] === undefined ||
    filter === 'used' && referenced.has(key) || filter === 'unused' && !referenced.has(key)
  ));
  const pageCount = Math.max(1, Math.ceil(visibleKeys.length / 40));
  const visiblePage = Math.min(page, pageCount - 1);
  const newTag = newLanguage.trim();
  const canAddLanguage = !!onLocalesChange && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(newTag)
    && !documents.some(document => document.locale.toLowerCase() === newTag.toLowerCase());
  const updateText = (text: string) => {
    if (!activeDocument || !activeKey || !onLocalesChange) return;
    onLocalesChange(documents.map(document => document.locale === activeDocument.locale
      ? { ...document, strings: { ...document.strings, [activeKey]: text } } : document));
  };
  const selectKey = (key: string, event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey && selectionAnchor && visibleKeys.includes(selectionAnchor)) {
      const start = visibleKeys.indexOf(selectionAnchor);
      const end = visibleKeys.indexOf(key);
      const range = visibleKeys.slice(Math.min(start, end), Math.max(start, end) + 1);
      setSelectedKeys(event.metaKey || event.ctrlKey ? [...new Set([...selection, ...range])] : range);
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedKeys(selection.includes(key) ? selection.filter(item => item !== key) : [...selection, key]);
      setSelectionAnchor(key);
    } else {
      setSelectedKeys([key]);
      setSelectionAnchor(key);
    }
    setSelectedKey(key);
    setDeleteMessage('');
  };
  const deleteKeys = (keysToDelete: readonly string[]) => {
    if (!keysToDelete.length || !onProjectContentChange) return;
    const result = removeLocaleKeys(world, documents, defaultLanguage, keysToDelete);
    if (!result.ok) { setDeleteMessage(result.message); return; }
    const description = keysToDelete.length === 1
      ? result.references
        ? `This key is used in ${result.references} place${result.references === 1 ? '' : 's'}. Replace those references with the ${defaultLanguage} text as a string literal, then delete “${keysToDelete[0]}” from every language file? Other translations for this key will be lost.`
        : `Delete “${keysToDelete[0]}” from every language file?`
      : `Delete ${keysToDelete.length} selected keys from every language file? ${result.references} in-use reference${result.references === 1 ? '' : 's'} will become ${defaultLanguage} string literals. Other translations for these keys will be lost.`;
    if (!window.confirm(`${description} Script source is not rewritten.`)) return;
    onProjectContentChange(result.world, result.locales);
    setSelectedKey('');
    setSelectedKeys([]);
    setSelectionAnchor('');
    setDeleteMessage('');
  };
  const selectionCanDelete = selection.every(key => !referenced.has(key) || documents.find(document => document.locale === defaultLanguage)?.strings[key] !== undefined);
  return <section className="apprentice-translations" aria-label="Translations">
    <div className="apprentice-section-title"><h2>Translations</h2><HelpTip label="Translations">A locale key names text in a language file. Scene titles, story paragraphs, choices, and dialogue can share this editor. The default language must provide every key used by the game.</HelpTip></div>
    <p>Choose a key, then write the text players should see. Keys used by choices and other actions appear here as soon as you enter them.</p>
    <div className="apprentice-translations__language">
      <label>Language <select aria-label="Translation language" value={activeDocument?.locale ?? ''} disabled={!activeDocument} onChange={event => setLanguage(event.target.value)}>
        {documents.map(document => <option key={document.locale} value={document.locale}>{document.locale}{document.locale === defaultLocale ? ' · default' : ''}</option>)}
      </select></label>
      <label>New language <input aria-label="New translation language" value={newLanguage} placeholder="e.g. fr-FR" onChange={event => setNewLanguage(event.target.value)} /></label>
      <label>First translation for {activeKey ?? 'a key'} <input aria-label="First translation" value={firstTranslation} disabled={!activeKey} onChange={event => setFirstTranslation(event.target.value)} /></label>
      <button type="button" disabled={!canAddLanguage} onClick={() => {
        if (!onLocalesChange) return;
        onLocalesChange([...documents, { format: 'dungeon-scrivener-locale', schemaVersion: 1, locale: newTag, strings: activeKey && firstTranslation ? { [activeKey]: firstTranslation } : {} }]);
        setLanguage(newTag);
        setNewLanguage('');
        setFirstTranslation('');
      }}>Add language</button>
    </div>
    <p className="apprentice-translations__hint">Language files may be empty. Missing translations fall back to the default language. Literal text needs no translation keys.</p>
    {!activeDocument && <p role="status">Add a language here to start saving translations. Literal text works without translation keys.</p>}
    {activeDocument && <>
      <div className="apprentice-translations__language"><label>New key name<input aria-label="New translation key" value={newKey} onChange={event => setNewKey(event.target.value)} placeholder="room-description" /></label>
      <button type="button" disabled={!onLocalesChange || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(newKey.trim()) || keys.includes(newKey.trim())} onClick={() => { const key = newKey.trim(); onLocalesChange?.(documents.map(document => document.locale === activeDocument.locale ? { ...document, strings: { ...document.strings, [key]: '' } } : document)); setSelectedKey(key); setSelectedKeys([key]); setSearch(''); setFilter('all'); setPage(0); setNewKey(''); }}>Add key</button></div>
      <div className="apprentice-translations__filters"><label>Find a key <input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Search scene, choice, or dialogue keys" /></label>
        <label>Show <select aria-label="Translation key filter" value={filter} onChange={event => { setFilter(event.target.value as typeof filter); setPage(0); }}><option value="all">All keys</option><option value="missing">Needs text</option><option value="used">In use</option><option value="unused">Unused</option></select></label></div>
      <p className="apprentice-translations__hint">Shift-click selects a range. Command/Ctrl-click toggles keys. With the key list focused, Command/Ctrl+A selects all filtered keys; Delete or Command+Backspace removes the selection.</p>
      <div className="apprentice-translations__keys" aria-label="Translation keys" onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault(); event.stopPropagation(); setSelectedKeys(visibleKeys); setSelectionAnchor(visibleKeys[0] ?? ''); setDeleteMessage('');
        } else if (event.key === 'Delete' || event.metaKey && event.key === 'Backspace') {
          event.preventDefault(); event.stopPropagation();
          const focusedKey = event.target instanceof HTMLButtonElement ? event.target.dataset['translationKey'] : undefined;
          deleteKeys(selection.length ? selection : focusedKey ? [focusedKey] : []);
        } else if (event.key === 'Escape' && selection.length) {
          event.preventDefault(); event.stopPropagation(); setSelectedKeys([]); setSelectionAnchor('');
        }
      }}>
        {visibleKeys.slice(visiblePage * 40, (visiblePage + 1) * 40).map(key => <button key={key} type="button" data-translation-key={key} className={selection.includes(key) ? 'is-selected' : ''} aria-pressed={selection.includes(key)} onClick={event => selectKey(key, event)}>
          <span>{key}</span><small>{activeDocument.strings[key] === undefined ? 'Needs text' : referenced.has(key) ? 'In use' : 'Saved'}</small>
        </button>)}
        {!visibleKeys.length && <p>{keys.length ? 'No keys match this search.' : 'No translation keys. Add a key here, or use literal text throughout your game.'}</p>}
      </div>
      {visibleKeys.length > 40 && <div className="apprentice-collection__pages"><button type="button" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Previous</button><span>{visiblePage * 40 + 1}–{Math.min((visiblePage + 1) * 40, visibleKeys.length)} of {visibleKeys.length}</span><button type="button" disabled={visiblePage === pageCount - 1} onClick={() => setPage(visiblePage + 1)}>Next</button></div>}
      {selection.length > 1 && <div className="apprentice-translations__editor" aria-label="Selected translation keys">
        <strong>{selection.length} keys selected</strong>
        <p>Deletion removes these keys from every language. In-use text becomes a literal from {defaultLanguage}.</p>
        <button type="button" className="apprentice-remove" disabled={!onProjectContentChange || !selectionCanDelete} onClick={() => deleteKeys(selection)}>Delete selected keys</button>
        {!selectionCanDelete && <p role="status">Add default-language text for each selected in-use key before deleting.</p>}
        {deleteMessage && <p role="alert">{deleteMessage}</p>}
      </div>}
      {activeKey && selection.length <= 1 && <div className="apprentice-translations__editor">
        <div className="apprentice-translations__language"><label>Rename key<input aria-label="Rename translation key" value={renameKey} onChange={event => setRenameKey(event.target.value)} placeholder={activeKey} /></label><button type="button" disabled={!onProjectContentChange || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(renameKey.trim()) || keys.includes(renameKey.trim())} onClick={() => { const nextKey = renameKey.trim(); const result = renameLocaleKey(world, documents, activeKey, nextKey); if (!result.ok) { setDeleteMessage(result.message); return; } onProjectContentChange?.(result.world, result.locales); setSelectedKey(nextKey); setSelectedKeys([nextKey]); setRenameKey(''); }}>Rename key and references</button></div>
        <div><strong>{activeKey}</strong><span>{referenced.has(activeKey) ? 'Used by the game' : 'Saved in the language file'}</span></div>
        <label>Text for {activeDocument.locale}<textarea aria-label={`Translation text for ${activeKey} (${activeDocument.locale})`} rows={10}
          value={activeDocument.strings[activeKey] ?? ''} onChange={event => updateText(event.target.value)} /></label>
        {activeDocument.strings[activeKey] === undefined && <p role="status">This key has no text in {activeDocument.locale}. Enter its translation here.</p>}
        <div className="apprentice-translations__delete"><button type="button" className="apprentice-remove" aria-label={`Delete translation key ${activeKey}`} disabled={!onProjectContentChange || referenced.has(activeKey) && defaultText === undefined} onClick={() => deleteKeys([activeKey])}>Delete key from all languages</button>
          {referenced.has(activeKey) && <p>{defaultText === undefined ? `Add ${defaultLanguage} text before deleting this in-use key.` : `In use. Deleting replaces its references with the ${defaultLanguage} text as a string literal and removes its other translations.`}</p>}
          {deleteMessage && <p role="alert">{deleteMessage}</p>}
        </div>
      </div>}
    </>}
  </section>;
}

export function ApprenticeForms({ world, view = 'all', selectedNodeId, actionFocus, requestedWorldSection, onWorldChange, project, locales, defaultLocale, assets, mediaAssets, onLocalesChange, onProjectContentChange, onImportAsset }: ApprenticeFormsProps) {
  const [worldSection, setWorldSection] = useState<'theme' | 'defaults' | 'state' | 'rules' | 'dialogue' | 'actors' | 'inventory' | 'time'>('state');
  useEffect(() => { if (requestedWorldSection) setWorldSection(requestedWorldSection.section as typeof worldSection); }, [requestedWorldSection]);
  const node = useMemo(() => world.nodes.find((candidate) => candidate.id === selectedNodeId), [world, selectedNodeId]);
  const updateNode = (next: NodeDefinition) => onWorldChange(updateNodeDefinition(world, next.id, () => next) ?? world);
  const contentSettings: ContentSettings = { project, locales, defaultLocale, assets, mediaAssets, onLocalesChange, onImportAsset };
  return <div className={view === 'world' ? 'apprentice-world-form' : undefined} aria-label="Apprentice forms" style={{ display: 'grid', gap: 18, padding: 16, overflow: 'auto' }}>
    {(view === 'scene' || view === 'actions' || view === 'logic' || view === 'all') && (node ? <NodeEditor actionFocus={actionFocus} section={view} key={node.id} world={world} node={node} onChange={updateNode} onWorldChange={onWorldChange} contentSettings={contentSettings} /> : <p>Select a node to edit its content and actions.</p>)}
    {view === 'text' && <TranslationEditor world={world} locales={locales} defaultLocale={defaultLocale} onLocalesChange={onLocalesChange} onProjectContentChange={onProjectContentChange} />}
    {(view === 'world' || view === 'all') && <>
    <nav className="apprentice-world-directory" aria-label="World sections">
      {([
        ['state', 'State', world.stateDefinitions.length], ['defaults', 'Action defaults', world.actionDefaults.choices.length + world.actionDefaults.commands.length],
        ['rules', 'Rules', world.rules.length], ['dialogue', 'Dialogue', world.conversations.length],
        ['actors', 'Actors & events', world.entities.length + world.entityDefinitions.length + world.eventDefinitions.length],
        ['inventory', 'Inventory', world.itemDefinitions.length + world.initialInventory.length],
        ['theme', 'Theme & sounds', world.settings.typingSounds?.mappings.length ?? 0], ['time', 'Time', 0],
      ] as const).map(([id, label, count]) => <button key={id} type="button" aria-current={worldSection === id ? 'page' : undefined} onClick={() => setWorldSection(id)}>
        <span>{label}</span>{count > 0 && <small>{count}</small>}
      </button>)}
    </nav>
    {worldSection === 'theme' && <ApprenticeAuthorSettings world={world} project={project} assets={assets} onWorldChange={onWorldChange} />}
    {worldSection === 'defaults' && <section><div className="apprentice-section-title"><h2>Game action defaults</h2><HelpTip label="Game action defaults">These actions can be inherited by scenes. Use scene actions for choices that belong to only one scene.</HelpTip></div><p>Nodes may inherit these choices and commands independently.</p><ActionEditors actionFocus={actionFocus} actions={world.actionDefaults} world={world} localeStrings={locales?.find(locale => locale.locale === defaultLocale)?.strings ?? {}} onChange={(actionDefaults) => onWorldChange({ ...world, actionDefaults })} /></section>}
    {worldSection === 'state' && <WorldStateEditor world={world} onWorldChange={onWorldChange} />}
    {worldSection === 'rules' && <RuleEditor requested={requestedWorldSection} world={world} onChange={(rules) => onWorldChange({ ...world, rules })} />}
    {worldSection === 'dialogue' && <ConversationEditor requested={requestedWorldSection} world={world} onChange={(conversations) => onWorldChange({ ...world, conversations })} />}
    {worldSection === 'actors' && <EventActorEditors requested={requestedWorldSection} world={world} onWorldChange={onWorldChange} />}
    {worldSection === 'inventory' && <InventoryEditor requested={requestedWorldSection} world={world} onWorldChange={onWorldChange} />}
    {worldSection === 'time' && <TimeEditor world={world} onWorldChange={onWorldChange} />}
    </>}
  </div>;
}
