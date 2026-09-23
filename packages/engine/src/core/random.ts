import type {
  Diagnostic, GameEngineHost, RandomOutcome, RandomOutcomeRequest, RandomOutcomeReplaySource,
  RandomSeedSource, ScriptId, SessionSnapshot, TransitionTraceRecord, UnseededRandomOutcome,
  WorldDocument,
} from '@dungeon-scrivener/model';

export const ZERO_SEED_REPLACEMENT = 0x6d2b79f5;
export const MAX_UNSEEDED_OUTCOMES = 16_384;

export interface RandomDrawSuccess {
  readonly ok: true;
  readonly value: number;
  readonly snapshot: SessionSnapshot;
  readonly trace: readonly TransitionTraceRecord[];
}

export interface RandomDrawFailure {
  readonly ok: false;
  readonly snapshot: SessionSnapshot;
  readonly diagnostic: Diagnostic;
  readonly trace: readonly TransitionTraceRecord[];
}

export type RandomDrawResult = RandomDrawSuccess | RandomDrawFailure;

function failure(snapshot: SessionSnapshot, message: string, sourceScriptId: ScriptId, ordinal: number): RandomDrawFailure {
  const diagnostic: Diagnostic = { code: 'DS-ENG-012', severity: 'error', message, blocks: ['play', 'script-execution'] };
  const trace: TransitionTraceRecord = {
    sequence: ordinal, kind: 'diagnostic', source: { kind: 'script', scriptId: sourceScriptId }, reason: message, diagnosticCode: diagnostic.code,
  };
  return { ok: false, snapshot, diagnostic, trace: [trace] };
}

function success(snapshot: SessionSnapshot, value: number, outcome: RandomOutcome, reason: string): RandomDrawSuccess {
  const trace: TransitionTraceRecord = {
    sequence: outcome.ordinal,
    kind: 'random',
    source: { kind: 'script', scriptId: outcome.sourceScriptId },
    reason,
    randomOutcome: outcome,
  };
  return { ok: true, value, snapshot, trace: [trace] };
}

function validUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function xorshift32(seed: number): number {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function nextRaw(snapshot: SessionSnapshot, host: Pick<GameEngineHost, 'unseededRandomSource'>, sourceScriptId: ScriptId, ordinal: number):
  | { readonly ok: true; readonly value: number; readonly randomSeed?: number }
  | { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (snapshot.randomnessMode === 'seeded') {
    if (snapshot.randomSeed === null || !validUint32(snapshot.randomSeed)) {
      return { ok: false, diagnostic: { code: 'DS-ENG-012', severity: 'error', message: 'Seeded session has no valid current random seed.', blocks: ['play', 'script-execution'] } };
    }
    const randomSeed = xorshift32(snapshot.randomSeed);
    return { ok: true, value: randomSeed, randomSeed };
  }
  const source = host.unseededRandomSource;
  if (!source) return { ok: false, diagnostic: { code: 'DS-ENG-012', severity: 'error', message: 'Unseeded random call requires an entropy or replay source.', blocks: ['play', 'script-execution'] } };
  try {
    const value = source.nextUint32();
    if (!validUint32(value)) return { ok: false, diagnostic: { code: 'DS-ENG-012', severity: 'error', message: 'Entropy source returned a value outside the uint32 range.', blocks: ['play', 'script-execution'] } };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, diagnostic: { code: 'DS-ENG-012', severity: 'error', message: error instanceof Error ? `Entropy source failed: ${error.message}` : 'Entropy source failed.', blocks: ['play', 'script-execution'] } };
  }
}

