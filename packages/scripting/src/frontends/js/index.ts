import { parse } from 'acorn';
import type {
  Diagnostic, ScriptBinaryOperator, ScriptExpression, ScriptFunction, ScriptIR,
  ScriptStatement, SourceSpan,
} from '@dungeon-scrivener/model';
import { SCRIPT_IR_LIMITS } from '../../ir/index.js';

export interface JavaScriptScriptMetadata {
  readonly scriptId: string;
  readonly sourcePath: string;
}

export type JavaScriptCompileResult =
  | { readonly ok: true; readonly ir: ScriptIR; readonly diagnostics: readonly [] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

type Ast = Record<string, unknown> & { readonly type: string; readonly start: number; readonly end: number };
type StaticKind = 'number' | 'string' | 'boolean' | 'array' | 'map' | 'unknown' | 'void';

const DECIMAL = /^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const DIAGNOSTIC_CODE = 'DS-SCRIPT-002';

class CompileFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(diagnostic.message); }
}

function record(value: unknown): value is Ast {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string'
    && Number.isInteger((value as { start?: unknown }).start)
    && Number.isInteger((value as { end?: unknown }).end);
}

function asAst(value: unknown): Ast {
  if (!record(value)) throw new Error('Acorn returned a malformed syntax node.');
  return value;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function hasValidUnicodeScalars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function scalarPositionMap(source: string): { readonly lines: Uint32Array; readonly columns: Uint32Array } {
  const lines = new Uint32Array(source.length + 1);
  const columns = new Uint32Array(source.length + 1);
  let line = 1;
  let column = 1;
  for (let offset = 0; offset < source.length;) {
    lines[offset] = line;
    columns[offset] = column;
    const code = source.codePointAt(offset)!;
    if (code === 13 && source.charCodeAt(offset + 1) === 10) {
      lines[offset + 1] = line;
      columns[offset + 1] = column;
      offset += 2;
      line += 1;
      column = 1;
      continue;
    }
    const width = code > 0xffff ? 2 : 1;
    if (width === 2) {
      lines[offset + 1] = line;
      columns[offset + 1] = column;
    }
    offset += width;
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) { line += 1; column = 1; }
    else column += 1;
  }
  lines[source.length] = line;
  columns[source.length] = column;
  return { lines, columns };
}

function isValidSourcePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith('/')
    && !path.includes('\\') && !path.includes(':')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(path)
    && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

class JavaScriptCompiler {
  private readonly positions: ReturnType<typeof scalarPositionMap>;
  private astNodeCount = 0;
  private readonly helperCalls: Array<{ readonly name: string; readonly argumentCount: number; readonly span: SourceSpan }> = [];
  private declaredAcrossFunction = new Set<string>();

  constructor(private readonly source: string, private readonly metadata: JavaScriptScriptMetadata) {
    this.positions = scalarPositionMap(source);
  }

  compile(program: Ast): ScriptIR {
    this.checkAstBudgets(program);
    if (program.type !== 'Program' || !Array.isArray(program.body)) this.reject(program, 'Expected a JavaScript program.');
    const functions: ScriptFunction[] = [];
    for (const item of program.body as unknown[]) {
      const declaration = asAst(item);
      if (declaration.type !== 'FunctionDeclaration') {
        this.reject(declaration, `Only top-level function declarations are supported. Example: function main() { return; }`);
      }
      functions.push(this.compileFunction(declaration));
    }
    if (functions.length === 0 || functions.length > SCRIPT_IR_LIMITS.maxFunctions) this.reject(program, 'A script must contain 1 to 256 function declarations.');
    const functionNames = new Set<string>();
    for (const fn of functions) {
      if (functionNames.has(fn.name)) this.reject(program, `Duplicate function ${fn.name}.`);
      functionNames.add(fn.name);
    }
    const functionsByName = new Map(functions.map((fn) => [fn.name, fn]));
    for (const call of this.helperCalls) {
      const helper = functionsByName.get(call.name);
      if (!helper) this.rejectAtSpan(call.span, `Call references unknown helper ${call.name}.`, 'score(3);');
      if (helper.parameters.length !== call.argumentCount) this.rejectAtSpan(call.span, `Helper ${call.name} expects ${helper.parameters.length} arguments.`, `${call.name}(value);`);
    }
    const mainFunctions = functions.filter((fn) => fn.name === 'main');
    if (mainFunctions.length !== 1 || mainFunctions[0]?.parameters.length !== 0) this.reject(program, 'Exactly one zero-argument main function is required.');
    const ir: ScriptIR = {
      format: 'dungeon-scrivener-script-ir', schemaVersion: 1,
      scriptId: this.metadata.scriptId, sourceLanguage: 'javascript', sourcePath: this.metadata.sourcePath,
      entrypoint: 'main', functions,
    };
    return ir;
  }

