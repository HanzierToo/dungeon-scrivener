import type {
  Condition, Diagnostic, Effect, EventDefinition, EventOccurrence, JsonRecord, LifecycleEffects,
  RuleDefinition, Scalar, SessionSnapshot, StateFieldDefinition, StateReference,
  TraceSource, TransitionResult, TransitionTraceRecord, ValueType, WorldDocument,
} from '@dungeon-scrivener/model';
import { reduceEffects } from './state.js';

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

function evaluateCondition(condition: Condition, context: EvaluationContext): EvaluationResult {
  const pending: Array<{ readonly condition: Condition; readonly exit: boolean }> = [{ condition, exit: false }];
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
      pending.push({ condition: current, exit: true });
      if (current.kind === 'not') pending.push({ condition: current.condition, exit: false });
      else for (let index = current.conditions.length - 1; index >= 0; index -= 1) {
        pending.push({ condition: current.conditions[index]!, exit: false });
      }
      continue;
    }
    let value: boolean;
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
        break;
      }
      case 'has-tag':
        if (!context.world.entities.some((entity) => entity.id === current.entityId)) throw new Error(`Condition references unknown entity ${current.entityId}.`);
        value = (context.snapshot.entityTags[current.entityId] ?? []).includes(current.tag);
        break;
      case 'at-node':
        if (!context.world.nodes.some((node) => node.id === current.nodeId)) throw new Error(`Condition references unknown node ${current.nodeId}.`);
        value = context.snapshot.currentNodeId === current.nodeId;
        break;
      case 'event-is':
        if (!eventDefinition(context.world, current.eventId)) throw new Error(`Condition references undeclared event ${current.eventId}.`);
        value = context.event?.eventId === current.eventId;
        break;
      case 'time-at-least':
        if (!Number.isSafeInteger(current.milliseconds) || current.milliseconds < 0) throw new Error('Condition contains an invalid game-time threshold.');
        value = context.snapshot.gameTimeMilliseconds >= current.milliseconds;
        break;
    }
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
): boolean {
  for (const record of records) {
    if (trace.length >= MAX_TRACE_RECORDS - 1) return false;
    trace.push({ ...record, sequence: trace.length });
  }
  return true;
}

