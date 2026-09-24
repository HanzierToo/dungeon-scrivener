import { parser } from '@lezer/python';
import type { Diagnostic, ScriptBinaryOperator, ScriptCapabilityName, ScriptExpression, ScriptFunction, ScriptIR, ScriptStatement, SourceSpan } from '@dungeon-scrivener/model';
import { validateScriptIR } from '../../ir/index.js';

export interface PythonScriptMetadata {
  readonly scriptId: string;
  readonly sourcePath: string;
}

export type PythonParseResult =
  | { readonly ok: true; readonly ir: ScriptIR }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const EXAMPLE = 'Example: def main():\\n    api.emit("ready", {})';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
type Node = { readonly name: string; readonly from: number; readonly to: number; readonly children: readonly Node[] };

class PythonCompileError extends Error {
  constructor(readonly node: Node, message: string) { super(message); }
}

function treeNode(tree: ReturnType<typeof parser.parse>, source: string): Node {
  const read = (cursor: ReturnType<typeof tree.cursor>): Node => {
    const children: Node[] = [];
    if (cursor.firstChild()) {
      do { children.push(read(cursor)); } while (cursor.nextSibling());
      cursor.parent();
    }
    return { name: cursor.name, from: cursor.from, to: cursor.to, children };
  };
  void source;
  return read(tree.cursor());
}

function scalarColumn(source: string, offset: number): number {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return [...source.slice(lineStart, offset)].length + 1;
}

class Compiler {
  private readonly functions = new Map<string, Node>();
  private readonly declaredAcrossFunction = new Set<string>();
  constructor(private readonly source: string, private readonly root: Node, private readonly metadata: PythonScriptMetadata) {}

  compile(): ScriptIR {
    this.checkIndentation();
    const syntaxError = this.findNode(this.root, '⚠');
    if (syntaxError) this.reject(syntaxError, 'Invalid Python syntax.');
    const top = this.root.children.filter((child) => child.name !== 'Comment');
    for (const node of top) {
      if (node.name !== 'FunctionDefinition') this.reject(node, 'Only top-level function definitions are supported.');
      const name = node.children.find((child) => child.name === 'VariableName');
      if (!name) this.reject(node, 'Malformed function definition.');
      if (!IDENTIFIER.test(this.text(name!)) || this.text(name!) === 'main' && this.functions.has('main')) this.reject(name!, 'Function name is invalid or duplicated.');
      if (this.functions.has(this.text(name!))) this.reject(name!, 'Duplicate function definition.');
      if (this.functions.size >= 64) this.reject(node, 'Function limit exceeded.');
      this.functions.set(this.text(name!), node);
    }
    if (!this.functions.has('main')) this.reject(this.root, 'A zero-argument main() function is required.');
    const compiled = [...this.functions.entries()].map(([name, fn]) => this.compileFunction(name, fn));
    const ir: ScriptIR = {
      format: 'dungeon-scrivener-script-ir', schemaVersion: 1,
      scriptId: this.metadata.scriptId, sourceLanguage: 'python', sourcePath: this.metadata.sourcePath,
      entrypoint: 'main', functions: compiled,
    };
    const validation = validateScriptIR(ir);
    if (!validation.ok) {
      const first = validation.diagnostics[0];
      throw new PythonCompileError(this.root, first?.message ?? 'Generated IR did not pass validation.');
    }
    return ir;
  }

  private compileFunction(name: string, node: Node): ScriptFunction {
    const nameNode = node.children.find((child) => child.name === 'VariableName')!;
    const params = node.children.find((child) => child.name === 'ParamList');
    const body = node.children.find((child) => child.name === 'Body');
    if (!params || !body) this.reject(node, 'Malformed function definition.');
    const paramNames = params!.children.filter((child) => child.name === 'VariableName').map((child) => this.text(child));
    if (params!.children.some((child) => !['(', ')', 'VariableName', ','].includes(child.name))) this.reject(params!, 'Only positional identifier parameters are supported.');
    if (paramNames.length > 32 || new Set(paramNames).size !== paramNames.length || paramNames.some((param) => !IDENTIFIER.test(param) || ['api', 'len'].includes(param))) this.reject(params!, 'Function parameters are invalid, duplicated, reserved, or exceed 32.');
    if (name === 'main' && paramNames.length !== 0) this.reject(params!, 'main() must not have parameters.');
    this.declaredAcrossFunction.clear();
    for (const param of paramNames) this.declaredAcrossFunction.add(param);
    return { name, parameters: paramNames, body: this.statements(body!.children.filter((child) => ![':', 'Comment'].includes(child.name)), new Set(paramNames)), span: this.span(node) };
  }