  span(node: Ast): SourceSpan {
    return {
      path: this.metadata.sourcePath,
      startLine: this.positions.lines[node.start] ?? 1,
      startColumn: this.positions.columns[node.start] ?? 1,
      endLine: this.positions.lines[node.end] ?? 1,
      endColumn: this.positions.columns[node.end] ?? 1,
    };
  }

  reject(node: Ast, message: string, example?: string): never {
    const sourceSpan = this.span(node);
    throw new CompileFailure({
      code: DIAGNOSTIC_CODE,
      severity: 'error',
      message: `${message}${example ? ` Example: ${example}` : ''}`,
      path: this.metadata.sourcePath,
      sourceSpan,
      ...(example ? { suggestedFix: example } : {}),
      blocks: ['script-execution', 'play', 'export'],
    });
  }

  private rejectAtSpan(sourceSpan: SourceSpan, message: string, example?: string): never {
    throw new CompileFailure({
      code: DIAGNOSTIC_CODE, severity: 'error',
      message: `${message}${example ? ` Example: ${example}` : ''}`,
      path: this.metadata.sourcePath, sourceSpan,
      ...(example ? { suggestedFix: example } : {}),
      blocks: ['script-execution', 'play', 'export'],
    });
  }

  private checkAstBudgets(root: Ast): void {
    const stack: Array<{ node: Ast; depth: number }> = [{ node: root, depth: 1 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      this.astNodeCount += 1;
      if (this.astNodeCount > SCRIPT_IR_LIMITS.maxSyntaxNodes) this.reject(current.node, 'Script exceeds the 10,000 syntax node limit.');
      if (current.depth > SCRIPT_IR_LIMITS.maxNestingDepth) this.reject(current.node, 'Script exceeds the 64 syntax nesting limit.');
      for (const [key, child] of Object.entries(current.node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        if (record(child)) stack.push({ node: child, depth: current.depth + 1 });
        else if (Array.isArray(child)) {
          for (const item of child) if (record(item)) stack.push({ node: item, depth: current.depth + 1 });
        }
      }
    }
  }

  private compileFunction(node: Ast): ScriptFunction {
    if (node.async === true || node.generator === true) this.reject(node, 'Async and generator functions are unsupported.', 'function main() { return; }');
    const id = record(node.id) ? asAst(node.id) : undefined;
    if (!id || id.type !== 'Identifier' || typeof id.name !== 'string') this.reject(node, 'Function declarations require a simple identifier name.');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(id.name as string) || id.name === 'api' || id.name === 'len') this.reject(id, `Function name ${String(id.name)} is invalid or reserved.`);
    if (!Array.isArray(node.params) || !record(node.body)) this.reject(node, 'Function declaration is malformed.');
    const parameters: string[] = [];
    for (const parameter of node.params as unknown[]) {
      const param = asAst(parameter);
      if (param.type !== 'Identifier' || typeof param.name !== 'string') this.reject(param, 'Only positional identifier parameters are supported.', 'function score(value) { return value; }');
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(param.name as string) || param.name === 'api' || param.name === 'len' || parameters.includes(param.name as string)) this.reject(param, `Parameter ${String(param.name)} is invalid, reserved, or duplicated.`);
      parameters.push(param.name as string);
    }
    if (parameters.length > SCRIPT_IR_LIMITS.maxParametersPerFunction) this.reject(node, 'Function exceeds the 32 parameter limit.');
    const body = asAst(node.body);
    if (body.type !== 'BlockStatement' || !Array.isArray(body.body)) this.reject(body, 'Function body must be a block.');
    const names = new Set(parameters);
    this.declaredAcrossFunction = new Set(parameters);
    const kinds = new Map<string, StaticKind>(parameters.map((name) => [name, 'unknown']));
    const statements = this.compileStatements(body.body as unknown[], names, kinds, 1);
    return { name: id.name as string, parameters, body: statements, span: this.span(node) };
  }

