import type {
  Diagnostic, JsonRecord, JsonValue, ScriptCapabilityName, ScriptExecutionContext,
  ScriptExecutionResult, ScriptExecutionTraceRecord, ScriptExecutorApi, ScriptExpression,
  ScriptFunction, ScriptIR, ScriptStatement, SourceSpan,
} from '@dungeon-scrivener/model';
import { SCRIPT_IR_LIMITS, validateScriptIR } from '../ir/index.js';

/** A wall-clock guard in addition to deterministic instruction fuel. */
export const MAX_EXECUTION_MILLISECONDS = 1_000;

interface ScriptArray extends ReadonlyArray<ScriptValue> {}
interface ScriptObject { readonly [key: string]: ScriptValue }
type ScriptValue = string | number | boolean | ScriptArray | ScriptObject;
interface Binding { value: ScriptValue; readonly mutable: boolean }
type Signal = { readonly kind: 'normal' } | { readonly kind: 'return'; readonly value?: ScriptValue };

const NORMAL: Signal = Object.freeze({ kind: 'normal' });
const MAX_SAFE_INDEX = Number.MAX_SAFE_INTEGER;

class ExecutionFailure extends Error {
  constructor(message: string, readonly span?: SourceSpan, readonly causeDiagnostic?: Diagnostic) {
    super(message);
    this.name = 'ExecutionFailure';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function cloneJson(value: unknown, span: SourceSpan, depth = 0): JsonValue {
  if (depth > SCRIPT_IR_LIMITS.maxValueDepth) throw new ExecutionFailure('Capability payload exceeds the value nesting limit.', span);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneJson(item, span, depth + 1)));
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) result[key] = cloneJson(item, span, depth + 1);
    return Object.freeze(result);
  }
  throw new ExecutionFailure('Capability payload contains a non-JSON value.', span);
}

