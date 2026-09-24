import type {
  Diagnostic, Effect, EntityDefinition, EntityInstance, Scalar, ScalarRecord,
  SavedSessionState, SessionSnapshot, StateFieldDefinition, StateReference, TraceSource, TransitionResult,
  TransitionTraceRecord, ValueType, WorldDocument,
} from '@dungeon-scrivener/model';
import { applyInventoryEffect } from '../inventory/index.js';

const INVALID_EFFECT = 'DS-ENG-001';

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function defaultRecord(fields: readonly StateFieldDefinition[], initial: ScalarRecord = {}): ScalarRecord {
  const values: Record<string, Scalar> = {};
  for (const field of fields) values[field.key] = initial[field.key] ?? field.defaultValue;
  return values;
}

function stateFields(world: WorldDocument, scopeKind: 'world' | 'node'): readonly StateFieldDefinition[] {
  return world.stateDefinitions.filter((field) => field.scopeKind === scopeKind);
}

/** Creates detached, deeply frozen scoped state maps from a validated world. */
export function createInitialState(world: WorldDocument): SavedSessionState['state'] {
  const definitions = new Map<string, EntityDefinition>(world.entityDefinitions.map((definition) => [definition.id, definition]));
  const nodes: Record<string, ScalarRecord> = {};
  const entities: Record<string, ScalarRecord> = {};
  for (const node of world.nodes) {
    nodes[node.id] = defaultRecord(stateFields(world, 'node'), node.state);
  }
  for (const entity of world.entities) {
    entities[entity.id] = defaultRecord(definitions.get(entity.definitionId)?.fields ?? [], entity.state);
  }
  return freezeDeep({ world: defaultRecord(stateFields(world, 'world'), world.worldState), nodes, entities });
}

interface ResolvedStateField { readonly valueType: ValueType; readonly value: Scalar | undefined }

function recordForReference(snapshot: SessionSnapshot, reference: StateReference): ScalarRecord | undefined {
  switch (reference.scope.kind) {
    case 'world': return snapshot.state.world;
    case 'node': return snapshot.state.nodes[reference.scope.ownerId];
    case 'entity': return snapshot.state.entities[reference.scope.ownerId];
  }
}

function fieldForReference(world: WorldDocument, snapshot: SessionSnapshot, reference: StateReference): ResolvedStateField | undefined {
  let fields: readonly StateFieldDefinition[];
  const scope = reference.scope;
  switch (scope.kind) {
    case 'world': fields = stateFields(world, 'world'); break;
    case 'node':
      if (!snapshot.state.nodes[scope.ownerId]) return undefined;
      fields = stateFields(world, 'node');
      break;
    case 'entity': {
      const entity = world.entities.find((candidate) => candidate.id === scope.ownerId);
      if (!entity || !snapshot.state.entities[scope.ownerId]) return undefined;
      fields = world.entityDefinitions.find((definition) => definition.id === entity.definitionId)?.fields ?? [];
      break;
    }
  }
  const field = fields.find((candidate) => candidate.key === reference.key);
  return field ? { valueType: field.valueType, value: recordForReference(snapshot, reference)?.[reference.key] } : undefined;
}

/** Reads one declared scalar from the current provisional session state. */
export function readStateValue(world: WorldDocument, snapshot: SessionSnapshot, reference: StateReference): Scalar | undefined {
  return fieldForReference(world, snapshot, reference)?.value;
}

function matchesType(value: Scalar, valueType: ValueType): boolean {
  if (typeof valueType === 'string') {
    switch (valueType) {
      case 'string': return typeof value === 'string';
      case 'boolean': return typeof value === 'boolean';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    }
  }
  return typeof value === 'string' && valueType.values.includes(value);
}

function replaceState(snapshot: SessionSnapshot, reference: StateReference, value: Scalar): SessionSnapshot {
  const state = snapshot.state;
  if (reference.scope.kind === 'world') {
    return { ...snapshot, state: { ...state, world: { ...state.world, [reference.key]: value } } };
  }
  if (reference.scope.kind === 'node') {
    return { ...snapshot, state: { ...state, nodes: { ...state.nodes, [reference.scope.ownerId]: { ...state.nodes[reference.scope.ownerId], [reference.key]: value } } } };
  }
  return { ...snapshot, state: { ...state, entities: { ...state.entities, [reference.scope.ownerId]: { ...state.entities[reference.scope.ownerId], [reference.key]: value } } } };
}

