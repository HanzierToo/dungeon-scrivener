import type {
  AvailabilityTraceHistory, Condition, ConditionEvaluationRead, ConditionObservedValue, Diagnostic, Effect,
  EventDefinition, EventOccurrence, JsonRecord, LifecycleEffects, RuleDefinition, Scalar,
  ScriptExecutionCapabilities, SessionSnapshot, StateFieldDefinition, StateReadProvenance, StateReference,
  TraceSource, TransitionResult, TransitionTraceRecord, ValueType, WorldDocument,
} from '@dungeon-scrivener/model';
import { applyInventoryEffect } from '../inventory/index.js';
import { applyDialogueEffect, completeTerminalConversation } from '../dialogue/index.js';
import { readStateValue, reduceEffects } from './state.js';
import {
  accountEngineTrace, executeScriptActivation, makeScriptRandomBridge,
  type ScriptActionTransaction, scriptDiagnostic,
} from './script-runtime.js';

const MAX_CONDITION_NODES = 10_000;
const MAX_RULE_EXECUTIONS = 10_000;
const MAX_QUEUED_EVENTS = 1_000;
const MAX_TRACE_RECORDS = 20_000;
const MAX_EFFECTS = 10_000;

const INVALID_EVENT = 'DS-ENG-002';
const BUDGET_EXCEEDED = 'DS-ENG-003';
const INVALID_CONDITION = 'DS-ENG-004';

interface EvaluationContext {
  readonly world: WorldDocument;
  readonly snapshot: SessionSnapshot;
  readonly event?: EventOccurrence;
  readonly reads?: ConditionEvaluationRead[];
  readonly traceHistory?: AvailabilityTraceHistory;
}

interface EvaluationResult {
  readonly value: boolean;
  readonly nodes: number;
}

function diagnostic(code: string, message: string): Diagnostic {
  return { code, severity: 'error', message, blocks: ['play'] };
}

function result(snapshot: SessionSnapshot, trace: readonly TransitionTraceRecord[], diagnostics: readonly Diagnostic[]): TransitionResult {
  const frozenTrace = freezeDeep(structuredClone(trace));
  const frozenDiagnostics = freezeDeep(structuredClone(diagnostics));
  return Object.freeze({
    snapshot,
    trace: frozenTrace,
    diagnostics: Object.freeze({
      format: 'dungeon-scrivener-diagnostics' as const,
      schemaVersion: 1 as const,
      diagnostics: frozenDiagnostics,
    }),
  });
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

/** Applies authored every/first/once policy; the caller commits once guards with its transaction. */
export function shouldRunLifecycleEffects(
  policy: LifecycleEffects['policy'],
  visitCount: number,
  onceAlreadyRun: boolean,
): boolean {
  if (!Number.isSafeInteger(visitCount) || visitCount < 0) return false;
  switch (policy) {
    case 'every-time': return true;
    case 'first-time': return visitCount === 0;
    case 'once-per-playthrough': return !onceAlreadyRun;
  }
}

function isValue(value: unknown, type: ValueType): value is Scalar {
  if (typeof type === 'string') {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'boolean': return typeof value === 'boolean';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    }
  }
  return typeof value === 'string' && type.values.includes(value);
}

function eventDefinition(world: WorldDocument, eventId: string): EventDefinition | undefined {
  return world.eventDefinitions.find((definition) => definition.id === eventId);
}

function validateEvent(world: WorldDocument, occurrence: EventOccurrence): string | undefined {
  const definition = eventDefinition(world, occurrence.eventId);
  if (!definition) return `Event ${occurrence.eventId} is not declared.`;
  const declared = new Map(definition.payloadFields.map((field) => [field.key, field]));
  for (const [key, field] of declared) {
    const value = occurrence.payload[key];
    if (value === undefined || !isValue(value, field.valueType)) {
      return `Event ${occurrence.eventId} payload field ${key} is missing or has the wrong type.`;
    }
  }
  for (const key of Object.keys(occurrence.payload)) {
    if (!declared.has(key)) return `Event ${occurrence.eventId} payload contains undeclared field ${key}.`;
  }
  return undefined;
}

function stateField(world: WorldDocument, snapshot: SessionSnapshot, reference: StateReference): StateFieldDefinition | undefined {
  const scope = reference.scope;
  switch (scope.kind) {
    case 'world': return world.stateDefinitions.find((field) => field.scopeKind === 'world' && field.key === reference.key);
    case 'node':
      if (!snapshot.state.nodes[scope.ownerId]) return undefined;
      return world.stateDefinitions.find((field) => field.scopeKind === 'node' && field.key === reference.key);
    case 'entity': {
      const instance = world.entities.find((entity) => entity.id === scope.ownerId);
      if (!instance || !snapshot.state.entities[scope.ownerId]) return undefined;
      const definition = world.entityDefinitions.find((candidate) => candidate.id === instance.definitionId);
      return definition?.fields.find((field) => field.key === reference.key);
    }
  }
}

