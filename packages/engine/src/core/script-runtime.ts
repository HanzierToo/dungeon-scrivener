import type {
  CompiledScriptBundle, Diagnostic, EventId, GameEngineHost, JsonRecord, ScriptEffect,
  ScriptExecutionCapabilities, ScriptExecutionLimits, ScriptExecutionTraceRecord, ScriptInvocationOrigin, ScriptIR, ScriptId,
  SessionSnapshot, StateReference, TraceSource, TransitionTraceRecord, WorldDocument,
} from '@dungeon-scrivener/model';
import { drawRandomFloat, drawRandomInt } from './random.js';

const MAX_ACTIVATIONS = 256;
const MAX_ACTION_INSTRUCTIONS = 250_000;
const MAX_CAPABILITY_CALLS = 10_000;
const MAX_REQUESTED_EFFECTS = 256;
const MAX_TRACE_RECORDS = 20_000;
const MAX_CALL_DEPTH = 16;
const MAX_LOOP_ITERATIONS = 1_000;
const MAX_ALLOCATED_BYTES = 1_048_576;
const MAX_STRING_BYTES = 16_384;
const MAX_COLLECTION_MEMBERS = 1_024;
const MAX_VALUE_DEPTH = 32;

export interface ScriptExecutionEnvironment {
  readonly host: Pick<GameEngineHost, 'scriptExecutor'>
    & Partial<Pick<GameEngineHost, 'seededSeedSource' | 'unseededRandomSource' | 'unseededRandomReplaySource'>>;
  readonly bundle: CompiledScriptBundle;
  readonly scripts: ReadonlyMap<ScriptId, ScriptIR>;
}

export interface ScriptActionBudget {
  activations: number;
  instructions: number;
  capabilityCalls: number;
  requestedEffects: number;
  traceRecords: number;
  seededRandomOrdinal: number;
  effects: number;
  ruleExecutions: number;
  events: number;
}

export interface ScriptActionTransaction {
  readonly environment?: ScriptExecutionEnvironment;
  readonly budget: ScriptActionBudget;
}

export interface ScriptCapabilityBridge {
  read(reference: StateReference): number | string | boolean;
  hasTag(entityId: string, tag: string): boolean;
  request(effect: ScriptEffect): void;
  emit(eventId: EventId, payload: JsonRecord): void;
  randomInt(minimum: number, maximum: number): number;
  randomFloat(): number;
}

export interface ScriptActivationResult {
  readonly ok: boolean;
  readonly trace: readonly TransitionTraceRecord[];
  readonly diagnostic?: Diagnostic;
}

export function createScriptExecutionEnvironment(
  host: ScriptExecutionEnvironment['host'],
  bundle: CompiledScriptBundle,
): ScriptExecutionEnvironment {
  return {
    host,
    bundle,
    scripts: new Map(bundle.scripts.map((script) => [script.scriptId, script])),
  };
}

export function validateScriptEnvironment(world: WorldDocument, environment: ScriptExecutionEnvironment): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = new Map<string, number>();
  for (const script of environment.bundle.scripts) ids.set(script.scriptId, (ids.get(script.scriptId) ?? 0) + 1);
  for (const reference of world.scripts) {
    const script = environment.scripts.get(reference.id);
    if (!script || ids.get(reference.id) !== 1) {
      diagnostics.push(runtimeDiagnostic(`World script ${reference.id} does not have exactly one compiled bundle entry.`));
      continue;
    }
    if (script.sourcePath !== reference.path || script.sourceLanguage !== reference.language || script.entrypoint !== reference.entrypoint) {
      diagnostics.push(runtimeDiagnostic(`Compiled script ${reference.id} no longer matches the supplied world declaration.`));
    }
  }
  for (const scriptId of environment.scripts.keys()) {
    if (!world.scripts.some((reference) => reference.id === scriptId)) diagnostics.push(runtimeDiagnostic(`Compiled script ${scriptId} is not declared by the supplied world.`));
  }
  return diagnostics;
}

