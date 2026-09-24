import { useMemo, useState, type FormEvent } from 'react';
import { dispatchPlayerInput, reduceEffects } from '@dungeon-scrivener/engine';
import type {
  Effect, PlayerInput, PlayerInputTransitionResult, Scalar, SessionSnapshot, StateReference, ValueType,
  TransitionTraceRecord, WorldDocument,
} from '@dungeon-scrivener/model';
import { DebuggerPanel } from './DebuggerPanel.js';

interface EditableField {
  readonly id: string;
  readonly label: string;
  readonly reference: StateReference;
  readonly valueType: ValueType;
}

interface Checkpoint {
  readonly id: number;
  readonly snapshot: SessionSnapshot;
  readonly transitions: readonly (readonly TransitionTraceRecord[])[];
}

export type DebugPlaytestStep = (snapshot: SessionSnapshot, input: PlayerInput) => PlayerInputTransitionResult;

export interface PlaytestDebuggerProps {
  readonly world: WorldDocument;
  /** Initial isolated playtest state. This component never writes it back to authored project data. */
  readonly initialSnapshot: SessionSnapshot;
  readonly initialTransitions?: readonly (readonly TransitionTraceRecord[])[];
  readonly completeTraceHistory?: boolean;
  /** Supply the app's configured engine dispatch when the world requires script runtime capabilities. */
  readonly stepSession?: DebugPlaytestStep;
}

function copySnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return structuredClone(snapshot);
}

function buildEditableFields(world: WorldDocument): readonly EditableField[] {
  const fields: EditableField[] = [];
  for (const field of world.stateDefinitions) {
    if (field.scopeKind === 'world') {
      fields.push({ id: `world:${field.key}`, label: `world.${field.key}`, reference: { scope: { kind: 'world' }, key: field.key }, valueType: field.valueType });
    } else {
      for (const node of world.nodes) {
        fields.push({
          id: `node:${node.id}:${field.key}`, label: `node:${node.id}.${field.key}`,
          reference: { scope: { kind: 'node', ownerId: node.id }, key: field.key }, valueType: field.valueType,
        });
      }
    }
  }
  for (const entity of world.entities) {
    const definition = world.entityDefinitions.find((candidate) => candidate.id === entity.definitionId);
    for (const field of definition?.fields ?? []) {
      fields.push({
        id: `entity:${entity.id}:${field.key}`, label: `entity:${entity.id}.${field.key}`,
        reference: { scope: { kind: 'entity', ownerId: entity.id }, key: field.key }, valueType: field.valueType,
      });
    }
  }
  return fields;
}

function currentValue(snapshot: SessionSnapshot, reference: StateReference): Scalar | undefined {
  switch (reference.scope.kind) {
    case 'world': return snapshot.state.world[reference.key];
    case 'node': return snapshot.state.nodes[reference.scope.ownerId]?.[reference.key];
    case 'entity': return snapshot.state.entities[reference.scope.ownerId]?.[reference.key];
  }
}