/** Drains emitted events FIFO and atomically applies matching rule effects. */
export function processEventQueue(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  initialEvents: readonly EventOccurrence[],
  source: TraceSource,
  reason: string,
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
    if (trace.length < MAX_TRACE_RECORDS) {
      trace.push({ sequence: trace.length, kind: 'diagnostic', source, reason: message, diagnosticCode: code });
    }
    return result(snapshot, trace, [...diagnostics, issue]);
  };

  const enqueue = (occurrence: EventOccurrence, eventSourceTrace: TraceSource, eventReason: string): TransitionResult | undefined => {
    const problem = validateEvent(world, occurrence);
    if (problem) return fail(INVALID_EVENT, problem);
    eventCount += 1;
    if (eventCount > MAX_QUEUED_EVENTS) return fail(BUDGET_EXCEEDED, `Event queue exceeded the ${MAX_QUEUED_EVENTS} occurrence budget.`);
    if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
    queue.push({ eventId: occurrence.eventId, payload: structuredClone(occurrence.payload) as JsonRecord, source: occurrence.source });
    trace.push({ sequence: trace.length, kind: 'event', source: { ...eventSourceTrace }, reason: eventReason, eventId: occurrence.eventId });
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
          trace.push({
            sequence: trace.length, kind: 'condition', source: { kind: 'rule', ruleId: rule.id },
            reason: `Predicate ${JSON.stringify(rule.condition)} evaluated ${conditionValue} for event ${current.eventId}.`,
            eventId: current.eventId,
          });
        }
        if (!conditionValue) continue;
        ruleExecutions += 1;
        if (ruleExecutions > MAX_RULE_EXECUTIONS) return fail(BUDGET_EXCEEDED, `Rule execution exceeded the ${MAX_RULE_EXECUTIONS} activation budget.`);
        if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        trace.push({
          sequence: trace.length, kind: 'rule', source: { kind: 'rule', ruleId: rule.id },
          reason: `Rule ${rule.id} matched event ${current.eventId} from ${current.source}.`, eventId: current.eventId,
        });

        for (const effect of rule.effects) {
          effectCount += 1;
          if (effectCount > MAX_EFFECTS) return fail(BUDGET_EXCEEDED, `Effect application exceeded the ${MAX_EFFECTS} per-action budget.`);
          const ruleSource: TraceSource = { kind: 'rule', ruleId: rule.id };
          const effectReason = `Rule ${rule.id} effect triggered by event ${current.eventId} from ${current.source}.`;
          if (effect.kind === 'emit-event') {
            if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
            trace.push({ sequence: trace.length, kind: 'effect-request', source: ruleSource, reason: effectReason, effect: structuredClone(effect) as Effect });
            const emitted: EventOccurrence = { eventId: effect.eventId, payload: effect.payload, source: eventSource(ruleSource) };
            const failed = enqueue(emitted, ruleSource, effectReason);
            if (failed) return failed;
            continue;
          }
          const reduced = reduceEffects(world, provisional, [effect], ruleSource, effectReason);
          provisional = reduced.snapshot;
          if (reduced.diagnostics.diagnostics.length > 0) {
            diagnostics.push(...reduced.diagnostics.diagnostics);
            if (!appendTrace(trace, reduced.trace)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
            return result(snapshot, trace, diagnostics);
          }
          if (!appendTrace(trace, reduced.trace)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        }
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
): TransitionResult {
  let provisional = snapshot;
  const trace: TransitionTraceRecord[] = [];
  let executions = 0;
  let effectCount = 0;
  const queuedEvents: EventOccurrence[] = [];
  const fail = (code: string, message: string): TransitionResult => {
    const failure = diagnostic(code, message);
    if (trace.length < MAX_TRACE_RECORDS) trace.push({ sequence: trace.length, kind: 'diagnostic', source: { ...source }, reason: message, diagnosticCode: code });
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
        trace.push({
          sequence: trace.length, kind: 'condition', source: { kind: 'rule', ruleId: rule.id },
          reason: `Predicate ${JSON.stringify(rule.condition)} evaluated ${conditionValue} for phase ${phase}.`,
        });
      }
      if (!conditionValue) continue;
      if (++executions > MAX_RULE_EXECUTIONS) return fail(BUDGET_EXCEEDED, `Rule execution exceeded the ${MAX_RULE_EXECUTIONS} activation budget.`);
      if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
      trace.push({ sequence: trace.length, kind: 'rule', source: { kind: 'rule', ruleId: rule.id }, reason: `Rule ${rule.id} matched phase ${phase}.` });
      for (const effect of rule.effects) {
        if (++effectCount > MAX_EFFECTS) return fail(BUDGET_EXCEEDED, `Effect application exceeded the ${MAX_EFFECTS} per-action budget.`);
        const ruleSource: TraceSource = { kind: 'rule', ruleId: rule.id };
        const effectReason = `Rule ${rule.id} effect triggered by phase ${phase}.`;
        if (effect.kind === 'emit-event') {
          if (trace.length >= MAX_TRACE_RECORDS - 1) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
          trace.push({ sequence: trace.length, kind: 'effect-request', source: ruleSource, reason: effectReason, effect: structuredClone(effect) });
          queuedEvents.push({ eventId: effect.eventId, payload: effect.payload, source: eventSource(ruleSource) });
          continue;
        }
        const reduced = reduceEffects(world, provisional, [effect], ruleSource, effectReason);
        provisional = reduced.snapshot;
        if (!appendTrace(trace, reduced.trace)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
        if (reduced.diagnostics.diagnostics.length > 0) return result(snapshot, trace, reduced.diagnostics.diagnostics);
      }
    }
  }

  if (queuedEvents.length > 0) {
    const drained = processEventQueue(world, provisional, queuedEvents, source, `Events emitted during phase ${phase}.`);
    if (!appendTrace(trace, drained.trace)) return fail(BUDGET_EXCEEDED, `Transition trace exceeded the ${MAX_TRACE_RECORDS} record budget.`);
    if (drained.diagnostics.diagnostics.length > 0) return result(snapshot, trace, drained.diagnostics.diagnostics);
    provisional = drained.snapshot;
  }
  return result(provisional, trace, []);
}
