import luaparse from 'luaparse';
import type { Diagnostic, ScriptExpression, ScriptFunction, ScriptIR, ScriptStatement, SourceSpan } from '@dungeon-scrivener/model';
import { SCRIPT_IR_LIMITS } from '../../ir/index.js';

type Ast = Record<string, any>;
type Kind = 'number' | 'string' | 'boolean' | 'array' | 'map' | 'unknown';
const CODE = 'DS-SCRIPT-001';
const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const record = (value: unknown): value is Ast => typeof value === 'object' && value !== null && !Array.isArray(value);

interface Metadata { readonly scriptId: string; readonly sourcePath: string }
type Result = { readonly ok: true; readonly ir: ScriptIR; readonly diagnostics: readonly [] } | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

class Rejected extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(diagnostic.message); }
}

class Compiler {
  private readonly names = new Set<string>();
  private readonly helperCalls: Array<{ name: string; count: number; span: SourceSpan }> = [];
  private readonly functions = new Map<string, Ast>();
  constructor(private readonly source: string, private readonly metadata: Metadata) {}

  span(node: Ast): SourceSpan {
    const start = node.loc?.start;
    const end = node.loc?.end;
    if (!start || !end) return { path: this.metadata.sourcePath, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
    return { path: this.metadata.sourcePath, startLine: start.line, startColumn: this.column(start.line, start.column), endLine: end.line, endColumn: this.column(end.line, end.column) };
  }
  private column(line: number, zeroBased: number): number {
    const text = this.source.split('\n')[line - 1] ?? '';
    return Array.from(text.slice(0, zeroBased)).length + 1;
  }
  reject(node: Ast, message: string, example = 'local function main() local total = 2 + 3 end'): never {
    const span = this.span(node);
    throw new Rejected({ code: CODE, severity: 'error', message: `Lua ${message} Example: ${example}`, path: this.metadata.sourcePath, sourceSpan: span,
      suggestedFix: `For example, use ${example}. Follow docs/contracts/script-subset.md.`, blocks: ['script-execution', 'play', 'export'] });
  }
  compile(chunk: Ast): ScriptIR {
    if (chunk.type !== 'Chunk' || !Array.isArray(chunk.body)) this.reject(chunk, 'source must be a chunk.');
    for (const node of chunk.body) {
      if (node.type !== 'FunctionDeclaration' || node.isLocal !== true || node.identifier?.type !== 'Identifier') this.reject(node, 'only local top-level function declarations are supported.');
      const name = node.identifier.name;
      this.identifier(name, node.identifier);
      if (this.functions.has(name)) this.reject(node, `function ${name} is duplicated.`);
      this.functions.set(name, node);
    }
    const main = this.functions.get('main');
    if (!main || main.parameters.length !== 0) this.reject(chunk, 'requires exactly one zero-argument local function named main.');
    const compiled = [...this.functions.values()].map((fn) => this.compileFunction(fn));
    for (const call of this.helperCalls) {
      const target = this.functions.get(call.name);
      if (!target) this.reject({ loc: { start: { line: call.span.startLine, column: call.span.startColumn - 1 }, end: { line: call.span.endLine, column: call.span.endColumn - 1 } } }, `call to undeclared helper ${call.name}.`);
      if (target.parameters.length !== call.count) this.reject(target, `helper ${call.name} expects ${target.parameters.length} arguments.`);
    }
    const ir: ScriptIR = { format: 'dungeon-scrivener-script-ir', schemaVersion: 1, scriptId: this.metadata.scriptId, sourceLanguage: 'lua', sourcePath: this.metadata.sourcePath, entrypoint: 'main', functions: compiled };
    return ir;
  }
  private identifier(name: string, node: Ast): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) this.reject(node, `identifier ${name} is outside the supported ASCII form.`);
    if (name === 'api' || name === 'len' || this.names.has(name)) this.reject(node, `identifier ${name} is reserved or redeclared.`);
  }
  private compileFunction(fn: Ast): ScriptFunction {
    this.names.clear();
    const name = fn.identifier.name;
    const params = fn.parameters as Ast[];
    if (params.length > SCRIPT_IR_LIMITS.maxParametersPerFunction) this.reject(fn, 'function exceeds 32 parameters.');
    const kinds = new Map<string, Kind>();
    for (const param of params) {
      if (param.type !== 'Identifier') this.reject(param, 'vararg and non-name parameters are unsupported.');
      this.identifier(param.name, param); this.names.add(param.name); kinds.set(param.name, 'unknown');
    }
    const body = this.statements(fn.body, kinds);
    for (const param of params) this.names.delete(param.name);
    return { name, parameters: params.map((param) => param.name), body, span: this.span(fn) };
  }
  private statements(nodes: Ast[], kinds: Map<string, Kind>): ScriptStatement[] {
    const out: ScriptStatement[] = [];
    for (const node of nodes) {
      const span = this.span(node);
      if (node.type === 'LocalStatement') {
        if (node.variables.length !== 1 || node.init.length !== 1 || node.variables[0].type !== 'Identifier') this.reject(node, 'local declarations require one initialized name.', 'local count = 0');
        const id = node.variables[0]; this.identifier(id.name, id); this.names.add(id.name);
        const value = this.expression(node.init[0], kinds); kinds.set(id.name, value.kind === 'literal' ? typeof value.value as Kind : this.infer(node.init[0], kinds));
        out.push({ kind: 'declare-local', name: id.name, mutable: true, value, span });
      } else if (node.type === 'AssignmentStatement') {
        if (node.variables.length !== 1 || node.init.length !== 1 || node.variables[0].type !== 'Identifier') this.reject(node, 'only assignment to a declared local is supported.');
        const id = node.variables[0]; if (!kinds.has(id.name)) this.reject(id, `assignment to undeclared local ${id.name} is forbidden.`);
        const value = this.expression(node.init[0], kinds);
        const old = kinds.get(id.name)!; const next = this.infer(node.init[0], kinds);
        if (old !== 'unknown' && next !== 'unknown' && old !== next) this.reject(node, 'assignment cannot change a local value kind.');
        out.push({ kind: 'assign-local', name: id.name, value, span });
      } else if (node.type === 'IfStatement') {
        let fallback: ScriptStatement[] = [];
        for (let i = node.clauses.length - 1; i >= 0; i--) {
          const clause = node.clauses[i]; const inner = new Map(kinds);
          const body = this.statements(clause.body, inner);
          if (clause.type === 'ElseClause') fallback = body;
          else {
            if (this.infer(clause.condition, kinds) !== 'boolean') this.reject(clause.condition, 'conditions must be boolean; Lua truthiness is unsupported.');
            fallback = [{ kind: 'if', condition: this.expression(clause.condition, kinds), then: body, else: fallback, span: this.span(node) }];
          }
        }
        out.push(...fallback);
      } else if (node.type === 'WhileStatement') {
        if (this.infer(node.condition, kinds) !== 'boolean') this.reject(node.condition, 'conditions must be boolean; Lua truthiness is unsupported.');
        out.push({ kind: 'while', condition: this.expression(node.condition, kinds), body: this.statements(node.body, new Map(kinds)), span });
      } else if (node.type === 'ReturnStatement') {
        if (node.arguments.length > 1) this.reject(node, 'return accepts at most one value.');
        out.push({ kind: 'return', ...(node.arguments.length ? { value: this.expression(node.arguments[0], kinds) } : {}), span });
      } else if (node.type === 'CallStatement') {
        const expression = this.expression(node.expression, kinds);
        if (expression.kind !== 'call' || expression.target.kind !== 'capability' || !['api.request', 'api.emit'].includes(expression.target.name)) this.reject(node, 'only api.request and api.emit are valid expression statements.');
        out.push({ kind: 'expression', expression, span });
      } else this.reject(node, `statement ${node.type} is not supported.`);
    }
    return out;
  }
  private infer(node: Ast, kinds: Map<string, Kind>): Kind {
    if (node.type === 'StringLiteral') return 'string';
    if (node.type === 'NumericLiteral') return 'number';
    if (node.type === 'BooleanLiteral') return 'boolean';
    if (node.type === 'Identifier') return kinds.get(node.name) ?? 'unknown';
    if (node.type === 'TableConstructorExpression') return node.fields[0]?.type === 'TableKeyString' || node.fields[0]?.type === 'TableKey' ? 'map' : 'array';
    if (node.type === 'CallExpression') return node.base?.name === 'len' || node.base?.name === 'api' ? 'unknown' : 'unknown';
    if (node.type === 'UnaryExpression' && node.operator === '-') return 'number';
    if (node.type === 'BinaryExpression') return ['==', '~=', '<', '<=', '>', '>=', 'and', 'or'].includes(node.operator) ? 'boolean' : 'number';
    return 'unknown';
  }
  private expression(node: Ast, kinds: Map<string, Kind>): ScriptExpression {
    const span = this.span(node);
    if (node.type === 'StringLiteral') {
      if (node.raw?.startsWith('[') || !['"', "'"].includes(node.raw?.[0])) this.reject(node, 'long-bracket and non-quoted strings are unsupported.');
      const value = this.decodeString(node.raw, node);
      if (bytes(value) > SCRIPT_IR_LIMITS.maxStringBytes) this.reject(node, 'string exceeds the 16 KiB limit.');
      return { kind: 'literal', value, span };
    }
    if (node.type === 'NumericLiteral') {
      if (!decimal.test(node.raw) || !Number.isFinite(node.value)) this.reject(node, 'only finite decimal numeric literals are supported.');
      return { kind: 'literal', value: Object.is(node.value, -0) ? 0 : node.value, span };
    }
    if (node.type === 'BooleanLiteral') return { kind: 'literal', value: node.value, span };
    if (node.type === 'NilLiteral') this.reject(node, 'nil is unsupported because the common IR has no null value.');
    if (node.type === 'Identifier') {
      if (node.name === 'nil') this.reject(node, 'nil is unsupported because the common IR has no null value.');
      if (node.name === 'api' || node.name === 'len' || !kinds.has(node.name)) this.reject(node, `global or undeclared name ${node.name} is forbidden.`);
      return { kind: 'local', name: node.name, span };
    }
    if (node.type === 'TableConstructorExpression') {
      if (node.fields.length > SCRIPT_IR_LIMITS.maxCollectionMembers) this.reject(node, 'table exceeds 1,024 members.');
      if (!node.fields.length) return { kind: 'array', items: [], span };
      const keyed = node.fields.map((field: Ast) => field.type !== 'TableValue');
      if (keyed.some(Boolean) && keyed.some((value: boolean) => !value)) this.reject(node, 'mixed array/map table constructors are unsupported.');
      if (!keyed[0]) {
        return { kind: 'array', items: node.fields.map((field: Ast) => {
          if (field.type !== 'TableValue') this.reject(field, 'array constructor must contain positional values.');
          return this.expression(field.value, kinds);
        }), span };
      }
      const entries: Array<{ key: string; value: ScriptExpression }> = []; const keys = new Set<string>();
      for (const field of node.fields as Ast[]) {
        let key: string;
        if (field.type === 'TableKeyString' && field.key.type === 'Identifier') key = field.key.name;
        else if (field.type === 'TableKey' && field.key.type === 'StringLiteral') key = field.key.value;
        else this.reject(field, 'map constructors require string keys.', '{kind = "world"}');
        if (keys.has(key!)) this.reject(field, `duplicate table key ${key!}.`); keys.add(key!);
        entries.push({ key: key!, value: this.expression(field.value, kinds) });
      }
      return { kind: 'map', entries, span };
    }
    if (node.type === 'IndexExpression') {
      const baseKind = this.infer(node.base, kinds);
      const target = this.expression(node.base, kinds); const index = this.expression(node.index, kinds);
      const idxKind = this.infer(node.index, kinds);
      if (baseKind === 'array' || baseKind === 'string') {
        if (idxKind !== 'number' && idxKind !== 'unknown') this.reject(node.index, 'sequence indexes must be numeric.');
        const zeroIndex: ScriptExpression = { kind: 'binary', operator: 'subtract', left: index, right: { kind: 'literal', value: 1, span }, span };
        return { kind: 'index', target, index: zeroIndex, span };
      }
      if (baseKind === 'map') {
        if (idxKind !== 'string' && idxKind !== 'unknown') this.reject(node.index, 'map indexes must be strings.');
        return { kind: 'index', target, index, span };
      }
      this.reject(node, 'indexing requires a statically identifiable table literal; map keys must be strings and sequences use 1-based Lua source indexes.');
    }
    if (node.type === 'UnaryExpression') {
      if (node.operator !== '-' && node.operator !== 'not') this.reject(node, `unary operator ${node.operator} is unsupported.`);
      if (node.operator === 'not' && this.infer(node.argument, kinds) !== 'boolean') this.reject(node, 'Lua truthiness is not used; not requires a boolean operand.');
      return { kind: 'unary', operator: node.operator === 'not' ? 'not' : 'negate', operand: this.expression(node.argument, kinds), span };
    }
    if (node.type === 'BinaryExpression') {
      const op: Record<string, any> = { '+':'add', '-':'subtract', '*':'multiply', '/':'divide', '%':'modulo', '==':'equal', '~=':'not-equal', '<':'less-than', '<=':'less-or-equal', '>':'greater-than', '>=':'greater-or-equal', and:'and', or:'or', '..':'concat' };
      if (!op[node.operator]) this.reject(node, `operator ${node.operator} is unsupported.`);
      const leftKind = this.infer(node.left, kinds); const rightKind = this.infer(node.right, kinds);
      if (['==', '~='].includes(node.operator) && (leftKind === 'array' || leftKind === 'map' || rightKind === 'array' || rightKind === 'map')) this.reject(node, 'table equality is unsupported.');
      if (node.operator === '..' && (leftKind !== 'string' || rightKind !== 'string')) this.reject(node, 'concatenation requires two strings.');
      if (['and', 'or'].includes(node.operator) && (leftKind !== 'boolean' || rightKind !== 'boolean')) this.reject(node, 'Lua truthiness is not used; and/or require boolean operands.');
      if (['<', '<=', '>', '>='].includes(node.operator) && (leftKind !== 'number' || rightKind !== 'number')) this.reject(node, 'ordering operators require numeric operands.');
      if (['+', '-', '*', '/', '%'].includes(node.operator) && (![leftKind, rightKind].every((kind) => kind === 'number' || kind === 'unknown'))) this.reject(node, 'arithmetic operators require numeric operands.');
      return { kind: 'binary', operator: op[node.operator], left: this.expression(node.left, kinds), right: this.expression(node.right, kinds), span };
    }
    if (node.type === 'CallExpression') return this.call(node, kinds);
    this.reject(node, `expression ${node.type} is unsupported.`);
  }
  private decodeString(raw: string, node: Ast): string {
    let result = '';
    for (let i = 1; i < raw.length - 1; i += 1) {
      if (raw[i] !== '\\') { result += raw[i]; continue; }
      const next = raw[++i];
      const escapes: Record<string, string> = { '\\': '\\', '"': '"', "'": "'", n: '\n', r: '\r', t: '\t' };
      if (next !== undefined && next in escapes) { result += escapes[next]!; continue; }
      if (next === 'u' && raw[i + 1] === '{') {
        const end = raw.indexOf('}', i + 2); const digits = raw.slice(i + 2, end);
        const point = /^[0-9a-fA-F]{1,6}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
        if (end < 0 || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) this.reject(node, 'Unicode escapes must represent a scalar value.');
        result += String.fromCodePoint(point); i = end; continue;
      }
      this.reject(node, `escape \\${next} is outside the documented string subset.`);
    }
    return result;
  }
  private call(node: Ast, kinds: Map<string, Kind>): ScriptExpression {
    let target: any;
    if (node.base.type === 'Identifier') {
      if (node.base.name === 'len') target = { kind: 'capability', name: 'len' };
      else {
        if (['assert', 'pairs', 'ipairs', 'type', 'tostring', 'tonumber', 'select', 'pcall', 'xpcall', 'require', 'load', 'rawget', 'rawset', 'setmetatable', 'getmetatable'].includes(node.base.name)) this.reject(node, `built-in ${node.base.name} is unsupported.`);
        this.helperCalls.push({ name: node.base.name, count: node.arguments.length, span: this.span(node) });
        target = { kind: 'helper', name: node.base.name };
      }
    } else if (node.base.type === 'MemberExpression' && node.base.indexer === '.' && node.base.base.type === 'Identifier' && node.base.base.name === 'api') {
      const name = `api.${node.base.identifier.name}`;
      if (!['api.read', 'api.hasTag', 'api.request', 'api.emit', 'api.randomInt', 'api.randomFloat'].includes(name)) this.reject(node, `unknown engine capability ${name}.`);
      target = { kind: 'capability', name };
    } else this.reject(node, 'calls must target a declared helper, len, or fixed api capability.');
    const args = node.arguments.map((arg: Ast) => this.expression(arg, kinds));
    const arity: Record<string, number> = { 'api.read': 2, 'api.hasTag': 2, 'api.request': 1, 'api.emit': 2, 'api.randomInt': 2, 'api.randomFloat': 0, len: 1 };
    if (target.kind === 'capability' && args.length !== arity[target.name]) this.reject(node, `${target.name} expects ${arity[target.name]} arguments.`);
    if (target.kind === 'capability' && ['api.request', 'api.emit'].includes(target.name) && node.type !== 'CallExpression') { /* statement checked by caller */ }
    return { kind: 'call', target, arguments: args, span: this.span(node) };
  }
}