/** Synchronous interpreter for validated IR. Authored source is never parsed or evaluated here. */
export class ScriptExecutor implements ScriptExecutorApi {
  executeScript(script: ScriptIR, context: ScriptExecutionContext): ScriptExecutionResult {
    const checked = validateScriptIR(script);
    let sequence = 0;
    let instructions = 0;
    let capabilityCalls = 0;
    let requestedEffects = 0;
    let allocatedBytes = 0;
    const trace: ScriptExecutionTraceRecord[] = [];
    const functions = new Map<string, ScriptFunction>();
    const startedAt = Date.now();
    let activeSpan: SourceSpan | undefined;

    function fail(message: string, span = activeSpan, causeDiagnostic?: Diagnostic): never {
      throw new ExecutionFailure(message, span, causeDiagnostic);
    }
    const record = (item: Omit<ScriptExecutionTraceRecord, 'sequence' | 'scriptId'>): void => {
      if (trace.length >= context.limits.maxTraceRecords) fail('Script trace-record budget exhausted.');
      trace.push(Object.freeze({ sequence: sequence++, scriptId: script.scriptId, ...item }));
    };
    const tick = (span: SourceSpan): void => {
      activeSpan = span;
      if (Date.now() - startedAt > MAX_EXECUTION_MILLISECONDS) fail('Script elapsed-work budget exhausted.', span);
      if (instructions >= Math.min(SCRIPT_IR_LIMITS.maxInstructionsPerActivation, context.limits.maxInstructions)) {
        fail('Script instruction budget exhausted.', span);
      }
      instructions += 1;
    };
    const allocate = (bytes: number, span: SourceSpan): void => {
      if (!Number.isSafeInteger(bytes) || bytes < 0
          || allocatedBytes + bytes > Math.min(SCRIPT_IR_LIMITS.maxAllocatedBytesPerActivation, context.limits.maxAllocatedBytes)) {
        fail('Script allocation budget exhausted.', span);
      }
      allocatedBytes += bytes;
    };
    const checkValue = (value: ScriptValue, span: SourceSpan, depth = 0): ScriptValue => {
      if (depth > Math.min(SCRIPT_IR_LIMITS.maxValueDepth, context.limits.maxValueDepth)) fail('Script value nesting limit exceeded.', span);
      if (typeof value === 'string') {
        const bytes = encodedBytes(value);
        if (bytes > Math.min(SCRIPT_IR_LIMITS.maxStringBytes, context.limits.maxStringBytes)) fail('Script string limit exceeded.', span);
        return value;
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('Script arithmetic produced a non-finite number.', span);
        return Object.is(value, -0) ? 0 : value;
      }
      if (typeof value === 'boolean') return value;
      if (Array.isArray(value)) {
        if (value.length > Math.min(SCRIPT_IR_LIMITS.maxCollectionMembers, context.limits.maxCollectionMembers)) fail('Script collection-member limit exceeded.', span);
        return value;
      }
      return value;
    };
    const immutableMap = (entries: readonly { key: string; value: ScriptExpression }[], env: Map<string, Binding>, span: SourceSpan, helperDepth: number, valueDepth: number): ScriptValue => {
      if (entries.length > Math.min(SCRIPT_IR_LIMITS.maxCollectionMembers, context.limits.maxCollectionMembers)) fail('Script collection-member limit exceeded.', span);
      const result: Record<string, ScriptValue> = Object.create(null) as Record<string, ScriptValue>;
      for (const entry of entries) {
        if (Object.hasOwn(result, entry.key)) fail('Duplicate map key encountered during execution.', span);
        const value = expression(entry.value, env, helperDepth, valueDepth + 1);
        allocate(encodedBytes(entry.key) + valueBytes(value), span);
        result[entry.key] = value;
      }
      return Object.freeze(result);
    };
    const valueBytes = (value: ScriptValue): number => {
      if (typeof value === 'string') return encodedBytes(value);
      if (Array.isArray(value)) return value.reduce((total, item) => total + valueBytes(item), 0);
      if (isRecord(value)) return Object.entries(value).reduce((total, [key, item]) => total + encodedBytes(key) + valueBytes(item), 0);
      return 8;
    };
    const capability = (name: ScriptCapabilityName, args: readonly ScriptValue[], span: SourceSpan): ScriptValue => {
      capabilityCalls += 1;
      if (capabilityCalls > context.limits.maxCapabilityCalls) fail('Script capability-call budget exhausted.', span);
      record({ kind: 'capability-call', capability: name, sourceSpan: span, instructionsExecuted: instructions, reason: `${name} invoked` });
      try {
        switch (name) {
          case 'api.read': {
            const scopeValue = args[0];
            const key = args[1];
            if (!isRecord(scopeValue) || typeof key !== 'string') fail('api.read arguments are invalid.', span);
            const scope = scopeValue.kind === 'world' ? { kind: 'world' as const }
              : scopeValue.kind === 'node' && typeof scopeValue.ownerId === 'string' ? { kind: 'node' as const, ownerId: scopeValue.ownerId }
                : scopeValue.kind === 'entity' && typeof scopeValue.ownerId === 'string' ? { kind: 'entity' as const, ownerId: scopeValue.ownerId }
                  : undefined;
            if (!scope) fail('api.read scope is invalid.', span);
            const result = context.capabilities.read({ scope, key });
            if (!scalar(result)) fail('api.read returned an invalid scalar.', span);
            return checkValue(result, span);
          }
          case 'api.hasTag': {
            if (typeof args[0] !== 'string' || typeof args[1] !== 'string') fail('api.hasTag arguments are invalid.', span);
            return context.capabilities.hasTag(args[0], args[1]);
          }
          case 'api.request': {
            if (!isRecord(args[0])) fail('api.request effect is invalid.', span);
            const effect = cloneJson(args[0], span);
            if (!isRecord(effect)) fail('api.request effect is invalid.', span);
            requestedEffects += 1;
            if (requestedEffects > Math.min(SCRIPT_IR_LIMITS.maxRequestedEffectsPerAction, context.limits.maxRequestedEffects)) fail('Script requested-effect budget exhausted.', span);
            context.capabilities.request(effect as unknown as Parameters<typeof context.capabilities.request>[0]);
            return false;
          }
          case 'api.emit': {
            if (typeof args[0] !== 'string' || !isRecord(args[1])) fail('api.emit arguments are invalid.', span);
            const payload = cloneJson(args[1], span);
            if (!isRecord(payload)) fail('api.emit payload is invalid.', span);
            requestedEffects += 1;
            if (requestedEffects > Math.min(SCRIPT_IR_LIMITS.maxRequestedEffectsPerAction, context.limits.maxRequestedEffects)) fail('Script requested-effect budget exhausted.', span);
            context.capabilities.emit(args[0], payload as JsonRecord);
            return false;
          }
          case 'api.randomInt': {
            const [minimum, maximum] = args;
            if (typeof minimum !== 'number' || typeof maximum !== 'number') fail('api.randomInt arguments are invalid.', span);
            return checkValue(context.capabilities.randomInt(minimum, maximum), span);
          }
          case 'api.randomFloat': return checkValue(context.capabilities.randomFloat(), span);
          case 'len': {
            const value = args[0];
            if (typeof value === 'string') return [...value].length;
            if (Array.isArray(value)) return value.length;
            if (isRecord(value)) return Object.keys(value).length;
            fail('len received an unsupported value.', span);
          }
        }
      } catch (error) {
        if (error instanceof ExecutionFailure) throw error;
        const capabilityError = error as { diagnostic?: Diagnostic; message?: string };
        fail(capabilityError?.message ?? `${name} failed.`, span, capabilityError?.diagnostic);
      }
    };
    const invoke = (fn: ScriptFunction, args: readonly ScriptValue[], depth: number): ScriptValue | undefined => {
      if (Date.now() - startedAt > MAX_EXECUTION_MILLISECONDS) fail('Script elapsed-work budget exhausted.', fn.span);
      if (depth > Math.min(SCRIPT_IR_LIMITS.maxHelperCallDepth, context.limits.maxCallDepth)) fail('Script helper-call depth limit exceeded.', fn.span);
      const env = new Map<string, Binding>();
      fn.parameters.forEach((parameter, index) => env.set(parameter, { value: args[index]!, mutable: true }));
      const result = statements(fn.body, env, depth);
      return result.kind === 'return' ? result.value : undefined;
    };
    const expression = (expr: ScriptExpression, env: Map<string, Binding>, depth = 0, valueDepth = 0): ScriptValue => {
      tick(expr.span);
      if ((expr.kind === 'array' || expr.kind === 'map')
          && valueDepth >= Math.min(SCRIPT_IR_LIMITS.maxValueDepth, context.limits.maxValueDepth)) {
        fail('Script value nesting limit exceeded.', expr.span);
      }
      switch (expr.kind) {
        case 'literal': return checkValue(expr.value, expr.span);
        case 'local': {
          const binding = env.get(expr.name);
          if (!binding) fail(`Unknown local ${expr.name}.`, expr.span);
          return binding.value;
        }
        case 'array': {
          if (expr.items.length > Math.min(SCRIPT_IR_LIMITS.maxCollectionMembers, context.limits.maxCollectionMembers)) fail('Script collection-member limit exceeded.', expr.span);
          const items = expr.items.map((item) => expression(item, env, depth, valueDepth + 1));
          allocate(items.reduce<number>((total, item) => total + valueBytes(item), 0), expr.span);
          return Object.freeze(items);
        }
        case 'map': return immutableMap(expr.entries, env, expr.span, depth, valueDepth);
        case 'index': {
          const target = expression(expr.target, env, depth);
          const index = expression(expr.index, env, depth);
          if (typeof target === 'string') {
            if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > MAX_SAFE_INDEX) fail('Array or string index must be a non-negative safe integer.', expr.span);
            const result = [...target][index];
            if (result === undefined) fail('Index is outside the collection.', expr.span);
            allocate(encodedBytes(result), expr.span);
            return result;
          }
          if (Array.isArray(target)) {
            if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > MAX_SAFE_INDEX) fail('Array index must be a non-negative safe integer.', expr.span);
            const result = target[index];
            if (result === undefined) fail('Index is outside the collection.', expr.span);
            return result as ScriptValue;
          }
          if (isRecord(target)) {
            if (typeof index !== 'string') fail('Map index must be a string.', expr.span);
            if (!Object.hasOwn(target, index)) fail('Map key does not exist.', expr.span);
            return target[index] as ScriptValue;
          }
          fail('Only arrays, maps, and strings can be indexed.', expr.span);
        }
        case 'unary': {
          const operand = expression(expr.operand, env, depth);
          if (expr.operator === 'not' && typeof operand === 'boolean') return !operand;
          if (expr.operator === 'negate' && typeof operand === 'number') return checkValue(-operand, expr.span);
          fail('Unary operator received an invalid value.', expr.span);
        }
        case 'binary': {
          const left = expression(expr.left, env, depth);
          if (expr.operator === 'and') {
            if (typeof left !== 'boolean') fail('and requires boolean operands.', expr.span);
            return left && boolean(expression(expr.right, env, depth), expr.span);
          }
          if (expr.operator === 'or') {
            if (typeof left !== 'boolean') fail('or requires boolean operands.', expr.span);
            return left || boolean(expression(expr.right, env, depth), expr.span);
          }
          const right = expression(expr.right, env, depth);
          switch (expr.operator) {
            case 'add': return arithmetic(left, right, expr.span, (a, b) => a + b);
            case 'subtract': return arithmetic(left, right, expr.span, (a, b) => a - b);
            case 'multiply': return arithmetic(left, right, expr.span, (a, b) => a * b);
            case 'divide': return arithmetic(left, right, expr.span, (a, b) => { if (b === 0) fail('Division by zero.', expr.span); return a / b; });
            case 'modulo': return arithmetic(left, right, expr.span, (a, b) => { if (b === 0) fail('Remainder by zero.', expr.span); return a - Math.floor(a / b) * b; });
            case 'concat': if (typeof left === 'string' && typeof right === 'string') {
              const result = checkValue(left + right, expr.span) as string;
              allocate(encodedBytes(result), expr.span);
              return result;
            } break;
            case 'equal': return equal(left, right, expr.span);
            case 'not-equal': return !equal(left, right, expr.span);
            case 'less-than': return compare(left, right, expr.span, (a, b) => a < b);
            case 'less-or-equal': return compare(left, right, expr.span, (a, b) => a <= b);
            case 'greater-than': return compare(left, right, expr.span, (a, b) => a > b);
            case 'greater-or-equal': return compare(left, right, expr.span, (a, b) => a >= b);
          }
          fail('Binary operator received invalid operands.', expr.span);
        }
        case 'call': {
          const args = expr.arguments.map((argument) => expression(argument, env, depth));
          if (expr.target.kind === 'helper') {
            const fn = functions.get(expr.target.name);
            if (!fn) fail(`Unknown helper ${expr.target.name}.`, expr.span);
            const result = invoke(fn, args, depth + 1);
            if (result === undefined) fail(`Helper ${expr.target.name} returned no value.`, expr.span);
            return result;
          }
          return capability(expr.target.name, args, expr.span);
        }
      }
    };
    const boolean = (value: ScriptValue, span: SourceSpan): boolean => {
      if (typeof value !== 'boolean') fail('Boolean operator received a non-boolean value.', span);
      return value;
    };
    const arithmetic = (left: ScriptValue, right: ScriptValue, span: SourceSpan, op: (a: number, b: number) => number): number => {
      if (typeof left !== 'number' || typeof right !== 'number') fail('Arithmetic operator requires numbers.', span);
      return checkValue(op(left, right), span) as number;
    };
    const equal = (left: ScriptValue, right: ScriptValue, span: SourceSpan): boolean => {
      if (typeof left !== typeof right || Array.isArray(left) || Array.isArray(right) || isRecord(left) || isRecord(right)) fail('Equality requires same-type scalar operands.', span);
      return left === right;
    };
    const compare = (left: ScriptValue, right: ScriptValue, span: SourceSpan, op: (a: number, b: number) => boolean): boolean => {
      if (typeof left !== 'number' || typeof right !== 'number') fail('Ordering requires numbers.', span);
      return op(left, right);
    };
    const statements = (body: readonly ScriptStatement[], env: Map<string, Binding>, depth: number): Signal => {
      for (const statement of body) {
        tick(statement.span);
        switch (statement.kind) {
          case 'declare-local': {
            const value = expression(statement.value, env, depth);
            if (env.has(statement.name)) fail(`Local ${statement.name} is already declared.`, statement.span);
            env.set(statement.name, { value, mutable: statement.mutable });
            break;
          }
          case 'assign-local': {
            const binding = env.get(statement.name);
            if (!binding || !binding.mutable) fail(`Local ${statement.name} is missing or immutable.`, statement.span);
            binding.value = expression(statement.value, env, depth);
            break;
          }
          case 'if': {
            const condition = boolean(expression(statement.condition, env, depth), statement.span);
            const branchEnv = new Map(env);
            const signal = statements(condition ? statement.then : statement.else, branchEnv, depth);
            if (signal.kind === 'return') return signal;
            break;
          }
          case 'while': {
            let iterations = 0;
            while (boolean(expression(statement.condition, env, depth), statement.span)) {
              if (iterations >= Math.min(SCRIPT_IR_LIMITS.maxLoopIterations, context.limits.maxLoopIterations)) fail('Script loop-iteration budget exhausted.', statement.span);
              iterations += 1;
              const signal = statements(statement.body, new Map(env), depth);
              if (signal.kind === 'return') return signal;
            }
            break;
          }
          case 'expression': expression(statement.expression, env, depth); break;
          case 'return': return { kind: 'return', ...(statement.value ? { value: expression(statement.value, env, depth) } : {}) };
        }
      }
      return NORMAL;
    };

    try {
      if (!checked.ok) {
        const diagnostic = checked.diagnostics[0] ?? makeDiagnostic(script, 'Script IR validation failed.');
        return { ok: false, instructionsExecuted: 0, diagnostic, trace: [] };
      }
      for (const fn of script.functions) functions.set(fn.name, fn);
      record({ kind: 'activation-start', reason: 'Script activation started' });
      invoke(functions.get('main')!, [], 0);
      record({ kind: 'activation-end', instructionsExecuted: instructions, reason: 'Script activation completed' });
      return { ok: true, instructionsExecuted: instructions, trace: Object.freeze(trace) };
    } catch (error) {
      const failure = error instanceof ExecutionFailure ? error : new ExecutionFailure(error instanceof Error ? error.message : 'Unknown script runtime failure.', activeSpan);
      const diagnostic = failure.causeDiagnostic ?? makeDiagnostic(script, failure.message, failure.span);
      try { record({ kind: 'failure', ...(failure.span ? { sourceSpan: failure.span } : {}), instructionsExecuted: instructions, reason: failure.message.slice(0, 512) }); } catch { /* trace budget is already exhausted */ }
      return { ok: false, instructionsExecuted: instructions, diagnostic, trace: Object.freeze(trace) };
    }
  }
}

function makeDiagnostic(script: ScriptIR, message: string, sourceSpan?: SourceSpan): Diagnostic {
  return Object.freeze({
    code: 'DS-SCRIPT-RUNTIME', severity: 'error', message: message.slice(0, 512),
    path: script.sourcePath, blocks: ['script-execution', 'play', 'export'] as const,
    ...(sourceSpan ? { sourceSpan } : {}),
  });
}

export const scriptExecutor: ScriptExecutorApi = new ScriptExecutor();