function stateValue(snapshot: SessionSnapshot, reference: StateReference): Scalar | undefined {
  switch (reference.scope.kind) {
    case 'world': return snapshot.state.world[reference.key];
    case 'node': return snapshot.state.nodes[reference.scope.ownerId]?.[reference.key];
    case 'entity': return snapshot.state.entities[reference.scope.ownerId]?.[reference.key];
  }
}

function sameScalar(left: Scalar, right: Scalar): boolean {
  return typeof left === typeof right && left === right;
}

function sameReference(left: StateReference, right: StateReference): boolean {
  if (left.key !== right.key || left.scope.kind !== right.scope.kind) return false;
  return left.scope.kind === 'world' || (right.scope.kind !== 'world' && left.scope.ownerId === right.scope.ownerId);
}

function provenance(reference: StateReference, history: AvailabilityTraceHistory | undefined): StateReadProvenance {
  if (!history) return { kind: 'unknown', reason: 'trace-history-not-provided' };
  for (let transitionIndex = history.transitions.length - 1; transitionIndex >= 0; transitionIndex -= 1) {
    const records = history.transitions[transitionIndex]!;
    for (let recordIndex = records.length - 1; recordIndex >= 0; recordIndex -= 1) {
      const record = records[recordIndex]!;
      if (record.kind !== 'state-change' || !record.target || !sameReference(record.target, reference)) continue;
      const stateChange = { transitionIndex, sequence: record.sequence };
      if (record.source.kind !== 'rule') return { kind: 'recorded', stateChange };
      for (let ruleIndex = recordIndex - 1; ruleIndex >= 0; ruleIndex -= 1) {
        const possibleRule = records[ruleIndex]!;
        if (possibleRule.kind === 'rule' && possibleRule.source.kind === 'rule' && possibleRule.source.ruleId === record.source.ruleId) {
          return { kind: 'recorded', stateChange, sourceRule: { transitionIndex, sequence: possibleRule.sequence } };
        }
      }
      return { kind: 'recorded', stateChange };
    }
  }
  return history.completeFromSessionStart
    ? { kind: 'session-start', completeTraceHistory: true }
    : { kind: 'unknown', reason: 'trace-history-starts-after-save' };
}

