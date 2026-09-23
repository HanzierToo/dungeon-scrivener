import type {
  Diagnostic, ScriptCapabilityName, ScriptEffect, ScriptExpression, ScriptFunction,
  ScriptIR, ScriptStatement, SourceSpan,
} from '@dungeon-scrivener/model';
import { SCRIPT_IR_LIMITS } from './budgets.js';

export { SCRIPT_IR_LIMITS } from './budgets.js';
export type { ScriptIR, ScriptExpression, ScriptStatement, ScriptFunction } from '@dungeon-scrivener/model';

const DIAGNOSTIC_CODE = 'DS-SCRIPT-001';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CAPABILITIES = new Set<ScriptCapabilityName>([
  'api.read', 'api.hasTag', 'api.request', 'api.emit', 'api.randomInt', 'api.randomFloat', 'len',
]);

type ValueKind = 'string' | 'number' | 'boolean' | 'array' | 'map' | 'null' | 'unknown' | 'void';
interface Binding { readonly mutable: boolean; readonly kind: ValueKind }
interface Scope { readonly bindings: Map<string, Binding>; readonly declaredNames: Set<string> }
interface ValidationContext {
  readonly ir: ScriptIR;
  readonly diagnostics: Diagnostic[];
  readonly functions: Map<string, ScriptFunction>;
  nodes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(message: string, span?: SourceSpan, path?: string): Diagnostic {
  return {
    code: DIAGNOSTIC_CODE,
    severity: 'error',
    message,
    ...(path ? { path } : {}),
    ...(span ? { sourceSpan: span } : {}),
    blocks: ['script-execution', 'play', 'export'],
  };
}

function fail(context: ValidationContext, message: string, span?: SourceSpan): void {
  context.diagnostics.push(diagnostic(message, span, context.ir.sourcePath));
}

function validSpan(value: unknown, context: ValidationContext, parent?: SourceSpan): value is SourceSpan {
  if (!isRecord(value)
      || !hasOwnKeys(value, ['path', 'startLine', 'startColumn', 'endLine', 'endColumn'])
      || value.path !== context.ir.sourcePath
      || !Number.isInteger(value.startLine) || (value.startLine as number) < 1
      || !Number.isInteger(value.startColumn) || (value.startColumn as number) < 1
      || !Number.isInteger(value.endLine) || (value.endLine as number) < 1
      || !Number.isInteger(value.endColumn) || (value.endColumn as number) < 1) {
    fail(context, 'Every IR node must have a valid source span in the declared source file.');
    return false;
  }
  const span = value as unknown as SourceSpan;
  if (span.endLine < span.startLine || (span.endLine === span.startLine && span.endColumn < span.startColumn)) {
    fail(context, 'Source span end must not precede its start.', span);
    return false;
  }
  if (parent && (span.startLine < parent.startLine || span.endLine > parent.endLine
      || (span.startLine === parent.startLine && span.startColumn < parent.startColumn)
      || (span.endLine === parent.endLine && span.endColumn > parent.endColumn))) {
    fail(context, 'A child source span must be contained by its parent span.', span);
  }
  return true;
}

function node(context: ValidationContext, spanValue: unknown, depth: number, parent?: SourceSpan): SourceSpan | undefined {
  context.nodes += 1;
  if (context.nodes > SCRIPT_IR_LIMITS.maxSyntaxNodes) {
    fail(context, `Script exceeds the ${SCRIPT_IR_LIMITS.maxSyntaxNodes} IR node limit.`);
    return undefined;
  }
  if (depth > SCRIPT_IR_LIMITS.maxNestingDepth) {
    fail(context, `Script exceeds the ${SCRIPT_IR_LIMITS.maxNestingDepth} nesting limit.`);
    return undefined;
  }
  return validSpan(spanValue, context, parent) ? spanValue : undefined;
}

function scalarKind(value: unknown): ValueKind {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}

function hasOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validPath(path: string): boolean {
  return path.length <= 1024 && !path.startsWith('/') && !path.includes('\\') && !path.includes(':')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(path)
    && path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function validateScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'world') return Object.keys(value).length === 1;
  return (value.kind === 'node' || value.kind === 'entity')
    && typeof value.ownerId === 'string' && IDENTIFIER.test(value.ownerId)
    && hasOwnKeys(value, ['kind', 'ownerId']);
}