function isPlayerInput(value: unknown): value is PlayerInput {
  if (typeof value !== 'object' || value === null || !('kind' in value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'choice': return 'actionId' in value && typeof value.actionId === 'string';
    case 'command-text': return 'rawText' in value && typeof value.rawText === 'string';
    case 'dialogue-option': return 'conversationId' in value && typeof value.conversationId === 'string' &&
      'lineId' in value && typeof value.lineId === 'string' && 'optionId' in value && typeof value.optionId === 'string';
    case 'inventory': return 'operation' in value && typeof value.operation === 'object' && value.operation !== null &&
      'kind' in value.operation && typeof value.operation.kind === 'string';
    default: return false;
  }
}

function scalarText(value: Scalar): string {
  return typeof value === 'string' ? value : String(value);
}

function parseScalar(value: string, type: ValueType): Scalar {
  if (typeof type !== 'string') {
    if (!type.values.includes(value)) throw new Error('Choose one of the declared enum values.');
    return value;
  }
  switch (type) {
    case 'string': return value;
    case 'boolean':
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error('Choose true or false.');
    case 'integer': {
      if (!/^-?(0|[1-9][0-9]*)$/.test(value)) throw new Error('Enter a whole number.');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error('Enter a safe integer.');
      return parsed;
    }
    case 'number': {
      if (value.trim() === '') throw new Error('Enter a number.');
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error('Enter a finite number.');
      return parsed;
    }
  }
}

function valueTypeLabel(type: ValueType): string {
  return typeof type === 'string' ? type : `enum (${type.values.join(', ')})`;
}

function DebugValueEditor({ value, type, onChange }: {
  readonly value: Scalar;
  readonly type: ValueType;
  readonly onChange: (value: string) => void;
}) {
  if (type === 'boolean') {
    return (
      <select value={String(value)} onChange={(event) => onChange(event.currentTarget.value)}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (typeof type !== 'string') {
    return (
      <select value={String(value)} onChange={(event) => onChange(event.currentTarget.value)}>
        {type.values.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  return <input type="text" inputMode={type === 'integer' || type === 'number' ? 'decimal' : 'text'} value={scalarText(value)} onChange={(event) => onChange(event.currentTarget.value)} />;
}

function StepInput({ onStep }: { readonly onStep: (input: PlayerInput) => void }) {
  const [text, setText] = useState('{\n  "kind": "choice",\n  "actionId": "enter-cellar"\n}');
  const [error, setError] = useState('');

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      const value: unknown = JSON.parse(text);
      if (!isPlayerInput(value)) throw new Error('Enter a supported PlayerInput object: choice, command-text, dialogue-option, or inventory.');
      setError('');
      onStep(value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Input must be valid JSON.');
    }
  }

  return (
    <form onSubmit={submit}>
      <label style={{ display: 'grid', gap: 4 }}>
        Step with PlayerInput JSON
        <textarea rows={5} value={text} onChange={(event) => setText(event.currentTarget.value)} spellCheck={false} />
      </label>
      <button type="submit">Step session</button>
      <p>Examples: <code>{'{"kind":"command-text","rawText":"talk to Mira"}'}</code> or a <code>dialogue-option</code> with conversation, line, and option IDs.</p>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function PlaytestDebugger({
  world,
  initialSnapshot,
  initialTransitions = [],
  completeTraceHistory = false,
  stepSession,
}: PlaytestDebuggerProps) {
  const initial = useMemo(() => copySnapshot(initialSnapshot), [initialSnapshot]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(() => copySnapshot(initial));
  const [transitions, setTransitions] = useState<readonly (readonly TransitionTraceRecord[])[]>(() => structuredClone(initialTransitions));
  const [checkpoints, setCheckpoints] = useState<readonly Checkpoint[]>([]);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState('');
  const [nextCheckpointId, setNextCheckpointId] = useState(1);
  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [draft, setDraft] = useState('');
  const [draftFieldId, setDraftFieldId] = useState('');
  const [editMessage, setEditMessage] = useState('');
  const fields = useMemo(() => buildEditableFields(world), [world]);
  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? fields[0];
  const value = selectedField ? currentValue(snapshot, selectedField.reference) : undefined;

  function appendTransition(records: readonly TransitionTraceRecord[]): void {
    setTransitions((previous) => [...previous, structuredClone(records)]);
  }

  function step(input: PlayerInput): void {
    const result = stepSession ? stepSession(copySnapshot(snapshot), input) : dispatchPlayerInput(world, copySnapshot(snapshot), input);
    setSnapshot(copySnapshot(result.snapshot));
    setDraftFieldId('');
    appendTransition(result.trace);
  }

  function makeCheckpoint(): void {
    const checkpoint: Checkpoint = {
      id: nextCheckpointId,
      snapshot: copySnapshot(snapshot),
      transitions: structuredClone(transitions),
    };
    setCheckpoints((previous) => [...previous, checkpoint]);
    setSelectedCheckpointId(String(checkpoint.id));
    setNextCheckpointId((previous) => previous + 1);
  }

  function restoreCheckpoint(): void {
    const checkpoint = checkpoints.find((candidate) => String(candidate.id) === selectedCheckpointId);
    if (!checkpoint) return;
    setSnapshot(copySnapshot(checkpoint.snapshot));
    setDraftFieldId('');
    setTransitions(structuredClone(checkpoint.transitions));
    setEditMessage(`Restored checkpoint ${checkpoint.id}.`);
  }

  function restart(): void {
    setSnapshot(copySnapshot(initial));
    setDraftFieldId('');
    setTransitions(structuredClone(initialTransitions));
    setEditMessage('Restarted the isolated playtest session.');
  }

  function editState(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!selectedField || value === undefined) return;
    try {
      const nextValue = parseScalar(draftFieldId === selectedField.id ? draft : valueDraft, selectedField.valueType);
      const effect: Effect = { kind: 'set-state', target: selectedField.reference, value: nextValue };
      const result = reduceEffects(
        world,
        snapshot,
        [effect],
        { kind: 'engine', operation: 'debug-state-edit' },
        `DEBUG ONLY: Playtest state override for ${selectedField.label}.`,
      );
      appendTransition(result.trace);
      if (result.diagnostics.diagnostics.length > 0) {
        setEditMessage(result.diagnostics.diagnostics.map((diagnostic) => diagnostic.message).join(' '));
        return;
      }
      setSnapshot(copySnapshot(result.snapshot));
      setDraftFieldId('');
      setEditMessage(`DEBUG ONLY: ${selectedField.label} is now ${JSON.stringify(nextValue)} in this test session.`);
    } catch (caught) {
      setEditMessage(caught instanceof Error ? caught.message : 'The value could not be parsed.');
    }
  }

  const checkpoint = checkpoints.find((candidate) => String(candidate.id) === selectedCheckpointId);
  const valueDraft = selectedField && value !== undefined ? scalarText(value) : '';
  const currentDraft = selectedField?.id === draftFieldId ? draft : valueDraft;

  return (
    <section aria-label="Sandboxed playtest debugger" style={{ display: 'grid', gap: 12 }}>
      <header>
        <h2>Sandboxed playtest</h2>
        <p>This debugger owns an isolated copy of the session snapshot. Steps, restores, restarts, and debug edits do not update authored project files or player saves.</p>
      </header>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" onClick={makeCheckpoint}>Create checkpoint</button>
        <label>
          Checkpoint
          <select value={selectedCheckpointId} onChange={(event) => setSelectedCheckpointId(event.currentTarget.value)}>
            <option value="">Choose a checkpoint</option>
            {checkpoints.map((item) => <option key={item.id} value={String(item.id)}>Checkpoint {item.id}</option>)}
          </select>
        </label>
        <button type="button" onClick={restoreCheckpoint} disabled={!checkpoint}>Restore checkpoint</button>
        <button type="button" onClick={restart}>Restart test session</button>
      </div>
      <StepInput onStep={step} />
      <fieldset style={{ border: '2px solid #a44', padding: 12 }}>
        <legend><strong>DEBUG ONLY · Test session state editing</strong></legend>
        <p>Changes go through the engine’s validated <code>set-state</code> effect and remain in this isolated test session.</p>
        {selectedField && value !== undefined ? (
          <form onSubmit={editState} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <label>
              State field
              <select value={selectedField.id} onChange={(event) => {
                setSelectedFieldId(event.currentTarget.value);
                const field = fields.find((candidate) => candidate.id === event.currentTarget.value);
                if (field) setDraft(scalarText(currentValue(snapshot, field.reference) ?? ''));
              }}>
                {fields.map((field) => <option key={field.id} value={field.id}>{field.label} · {valueTypeLabel(field.valueType)}</option>)}
              </select>
            </label>
            <label>
              New value
              <DebugValueEditor value={parseCurrentValue(currentDraft, selectedField.valueType, value)} type={selectedField.valueType} onChange={(next) => { setDraft(next); setDraftFieldId(selectedField.id); }} />
            </label>
            <button type="submit">Apply debug edit</button>
          </form>
        ) : <p>No declared state fields are available to edit.</p>}
        {editMessage && <p role="status">{editMessage}</p>}
      </fieldset>
      <p>Current test state: node <code>{snapshot.currentNodeId}</code>, game time {snapshot.gameTimeMilliseconds} ms.</p>
      <details>
        <summary>Inspect complete test-session snapshot</summary>
        <pre style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(snapshot, null, 2)}</pre>
      </details>
      <DebuggerPanel
        world={world}
        snapshot={snapshot}
        transitions={transitions}
        completeTraceHistory={completeTraceHistory}
      />
    </section>
  );
}

function parseCurrentValue(draft: string, type: ValueType, fallback: Scalar): Scalar {
  try { return parseScalar(draft, type); }
  catch { return fallback; }
}
