import type {
  ActionInput, ActionSet, ChoiceDefinition, CommandDefinition, CommandMatchResult,
  Condition, Diagnostic, Effect, EventOccurrence, LifecycleEffects, PlayerInput,
  PlayerInputResolution, PlayerInputTransitionResult, Scalar, SessionSnapshot,
  TraceSource, TransitionResult, TransitionTraceRecord, ValueType, WorldDocument,
} from '@dungeon-scrivener/model';
import { evaluateConditionValue, processEventQueue, processRulePhase, shouldRunLifecycleEffects } from './rules.js';
import { reduceEffects } from './state.js';
import { advanceActionTime } from './time.js';
import { applyInventoryEffect, inventoryOperationEffect } from '../inventory/index.js';
import {
  applyDialogueEffect, completeTerminalConversation, prepareDialogueOption, resumeOnReturn, suspendForNavigation,
} from '../dialogue/index.js';

const MAX_EFFECTS_PER_ACTION = 10_000;
const MAX_TRACE_RECORDS = 20_000;
const MAX_COMMANDS = 256;
const MAX_PATTERNS = 32;
const MAX_PARAMETERS = 16;
const MAX_PATTERN_BYTES = 4_096;
const MAX_PATTERN_TOKENS = 128;
const MAX_COMMAND_BYTES = 4_096;
const MAX_COMMAND_SCALARS = 1_024;
const MAX_COMMAND_TOKENS = 128;
const MAX_TOKEN_COMPARISONS = 1_048_576;

const INVALID_INPUT = 'DS-ENG-005';
const INVALID_ACTION = 'DS-ENG-006';
const INVALID_NAVIGATION = 'DS-ENG-007';
const INVALID_LIFECYCLE = 'DS-ENG-008';
const BUDGET_EXCEEDED = 'DS-ENG-009';

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function report(diagnostics: readonly Diagnostic[]) {
  return freezeDeep({ format: 'dungeon-scrivener-diagnostics' as const, schemaVersion: 1 as const, diagnostics: [...diagnostics] });
}

function transition(snapshot: SessionSnapshot, trace: readonly TransitionTraceRecord[], diagnostics: readonly Diagnostic[]): TransitionResult {
  return Object.freeze({ snapshot, trace: freezeDeep(structuredClone(trace)), diagnostics: report(diagnostics) });
}

function issue(code: string, message: string): Diagnostic {
  return { code, severity: 'error', message, blocks: ['play'] };
}

function actionSets(world: WorldDocument, snapshot: SessionSnapshot): ActionSet {
  const leafToRoot: WorldDocument['nodes'][number][] = [];
  let node = world.nodes.find((candidate) => candidate.id === snapshot.currentNodeId);
  while (node) {
    leafToRoot.push(node);
    if (!node.inheritance?.defaults || node.parentId === null) break;
    node = world.nodes.find((candidate) => candidate.id === node?.parentId);
  }
  const effective: { choices: ChoiceDefinition[]; commands: CommandDefinition[] } = {
    choices: [...world.actionDefaults.choices],
    commands: [...world.actionDefaults.commands],
  };
  for (const inheritedNode of leafToRoot.reverse()) {
    if (inheritedNode.actions?.choices !== undefined) effective.choices = [...inheritedNode.actions.choices];
    if (inheritedNode.actions?.commands !== undefined) effective.commands = [...inheritedNode.actions.commands];
  }
  return effective;
}

export function getAvailableActions(world: WorldDocument, snapshot: SessionSnapshot): ActionSet {
  return freezeDeep(actionSets(world, snapshot));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\p{White_Space}+/gu, ' ').replace(/^ | $/gu, '');
}

function normalizedDisplay(value: string): string {
  return normalizeWhitespace(value.normalize('NFC'));
}

