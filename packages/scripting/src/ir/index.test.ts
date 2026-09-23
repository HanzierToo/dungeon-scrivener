import { describe, expect, it } from 'vitest';
import { validateScriptIR } from './index.js';

const path = 'scripts/example.js';
const span = { path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 40 };
const literal = (value: string | number | boolean, endColumn = 10) => ({
  kind: 'literal', value, span: { ...span, endColumn },
});
const map = (entries: Array<[string, unknown]>, endColumn = 20) => ({
  kind: 'map', entries: entries.map(([key, value]) => ({ key, value })), span: { ...span, endColumn },
});

function script(body: unknown[]) {
  return {
    format: 'dungeon-scrivener-script-ir',
    schemaVersion: 1,
    scriptId: 'example',
    sourceLanguage: 'javascript',
    sourcePath: path,
    entrypoint: 'main',
    functions: [{ name: 'main', parameters: [], body, span }],
  };
}

describe('script IR validator', () => {
  it('accepts branching logic that requests a typed effect through api', () => {
    const effect = map([
      ['kind', literal('increment-state')],
      ['target', map([['scope', map([['kind', literal('world')]])], ['key', literal('gold')]])],
      ['amount', literal(1)],
    ]);
    const call = {
      kind: 'call', target: { kind: 'capability', name: 'api.request' },
      arguments: [effect], span: { ...span, endColumn: 30 },
    };
    const ir = script([{
      kind: 'if', condition: literal(true), then: [{ kind: 'expression', expression: call, span }], else: [], span,
    }]);
    expect(validateScriptIR(ir)).toMatchObject({ ok: true, diagnostics: [] });
  });

  it.each([
    ['unknown opcode', script([{ kind: 'write-state', target: 'gold', value: literal(5), span }])],
    ['forged capability', script([{ kind: 'expression', expression: {
      kind: 'call', target: { kind: 'capability', name: 'api.deleteWorld' }, arguments: [], span,
    }, span }])],
    ['missing source span', script([{ kind: 'return' }])],
    ['unbounded literal-true loop', script([{ kind: 'while', condition: literal(true), body: [], span }])],
    ['direct state mutation opcode', script([{ kind: 'expression', expression: { kind: 'state-write', span }, span }])],
  ])('rejects %s', (_name, ir) => {
    expect(validateScriptIR(ir).ok).toBe(false);
  });
});
