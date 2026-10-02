import { useId, useMemo, useState } from 'react';
import type {
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
import { updateNodeDefinition } from './commands.js';

export interface ApprenticeFormsProps {
  readonly world: WorldDocument;
  readonly view?: 'scene' | 'world' | 'all';
  readonly selectedNodeId?: string;
  readonly onWorldChange: (world: WorldDocument) => void;
  readonly project?: ProjectVfsSnapshot | undefined;
  readonly locales?: readonly LocaleDocument[] | undefined;
  readonly defaultLocale?: string | undefined;
  readonly assets?: readonly RegisteredAsset[] | undefined;
  readonly mediaAssets?: MediaAssetApi | undefined;
  readonly onLocalesChange?: ((locales: readonly LocaleDocument[]) => void) | undefined;
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

function TextSourceField({ label, value, onChange }: { label: string; value: TextSource; onChange: (next: TextSource) => void }) {
  return <fieldset className="apprentice-text-source" style={fieldStyle}><legend>{label}</legend>
    <label>Text source <select value={value.kind} onChange={(event) => onChange(event.target.value === 'literal' ? { kind: 'literal', text: '' } : { kind: 'locale-key', key: '' })}>
      <option value="literal">Literal text</option><option value="locale-key">Locale key</option>
    </select></label>
    <label>{value.kind === 'literal' ? 'Text' : 'Locale key'} <input style={inputStyle} value={value.kind === 'literal' ? value.text : value.key} onChange={(event) => onChange(value.kind === 'literal' ? { kind: 'literal', text: event.target.value } : { kind: 'locale-key', key: event.target.value })} /></label>
    {value.kind === 'locale-key' && <p className="apprentice-text-source__hint">Edit this key’s player-facing text in World → Translations.</p>}
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

function StateFieldsEditor({ fields, onChange, allowAdd = true, showKey = true, allowRemove = true }: { fields: readonly StateFieldDefinition[]; onChange: (fields: readonly StateFieldDefinition[]) => void; allowAdd?: boolean; showKey?: boolean; allowRemove?: boolean }) {
  return <fieldset style={fieldStyle}><legend>State fields</legend>
    {fields.map((field, index) => <div key={`${field.key}-${index}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
      {showKey && <label>Key <input value={field.key} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} /></label>}
      <label>Type <select value={typeof field.valueType === 'string' ? field.valueType : 'enum'} onChange={(event) => {
        const kind = event.target.value;
        const valueType = kind === 'enum' ? { kind: 'enum' as const, values: [] } : kind as 'string' | 'number' | 'integer' | 'boolean';
        const defaultValue: Scalar = kind === 'boolean' ? false : kind === 'number' || kind === 'integer' ? 0 : '';
        onChange(fields.map((item, i) => i === index ? { ...item, valueType, defaultValue } : item));
      }}><option value="string">Text</option><option value="number">Number</option><option value="integer">Integer</option><option value="boolean">Boolean</option><option value="enum">Enum</option></select></label>
      {typeof field.valueType !== 'string' && <label>Allowed values <input value={field.valueType.values.join(', ')} onChange={(event) => onChange(fields.map((item, i) => i === index && typeof item.valueType !== 'string' ? { ...item, valueType: { ...item.valueType, values: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } } : item))} /></label>}
      <label>Default {typeof field.defaultValue === 'boolean' ? <select value={String(field.defaultValue)} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, defaultValue: event.target.value === 'true' } : item))}><option value="false">false</option><option value="true">true</option></select> : <input type={typeof field.defaultValue === 'number' ? 'number' : 'text'} value={field.defaultValue} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, defaultValue: typeof item.defaultValue === 'number' ? Number(event.target.value) : event.target.value } : item))} />}</label>
      {allowRemove && <button type="button" onClick={() => onChange(fields.filter((_item, i) => i !== index))}>Remove field</button>}
    </div>)}
    {allowAdd && <button type="button" onClick={() => onChange([...fields, { key: uid(), valueType: 'string', defaultValue: '' }])}>Add state field</button>}
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
      addLabel="Add world state" onAdd={() => { const key = uid(); onWorldChange({ ...world, stateDefinitions: [...world.stateDefinitions, { key, scopeKind: 'world', valueType: 'integer', defaultValue: 0 }], worldState: { ...world.worldState, [key]: 0 } }); }}
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

function stateValueType(world: WorldDocument, reference: StateReference): ValueType {
  const scope = reference.scope;
  if (scope.kind === 'entity') {
    const entity = world.entities.find((candidate) => candidate.id === scope.ownerId);
    const definition = world.entityDefinitions.find((candidate) => candidate.id === entity?.definitionId);
    return definition?.fields.find((field) => field.key === reference.key)?.valueType ?? 'string';
  }
  const field = world.stateDefinitions.find((candidate) => candidate.key === reference.key && candidate.scopeKind === scope.kind);
  return field?.valueType ?? 'string';
}

function ScalarField({ label, value, valueType, onChange }: { label: string; value: Scalar; valueType: ValueType; onChange: (value: Scalar) => void }) {
  if (typeof valueType === 'object') return <label>{label} <select value={String(value)} onChange={(event) => onChange(event.target.value)}>{valueType.values.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
  if (valueType === 'boolean') return <label>{label} <select value={String(value)} onChange={(event) => onChange(event.target.value === 'true')}><option value="false">false</option><option value="true">true</option></select></label>;
  if (valueType === 'number' || valueType === 'integer') return <label>{label} <input type="number" step={valueType === 'integer' ? 1 : 'any'} value={Number(value)} onChange={(event) => onChange(Number(event.target.value))} /></label>;
  return <label>{label} <input style={inputStyle} value={String(value)} onChange={(event) => onChange(event.target.value)} /></label>;
}

const emptyCondition = (): Condition => ({ kind: 'at-node', nodeId: '' });
function ConditionField({ label = 'Condition', value, onChange, world }: { label?: string; value?: Condition | undefined; onChange: (next?: Condition) => void; world: WorldDocument }) {
  const current = value ?? emptyCondition();
  const set = (patch: Partial<Condition>) => onChange({ ...current, ...patch } as Condition);
  return <fieldset className="apprentice-condition" style={fieldStyle}><legend>{label}</legend><HelpTip label="Condition">A condition controls when this action is available. Leave it off to make the action always available.</HelpTip>
    <label><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked ? emptyCondition() : undefined)} /> Enabled</label>
    {value && <>
      <label>Predicate <select value={current.kind} onChange={(event) => {
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
        <option value="at-node">At node</option><option value="event-is">Event is</option><option value="time-at-least">Time at least</option><option value="compare-state">Compare state</option><option value="has-tag">Actor has tag</option><option value="has-item">Has item</option><option value="all">All of</option><option value="any">Any of</option><option value="not">Not</option><option value="has-seen-line">Has seen dialogue line</option><option value="has-selected-dialogue-option">Has selected dialogue option</option>
      </select></label>
      {current.kind === 'at-node' && <label>Node <select value={current.nodeId} onChange={(event) => set({ nodeId: event.target.value })}><option value="">Choose node</option>{world.nodes.map((node) => <option key={node.id} value={node.id}>{sourceLabel(node.title)}</option>)}</select></label>}
      {current.kind === 'event-is' && <label>Event <select value={current.eventId} onChange={(event) => set({ eventId: event.target.value })}><option value="">Choose event</option>{world.eventDefinitions.map((event) => <option key={event.id} value={event.id}>{event.id}</option>)}</select></label>}
      {current.kind === 'time-at-least' && <label>Milliseconds <input type="number" min="0" value={current.milliseconds} onChange={(event) => set({ milliseconds: Number(event.target.value) })} /></label>}
      {current.kind === 'compare-state' && <><StateReferenceFields value={current.left} world={world} onChange={(left) => set({ left })} /><label>Operator <select value={current.operator} onChange={(event) => set({ operator: event.target.value as typeof current.operator })}>{['eq','neq','lt','lte','gt','gte'].map((operator) => <option key={operator} value={operator}>{operator}</option>)}</select></label><ScalarField label="Compared value" value={current.right} valueType={stateValueType(world, current.left)} onChange={(right) => set({ right })} /></>}
      {current.kind === 'has-tag' && <><label>Actor <select value={current.entityId} onChange={(event) => set({ entityId: event.target.value })}><option value="">Choose actor</option>{world.entities.map((entity) => <option key={entity.id} value={entity.id}>{sourceLabel(entity.name)}</option>)}</select></label><label>Tag <input value={current.tag} onChange={(event) => set({ tag: event.target.value })} /></label></>}
      {current.kind === 'has-item' && <><ScopeField value={current.owner} world={world} onChange={(owner) => set({ owner })} /><label>Item <select value={current.itemId} onChange={(event) => set({ itemId: event.target.value })}><option value="">Choose item</option>{world.itemDefinitions.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item.name)}</option>)}</select></label><label>Minimum quantity <input type="number" min="1" value={current.quantity} onChange={(event) => set({ quantity: Number(event.target.value) })} /></label></>}
      {current.kind === 'has-seen-line' && <><label>Conversation <select value={current.conversationId} onChange={(event) => set({ conversationId: event.target.value, lineId: '' })}><option value="">Choose conversation</option>{world.conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.id}</option>)}</select></label><label>Line <select value={current.lineId} onChange={(event) => set({ lineId: event.target.value })}><option value="">Choose line</option>{world.conversations.find((conversation) => conversation.id === current.conversationId)?.lines.map((line) => <option key={line.id} value={line.id}>{line.id}</option>)}</select></label></>}
      {current.kind === 'has-selected-dialogue-option' && <><label>Conversation ID <input value={current.conversationId} onChange={(event) => set({ conversationId: event.target.value })} /></label><label>Option ID <input value={current.optionId} onChange={(event) => set({ optionId: event.target.value })} /></label></>}
      {(current.kind === 'all' || current.kind === 'any') && <div><p>{current.kind === 'all' ? 'Every predicate must match.' : 'At least one predicate must match.'}</p>{current.conditions.map((condition, index) => <ConditionField key={index} value={condition} world={world} onChange={(next) => set({ conditions: current.conditions.map((old, i) => i === index ? (next ?? emptyCondition()) : old) })} />)}<button type="button" onClick={() => set({ conditions: [...current.conditions, emptyCondition()] })}>Add predicate</button></div>}
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
          'run-script': { kind: 'run-script', scriptId: '' },
        };
        const next = kinds[event.target.value]; if (next) update(index, next);
      }}>
        <option value="set-state">Set state</option><option value="increment-state">Increment state</option><option value="navigate">Navigate</option><option value="emit-event">Emit event</option><option value="add-item">Add item</option><option value="remove-item">Remove item</option><option value="transfer-item">Transfer item</option><option value="use-item">Use item</option><option value="equip-item">Equip item</option><option value="unequip-item">Unequip item</option><option value="add-tag">Add actor tag</option><option value="remove-tag">Remove actor tag</option><option value="start-conversation">Start conversation</option><option value="interrupt-conversation">Interrupt conversation</option><option value="resume-conversation">Resume conversation</option><option value="run-script">Run script</option>
      </select></label>
      {(effect.kind === 'set-state' || effect.kind === 'increment-state') && <><StateReferenceFields value={effect.target} world={world} onChange={(target) => update(index, { ...effect, target })} />{effect.kind === 'set-state' ? <ScalarField label="Value" value={effect.value} valueType={stateValueType(world, effect.target)} onChange={(value) => update(index, { ...effect, value })} /> : <label>Amount <input type="number" value={effect.amount} onChange={(event) => update(index, { ...effect, amount: Number(event.target.value) })} /></label>}</>}
      {effect.kind === 'navigate' && <label>Navigation link <select value={effect.edgeId} onChange={(event) => update(index, { ...effect, edgeId: event.target.value })}><option value="">Choose link</option>{world.navigationEdges.map((edge) => <option key={edge.id} value={edge.id}>{edge.id}</option>)}</select></label>}
      {effect.kind === 'emit-event' && <label>Event <select value={effect.eventId} onChange={(event) => { const definition = world.eventDefinitions.find((item) => item.id === event.target.value); update(index, { ...effect, eventId: event.target.value, payload: Object.fromEntries((definition?.payloadFields ?? []).map((field) => [field.key, field.defaultValue])) }); }}><option value="">Choose event</option>{world.eventDefinitions.map((event) => <option key={event.id} value={event.id}>{event.id}</option>)}</select></label>}
      {effect.kind === 'emit-event' && world.eventDefinitions.find((event) => event.id === effect.eventId)?.payloadFields.map((field) => <ScalarField key={field.key} label={`Payload: ${field.key}`} value={(effect.payload[field.key] as Scalar | undefined) ?? field.defaultValue} valueType={field.valueType} onChange={(value) => update(index, { ...effect, payload: { ...effect.payload, [field.key]: value } })} />)}
      {effect.kind === 'add-item' && <><ScopeField value={effect.owner} world={world} onChange={(owner) => update(index, { ...effect, owner })} /><label>Item <select value={effect.itemId} onChange={(event) => update(index, { ...effect, itemId: event.target.value })}><option value="">Choose item</option>{world.itemDefinitions.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item.name)}</option>)}</select></label><label>Quantity <input type="number" min="1" value={effect.quantity} onChange={(event) => update(index, { ...effect, quantity: Number(event.target.value) })} /></label></>}
      {effect.kind === 'remove-item' && <><label>Stack ID <input value={effect.stackId} onChange={(event) => update(index, { ...effect, stackId: event.target.value })} /></label><label>Quantity <input type="number" min="1" value={effect.quantity} onChange={(event) => update(index, { ...effect, quantity: Number(event.target.value) })} /></label></>}
      {effect.kind === 'transfer-item' && <><label>Stack ID <input value={effect.stackId} onChange={(event) => update(index, { ...effect, stackId: event.target.value })} /></label><label>Quantity <input type="number" min="1" value={effect.quantity} onChange={(event) => update(index, { ...effect, quantity: Number(event.target.value) })} /></label><ScopeField value={effect.destination.owner} world={world} onChange={(owner) => update(index, { ...effect, destination: { ...effect.destination, owner } })} /><label>Destination container stack ID <input value={effect.destination.containerStackId ?? ''} onChange={(event) => { const destination = { ...effect.destination }; if (event.target.value) destination.containerStackId = event.target.value; else delete (destination as { containerStackId?: string }).containerStackId; update(index, { ...effect, destination }); }} /></label></>}
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

function ActionEditors({ actions, onChange, world }: { actions: ActionSet; onChange: (actions: ActionSet) => void; world: WorldDocument }) {
  const updateChoice = (index: number, choice: ChoiceDefinition) => onChange({ ...actions, choices: actions.choices.map((item, i) => i === index ? choice : item) });
  const updateCommand = (index: number, command: CommandDefinition) => onChange({ ...actions, commands: actions.commands.map((item, i) => i === index ? command : item) });
  return <section className="apprentice-actions"><div className="apprentice-section-title"><h3>Player actions</h3><HelpTip label="Player actions">Choices are buttons players can select. Commands are words players type. Link either to a route on the map, then add optional conditions and effects.</HelpTip></div>
    {actions.choices.length === 0 && actions.commands.length === 0 && <p className="apprentice-empty">No actions yet. Add a choice to give the player something to do.</p>}
    <CollectionBrowser name="Choices" items={actions.choices} title={choice => sourceLabel(choice.label) || choice.id} summary={choice => `${choice.id}${choice.navigationEdgeId ? ` · route ${choice.navigationEdgeId}` : ''}`}
      addLabel="Add choice" onAdd={() => onChange({ ...actions, choices: [...actions.choices, { id: uid(), label: { kind: 'literal', text: 'New choice' }, effects: [] }] })}
      renderEditor={(choice, index) => <fieldset className="apprentice-choice" style={fieldStyle}><legend><span className="apprentice-kind">Choice {index + 1}</span> <span className="apprentice-id">{choice.id}</span></legend>
      <TextSourceField label="Choice label" value={choice.label} onChange={(label) => updateChoice(index, { ...choice, label })} />
      <ConditionField value={choice.condition} world={world} onChange={(condition) => { const next = { ...choice }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; updateChoice(index, next); }} />
      <label>When condition is false <select value={choice.falsePolicy ?? 'hide'} onChange={(event) => updateChoice(index, { ...choice, falsePolicy: event.target.value as 'hide' | 'disable' })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
      <label>Navigation link <select value={choice.navigationEdgeId ?? ''} onChange={(event) => { const next = { ...choice }; if (event.target.value) next.navigationEdgeId = event.target.value; else delete (next as { navigationEdgeId?: string }).navigationEdgeId; updateChoice(index, next); }}><option value="">No navigation</option>{world.navigationEdges.map((edge) => <option key={edge.id} value={edge.id}>{edge.id}</option>)}</select></label>
      <EffectList effects={choice.effects} world={world} onChange={(effects) => updateChoice(index, { ...choice, effects })} />
      <button type="button" className="apprentice-remove" onClick={() => onChange({ ...actions, choices: actions.choices.filter((_item, i) => i !== index) })}>Remove choice</button>
    </fieldset>} />
    <CollectionBrowser name="Commands" items={actions.commands} title={command => command.patterns[0] || command.id} summary={command => `${command.id}${command.navigationEdgeId ? ` · route ${command.navigationEdgeId}` : ''}`}
      addLabel="Add command" onAdd={() => onChange({ ...actions, commands: [...actions.commands, { id: uid(), patterns: ['new command'], parameters: [], effects: [] }] })}
      renderEditor={(command, index) => <fieldset className="apprentice-command" style={fieldStyle}><legend><span className="apprentice-kind">Command {index + 1}</span> <span className="apprentice-id">{command.id}</span></legend>
      <label>Command ID <input value={command.id} onChange={(event) => updateCommand(index, { ...command, id: event.target.value })} /></label>
      <label>Patterns, primary first <input style={inputStyle} value={command.patterns.join(' | ')} onChange={(event) => updateCommand(index, { ...command, patterns: event.target.value.split('|').map((part) => part.trim()) })} /></label>
      <label>Parameters (ID:type; enum values use enum[a|b]) <input style={inputStyle} value={command.parameters.map((parameter) => `${parameter.id}:${typeof parameter.valueType === 'string' ? parameter.valueType : `enum[${parameter.valueType.values.join('|')}]`}`).join(', ')} onChange={(event) => updateCommand(index, { ...command, parameters: event.target.value.split(',').map((part) => { const [id, kind = 'string'] = part.trim().split(':'); const enumValues = /^enum\[(.*)\]$/.exec(kind); const valueType: ValueType = enumValues ? { kind: 'enum', values: enumValues[1] ? enumValues[1].split('|') : [] } : kind === 'number' || kind === 'integer' || kind === 'boolean' ? kind : 'string'; return { id: id ?? '', valueType }; }) })} /></label>
      <ConditionField value={command.condition} world={world} onChange={(condition) => { const next = { ...command }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; updateCommand(index, next); }} />
      <label>When condition is false <select value={command.falsePolicy ?? 'hide'} onChange={(event) => updateCommand(index, { ...command, falsePolicy: event.target.value as 'hide' | 'disable' })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
      <label>Navigation link <select value={command.navigationEdgeId ?? ''} onChange={(event) => { const next = { ...command }; if (event.target.value) next.navigationEdgeId = event.target.value; else delete (next as { navigationEdgeId?: string }).navigationEdgeId; updateCommand(index, next); }}><option value="">No navigation</option>{world.navigationEdges.map((edge) => <option key={edge.id} value={edge.id}>{edge.id}</option>)}</select></label>
      <EffectList effects={command.effects} world={world} onChange={(effects) => updateCommand(index, { ...command, effects })} />
      <button type="button" className="apprentice-remove" onClick={() => onChange({ ...actions, commands: actions.commands.filter((_item, i) => i !== index) })}>Remove command</button>
    </fieldset>} />
  </section>;
}

function NodeEditor({ world, node, onChange, contentSettings }: { world: WorldDocument; node: NodeDefinition; onChange: (node: NodeDefinition) => void; contentSettings: ContentSettings }) {
  const defaultTitleLocale = contentSettings.locales?.find(locale => locale.locale === contentSettings.defaultLocale);
  const titleKey = node.title.kind === 'locale-key' ? node.title.key : undefined;
  const inheritedActions = node.inheritance?.defaults && node.parentId !== null
    ? resolveNodeActions(world, node.parentId).value ?? world.actionDefaults
    : world.actionDefaults;
  const inheritedRules = node.inheritance?.rules && node.parentId !== null
    ? resolveNodeRules(world, node.parentId).value ?? []
    : [];
  const localRules = (node.ruleIds ?? []).map((id) => world.rules.find((rule) => rule.id === id)).filter((rule): rule is RuleDefinition => rule !== undefined);
  const localChoices = node.actions?.choices ?? [];
  const localCommands = node.actions?.commands ?? [];
  const authoredFields = <>
    <RichContentEditor value={node.content} onChange={(content) => onChange({ ...node, content })} world={world} {...contentSettings} />
    <ActionEditors actions={{ choices: localChoices, commands: localCommands }} world={world} onChange={(actions) => {
      const nextActions = { ...node.actions };
      if (actions.choices !== localChoices) nextActions.choices = actions.choices;
      if (actions.commands !== localCommands) nextActions.commands = actions.commands;
      onChange({ ...node, actions: nextActions });
    }} />
  </>;
  return <section className="apprentice-scene-editor"><div className="apprentice-section-title"><h2>{node.visitable ? 'Scene content' : 'Folder details'}</h2><HelpTip label={node.visitable ? 'Scene content' : 'Folder details'}>{node.visitable ? 'The title and content are what the player sees on entering this scene. Select a box on the map to edit a different scene.' : 'Folders organize scenes and other folders. A folder is not a playable location. Draw from its lower dot to another box’s upper dot to put that box inside it; nest folders the same way. Player routes connect scenes only.'}</HelpTip></div>
    {!node.visitable && <div className="apprentice-folder-note"><p>Organize a chapter here. Connect this folder’s lower dot to a scene or another folder’s upper dot. Players follow scene routes, not folder links.</p><p>{(() => { const children = world.nodes.filter(child => child.parentId === node.id); return `Inside this folder (${children.length}): ${children.slice(0, 8).map(child => sourceLabel(child.title)).join(', ') || 'nothing yet'}${children.length > 8 ? ', …' : ''}.`; })()} A folder may be nested in another folder.</p></div>}
    <TextSourceField label="Title" value={node.title} onChange={(title) => onChange({ ...node, title })} />
    {titleKey !== undefined && defaultTitleLocale && contentSettings.onLocalesChange && <label>Title text ({defaultTitleLocale.locale})
      <input value={defaultTitleLocale.strings[titleKey] ?? ''} onChange={event => contentSettings.onLocalesChange?.((contentSettings.locales ?? []).map(locale => locale.locale === defaultTitleLocale.locale
        ? { ...locale, strings: { ...locale.strings, [titleKey]: event.target.value } } : locale))} />
    </label>}
    {node.visitable ? authoredFields : <details className="apprentice-advanced"><summary>Advanced folder content and action defaults</summary><div><p>Folder text is stored in the project but is not shown during play. Child scenes can inherit folder actions when their inheritance setting is enabled.</p>{authoredFields}</div></details>}
    <details className="apprentice-advanced"><summary>{node.visitable ? 'Advanced scene settings' : 'Advanced folder settings'}</summary><div><p>Use inheritance, node state, and rules when the basic scene and action fields are not enough.</p>
    <label><input type="checkbox" checked={node.inheritance?.defaults ?? false} onChange={(event) => onChange({ ...node, inheritance: { defaults: event.target.checked, rules: node.inheritance?.rules ?? false } })} /> Inherit action defaults</label>
    <label><input type="checkbox" checked={node.inheritance?.rules ?? false} onChange={(event) => onChange({ ...node, inheritance: { defaults: node.inheritance?.defaults ?? false, rules: event.target.checked } })} /> Inherit rules</label>
    <fieldset style={fieldStyle}><legend>Node state overrides</legend><CollectionBrowser name="Node state fields" items={world.stateDefinitions.filter(field => field.scopeKind === 'node')} title={field => field.key} summary={field => `Current ${String(node.state?.[field.key] ?? field.defaultValue)} · default ${String(field.defaultValue)}`} renderEditor={field => <ScalarField label={`${field.key} (default ${String(field.defaultValue)})`} value={node.state?.[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={value => onChange({ ...node, state: { ...node.state, [field.key]: value } })} />} /></fieldset>
    <p>Inherited choices ({inheritedActions.choices.length}): {inheritedActions.choices.length ? inheritedActions.choices.slice(0, 5).map(choice => sourceLabel(choice.label)).join(', ') : 'none'}{inheritedActions.choices.length > 5 ? ', …' : ''}. {node.actions?.choices === undefined ? 'Using inherited choices.' : `Local choices replace them (${localChoices.length}).`}</p>
    <p>Inherited commands ({inheritedActions.commands.length}): {inheritedActions.commands.length ? inheritedActions.commands.slice(0, 5).map(command => command.patterns[0]).join(', ') : 'none'}{inheritedActions.commands.length > 5 ? ', …' : ''}. {node.actions?.commands === undefined ? 'Using inherited commands.' : `Local commands replace them (${localCommands.length}).`}</p>
    <fieldset style={fieldStyle}><legend>Rules on this node</legend><p>{inheritedRules.length} inherited rules. {inheritedRules.slice(0, 5).map(rule => rule.id).join(', ')}{inheritedRules.length > 5 ? ', …' : ''}</p><CollectionBrowser name="Available rules" items={world.rules} title={rule => rule.id} summary={rule => `Priority ${rule.priority}${(node.ruleIds ?? []).includes(rule.id) ? ' · assigned' : ''}`} renderEditor={rule => <label><input type="checkbox" checked={(node.ruleIds ?? []).includes(rule.id)} onChange={(event) => onChange({ ...node, ruleIds: event.target.checked ? [...(node.ruleIds ?? []), rule.id] : (node.ruleIds ?? []).filter((id) => id !== rule.id) })} /> Use {rule.id} on this node</label>} /></fieldset>
    </div></details>
  </section>;
}

function RuleEditor({ world, onChange }: { world: WorldDocument; onChange: (rules: readonly RuleDefinition[]) => void }) {
  const update = (index: number, rule: RuleDefinition) => onChange(world.rules.map((item, i) => i === index ? rule : item));
  return <section><div className="apprentice-section-title"><h2>Rules</h2><HelpTip label="Rules">Rules react to game events or phases. Use them for behavior that should run beyond one scene action.</HelpTip></div>
    <CollectionBrowser name="Rules" items={world.rules} title={rule => rule.id} summary={rule => `${rule.trigger.kind === 'event' ? rule.trigger.eventId : rule.trigger.phase} · priority ${rule.priority}`}
      addLabel="Add rule" onAdd={() => onChange([...world.rules, { id: uid(), trigger: { kind: 'phase', phase: 'action-start' }, priority: 0, effects: [] }])}
      renderEditor={(rule, index) => <fieldset style={fieldStyle}><legend>{rule.id}</legend>
      <label>Rule ID <input value={rule.id} onChange={(event) => update(index, { ...rule, id: event.target.value })} /></label>
      <label>Trigger <select value={rule.trigger.kind === 'event' ? `event:${rule.trigger.eventId}` : `phase:${rule.trigger.phase}`} onChange={(event) => {
        const [kind, value] = event.target.value.split(':');
        update(index, { ...rule, trigger: kind === 'event' ? { kind: 'event', eventId: value ?? '' } : { kind: 'phase', phase: (value ?? 'action-start') as Extract<RuleDefinition['trigger'], { kind: 'phase' }>['phase'] } });
      }}><optgroup label="Events">{world.eventDefinitions.map((event) => <option key={event.id} value={`event:${event.id}`}>{event.id}</option>)}</optgroup><optgroup label="Phases">{['action-start','node-entry','node-revisit','node-exit','time-advanced'].map((phase) => <option key={phase} value={`phase:${phase}`}>{phase}</option>)}</optgroup></select></label>
      <label>Priority <input type="number" value={rule.priority} onChange={(event) => update(index, { ...rule, priority: Number(event.target.value) })} /></label>
      <ConditionField value={rule.condition} world={world} onChange={(condition) => { const next = { ...rule }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; update(index, next); }} />
      <EffectList effects={rule.effects} world={world} onChange={(effects) => update(index, { ...rule, effects })} />
      <button type="button" onClick={() => onChange(world.rules.filter((_item, i) => i !== index))}>Remove rule</button>
    </fieldset>} />
    <p>Rules run by descending priority; equal priorities retain authored order. Inherited rules run parent before child.</p>
  </section>;
}

function ConversationEditor({ world, onChange }: { world: WorldDocument; onChange: (conversations: readonly ConversationDefinition[]) => void }) {
  const updateConversation = (index: number, value: ConversationDefinition) => onChange(world.conversations.map((conversation, i) => i === index ? value : conversation));
  return <section><div className="apprentice-section-title"><h2>Dialogue</h2><HelpTip label="Dialogue">Conversations contain spoken lines and responses. An action can start a conversation.</HelpTip></div>
    <CollectionBrowser name="Conversations" items={world.conversations} title={conversation => conversation.id} summary={conversation => `${conversation.lines.length} lines`}
      addLabel="Add conversation" onAdd={() => { const lineId = uid(); onChange([...world.conversations, { id: uid(), participantEntityIds: [], entryLineId: lineId, interruptible: true, resumeOnReturn: true, lines: [{ id: lineId, speakerEntityId: '', text: { kind: 'literal', text: 'New dialogue line' } }] }]); }}
      renderEditor={(conversation, index) => <fieldset style={fieldStyle}><legend>Conversation: {conversation.id}</legend>
      <label>ID <input value={conversation.id} onChange={(event) => updateConversation(index, { ...conversation, id: event.target.value })} /></label>
      <label>Entry line <select value={conversation.entryLineId} onChange={(event) => updateConversation(index, { ...conversation, entryLineId: event.target.value })}>{conversation.lines.map((line) => <option key={line.id} value={line.id}>{line.id}</option>)}</select></label>
      <label><input type="checkbox" checked={conversation.interruptible} onChange={(event) => updateConversation(index, { ...conversation, interruptible: event.target.checked })} /> Can be interrupted</label>
      <label><input type="checkbox" checked={conversation.resumeOnReturn} onChange={(event) => updateConversation(index, { ...conversation, resumeOnReturn: event.target.checked })} /> Resume when returning to the node</label>
      <label>Participants <select multiple value={[...conversation.participantEntityIds]} onChange={(event) => updateConversation(index, { ...conversation, participantEntityIds: [...event.target.selectedOptions].map((option) => option.value) })}>{world.entities.map((actor) => <option key={actor.id} value={actor.id}>{sourceLabel(actor.name)}</option>)}</select></label>
      <CollectionBrowser name="Lines" items={conversation.lines} title={line => line.id} summary={line => sourceLabel(line.text)}
        addLabel="Add line" onAdd={() => { const line: DialogueLine = { id: uid(), speakerEntityId: conversation.participantEntityIds[0] ?? '', text: { kind: 'literal', text: 'New dialogue line' } }; updateConversation(index, { ...conversation, lines: [...conversation.lines, line] }); }}
        renderEditor={(line, lineIndex) => <fieldset style={fieldStyle}><legend>Line: {line.id}</legend>
        <label>Speaker <select value={line.speakerEntityId} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, speakerEntityId: event.target.value } : item) })}><option value="">Choose actor</option>{world.entities.map((actor) => <option key={actor.id} value={actor.id}>{sourceLabel(actor.name)}</option>)}</select></label>
        <TextSourceField label="Line text" value={line.text} onChange={(text) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, text } : item) })} />
        <label>Next line <select value={line.nextLineId ?? ''} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => { if (i !== lineIndex) return item; const next = { ...item }; if (event.target.value) next.nextLineId = event.target.value; else delete (next as { nextLineId?: string }).nextLineId; return next; }) })}><option value="">End conversation</option>{conversation.lines.filter((item) => item.id !== line.id).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
        <ConditionField value={line.condition} world={world} onChange={(condition) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => { if (i !== lineIndex) return item; const next = { ...item }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; return next; }) })} />
        <h4>Dialogue options</h4>
        <CollectionBrowser name="Options" items={line.options ?? []} title={option => sourceLabel(option.text) || option.id} summary={option => option.id}
          addLabel="Add option" onAdd={() => { const option: DialogueOption = { id: uid(), text: { kind: 'literal', text: 'New option' }, effects: [] }; updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: [...(item.options ?? []), option] } : item) }); }}
          renderEditor={(option, optionIndex) => <fieldset style={fieldStyle}><legend>Option: {option.id}</legend>
          <TextSourceField label="Option text" value={option.text} onChange={(text) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, text } : value) } : item) })} />
          <ConditionField value={option.condition} world={world} onChange={(condition) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => { if (j !== optionIndex) return value; const next = { ...value }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; return next; }) } : item) })} />
          <label>When unavailable <select value={option.falsePolicy ?? 'hide'} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, falsePolicy: event.target.value as 'hide' | 'disable' } : value) } : item) })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
          {option.falsePolicy === 'disable' && <TextSourceField label="Disabled reason" value={option.disabledReason ?? { kind: 'literal', text: '' }} onChange={(disabledReason) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, disabledReason } : value) } : item) })} />}
          <label>Next line <select value={option.nextLineId ?? ''} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => { if (j !== optionIndex) return value; const next = { ...value }; if (event.target.value) next.nextLineId = event.target.value; else delete (next as { nextLineId?: string }).nextLineId; return next; }) } : item) })}><option value="">Use line continuation</option>{conversation.lines.filter((item) => item.id !== line.id).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
          <EffectList effects={option.effects} world={world} onChange={(effects) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, effects } : value) } : item) })} />
          <button type="button" onClick={() => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).filter((_value, j) => j !== optionIndex) } : item) })}>Remove option</button>
        </fieldset>} />
        <button type="button" onClick={() => updateConversation(index, { ...conversation, lines: conversation.lines.filter((_item, i) => i !== lineIndex), entryLineId: conversation.entryLineId === line.id ? (conversation.lines.find((item) => item.id !== line.id)?.id ?? '') : conversation.entryLineId })}>Remove line</button>
      </fieldset>} />
      <button type="button" onClick={() => onChange(world.conversations.filter((_item, i) => i !== index))}>Remove conversation</button>
    </fieldset>} />
  </section>;
}

function EventActorEditors({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  return <section><div className="apprentice-section-title"><h2>Actors and events</h2><HelpTip label="Actors and events">Actors are people or objects with state. Events let actions and rules communicate.</HelpTip></div>
    <h3>Actor types</h3><CollectionBrowser name="Actor types" items={world.entityDefinitions} title={definition => sourceLabel(definition.name) || definition.id} summary={definition => definition.id}
      addLabel="Add actor type" onAdd={() => onWorldChange({ ...world, entityDefinitions: [...world.entityDefinitions, { id: uid(), name: { kind: 'literal', text: 'Actor type' }, fields: [], allowedTags: [] }] })}
      renderEditor={(definition, index) => <fieldset style={fieldStyle}><legend>{definition.id}</legend>
      <label>Definition ID <input value={definition.id} onChange={(event) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label>
      <TextSourceField label="Actor type name" value={definition.name} onChange={(name) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, name } : item) })} />
      <StateFieldsEditor fields={definition.fields} onChange={(fields) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, fields } : item) })} />
      <label>Allowed tags <input style={inputStyle} value={definition.allowedTags.join(', ')} onChange={(event) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, allowedTags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) } : item) })} /></label>
    </fieldset>} />
    <h3>Actor instances</h3><CollectionBrowser name="Actor instances" items={world.entities} title={entity => sourceLabel(entity.name) || entity.id} summary={entity => entity.id}
      addLabel="Add actor" addDisabled={!world.entityDefinitions.length} onAdd={() => { const definition = world.entityDefinitions[0]; if (!definition) return; const actor: EntityInstance = { id: uid(), definitionId: definition.id, name: { kind: 'literal', text: 'New actor' }, tags: [], state: {} }; onWorldChange({ ...world, entities: [...world.entities, actor] }); }}
      renderEditor={(entity, index) => <fieldset style={fieldStyle}><legend>{sourceLabel(entity.name) || entity.id}</legend>
      <label>Actor ID <input value={entity.id} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label>
      <label>Type <select value={entity.definitionId} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, definitionId: event.target.value } : item) })}><option value="">Choose type</option>{world.entityDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{sourceLabel(definition.name)}</option>)}</select></label>
      <TextSourceField label="Actor name" value={entity.name} onChange={(name) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, name } : item) })} />
      <label>Tags <input value={entity.tags.join(', ')} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) } : item) })} /></label>
      <fieldset style={fieldStyle}><legend>Actor state</legend>{world.entityDefinitions.find((definition) => definition.id === entity.definitionId)?.fields.map((field) => <ScalarField key={field.key} label={`${field.key} (default ${String(field.defaultValue)})`} value={entity.state[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={(value) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, state: { ...item.state, [field.key]: value } } : item) })} />)}</fieldset>
    </fieldset>} />
    <h3>Events</h3><CollectionBrowser name="Events" items={world.eventDefinitions} title={definition => definition.id} summary={definition => `${definition.payloadFields.length} payload fields`}
      addLabel="Add event" onAdd={() => onWorldChange({ ...world, eventDefinitions: [...world.eventDefinitions, { id: uid(), payloadFields: [] }] })}
      renderEditor={(definition, index) => <fieldset style={fieldStyle}><legend>{definition.id}</legend><label>Event ID <input value={definition.id} onChange={(event) => onWorldChange({ ...world, eventDefinitions: world.eventDefinitions.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label><StateFieldsEditor fields={definition.payloadFields} onChange={(payloadFields) => onWorldChange({ ...world, eventDefinitions: world.eventDefinitions.map((item, i) => i === index ? { ...item, payloadFields } : item) })} /></fieldset>} />
  </section>;
}

function InventoryEditor({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  return <section><div className="apprentice-section-title"><h2>Inventory</h2><HelpTip label="Inventory">Define items here, then use action effects to give, remove, or use them.</HelpTip></div>
    <CollectionBrowser name="Item definitions" items={world.itemDefinitions} title={item => sourceLabel(item.name) || item.id} summary={item => item.id}
      addLabel="Add item definition" onAdd={() => onWorldChange({ ...world, itemDefinitions: [...world.itemDefinitions, { id: uid(), name: { kind: 'literal', text: 'New item' }, stackLimit: 1, canContain: false, fields: [] }] })}
      renderEditor={(item, index) => <fieldset style={fieldStyle}><legend>{sourceLabel(item.name) || item.id}</legend>
      <label>Item ID <input value={item.id} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, id: event.target.value } : value) })} /></label>
      <TextSourceField label="Item name" value={item.name} onChange={(name) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, name } : value) })} />
      <label>Stack limit <input type="number" min="1" value={item.stackLimit} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, stackLimit: Number(event.target.value) } : value) })} /></label>
      <label><input type="checkbox" checked={item.canContain} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, canContain: event.target.checked } : value) })} /> Can contain items</label>
      <label>Use event <select value={item.useEventId ?? ''} onChange={(event) => { const next = { ...item }; if (event.target.value) next.useEventId = event.target.value; else delete (next as { useEventId?: string }).useEventId; onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? next : value) }); }}><option value="">Not usable</option>{world.eventDefinitions.map((event) => <option key={event.id} value={event.id}>{event.id}</option>)}</select></label>
      <label>Equipment slot <input value={item.equipmentSlot ?? ''} onChange={(event) => { const next = { ...item }; if (event.target.value) next.equipmentSlot = event.target.value; else delete (next as { equipmentSlot?: string }).equipmentSlot; onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? next : value) }); }} /></label>
      <StateFieldsEditor fields={item.fields} onChange={(fields) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, fields } : value) })} />
    </fieldset>} />
    <h3>Initial stacks</h3><CollectionBrowser name="Initial stacks" items={world.initialInventory} title={stack => `${stack.quantity} × ${stack.itemId}`} summary={stack => stack.id}
      addLabel="Add initial stock" addDisabled={!world.itemDefinitions.length} onAdd={() => { const item = world.itemDefinitions[0]; if (!item) return; onWorldChange({ ...world, initialInventory: [...world.initialInventory, { id: uid(), owner: { kind: 'world' }, itemId: item.id, quantity: 1, fields: {} }] }); }}
      renderEditor={(stack, index) => <fieldset style={fieldStyle}><legend>{stack.id}</legend>
      <label>Item <select value={stack.itemId} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, itemId: event.target.value } : value) })}>{world.itemDefinitions.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item.name)}</option>)}</select></label>
      <ScopeField value={stack.owner} world={world} onChange={(owner) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, owner } : value) })} />
      <label>Quantity <input type="number" min="1" value={stack.quantity} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, quantity: Number(event.target.value) } : value) })} /></label>
      <label>Container stack <select value={stack.containerStackId ?? ''} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => { if (i !== index) return value; const next = { ...value }; if (event.target.value) next.containerStackId = event.target.value; else delete (next as { containerStackId?: string }).containerStackId; return next; }) })}><option value="">No container</option>{world.initialInventory.filter((value) => value.id !== stack.id && world.itemDefinitions.find((item) => item.id === value.itemId)?.canContain).map((value) => <option key={value.id} value={value.id}>{value.id}</option>)}</select></label>
      {world.itemDefinitions.find((item) => item.id === stack.itemId)?.fields.map((field) => <ScalarField key={field.key} label={`Stack field: ${field.key}`} value={stack.fields[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={(value) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((entry, i) => i === index ? { ...entry, fields: { ...entry.fields, [field.key]: value } } : entry) })} />)}
      <button type="button" onClick={() => onWorldChange({ ...world, initialInventory: world.initialInventory.filter((_value, i) => i !== index) })}>Remove stack</button>
    </fieldset>} />
  </section>;
}

function TimeEditor({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  const time = world.settings.time;
  const change = (patch: Partial<typeof time>) => onWorldChange({ ...world, settings: { ...world.settings, time: { ...time, ...patch } } });
  return <section><div className="apprentice-section-title"><h2>Time</h2><HelpTip label="Time">Choose how the game clock advances. Per-action time is simplest for a first story.</HelpTip></div>
    <label>Clock mode <select value={time.mode} onChange={(event) => change({ mode: event.target.value as typeof time.mode })}><option value="per-action">Per action</option><option value="elapsed">Elapsed time</option></select></label>
    {time.mode === 'per-action' && <label>Milliseconds per action <input type="number" min="0" value={time.millisecondsPerAction ?? 0} onChange={(event) => change({ millisecondsPerAction: Number(event.target.value) })} /></label>}
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

function TranslationEditor({ world, locales, defaultLocale, onLocalesChange }: Pick<ApprenticeFormsProps, 'world' | 'locales' | 'defaultLocale' | 'onLocalesChange'>) {
  const [language, setLanguage] = useState(defaultLocale ?? '');
  const [selectedKey, setSelectedKey] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'missing' | 'used' | 'unused'>('all');
  const [page, setPage] = useState(0);
  const [newLanguage, setNewLanguage] = useState('');
  const [firstTranslation, setFirstTranslation] = useState('');
  const documents = locales ?? [];
  const activeDocument = documents.find(document => document.locale === language)
    ?? documents.find(document => document.locale === defaultLocale)
    ?? documents[0];
  const referenced = useMemo(() => referencedLocaleKeys(world), [world]);
  const keys = [...new Set([...referenced, ...documents.flatMap(document => Object.keys(document.strings))])].sort((a, b) => a.localeCompare(b));
  const activeKey = keys.includes(selectedKey) ? selectedKey : keys[0];
  const visibleKeys = keys.filter(key => key.toLowerCase().includes(search.trim().toLowerCase()) && (
    filter === 'all' || filter === 'missing' && activeDocument?.strings[key] === undefined ||
    filter === 'used' && referenced.has(key) || filter === 'unused' && !referenced.has(key)
  ));
  const pageCount = Math.max(1, Math.ceil(visibleKeys.length / 40));
  const visiblePage = Math.min(page, pageCount - 1);
  const newTag = newLanguage.trim();
  const canAddLanguage = !!activeDocument && !!activeKey && !!firstTranslation.trim() && !!onLocalesChange && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(newTag)
    && !documents.some(document => document.locale.toLowerCase() === newTag.toLowerCase());
  const updateText = (text: string) => {
    if (!activeDocument || !activeKey || !onLocalesChange) return;
    onLocalesChange(documents.map(document => document.locale === activeDocument.locale
      ? { ...document, strings: { ...document.strings, [activeKey]: text } } : document));
  };
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
        if (!activeDocument || !onLocalesChange) return;
        onLocalesChange([...documents, { format: 'dungeon-scrivener-locale', schemaVersion: 1, locale: newTag, strings: { [activeKey!]: firstTranslation } }]);
        setLanguage(newTag);
        setNewLanguage('');
        setFirstTranslation('');
      }}>Add language</button>
    </div>
    <p className="apprentice-translations__hint">Add one genuine translation to start a language. Missing keys fall back to the project’s default language.</p>
    {!activeDocument && <p role="status">This project has no language file. Add one in Sage before editing translations here.</p>}
    {activeDocument && <>
      <div className="apprentice-translations__filters"><label>Find a key <input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Search scene, choice, or dialogue keys" /></label>
        <label>Show <select aria-label="Translation key filter" value={filter} onChange={event => { setFilter(event.target.value as typeof filter); setPage(0); }}><option value="all">All keys</option><option value="missing">Needs text</option><option value="used">In use</option><option value="unused">Unused</option></select></label></div>
      <div className="apprentice-translations__keys" aria-label="Translation keys">
        {visibleKeys.slice(visiblePage * 40, (visiblePage + 1) * 40).map(key => <button key={key} type="button" className={key === activeKey ? 'is-selected' : ''} aria-pressed={key === activeKey} onClick={() => setSelectedKey(key)}>
          <span>{key}</span><small>{activeDocument.strings[key] === undefined ? 'Needs text' : referenced.has(key) ? 'In use' : 'Saved'}</small>
        </button>)}
        {!visibleKeys.length && <p>{keys.length ? 'No keys match this search.' : 'Use a locale key in a scene or action to list it here.'}</p>}
      </div>
      {visibleKeys.length > 40 && <div className="apprentice-collection__pages"><button type="button" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Previous</button><span>{visiblePage * 40 + 1}–{Math.min((visiblePage + 1) * 40, visibleKeys.length)} of {visibleKeys.length}</span><button type="button" disabled={visiblePage === pageCount - 1} onClick={() => setPage(visiblePage + 1)}>Next</button></div>}
      {activeKey && <div className="apprentice-translations__editor">
        <div><strong>{activeKey}</strong><span>{referenced.has(activeKey) ? 'Used by the game' : 'Saved in the language file'}</span></div>
        <label>Text for {activeDocument.locale}<textarea aria-label={`Translation text for ${activeKey} (${activeDocument.locale})`} rows={10}
          value={activeDocument.strings[activeKey] ?? ''} onChange={event => updateText(event.target.value)} /></label>
        {activeDocument.strings[activeKey] === undefined && <p role="status">This key has no text in {activeDocument.locale}. Enter its translation here.</p>}
      </div>}
    </>}
  </section>;
}

export function ApprenticeForms({ world, view = 'all', selectedNodeId, onWorldChange, project, locales, defaultLocale, assets, mediaAssets, onLocalesChange, onImportAsset }: ApprenticeFormsProps) {
  const [worldSection, setWorldSection] = useState<'translations' | 'theme' | 'defaults' | 'state' | 'rules' | 'dialogue' | 'actors' | 'inventory' | 'time'>('translations');
  const node = useMemo(() => world.nodes.find((candidate) => candidate.id === selectedNodeId), [world, selectedNodeId]);
  const updateNode = (next: NodeDefinition) => onWorldChange(updateNodeDefinition(world, next.id, () => next) ?? world);
  const contentSettings: ContentSettings = { project, locales, defaultLocale, assets, mediaAssets, onLocalesChange, onImportAsset };
  return <div className={view === 'world' ? 'apprentice-world-form' : undefined} aria-label="Apprentice forms" style={{ display: 'grid', gap: 18, padding: 16, overflow: 'auto' }}>
    {view !== 'world' && (node ? <NodeEditor world={world} node={node} onChange={updateNode} contentSettings={contentSettings} /> : <p>Select a node to edit its content and actions.</p>)}
    {view !== 'scene' && <>
    <nav className="apprentice-world-directory" aria-label="World sections">
      {([
        ['translations', 'Translations', (locales ?? []).reduce((count, locale) => count + Object.keys(locale.strings).length, 0)],
        ['state', 'State', world.stateDefinitions.length], ['defaults', 'Action defaults', world.actionDefaults.choices.length + world.actionDefaults.commands.length],
        ['rules', 'Rules', world.rules.length], ['dialogue', 'Dialogue', world.conversations.length],
        ['actors', 'Actors & events', world.entities.length + world.entityDefinitions.length + world.eventDefinitions.length],
        ['inventory', 'Inventory', world.itemDefinitions.length + world.initialInventory.length],
        ['theme', 'Theme & sounds', world.settings.typingSounds?.mappings.length ?? 0], ['time', 'Time', 0],
      ] as const).map(([id, label, count]) => <button key={id} type="button" aria-current={worldSection === id ? 'page' : undefined} onClick={() => setWorldSection(id)}>
        <span>{label}</span>{count > 0 && <small>{count}</small>}
      </button>)}
    </nav>
    {worldSection === 'translations' && <TranslationEditor world={world} locales={locales} defaultLocale={defaultLocale} onLocalesChange={onLocalesChange} />}
    {worldSection === 'theme' && <ApprenticeAuthorSettings world={world} project={project} assets={assets} onWorldChange={onWorldChange} />}
    {worldSection === 'defaults' && <section><div className="apprentice-section-title"><h2>Game action defaults</h2><HelpTip label="Game action defaults">These actions can be inherited by scenes. Use scene actions for choices that belong to only one scene.</HelpTip></div><p>Nodes may inherit these choices and commands independently.</p><ActionEditors actions={world.actionDefaults} world={world} onChange={(actionDefaults) => onWorldChange({ ...world, actionDefaults })} /></section>}
    {worldSection === 'state' && <WorldStateEditor world={world} onWorldChange={onWorldChange} />}
    {worldSection === 'rules' && <RuleEditor world={world} onChange={(rules) => onWorldChange({ ...world, rules })} />}
    {worldSection === 'dialogue' && <ConversationEditor world={world} onChange={(conversations) => onWorldChange({ ...world, conversations })} />}
    {worldSection === 'actors' && <EventActorEditors world={world} onWorldChange={onWorldChange} />}
    {worldSection === 'inventory' && <InventoryEditor world={world} onWorldChange={onWorldChange} />}
    {worldSection === 'time' && <TimeEditor world={world} onWorldChange={onWorldChange} />}
    </>}
  </div>;
}
