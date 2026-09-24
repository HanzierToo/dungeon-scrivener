import { describe, expect, it, vi } from 'vitest';
import type { ScriptExecutionContext, ScriptIR } from '@dungeon-scrivener/model';
import { ScriptExecutor } from './index.js';

const path = 'scripts/executor.js';
const span = { path, startLine: 1, startColumn: 1, endLine: 8, endColumn: 1_000 };
const at = (endColumn = 20) => ({ ...span, endColumn });
const literal = (value: string | number | boolean) => ({ kind: 'literal' as const, value, span: at() });
const map = (entries: Array<[string, unknown]>) => ({
  kind: 'map' as const,
  entries: entries.map(([key, value]) => ({ key, value })),
  span: at(50),
});
const call = (name: string, args: unknown[]) => ({
  kind: 'call' as const,
  target: { kind: 'capability' as const, name },
  arguments: args,
  span: at(50),
});
function script(body: unknown[], helpers: unknown[] = []): ScriptIR {
  return {
    format: 'dungeon-scrivener-script-ir', schemaVersion: 1, scriptId: 'executor',
    sourceLanguage: 'javascript', sourcePath: path, entrypoint: 'main',
    functions: [
      { name: 'main', parameters: [], body: body as ScriptIR['functions'][number]['body'], span },
      ...helpers as ScriptIR['functions'],
    ],
  };
}

function makeContext(overrides: Partial<ScriptExecutionContext> = {}): ScriptExecutionContext {
  const capabilities: ScriptExecutionContext['capabilities'] = {
    read: () => 0,
    hasTag: () => false,
    request: vi.fn(),
    emit: vi.fn(),
    randomInt: (minimum) => minimum,
    randomFloat: () => 0.25,
  };
  return {
    origin: { kind: 'action', actionId: 'test-action' },
    limits: {
      maxInstructions: 50_000, maxCallDepth: 16, maxLoopIterations: 1_000,
      maxAllocatedBytes: 1024 * 1024, maxStringBytes: 16 * 1024,
      maxCollectionMembers: 1024, maxValueDepth: 32, maxCapabilityCalls: 10_000,
      maxRequestedEffects: 256, maxTraceRecords: 20_000,
    },
    capabilities,
    ...overrides,
  };
}

describe('synchronous validated-IR executor', () => {
  it('runs normal IR and applies requested effects through the capability bridge', () => {
    const context = makeContext();
    const effect = map([
      ['kind', literal('increment-state')],
      ['target', map([['scope', map([['kind', literal('world')]])], ['key', literal('gold')]])],
      ['amount', literal(3)],
    ]);
    const ir = script([{ kind: 'expression', expression: call('api.request', [effect]), span }]);

    const result = new ScriptExecutor().executeScript(ir, context);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(context.capabilities.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'increment-state' }));
    expect(result.trace.at(-1)?.kind).toBe('activation-end');
  });

  it('rejects browser, storage, network, file and arbitrary-global access as unvalidated IR', () => {
    const forbiddenNames = ['window', 'document', 'localStorage', 'fetch', 'XMLHttpRequest', 'process', 'require', 'eval'];
    for (const name of forbiddenNames) {
      const attempts = [
        { kind: 'call', target: { kind: 'helper', name }, arguments: [], span: at() },
        { kind: 'local', name, span: at() },
      ];
      for (const expression of attempts) {
        const ir = script([{ kind: 'expression', expression, span }]);
        const result = new ScriptExecutor().executeScript(ir, makeContext());
        expect(result.ok, name).toBe(false);
        expect(result.instructionsExecuted, name).toBe(0);
      }
    }
  });

  it('bounds loops, recursion, and event/effect requests', () => {
    const loop = script([
      { kind: 'declare-local', name: 'repeat', mutable: false, value: literal(true), span },
      { kind: 'while', condition: { kind: 'local', name: 'repeat', span: at() }, body: [], span },
    ]);
    const loopResult = new ScriptExecutor().executeScript(loop, makeContext());
    expect(loopResult.ok).toBe(false);
    expect(!loopResult.ok && loopResult.diagnostic.message).toContain('loop-iteration');

    const recursive = script([{
      kind: 'if', condition: { kind: 'call', target: { kind: 'helper', name: 'again' }, arguments: [], span: at() }, then: [], else: [], span,
    }], [{ name: 'again', parameters: [], body: [
      { kind: 'return', value: { kind: 'call', target: { kind: 'helper', name: 'again' }, arguments: [], span: at() }, span },
    ], span }]);
    const recursionResult = new ScriptExecutor().executeScript(recursive, makeContext());
    expect(recursionResult.ok).toBe(false);
    expect(!recursionResult.ok && recursionResult.diagnostic.message).toContain('call depth');

    const emit = call('api.emit', [literal('noise'), map([])]);
    const flood = script(Array.from({ length: 3 }, () => ({ kind: 'expression', expression: emit, span })));
    const context = makeContext({ limits: { ...makeContext().limits, maxRequestedEffects: 2 } });
    const floodResult = new ScriptExecutor().executeScript(flood, context);
    expect(floodResult.ok).toBe(false);
    expect(!floodResult.ok && floodResult.diagnostic.message).toContain('requested-effect');
    expect(context.capabilities.emit).toHaveBeenCalledTimes(2);
  });

  it('bounds instruction fuel, aggregate allocation, and elapsed work', () => {
    const request = script([{ kind: 'expression', expression: call('api.request', [map([['kind', literal('navigate')], ['edgeId', literal('next')]])]), span }]);
    const instructionResult = new ScriptExecutor().executeScript(request, makeContext({
      limits: { ...makeContext().limits, maxInstructions: 1 },
    }));
    expect(instructionResult.ok).toBe(false);
    expect(!instructionResult.ok && instructionResult.diagnostic.message).toContain('instruction budget');

    const allocationResult = new ScriptExecutor().executeScript(request, makeContext({
      limits: { ...makeContext().limits, maxAllocatedBytes: 1 },
    }));
    expect(allocationResult.ok).toBe(false);
    expect(!allocationResult.ok && allocationResult.diagnostic.message).toContain('allocation budget');

    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1_001);
    try {
      const elapsedResult = new ScriptExecutor().executeScript(script([]), makeContext());
      expect(elapsedResult.ok).toBe(false);
      expect(!elapsedResult.ok && elapsedResult.diagnostic.message).toContain('elapsed-work budget');
    } finally {
      now.mockRestore();
    }
  });

  it('preserves the same effect order in hosted and direct-open host contexts', () => {
    const ir = script([
      { kind: 'expression', expression: call('api.request', [map([['kind', literal('navigate')], ['edgeId', literal('next')]])]), span },
      { kind: 'expression', expression: call('api.emit', [literal('arrived'), map([])]), span },
    ]);
    const invoke = () => {
      const events: string[] = [];
      const context = makeContext({ capabilities: {
        ...makeContext().capabilities,
        request: (effect) => { events.push(`effect:${effect.kind}`); },
        emit: (eventId) => { events.push(`event:${eventId}`); },
      } });
      return { result: new ScriptExecutor().executeScript(ir, context), events };
    };

    const hosted = invoke();
    const directOpen = invoke();
    expect(hosted.result.ok, JSON.stringify(hosted.result)).toBe(true);
    expect(directOpen.result.ok, JSON.stringify(directOpen.result)).toBe(true);
    expect(hosted.events).toEqual(['effect:navigate', 'event:arrived']);
    expect(directOpen.events).toEqual(hosted.events);
  });
});