function requestFor(snapshot: SessionSnapshot, sourceScriptId: ScriptId, operation: 'float' | 'integer', minimum?: number, maximum?: number): RandomOutcomeRequest {
  return {
    ordinal: snapshot.randomOutcomes.length,
    sourceScriptId,
    operation,
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

function matchesReplay(outcome: UnseededRandomOutcome, request: RandomOutcomeRequest): boolean {
  return outcome.provider === 'unseeded'
    && outcome.ordinal === request.ordinal
    && outcome.sourceScriptId === request.sourceScriptId
    && outcome.operation === request.operation
    && outcome.minimum === request.minimum
    && outcome.maximum === request.maximum;
}

function replayValue(
  replay: RandomOutcomeReplaySource,
  request: RandomOutcomeRequest,
  validValue: (value: number) => boolean,
): UnseededRandomOutcome | undefined {
  try {
    const outcome = replay.nextOutcome(request);
    if (!outcome || !matchesReplay(outcome, request) || !validValue(outcome.value)) return undefined;
    return outcome;
  } catch {
    return undefined;
  }
}

function commitDraw(snapshot: SessionSnapshot, rawValues: readonly number[], request: RandomOutcomeRequest, value: number, seededOrdinal: number): RandomDrawSuccess | RandomDrawFailure {
  if (snapshot.randomnessMode === 'seeded') {
    const randomSeed = rawValues.at(-1);
    if (randomSeed === undefined) return failure(snapshot, 'Seeded random operation produced no raw draws.', request.sourceScriptId, seededOrdinal);
    const outcome: RandomOutcome = {
      ...request, ordinal: seededOrdinal, provider: 'seeded', value,
    };
    return success({ ...snapshot, randomSeed }, value, outcome, `Seeded ${request.operation} random outcome committed.`);
  }
  if (snapshot.randomOutcomes.length >= MAX_UNSEEDED_OUTCOMES) {
    return failure(snapshot, `Unseeded random history reached the ${MAX_UNSEEDED_OUTCOMES} outcome limit.`, request.sourceScriptId, request.ordinal);
  }
  const outcome: UnseededRandomOutcome = {
    ...request, provider: 'unseeded', value,
  };
  const next = { ...snapshot, randomOutcomes: [...snapshot.randomOutcomes, outcome] };
  return success(next, value, outcome, `Unseeded ${request.operation} random outcome recorded for replay.`);
}

/** Draws a [0, 1) random float using the session mode, host entropy, or replay transcript. */
export function drawRandomFloat(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  sourceScriptId: ScriptId,
  host: Pick<GameEngineHost, 'unseededRandomSource' | 'unseededRandomReplaySource'>,
  seededOrdinal = 0,
): RandomDrawResult {
  if (snapshot.randomnessMode !== world.settings.randomness.mode) return failure(snapshot, 'Session randomness mode does not match the supplied world.', sourceScriptId, seededOrdinal);
  const request = requestFor(snapshot, sourceScriptId, 'float');
  if (snapshot.randomnessMode === 'unseeded' && snapshot.randomOutcomes.length >= MAX_UNSEEDED_OUTCOMES) {
    return failure(snapshot, `Unseeded random history reached the ${MAX_UNSEEDED_OUTCOMES} outcome limit.`, sourceScriptId, request.ordinal);
  }
  if (snapshot.randomnessMode === 'unseeded' && host.unseededRandomReplaySource) {
    const replayed = replayValue(host.unseededRandomReplaySource, request, (value) => Number.isFinite(value) && value >= 0 && value < 1);
    if (!replayed) return failure(snapshot, 'Unseeded random replay transcript is exhausted, mismatched, or invalid.', sourceScriptId, request.ordinal);
    return commitDraw(snapshot, [], request, replayed.value, seededOrdinal);
  }
  const raw = nextRaw(snapshot, host, sourceScriptId, request.ordinal);
  if (!raw.ok) return { ok: false, snapshot, diagnostic: raw.diagnostic, trace: [{ sequence: request.ordinal, kind: 'diagnostic', source: { kind: 'script', scriptId: sourceScriptId }, reason: raw.diagnostic.message, diagnosticCode: raw.diagnostic.code }] };
  const value = raw.value / 0x1_0000_0000;
  return commitDraw(snapshot, [raw.value], request, value, seededOrdinal);
}

/** Draws an inclusive integer in [minimum, maximum] using bounded rejection sampling. */
export function drawRandomInt(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  sourceScriptId: ScriptId,
  minimum: number,
  maximum: number,
  host: Pick<GameEngineHost, 'unseededRandomSource' | 'unseededRandomReplaySource'>,
  seededOrdinal = 0,
): RandomDrawResult {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
    return failure(snapshot, 'Random integer bounds must be ordered safe integers.', sourceScriptId, seededOrdinal);
  }
  const range = maximum - minimum + 1;
  if (!Number.isSafeInteger(range) || range < 1 || range > 0x1_0000_0000) {
    return failure(snapshot, 'Random integer range must contain between one and 2^32 values.', sourceScriptId, seededOrdinal);
  }
  if (snapshot.randomnessMode !== world.settings.randomness.mode) return failure(snapshot, 'Session randomness mode does not match the supplied world.', sourceScriptId, seededOrdinal);
  const request = requestFor(snapshot, sourceScriptId, 'integer', minimum, maximum);
  if (snapshot.randomnessMode === 'unseeded' && snapshot.randomOutcomes.length >= MAX_UNSEEDED_OUTCOMES) {
    return failure(snapshot, `Unseeded random history reached the ${MAX_UNSEEDED_OUTCOMES} outcome limit.`, sourceScriptId, request.ordinal);
  }
  const validValue = (value: number) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  if (snapshot.randomnessMode === 'unseeded' && host.unseededRandomReplaySource) {
    const replayed = replayValue(host.unseededRandomReplaySource, request, validValue);
    if (!replayed) return failure(snapshot, 'Unseeded random replay transcript is exhausted, mismatched, or invalid.', sourceScriptId, request.ordinal);
    return commitDraw(snapshot, [], request, replayed.value, seededOrdinal);
  }

  const limit = 0x1_0000_0000 - (0x1_0000_0000 % range);
  const rawValues: number[] = [];
  let workingSnapshot = snapshot;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const raw = nextRaw(workingSnapshot, host, sourceScriptId, request.ordinal);
    if (!raw.ok) return { ok: false, snapshot, diagnostic: raw.diagnostic, trace: [{ sequence: request.ordinal, kind: 'diagnostic', source: { kind: 'script', scriptId: sourceScriptId }, reason: raw.diagnostic.message, diagnosticCode: raw.diagnostic.code }] };
    rawValues.push(raw.value);
    if (raw.randomSeed !== undefined) workingSnapshot = { ...snapshot, randomSeed: raw.randomSeed };
    if (raw.value < limit) {
      const value = minimum + (raw.value % range);
      return commitDraw(snapshot, rawValues, request, value, seededOrdinal);
    }
  }
  return failure(snapshot, 'Random integer request exceeded 64 raw draws without an unbiased result.', sourceScriptId, request.ordinal);
}

/** Validates a host seed without substituting entropy or a fallback value. */
export function obtainSeed(supplied: number | undefined, source: RandomSeedSource | undefined): number | undefined {
  const candidate = supplied === undefined ? source?.nextUint32() : supplied;
  if (candidate === undefined || !validUint32(candidate)) return undefined;
  return candidate === 0 ? ZERO_SEED_REPLACEMENT : candidate;
}