function evaluateCondition(condition: Condition, context: EvaluationContext): EvaluationResult {
  const pending: Array<{ readonly condition: Condition; readonly exit: boolean; readonly path: readonly number[] }> = [{ condition, exit: false, path: [] }];
  const values: boolean[] = [];
  let nodes = 0;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (!frame.exit && ++nodes > MAX_CONDITION_NODES) throw new RangeError(`Condition tree exceeds ${MAX_CONDITION_NODES} nodes.`);
    const current = frame.condition;
    if (frame.exit) {
      if (current.kind === 'not') {
        values.push(!values.pop()!);
      } else if (current.kind === 'all' || current.kind === 'any') {
        const children = values.splice(values.length - current.conditions.length, current.conditions.length);
        values.push(current.kind === 'all' ? children.every(Boolean) : children.some(Boolean));
      }
      continue;
    }
    if (current.kind === 'all' || current.kind === 'any' || current.kind === 'not') {
      pending.push({ condition: current, exit: true, path: frame.path });
      if (current.kind === 'not') pending.push({ condition: current.condition, exit: false, path: [...frame.path, 0] });
      else for (let index = current.conditions.length - 1; index >= 0; index -= 1) {
        pending.push({ condition: current.conditions[index]!, exit: false, path: [...frame.path, index] });
      }
      continue;
    }
    let value: boolean;
    let observed: ConditionObservedValue;
    let stateReference: StateReference | undefined;
    let readProvenance: StateReadProvenance | undefined;
    switch (current.kind) {
      case 'compare-state': {
        const field = stateField(context.world, context.snapshot, current.left);
        const left = stateValue(context.snapshot, current.left);
        if (!field || left === undefined || !isValue(current.right, field.valueType)) {
          throw new Error(`Condition references invalid state ${current.left.key} or a differently typed comparison value.`);
        }
        if (current.operator === 'eq') value = sameScalar(left, current.right);
        else if (current.operator === 'neq') value = !sameScalar(left, current.right);
        else {
          if (typeof left !== 'number' || typeof current.right !== 'number') {
            throw new Error(`Ordering comparison for ${current.left.key} requires numeric state.`);
          }
          switch (current.operator) {
            case 'lt': value = left < current.right; break;
            case 'lte': value = left <= current.right; break;
            case 'gt': value = left > current.right; break;
            case 'gte': value = left >= current.right; break;
          }
        }
        stateReference = current.left;
        observed = { kind: 'state', value: left };
        readProvenance = provenance(current.left, context.traceHistory);
        break;
      }
      case 'has-tag':
        if (!context.world.entities.some((entity) => entity.id === current.entityId)) throw new Error(`Condition references unknown entity ${current.entityId}.`);
        value = (context.snapshot.entityTags[current.entityId] ?? []).includes(current.tag);
        observed = { kind: 'tag-membership', entityId: current.entityId, tag: current.tag, present: value };
        break;
      case 'has-seen-line':
        if (!context.world.conversations.some((item) => item.id === current.conversationId && item.lines.some((line) => line.id === current.lineId))) {
          throw new Error(`Dialogue history condition references unknown line ${current.conversationId}:${current.lineId}.`);
        }
        const matchingEntries = (context.snapshot.dialogueHistory ?? []).filter((entry) => entry.kind === 'line-seen' &&
          entry.conversationId === current.conversationId && entry.lineId === current.lineId);
        value = matchingEntries.length > 0;
        observed = { kind: 'dialogue-history', matchingEntries };
        break;
      case 'has-selected-dialogue-option': {
        const definition = context.world.conversations.find((item) => item.id === current.conversationId);
        if (!definition || !definition.lines.some((line) => line.options?.some((option) => option.id === current.optionId))) {
          throw new Error(`Dialogue history condition references unknown option ${current.conversationId}:${current.optionId}.`);
        }
        const matchingEntries = (context.snapshot.dialogueHistory ?? []).filter((entry) => entry.kind === 'option-selected' &&
          entry.conversationId === current.conversationId && entry.optionId === current.optionId);
        value = matchingEntries.length > 0;
        observed = { kind: 'dialogue-history', matchingEntries };
        break;
      }
      case 'has-item': {
        if (!context.world.itemDefinitions.some((item) => item.id === current.itemId)) throw new Error(`Condition references unknown item ${current.itemId}.`);
        if (!Number.isSafeInteger(current.quantity) || current.quantity <= 0) throw new Error('Inventory condition quantity must be a positive safe integer.');
        if (current.owner.kind === 'node') {
          const nodeId = current.owner.ownerId;
          if (!context.world.nodes.some((node) => node.id === nodeId)) throw new Error(`Condition references unknown inventory owner node ${nodeId}.`);
        }
        if (current.owner.kind === 'entity') {
          const entityId = current.owner.ownerId;
          if (!context.world.entities.some((entity) => entity.id === entityId)) throw new Error(`Condition references unknown inventory owner entity ${entityId}.`);
        }
        const ownerId = current.owner.kind === 'world' ? undefined : current.owner.ownerId;
        const matchingStacks = context.snapshot.inventory
          .filter((stack) => stack.itemId === current.itemId && stack.owner.kind === current.owner.kind &&
            (ownerId === undefined || ('ownerId' in stack.owner && stack.owner.ownerId === ownerId)))
        const quantity = matchingStacks.reduce((total, stack) => total + stack.quantity, 0);
        if (!Number.isSafeInteger(quantity)) throw new RangeError('Inventory condition quantity exceeds the safe integer limit.');
        value = quantity >= current.quantity;
        observed = { kind: 'inventory-total', owner: current.owner, itemId: current.itemId, quantity, matchingStackIds: matchingStacks.map((stack) => stack.id) };
        break;
      }
      case 'at-node':
        if (!context.world.nodes.some((node) => node.id === current.nodeId)) throw new Error(`Condition references unknown node ${current.nodeId}.`);
        value = context.snapshot.currentNodeId === current.nodeId;
        observed = { kind: 'current-node', nodeId: context.snapshot.currentNodeId };
        break;
      case 'event-is':
        if (!eventDefinition(context.world, current.eventId)) throw new Error(`Condition references undeclared event ${current.eventId}.`);
        value = context.event?.eventId === current.eventId;
        observed = { kind: 'event', triggeringEventId: context.event?.eventId ?? null };
        break;
      case 'time-at-least':
        if (!Number.isSafeInteger(current.milliseconds) || current.milliseconds < 0) throw new Error('Condition contains an invalid game-time threshold.');
        value = context.snapshot.gameTimeMilliseconds >= current.milliseconds;
        observed = { kind: 'game-time', milliseconds: context.snapshot.gameTimeMilliseconds };
        break;
    }
    if (context.reads) context.reads.push({
      conditionPath: frame.path,
      conditionKind: current.kind,
      ...(stateReference ? { stateReference } : {}),
      observed: structuredClone(observed!),
      result: value,
      ...(readProvenance ? { provenance: readProvenance } : {}),
    });
    values.push(value);
  }
  return { value: values.at(-1) ?? true, nodes };
}

/** Evaluates one condition against the current snapshot and optional triggering event. */
export function evaluateConditionValue(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  condition: Condition,
  event?: EventOccurrence,
): boolean {
  return evaluateCondition(condition, { world, snapshot, ...(event ? { event } : {}) }).value;
}