function validateEffect(value: unknown): value is ScriptEffect {
  if (!isRecord(value) || typeof value.kind !== 'string' || value.kind === 'run-script') return false;
  switch (value.kind) {
    case 'set-state':
      return isRecord(value.target) && validateScope(value.target.scope)
        && typeof value.target.key === 'string' && IDENTIFIER.test(value.target.key)
        && ['string', 'number', 'boolean'].includes(typeof value.value)
        && (typeof value.value !== 'number' || Number.isFinite(value.value))
        && hasOwnKeys(value, ['kind', 'target', 'value']);
    case 'increment-state':
      return isRecord(value.target) && validateScope(value.target.scope)
        && typeof value.target.key === 'string' && IDENTIFIER.test(value.target.key)
        && typeof value.amount === 'number' && Number.isFinite(value.amount)
        && hasOwnKeys(value, ['kind', 'target', 'amount']);
    case 'add-tag':
    case 'remove-tag':
      return typeof value.entityId === 'string' && IDENTIFIER.test(value.entityId)
        && typeof value.tag === 'string' && value.tag.length > 0 && value.tag.length <= 128
        && hasOwnKeys(value, ['kind', 'entityId', 'tag']);
    case 'emit-event':
      return typeof value.eventId === 'string' && IDENTIFIER.test(value.eventId)
        && isRecord(value.payload) && hasOwnKeys(value, ['kind', 'eventId', 'payload']);
    case 'navigate':
      return typeof value.edgeId === 'string' && IDENTIFIER.test(value.edgeId)
        && hasOwnKeys(value, ['kind', 'edgeId']);
    case 'add-item':
    case 'remove-item':
      return validateScope(value.owner) && typeof value.itemId === 'string' && IDENTIFIER.test(value.itemId)
        && Number.isSafeInteger(value.quantity) && (value.quantity as number) > 0
        && hasOwnKeys(value, ['kind', 'owner', 'itemId', 'quantity']);
    case 'start-conversation':
    case 'interrupt-conversation':
    case 'resume-conversation':
      return typeof value.conversationId === 'string' && IDENTIFIER.test(value.conversationId)
        && hasOwnKeys(value, ['kind', 'conversationId']);
    default: return false;
  }
}

function literalValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'literal') return value.value;
  if (value.kind === 'array' && Array.isArray(value.items)) return value.items.map(literalValue);
  if (value.kind === 'map' && Array.isArray(value.entries)) {
    const record: Record<string, unknown> = {};
    for (const entry of value.entries) {
      if (!isRecord(entry) || typeof entry.key !== 'string') return undefined;
      record[entry.key] = literalValue(entry.value);
    }
    return record;
  }
  return undefined;
}

