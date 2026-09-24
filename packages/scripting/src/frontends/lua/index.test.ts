import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLua } from './index.js';

const metadata = { scriptId: 'lua-golden', sourcePath: 'scripts/lua-golden.lua' };

describe('Lua subset frontend', () => {
  it('compiles branches, bounded loops, helpers, and capabilities to common IR', () => {
    const result = parseLua([
      'local function adjust(value)',
      '  return value',
      'end',
      'local function main()',
      '  local amount = adjust(1)',
      '  local count = 0',
      '  while count < 2 do',
      '    count = count + 1',
      '  end',
      '  if count == 2 then',
      '    api.request({kind = "increment-state", target = {scope = {kind = "world"}, key = "gold"}, amount = 1})',
      '  else',
      '    api.emit("quiet", {})',
      '  end',
      'end',
    ].join('\n'), metadata);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.ir.functions.map((fn) => fn.name)).toEqual(['adjust', 'main']);
    expect(result.ir.functions[1]?.body.map((item) => item.kind)).toEqual(['declare-local', 'declare-local', 'while', 'if']);
    expect(result.ir.functions[1]?.body[2]).toMatchObject({ kind: 'while', condition: { kind: 'binary', operator: 'less-than' } });
    expect(result.ir.functions[1]?.body[3]).toMatchObject({ kind: 'if', then: [{ kind: 'expression', expression: { target: { name: 'api.request' } } }] });
  });

  it('parses the frozen tavern Lua sample', () => {
    const source = readFileSync('fixtures/tavern-at-dusk/scripts/echo.lua', 'utf8');
    const result = parseLua(source, { scriptId: 'echo', sourcePath: 'scripts/echo.lua' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.ir.sourceLanguage).toBe('lua');
    expect(result.ir.functions[0]?.body.map((item) => item.kind)).toEqual(['declare-local', 'expression', 'expression']);
    expect(result.ir.functions[0]?.body[0]).toMatchObject({ kind: 'declare-local', name: 'trust', value: { kind: 'call', target: { name: 'api.read' } } });
  });

  it('converts Lua sequence indexing to zero-based IR and rejects nil and truthiness', () => {
    const indexed = parseLua('local function main() local values = {10, 20} local first = values[1] end', metadata);
    expect(indexed.ok, JSON.stringify(indexed)).toBe(true);
    if (indexed.ok) expect(indexed.ir.functions[0]?.body[1]).toMatchObject({ kind: 'declare-local', value: { kind: 'index', index: { kind: 'binary', operator: 'subtract', right: { kind: 'literal', value: 1 } } } });
    for (const source of ['local function main() local value = nil end', 'local function main() if 1 then end end', 'function main() end']) {
      const result = parseLua(source, metadata);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]?.sourceSpan).toMatchObject({ path: metadata.sourcePath, startLine: 1, startColumn: expect.any(Number) });
    }
  });

  it.each([
    ['global access', 'local function main() return os.time() end', 1],
    ['numeric for', 'local function main() for i = 1, 3 do end end', 1],
    ['repeat loop', 'local function main() repeat local x = true until x end', 1],
    ['long string', 'local function main() local x = [[text]] end', 1],
    ['Lua truthiness', 'local function main() local x = not 0 end', 1],
    ['table mutation', 'local function main() local x = {1} x[1] = 2 end', 1],
  ])('rejects %s with a source location', (_label, source, line) => {
    const result = parseLua(source, metadata);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.sourceSpan).toMatchObject({ path: metadata.sourcePath, startLine: line });
      expect(result.diagnostics[0]?.message).toContain('Example:');
    }
  });
});