  private statements(nodes: readonly Node[], declared: Set<string>): ScriptStatement[] {
    return nodes.map((node) => {
      switch (node.name) {
        case 'AssignStatement': return this.assignment(node, declared);
        case 'IfStatement': {
          const conditionNode = node.children.find((child) => !['if', 'Body'].includes(child.name));
          const bodies = node.children.filter((child) => child.name === 'Body');
          if (!conditionNode || bodies.length < 1 || bodies.length > 2) this.reject(node, 'Malformed if statement.');
          const cond = this.expression(conditionNode!, declared);
          if (cond.kind === 'literal' && typeof cond.value !== 'boolean') this.reject(conditionNode!, 'Conditions must be booleans; Python truthiness is not supported.');
          return { kind: 'if', condition: cond, then: this.statements(bodies[0]!.children.filter((child) => child.name !== ':'), new Set(declared)), else: bodies[1] ? this.statements(bodies[1].children.filter((child) => child.name !== ':'), new Set(declared)) : [], span: this.span(node) };
        }
        case 'WhileStatement': {
          const conditionNode = node.children.find((child) => !['while', 'Body'].includes(child.name));
          const body = node.children.find((child) => child.name === 'Body');
          if (!conditionNode || !body) this.reject(node, 'Malformed while statement.');
          if (this.text(conditionNode!) === 'True') this.reject(conditionNode!, 'A literal-true loop is statically unbounded.');
          const condition = this.expression(conditionNode!, declared);
          if (condition.kind === 'literal' && typeof condition.value !== 'boolean') this.reject(conditionNode!, 'Conditions must be booleans; Python truthiness is not supported.');
          return { kind: 'while', condition, body: this.statements(body!.children.filter((child) => child.name !== ':'), new Set(declared)), span: this.span(node) };
        }
        case 'ReturnStatement': {
          const valueNode = node.children.find((child) => child.name !== 'return');
          return { kind: 'return', ...(valueNode ? { value: this.expression(valueNode, declared) } : {}), span: this.span(node) };
        }
        case 'ExpressionStatement': {
          if (node.children.length !== 1) this.reject(node, 'Malformed expression statement.');
          const expression = this.expression(node.children[0]!, declared);
          if (expression.kind !== 'call' || expression.target.kind !== 'capability' || !['api.request', 'api.emit'].includes(expression.target.name)) this.reject(node, 'Only api.request(...) and api.emit(...) are valid expression statements.');
          return { kind: 'expression', expression, span: this.span(node) };
        }
        case 'PassStatement': this.reject(node, 'Empty function and control-flow suites are unsupported.');
        default: this.reject(node, `Unsupported statement ${node.name}.`);
      }
    });
  }

  private assignment(node: Node, declared: Set<string>): ScriptStatement {
    const name = node.children.find((child) => child.name === 'VariableName');
    const op = node.children.find((child) => child.name === 'AssignOp');
    const valueNode = [...node.children].reverse().find((child) => child !== name && child !== op);
    if (!name || !op || !valueNode || this.text(op) !== '=') this.reject(node, 'Only simple local assignment is supported.');
    const key = this.text(name!);
    if (!IDENTIFIER.test(key) || ['api', 'len', 'True', 'False', 'None'].includes(key)) this.reject(name!, 'Invalid or reserved local name.');
    const value = this.expression(valueNode!, declared);
    if (!declared.has(key)) {
      declared.add(key);
      this.declaredAcrossFunction.add(key);
      return { kind: 'declare-local', name: key, mutable: true, value, span: this.span(node) };
    }
    return { kind: 'assign-local', name: key, value, span: this.span(node) };
  }