function inferExpression(value: unknown, scope: Scope, context: ValidationContext, depth: number, parent?: SourceSpan): ValueKind {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    fail(context, 'Expression is malformed.', parent);
    return 'unknown';
  }
  const span = node(context, value.span, depth, parent);
  switch (value.kind) {
    case 'literal': {
      if (!hasOwnKeys(value, ['kind', 'value', 'span']) || !['string', 'number', 'boolean'].includes(typeof value.value)
          || (typeof value.value === 'number' && !Number.isFinite(value.value))) fail(context, 'Literal must be a finite number, string, or boolean.', span);
      if (typeof value.value === 'string' && new TextEncoder().encode(value.value).length > SCRIPT_IR_LIMITS.maxStringBytes) fail(context, 'String literal exceeds the 16 KiB limit.', span);
      return scalarKind(value.value);
    }
    case 'local': {
      if (!hasOwnKeys(value, ['kind', 'name', 'span']) || typeof value.name !== 'string' || !IDENTIFIER.test(value.name)) {
        fail(context, 'Local reference has an invalid identifier.', span);
        return 'unknown';
      }
      const binding = scope.bindings.get(value.name);
      if (!binding) { fail(context, `Implicit global or undeclared local ${value.name} is not allowed.`, span); return 'unknown'; }
      return binding.kind;
    }
    case 'array': {
      if (!hasOwnKeys(value, ['kind', 'items', 'span']) || !Array.isArray(value.items)) { fail(context, 'Array expression is malformed.', span); return 'unknown'; }
      if (value.items.length > SCRIPT_IR_LIMITS.maxCollectionMembers) fail(context, 'Array exceeds the 1,024 member limit.', span);
      for (const item of value.items) inferExpression(item, scope, context, depth + 1, span);
      return 'array';
    }
    case 'map': {
      if (!hasOwnKeys(value, ['kind', 'entries', 'span']) || !Array.isArray(value.entries)) { fail(context, 'Map expression is malformed.', span); return 'unknown'; }
      if (value.entries.length > SCRIPT_IR_LIMITS.maxCollectionMembers) fail(context, 'Map exceeds the 1,024 member limit.', span);
      const keys = new Set<string>();
      for (const entry of value.entries) {
        if (!isRecord(entry) || typeof entry.key !== 'string' || entry.key.length > 128 || !hasOwnKeys(entry, ['key', 'value'])) {
          fail(context, 'Map keys must be string literals of at most 128 characters.', span);
          continue;
        }
        if (keys.has(entry.key)) fail(context, `Map contains duplicate key ${entry.key}.`, span);
        keys.add(entry.key);
        inferExpression(entry.value, scope, context, depth + 1, span);
      }
      return 'map';
    }
    case 'index': {
      if (!hasOwnKeys(value, ['kind', 'target', 'index', 'span'])) fail(context, 'Index expression has unknown fields.', span);
      const target = inferExpression(value.target, scope, context, depth + 1, span);
      const index = inferExpression(value.index, scope, context, depth + 1, span);
      if (target !== 'array' && target !== 'map' && target !== 'string' && target !== 'unknown') fail(context, 'Only arrays, maps, and strings can be indexed.', span);
      if (target === 'map' && index !== 'string' && index !== 'unknown') fail(context, 'Map indexes must be strings.', span);
      if ((target === 'array' || target === 'string') && index !== 'number' && index !== 'unknown') fail(context, 'Array and string indexes must be numbers.', span);
      return 'unknown';
    }
    case 'unary': {
      if (!hasOwnKeys(value, ['kind', 'operator', 'operand', 'span'])) fail(context, 'Unary expression has unknown fields.', span);
      const operand = inferExpression(value.operand, scope, context, depth + 1, span);
      if (value.operator === 'not') {
        if (operand !== 'boolean' && operand !== 'unknown') fail(context, 'Boolean not requires a boolean operand.', span);
        return 'boolean';
      }
      if (value.operator === 'negate') {
        if (operand !== 'number' && operand !== 'unknown') fail(context, 'Numeric negation requires a number operand.', span);
        return 'number';
      }
      fail(context, 'Unknown unary operator.', span);
      return 'unknown';
    }
    case 'binary': {
      if (!hasOwnKeys(value, ['kind', 'operator', 'left', 'right', 'span'])) fail(context, 'Binary expression has unknown fields.', span);
      const left = inferExpression(value.left, scope, context, depth + 1, span);
      const right = inferExpression(value.right, scope, context, depth + 1, span);
      const operator = value.operator;
      if (['add', 'subtract', 'multiply', 'divide', 'modulo'].includes(String(operator))) {
        if (![left, right].every((kind) => kind === 'number' || kind === 'unknown')) fail(context, 'Arithmetic operators require numbers.', span);
        return 'number';
      }
      if (operator === 'concat') {
        if (![left, right].every((kind) => kind === 'string' || kind === 'unknown')) fail(context, 'String concatenation requires strings.', span);
        return 'string';
      }
      if (['equal', 'not-equal'].includes(String(operator))) {
        if (left !== 'unknown' && right !== 'unknown' && left !== right) fail(context, 'Equality requires operands of the same type.', span);
        return 'boolean';
      }
      if (['less-than', 'less-or-equal', 'greater-than', 'greater-or-equal'].includes(String(operator))) {
        if (![left, right].every((kind) => kind === 'number' || kind === 'unknown')) fail(context, 'Ordering comparisons require numbers.', span);
        return 'boolean';
      }
      if (operator === 'and' || operator === 'or') {
        if (![left, right].every((kind) => kind === 'boolean' || kind === 'unknown')) fail(context, 'Boolean operators require booleans.', span);
        return 'boolean';
      }
      fail(context, 'Unknown binary operator.', span);
      return 'unknown';
    }
    case 'call': return validateCall(value, scope, context, depth, span);
    default:
      fail(context, `Unknown expression opcode ${value.kind}.`, span);
      return 'unknown';
  }
}