/** Evaluates a condition with the same rules as gameplay and records each leaf read in authored order. */
export function inspectCondition(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  condition: Condition,
  traceHistory?: AvailabilityTraceHistory,
): { readonly result: boolean; readonly reads: readonly ConditionEvaluationRead[] } {
  const reads: ConditionEvaluationRead[] = [];
  const evaluation = evaluateCondition(condition, { world, snapshot, reads, ...(traceHistory ? { traceHistory } : {}) });
  return freezeDeep({ result: evaluation.value, reads });
}

function eventSource(source: TraceSource): string {
  switch (source.kind) {
    case 'action': return `action:${source.actionId}`;
    case 'rule': return `rule:${source.ruleId}`;
    case 'lifecycle': return `lifecycle:${source.nodeId}:${source.phase}`;
    case 'script': return `script:${source.scriptId}`;
    case 'engine': return `engine:${source.operation}`;
  }
}

interface RuleGroup { readonly nodeId: string; readonly rules: readonly RuleDefinition[] }

/** Resolves the current node's local rules and opted-in ancestor rules, parent first. */
function effectiveRuleGroups(world: WorldDocument, snapshot: SessionSnapshot): readonly RuleGroup[] {
  const byId = new Map(world.rules.map((rule) => [rule.id, rule]));
  const leafToRoot: Array<{ nodeId: string; ruleIds: readonly string[] }> = [];
  let node = world.nodes.find((candidate) => candidate.id === snapshot.currentNodeId);
  while (node) {
    leafToRoot.push({ nodeId: node.id, ruleIds: node.ruleIds ?? [] });
    if (!node.inheritance?.rules || node.parentId === null) break;
    node = world.nodes.find((candidate) => candidate.id === node?.parentId);
  }
  return leafToRoot.reverse().map(({ nodeId, ruleIds }) => ({
    nodeId,
    rules: ruleIds.flatMap((id) => {
      const rule = byId.get(id);
      return rule ? [rule] : [];
    }),
  }));
}

function appendTrace(
  trace: TransitionTraceRecord[],
  records: readonly TransitionTraceRecord[],
  transaction?: ScriptActionTransaction,
  alreadyAccounted = false,
): boolean {
  if (transaction && !alreadyAccounted && !accountEngineTrace(transaction, records.length)) return false;
  for (const record of records) {
    if (trace.length >= MAX_TRACE_RECORDS - 1) return false;
    trace.push({ ...record, sequence: trace.length });
  }
  return true;
}

function pushTrace(trace: TransitionTraceRecord[], record: Omit<TransitionTraceRecord, 'sequence'>, transaction?: ScriptActionTransaction): boolean {
  if (trace.length >= MAX_TRACE_RECORDS - 1 || (transaction && !accountEngineTrace(transaction, 1))) return false;
  trace.push({ ...record, sequence: trace.length });
  return true;
}

function invokeRuleScript(
  world: WorldDocument,
  transaction: ScriptActionTransaction | undefined,
  scriptId: string,
  ruleId: string,
  getSnapshot: () => SessionSnapshot,
  setSnapshot: (snapshot: SessionSnapshot) => void,
  request: (effect: import('@dungeon-scrivener/model').ScriptEffect, source: TraceSource, reason: string) => void,
  emit: (eventId: string, payload: JsonRecord, source: TraceSource, reason: string) => void,
  trace: TransitionTraceRecord[],
): Diagnostic | undefined {
  if (!transaction) return scriptDiagnostic(`run-script effect for ${scriptId} requires an engine script runtime.`);
  const source: TraceSource = { kind: 'script', scriptId };
  const reason = `Script ${scriptId} invoked by rule ${ruleId}.`;
  const random = makeScriptRandomBridge(transaction, world, scriptId, getSnapshot, setSnapshot, (records) => {
    if (!appendTrace(trace, records, transaction, true)) throw scriptDiagnostic('Transition trace budget exceeded while recording script randomness.');
  });
  const capabilities: ScriptExecutionCapabilities = {
    read(reference) {
      const value = readStateValue(world, getSnapshot(), reference);
      if (value === undefined) throw scriptDiagnostic(`Script ${scriptId} read unknown state ${reference.scope.kind}:${reference.key}.`);
      return value;
    },
    hasTag(entityId, tag) {
      if (!world.entities.some((entity) => entity.id === entityId)) throw scriptDiagnostic(`Script ${scriptId} queried unknown entity ${entityId}.`);
      return (getSnapshot().entityTags[entityId] ?? []).includes(tag);
    },
    request(effect) { request(effect, source, reason); },
    emit(eventId, payload) { emit(eventId, payload, source, reason); },
    ...random,
  };
  const result = executeScriptActivation(transaction, world, getSnapshot(), scriptId, { kind: 'rule', ruleId }, capabilities);
  if (!appendTrace(trace, result.trace, transaction, true)) return scriptDiagnostic('Transition trace budget exceeded while importing executor trace.');
  return result.ok ? undefined : result.diagnostic;
}