  private expression(node: Node, declared: Set<string>): ScriptExpression {
    const children = node.children;
    switch (node.name) {
      case 'Number': {
        const token = this.text(node);
        if (!/^(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?$/u.test(token)) this.reject(node, 'Only decimal numeric literals are supported.');
        const value = Number(token);
        if (!Number.isFinite(value) || !token.includes('.') && !/[eE]/.test(token) && !Number.isSafeInteger(value)) this.reject(node, 'Numbers must be finite and integer literals must be safe integers.');
        return { kind: 'literal', value, span: this.span(node) };
      }
      case 'String': {
        let value: unknown;
        try { value = JSON.parse(this.text(node).replace(/^'/, '"').replace(/'$/, '"')); } catch { this.reject(node, 'Only simple quoted string literals with supported escapes are allowed.'); }
        if (typeof value !== 'string') this.reject(node, 'Invalid string literal.');
        return { kind: 'literal', value: value as string, span: this.span(node) };
      }
      case 'Boolean': return { kind: 'literal', value: this.text(node) === 'True', span: this.span(node) };
      case 'VariableName': {
        const name = this.text(node);
        if (name === 'None') this.reject(node, 'None is unsupported because the shared script IR has no null value.');
        if (!declared.has(name)) this.reject(node, `Undeclared local or unsupported name ${name}.`);
        return { kind: 'local', name, span: this.span(node) };
      }
      case 'ArrayExpression': return { kind: 'array', items: children.filter((child) => !['[', ']', ','].includes(child.name)).map((child) => this.expression(child, declared)), span: this.span(node) };
      case 'DictionaryExpression': {
        const entries: { key: string; value: ScriptExpression }[] = [];
        for (let i = 0; i < children.length;) {
          if (['{', '}', ','].includes(children[i]!.name)) { i += 1; continue; }
          const key = children[i++];
          if (!key || key.name !== 'String' || this.text(children[i]!) !== ':') this.reject(key ?? node, 'Dict keys must be string literals.');
          i += 1;
          const value = children[i++];
          if (!value) this.reject(node, 'Malformed dict entry.');
          const decoded = this.expression(key!, declared);
          if (decoded.kind !== 'literal' || typeof decoded.value !== 'string' || entries.some((entry) => entry.key === decoded.value)) this.reject(key!, 'Dict keys must be unique string literals.');
          entries.push({ key: (decoded as { value: string }).value, value: this.expression(value!, declared) });
          if (children[i]?.name === ',') i += 1;
        }
        return { kind: 'map', entries, span: this.span(node) };
      }
      case 'MemberExpression': {
        const base = children[0];
        if (base?.name === 'VariableName' && this.text(base) === 'api' && children[1]?.name === '.' && children[2]?.name === 'PropertyName') {
          const method = this.text(children[2]!);
          const name = `api.${method}`;
          if (!['read', 'hasTag', 'request', 'emit', 'randomInt', 'randomFloat'].includes(method)) this.reject(node, `Unsupported engine capability ${name}.`);
          return { kind: 'local', name: 'api', span: this.span(node) } as never;
        }
        if (children[1]?.name === '[' && children[3]?.name === ']') return { kind: 'index', target: this.expression(children[0]!, declared), index: this.expression(children[2]!, declared), span: this.span(node) };
        this.reject(node, 'Attribute traversal is unsupported except fixed api capability calls.');
      }
      case 'CallExpression': {
        const callee = children[0];
        const argsNode = children.find((child) => child.name === 'ArgList');
        if (!callee || !argsNode) this.reject(node, 'Malformed call.');
        const args: ScriptExpression[] = [];
        for (const child of argsNode!.children) {
          if (['(', ')', ','].includes(child.name)) continue;
          if (child.name === 'KeywordArg' || child.name === 'StarredExpression') this.reject(child, 'Keyword and unpacked arguments are unsupported.');
          args.push(this.expression(child, declared));
        }
        if (callee!.name === 'VariableName') {
          const name = this.text(callee!);
          if (name === 'len') return { kind: 'call', target: { kind: 'capability', name: 'len' }, arguments: args, span: this.span(node) };
          if (!this.functions.has(name)) this.reject(callee!, `Call to undeclared helper ${name}.`);
          return { kind: 'call', target: { kind: 'helper', name }, arguments: args, span: this.span(node) };
        }
        if (callee!.name === 'MemberExpression' && callee!.children[0]?.name === 'VariableName' && this.text(callee!.children[0]!) === 'api') {
          const method = this.text(callee!.children[2]!);
          const capability = `api.${method}` as ScriptCapabilityName;
          if (!['api.read', 'api.hasTag', 'api.request', 'api.emit', 'api.randomInt', 'api.randomFloat'].includes(capability)) this.reject(callee!, `Unsupported engine capability ${capability}.`);
          return { kind: 'call', target: { kind: 'capability', name: capability }, arguments: args, span: this.span(node) };
        }
        this.reject(callee!, 'Arbitrary function calls are unsupported.');
      }
      case 'UnaryExpression': {
        const op = children[0];
        const operand = children.at(-1);
        if (!op || !operand) this.reject(node, 'Malformed unary expression.');
        if (this.text(op!) === 'not') return { kind: 'unary', operator: 'not', operand: this.expression(operand!, declared), span: this.span(node) };
        if (this.text(op!) === '-') return { kind: 'unary', operator: 'negate', operand: this.expression(operand!, declared), span: this.span(node) };
        this.reject(op!, 'Only not and numeric negation are supported.');
      }
      case 'BinaryExpression': {
        if (children.length !== 3) this.reject(node, 'Chained comparisons and complex operators are unsupported.');
        const left = this.expression(children[0]!, declared);
        const op = this.text(children[1]!);
        const right = this.expression(children[2]!, declared);
        const operators: Record<string, ScriptBinaryOperator> = {
          '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'modulo',
          '==': 'equal', '!=': 'not-equal', '<': 'less-than', '<=': 'less-or-equal', '>': 'greater-than', '>=': 'greater-or-equal',
          and: 'and', or: 'or',
        };
        const operator = operators[op];
        if (!operator) this.reject(children[1]!, `Operator ${op} is outside the supported subset.`);
        return { kind: 'binary', operator: operator!, left, right, span: this.span(node) };
      }
      case 'ParenthesizedExpression': if (children.length === 3) return this.expression(children[1]!, declared); else this.reject(node, 'Malformed parentheses.');
      default: this.reject(node, `Unsupported expression ${node.name}.`);
    }
  }

  private checkIndentation(): void {
    const lines = this.source.split(/\r?\n/u);
    let indentWidth: number | undefined;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (/\t/u.test(line.match(/^\s*/u)?.[0] ?? '')) this.rejectOffset(this.offsetOfLine(i), 'Tabs are unsupported for indentation.');
      const width = (line.match(/^ */u)?.[0] ?? '').length;
      if (line.trim() && width > 0) {
        if (indentWidth === undefined) indentWidth = width;
        if (width % indentWidth !== 0) this.rejectOffset(this.offsetOfLine(i), 'Indentation must use a consistent multiple of the first suite indentation width.');
      }
    }
  }

  private findNode(node: Node, name: string): Node | undefined {
    if (node.name === name) return node;
    for (const child of node.children) {
      const found = this.findNode(child, name);
      if (found) return found;
    }
    return undefined;
  }

  private offsetOfLine(lineIndex: number): number { return this.source.split(/\r?\n/u).slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0); }
  private text(node: Node): string { return this.source.slice(node.from, node.to); }
  private span(node: Node): SourceSpan {
    const before = this.source.slice(0, node.from);
    const line = before.split('\n').length;
    const endBefore = this.source.slice(0, node.to);
    const endLine = endBefore.split('\n').length;
    return { path: this.metadata.sourcePath, startLine: line, startColumn: scalarColumn(this.source, node.from), endLine, endColumn: scalarColumn(this.source, node.to) };
  }
  private reject(node: Node, message: string): never { throw new PythonCompileError(node, message); }
  private rejectOffset(offset: number, message: string): never { throw new PythonCompileError({ name: 'Indentation', from: offset, to: offset + 1, children: [] }, message); }
}

export function parsePython(source: string, metadata: PythonScriptMetadata): PythonParseResult {
  try {
    if (!metadata.scriptId || !metadata.sourcePath) throw new Error('Python script metadata requires scriptId and sourcePath.');
    const tree = parser.parse(source);
    const compiler = new Compiler(source, treeNode(tree, source), metadata);
    return { ok: true, ir: compiler.compile() };
  } catch (error) {
    const compileError = error instanceof PythonCompileError ? error : undefined;
    const node = compileError?.node ?? { name: 'Script', from: 0, to: 1, children: [] };
    const before = source.slice(0, node.from);
    const startLine = before.split('\n').length;
    const diagnostic: Diagnostic = {
      code: 'DS-SCRIPT-PYTHON-001', severity: 'error',
      message: `${compileError?.message ?? String(error)} ${EXAMPLE}`,
      path: metadata.sourcePath,
      sourceSpan: { path: metadata.sourcePath, startLine, startColumn: scalarColumn(source, node.from), endLine: startLine, endColumn: scalarColumn(source, node.to) },
      blocks: ['script-execution', 'play', 'export'],
    };
    return { ok: false, diagnostics: [diagnostic] };
  }
}