function effectDiagnostic(message: string, entityId?: string): Diagnostic {
  return { code: INVALID_EFFECT, severity: 'error', message, ...(entityId ? { entityId } : {}), blocks: ['play'] };
}

/** Applies a batch of state effect requests as one transaction. */
export function reduceEffects(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  effects: readonly Effect[],
  source: TraceSource,
  reason: string,
): TransitionResult {
  let provisional = snapshot;
  const trace: TransitionTraceRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const effect of effects) {
    trace.push({ sequence: trace.length, kind: 'effect-request', source: { ...source }, reason, effect: structuredClone(effect) });
    if (effect.kind === 'set-state' || effect.kind === 'increment-state') {
      const field = fieldForReference(world, provisional, effect.target);
      if (!field) {
        const ownerId = 'ownerId' in effect.target.scope ? effect.target.scope.ownerId : undefined;
        diagnostics.push(effectDiagnostic(`State target ${effect.target.scope.kind}:${ownerId ? `${ownerId}:` : ''}${effect.target.key} does not exist.`, ownerId));
        break;
      }
      const before = field.value;
      let after: Scalar;
      if (effect.kind === 'set-state') {
        after = effect.value;
        if (!matchesType(after, field.valueType)) {
          diagnostics.push(effectDiagnostic(`State value for ${effect.target.key} does not match its declared type.`));
          break;
        }
      } else {
        if (typeof before !== 'number' || !Number.isFinite(effect.amount) || (field.valueType !== 'number' && field.valueType !== 'integer')) {
          diagnostics.push(effectDiagnostic(`Cannot increment non-numeric state ${effect.target.key}.`));
          break;
        }
        after = before + effect.amount;
        if (!matchesType(after, field.valueType)) {
          diagnostics.push(effectDiagnostic(`Incrementing ${effect.target.key} would violate its declared type or numeric bounds.`));
          break;
        }
      }
      provisional = replaceState(provisional, effect.target, after);
      trace.push({
        sequence: trace.length, kind: 'state-change', source: { ...source }, reason,
        target: structuredClone(effect.target), effect: structuredClone(effect), before: before as Scalar, after,
      });
      continue;
    }
    if (effect.kind === 'add-tag' || effect.kind === 'remove-tag') {
      const entity = world.entities.find((candidate: EntityInstance) => candidate.id === effect.entityId);
      const definition = entity && world.entityDefinitions.find((candidate) => candidate.id === entity.definitionId);
      if (!entity || !definition || !definition.allowedTags.includes(effect.tag)) {
        diagnostics.push(effectDiagnostic(`Tag ${effect.tag} is not declared for entity ${effect.entityId}.`, effect.entityId));
        break;
      }
      const current = provisional.entityTags[effect.entityId] ?? [];
      const next = effect.kind === 'add-tag'
        ? (current.includes(effect.tag) ? current : [...current, effect.tag])
        : current.filter((tag) => tag !== effect.tag);
      provisional = { ...provisional, entityTags: { ...provisional.entityTags, [effect.entityId]: next } };
      trace.push({ sequence: trace.length, kind: 'state-change', source: { ...source }, reason, effect: structuredClone(effect) });
      continue;
    }
    if (effect.kind === 'add-item' || effect.kind === 'remove-item' || effect.kind === 'transfer-item' || effect.kind === 'equip-item' || effect.kind === 'unequip-item') {
      const inventory = applyInventoryEffect(world, provisional, effect);
      if (!inventory.ok) {
        diagnostics.push(...inventory.diagnostics);
        break;
      }
      provisional = inventory.snapshot;
      trace.push({ sequence: trace.length, kind: 'state-change', source: { ...source }, reason, effect: structuredClone(effect) });
      continue;
    }
    diagnostics.push(effectDiagnostic(`Effect ${effect.kind} is not implemented by the state reducer.`));
    break;
  }
  if (diagnostics.length > 0) {
    trace.push({ sequence: trace.length, kind: 'diagnostic', source: { ...source }, reason, diagnosticCode: diagnostics[0]!.code });
    const report = freezeDeep({ format: 'dungeon-scrivener-diagnostics' as const, schemaVersion: 1 as const, diagnostics });
    return Object.freeze({ snapshot, trace: freezeDeep(trace), diagnostics: report });
  }
  const report = freezeDeep({ format: 'dungeon-scrivener-diagnostics' as const, schemaVersion: 1 as const, diagnostics });
  return Object.freeze({ snapshot: freezeDeep(provisional), trace: freezeDeep(trace), diagnostics: report });
}
