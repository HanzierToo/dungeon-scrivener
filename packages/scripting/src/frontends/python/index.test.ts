import { describe, expect, it } from 'vitest';
import { parseJavaScript } from '../js/index.js';
import { parsePython } from './index.js';

const metadata = { scriptId: 'python-golden', sourcePath: 'scripts/python-golden.py' };

describe('Python subset frontend', () => {
  it('compiles the shared subset to IR with source spans and engine calls', () => {
    const source = [
      'def adjust(value):',
      '    return value',
      'def main():',
      '    amount = adjust(1)',
      '    count = 0',
      '    while count < 2:',
      '        count = count + 1',
      '    if count == 2:',
      '        api.request({"kind": "increment-state", "target": {"scope": {"kind": "world"}, "key": "gold"}, "amount": 1})',
      '    else:',
      '        api.emit("unexpected", {})',
    ].join('\n');
    const result = parsePython(source, metadata);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.functions.map((fn) => fn.name)).toEqual(['adjust', 'main']);
    expect(result.ir.functions[1]?.body.map((statement) => statement.kind)).toEqual(['declare-local', 'declare-local', 'while', 'if']);
    expect(result.ir.functions[1]?.body[3]).toMatchObject({
      kind: 'if',
      then: [{ kind: 'expression', expression: { kind: 'call', target: { kind: 'capability', name: 'api.request' } } }],
      else: [{ kind: 'expression', expression: { kind: 'call', target: { kind: 'capability', name: 'api.emit' } } }],
    });
    expect(result.ir.functions[1]?.span).toMatchObject({ startLine: 3, startColumn: 1, endLine: 11 });
  });

  it('matches JavaScript IR for the equivalent common-subset script', () => {
    const python = parsePython('def main():\n    count = 1 + 2\n    if count == 3:\n        api.emit("ready", {})', metadata);
    const javascript = parseJavaScript('function main() {\n  let count = 1 + 2;\n  if (count === 3) {\n    api.emit("ready", {});\n  }\n}', { scriptId: metadata.scriptId, sourcePath: metadata.sourcePath });
    expect(python.ok).toBe(true);
    expect(javascript.ok).toBe(true);
    if (!python.ok || !javascript.ok) return;
    const withoutSpans = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item: unknown) => key === 'span' ? undefined : item));
    expect(withoutSpans(python.ir.functions[0]?.body)).toEqual(withoutSpans(javascript.ir.functions[0]?.body));
  });

  it.each([
    ['imports', 'import os\ndef main():\n    pass', 1, 1],
    ['None', 'def main():\n    value = None', 2, 13],
    ['truthy conditions', 'def main():\n    if 1:\n        api.emit("x", {})', 2, 8],
    ['decorators', '@safe\ndef main():\n    pass', 1, 1],
    ['classes', 'class Story:\n    pass', 1, 1],
    ['comprehensions', 'def main():\n    values = [x for x in range(2)]', 2, 14],
    ['floor division', 'def main():\n    value = 4 // 2', 2, 15],
  ])('rejects %s with a source location', (_label, source, line, column) => {
    const result = parsePython(source, metadata);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.sourceSpan).toMatchObject({ path: metadata.sourcePath, startLine: line, startColumn: column });
  });
});