function normalizedMatch(value: string): string {
  return normalizedDisplay(value).toLowerCase();
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function tokenList(value: string): string[] {
  return value === '' ? [] : value.split(' ');
}

function parseCapture(value: string, valueType: ValueType): Scalar | undefined {
  if (typeof valueType === 'string') {
    switch (valueType) {
      case 'string': return value;
      case 'number': {
        if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value)) return undefined;
        const result = Number(value);
        return Number.isFinite(result) ? result : undefined;
      }
      case 'integer': {
        if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value)) return undefined;
        const result = Number(value);
        return Number.isSafeInteger(result) ? result : undefined;
      }
      case 'boolean':
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;
        return undefined;
    }
  }
  return typeof valueType !== 'string'
    ? valueType.values.find((candidate) => candidate.toLowerCase() === value.toLowerCase())
    : undefined;
}

function conditionEnabled(world: WorldDocument, snapshot: SessionSnapshot, condition: Condition | undefined): boolean {
  return condition ? evaluateConditionValue(world, snapshot, condition) : true;
}

function invalidCommand(message: string): CommandMatchResult {
  return { kind: 'invalid-input', diagnostic: issue(INVALID_INPUT, message) };
}

export function matchCommandText(world: WorldDocument, snapshot: SessionSnapshot, rawText: string): CommandMatchResult {
  if (hasLoneSurrogate(rawText) || new TextEncoder().encode(rawText).byteLength > MAX_COMMAND_BYTES || Array.from(rawText).length > MAX_COMMAND_SCALARS) {
    return invalidCommand('Command input contains malformed Unicode or exceeds its raw input limit.');
  }
  const displayTokens = tokenList(normalizedDisplay(rawText));
  const matchTokens = tokenList(normalizedMatch(rawText));
  if (matchTokens.length > MAX_COMMAND_TOKENS) return invalidCommand(`Command input exceeds ${MAX_COMMAND_TOKENS} normalized tokens.`);

  const commands = actionSets(world, snapshot).commands;
  if (commands.length > MAX_COMMANDS) return invalidCommand(`The effective command set exceeds ${MAX_COMMANDS} commands.`);
  const matches = new Map<string, { command: CommandDefinition; parameters: Record<string, Scalar> }>();
  let comparisons = 0;
  for (const command of commands) {
    if (command.patterns.length > MAX_PATTERNS || command.parameters.length > MAX_PARAMETERS) {
      return invalidCommand(`Command ${command.id} exceeds a pattern or parameter limit.`);
    }
    let enabled: boolean;
    try {
      enabled = conditionEnabled(world, snapshot, command.condition);
    } catch (error) {
      return invalidCommand(error instanceof Error ? `Command ${command.id} condition is invalid: ${error.message}` : `Command ${command.id} condition is invalid.`);
    }
    if (!enabled && command.falsePolicy !== 'disable') continue;
    const parameters = new Map(command.parameters.map((parameter) => [parameter.id, parameter]));
    for (const pattern of command.patterns) {
      if (hasLoneSurrogate(pattern) || new TextEncoder().encode(pattern).byteLength > MAX_PATTERN_BYTES) {
        return invalidCommand(`Command ${command.id} contains an invalid or over-limit pattern.`);
      }
      const patternTokens = tokenList(normalizedMatch(pattern));
      if (patternTokens.length > MAX_PATTERN_TOKENS) return invalidCommand(`Command ${command.id} pattern exceeds ${MAX_PATTERN_TOKENS} tokens.`);
      if (patternTokens.length !== matchTokens.length) continue;
      const captures: Record<string, Scalar> = {};
      let matched = true;
      for (let index = 0; index < patternTokens.length; index += 1) {
        comparisons += 1;
        if (comparisons > MAX_TOKEN_COMPARISONS) return invalidCommand(`Command matching exceeded ${MAX_TOKEN_COMPARISONS} token comparisons.`);
        const placeholder = /^\{([a-z][a-z0-9-]*)\}$/.exec(patternTokens[index]!);
        if (!placeholder) {
          if (patternTokens[index] !== matchTokens[index]) matched = false;
          if (!matched) break;
          continue;
        }
        const parameter = parameters.get(placeholder[1]!);
        const captured = parameter ? parseCapture(displayTokens[index]!, parameter.valueType) : undefined;
        if (captured === undefined) { matched = false; break; }
        captures[placeholder[1]!] = captured;
      }
      if (matched) {
        matches.set(command.id, { command, parameters: captures });
        break;
      }
    }
  }
  const normalizedText = normalizedMatch(rawText);
  if (matches.size === 0) return { kind: 'no-match', normalizedText };
  if (matches.size > 1) return { kind: 'ambiguous', commandIds: [...matches.keys()].sort(), normalizedText };
  const matched = matches.values().next().value!;
  return {
    kind: 'matched',
    action: { kind: 'command', actionId: matched.command.id, parameters: matched.parameters },
    normalizedText,
  };
}

