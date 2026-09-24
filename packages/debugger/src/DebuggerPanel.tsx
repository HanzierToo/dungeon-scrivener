import { useMemo, useState, type CSSProperties } from 'react';
import { inspectActionAvailability } from '@dungeon-scrivener/engine';
import type {
  AvailableActionEvaluation, AvailabilityTraceHistory, ConditionEvaluationRead, SessionSnapshot,
  StateReadProvenance, StateReference, TraceSource, TransitionTraceRecord, WorldDocument,
} from '@dungeon-scrivener/model';

type TraceGroup = 'actions' | 'conditions' | 'rules' | 'effects' | 'state' | 'events' | 'clock' | 'random' | 'scripts' | 'diagnostics';

const traceGroups: readonly { readonly id: TraceGroup; readonly label: string }[] = [
  { id: 'actions', label: 'Actions and navigation' },
  { id: 'conditions', label: 'Rule conditions' },
  { id: 'rules', label: 'Rules' },
  { id: 'effects', label: 'Effects' },
  { id: 'state', label: 'State changes' },
  { id: 'events', label: 'Events' },
  { id: 'clock', label: 'Clock' },
  { id: 'random', label: 'Randomness' },
  { id: 'scripts', label: 'Scripts and source spans' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

const panelStyle: CSSProperties = {
  border: '1px solid #8b8b8b', borderRadius: 6, padding: 12, color: 'inherit',
  font: 'inherit', maxWidth: '100%', overflowWrap: 'anywhere',
};
const gridStyle: CSSProperties = { display: 'grid', gap: 8 };
const rowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' };
const entryStyle: CSSProperties = { borderTop: '1px solid #aaa', padding: '8px 0' };

export interface DebuggerPanelProps {
  readonly world: WorldDocument;
  readonly snapshot: SessionSnapshot;
  /** Ordered engine transition traces retained by the host for this test session. */
  readonly transitions: readonly (readonly TransitionTraceRecord[])[];
  /** Set true only when transitions contains the complete history since session creation. */
  readonly completeTraceHistory?: boolean;
}

function sourceLabel(source: TraceSource): string {
  switch (source.kind) {
    case 'action': return `Action ${source.actionId}`;
    case 'rule': return `Rule ${source.ruleId}`;
    case 'lifecycle': return `${source.phase} lifecycle for ${source.nodeId}`;
    case 'script': return `Script ${source.scriptId}`;
    case 'engine': return `Engine ${source.operation}`;
  }
}

function stateReferenceLabel(reference: StateReference): string {
  switch (reference.scope.kind) {
    case 'world': return `world.${reference.key}`;
    case 'node': return `node:${reference.scope.ownerId}.${reference.key}`;
    case 'entity': return `entity:${reference.scope.ownerId}.${reference.key}`;
  }
}

function groupFor(record: TransitionTraceRecord): TraceGroup {
  switch (record.kind) {
    case 'action':
    case 'node-transition': return 'actions';
    case 'condition': return 'conditions';
    case 'rule': return 'rules';
    case 'effect-request': return 'effects';
    case 'state-change': return 'state';
    case 'event': return 'events';
    case 'time': return 'clock';
    case 'random': return 'random';
    case 'script': return 'scripts';
    case 'diagnostic': return 'diagnostics';
  }
}

function describeRecord(record: TransitionTraceRecord): string {
  const details: string[] = [record.reason];
  if (record.target) details.push(`Field: ${stateReferenceLabel(record.target)}.`);
  if (record.before !== undefined || record.after !== undefined) details.push(`Value: ${String(record.before)} → ${String(record.after)}.`);
  if (record.eventId) details.push(`Event: ${record.eventId}.`);
  if (record.effect) details.push(`Effect: ${JSON.stringify(record.effect)}.`);
  if (record.randomOutcome) {
    const outcome = record.randomOutcome;
    const range = outcome.minimum === undefined ? '' : ` in [${outcome.minimum}, ${outcome.maximum}]`;
    details.push(`Draw: ${outcome.value}${range}; ${outcome.provider}, ${outcome.operation}, outcome ${outcome.ordinal}.`);
  }
  if (record.scriptTrace?.sourceSpan) {
    const span = record.scriptTrace.sourceSpan;
    details.push(`Source: ${span.path}:${span.startLine}:${span.startColumn}–${span.endLine}:${span.endColumn}.`);
  }
  return details.join(' ');
}

function resolveTraceReference(
  reference: { readonly transitionIndex: number; readonly sequence: number },
  transitions: readonly (readonly TransitionTraceRecord[])[],
): TransitionTraceRecord | undefined {
  return transitions[reference.transitionIndex]?.find((record) => record.sequence === reference.sequence);
}

function provenanceSummary(
  provenance: StateReadProvenance | undefined,
  transitions: readonly (readonly TransitionTraceRecord[])[],
): string {
  if (!provenance) return 'No cause was supplied by the availability inspection.';
  if (provenance.kind === 'session-start') return 'The complete trace shows this value was present at session start; no earlier state change exists in the trace.';
  if (provenance.kind === 'unknown') {
    return provenance.reason === 'trace-history-not-provided'
      ? 'Earlier transition traces were not supplied, so the cause is unavailable.'
      : 'The retained traces begin after session start, so the earlier cause is unavailable.';
  }

  const change = resolveTraceReference(provenance.stateChange, transitions);
  if (!change) return 'The referenced state-change trace is unavailable.';
  const cause = `${sourceLabel(change.source)}: ${change.reason}`;
  if (!provenance.sourceRule) return `Recorded cause: ${cause}`;
  const rule = resolveTraceReference(provenance.sourceRule, transitions);
  if (!rule || rule.source.kind !== 'rule') return `Recorded cause: ${cause}`;
  return `Recorded cause: Rule ${rule.source.ruleId}. ${rule.reason} ${cause}`;
}

function observedSummary(read: ConditionEvaluationRead): string {
  const observed = read.observed;
  switch (observed.kind) {
    case 'state': return `${read.stateReference ? stateReferenceLabel(read.stateReference) : 'State'} = ${JSON.stringify(observed.value)}`;
    case 'tag-membership': return `Tag ${observed.tag} on ${observed.entityId}: ${observed.present ? 'present' : 'absent'}`;
    case 'dialogue-history': return `Matching dialogue-history entries: ${observed.matchingEntries.length}`;
    case 'inventory-total': return `Inventory ${observed.itemId} at ${observed.owner.kind}${observed.owner.kind === 'world' ? '' : `:${observed.owner.ownerId}`}: ${observed.quantity}`;
    case 'current-node': return `Current node: ${observed.nodeId}`;
    case 'event': return `Triggering event: ${observed.triggeringEventId ?? 'none'}`;
    case 'game-time': return `Game time: ${observed.milliseconds} ms`;
  }
}

function actionLabel(item: AvailableActionEvaluation): string {
  return `${item.kind}: ${item.id}`;
}

function AvailabilityEntry({ item, transitions }: {
  readonly item: AvailableActionEvaluation;
  readonly transitions: readonly (readonly TransitionTraceRecord[])[];
}) {
  return (
    <li style={entryStyle}>
      <strong>{actionLabel(item)}</strong>. {item.visibility}, {item.enabled ? 'enabled' : 'disabled'}; condition {item.result ? 'passed' : 'failed'}.
      {item.condition === null ? <p>No authored condition. Availability evaluates true.</p> : (
        <>
          <p>Condition: <code>{JSON.stringify(item.condition)}</code></p>
          {item.reads.length === 0 ? <p>No leaf reads were returned by the inspection.</p> : (
            <ol>
              {item.reads.map((read, index) => (
                <li key={`${read.conditionPath.join('.')}:${index}`}>
                  {read.conditionKind} at {read.conditionPath.length ? read.conditionPath.join('.') : 'root'}: {observedSummary(read)}. Result: {read.result ? 'true' : 'false'}.
                  {read.stateReference && <span> {provenanceSummary(read.provenance, transitions)}</span>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </li>
  );
}

function AvailabilitySection({ title, items, transitions, query }: {
  readonly title: string;
  readonly items: readonly AvailableActionEvaluation[];
  readonly transitions: readonly (readonly TransitionTraceRecord[])[];
  readonly query: string;
}) {
  const filtered = items.filter((item) => `${actionLabel(item)} ${JSON.stringify(item.condition)} ${JSON.stringify(item.reads)}`.toLowerCase().includes(query));
  if (filtered.length === 0) return null;
  return (
    <section>
      <h4>{title}</h4>
      <ul>{filtered.map((item) => <AvailabilityEntry key={`${item.kind}:${item.id}`} item={item} transitions={transitions} />)}</ul>
    </section>
  );
}

export function DebuggerPanel({ world, snapshot, transitions, completeTraceHistory = false }: DebuggerPanelProps) {
  const [query, setQuery] = useState('');
  const [enabledGroups, setEnabledGroups] = useState<ReadonlySet<TraceGroup>>(() => new Set(traceGroups.map(({ id }) => id)));
  const traceHistory = useMemo<AvailabilityTraceHistory>(() => ({
    completeFromSessionStart: completeTraceHistory,
    transitions,
  }), [completeTraceHistory, transitions]);
  const availability = useMemo(
    () => inspectActionAvailability(world, snapshot, traceHistory),
    [world, snapshot, traceHistory],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const entries = transitions.flatMap((records, transitionIndex) => records.map((record) => ({ record, transitionIndex })));
  const filteredEntries = entries.filter(({ record }) => enabledGroups.has(groupFor(record)) &&
    `${record.kind} ${sourceLabel(record.source)} ${describeRecord(record)}`.toLowerCase().includes(normalizedQuery));

  function toggleGroup(group: TraceGroup, enabled: boolean): void {
    setEnabledGroups((previous) => {
      const next = new Set(previous);
      if (enabled) next.add(group);
      else next.delete(group);
      return next;
    });
  }

  return (
    <details>
      <summary>Playtest debugger</summary>
      <aside aria-label="Playtest trace debugger" style={panelStyle}>
        <div style={gridStyle}>
          <label style={rowStyle}>
            Search traces and availability
            <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <fieldset>
            <legend>Trace filters</legend>
            <div style={rowStyle}>
              {traceGroups.map(({ id, label }) => (
                <label key={id}>
                  <input type="checkbox" checked={enabledGroups.has(id)} onChange={(event) => toggleGroup(id, event.currentTarget.checked)} /> {label}
                </label>
              ))}
            </div>
          </fieldset>
          <section aria-label="Current action availability">
            <h3>Availability inspection</h3>
            <p>Read-only condition evaluation for the current snapshot. Causes are linked only when the engine inspection returns a trace reference.</p>
            <AvailabilitySection title="Choices" items={availability.choices} transitions={transitions} query={normalizedQuery} />
            <AvailabilitySection title="Commands" items={availability.commands} transitions={transitions} query={normalizedQuery} />
            <AvailabilitySection title="Dialogue options" items={availability.dialogueOptions} transitions={transitions} query={normalizedQuery} />
          </section>
          <section aria-label="Chronological engine trace">
            <h3>Chronological engine trace</h3>
            {filteredEntries.length === 0 ? <p>No trace records match the current filters.</p> : (
              <ol>
                {filteredEntries.map(({ record, transitionIndex }) => (
                  <li key={`${transitionIndex}:${record.sequence}`} style={entryStyle}>
                    <strong>Transition {transitionIndex + 1}, #{record.sequence}. {record.kind}</strong> · {sourceLabel(record.source)}
                    <p>{describeRecord(record)}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </aside>
    </details>
  );
}