  private compileStatements(nodes: readonly unknown[], declaredNames: Set<string>, kinds: Map<string, StaticKind>, depth: number): ScriptStatement[] {
    const output: ScriptStatement[] = [];
    for (const raw of nodes) {
      const node = asAst(raw);
      switch (node.type) {
        case 'VariableDeclaration': {
          if (node.kind !== 'let' && node.kind !== 'const') this.reject(node, 'Only let and const declarations are supported.', 'let count = 0;');
          if (!Array.isArray(node.declarations) || node.declarations.length !== 1) this.reject(node, 'Declare one local variable per statement.');
          const declarator = asAst(node.declarations[0]);
          const nameNode = record(declarator.id) ? asAst(declarator.id) : undefined;
          if (!nameNode || nameNode.type !== 'Identifier' || typeof nameNode.name !== 'string') this.reject(declarator, 'Destructuring declarations are unsupported.', 'const count = 0;');
          if (!declarator.init) this.reject(declarator, 'Every local declaration needs an initializer.', 'let count = 0;');
          this.declare(nameNode.name as string, declarator, declaredNames);
          const value = this.compileExpression(asAst(declarator.init), kinds, depth + 1);
          kinds.set(nameNode.name as string, this.staticKind(asAst(declarator.init), kinds));
          output.push({ kind: 'declare-local', name: nameNode.name as string, mutable: node.kind === 'let', value, span: this.span(node) });
          break;
        }
        case 'IfStatement': {
          const conditionNode = asAst(node.test);
          const condition = this.compileExpression(conditionNode, kinds, depth + 1);
          const thenNode = asAst(node.consequent);
          const elseNode = node.alternate ? asAst(node.alternate) : undefined;
          const thenStatements = this.compileBlock(thenNode, new Set(declaredNames), new Map(kinds), depth + 1);
          const elseStatements = elseNode ? this.compileBlock(elseNode, new Set(declaredNames), new Map(kinds), depth + 1) : [];
          output.push({ kind: 'if', condition, then: thenStatements, else: elseStatements, span: this.span(node) });
          break;
        }
        case 'WhileStatement': {
          const conditionNode = asAst(node.test);
          if (conditionNode.type === 'Literal' && conditionNode.value === true) this.reject(conditionNode, 'A literal-true loop is statically unbounded.', 'while (count < 3) { count = count + 1; }');
          const condition = this.compileExpression(conditionNode, kinds, depth + 1);
          const bodyNames = new Set(declaredNames);
          const statements = this.compileBlock(asAst(node.body), bodyNames, new Map(kinds), depth + 1);
          output.push({ kind: 'while', condition, body: statements, span: this.span(node) });
          break;
        }
        case 'ExpressionStatement': {
          const expression = asAst(node.expression);
          if (expression.type === 'AssignmentExpression') {
            if (expression.operator !== '=') this.reject(expression, 'Compound assignments are unsupported.', 'count = count + 1;');
            const target = asAst(expression.left);
            if (target.type !== 'Identifier' || typeof target.name !== 'string') this.reject(target, 'Assignments may target local names only; collection mutation is unsupported.', 'count = count + 1;');
            if (!declaredNames.has(target.name as string)) this.reject(target, `Assignment to undeclared local ${String(target.name)} is not allowed.`, 'let score = 0; score = 1;');
            const valueNode = asAst(expression.right);
            const value = this.compileExpression(valueNode, kinds, depth + 1);
            const previousKind = kinds.get(target.name as string) ?? 'unknown';
            const nextKind = this.staticKind(valueNode, kinds);
            if (previousKind !== 'unknown' && nextKind !== 'unknown' && previousKind !== nextKind) this.reject(expression, `Assignment changes the value type of local ${String(target.name)}.`);
            output.push({ kind: 'assign-local', name: target.name as string, value, span: this.span(expression) });
            break;
          }
          if (expression.type !== 'CallExpression') this.reject(expression, 'Only assignment and engine request calls are valid expression statements.', 'api.emit("ready", {});');
          const call = this.compileCall(expression, kinds, depth + 1, true);
          if (call.kind === 'call' && call.target.kind === 'capability' && call.target.name !== 'api.request' && call.target.name !== 'api.emit') {
            this.reject(expression, `${call.target.name} must be used as an expression, not a statement.`, 'const value = api.randomFloat();');
          }
          output.push({ kind: 'expression', expression: call, span: this.span(node) });
          break;
        }
        case 'ReturnStatement': {
          const value = node.argument ? this.compileExpression(asAst(node.argument), kinds, depth + 1) : undefined;
          output.push({ kind: 'return', ...(value ? { value } : {}), span: this.span(node) });
          break;
        }
        case 'EmptyStatement': this.reject(node, 'Empty statements are not part of the documented subset.'); break;
        default:
          this.reject(node, `Unsupported statement ${node.type}.`, 'if (ready) { api.emit("ready", {}); }');
      }
    }
    return output;
  }