interface ActionContext {
  readonly world: WorldDocument;
  readonly original: SessionSnapshot;
  snapshot: SessionSnapshot;
  readonly trace: TransitionTraceRecord[];
  readonly diagnostics: Diagnostic[];
  readonly events: EventOccurrence[];
  effectCount: number;
  didNavigate: boolean;
}

function addTrace(context: ActionContext, record: Omit<TransitionTraceRecord, 'sequence'>): boolean {
  if (context.trace.length >= MAX_TRACE_RECORDS - 1) return false;
  context.trace.push({ ...record, sequence: context.trace.length });
  return true;
}

function addTransitionTrace(context: ActionContext, records: readonly TransitionTraceRecord[]): boolean {
  for (const { sequence: _sequence, ...record } of records) {
    if (!addTrace(context, record)) return false;
  }
  return true;
}

function applyRuleTransition(context: ActionContext, result: TransitionResult): boolean {
  if (!addTransitionTrace(context, result.trace)) {
    fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
    return false;
  }
  if (result.diagnostics.diagnostics.length > 0) {
    context.diagnostics.push(...result.diagnostics.diagnostics);
    return false;
  }
  context.snapshot = result.snapshot;
  return true;
}

function fail(context: ActionContext, code: string, message: string): void {
  context.diagnostics.push(issue(code, message));
  addTrace(context, { kind: 'diagnostic', source: { kind: 'engine', operation: 'action' }, reason: message, diagnosticCode: code });
}

function runLifecycle(
  context: ActionContext,
  nodeId: string,
  phase: 'entry' | 'revisit' | 'exit',
  source: TraceSource,
  reason: string,
  depth: number,
  occurrencesBefore: number,
): boolean {
  const node = context.world.nodes.find((candidate) => candidate.id === nodeId);
  const lifecycle = node?.lifecycle?.[phase];
  if (!lifecycle) return true;
  return shouldRunLifecycleEffects(lifecycle.policy, occurrencesBefore, occurrencesBefore > 0)
    ? runEffects(context, lifecycle.effects, source, `${reason} (${phase} lifecycle for ${nodeId})`, depth + 1)
    : true;
}

