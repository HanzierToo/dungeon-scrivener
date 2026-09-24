import { evaluateConditionValue } from '../core/rules.js';
import type {
  Condition, ConversationDefinition, DialogueHistoryEntry, DialogueLine, DialogueOption, Effect,
  EventOccurrence, LocaleDocument, PlayerDialogueOptionView, PlayerDialogueView, PlayerInput,
  ProjectManifest, SavedConversationContext, SessionSnapshot, TraceSource, TransitionResult,
  TransitionTraceRecord, WorldDocument,
} from '@dungeon-scrivener/model';

export const MAX_DIALOGUE_HISTORY = 16_384;
export const MAX_SUSPENDED_CONVERSATIONS = 64;

const INVALID_DIALOGUE = 'DS-ENG-014';
const DIALOGUE_BUDGET = 'DS-ENG-015';
const UNAVAILABLE_OPTION = 'This option is unavailable.';

export type ConditionEvaluator = (
  condition: Condition,
  snapshot: SessionSnapshot,
  event?: EventOccurrence,
) => boolean;

interface DialogueOperation {
  readonly snapshot: SessionSnapshot;
  readonly trace: readonly TransitionTraceRecord[];
  readonly diagnostics: readonly import('@dungeon-scrivener/model').Diagnostic[];
}

export type DialogueOptionSelection =
  | { readonly kind: 'accepted'; readonly option: DialogueOption; readonly operation: DialogueOperation }
  | { readonly kind: 'disabled'; readonly disabledReason: string }
  | { readonly kind: 'invalid'; readonly diagnostic: import('@dungeon-scrivener/model').Diagnostic };

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function makeResult(
  snapshot: SessionSnapshot,
  trace: readonly TransitionTraceRecord[],
  diagnostics: readonly import('@dungeon-scrivener/model').Diagnostic[] = [],
): TransitionResult {
  const frozenTrace = freezeDeep(structuredClone(trace));
  const frozenDiagnostics = freezeDeep(structuredClone(diagnostics));
  return Object.freeze({
    snapshot: freezeDeep(snapshot),
    trace: frozenTrace,
    diagnostics: freezeDeep({ format: 'dungeon-scrivener-diagnostics' as const, schemaVersion: 1 as const, diagnostics: frozenDiagnostics }),
  });
}

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message, blocks: ['play' as const] };
}

function failure(snapshot: SessionSnapshot, source: TraceSource, reason: string, code = INVALID_DIALOGUE): DialogueOperation {
  return {
    snapshot,
    trace: [{ sequence: 0, kind: 'diagnostic', source, reason, diagnosticCode: code }],
    diagnostics: [diagnostic(code, reason)],
  };
}

function addHistory(snapshot: SessionSnapshot, entry: DialogueHistoryEntry): SessionSnapshot | undefined {
  if ((snapshot.dialogueHistory ?? []).length >= MAX_DIALOGUE_HISTORY) return undefined;
  return { ...snapshot, dialogueHistory: [...(snapshot.dialogueHistory ?? []), entry] };
}

function conversation(world: WorldDocument, conversationId: string): ConversationDefinition | undefined {
  return world.conversations.find((candidate) => candidate.id === conversationId);
}

function lineFor(definition: ConversationDefinition, lineId: string): DialogueLine | undefined {
  return definition.lines.find((candidate) => candidate.id === lineId);
}

function isTerminal(definition: ConversationDefinition, context: SavedConversationContext): boolean {
  const line = lineFor(definition, context.lineId);
  return Boolean(line && (!line.options || line.options.length === 0) && line.nextLineId === undefined);
}

function sameContext(left: SavedConversationContext, right: SavedConversationContext): boolean {
  return left.conversationId === right.conversationId && left.lineId === right.lineId && left.returnNodeId === right.returnNodeId;
}

interface ResolveResult {
  readonly context: SavedConversationContext | null;
  readonly snapshot: SessionSnapshot;
  readonly trace: readonly TransitionTraceRecord[];
  readonly diagnostic?: import('@dungeon-scrivener/model').Diagnostic;
}