function validateCall(value: Record<string, unknown>, scope: Scope, context: ValidationContext, depth: number, span?: SourceSpan): ValueKind {
  if (!hasOwnKeys(value, ['kind', 'target', 'arguments', 'span']) || !isRecord(value.target) || !Array.isArray(value.arguments)) {
    fail(context, 'Call expression is malformed.', span);
    return 'unknown';
  }
  const args = value.arguments.map((argument) => inferExpression(argument, scope, context, depth + 1, span));
  if (value.target.kind === 'helper' && typeof value.target.name === 'string') {
    if (!hasOwnKeys(value.target, ['kind', 'name'])) fail(context, 'Helper call target has unknown fields.', span);
    const fn = context.functions.get(value.target.name);
    if (!fn) { fail(context, `Call references unknown helper ${value.target.name}.`, span); return 'unknown'; }
    if (args.length !== fn.parameters.length) fail(context, `Helper ${fn.name} expects ${fn.parameters.length} arguments.`, span);
    return 'unknown';
  }
  if (value.target.kind !== 'capability' || typeof value.target.name !== 'string' || !CAPABILITIES.has(value.target.name as ScriptCapabilityName)) {
    fail(context, 'Call target is not an allowed helper or engine capability.', span);
    return 'unknown';
  }
  if (!hasOwnKeys(value.target, ['kind', 'name'])) fail(context, 'Capability call target has unknown fields.', span);
  const capability = value.target.name as ScriptCapabilityName;
  const count = (n: number) => { if (args.length !== n) fail(context, `${capability} expects ${n} argument(s).`, span); };
  const expect = (index: number, kind: ValueKind) => { if (args[index] !== kind && args[index] !== 'unknown') fail(context, `${capability} argument ${index + 1} must be ${kind}.`, span); };
  switch (capability) {
    case 'api.read':
      count(2); expect(0, 'map'); expect(1, 'string');
      if (!isRecord(value.arguments[0]) || value.arguments[0].kind !== 'map') fail(context, 'api.read scope must be a literal scope record.', span);
      else {
        const entries = value.arguments[0].entries;
        const scopeEntries = Array.isArray(entries) ? entries : [];
        const scopeRecord = Object.fromEntries(scopeEntries.filter(isRecord).map((entry) => [entry.key, literalValue(entry.value)]));
        if (!validateScope(scopeRecord)) fail(context, 'api.read scope must use the StateScope record shape.', span);
      }
      return 'unknown';
    case 'api.hasTag': count(2); expect(0, 'string'); expect(1, 'string'); return 'boolean';
    case 'api.request':
      count(1); expect(0, 'map');
      if (!isRecord(value.arguments[0]) || value.arguments[0].kind !== 'map') fail(context, 'api.request requires a literal typed effect map.', span);
      else {
        const entries = value.arguments[0].entries;
        const effect = Object.fromEntries(Array.isArray(entries) ? entries.filter(isRecord).map((entry) => [entry.key, literalValue(entry.value)]) : []);
        if (!validateEffect(effect)) fail(context, 'api.request effect is invalid or attempts to write state directly.', span);
      }
      return 'void';
    case 'api.emit': count(2); expect(0, 'string'); expect(1, 'map'); return 'void';
    case 'api.randomInt': count(2); expect(0, 'number'); expect(1, 'number'); return 'number';
    case 'api.randomFloat': count(0); return 'number';
    case 'len': count(1); if (!['array', 'map', 'string', 'unknown'].includes(args[0] ?? 'unknown')) fail(context, 'len accepts only a string, array, or map.', span); return 'number';
  }
}

function isAlwaysTrue(expression: unknown): boolean {
  return isRecord(expression) && expression.kind === 'literal' && expression.value === true;
}