function parseDiagnostic(error: unknown, source: string, metadata: Metadata): Diagnostic {
  const item = error as { message?: string; line?: number; column?: number };
  const line = item.line ?? 1; const column = item.column ?? 1;
  const text = source.split('\n')[line - 1] ?? '';
  const width = text.slice(column - 1).codePointAt(0)! > 0xffff ? 1 : text.slice(column - 1).length ? 1 : 0;
  const span = { path: metadata.sourcePath, startLine: line, startColumn: column, endLine: line, endColumn: column + width };
  return { code: CODE, severity: 'error', message: `Lua parse error: ${item.message ?? 'invalid syntax'}. Example: local function main() local total = 2 + 3 end`, path: metadata.sourcePath, sourceSpan: span, suggestedFix: 'Use only syntax listed in docs/contracts/script-subset.md.', blocks: ['script-execution', 'play', 'export'] };
}

/** Parse the frozen Lua subset to shared IR. Source is parsed, never executed. */
export function parseLua(source: string, metadata: Metadata): Result {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(metadata.scriptId) || !metadata.sourcePath || metadata.sourcePath.startsWith('/') || metadata.sourcePath.split('/').some((part) => !part || part === '.' || part === '..') || metadata.sourcePath.includes('\\')) {
    return { ok: false, diagnostics: [{ code: CODE, severity: 'error', message: 'Script metadata is invalid.', path: metadata.sourcePath, blocks: ['script-execution', 'play', 'export'] }] };
  }
  if (source.charCodeAt(0) === 0xfeff || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(source)) return { ok: false, diagnostics: [{ code: CODE, severity: 'error', message: 'Source must contain valid Unicode scalar values and no BOM.', path: metadata.sourcePath, blocks: ['script-execution', 'play', 'export'] }] };
  if (bytes(source) > SCRIPT_IR_LIMITS.maxSourceBytes) return { ok: false, diagnostics: [{ code: CODE, severity: 'error', message: 'Lua source exceeds 128 KiB.', path: metadata.sourcePath, blocks: ['script-execution', 'play', 'export'] }] };
  try {
    const chunk = luaparse.parse(source, { luaVersion: '5.3', locations: true, ranges: true, comments: false }) as unknown as Ast;
    return { ok: true, ir: new Compiler(source, metadata).compile(chunk), diagnostics: [] };
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, diagnostics: [error.diagnostic] };
    return { ok: false, diagnostics: [parseDiagnostic(error, source, metadata)] };
  }
}