  private compileBlock(node: Ast, names: Set<string>, kinds: Map<string, StaticKind>, depth: number): ScriptStatement[] {
    if (node.type === 'BlockStatement' && Array.isArray(node.body)) return this.compileStatements(node.body, names, kinds, depth);
    return this.compileStatements([node], names, kinds, depth);
  }

  private declare(name: string, node: Ast, names: Set<string>): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) this.reject(node, `Identifier ${name} is outside the supported ASCII identifier form.`);
    if (name === 'api' || name === 'len' || this.declaredAcrossFunction.has(name)) this.reject(node, `Local ${name} is reserved or redeclared.`);
    this.declaredAcrossFunction.add(name);
    names.add(name);
  }

  private compileExpression(node: Ast, kinds: Map<string, StaticKind>, depth: number): ScriptExpression {
    switch (node.type) {
      case 'Literal': {
        if (typeof node.value === 'boolean' || typeof node.value === 'string') {
          if (typeof node.value === 'string') {
            this.validateStringLiteral(node);
            if (utf8Bytes(node.value) > SCRIPT_IR_LIMITS.maxStringBytes) this.reject(node, 'String literal exceeds the 16 KiB limit.');
          }
          return { kind: 'literal', value: node.value, span: this.span(node) };
        }
        if (typeof node.value === 'number' && Number.isFinite(node.value)) {
          if (typeof node.raw !== 'string' || !DECIMAL.test(node.raw)) this.reject(node, 'Only finite decimal numeric literals are supported.', 'const value = 12.5;');
          return { kind: 'literal', value: Object.is(node.value, -0) ? 0 : node.value, span: this.span(node) };
        }
        this.reject(node, 'Only finite decimal numbers, strings, and booleans are supported.', 'const enabled = true;');
      }
      case 'Identifier':
        if (typeof node.name !== 'string') this.reject(node, 'Malformed identifier.');
        if (node.name === 'eval') this.reject(node, 'eval is forbidden.', 'api.request(effect);');
        if (node.name === 'NaN' || node.name === 'Infinity' || node.name === 'undefined' || node.name === 'null') this.reject(node, `${String(node.name)} is not a supported script value.`);
        if (node.name === 'api' || node.name === 'len' || kinds.has(node.name as string)) {
          if (node.name === 'api' || node.name === 'len') this.reject(node, `${String(node.name)} can only be used as a supported call target.`);
          return { kind: 'local', name: node.name as string, span: this.span(node) };
        }
        this.reject(node, `Implicit global or undeclared local ${String(node.name)} is not allowed.`);
      case 'ArrayExpression': {
        if (!Array.isArray(node.elements)) this.reject(node, 'Malformed array literal.');
        const items: ScriptExpression[] = [];
        for (const item of node.elements as unknown[]) {
          if (!item) this.reject(node, 'Array holes are unsupported.', '[1, 2, 3]');
          const child = asAst(item);
          if (child.type === 'SpreadElement') this.reject(child, 'Array spread is unsupported.', '[first, second]');
          items.push(this.compileExpression(child, kinds, depth + 1));
        }
        if (items.length > SCRIPT_IR_LIMITS.maxCollectionMembers) this.reject(node, 'Array exceeds 1,024 members.');
        return { kind: 'array', items, span: this.span(node) };
      }
      case 'ObjectExpression': {
        if (!Array.isArray(node.properties)) this.reject(node, 'Malformed object literal.');
        const entries: Array<{ key: string; value: ScriptExpression }> = [];
        const keys = new Set<string>();
        for (const raw of node.properties as unknown[]) {
          const property = asAst(raw);
          if (property.type === 'SpreadElement') this.reject(property, 'Object spread is unsupported.');
          if (property.type !== 'Property' || property.kind !== 'init' || property.method === true || property.computed === true || property.shorthand === true) {
            this.reject(property, 'Only explicit, static string-keyed object properties are supported.', '{ name: value }');
          }
          const keyNode = asAst(property.key);
          let key: string;
          if (keyNode.type === 'Identifier' && typeof keyNode.name === 'string') key = keyNode.name;
          else if (keyNode.type === 'Literal' && typeof keyNode.value === 'string') { this.validateStringLiteral(keyNode); key = keyNode.value; }
          else this.reject(keyNode, 'Object keys must be string literals or identifier names.');
          if (keys.has(key)) this.reject(property, `Duplicate object key ${key}.`);
          keys.add(key);
          entries.push({ key, value: this.compileExpression(asAst(property.value), kinds, depth + 1) });
        }
        if (entries.length > SCRIPT_IR_LIMITS.maxCollectionMembers) this.reject(node, 'Object exceeds 1,024 members.');
        return { kind: 'map', entries, span: this.span(node) };
      }
      case 'MemberExpression': {
        if (!node.computed) this.reject(node, 'Direct property traversal is unsupported; use a fixed api capability call or indexed collection access.', 'items[index]');
        const target = asAst(node.object);
        if (target.type === 'Identifier' && target.name === 'api') this.reject(node, 'Computed capability access is forbidden.', 'api.read(scope, key)');
        return { kind: 'index', target: this.compileExpression(target, kinds, depth + 1), index: this.compileExpression(asAst(node.property), kinds, depth + 1), span: this.span(node) };
      }
      case 'UnaryExpression': {
        if (node.operator !== '!' && node.operator !== '-') this.reject(node, `Unary operator ${String(node.operator)} is unsupported.`);
        return { kind: 'unary', operator: node.operator === '!' ? 'not' : 'negate', operand: this.compileExpression(asAst(node.argument), kinds, depth + 1), span: this.span(node) };
      }
      case 'BinaryExpression':
      case 'LogicalExpression': {
        const operator = this.binaryOperator(node, kinds);
        return { kind: 'binary', operator, left: this.compileExpression(asAst(node.left), kinds, depth + 1), right: this.compileExpression(asAst(node.right), kinds, depth + 1), span: this.span(node) };
      }
      case 'CallExpression': return this.compileCall(node, kinds, depth + 1, false);
      case 'ParenthesizedExpression': return this.compileExpression(asAst(node.expression), kinds, depth + 1);
      case 'ChainExpression': this.reject(node, 'Optional chaining is unsupported.');
      default: this.reject(node, `Unsupported expression ${node.type}.`, 'const total = score(3) + 1;');
    }
  }

  private binaryOperator(node: Ast, kinds: Map<string, StaticKind>): ScriptBinaryOperator {
    const operators: Record<string, ScriptBinaryOperator> = {
      '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'modulo',
      '===': 'equal', '!==': 'not-equal', '<': 'less-than', '<=': 'less-or-equal', '>': 'greater-than', '>=': 'greater-or-equal',
      '&&': 'and', '||': 'or',
    };
    if (node.operator === '+') {
      const left = this.staticKind(asAst(node.left), kinds);
      const right = this.staticKind(asAst(node.right), kinds);
      if (left === 'string' && right === 'string') return 'concat';
      if (left === 'number' && right === 'number') return 'add';
      this.reject(node, 'The + operator requires two known strings or two known numbers.', 'const total = 2 + 3;');
    }
    if (node.operator === '==' || node.operator === '!=') this.reject(node, 'Loose equality is unsupported; use === or !==.', 'ready === true');
    const operator = operators[String(node.operator)];
    if (!operator) this.reject(node, `Unsupported operator ${String(node.operator)}.`);
    return operator;
  }

  private staticKind(node: Ast, kinds: Map<string, StaticKind>): StaticKind {
    if (node.type === 'Literal') {
      if (typeof node.value === 'string') return 'string';
      if (typeof node.value === 'number') return 'number';
      if (typeof node.value === 'boolean') return 'boolean';
    }
    if (node.type === 'Identifier') return kinds.get(String(node.name)) ?? 'unknown';
    if (node.type === 'ArrayExpression') return 'array';
    if (node.type === 'ObjectExpression') return 'map';
    if (node.type === 'UnaryExpression' && node.operator === '-') return 'number';
    if (node.type === 'CallExpression') {
      const callee = asAst(node.callee);
      if (callee.type === 'Identifier' && callee.name === 'len') return 'number';
      if (callee.type === 'MemberExpression' && record(callee.object) && callee.object.name === 'api') {
        const apiKinds: Record<string, StaticKind> = { 'hasTag': 'boolean', 'randomInt': 'number', 'randomFloat': 'number', 'read': 'unknown' };
        return apiKinds[String(asAst(callee.property).name)] ?? 'void';
      }
    }
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      if (['===', '!=='].includes(String(node.operator))) {
        const left = this.staticKind(asAst(node.left), kinds);
        const right = this.staticKind(asAst(node.right), kinds);
        if (['array', 'map'].includes(left) || ['array', 'map'].includes(right)) this.reject(node, 'Arrays and maps cannot be compared for equality.');
        return 'boolean';
      }
      if (['<', '<=', '>', '>=', '&&', '||'].includes(String(node.operator))) return 'boolean';
      if (node.operator === '+') {
        const left = this.staticKind(asAst(node.left), kinds);
        const right = this.staticKind(asAst(node.right), kinds);
        return left === right ? left : 'unknown';
      }
      return 'number';
    }
    if (node.type === 'UnaryExpression' && node.operator === '!') return 'boolean';
    if (node.type === 'MemberExpression' && node.computed) {
      const target = asAst(node.object);
      if (target.type === 'Identifier' && kinds.get(String(target.name)) === 'array') return 'unknown';
    }
    return 'unknown';
  }

  private compileCall(node: Ast, kinds: Map<string, StaticKind>, depth: number, statement: boolean): ScriptExpression {
    if (node.optional === true || !Array.isArray(node.arguments)) this.reject(node, 'Optional or malformed calls are unsupported.');
    const callee = asAst(node.callee);
    let target: { kind: 'helper'; name: string } | { kind: 'capability'; name: 'api.read' | 'api.hasTag' | 'api.request' | 'api.emit' | 'api.randomInt' | 'api.randomFloat' | 'len' };
    let capability: string | undefined;
    if (callee.type === 'Identifier' && typeof callee.name === 'string') {
      if (callee.name === 'eval' || callee.name === 'Function') this.reject(callee, `${String(callee.name)} is forbidden.`, 'api.request(effect);');
      if (callee.name === 'api') this.reject(callee, 'The api object cannot be called directly.');
      if (kinds.has(callee.name)) this.reject(callee, 'Function values and calls through local variables are unsupported.', 'score(value);');
      if (callee.name === 'len') target = { kind: 'capability', name: 'len' };
      else {
        target = { kind: 'helper', name: callee.name };
        this.helperCalls.push({ name: callee.name, argumentCount: node.arguments.length, span: this.span(node) });
      }
    } else if (callee.type === 'MemberExpression' && !callee.computed && !callee.optional) {
      const object = asAst(callee.object);
      const property = asAst(callee.property);
      if (object.type !== 'Identifier' || object.name !== 'api' || property.type !== 'Identifier' || typeof property.name !== 'string') {
        this.reject(callee, 'Only fixed api capability calls may use property-call syntax.', 'api.read(scope, key)');
      }
      capability = `api.${String(property.name)}`;
      const supported = new Set(['api.read', 'api.hasTag', 'api.request', 'api.emit', 'api.randomInt', 'api.randomFloat']);
      if (!supported.has(capability)) this.reject(callee, `Unknown engine capability ${capability}.`);
      target = { kind: 'capability', name: capability as 'api.read' | 'api.hasTag' | 'api.request' | 'api.emit' | 'api.randomInt' | 'api.randomFloat' };
    } else this.reject(callee, 'Calls must target a declared helper, len, or a fixed api capability.', 'api.read(scope, key)');
    const name = capability ?? (target.kind === 'helper' ? target.name : target.name);
    if ((name === 'api.request' || name === 'api.emit') && !statement) this.reject(node, `${name} is a statement-only capability.`);
    const args: ScriptExpression[] = [];
    for (const argument of node.arguments as unknown[]) {
      const arg = asAst(argument);
      if (arg.type === 'SpreadElement') this.reject(arg, 'Spread call arguments are unsupported.');
      args.push(this.compileExpression(arg, kinds, depth + 1));
    }
    const arities: Record<string, number> = {
      'api.read': 2, 'api.hasTag': 2, 'api.request': 1, 'api.emit': 2,
      'api.randomInt': 2, 'api.randomFloat': 0, len: 1,
    };
    if (capability && arities[capability] !== args.length) this.reject(node, `${capability} expects ${arities[capability]} arguments.`, `${capability}(${capability === 'api.randomFloat' ? '' : 'value'});`);
    if (capability) {
      const argumentKinds: Record<string, readonly StaticKind[]> = {
        'api.read': ['map', 'string'], 'api.hasTag': ['string', 'string'],
        'api.request': ['map'], 'api.emit': ['string', 'map'],
        'api.randomInt': ['number', 'number'], 'api.randomFloat': [], len: ['unknown'],
      };
      for (let index = 0; index < args.length; index += 1) {
        const expected = argumentKinds[capability]?.[index];
        const actual = this.staticKind(asAst((node.arguments as unknown[])[index]), kinds);
        if (expected && expected !== 'unknown' && actual !== 'unknown' && actual !== expected) {
          this.reject(asAst((node.arguments as unknown[])[index]), `${capability} argument ${index + 1} must be ${expected}.`);
        }
      }
      if (capability === 'api.request') {
        const effect = asAst((node.arguments as unknown[])[0]);
        if (effect.type !== 'ObjectExpression') this.reject(effect, 'api.request requires a typed effect object literal.', 'api.request({ kind: "increment-state", target: ..., amount: 1 });');
        const kindProperty = (effect.properties as unknown[]).map(asAst).find((property) => property.type === 'Property' && this.propertyName(asAst(property.key)) === 'kind');
        const effectKindNode = kindProperty && asAst(kindProperty.value);
        const effectKind = effectKindNode?.type === 'Literal' ? effectKindNode.value : undefined;
        const allowedEffects = new Set(['set-state', 'increment-state', 'add-tag', 'remove-tag', 'emit-event', 'navigate', 'add-item', 'remove-item', 'start-conversation', 'interrupt-conversation', 'resume-conversation']);
        if (typeof effectKind !== 'string' || !allowedEffects.has(effectKind)) this.reject(effect, 'api.request effect kind is unknown or forbidden; run-script cannot be requested.', 'api.request({ kind: "set-state", target: ..., value: true });');
      }
    }
    return { kind: 'call', target, arguments: args, span: this.span(node) };
  }

  private propertyName(key: Ast): string | undefined {
    if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
    if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
    return undefined;
  }

  private validateStringLiteral(node: Ast): void {
    if (typeof node.raw !== 'string' || (node.raw[0] !== '"' && node.raw[0] !== "'")) this.reject(node, 'String must use a single or double quote.');
    const raw = node.raw as string;
    const quote = raw[0]!;
    for (let index = 1; index < raw.length - 1; index += 1) {
      if (raw[index] !== '\\') continue;
      index += 1;
      const escaped = raw[index];
      if ([quote, '\\', 'n', 'r', 't'].includes(String(escaped))) continue;
      if (escaped === 'u') {
        if (raw[index + 1] === '{') {
          const end = raw.indexOf('}', index + 2);
          const digits = end < 0 ? '' : raw.slice(index + 2, end);
          const codePoint = /^[0-9a-fA-F]{1,6}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
          if (codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) this.reject(node, 'Unicode escape must resolve to a Unicode scalar value.');
          index = end;
          continue;
        }
        const digits = raw.slice(index + 1, index + 5);
        const codeUnit = /^[0-9a-fA-F]{4}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          const nextEscape = raw.slice(index + 5, index + 7) === '\\u' ? raw.slice(index + 7, index + 11) : '';
          const lowSurrogate = /^[dD][c-fC-F][0-9a-fA-F]{2}$/.test(nextEscape) ? Number.parseInt(nextEscape, 16) : -1;
          if (lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) this.reject(node, 'Unicode escape must resolve to a Unicode scalar value.');
          index += 10;
          continue;
        }
        if (codeUnit < 0 || (codeUnit >= 0xdc00 && codeUnit <= 0xdfff)) this.reject(node, 'Unicode escape must resolve to a Unicode scalar value.');
        index += 4;
        continue;
      }
      this.reject(node, `Escape \\${String(escaped)} is not in the documented string subset.`);
    }
  }
}

