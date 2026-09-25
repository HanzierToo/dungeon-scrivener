import { useMemo } from 'react';
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

const uid = () => crypto.randomUUID();
const fieldStyle = { display: 'grid', gap: 4, margin: '8px 0' } as const;
const inputStyle = { maxWidth: 480, width: '100%' } as const;

function TextSourceField({ label, value, onChange }: { label: string; value: TextSource; onChange: (next: TextSource) => void }) {
  return <fieldset style={fieldStyle}><legend>{label}</legend>
    <label>Text source <select value={value.kind} onChange={(event) => onChange(event.target.value === 'literal' ? { kind: 'literal', text: '' } : { kind: 'locale-key', key: '' })}>
      <option value="literal">Literal text</option><option value="locale-key">Locale key</option>
    </select></label>
    <label>{value.kind === 'literal' ? 'Text' : 'Locale key'} <input style={inputStyle} value={value.kind === 'literal' ? value.text : value.key} onChange={(event) => onChange(value.kind === 'literal' ? { kind: 'literal', text: event.target.value } : { kind: 'locale-key', key: event.target.value })} /></label>
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

function StateFieldsEditor({ fields, onChange, allowAdd = true }: { fields: readonly StateFieldDefinition[]; onChange: (fields: readonly StateFieldDefinition[]) => void; allowAdd?: boolean }) {
  return <fieldset style={fieldStyle}><legend>State fields</legend>
    {fields.map((field, index) => <div key={`${field.key}-${index}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
      <label>Key <input value={field.key} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} /></label>
      <label>Type <select value={typeof field.valueType === 'string' ? field.valueType : 'enum'} onChange={(event) => {
        const kind = event.target.value;
        const valueType = kind === 'enum' ? { kind: 'enum' as const, values: [] } : kind as 'string' | 'number' | 'integer' | 'boolean';
        const defaultValue: Scalar = kind === 'boolean' ? false : kind === 'number' || kind === 'integer' ? 0 : '';
        onChange(fields.map((item, i) => i === index ? { ...item, valueType, defaultValue } : item));
      }}><option value="string">Text</option><option value="number">Number</option><option value="integer">Integer</option><option value="boolean">Boolean</option><option value="enum">Enum</option></select></label>
      {typeof field.valueType !== 'string' && <label>Allowed values <input value={field.valueType.values.join(', ')} onChange={(event) => onChange(fields.map((item, i) => i === index && typeof item.valueType !== 'string' ? { ...item, valueType: { ...item.valueType, values: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } } : item))} /></label>}
      <label>Default {typeof field.defaultValue === 'boolean' ? <select value={String(field.defaultValue)} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, defaultValue: event.target.value === 'true' } : item))}><option value="false">false</option><option value="true">true</option></select> : <input type={typeof field.defaultValue === 'number' ? 'number' : 'text'} value={field.defaultValue} onChange={(event) => onChange(fields.map((item, i) => i === index ? { ...item, defaultValue: typeof item.defaultValue === 'number' ? Number(event.target.value) : event.target.value } : item))} />}</label>
      <button type="button" onClick={() => onChange(fields.filter((_item, i) => i !== index))}>Remove field</button>
    </div>)}
    {allowAdd && <button type="button" onClick={() => onChange([...fields, { key: uid(), valueType: 'string', defaultValue: '' }])}>Add state field</button>}
  </fieldset>;
}

function WorldStateEditor({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  return <section><h2>State definitions</h2>
    {world.stateDefinitions.map((field, index) => <fieldset key={`${field.key}-${index}`} style={fieldStyle}><legend>{field.key}</legend>
      <label>Key <input value={field.key} onChange={(event) => onWorldChange({ ...world, stateDefinitions: world.stateDefinitions.map((item, i) => i === index ? { ...item, key: event.target.value } : item) })} /></label>
      <label>Scope <select value={field.scopeKind} onChange={(event) => onWorldChange({ ...world, stateDefinitions: world.stateDefinitions.map((item, i) => i === index ? { ...item, scopeKind: event.target.value as 'world' | 'node' } : item) })}><option value="world">World</option><option value="node">Node</option></select></label>
      <StateFieldsEditor fields={[field]} allowAdd={false} onChange={(fields) => { const next = fields[0]; if (next) onWorldChange({ ...world, stateDefinitions: world.stateDefinitions.map((item, i) => i === index ? { ...next, scopeKind: field.scopeKind } : item) }); }} />
      <button type="button" onClick={() => onWorldChange({ ...world, stateDefinitions: world.stateDefinitions.filter((_item, i) => i !== index) })}>Remove definition</button>
    </fieldset>)}
    <button type="button" onClick={() => onWorldChange({ ...world, stateDefinitions: [...world.stateDefinitions, { key: uid(), scopeKind: 'world', valueType: 'integer', defaultValue: 0 }] })}>Add world state</button>
  </section>;
}

function StateReferenceFields({ value, onChange, world }: { value: StateReference; onChange: (next: StateReference) => void; world: WorldDocument }) {
  const scope = value.scope;
  const definitions = scope.kind === 'entity'
    ? world.entityDefinitions.find((definition) => definition.id === world.entities.find((entity) => entity.id === scope.ownerId)?.definitionId)?.fields ?? []
    : world.stateDefinitions.filter((definition) => definition.scopeKind === scope.kind);
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    <ScopeField value={value.scope} world={world} onChange={(scope) => onChange({ ...value, scope })} />
    <label>State key <select value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })}>
      <option value="">Choose a key</option>{definitions.map((definition) => <option key={definition.key} value={definition.key}>{definition.key}</option>)}
    </select></label>
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
  return <fieldset style={fieldStyle}><legend>{label}</legend>
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
  return <fieldset style={fieldStyle}><legend>Effects, in execution order</legend>
    {effects.map((effect, index) => <fieldset key={index} style={fieldStyle}><legend>Effect {index + 1}</legend>
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
      <button type="button" onClick={() => onChange(effects.filter((_item, currentIndex) => currentIndex !== index))}>Remove effect</button>
    </fieldset>)}
    <button type="button" onClick={() => onChange([...effects, emptyEffect()])}>Add effect</button>
  </fieldset>;
}

function ActionEditors({ actions, onChange, world }: { actions: ActionSet; onChange: (actions: ActionSet) => void; world: WorldDocument }) {
  const updateChoice = (index: number, choice: ChoiceDefinition) => onChange({ ...actions, choices: actions.choices.map((item, i) => i === index ? choice : item) });
  const updateCommand = (index: number, command: CommandDefinition) => onChange({ ...actions, commands: actions.commands.map((item, i) => i === index ? command : item) });
  return <section><h3>Choices and commands</h3>
    {actions.choices.map((choice, index) => <fieldset key={choice.id} style={fieldStyle}><legend>Choice: {choice.id}</legend>
      <TextSourceField label="Choice label" value={choice.label} onChange={(label) => updateChoice(index, { ...choice, label })} />
      <ConditionField value={choice.condition} world={world} onChange={(condition) => { const next = { ...choice }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; updateChoice(index, next); }} />
      <label>When condition is false <select value={choice.falsePolicy ?? 'hide'} onChange={(event) => updateChoice(index, { ...choice, falsePolicy: event.target.value as 'hide' | 'disable' })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
      <label>Navigation link <select value={choice.navigationEdgeId ?? ''} onChange={(event) => { const next = { ...choice }; if (event.target.value) next.navigationEdgeId = event.target.value; else delete (next as { navigationEdgeId?: string }).navigationEdgeId; updateChoice(index, next); }}><option value="">No navigation</option>{world.navigationEdges.map((edge) => <option key={edge.id} value={edge.id}>{edge.id}</option>)}</select></label>
      <EffectList effects={choice.effects} world={world} onChange={(effects) => updateChoice(index, { ...choice, effects })} />
      <button type="button" onClick={() => onChange({ ...actions, choices: actions.choices.filter((_item, i) => i !== index) })}>Remove choice</button>
    </fieldset>)}
    {actions.commands.map((command, index) => <fieldset key={command.id} style={fieldStyle}><legend>Command: {command.id}</legend>
      <label>Command ID <input value={command.id} onChange={(event) => updateCommand(index, { ...command, id: event.target.value })} /></label>
      <label>Patterns, primary first <input style={inputStyle} value={command.patterns.join(' | ')} onChange={(event) => updateCommand(index, { ...command, patterns: event.target.value.split('|').map((part) => part.trim()) })} /></label>
      <label>Parameters (ID:type; enum values use enum[a|b]) <input style={inputStyle} value={command.parameters.map((parameter) => `${parameter.id}:${typeof parameter.valueType === 'string' ? parameter.valueType : `enum[${parameter.valueType.values.join('|')}]`}`).join(', ')} onChange={(event) => updateCommand(index, { ...command, parameters: event.target.value.split(',').map((part) => { const [id, kind = 'string'] = part.trim().split(':'); const enumValues = /^enum\[(.*)\]$/.exec(kind); const valueType: ValueType = enumValues ? { kind: 'enum', values: enumValues[1] ? enumValues[1].split('|') : [] } : kind === 'number' || kind === 'integer' || kind === 'boolean' ? kind : 'string'; return { id: id ?? '', valueType }; }) })} /></label>
      <ConditionField value={command.condition} world={world} onChange={(condition) => { const next = { ...command }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; updateCommand(index, next); }} />
      <label>When condition is false <select value={command.falsePolicy ?? 'hide'} onChange={(event) => updateCommand(index, { ...command, falsePolicy: event.target.value as 'hide' | 'disable' })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
      <label>Navigation link <select value={command.navigationEdgeId ?? ''} onChange={(event) => { const next = { ...command }; if (event.target.value) next.navigationEdgeId = event.target.value; else delete (next as { navigationEdgeId?: string }).navigationEdgeId; updateCommand(index, next); }}><option value="">No navigation</option>{world.navigationEdges.map((edge) => <option key={edge.id} value={edge.id}>{edge.id}</option>)}</select></label>
      <EffectList effects={command.effects} world={world} onChange={(effects) => updateCommand(index, { ...command, effects })} />
      <button type="button" onClick={() => onChange({ ...actions, commands: actions.commands.filter((_item, i) => i !== index) })}>Remove command</button>
    </fieldset>)}
    <button type="button" onClick={() => onChange({ ...actions, choices: [...actions.choices, { id: uid(), label: { kind: 'literal', text: 'New choice' }, effects: [] }] })}>Add choice</button>
    <button type="button" onClick={() => onChange({ ...actions, commands: [...actions.commands, { id: uid(), patterns: ['new command'], parameters: [], effects: [] }] })}>Add command</button>
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
  return <section><h2>Scene content</h2>
    <TextSourceField label="Title" value={node.title} onChange={(title) => onChange({ ...node, title })} />
    {titleKey !== undefined && defaultTitleLocale && contentSettings.onLocalesChange && <label>Title text ({defaultTitleLocale.locale})
      <input value={defaultTitleLocale.strings[titleKey] ?? ''} onChange={event => contentSettings.onLocalesChange?.((contentSettings.locales ?? []).map(locale => locale.locale === defaultTitleLocale.locale
        ? { ...locale, strings: { ...locale.strings, [titleKey]: event.target.value } } : locale))} />
    </label>}
    <RichContentEditor value={node.content} onChange={(content) => onChange({ ...node, content })} world={world} {...contentSettings} />
    <label><input type="checkbox" checked={node.inheritance?.defaults ?? false} onChange={(event) => onChange({ ...node, inheritance: { defaults: event.target.checked, rules: node.inheritance?.rules ?? false } })} /> Inherit action defaults</label>
    <label><input type="checkbox" checked={node.inheritance?.rules ?? false} onChange={(event) => onChange({ ...node, inheritance: { defaults: node.inheritance?.defaults ?? false, rules: event.target.checked } })} /> Inherit rules</label>
    <fieldset style={fieldStyle}><legend>Node state overrides</legend>{world.stateDefinitions.filter((field) => field.scopeKind === 'node').map((field) => <ScalarField key={field.key} label={`${field.key} (default ${String(field.defaultValue)})`} value={node.state?.[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={(value) => onChange({ ...node, state: { ...node.state, [field.key]: value } })} />)}</fieldset>
    <p>Inherited choices: {inheritedActions.choices.length ? inheritedActions.choices.map((choice) => sourceLabel(choice.label)).join(', ') : 'none'}. {node.actions?.choices === undefined ? 'Using inherited choices.' : `Local choices replace them: ${localChoices.length ? localChoices.map((choice) => sourceLabel(choice.label)).join(', ') : 'none (disabled)'}.`}</p>
    <p>Inherited commands: {inheritedActions.commands.length ? inheritedActions.commands.map((command) => command.patterns[0]).join(', ') : 'none'}. {node.actions?.commands === undefined ? 'Using inherited commands.' : `Local commands replace them: ${localCommands.length ? localCommands.map((command) => command.patterns[0]).join(', ') : 'none (disabled)'}.`}</p>
    <fieldset style={fieldStyle}><legend>Rules on this node</legend><p>Inherited rules: {inheritedRules.map((rule) => `${rule.id} (priority ${rule.priority})`).join(', ') || 'none'}</p>{world.rules.map((rule) => <label key={rule.id} style={{ display: 'block' }}><input type="checkbox" checked={(node.ruleIds ?? []).includes(rule.id)} onChange={(event) => onChange({ ...node, ruleIds: event.target.checked ? [...(node.ruleIds ?? []), rule.id] : (node.ruleIds ?? []).filter((id) => id !== rule.id) })} /> {rule.id} (priority {rule.priority})</label>)}</fieldset>
    <ActionEditors actions={{ choices: localChoices, commands: localCommands }} world={world} onChange={(actions) => {
      const nextActions = { ...node.actions };
      if (actions.choices !== localChoices) nextActions.choices = actions.choices;
      if (actions.commands !== localCommands) nextActions.commands = actions.commands;
      onChange({ ...node, actions: nextActions });
    }} />
  </section>;
}

function RuleEditor({ world, onChange }: { world: WorldDocument; onChange: (rules: readonly RuleDefinition[]) => void }) {
  const update = (index: number, rule: RuleDefinition) => onChange(world.rules.map((item, i) => i === index ? rule : item));
  return <section><h2>Rules</h2>
    {world.rules.map((rule, index) => <fieldset key={rule.id} style={fieldStyle}><legend>{rule.id}</legend>
      <label>Rule ID <input value={rule.id} onChange={(event) => update(index, { ...rule, id: event.target.value })} /></label>
      <label>Trigger <select value={rule.trigger.kind === 'event' ? `event:${rule.trigger.eventId}` : `phase:${rule.trigger.phase}`} onChange={(event) => {
        const [kind, value] = event.target.value.split(':');
        update(index, { ...rule, trigger: kind === 'event' ? { kind: 'event', eventId: value ?? '' } : { kind: 'phase', phase: (value ?? 'action-start') as Extract<RuleDefinition['trigger'], { kind: 'phase' }>['phase'] } });
      }}><optgroup label="Events">{world.eventDefinitions.map((event) => <option key={event.id} value={`event:${event.id}`}>{event.id}</option>)}</optgroup><optgroup label="Phases">{['action-start','node-entry','node-revisit','node-exit','time-advanced'].map((phase) => <option key={phase} value={`phase:${phase}`}>{phase}</option>)}</optgroup></select></label>
      <label>Priority <input type="number" value={rule.priority} onChange={(event) => update(index, { ...rule, priority: Number(event.target.value) })} /></label>
      <ConditionField value={rule.condition} world={world} onChange={(condition) => { const next = { ...rule }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; update(index, next); }} />
      <EffectList effects={rule.effects} world={world} onChange={(effects) => update(index, { ...rule, effects })} />
      <button type="button" onClick={() => onChange(world.rules.filter((_item, i) => i !== index))}>Remove rule</button>
    </fieldset>)}
    <button type="button" onClick={() => onChange([...world.rules, { id: uid(), trigger: { kind: 'phase', phase: 'action-start' }, priority: 0, effects: [] }])}>Add rule</button>
    <p>Rules run by descending priority; equal priorities retain authored order. Inherited rules run parent before child.</p>
  </section>;
}

function ConversationEditor({ world, onChange }: { world: WorldDocument; onChange: (conversations: readonly ConversationDefinition[]) => void }) {
  const updateConversation = (index: number, value: ConversationDefinition) => onChange(world.conversations.map((conversation, i) => i === index ? value : conversation));
  return <section><h2>Dialogue</h2>
    {world.conversations.map((conversation, index) => <fieldset key={conversation.id} style={fieldStyle}><legend>Conversation: {conversation.id}</legend>
      <label>ID <input value={conversation.id} onChange={(event) => updateConversation(index, { ...conversation, id: event.target.value })} /></label>
      <label>Entry line <select value={conversation.entryLineId} onChange={(event) => updateConversation(index, { ...conversation, entryLineId: event.target.value })}>{conversation.lines.map((line) => <option key={line.id} value={line.id}>{line.id}</option>)}</select></label>
      <label><input type="checkbox" checked={conversation.interruptible} onChange={(event) => updateConversation(index, { ...conversation, interruptible: event.target.checked })} /> Can be interrupted</label>
      <label><input type="checkbox" checked={conversation.resumeOnReturn} onChange={(event) => updateConversation(index, { ...conversation, resumeOnReturn: event.target.checked })} /> Resume when returning to the node</label>
      <label>Participants <select multiple value={[...conversation.participantEntityIds]} onChange={(event) => updateConversation(index, { ...conversation, participantEntityIds: [...event.target.selectedOptions].map((option) => option.value) })}>{world.entities.map((actor) => <option key={actor.id} value={actor.id}>{sourceLabel(actor.name)}</option>)}</select></label>
      {conversation.lines.map((line, lineIndex) => <fieldset key={line.id} style={fieldStyle}><legend>Line: {line.id}</legend>
        <label>Speaker <select value={line.speakerEntityId} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, speakerEntityId: event.target.value } : item) })}><option value="">Choose actor</option>{world.entities.map((actor) => <option key={actor.id} value={actor.id}>{sourceLabel(actor.name)}</option>)}</select></label>
        <TextSourceField label="Line text" value={line.text} onChange={(text) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, text } : item) })} />
        <label>Next line <select value={line.nextLineId ?? ''} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => { if (i !== lineIndex) return item; const next = { ...item }; if (event.target.value) next.nextLineId = event.target.value; else delete (next as { nextLineId?: string }).nextLineId; return next; }) })}><option value="">End conversation</option>{conversation.lines.filter((item) => item.id !== line.id).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
        <ConditionField value={line.condition} world={world} onChange={(condition) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => { if (i !== lineIndex) return item; const next = { ...item }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; return next; }) })} />
        <h4>Dialogue options</h4>
        {(line.options ?? []).map((option, optionIndex) => <fieldset key={option.id} style={fieldStyle}><legend>Option: {option.id}</legend>
          <TextSourceField label="Option text" value={option.text} onChange={(text) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, text } : value) } : item) })} />
          <ConditionField value={option.condition} world={world} onChange={(condition) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => { if (j !== optionIndex) return value; const next = { ...value }; if (condition) next.condition = condition; else delete (next as { condition?: Condition }).condition; return next; }) } : item) })} />
          <label>When unavailable <select value={option.falsePolicy ?? 'hide'} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, falsePolicy: event.target.value as 'hide' | 'disable' } : value) } : item) })}><option value="hide">Hide</option><option value="disable">Show disabled</option></select></label>
          {option.falsePolicy === 'disable' && <TextSourceField label="Disabled reason" value={option.disabledReason ?? { kind: 'literal', text: '' }} onChange={(disabledReason) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, disabledReason } : value) } : item) })} />}
          <label>Next line <select value={option.nextLineId ?? ''} onChange={(event) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => { if (j !== optionIndex) return value; const next = { ...value }; if (event.target.value) next.nextLineId = event.target.value; else delete (next as { nextLineId?: string }).nextLineId; return next; }) } : item) })}><option value="">Use line continuation</option>{conversation.lines.filter((item) => item.id !== line.id).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
          <EffectList effects={option.effects} world={world} onChange={(effects) => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).map((value, j) => j === optionIndex ? { ...value, effects } : value) } : item) })} />
          <button type="button" onClick={() => updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: (item.options ?? []).filter((_value, j) => j !== optionIndex) } : item) })}>Remove option</button>
        </fieldset>)}
        <button type="button" onClick={() => { const option: DialogueOption = { id: uid(), text: { kind: 'literal', text: 'New option' }, effects: [] }; updateConversation(index, { ...conversation, lines: conversation.lines.map((item, i) => i === lineIndex ? { ...item, options: [...(item.options ?? []), option] } : item) }); }}>Add option</button>
        <button type="button" onClick={() => updateConversation(index, { ...conversation, lines: conversation.lines.filter((_item, i) => i !== lineIndex), entryLineId: conversation.entryLineId === line.id ? (conversation.lines.find((item) => item.id !== line.id)?.id ?? '') : conversation.entryLineId })}>Remove line</button>
      </fieldset>)}
      <button type="button" onClick={() => { const line: DialogueLine = { id: uid(), speakerEntityId: conversation.participantEntityIds[0] ?? '', text: { kind: 'literal', text: 'New dialogue line' } }; updateConversation(index, { ...conversation, lines: [...conversation.lines, line] }); }}>Add line</button>
      <button type="button" onClick={() => onChange(world.conversations.filter((_item, i) => i !== index))}>Remove conversation</button>
    </fieldset>)}
    <button type="button" onClick={() => { const lineId = uid(); onChange([...world.conversations, { id: uid(), participantEntityIds: [], entryLineId: lineId, interruptible: true, resumeOnReturn: true, lines: [{ id: lineId, speakerEntityId: '', text: { kind: 'literal', text: 'New dialogue line' } }] }]); }}>Add conversation</button>
  </section>;
}

function EventActorEditors({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  return <section><h2>Actors and events</h2>
    <h3>Actors</h3>{world.entityDefinitions.map((definition, index) => <fieldset key={definition.id} style={fieldStyle}><legend>{definition.id}</legend>
      <label>Definition ID <input value={definition.id} onChange={(event) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label>
      <TextSourceField label="Actor type name" value={definition.name} onChange={(name) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, name } : item) })} />
      <StateFieldsEditor fields={definition.fields} onChange={(fields) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, fields } : item) })} />
      <label>Allowed tags <input style={inputStyle} value={definition.allowedTags.join(', ')} onChange={(event) => onWorldChange({ ...world, entityDefinitions: world.entityDefinitions.map((item, i) => i === index ? { ...item, allowedTags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) } : item) })} /></label>
    </fieldset>)}
    <button type="button" onClick={() => onWorldChange({ ...world, entityDefinitions: [...world.entityDefinitions, { id: uid(), name: { kind: 'literal', text: 'Actor type' }, fields: [], allowedTags: [] }] })}>Add actor type</button>
    <h3>Actor instances</h3>{world.entities.map((entity, index) => <fieldset key={entity.id} style={fieldStyle}><legend>{sourceLabel(entity.name) || entity.id}</legend>
      <label>Actor ID <input value={entity.id} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label>
      <label>Type <select value={entity.definitionId} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, definitionId: event.target.value } : item) })}><option value="">Choose type</option>{world.entityDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{sourceLabel(definition.name)}</option>)}</select></label>
      <TextSourceField label="Actor name" value={entity.name} onChange={(name) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, name } : item) })} />
      <label>Tags <input value={entity.tags.join(', ')} onChange={(event) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) } : item) })} /></label>
      <fieldset style={fieldStyle}><legend>Actor state</legend>{world.entityDefinitions.find((definition) => definition.id === entity.definitionId)?.fields.map((field) => <ScalarField key={field.key} label={`${field.key} (default ${String(field.defaultValue)})`} value={entity.state[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={(value) => onWorldChange({ ...world, entities: world.entities.map((item, i) => i === index ? { ...item, state: { ...item.state, [field.key]: value } } : item) })} />)}</fieldset>
    </fieldset>)}
    <button type="button" disabled={!world.entityDefinitions.length} onClick={() => { const definition = world.entityDefinitions[0]; if (!definition) return; const actor: EntityInstance = { id: uid(), definitionId: definition.id, name: { kind: 'literal', text: 'New actor' }, tags: [], state: {} }; onWorldChange({ ...world, entities: [...world.entities, actor] }); }}>Add actor</button>
    <h3>Events</h3>{world.eventDefinitions.map((definition, index) => <fieldset key={definition.id} style={fieldStyle}><legend>{definition.id}</legend><label>Event ID <input value={definition.id} onChange={(event) => onWorldChange({ ...world, eventDefinitions: world.eventDefinitions.map((item, i) => i === index ? { ...item, id: event.target.value } : item) })} /></label><StateFieldsEditor fields={definition.payloadFields} onChange={(payloadFields) => onWorldChange({ ...world, eventDefinitions: world.eventDefinitions.map((item, i) => i === index ? { ...item, payloadFields } : item) })} /></fieldset>)}
    <button type="button" onClick={() => onWorldChange({ ...world, eventDefinitions: [...world.eventDefinitions, { id: uid(), payloadFields: [] }] })}>Add event</button>
  </section>;
}

function InventoryEditor({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  return <section><h2>Inventory</h2>
    {world.itemDefinitions.map((item, index) => <fieldset key={item.id} style={fieldStyle}><legend>{sourceLabel(item.name) || item.id}</legend>
      <label>Item ID <input value={item.id} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, id: event.target.value } : value) })} /></label>
      <TextSourceField label="Item name" value={item.name} onChange={(name) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, name } : value) })} />
      <label>Stack limit <input type="number" min="1" value={item.stackLimit} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, stackLimit: Number(event.target.value) } : value) })} /></label>
      <label><input type="checkbox" checked={item.canContain} onChange={(event) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, canContain: event.target.checked } : value) })} /> Can contain items</label>
      <label>Use event <select value={item.useEventId ?? ''} onChange={(event) => { const next = { ...item }; if (event.target.value) next.useEventId = event.target.value; else delete (next as { useEventId?: string }).useEventId; onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? next : value) }); }}><option value="">Not usable</option>{world.eventDefinitions.map((event) => <option key={event.id} value={event.id}>{event.id}</option>)}</select></label>
      <label>Equipment slot <input value={item.equipmentSlot ?? ''} onChange={(event) => { const next = { ...item }; if (event.target.value) next.equipmentSlot = event.target.value; else delete (next as { equipmentSlot?: string }).equipmentSlot; onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? next : value) }); }} /></label>
      <StateFieldsEditor fields={item.fields} onChange={(fields) => onWorldChange({ ...world, itemDefinitions: world.itemDefinitions.map((value, i) => i === index ? { ...value, fields } : value) })} />
    </fieldset>)}
    <button type="button" onClick={() => onWorldChange({ ...world, itemDefinitions: [...world.itemDefinitions, { id: uid(), name: { kind: 'literal', text: 'New item' }, stackLimit: 1, canContain: false, fields: [] }] })}>Add item definition</button>
    <button type="button" disabled={!world.itemDefinitions.length} onClick={() => { const item = world.itemDefinitions[0]; if (!item) return; onWorldChange({ ...world, initialInventory: [...world.initialInventory, { id: uid(), owner: { kind: 'world' }, itemId: item.id, quantity: 1, fields: {} }] }); }}>Add initial stock</button>
    <h3>Initial stacks</h3>{world.initialInventory.map((stack, index) => <fieldset key={stack.id} style={fieldStyle}><legend>{stack.id}</legend>
      <label>Item <select value={stack.itemId} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, itemId: event.target.value } : value) })}>{world.itemDefinitions.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item.name)}</option>)}</select></label>
      <ScopeField value={stack.owner} world={world} onChange={(owner) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, owner } : value) })} />
      <label>Quantity <input type="number" min="1" value={stack.quantity} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => i === index ? { ...value, quantity: Number(event.target.value) } : value) })} /></label>
      <label>Container stack <select value={stack.containerStackId ?? ''} onChange={(event) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((value, i) => { if (i !== index) return value; const next = { ...value }; if (event.target.value) next.containerStackId = event.target.value; else delete (next as { containerStackId?: string }).containerStackId; return next; }) })}><option value="">No container</option>{world.initialInventory.filter((value) => value.id !== stack.id && world.itemDefinitions.find((item) => item.id === value.itemId)?.canContain).map((value) => <option key={value.id} value={value.id}>{value.id}</option>)}</select></label>
      {world.itemDefinitions.find((item) => item.id === stack.itemId)?.fields.map((field) => <ScalarField key={field.key} label={`Stack field: ${field.key}`} value={stack.fields[field.key] ?? field.defaultValue} valueType={field.valueType} onChange={(value) => onWorldChange({ ...world, initialInventory: world.initialInventory.map((entry, i) => i === index ? { ...entry, fields: { ...entry.fields, [field.key]: value } } : entry) })} />)}
      <button type="button" onClick={() => onWorldChange({ ...world, initialInventory: world.initialInventory.filter((_value, i) => i !== index) })}>Remove stack</button>
    </fieldset>)}
  </section>;
}

function TimeEditor({ world, onWorldChange }: { world: WorldDocument; onWorldChange: (world: WorldDocument) => void }) {
  const time = world.settings.time;
  const change = (patch: Partial<typeof time>) => onWorldChange({ ...world, settings: { ...world.settings, time: { ...time, ...patch } } });
  return <section><h2>Time</h2>
    <label>Clock mode <select value={time.mode} onChange={(event) => change({ mode: event.target.value as typeof time.mode })}><option value="per-action">Per action</option><option value="elapsed">Elapsed time</option></select></label>
    {time.mode === 'per-action' && <label>Milliseconds per action <input type="number" min="0" value={time.millisecondsPerAction ?? 0} onChange={(event) => change({ millisecondsPerAction: Number(event.target.value) })} /></label>}
    <label>When hidden <select value={time.hiddenBehavior} onChange={(event) => change({ hiddenBehavior: event.target.value as typeof time.hiddenBehavior })}><option value="pause">Pause</option><option value="bounded-catch-up">Bounded catch-up</option></select></label>
    <label>Maximum catch-up milliseconds <input type="number" min="0" value={time.maxCatchUpMilliseconds} onChange={(event) => change({ maxCatchUpMilliseconds: Number(event.target.value) })} /></label>
    <label><input type="checkbox" checked={time.showClockHud} onChange={(event) => change({ showClockHud: event.target.checked })} /> Show clock in player HUD</label>
  </section>;
}

export function ApprenticeForms({ world, view = 'all', selectedNodeId, onWorldChange, project, locales, defaultLocale, assets, mediaAssets, onLocalesChange, onImportAsset }: ApprenticeFormsProps) {
  const node = useMemo(() => world.nodes.find((candidate) => candidate.id === selectedNodeId), [world, selectedNodeId]);
  const updateNode = (next: NodeDefinition) => onWorldChange(updateNodeDefinition(world, next.id, () => next) ?? world);
  const contentSettings: ContentSettings = { project, locales, defaultLocale, assets, mediaAssets, onLocalesChange, onImportAsset };
  return <div aria-label="Apprentice forms" style={{ display: 'grid', gap: 18, padding: 16, overflow: 'auto' }}>
    {view !== 'world' && (node ? <NodeEditor world={world} node={node} onChange={updateNode} contentSettings={contentSettings} /> : <p>Select a node to edit its content and actions.</p>)}
    {view !== 'scene' && <>
    <ApprenticeAuthorSettings world={world} project={project} assets={assets} onWorldChange={onWorldChange} />
    <section><h2>Game action defaults</h2><p>Nodes may inherit these choices and commands independently.</p><ActionEditors actions={world.actionDefaults} world={world} onChange={(actionDefaults) => onWorldChange({ ...world, actionDefaults })} /></section>
    <WorldStateEditor world={world} onWorldChange={onWorldChange} />
    <RuleEditor world={world} onChange={(rules) => onWorldChange({ ...world, rules })} />
    <ConversationEditor world={world} onChange={(conversations) => onWorldChange({ ...world, conversations })} />
    <EventActorEditors world={world} onWorldChange={onWorldChange} />
    <InventoryEditor world={world} onWorldChange={onWorldChange} />
    <TimeEditor world={world} onWorldChange={onWorldChange} />
    </>}
  </div>;
}