function validateStatements(statements: unknown, scope: Scope, context: ValidationContext, depth: number, parent?: SourceSpan, returnKinds: ValueKind[] = []): void {
  if (!Array.isArray(statements)) { fail(context, 'Function body must be a statement array.', parent); return; }
  for (const value of statements) {
    if (!isRecord(value) || typeof value.kind !== 'string') { fail(context, 'Statement is malformed.', parent); continue; }
    const span = node(context, value.span, depth, parent);
    switch (value.kind) {
      case 'declare-local': {
        if (!hasOwnKeys(value, ['kind', 'name', 'mutable', 'value', 'span']) || typeof value.name !== 'string' || !IDENTIFIER.test(value.name) || typeof value.mutable !== 'boolean') {
          fail(context, 'Local declaration is malformed.', span); break;
        }
        if (value.name === 'api' || value.name === 'len' || scope.declaredNames.has(value.name)) fail(context, `Local ${value.name} is reserved or redeclared.`, span);
        const kind = inferExpression(value.value, scope, context, depth + 1, span);
        scope.bindings.set(value.name, { mutable: value.mutable, kind });
        scope.declaredNames.add(value.name);
        break;
      }
      case 'assign-local': {
        if (!hasOwnKeys(value, ['kind', 'name', 'value', 'span']) || typeof value.name !== 'string') { fail(context, 'Local assignment is malformed.', span); break; }
        const binding = scope.bindings.get(value.name);
        const kind = inferExpression(value.value, scope, context, depth + 1, span);
        if (!binding) fail(context, `Assignment to undeclared local ${value.name} is not allowed.`, span);
        else if (!binding.mutable) fail(context, `Cannot assign to immutable local ${value.name}.`, span);
        else if (binding.kind !== 'unknown' && kind !== 'unknown' && binding.kind !== kind) fail(context, `Assignment changes the type of local ${value.name}.`, span);
        break;
      }
      case 'if': {
        if (!hasOwnKeys(value, ['kind', 'condition', 'then', 'else', 'span'])) fail(context, 'If statement has unknown fields.', span);
        const condition = inferExpression(value.condition, scope, context, depth + 1, span);
        if (condition !== 'boolean' && condition !== 'unknown') fail(context, 'Branch condition must be boolean.', span);
        const thenScope: Scope = { bindings: new Map(scope.bindings), declaredNames: scope.declaredNames };
        const elseScope: Scope = { bindings: new Map(scope.bindings), declaredNames: scope.declaredNames };
        validateStatements(value.then, thenScope, context, depth + 1, span, returnKinds);
        validateStatements(value.else, elseScope, context, depth + 1, span, returnKinds);
        break;
      }
      case 'while': {
        if (!hasOwnKeys(value, ['kind', 'condition', 'body', 'span'])) fail(context, 'While statement has unknown fields.', span);
        const condition = inferExpression(value.condition, scope, context, depth + 1, span);
        if (condition !== 'boolean' && condition !== 'unknown') fail(context, 'Loop condition must be boolean.', span);
        if (isAlwaysTrue(value.condition)) fail(context, 'Unbounded loop: a literal true condition cannot terminate.', span);
        validateStatements(value.body, { bindings: new Map(scope.bindings), declaredNames: scope.declaredNames }, context, depth + 1, span, returnKinds);
        break;
      }
      case 'expression': {
        if (!hasOwnKeys(value, ['kind', 'expression', 'span'])) fail(context, 'Expression statement has unknown fields.', span);
        const kind = inferExpression(value.expression, scope, context, depth + 1, span);
        if (isRecord(value.expression) && value.expression.kind === 'call' && isRecord(value.expression.target)
            && value.expression.target.kind === 'capability'
            && ['api.request', 'api.emit'].includes(String(value.expression.target.name))) continue;
        if (kind !== 'void') fail(context, 'Only api.request and api.emit may be used as statement calls.', span);
        break;
      }
      case 'return': {
        if (!hasOwnKeys(value, ['kind', 'value', 'span'])) fail(context, 'Return statement has unknown fields.', span);
        returnKinds.push(value.value === undefined ? 'void' : inferExpression(value.value, scope, context, depth + 1, span));
        break;
      }
      default: fail(context, `Unknown statement opcode ${value.kind}.`, span);
    }
  }
}