function parseErrorDiagnostic(error: unknown, source: string, metadata: JavaScriptScriptMetadata): Diagnostic {
  const positioned = error as { message?: unknown; pos?: unknown };
  const offset = typeof positioned.pos === 'number' ? Math.max(0, Math.min(source.length, positioned.pos)) : 0;
  const position = scalarPositionMap(source);
  const line = position.lines[offset] ?? 1;
  const column = position.columns[offset] ?? 1;
  const tail = source.slice(offset);
  const width = tail.codePointAt(0) && tail.codePointAt(0)! > 0xffff ? 2 : Math.min(1, tail.length);
  return {
    code: DIAGNOSTIC_CODE,
    severity: 'error',
    message: `JavaScript parse error: ${typeof positioned.message === 'string' ? positioned.message : 'invalid syntax'}. Example: function main() { const total = 2 + 3; }`,
    path: metadata.sourcePath,
    sourceSpan: { path: metadata.sourcePath, startLine: line, startColumn: column, endLine: line, endColumn: column + (width === 2 ? 1 : width) },
    suggestedFix: 'For example, use function main() { const total = 2 + 3; return; }. Use only syntax from docs/contracts/script-subset.md.',
    blocks: ['script-execution', 'play', 'export'],
  };
}

/** Parse and compile a JavaScript source string without evaluating it. */
export function parseJavaScript(source: string, metadata: JavaScriptScriptMetadata): JavaScriptCompileResult {
  if (!isValidSourcePath(metadata.sourcePath)) {
    return { ok: false, diagnostics: [{ code: DIAGNOSTIC_CODE, severity: 'error', message: 'Script source path is invalid.', path: metadata.sourcePath, blocks: ['script-execution', 'play', 'export'] }] };
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(metadata.scriptId)) {
    return { ok: false, diagnostics: [{ code: DIAGNOSTIC_CODE, severity: 'error', message: 'Script ID is invalid.', path: metadata.sourcePath, blocks: ['script-execution', 'play', 'export'] }] };
  }
  if (source.charCodeAt(0) === 0xfeff || !hasValidUnicodeScalars(source)) {
    return { ok: false, diagnostics: [{ code: DIAGNOSTIC_CODE, severity: 'error', message: 'Source must be UTF-8 text without a BOM and contain valid Unicode scalar values.', path: metadata.sourcePath, blocks: ['script-execution', 'play', 'export'] }] };
  }
  if (utf8Bytes(source) > SCRIPT_IR_LIMITS.maxSourceBytes) {
    return { ok: false, diagnostics: [{ code: DIAGNOSTIC_CODE, severity: 'error', message: 'JavaScript source exceeds the 128 KiB limit.', path: metadata.sourcePath, blocks: ['script-execution', 'play', 'export'] }] };
  }
  try {
    const program = parse(source, { ecmaVersion: 2022, sourceType: 'script', allowAwaitOutsideFunction: false, allowReturnOutsideFunction: false }) as unknown as Ast;
    const ir = new JavaScriptCompiler(source, metadata).compile(program);
    return { ok: true, ir, diagnostics: [] };
  } catch (error) {
    if (error instanceof CompileFailure) return { ok: false, diagnostics: [error.diagnostic] };
    return { ok: false, diagnostics: [parseErrorDiagnostic(error, source, metadata)] };
  }
}