function navigate(context: ActionContext, edgeId: string, source: TraceSource, reason: string, depth: number): boolean {
  const edge = context.world.navigationEdges.find((candidate) => candidate.id === edgeId);
  const currentNodeId = context.snapshot.currentNodeId;
  if (!edge || edge.fromNodeId !== currentNodeId) {
    fail(context, INVALID_NAVIGATION, `Navigation edge ${edgeId} is not available from node ${currentNodeId}.`);
    return false;
  }
  const target = context.world.nodes.find((node) => node.id === edge.toNodeId);
  if (!target || !target.visitable) {
    fail(context, INVALID_NAVIGATION, `Navigation edge ${edgeId} does not lead to a visitable node.`);
    return false;
  }
  try {
    if (edge.condition && !conditionEnabled(context.world, context.snapshot, edge.condition)) {
      fail(context, INVALID_NAVIGATION, `Navigation edge ${edgeId} is blocked by its condition.`);
      return false;
    }
  } catch (error) {
    fail(context, INVALID_NAVIGATION, error instanceof Error ? `Navigation edge ${edgeId} has an invalid condition: ${error.message}` : `Navigation edge ${edgeId} has an invalid condition.`);
    return false;
  }

  const currentVisits = context.snapshot.nodeVisitCounts[currentNodeId] ?? 0;
  if (!runLifecycle(context, currentNodeId, 'exit', source, reason, depth, Math.max(0, currentVisits - 1))) return false;
  if (!applyRuleTransition(context, processRulePhase(context.world, context.snapshot, 'node-exit', source, reason))) return false;
  if (context.snapshot.currentNodeId !== currentNodeId) {
    fail(context, INVALID_NAVIGATION, `Exit effects changed the current node before navigation edge ${edgeId} was applied.`);
    return false;
  }
  const suspended = suspendForNavigation(context.snapshot, source, reason);
  if (!addTransitionTrace(context, suspended.trace)) { fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`); return false; }
  if (suspended.diagnostics.length > 0) { context.diagnostics.push(...suspended.diagnostics); return false; }
  context.snapshot = suspended.snapshot;
  const fromNodeId = context.snapshot.currentNodeId;
  const previousVisits = context.snapshot.nodeVisitCounts[target.id] ?? 0;
  if (previousVisits >= Number.MAX_SAFE_INTEGER) {
    fail(context, BUDGET_EXCEEDED, `Visit count for node ${target.id} exceeds the safe integer limit.`);
    return false;
  }
  const nextVisits = previousVisits + 1;
  const phase = previousVisits === 0 ? 'entry' : 'revisit';
  context.didNavigate = true;
  context.snapshot = {
    ...context.snapshot,
    currentNodeId: target.id,
    nodeVisitCounts: { ...context.snapshot.nodeVisitCounts, [target.id]: nextVisits },
  };
  addTrace(context, { kind: 'node-transition', source, reason, fromNodeId, toNodeId: target.id });
  const lifecycleOccurrences = phase === 'entry' ? previousVisits : Math.max(0, previousVisits - 1);
  if (!runLifecycle(context, target.id, phase, source, reason, depth, lifecycleOccurrences)) return false;
  const rulePhase = phase === 'entry' ? 'node-entry' : 'node-revisit';
  return applyRuleTransition(context, processRulePhase(context.world, context.snapshot, rulePhase, source, reason));
}

function runEffects(context: ActionContext, effects: readonly Effect[], source: TraceSource, reason: string, depth: number): boolean {
  if (depth > 64) { fail(context, BUDGET_EXCEEDED, 'Nested lifecycle navigation exceeded its depth budget.'); return false; }
  for (const effect of effects) {
    context.effectCount += 1;
    if (context.effectCount > MAX_EFFECTS_PER_ACTION) { fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_EFFECTS_PER_ACTION} effect budget.`); return false; }
    if (effect.kind === 'emit-event') {
      if (!addTrace(context, { kind: 'effect-request', source, reason, effect: structuredClone(effect) })) {
        fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
        return false;
      }
      context.events.push({ eventId: effect.eventId, payload: effect.payload, source: source.kind === 'action' ? `action:${source.actionId}` : `${source.kind}:${'ruleId' in source ? source.ruleId : 'lifecycle'}` });
      continue;
    }
    if (effect.kind === 'use-item') {
      if (!addTrace(context, { kind: 'effect-request', source, reason, effect: structuredClone(effect) })) {
        fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
        return false;
      }
      const used = applyInventoryEffect(context.world, context.snapshot, effect);
      if (!used.ok || !used.event) {
        context.diagnostics.push(...(used.diagnostics.length > 0 ? used.diagnostics : [issue(INVALID_ACTION, 'Inventory use did not produce its declared event.')]));
        addTrace(context, { kind: 'diagnostic', source, reason: context.diagnostics.at(-1)!.message, diagnosticCode: context.diagnostics.at(-1)!.code });
        return false;
      }
      context.snapshot = used.snapshot;
      context.events.push(used.event);
      continue;
    }
    if (effect.kind === 'navigate') {
      if (!addTrace(context, { kind: 'effect-request', source, reason, effect: structuredClone(effect) })) {
        fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
        return false;
      }
      if (!navigate(context, effect.edgeId, source, reason, depth)) return false;
      continue;
    }
    const dialogue = applyDialogueEffect(
      context.world, context.snapshot, effect, source, reason,
      (condition, snapshot, event) => evaluateConditionValue(context.world, snapshot, condition, event),
    );
    if (dialogue) {
      if (!applyRuleTransition(context, dialogue)) return false;
      continue;
    }
    const reduced = reduceEffects(context.world, context.snapshot, [effect], source, reason);
    context.snapshot = reduced.snapshot;
    if (!addTransitionTrace(context, reduced.trace)) { fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`); return false; }
    if (reduced.diagnostics.diagnostics.length > 0) {
      context.diagnostics.push(...reduced.diagnostics.diagnostics);
      return false;
    }
  }
  const completed = completeTerminalConversation(context.world, context.snapshot, source, reason);
  context.snapshot = completed.snapshot;
  if (!addTransitionTrace(context, completed.trace)) {
    fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
    return false;
  }
  return true;
}

function finishAction(context: ActionContext, advanceTime = true): TransitionResult {
  if (context.diagnostics.length > 0) return transition(context.original, context.trace, context.diagnostics);
  if (context.events.length > 0) {
    const rules = processEventQueue(context.world, context.snapshot, context.events, { kind: 'engine', operation: 'action-event-queue' }, 'Events emitted during the action.');
    if (!addTransitionTrace(context, rules.trace)) {
      fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
      return transition(context.original, context.trace, context.diagnostics);
    }
    if (rules.diagnostics.diagnostics.length > 0) return transition(context.original, context.trace, rules.diagnostics.diagnostics);
    context.snapshot = rules.snapshot;
  }
  if (!advanceTime) return transition(context.snapshot, context.trace, context.diagnostics);
  const timeAdvance = advanceActionTime(
    context.world,
    context.snapshot,
    { kind: 'engine', operation: 'accepted-action-time' },
    'Per-action game time advanced after the action committed its effects.',
  );
  if (!addTransitionTrace(context, timeAdvance.trace)) {
    fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
    return transition(context.original, context.trace, context.diagnostics);
  }
  if (timeAdvance.diagnostics.diagnostics.length > 0) {
    return transition(context.original, context.trace, timeAdvance.diagnostics.diagnostics);
  }
  const timeAdvanced = timeAdvance.snapshot.gameTimeMilliseconds !== context.snapshot.gameTimeMilliseconds;
  context.snapshot = timeAdvance.snapshot;
  if (timeAdvanced) {
    const timedRules = processRulePhase(context.world, context.snapshot, 'time-advanced', { kind: 'engine', operation: 'action-time-advanced' }, 'Per-action game time advanced.');
    if (!applyRuleTransition(context, timedRules)) return transition(context.original, context.trace, context.diagnostics);
  }
  if (context.didNavigate) {
    const resumed = resumeOnReturn(
      context.world, context.snapshot, { kind: 'engine', operation: 'resume-conversation-on-return' },
      (condition, current, event) => evaluateConditionValue(context.world, current, condition, event),
    );
    if (!addTransitionTrace(context, resumed.trace)) {
      fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
      return transition(context.original, context.trace, context.diagnostics);
    }
    if (resumed.diagnostics.diagnostics.length > 0) {
      context.diagnostics.push(...resumed.diagnostics.diagnostics);
      return transition(context.original, context.trace, context.diagnostics);
    }
    context.snapshot = resumed.snapshot;
  }
  return transition(context.snapshot, context.trace, context.diagnostics);
}

function validParameters(command: CommandDefinition, parameters: Readonly<Record<string, Scalar>>): boolean {
  const expected = new Map(command.parameters.map((parameter) => [parameter.id, parameter.valueType]));
  const provided = Object.keys(parameters);
  if (provided.length !== expected.size || provided.some((key) => !expected.has(key))) return false;
  return command.parameters.every((parameter) => {
    const value = parameters[parameter.id];
    if (value === undefined) return false;
    if (typeof parameter.valueType === 'string') {
      switch (parameter.valueType) {
        case 'string': return typeof value === 'string';
        case 'boolean': return typeof value === 'boolean';
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
      }
    }
    return typeof value === 'string' && parameter.valueType.values.includes(value);
  });
}

export function dispatchAction(world: WorldDocument, snapshot: SessionSnapshot, input: ActionInput): TransitionResult {
  const actionSet = actionSets(world, snapshot);
  let effects: readonly Effect[];
  let navigationEdgeId: string | undefined;
  let actionId: string;
  if (input.kind === 'choice') {
    const choice = actionSet.choices.find((candidate) => candidate.id === input.actionId);
    if (!choice) return transition(snapshot, [], [issue(INVALID_ACTION, `Choice ${input.actionId} is unavailable at node ${snapshot.currentNodeId}.`)]);
    let enabled: boolean;
    try { enabled = conditionEnabled(world, snapshot, choice.condition); }
    catch (error) { return transition(snapshot, [], [issue(INVALID_ACTION, error instanceof Error ? `Choice ${choice.id} has an invalid condition: ${error.message}` : `Choice ${choice.id} has an invalid condition.`)]); }
    if (!enabled) return transition(snapshot, [], [issue(INVALID_ACTION, `Choice ${choice.id} is disabled.`)]);
    effects = choice.effects;
    navigationEdgeId = choice.navigationEdgeId;
    actionId = choice.id;
  } else {
    const command = actionSet.commands.find((candidate) => candidate.id === input.actionId);
    if (!command || !validParameters(command, input.parameters)) {
      return transition(snapshot, [], [issue(INVALID_ACTION, `Command ${input.actionId} is unavailable or has invalid parameters.`)]);
    }
    let enabled: boolean;
    try { enabled = conditionEnabled(world, snapshot, command.condition); }
    catch (error) { return transition(snapshot, [], [issue(INVALID_ACTION, error instanceof Error ? `Command ${command.id} has an invalid condition: ${error.message}` : `Command ${command.id} has an invalid condition.`)]); }
    if (!enabled) return transition(snapshot, [], [issue(INVALID_ACTION, `Command ${command.id} is disabled.`)]);
    effects = command.effects;
    navigationEdgeId = command.navigationEdgeId;
    actionId = command.id;
  }
  const source: TraceSource = { kind: 'action', actionId };
  const context: ActionContext = { world, original: snapshot, snapshot, trace: [], diagnostics: [], events: [], effectCount: 0, didNavigate: false };
  addTrace(context, { kind: 'action', source, reason: `Player selected action ${actionId}.` });
  if (!applyRuleTransition(context, processRulePhase(world, context.snapshot, 'action-start', source, `Action ${actionId} starts.`))) return finishAction(context);
  if (!runEffects(context, effects, source, `Effects for action ${actionId}.`, 0)) return finishAction(context);
  if (navigationEdgeId && !navigate(context, navigationEdgeId, source, `Action ${actionId} navigates by edge ${navigationEdgeId}.`, 0)) return finishAction(context);
  return finishAction(context);
}

/** Applies the entry/revisit lifecycle when a newly created session enters its starting node. */
export function enterSessionNode(world: WorldDocument, snapshot: SessionSnapshot): TransitionResult {
  const node = world.nodes.find((candidate) => candidate.id === snapshot.currentNodeId);
  if (!node || !node.visitable) return transition(snapshot, [], [issue(INVALID_NAVIGATION, `Starting node ${snapshot.currentNodeId} is missing or nonvisitable.`)]);
  const source: TraceSource = { kind: 'engine', operation: 'session-entry' };
  const context: ActionContext = { world, original: snapshot, snapshot, trace: [], diagnostics: [], events: [], effectCount: 0, didNavigate: false };
  const previousVisits = context.snapshot.nodeVisitCounts[node.id] ?? 0;
  if (previousVisits >= Number.MAX_SAFE_INTEGER) return transition(snapshot, [], [issue(BUDGET_EXCEEDED, `Visit count for node ${node.id} exceeds the safe integer limit.`)]);
  const phase = previousVisits === 0 ? 'entry' : 'revisit';
  context.snapshot = {
    ...context.snapshot,
    nodeVisitCounts: { ...context.snapshot.nodeVisitCounts, [node.id]: previousVisits + 1 },
  };
  addTrace(context, {
    kind: 'node-transition', source, reason: `Session enters starting node ${node.id}.`, toNodeId: node.id,
  });
  const occurrenceCount = phase === 'entry' ? previousVisits : Math.max(0, previousVisits - 1);
  if (!runLifecycle(context, node.id, phase, source, `Session enters starting node ${node.id}.`, 0, occurrenceCount)) return finishAction(context, false);
  const rulePhase = phase === 'entry' ? 'node-entry' : 'node-revisit';
  if (!applyRuleTransition(context, processRulePhase(world, context.snapshot, rulePhase, source, `Session enters starting node ${node.id}.`))) return finishAction(context, false);
  return finishAction(context, false);
}

function inputTransition(snapshot: SessionSnapshot, resolution: PlayerInputResolution, transitionResult: TransitionResult): PlayerInputTransitionResult {
  return Object.freeze({ ...transitionResult, resolution });
}

function dispatchInventoryInput(world: WorldDocument, snapshot: SessionSnapshot, operation: Extract<PlayerInput, { kind: 'inventory' }>['operation']): PlayerInputTransitionResult {
  const effect = inventoryOperationEffect(operation);
  if (!effect) {
    const diagnostic = issue(INVALID_INPUT, 'Inventory input does not match a supported operation shape.');
    return inputTransition(snapshot, { kind: 'invalid-inventory-input', diagnostic }, transition(snapshot, [], [diagnostic]));
  }
  const actionId = `inventory-${operation.kind}`;
  const source: TraceSource = { kind: 'action', actionId };
  const context: ActionContext = { world, original: snapshot, snapshot, trace: [], diagnostics: [], events: [], effectCount: 0, didNavigate: false };
  addTrace(context, { kind: 'action', source, reason: `Player requested inventory operation ${operation.kind}.` });
  if (!applyRuleTransition(context, processRulePhase(world, context.snapshot, 'action-start', source, `Inventory ${operation.kind} starts.`))) {
    const result = finishAction(context);
    return inputTransition(snapshot, { kind: 'invalid-inventory-input', diagnostic: result.diagnostics.diagnostics[0]! }, result);
  }
  if (!runEffects(context, [effect], source, `Inventory ${operation.kind} operation.`, 0)) {
    const result = finishAction(context);
    return inputTransition(snapshot, { kind: 'invalid-inventory-input', diagnostic: result.diagnostics.diagnostics[0]! }, result);
  }
  const result = finishAction(context);
  const diagnostic = result.diagnostics.diagnostics[0];
  if (diagnostic) return inputTransition(snapshot, { kind: 'invalid-inventory-input', diagnostic }, result);
  return inputTransition(snapshot, { kind: 'inventory', operation }, result);
}

export function dispatchPlayerInput(world: WorldDocument, snapshot: SessionSnapshot, input: PlayerInput): PlayerInputTransitionResult {
  if (input.kind === 'inventory') return dispatchInventoryInput(world, snapshot, input.operation);
  if (input.kind === 'choice') {
    const choice = actionSets(world, snapshot).choices.find((candidate) => candidate.id === input.actionId);
    if (choice && choice.falsePolicy === 'disable') {
      try {
        if (!conditionEnabled(world, snapshot, choice.condition)) {
          return inputTransition(snapshot, { kind: 'disabled', actionId: choice.id, reason: `Choice ${choice.id} is disabled.` }, transition(snapshot, [], []));
        }
      } catch { /* dispatchAction returns the actionable condition diagnostic below. */ }
    }
    const result = dispatchAction(world, snapshot, input);
    const diagnostic = result.diagnostics.diagnostics[0];
    if (diagnostic) return inputTransition(snapshot, { kind: 'invalid-input', diagnostic }, result);
    return inputTransition(snapshot, { kind: 'choice', actionId: input.actionId }, result);
  }
  if (input.kind === 'dialogue-option') {
    const actionId = `dialogue-${input.optionId}`;
    const source: TraceSource = { kind: 'action', actionId };
    const context: ActionContext = { world, original: snapshot, snapshot, trace: [], diagnostics: [], events: [], effectCount: 0, didNavigate: false };
    addTrace(context, { kind: 'action', source, reason: `Player selected dialogue option ${input.optionId}.` });
    if (!applyRuleTransition(context, processRulePhase(world, context.snapshot, 'action-start', source, `Dialogue option ${input.optionId} starts.`))) {
      const result = finishAction(context);
      return inputTransition(snapshot, { kind: 'invalid-dialogue-option', diagnostic: result.diagnostics.diagnostics[0]! }, result);
    }
    const prepared = prepareDialogueOption(
      world, context.snapshot, input, source,
      (condition, current, event) => evaluateConditionValue(world, current, condition, event),
    );
    if (prepared.kind === 'invalid') {
      const rejected = transition(snapshot, [{
        sequence: 0, kind: 'diagnostic', source, reason: prepared.diagnostic.message,
        diagnosticCode: prepared.diagnostic.code,
      }], [prepared.diagnostic]);
      return inputTransition(snapshot, { kind: 'invalid-dialogue-option', diagnostic: prepared.diagnostic }, rejected);
    }
    if (prepared.kind === 'disabled') {
      return inputTransition(snapshot, {
        kind: 'dialogue-option-disabled', conversationId: input.conversationId,
        lineId: input.lineId, optionId: input.optionId, disabledReason: prepared.disabledReason,
      }, transition(snapshot, [], []));
    }
    context.snapshot = prepared.operation.snapshot;
    if (!addTransitionTrace(context, prepared.operation.trace)) {
      fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
      const result = finishAction(context);
      return inputTransition(snapshot, { kind: 'invalid-dialogue-option', diagnostic: result.diagnostics.diagnostics[0]! }, result);
    }
    if (!runEffects(context, prepared.option.effects, source, `Effects for dialogue option ${input.optionId}.`, 0)) {
      const result = finishAction(context);
      return inputTransition(snapshot, { kind: 'invalid-dialogue-option', diagnostic: result.diagnostics.diagnostics[0]! }, result);
    }
    const completed = completeTerminalConversation(world, context.snapshot, source, `Dialogue option ${input.optionId} effects completed.`);
    context.snapshot = completed.snapshot;
    if (!addTransitionTrace(context, completed.trace)) {
      fail(context, BUDGET_EXCEEDED, `Action exceeded the ${MAX_TRACE_RECORDS} trace budget.`);
      const result = finishAction(context);
      return inputTransition(snapshot, { kind: 'invalid-dialogue-option', diagnostic: result.diagnostics.diagnostics[0]! }, result);
    }
    const result = finishAction(context);
    const diagnostic = result.diagnostics.diagnostics[0];
    if (diagnostic) return inputTransition(snapshot, { kind: 'invalid-dialogue-option', diagnostic }, result);
    return inputTransition(snapshot, {
      kind: 'dialogue-option', conversationId: input.conversationId, lineId: input.lineId, optionId: input.optionId,
    }, result);
  }
  const matched = matchCommandText(world, snapshot, input.rawText);
  if (matched.kind === 'invalid-input') return inputTransition(snapshot, matched, transition(snapshot, [], [matched.diagnostic]));
  if (matched.kind === 'no-match' || matched.kind === 'ambiguous') return inputTransition(snapshot, matched, transition(snapshot, [], []));
  const command = actionSets(world, snapshot).commands.find((candidate) => candidate.id === matched.action.actionId);
  if (!command) {
    const diagnostic = issue(INVALID_ACTION, `Command ${matched.action.actionId} is no longer available.`);
    return inputTransition(snapshot, { kind: 'invalid-input', diagnostic }, transition(snapshot, [], [diagnostic]));
  }
  let enabled: boolean;
  try { enabled = conditionEnabled(world, snapshot, command.condition); }
  catch (error) {
    const diagnostic = issue(INVALID_ACTION, error instanceof Error ? `Command ${command.id} has an invalid condition: ${error.message}` : `Command ${command.id} has an invalid condition.`);
    return inputTransition(snapshot, { kind: 'invalid-input', diagnostic }, transition(snapshot, [], [diagnostic]));
  }
  if (!enabled) {
    const resolution: PlayerInputResolution = { kind: 'disabled', actionId: command.id, reason: `Command ${command.id} is disabled.` };
    return inputTransition(snapshot, resolution, transition(snapshot, [], []));
  }
  const action = matched.action;
  const result = dispatchAction(world, snapshot, action);
  const diagnostic = result.diagnostics.diagnostics[0];
  if (diagnostic) return inputTransition(snapshot, { kind: 'invalid-input', diagnostic }, result);
  return inputTransition(snapshot, { kind: 'command', action, normalizedText: matched.normalizedText }, result);
}