export function createScriptActionTransaction(environment?: ScriptExecutionEnvironment): ScriptActionTransaction {
  return {
    ...(environment ? { environment } : {}),
    budget: { activations: 0, instructions: 0, capabilityCalls: 0, requestedEffects: 0, traceRecords: 0, seededRandomOrdinal: 0, effects: 0, ruleExecutions: 0, events: 0 },
  };
}

function runtimeDiagnostic(message: string, cause?: Diagnostic): Diagnostic {
  return cause ?? { code: 'DS-ENG-014', severity: 'error', message, blocks: ['play', 'script-execution'] };
}

function scriptSource(scriptId: ScriptId): TraceSource {
  return { kind: 'script', scriptId };
}

function asTrace(scriptId: ScriptId, records: readonly ScriptExecutionTraceRecord[]): readonly TransitionTraceRecord[] {
  return records.map((record, sequence) => ({
    sequence,
    kind: 'script',
    source: scriptSource(scriptId),
    reason: record.reason,
    scriptTrace: structuredClone(record),
  }));
}

/** Executes one activation with counters shared by every script in the enclosing action. */
export function executeScriptActivation(
  transaction: ScriptActionTransaction,
  world: WorldDocument,
  snapshot: SessionSnapshot,
  scriptId: ScriptId,
  origin: ScriptInvocationOrigin,
  bridge: ScriptCapabilityBridge,
): ScriptActivationResult {
  const { budget } = transaction;
  const environment = transaction.environment;
  const fail = (message: string, cause?: Diagnostic): ScriptActivationResult => ({
    ok: false,
    diagnostic: runtimeDiagnostic(message, cause),
    trace: [],
  });
  if (!environment) return fail(`run-script effect for ${scriptId} requires an engine script runtime.`);
  const script = environment.scripts.get(scriptId);
  if (!script) return fail(`Script ${scriptId} is not present in the compiled bundle.`);
  if (budget.activations >= MAX_ACTIVATIONS) return fail(`Script activation budget exceeded (${MAX_ACTIVATIONS} per action).`);
  if (budget.instructions >= MAX_ACTION_INSTRUCTIONS) return fail(`Script instruction budget exceeded (${MAX_ACTION_INSTRUCTIONS} per action).`);
  if (budget.capabilityCalls >= MAX_CAPABILITY_CALLS) return fail(`Script capability-call budget exceeded (${MAX_CAPABILITY_CALLS} per action).`);
  if (budget.requestedEffects >= MAX_REQUESTED_EFFECTS) return fail(`Script requested-effect budget exceeded (${MAX_REQUESTED_EFFECTS} per action).`);
  if (budget.traceRecords >= MAX_TRACE_RECORDS) return fail(`Transition trace budget exceeded (${MAX_TRACE_RECORDS} per action).`);

  const limits: ScriptExecutionLimits = {
    maxInstructions: Math.min(50_000, MAX_ACTION_INSTRUCTIONS - budget.instructions),
    maxCallDepth: MAX_CALL_DEPTH,
    maxLoopIterations: MAX_LOOP_ITERATIONS,
    maxAllocatedBytes: MAX_ALLOCATED_BYTES,
    maxStringBytes: MAX_STRING_BYTES,
    maxCollectionMembers: MAX_COLLECTION_MEMBERS,
    maxValueDepth: MAX_VALUE_DEPTH,
    maxCapabilityCalls: MAX_CAPABILITY_CALLS - budget.capabilityCalls,
    maxRequestedEffects: MAX_REQUESTED_EFFECTS - budget.requestedEffects,
    maxTraceRecords: MAX_TRACE_RECORDS - budget.traceRecords,
  };
  const chargeCapability = (requested = false): void => {
    budget.capabilityCalls += 1;
    if (budget.capabilityCalls > MAX_CAPABILITY_CALLS) throw new Error(`Script capability-call budget exceeded (${MAX_CAPABILITY_CALLS} per action).`);
    if (requested) {
      budget.requestedEffects += 1;
      if (budget.requestedEffects > MAX_REQUESTED_EFFECTS) throw new Error(`Script requested-effect budget exceeded (${MAX_REQUESTED_EFFECTS} per action).`);
    }
  };
  const capabilities: ScriptExecutionCapabilities = {
    read: (reference) => { chargeCapability(); return bridge.read(reference); },
    hasTag: (entityId, tag) => { chargeCapability(); return bridge.hasTag(entityId, tag); },
    request: (effect) => { chargeCapability(true); bridge.request(effect); },
    emit: (eventId, payload) => { chargeCapability(true); bridge.emit(eventId, payload); },
    randomInt: (minimum, maximum) => { chargeCapability(); return bridge.randomInt(minimum, maximum); },
    randomFloat: () => { chargeCapability(); return bridge.randomFloat(); },
  };

  budget.activations += 1;
  let result;
  try {
    result = environment.host.scriptExecutor.executeScript(script, { origin, limits, capabilities });
  } catch (error) {
    return fail(error instanceof Error ? `Script executor threw: ${error.message}` : 'Script executor threw an unexpected error.');
  }
  if (!Number.isSafeInteger(result.instructionsExecuted) || result.instructionsExecuted < 0 || result.instructionsExecuted > limits.maxInstructions ||
      !Array.isArray(result.trace) || result.trace.length > limits.maxTraceRecords) {
    return fail('Script executor returned counts or trace records outside the limits supplied by the engine.');
  }
  budget.instructions += result.instructionsExecuted;
  const trace = asTrace(scriptId, result.trace);
  if (budget.traceRecords + trace.length > MAX_TRACE_RECORDS) return fail('Script execution exceeded the action trace-record budget.');
  budget.traceRecords += trace.length;
  if (result.ok) return { ok: true, trace };
  return { ok: false, trace, diagnostic: runtimeDiagnostic(result.diagnostic.message, result.diagnostic) };
}