function resolveLine(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  definition: ConversationDefinition,
  firstLineId: string,
  returnNodeId: string,
  source: TraceSource,
  reason: string,
  evaluate: ConditionEvaluator,
  event?: EventOccurrence,
): ResolveResult {
  let provisional = snapshot;
  const trace: TransitionTraceRecord[] = [];
  const visited = new Set<string>();
  let lineId: string | undefined = firstLineId;

  while (lineId !== undefined) {
    if (visited.has(lineId)) {
      return { context: null, snapshot, trace, diagnostic: diagnostic(INVALID_DIALOGUE, `Conversation ${definition.id} contains a conditional-line cycle at ${lineId}.`) };
    }
    visited.add(lineId);
    const line = lineFor(definition, lineId);
    if (!line) {
      return { context: null, snapshot, trace, diagnostic: diagnostic(INVALID_DIALOGUE, `Conversation ${definition.id} references missing line ${lineId}.`) };
    }

    let enabled = true;
    try {
      enabled = line.condition === undefined || evaluate(line.condition, provisional, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Line condition evaluation failed.';
      return { context: null, snapshot, trace, diagnostic: diagnostic(INVALID_DIALOGUE, `Line ${line.id}: ${message}`) };
    }
    if (!enabled) {
      lineId = line.nextLineId;
      continue;
    }

    const withHistory = addHistory(provisional, { kind: 'line-seen', conversationId: definition.id, lineId: line.id });
    if (!withHistory) {
      return { context: null, snapshot, trace, diagnostic: diagnostic(DIALOGUE_BUDGET, `Dialogue history exceeds ${MAX_DIALOGUE_HISTORY} entries.`) };
    }
    provisional = withHistory;
    trace.push({
      sequence: trace.length,
      kind: 'state-change',
      source,
      reason: `${reason} Line ${line.id} was seen.`,
    });

    if (line.options && line.options.length > 0) {
      return {
        context: { conversationId: definition.id, lineId: line.id, returnNodeId },
        snapshot: provisional,
        trace,
      };
    }
    if (line.nextLineId !== undefined) {
      lineId = line.nextLineId;
      continue;
    }
    return { context: { conversationId: definition.id, lineId: line.id, returnNodeId }, snapshot: provisional, trace };
  }
  return { context: null, snapshot: provisional, trace };
}

function resolvedContext(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  context: SavedConversationContext,
  source: TraceSource,
  reason: string,
  evaluate: ConditionEvaluator,
  event?: EventOccurrence,
): ResolveResult {
  const definition = conversation(world, context.conversationId);
  if (!definition) {
    return { context: null, snapshot, trace: [], diagnostic: diagnostic(INVALID_DIALOGUE, `Conversation ${context.conversationId} does not exist.`) };
  }
  return resolveLine(world, snapshot, definition, context.lineId, snapshot.currentNodeId, source, reason, evaluate, event);
}

function resultForControl(
  original: SessionSnapshot,
  provisional: SessionSnapshot,
  trace: readonly TransitionTraceRecord[],
  diagnostics: readonly import('@dungeon-scrivener/model').Diagnostic[],
): TransitionResult {
  return makeResult(diagnostics.length > 0 ? original : provisional, trace, diagnostics);
}

/** Applies one conversation effect inside the caller's existing provisional transaction. */
export function applyDialogueEffect(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  effect: Effect,
  source: TraceSource,
  reason: string,
  evaluate: ConditionEvaluator,
  event?: EventOccurrence,
): TransitionResult | undefined {
  if (effect.kind !== 'start-conversation' && effect.kind !== 'interrupt-conversation' && effect.kind !== 'resume-conversation') return undefined;

  const trace: TransitionTraceRecord[] = [{ sequence: 0, kind: 'effect-request', source, reason, effect: structuredClone(effect) }];
  const fail = (message: string, code = INVALID_DIALOGUE) => resultForControl(snapshot, snapshot, [...trace, {
    sequence: trace.length, kind: 'diagnostic' as const, source, reason: message, diagnosticCode: code,
  }], [diagnostic(code, message)]);
  let provisional = snapshot;

  if (effect.kind === 'start-conversation') {
    if ((provisional.activeConversation ?? null) !== null) return fail('A conversation is already active; interrupt or complete it before starting another.');
    const definition = conversation(world, effect.conversationId);
    if (!definition) return fail(`Conversation ${effect.conversationId} does not exist.`);
    const resolved = resolveLine(world, provisional, definition, definition.entryLineId, provisional.currentNodeId, source, reason, evaluate, event);
    if (resolved.diagnostic) return fail(resolved.diagnostic.message, resolved.diagnostic.code);
    if (resolved.context && provisional.conversationStack.some((context) => sameContext(context, resolved.context!))) {
      return fail(`Conversation ${resolved.context.conversationId} already exists as a suspended context.`);
    }
    const active = resolved.context && isTerminal(definition, resolved.context) ? null : resolved.context;
    provisional = { ...resolved.snapshot, activeConversation: active };
    trace.push(...resolved.trace.map((record) => ({ ...record, sequence: trace.length + record.sequence })));
    trace.push({ sequence: trace.length, kind: 'state-change', source, reason: `Conversation ${definition.id} started.` });
    return resultForControl(snapshot, provisional, trace, []);
  }

  if (effect.kind === 'interrupt-conversation') {
    const active = provisional.activeConversation ?? null;
    if (!active) return fail('There is no active conversation to interrupt.');
    const definition = conversation(world, active.conversationId);
    if (!definition || !definition.interruptible) return fail(`Conversation ${active.conversationId} cannot be interrupted.`);
    const suspendedActive = { ...active, returnNodeId: provisional.currentNodeId };
    if (provisional.conversationStack.some((context) => sameContext(context, suspendedActive))) {
      return fail(`Conversation ${active.conversationId} already exists as a suspended context.`);
    }
    if (provisional.conversationStack.length >= MAX_SUSPENDED_CONVERSATIONS) {
      return fail(`Suspended conversation stack exceeds ${MAX_SUSPENDED_CONVERSATIONS} contexts.`, DIALOGUE_BUDGET);
    }
    provisional = {
      ...provisional,
      activeConversation: null,
      conversationStack: [...provisional.conversationStack, suspendedActive],
    };
    trace.push({ sequence: trace.length, kind: 'state-change', source, reason: `Conversation ${active.conversationId} was suspended.` });
    return resultForControl(snapshot, provisional, trace, []);
  }

  const targetIndex = provisional.conversationStack.length - 1;
  const target = provisional.conversationStack[targetIndex];
  if (!target || target.conversationId !== effect.conversationId) {
    return fail(`Conversation ${effect.conversationId} is not the top suspended context.`);
  }
  const suspended = provisional.conversationStack.slice(0, targetIndex);
  provisional = { ...provisional, conversationStack: suspended };
  const active = provisional.activeConversation ?? null;
  if (active) {
    const activeDefinition = conversation(world, active.conversationId);
    if (!activeDefinition) return fail(`Active conversation ${active.conversationId} does not exist.`);
    if (isTerminal(activeDefinition, active)) {
      provisional = { ...provisional, activeConversation: null };
      trace.push({ sequence: trace.length, kind: 'state-change', source, reason: `Terminal conversation ${active.conversationId} completed.` });
    } else {
      if (!activeDefinition.interruptible) return fail(`Active conversation ${active.conversationId} cannot be suspended for resume.`);
      const suspendedActive = { ...active, returnNodeId: provisional.currentNodeId };
      if (provisional.conversationStack.some((context) => sameContext(context, suspendedActive))) {
        return fail(`Conversation ${active.conversationId} already exists as a suspended context.`);
      }
      if (provisional.conversationStack.length >= MAX_SUSPENDED_CONVERSATIONS) {
        return fail(`Suspended conversation stack exceeds ${MAX_SUSPENDED_CONVERSATIONS} contexts.`, DIALOGUE_BUDGET);
      }
      provisional = {
        ...provisional,
        activeConversation: null,
        conversationStack: [...provisional.conversationStack, suspendedActive],
      };
      trace.push({ sequence: trace.length, kind: 'state-change', source, reason: `Conversation ${active.conversationId} was suspended for resume.` });
    }
  }
  const resumed = resolvedContext(world, provisional, target, source, reason, evaluate, event);
  if (resumed.diagnostic) return fail(resumed.diagnostic.message, resumed.diagnostic.code);
  provisional = { ...resumed.snapshot, activeConversation: resumed.context };
  trace.push(...resumed.trace.map((record) => ({ ...record, sequence: trace.length + record.sequence })));
  trace.push({ sequence: trace.length, kind: 'state-change', source, reason: `Conversation ${target.conversationId} resumed.` });
  return resultForControl(snapshot, provisional, trace, []);
}

/** Suspends the active context as a navigation leaves its current node. */
export function suspendForNavigation(snapshot: SessionSnapshot, source: TraceSource, reason: string): DialogueOperation {
  const active = snapshot.activeConversation ?? null;
  if (!active) return { snapshot, trace: [], diagnostics: [] };
  const suspendedActive = { ...active, returnNodeId: snapshot.currentNodeId };
  if (snapshot.conversationStack.some((context) => sameContext(context, suspendedActive))) {
    return failure(snapshot, source, `Conversation ${active.conversationId} already exists as a suspended context.`);
  }
  if (snapshot.conversationStack.length >= MAX_SUSPENDED_CONVERSATIONS) {
    return failure(snapshot, source, `Suspended conversation stack exceeds ${MAX_SUSPENDED_CONVERSATIONS} contexts.`, DIALOGUE_BUDGET);
  }
  const next = {
    ...snapshot,
    activeConversation: null,
    conversationStack: [...snapshot.conversationStack, suspendedActive],
  };
  return {
    snapshot: freezeDeep(next),
    trace: freezeDeep([{ sequence: 0, kind: 'state-change' as const, source, reason: `${reason} Conversation ${active.conversationId} was suspended.` }]),
    diagnostics: [],
  };
}

/** Resumes the most recent matching context after destination node effects and rules complete. */
export function resumeOnReturn(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  source: TraceSource,
  evaluate: ConditionEvaluator,
): TransitionResult {
  if ((snapshot.activeConversation ?? null) !== null) return makeResult(snapshot, [], []);
  let index = -1;
  for (let candidate = snapshot.conversationStack.length - 1; candidate >= 0; candidate -= 1) {
    const context = snapshot.conversationStack[candidate]!;
    if (context.returnNodeId === snapshot.currentNodeId && conversation(world, context.conversationId)?.resumeOnReturn === true) {
      index = candidate;
      break;
    }
  }
  if (index < 0) return makeResult(snapshot, [], []);

  const target = snapshot.conversationStack[index]!;
  const withoutTarget = {
    ...snapshot,
    conversationStack: snapshot.conversationStack.filter((_context, candidateIndex) => candidateIndex !== index),
  };
  const sourceReason = `Conversation ${target.conversationId} automatically resumes on return to ${snapshot.currentNodeId}.`;
  const resolved = resolvedContext(world, withoutTarget, target, source, sourceReason, evaluate);
  if (resolved.diagnostic) return makeResult(snapshot, [{ sequence: 0, kind: 'diagnostic', source, reason: resolved.diagnostic.message, diagnosticCode: resolved.diagnostic.code }], [resolved.diagnostic]);
  let active = resolved.context;
  const trace = [...resolved.trace, {
    sequence: resolved.trace.length, kind: 'state-change' as const, source,
    reason: `Conversation ${target.conversationId} resumed on return.`,
  }];
  if (active) {
    const definition = conversation(world, active.conversationId);
    if (definition && isTerminal(definition, active)) {
      trace.push({ sequence: trace.length, kind: 'state-change', source, reason: `Terminal conversation ${active.conversationId} completed on return.` });
      active = null;
    }
  }
  return makeResult({ ...resolved.snapshot, activeConversation: active }, trace, []);
}

function localize(source: { readonly kind: 'literal'; readonly text: string } | { readonly kind: 'locale-key'; readonly key: string }, requested: LocaleDocument | undefined, fallback: LocaleDocument | undefined): string {
  if (source.kind === 'literal') return source.text;
  return requested?.strings[source.key] ?? fallback?.strings[source.key] ?? `[${source.key}]`;
}

/** Returns the localized dialogue projection without exposing mutable session state. */
export function projectDialogueView(
  manifest: Pick<ProjectManifest, 'defaultLocale'>,
  world: WorldDocument,
  locales: readonly LocaleDocument[],
  snapshot: SessionSnapshot,
  requestedLocale?: string,
): PlayerDialogueView | undefined {
  const active = snapshot.activeConversation ?? null;
  if (!active) return undefined;
  const definition = conversation(world, active.conversationId);
  const line = definition && lineFor(definition, active.lineId);
  if (!definition || !line) return undefined;
  const requested = locales.find((locale) => locale.locale === (requestedLocale ?? manifest.defaultLocale));
  const fallback = locales.find((locale) => locale.locale === manifest.defaultLocale);
  const speaker = world.entities.find((entity) => entity.id === line.speakerEntityId);
  const options: PlayerDialogueOptionView[] = [];
  for (const option of line.options ?? []) {
    let enabled = true;
    let conditionError = false;
    try { enabled = option.condition === undefined || evaluateConditionValue(world, snapshot, option.condition); }
    catch { enabled = false; conditionError = true; }
    if (!enabled && !conditionError && (option.falsePolicy ?? 'hide') === 'hide') continue;
    options.push({
      id: option.id,
      label: localize(option.text, requested, fallback),
      enabled,
      ...(!enabled ? { disabledReason: conditionError ? 'This option condition could not be evaluated.' : option.disabledReason ? localize(option.disabledReason, requested, fallback) : UNAVAILABLE_OPTION } : {}),
    });
  }
  return freezeDeep({
    conversationId: active.conversationId,
    lineId: line.id,
    speakerEntityId: line.speakerEntityId,
    speakerName: speaker ? localize(speaker.name, requested, fallback) : line.speakerEntityId,
    text: localize(line.text, requested, fallback),
    options: Object.freeze(options),
    canResume: snapshot.conversationStack.length > 0,
  });
}

function fallbackDisabledReason(option: DialogueOption): string {
  const reason = option.disabledReason;
  if (!reason) return UNAVAILABLE_OPTION;
  return reason.kind === 'literal' ? reason.text : `[${reason.key}]`;
}

/** Validates an option against the active line and prepares its history/line change. */
export function prepareDialogueOption(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  input: Extract<PlayerInput, { readonly kind: 'dialogue-option' }>,
  source: TraceSource,
  evaluate: ConditionEvaluator,
): DialogueOptionSelection {
  const active = snapshot.activeConversation ?? null;
  if (!active || active.conversationId !== input.conversationId || active.lineId !== input.lineId) {
    return { kind: 'invalid', diagnostic: diagnostic(INVALID_DIALOGUE, 'Dialogue option does not match the active conversation and line.') };
  }
  const definition = conversation(world, active.conversationId);
  const line = definition && lineFor(definition, active.lineId);
  const option = line?.options?.find((candidate) => candidate.id === input.optionId);
  if (!definition || !line || !option) {
    return { kind: 'invalid', diagnostic: diagnostic(INVALID_DIALOGUE, `Dialogue option ${input.optionId} is unavailable on line ${input.lineId}.`) };
  }
  let enabled = true;
  try { enabled = option.condition === undefined || evaluate(option.condition, snapshot); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Dialogue option condition evaluation failed.';
    return { kind: 'invalid', diagnostic: diagnostic(INVALID_DIALOGUE, `Option ${option.id}: ${message}`) };
  }
  if (!enabled) {
    if ((option.falsePolicy ?? 'hide') === 'hide') {
      return { kind: 'invalid', diagnostic: diagnostic(INVALID_DIALOGUE, `Dialogue option ${option.id} is hidden.`) };
    }
    return { kind: 'disabled', disabledReason: fallbackDisabledReason(option) };
  }

  let provisional = addHistory(snapshot, { kind: 'option-selected', conversationId: definition.id, lineId: line.id, optionId: option.id });
  if (!provisional) return { kind: 'invalid', diagnostic: diagnostic(DIALOGUE_BUDGET, `Dialogue history exceeds ${MAX_DIALOGUE_HISTORY} entries.`) };
  const trace: TransitionTraceRecord[] = [{
    sequence: 0, kind: 'state-change', source, reason: `Dialogue option ${option.id} was selected.`,
  }];
  const nextLineId = option.nextLineId ?? line.nextLineId;
  let nextActive: SavedConversationContext | null = null;
  if (nextLineId !== undefined) {
    const resolved = resolveLine(world, provisional, definition, nextLineId, snapshot.currentNodeId, source, `Dialogue option ${option.id} advances.`, evaluate);
    if (resolved.diagnostic) return { kind: 'invalid', diagnostic: resolved.diagnostic };
    provisional = resolved.snapshot;
    nextActive = resolved.context;
    trace.push(...resolved.trace.map((record) => ({ ...record, sequence: trace.length + record.sequence })));
  }
  provisional = { ...provisional, activeConversation: nextActive };
  return { kind: 'accepted', option, operation: { snapshot: freezeDeep(provisional), trace: freezeDeep(trace), diagnostics: [] } };
}

export function completeTerminalConversation(world: WorldDocument, snapshot: SessionSnapshot, source: TraceSource, reason: string): DialogueOperation {
  const active = snapshot.activeConversation ?? null;
  const definition = active && conversation(world, active.conversationId);
  if (!active || !definition || !isTerminal(definition, active)) return { snapshot, trace: [], diagnostics: [] };
  return {
    snapshot: freezeDeep({ ...snapshot, activeConversation: null }),
    trace: freezeDeep([{ sequence: 0, kind: 'state-change' as const, source, reason: `${reason} Terminal conversation ${active.conversationId} completed.` }]),
    diagnostics: [],
  };
}
