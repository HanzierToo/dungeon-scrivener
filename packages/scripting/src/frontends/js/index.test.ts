import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseJavaScript } from './index.js';

const metadata = { scriptId: 'js-golden', sourcePath: 'scripts/js-golden.js' };

describe('JavaScript subset frontend', () => {
  it('compiles literals, locals, branches, bounded loops, helpers, and engine effects', () => {
    const source = [
      'function adjust(value) {',
      '  return value;',
      '}',
      'function main() {',
      '  const amount = adjust(1);',
      '  let count = 0;',
      '  while (count < 2) {',
      '    count = count + 1;',
      '  }',
      '  if (count === 2) {',
      '    api.request({ kind: "increment-state", target: { scope: { kind: "world" }, key: "gold" }, amount: 1 });',
      '  }',
      '}',
    ].join('\n');
    const result = parseJavaScript(source, metadata);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.functions.map((fn) => fn.name)).toEqual(['adjust', 'main']);
    const [helper, main] = result.ir.functions;
    expect(helper?.body.map((statement) => statement.kind)).toEqual(['return']);
    expect(main?.body.map((statement) => statement.kind)).toEqual(['declare-local', 'declare-local', 'while', 'if']);
    expect(main?.body[2]).toMatchObject({
      kind: 'while',
      condition: { kind: 'binary', operator: 'less-than' },
      body: [{ kind: 'assign-local', name: 'count', value: { kind: 'binary', operator: 'add' } }],
    });
    expect(main?.body[3]).toMatchObject({
      kind: 'if',
      condition: { kind: 'binary', operator: 'equal' },
      then: [{ kind: 'expression', expression: { kind: 'call', target: { kind: 'capability', name: 'api.request' } } }],
      else: [],
    });
    expect(main?.span).toEqual({ path: metadata.sourcePath, startLine: 4, startColumn: 1, endLine: 13, endColumn: 2 });
  });

  it('parses the frozen tavern JavaScript sample into capability calls', () => {
    const source = readFileSync('fixtures/tavern-at-dusk/scripts/keeper.js', 'utf8');
    const result = parseJavaScript(source, { scriptId: 'keeper', sourcePath: 'scripts/keeper.js' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.functions[0]?.body.map((statement) => statement.kind)).toEqual(['declare-local', 'expression', 'expression']);
    expect(result.ir.functions[0]?.body[0]).toMatchObject({
      kind: 'declare-local',
      name: 'echoes',
      value: { kind: 'call', target: { kind: 'capability', name: 'api.randomInt' } },
    });
    expect(result.ir.functions[0]?.body[1]).toMatchObject({
      kind: 'expression',
      expression: {
        kind: 'call',
        target: { kind: 'capability', name: 'api.request' },
        arguments: [{
          kind: 'map',
          entries: [
            { key: 'kind', value: { kind: 'literal', value: 'increment-state' } },
            { key: 'target', value: { kind: 'map', entries: [
              { key: 'scope', value: { kind: 'map', entries: [{ key: 'kind', value: { kind: 'literal', value: 'world' } }] } },
              { key: 'key', value: { kind: 'literal', value: 'bell-echoes' } },
            ] } },
            { key: 'amount', value: { kind: 'local', name: 'echoes' } },
          ],
        }],
      },
    });
    expect(result.ir.functions[0]?.body[2]).toMatchObject({
      kind: 'expression',
      expression: {
        kind: 'call',
        target: { kind: 'capability', name: 'api.emit' },
        arguments: [
          { kind: 'literal', value: 'tavern-stir' },
          { kind: 'map', entries: [{ key: 'source', value: { kind: 'literal', value: 'midnight-chime' } }] },
        ],
      },
    });
    expect(result.ir.functions[0]?.span).toMatchObject({ startLine: 1, startColumn: 1, endLine: 9, endColumn: 2 });
  });

  it.each([
    ['arrow functions', 'function main() { const f = (x) => x; }', 1, 29],
    ['imports', 'import x from "x"; function main() {}', 1, 1],
    ['eval', 'function main() { eval("1"); }', 1, 19],
    ['browser globals', 'function main() { window.location; }', 1, 19],
    ['dynamic API lookup', 'function main() { api[name](); }', 1, 19],
    ['implicit globals', 'function main() { score = 1; }', 1, 19],
    ['direct property traversal', 'function main() { const x = actor.secret; }', 1, 29],
  ])('rejects %s at the exact source location', (_label, source, line, column) => {
    const result = parseJavaScript(source, metadata);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.sourceSpan).toMatchObject({ path: metadata.sourcePath, startLine: line, startColumn: column });
    expect(result.diagnostics[0]?.message).toContain('Example:');
  });

  it('uses Unicode scalar columns and rejects non-subset loop and string forms', () => {
    const unicode = parseJavaScript('function main() {\n  const face = "😀"; window.x;\n}', metadata);
    expect(unicode.ok).toBe(false);
    if (!unicode.ok) expect(unicode.diagnostics[0]?.sourceSpan).toMatchObject({ startLine: 2, startColumn: 21 });
    expect(parseJavaScript('function main() { while (true) {} }', metadata).ok).toBe(false);
    expect(parseJavaScript('function main() { const text = `hello`; }', metadata).ok).toBe(false);
  });
});
