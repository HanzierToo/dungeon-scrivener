import type {
  ClockInput, Diagnostic, PageVisibility, SessionSnapshot, TraceSource, TransitionResult, TransitionTraceRecord, WorldDocument,
} from '@dungeon-scrivener/model';
import { processRulePhase } from './rules.js';

const INVALID_TIME = 'DS-ENG-010';
const INVALID_CLOCK = 'DS-ENG-011';

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function result(snapshot: SessionSnapshot, trace: readonly TransitionTraceRecord[], diagnostics: readonly Diagnostic[] = []): TransitionResult {
  const report = freezeDeep({ format: 'dungeon-scrivener-diagnostics' as const, schemaVersion: 1 as const, diagnostics: [...diagnostics] });
  return Object.freeze({ snapshot, trace: freezeDeep(structuredClone(trace)), diagnostics: report });
}

function issue(code: string, message: string): Diagnostic {
  return { code, severity: 'error', message, blocks: ['play'] };
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isActive(visibility: PageVisibility, focused: boolean): boolean {
  return visibility === 'visible' && focused;
}

function addTime(snapshot: SessionSnapshot, creditedMilliseconds: number): SessionSnapshot | undefined {
  const nextTime = snapshot.gameTimeMilliseconds + creditedMilliseconds;
  if (!Number.isSafeInteger(nextTime) || nextTime < 0) return undefined;
  return { ...snapshot, gameTimeMilliseconds: nextTime };
}

/** Adds authored per-action time after the enclosing action and all its effects succeed. */
export function advanceActionTime(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  source: TraceSource,
  reason: string,
): TransitionResult {
  if (world.settings.time.mode !== 'per-action') return result(snapshot, []);
  const amount = world.settings.time.millisecondsPerAction;
  if (!Number.isSafeInteger(amount) || amount! <= 0) {
    return result(snapshot, [], [issue(INVALID_TIME, 'Per-action time must be a positive safe integer.')]);
  }
  const next = addTime(snapshot, amount!);
  if (!next) return result(snapshot, [], [issue(INVALID_TIME, 'Per-action time would exceed the safe integer game-time limit.')]);
  const trace: TransitionTraceRecord = {
    sequence: 0, kind: 'time', source: structuredClone(source), reason,
    before: snapshot.gameTimeMilliseconds, after: next.gameTimeMilliseconds,
  };
  return result(next, [trace]);
}

/** Applies one host-supplied elapsed-time observation without reading browser globals. */
export function observeClock(world: WorldDocument, snapshot: SessionSnapshot, input: ClockInput): TransitionResult {
  if (!['tick', 'visibility-change', 'focus-change', 'resume'].includes(input.kind) ||
      !validTimestamp(input.wallClockEpochMilliseconds) || (input.visibility !== 'visible' && input.visibility !== 'hidden') || typeof input.focused !== 'boolean') {
    return result(snapshot, [], [issue(INVALID_CLOCK, 'Clock input has an invalid timestamp, visibility, or focus value.')]);
  }
  if (!Number.isSafeInteger(world.settings.time.maxCatchUpMilliseconds) || world.settings.time.maxCatchUpMilliseconds < 0 || world.settings.time.maxCatchUpMilliseconds > 86_400_000) {
    return result(snapshot, [], [issue(INVALID_CLOCK, 'Maximum elapsed-time catch-up must be between zero and one day.')]);
  }
  const { wallClockEpochMilliseconds: now } = input;
  if (world.settings.time.mode === 'per-action') {
    const next: SessionSnapshot = {
      ...snapshot,
      clockState: {
        visibility: input.visibility, focused: input.focused,
        lastObservedEpochMilliseconds: null, inactiveSinceEpochMilliseconds: null,
      },
    };
    const trace: TransitionTraceRecord = {
      sequence: 0, kind: 'time', source: { kind: 'engine', operation: 'clock-observation' },
      reason: 'Clock activity flags observed; per-action game time does not use wall time.',
      before: snapshot.gameTimeMilliseconds, after: snapshot.gameTimeMilliseconds,
    };
    return result(next, [trace]);
  }

  const previous = snapshot.clockState.lastObservedEpochMilliseconds;
  if (previous === null || !validTimestamp(previous)) {
    return result(snapshot, [], [issue(INVALID_CLOCK, 'Elapsed-time session has no valid clock baseline.')]);
  }
  if (now < previous) return result(snapshot, [], [issue(INVALID_CLOCK, 'Clock timestamp is earlier than the persisted observation baseline.')]);
  if (now === previous) return result(snapshot, []);

  const delta = now - previous;
  const wasActive = isActive(snapshot.clockState.visibility, snapshot.clockState.focused);
  const isNowActive = isActive(input.visibility, input.focused);
  let credited = 0;
  if (input.kind === 'resume') {
    if (world.settings.time.hiddenBehavior === 'bounded-catch-up') {
      credited = Math.min(delta, world.settings.time.maxCatchUpMilliseconds);
    }
  } else if (wasActive) {
    credited = delta;
  } else if (isNowActive && world.settings.time.hiddenBehavior === 'bounded-catch-up') {
    credited = Math.min(delta, world.settings.time.maxCatchUpMilliseconds);
  }

  const nextTime = addTime(snapshot, credited);
  if (!nextTime) return result(snapshot, [], [issue(INVALID_CLOCK, 'Clock observation would exceed the safe integer game-time limit.')]);
  const inactiveSince = isNowActive
    ? null
    : (input.kind === 'resume' || wasActive ? now : snapshot.clockState.inactiveSinceEpochMilliseconds ?? now);
  const next: SessionSnapshot = {
    ...nextTime,
    clockState: {
      visibility: input.visibility,
      focused: input.focused,
      lastObservedEpochMilliseconds: now,
      inactiveSinceEpochMilliseconds: inactiveSince,
    },
  };
  const trace: TransitionTraceRecord = {
    sequence: 0, kind: 'time', source: { kind: 'engine', operation: 'clock-observation' },
    reason: input.kind === 'resume'
      ? `Elapsed-time session resumed after ${delta} wall-clock milliseconds; credited ${credited} game-time milliseconds.`
      : `Clock observation advanced ${credited} game-time milliseconds from ${delta} wall-clock milliseconds.`,
    before: snapshot.gameTimeMilliseconds, after: next.gameTimeMilliseconds,
  };
  const observed = result(next, [trace]);
  if (credited === 0) return observed;
  const rules = processRulePhase(world, next, 'time-advanced', { kind: 'engine', operation: 'elapsed-time-advanced' }, 'Elapsed game time advanced after a clock observation.');
  const combined = [...observed.trace, ...rules.trace].map((record, sequence) => ({ ...record, sequence }));
  if (rules.diagnostics.diagnostics.length > 0) return result(snapshot, combined, rules.diagnostics.diagnostics);
  return result(rules.snapshot, combined);
}

/** Read-only game-time projection for a clock HUD; wall-clock time is never exposed as game time. */
export function clockHudValue(world: WorldDocument, snapshot: SessionSnapshot): number | undefined {
  return world.settings.time.showClockHud ? snapshot.gameTimeMilliseconds : undefined;
}