function validateFunction(fn: ScriptFunction, context: ValidationContext): void {
  const span = node(context, fn.span, 1);
  if (!IDENTIFIER.test(fn.name) || fn.name === 'api' || fn.name === 'len') fail(context, `Invalid or reserved function name ${fn.name}.`, span);
  if (fn.parameters.length > SCRIPT_IR_LIMITS.maxParametersPerFunction) fail(context, 'Function exceeds 32 parameters.', span);
  if (!hasOwnKeys(fn as unknown as Record<string, unknown>, ['name', 'parameters', 'body', 'span'])) fail(context, `Function ${fn.name} has unknown fields.`, span);
  const scope: Scope = { bindings: new Map(), declaredNames: new Set() };
  for (const parameter of fn.parameters) {
    if (!IDENTIFIER.test(parameter) || parameter === 'api' || parameter === 'len' || scope.bindings.has(parameter)) fail(context, `Invalid or duplicate parameter ${parameter}.`, span);
    scope.bindings.set(parameter, { mutable: true, kind: 'unknown' });
    scope.declaredNames.add(parameter);
  }
  const returnKinds: ValueKind[] = [];
  validateStatements(fn.body, scope, context, 2, span, returnKinds);
  if (fn.name === 'main' && returnKinds.some((kind) => kind !== 'void')) fail(context, 'main must not return a value.', span);
  if (fn.name !== 'main' && returnKinds.length > 0 && returnKinds.some((kind) => kind !== returnKinds[0])) fail(context, `Helper ${fn.name} mixes value and no-value returns.`, span);
  if (fn.name !== 'main' && returnKinds.length > 0 && !returnsOnEveryPath(fn.body)) fail(context, `Helper ${fn.name} must return consistently on every path.`, span);
}

function returnsOnEveryPath(statements: readonly ScriptStatement[]): boolean {
  for (const statement of statements) {
    if (statement.kind === 'return') return true;
    if (statement.kind === 'if' && returnsOnEveryPath(statement.then) && returnsOnEveryPath(statement.else)) return true;
  }
  return false;
}

/** Validate unknown serialized data before any executor receives it. */
export function validateScriptIR(input: unknown): { readonly ok: true; readonly ir: ScriptIR; readonly diagnostics: readonly [] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(input)) return { ok: false, diagnostics: [diagnostic('Script IR must be an object.')] };
  const headerKeys = ['format', 'schemaVersion', 'scriptId', 'sourceLanguage', 'sourcePath', 'entrypoint', 'functions'];
  if (!hasOwnKeys(input, headerKeys) || headerKeys.some((key) => !(key in input))) diagnostics.push(diagnostic('Script IR has missing or unknown fields.'));
  if (input.format !== 'dungeon-scrivener-script-ir' || input.schemaVersion !== 1 || input.entrypoint !== 'main'
      || typeof input.scriptId !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.scriptId)
      || typeof input.sourcePath !== 'string' || !validPath(input.sourcePath)
      || !['javascript', 'lua', 'python'].includes(String(input.sourceLanguage)) || !Array.isArray(input.functions)) {
    diagnostics.push(diagnostic('Script IR header does not match the v1 contract.'));
  }
  if (!Array.isArray(input.functions)) return { ok: false, diagnostics };
  const ir = input as unknown as ScriptIR;
  const context: ValidationContext = { ir, diagnostics, functions: new Map(), nodes: 0 };
  if (input.functions.length === 0 || input.functions.length > SCRIPT_IR_LIMITS.maxFunctions) fail(context, 'IR must contain 1 to 256 functions.');
  for (const candidate of input.functions) {
    if (!isRecord(candidate) || typeof candidate.name !== 'string' || !Array.isArray(candidate.parameters) || !Array.isArray(candidate.body)) {
      fail(context, 'Function declaration is malformed.');
      continue;
    }
    if (context.functions.has(candidate.name)) fail(context, `Duplicate function ${candidate.name}.`);
    else context.functions.set(candidate.name, candidate as unknown as ScriptFunction);
  }
  const main = context.functions.get('main');
  if (!main || main.parameters.length !== 0) fail(context, 'Exactly one zero-argument main function is required.');
  for (const fn of context.functions.values()) validateFunction(fn, context);
  const resultDiagnostics = Object.freeze(diagnostics.map((item) => Object.freeze(item)));
  if (diagnostics.length > 0) return { ok: false, diagnostics: resultDiagnostics };
  return { ok: true, ir, diagnostics: [] };
}

/** Explicit source-span type export for frontend authors. */
export type { SourceSpan } from '@dungeon-scrivener/model';