/** Drains emitted events FIFO and atomically applies matching rule effects. */
export function processEventQueue(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  initialEvents: readonly EventOccurrence[],
  source: TraceSource,
  reason: string,
  transaction?: ScriptActionTransaction,
): TransitionResult {
  let provisional = snapshot;
  const trace: TransitionTraceRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const queue: EventOccurrence[] = [];
  let eventCount = 0;
  let ruleExecutions = 0;
  let effectCount = 0;

  const fail = (code: string, message: string): TransitionResult => {
    const issue = diagnostic(code, message);
    pushTrace(trace, { kind: 'diagnostic', source, reason: message, diagnosticCode: code }, transaction);
    return result(snapshot, trace, [...diagnostics, issue]);
  };

  const enqueue = (occurrence: EventOccurrence, eventSourceTrace: TraceSource, eventReason: string): TransitionResult | undefined => {
    const problem = validateEvent(world, occurrence);
    if (problem) return fail(INVALID_EVENT, problem);
    eventCount += 1;
    if (transaction) transaction.budget.events += 1;
    if (eventCount > MAX_QUEUED_EVENTS || (transaction && transaction.budget.events > MAX_QUEUED_EVENTS)) return fail(BUDGET_EXCEEDED, `Event queue exceeded the ${MAX_QUEUED_EVENTS} occurrence budget.`);
    queue.push({ eventId: occurrence.eventId, payload: structuredClone(occurrence.payload) as JsonRecord, source: occurrence.source });
    if (!pushTrace(trace, { kind: 'event', source: { ...eventSourceTrace }, reason: eventReason, eventId: occurrence.eventId }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
    return undefined;
  };

  for (const event of initialEvents) {
    const failed = enqueue(event, source, reason);
    if (failed) return failed;
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const groups = effectiveRuleGroups(world, provisional);
    for (const group of groups) {
      const indexedRules = group.rules
        .map((rule, index) => ({ rule, index }))
        .filter(({ rule }) => rule.trigger.kind === 'event' && rule.trigger.eventId === current.eventId)
        .sort((left, right) => right.rule.priority - left.rule.priority || left.index - right.index);
      for (const { rule } of indexedRules) {
        let conditionValue = true;
        if (rule.condition) {
          try {
            const evaluation = evaluateCondition(rule.condition, { world, snapshot: provisional, event: current });
            if (evaluation.nodes > MAX_CONDITION_NODES) return fail(BUDGET_EXCEEDED, `Condition for rule ${rule.id} exceeded the ${MAX_CONDITION_NODES} node budget.`);
            conditionValue = evaluation.value;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Condition evaluation failed.';
            return fail(error instanceof RangeError ? BUDGET_EXCEEDED : INVALID_CONDITION, `Rule ${rule.id}: ${message}`);
          }
          if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
          if (!pushTrace(trace, {
            kind: 'condition', source: { kind: 'rule', ruleId: rule.id },
            reason: `Predicate ${JSON.stringify(rule.condition)} evaluated ${conditionValue} for event ${current.eventId}.`,
            eventId: current.eventId,
          }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        }
        if (!conditionValue) continue;
        ruleExecutions += 1;
        if (transaction) transaction.budget.ruleExecutions += 1;
        if (ruleExecutions > MAX_RULE_EXECUTIONS || (transaction && transaction.budget.ruleExecutions > MAX_RULE_EXECUTIONS)) return fail(BUDGET_EXCEEDED, `Rule execution exceeded the ${MAX_RULE_EXECUTIONS} activation budget.`);
        if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        if (!pushTrace(trace, {
          kind: 'rule', source: { kind: 'rule', ruleId: rule.id },
          reason: `Rule ${rule.id} matched event ${current.eventId} from ${current.source}.`, eventId: current.eventId,
        }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);

        for (const effect of rule.effects) {
          effectCount += 1;
          if (transaction) transaction.budget.effects += 1;
          if (effectCount > MAX_EFFECTS || (transaction && transaction.budget.effects > MAX_EFFECTS)) return fail(BUDGET_EXCEEDED, `Effect application exceeded the ${MAX_EFFECTS} per-action budget.`);
          const ruleSource: TraceSource = { kind: 'rule', ruleId: rule.id };
          const effectReason = `Rule ${rule.id} effect triggered by event ${current.eventId} from ${current.source}.`;
          if (effect.kind === 'emit-event') {
            if (!pushTrace(trace, { kind: 'effect-request', source: ruleSource, reason: effectReason, effect: structuredClone(effect) as Effect }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
            const emitted: EventOccurrence = { eventId: effect.eventId, payload: effect.payload, source: eventSource(ruleSource) };
            const failed = enqueue(emitted, ruleSource, effectReason);
            if (failed) return failed;
            continue;
          }
          if (effect.kind === 'use-item') {
            if (!pushTrace(trace, { kind: 'effect-request', source: ruleSource, reason: effectReason, effect: structuredClone(effect) }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
            const used = applyInventoryEffect(world, provisional, effect);
            if (!used.ok || !used.event) return result(snapshot, trace, used.diagnostics.length > 0 ? used.diagnostics : [diagnostic(INVALID_EVENT, 'Inventory use did not produce its declared event.')]);
            provisional = used.snapshot;
            const failed = enqueue(used.event, ruleSource, effectReason);
            if (failed) return failed;
            continue;
          }
          if (effect.kind === 'run-script') {
            if (!pushTrace(trace, { kind: 'effect-request', source: ruleSource, reason: effectReason, effect: structuredClone(effect) }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
            const scriptSource: TraceSource = { kind: 'script', scriptId: effect.scriptId };
            const request = (requested: import('@dungeon-scrivener/model').ScriptEffect, requestedSource: TraceSource, requestedReason: string): void => {
              if (transaction && ++transaction.budget.effects > MAX_EFFECTS) throw scriptDiagnostic(`Effect application exceeded the ${MAX_EFFECTS} per-action budget.`);
              if (requested.kind === 'emit-event') {
                if (!pushTrace(trace, { kind: 'effect-request', source: requestedSource, reason: requestedReason, effect: structuredClone(requested) }, transaction)) {
                  throw scriptDiagnostic('Transition trace budget exceeded while applying script-requested event.');
                }
                const error = enqueue({ eventId: requested.eventId, payload: requested.payload, source: eventSource(requestedSource) }, requestedSource, requestedReason);
                if (error) throw scriptDiagnostic(error.diagnostics.diagnostics[0]?.message ?? 'Script event request failed.', error.diagnostics.diagnostics[0]);
                return;
              }
              if (requested.kind === 'use-item') {
                if (!pushTrace(trace, { kind: 'effect-request', source: requestedSource, reason: requestedReason, effect: structuredClone(requested) }, transaction)) throw scriptDiagnostic('Transition trace budget exceeded while applying script-requested item use.');
                const used = applyInventoryEffect(world, provisional, requested);
                if (!used.ok || !used.event) throw scriptDiagnostic(used.diagnostics[0]?.message ?? 'Script-requested item use failed.', used.diagnostics[0]);
                provisional = used.snapshot;
                const error = enqueue(used.event, requestedSource, requestedReason);
                if (error) throw scriptDiagnostic(error.diagnostics.diagnostics[0]?.message ?? 'Script-requested item event failed.', error.diagnostics.diagnostics[0]);
                return;
              }
              const requestedDialogue = applyDialogueEffect(world, provisional, requested, requestedSource, requestedReason,
                (condition, currentSnapshot, triggeringEvent) => evaluateCondition(condition, {
                  world, snapshot: currentSnapshot, ...(triggeringEvent ? { event: triggeringEvent } : {}),
                }).value,
                current);
              if (requestedDialogue) {
                if (!appendTrace(trace, requestedDialogue.trace, transaction)) throw scriptDiagnostic('Transition trace budget exceeded while applying script-requested dialogue effect.');
                if (requestedDialogue.diagnostics.diagnostics.length > 0) throw scriptDiagnostic(requestedDialogue.diagnostics.diagnostics[0]!.message, requestedDialogue.diagnostics.diagnostics[0]);
                provisional = requestedDialogue.snapshot;
                return;
              }
              const reducedRequest = reduceEffects(world, provisional, [requested], requestedSource, requestedReason);
              if (!appendTrace(trace, reducedRequest.trace, transaction)) throw scriptDiagnostic('Transition trace budget exceeded while applying script-requested effect.');
              if (reducedRequest.diagnostics.diagnostics.length > 0) throw scriptDiagnostic(reducedRequest.diagnostics.diagnostics[0]!.message, reducedRequest.diagnostics.diagnostics[0]);
              provisional = reducedRequest.snapshot;
            };
            const emit = (eventId: string, payload: JsonRecord, emittedBy: TraceSource, emittedReason: string): void => {
              if (transaction && ++transaction.budget.effects > MAX_EFFECTS) throw scriptDiagnostic(`Effect application exceeded the ${MAX_EFFECTS} per-action budget.`);
              const error = enqueue({ eventId, payload, source: eventSource(emittedBy) }, emittedBy, emittedReason);
              if (error) throw scriptDiagnostic(error.diagnostics.diagnostics[0]?.message ?? 'Script event emission failed.', error.diagnostics.diagnostics[0]);
            };
            const failure = invokeRuleScript(world, transaction, effect.scriptId, rule.id, () => provisional, (next) => { provisional = next; }, request, emit, trace);
            if (failure) {
              pushTrace(trace, { kind: 'diagnostic', source: scriptSource, reason: failure.message, diagnosticCode: failure.code }, transaction);
              return result(snapshot, trace, [failure]);
            }
            continue;
          }
          const dialogue = applyDialogueEffect(
            world, provisional, effect, ruleSource, effectReason,
            (condition, currentSnapshot, triggeringEvent) => evaluateCondition(condition, {
              world, snapshot: currentSnapshot, ...(triggeringEvent ? { event: triggeringEvent } : {}),
            }).value,
            current,
          );
          if (dialogue) {
            if (!appendTrace(trace, dialogue.trace, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
            if (dialogue.diagnostics.diagnostics.length > 0) return result(snapshot, trace, dialogue.diagnostics.diagnostics);
            provisional = dialogue.snapshot;
            continue;
          }
          const reduced = reduceEffects(world, provisional, [effect], ruleSource, effectReason);
          provisional = reduced.snapshot;
          if (reduced.diagnostics.diagnostics.length > 0) {
            diagnostics.push(...reduced.diagnostics.diagnostics);
            if (!appendTrace(trace, reduced.trace, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
            return result(snapshot, trace, diagnostics);
          }
          if (!appendTrace(trace, reduced.trace, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        }
        const completed = completeTerminalConversation(world, provisional, { kind: 'rule', ruleId: rule.id }, `Rule ${rule.id} effects completed.`);
        provisional = completed.snapshot;
        if (!appendTrace(trace, completed.trace, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
      }
    }
  }
  return result(provisional, trace, diagnostics);
}

/** Executes rules attached to the active node for a lifecycle/action phase. */
export function processRulePhase(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  phase: Extract<RuleDefinition['trigger'], { kind: 'phase' }>['phase'],
  source: TraceSource,
  reason: string,
  transaction?: ScriptActionTransaction,
): TransitionResult {
  let provisional = snapshot;
  const trace: TransitionTraceRecord[] = [];
  let executions = 0;
  let effectCount = 0;
  const queuedEvents: EventOccurrence[] = [];
  const fail = (code: string, message: string): TransitionResult => {
    const failure = diagnostic(code, message);
    pushTrace(trace, { kind: 'diagnostic', source: { ...source }, reason: message, diagnosticCode: code }, transaction);
    return result(snapshot, trace, [failure]);
  };

  for (const group of effectiveRuleGroups(world, provisional)) {
    const candidates = group.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.trigger.kind === 'phase' && rule.trigger.phase === phase)
      .sort((left, right) => right.rule.priority - left.rule.priority || left.index - right.index);
    for (const { rule } of candidates) {
      let conditionValue = true;
      if (rule.condition) {
        try { conditionValue = evaluateCondition(rule.condition, { world, snapshot: provisional }).value; }
        catch (error) {
          const message = error instanceof Error ? error.message : 'Condition evaluation failed.';
          return fail(error instanceof RangeError ? BUDGET_EXCEEDED : INVALID_CONDITION, `Rule ${rule.id}: ${message}`);
        }
        if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        if (!pushTrace(trace, {
          kind: 'condition', source: { kind: 'rule', ruleId: rule.id },
          reason: `Predicate ${JSON.stringify(rule.condition)} evaluated ${conditionValue} for phase ${phase}.`,
        }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
      }
      if (!conditionValue) continue;
      if (++executions > MAX_RULE_EXECUTIONS) return fail(BUDGET_EXCEEDED, `Rule execution exceeded the ${MAX_RULE_EXECUTIONS} activation budget.`);
      if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
      if (!pushTrace(trace, { kind: 'rule', source: { kind: 'rule', ruleId: rule.id }, reason: `Rule ${rule.id} matched phase ${phase}.` }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        for (const effect of rule.effects) {
        effectCount += 1;
        if (transaction) transaction.budget.effects += 1;
        if (effectCount > MAX_EFFECTS || (transaction && transaction.budget.effects > MAX_EFFECTS)) return fail(BUDGET_EXCEEDED, `Effect application exceeded the ${MAX_EFFECTS} per-action budget.`);
        const ruleSource: TraceSource = { kind: 'rule', ruleId: rule.id };
        const effectReason = `Rule ${rule.id} effect triggered by phase ${phase}.`;
        if (effect.kind === 'emit-event') {
          if (!pushTrace(trace, { kind: 'effect-request', source: ruleSource, reason: effectReason, effect: structuredClone(effect) }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
          queuedEvents.push({ eventId: effect.eventId, payload: effect.payload, source: eventSource(ruleSource) });
          continue;
        }
        if (effect.kind === 'use-item') {
          if (!pushTrace(trace, { kind: 'effect-request', source: ruleSource, reason: effectReason, effect: structuredClone(effect) }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
          const used = applyInventoryEffect(world, provisional, effect);
          if (!used.ok || !used.event) return result(snapshot, trace, used.diagnostics.length > 0 ? used.diagnostics : [diagnostic(INVALID_EVENT, 'Inventory use did not produce its declared event.')]);
          provisional = used.snapshot;
          queuedEvents.push(used.event);
          continue;
        }
        if (effect.kind === 'run-script') {
          if (!pushTrace(trace, { kind: 'effect-request', source: ruleSource, reason: effectReason, effect: structuredClone(effect) }, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
          const scriptSource: TraceSource = { kind: 'script', scriptId: effect.scriptId };
          const request = (requested: import('@dungeon-scrivener/model').ScriptEffect, requestedSource: TraceSource, requestedReason: string): void => {
            if (transaction && ++transaction.budget.effects > MAX_EFFECTS) throw scriptDiagnostic(`Effect application exceeded the ${MAX_EFFECTS} per-action budget.`);
            if (requested.kind === 'emit-event') {
              if (!pushTrace(trace, { kind: 'effect-request', source: requestedSource, reason: requestedReason, effect: structuredClone(requested) }, transaction)) throw scriptDiagnostic('Transition trace budget exceeded while applying script-requested event.');
              queuedEvents.push({ eventId: requested.eventId, payload: requested.payload, source: eventSource(requestedSource) });
              return;
            }
            if (requested.kind === 'use-item') {
              if (!pushTrace(trace, { kind: 'effect-request', source: requestedSource, reason: requestedReason, effect: structuredClone(requested) }, transaction)) throw scriptDiagnostic('Transition trace budget exceeded while applying script-requested item use.');
              const used = applyInventoryEffect(world, provisional, requested);
              if (!used.ok || !used.event) throw scriptDiagnostic(used.diagnostics[0]?.message ?? 'Script-requested item use failed.', used.diagnostics[0]);
              provisional = used.snapshot;
              queuedEvents.push(used.event);
              return;
            }
            const requestedDialogue = applyDialogueEffect(world, provisional, requested, requestedSource, requestedReason,
              (condition, currentSnapshot, triggeringEvent) => evaluateCondition(condition, {
                world, snapshot: currentSnapshot, ...(triggeringEvent ? { event: triggeringEvent } : {}),
              }).value);
            if (requestedDialogue) {
              if (!appendTrace(trace, requestedDialogue.trace, transaction)) throw scriptDiagnostic('Transition trace budget exceeded while applying script-requested dialogue effect.');
              if (requestedDialogue.diagnostics.diagnostics.length > 0) throw scriptDiagnostic(requestedDialogue.diagnostics.diagnostics[0]!.message, requestedDialogue.diagnostics.diagnostics[0]);
              provisional = requestedDialogue.snapshot;
              return;
            }
            const reducedRequest = reduceEffects(world, provisional, [requested], requestedSource, requestedReason);
            if (!appendTrace(trace, reducedRequest.trace, transaction)) throw scriptDiagnostic('Transition trace budget exceeded while applying script-requested effect.');
            if (reducedRequest.diagnostics.diagnostics.length > 0) throw scriptDiagnostic(reducedRequest.diagnostics.diagnostics[0]!.message, reducedRequest.diagnostics.diagnostics[0]);
            provisional = reducedRequest.snapshot;
          };
          const emit = (eventId: string, payload: JsonRecord, emittedBy: TraceSource): void => {
            if (transaction && ++transaction.budget.effects > MAX_EFFECTS) throw scriptDiagnostic(`Effect application exceeded the ${MAX_EFFECTS} per-action budget.`);
            queuedEvents.push({ eventId, payload, source: eventSource(emittedBy) });
          };
          const failure = invokeRuleScript(world, transaction, effect.scriptId, rule.id, () => provisional, (next) => { provisional = next; }, request, emit, trace);
          if (failure) {
            pushTrace(trace, { kind: 'diagnostic', source: scriptSource, reason: failure.message, diagnosticCode: failure.code }, transaction);
            return result(snapshot, trace, [failure]);
          }
          continue;
        }
        const dialogue = applyDialogueEffect(
          world, provisional, effect, ruleSource, effectReason,
          (condition, currentSnapshot, triggeringEvent) => evaluateCondition(condition, {
            world, snapshot: currentSnapshot, ...(triggeringEvent ? { event: triggeringEvent } : {}),
          }).value,
        );
        if (dialogue) {
          if (!appendTrace(trace, dialogue.trace, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
          if (dialogue.diagnostics.diagnostics.length > 0) return result(snapshot, trace, dialogue.diagnostics.diagnostics);
          provisional = dialogue.snapshot;
          continue;
        }
        const reduced = reduceEffects(world, provisional, [effect], ruleSource, effectReason);
        provisional = reduced.snapshot;
        if (!appendTrace(trace, reduced.trace, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        if (reduced.diagnostics.diagnostics.length > 0) return result(snapshot, trace, reduced.diagnostics.diagnostics);
      }
      const completed = completeTerminalConversation(world, provisional, { kind: 'rule', ruleId: rule.id }, `Rule ${rule.id} effects completed.`);
      provisional = completed.snapshot;
      if (!appendTrace(trace, completed.trace, transaction)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
    }
  }

  if (queuedEvents.length > 0) {
    const drained = processEventQueue(world, provisional, queuedEvents, source, `Events emitted during phase ${phase}.`, transaction);
    if (!appendTrace(trace, drained.trace, transaction, true)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
    if (drained.diagnostics.diagnostics.length > 0) return result(snapshot, trace, drained.diagnostics.diagnostics);
    provisional = drained.snapshot;
  }
  return result(provisional, trace, []);
}