export function remainingScriptTraceRecords(transaction: ScriptActionTransaction): number {
  return Math.max(0, MAX_TRACE_RECORDS - transaction.budget.traceRecords);
}

export function accountEngineTrace(transaction: ScriptActionTransaction, count: number): boolean {
  if (!Number.isSafeInteger(count) || count < 0 || transaction.budget.traceRecords + count > MAX_TRACE_RECORDS) return false;
  transaction.budget.traceRecords += count;
  return true;
}

export function scriptDiagnostic(message: string, cause?: Diagnostic): Diagnostic {
  return runtimeDiagnostic(message, cause);
}

export function makeScriptRandomBridge(
  transaction: ScriptActionTransaction,
  world: WorldDocument,
  scriptId: ScriptId,
  getSnapshot: () => SessionSnapshot,
  setSnapshot: (snapshot: SessionSnapshot) => void,
  addTrace: (records: readonly TransitionTraceRecord[]) => void,
): Pick<ScriptCapabilityBridge, 'randomInt' | 'randomFloat'> {
  const addRandomTrace = (records: readonly TransitionTraceRecord[]): void => {
    if (!accountEngineTrace(transaction, records.length)) throw new Error(`Transition trace budget exceeded (${MAX_TRACE_RECORDS} per action).`);
    addTrace(records);
  };
  return {
    randomInt(minimum, maximum) {
      const environment = transaction.environment;
      if (!environment) throw new Error(`Script ${scriptId} has no runtime host.`);
      const drawn = drawRandomInt(world, getSnapshot(), scriptId, minimum, maximum, environment.host, transaction.budget.seededRandomOrdinal++);
      if (!drawn.ok) throw Object.assign(new Error(drawn.diagnostic.message), { diagnostic: drawn.diagnostic });
      setSnapshot(drawn.snapshot);
      addRandomTrace(drawn.trace);
      return drawn.value;
    },
    randomFloat() {
      const environment = transaction.environment;
      if (!environment) throw new Error(`Script ${scriptId} has no runtime host.`);
      const drawn = drawRandomFloat(world, getSnapshot(), scriptId, environment.host, transaction.budget.seededRandomOrdinal++);
      if (!drawn.ok) throw Object.assign(new Error(drawn.diagnostic.message), { diagnostic: drawn.diagnostic });
      setSnapshot(drawn.snapshot);
      addRandomTrace(drawn.trace);
      return drawn.value;
    },
  };
}
