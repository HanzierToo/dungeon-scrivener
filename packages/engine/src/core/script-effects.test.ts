import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CompiledScriptBundle, GameEngineHost, SessionStartOptions, WorldDocument } from '@dungeon-scrivener/model';
import tavernWorldJson from '../../../../fixtures/tavern-at-dusk/world.json';
import { parseJavaScript } from '../../../scripting/src/frontends/js/index.js';
import { parseLua } from '../../../scripting/src/frontends/lua/index.js';
import { parsePython } from '../../../scripting/src/frontends/python/index.js';
import { ScriptExecutor } from '../../../scripting/src/executor/index.js';
import { validateScriptIR } from '../../../scripting/src/ir/index.js';
import { createSession } from './session.js';
import { dispatchPlayerInput, inspectActionAvailability } from './actions.js';
import { createScriptExecutionEnvironment } from './script-runtime.js';
import { observeClock } from './time.js';

const world = tavernWorldJson as unknown as WorldDocument;

function source(path: string): string {
  return readFileSync(new URL(`../../../../fixtures/tavern-at-dusk/${path}`, import.meta.url), 'utf8');
}

function compiledBundle(): CompiledScriptBundle {
  const js = parseJavaScript(source('scripts/keeper.js'), { scriptId: 'keeper-check', sourcePath: 'scripts/keeper.js' });
  if (js.ok) {
    const validation = validateScriptIR(js.ir);
    if (!validation.ok) throw new Error(JSON.stringify({ ir: js.ir.functions[0]?.body, diagnostics: validation.diagnostics }));
  }
  const lua = parseLua(source('scripts/echo.lua'), { scriptId: 'echo-check', sourcePath: 'scripts/echo.lua' });
  if (lua.ok) {
    const validation = validateScriptIR(lua.ir);
    if (!validation.ok) throw new Error(JSON.stringify({ ir: lua.ir.functions[0]?.body, diagnostics: validation.diagnostics }));
  }
  const python = parsePython(source('scripts/witness.py'), { scriptId: 'witness-check', sourcePath: 'scripts/witness.py' });
  if (!js.ok || !lua.ok || !python.ok) {
    throw new Error(JSON.stringify({
      javascript: js.ok ? [] : js.diagnostics,
      lua: lua.ok ? [] : lua.diagnostics,
      python: python.ok ? [] : python.diagnostics,
    }));
  }
  return { format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts: [js.ir, lua.ir, python.ir] };
}

describe('script effects inside engine transactions', () => {
  it('runs the Tavern elapsed clock cascade through Lua echo-check and exposes the trust-gated dialogue option', () => {
    const bundle = compiledBundle();
    let randomCalls = 0;
    const host: GameEngineHost = {
      scriptExecutor: new ScriptExecutor(),
      mediaAssets: { resolveAsset: (assetId) => ({ ok: false, diagnostic: { code: 'test-missing-asset', severity: 'error', message: `Missing ${assetId}.` } }) },
      unseededRandomSource: { nextUint32: () => { randomCalls += 1; return 0x8000_0000; } },
    };
    const runtime = createScriptExecutionEnvironment(host, bundle);
    const start: SessionStartOptions = { wallClockEpochMilliseconds: 1_000_000, visibility: 'visible', focused: true };
    const created = createSession(host, bundle, 'tavern-at-dusk', world, start);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.diagnostics.diagnostics.map((item) => item.message).join('\n'));

    const history = [];
    let snapshot = created.snapshot;
    const startMira = dispatchPlayerInput(world, snapshot, { kind: 'command-text', rawText: 'talk to Mira' }, runtime);
    expect(startMira.resolution.kind).toBe('command');
    history.push(startMira.trace);
    snapshot = startMira.snapshot;
    const rowan = dispatchPlayerInput(world, snapshot, {
      kind: 'dialogue-option', conversationId: 'mira-story', lineId: 'mira-first', optionId: 'interrupt-for-rowan',
    }, runtime);
    expect(rowan.resolution.kind).toBe('dialogue-option');
    history.push(rowan.trace);
    snapshot = rowan.snapshot;
    expect(snapshot.activeConversation).toMatchObject({ conversationId: 'rowan-story', lineId: 'rowan-first' });

    const activeTick = observeClock(world, snapshot, { kind: 'tick', wallClockEpochMilliseconds: 1_060_000, visibility: 'visible', focused: true }, runtime);
    history.push(activeTick.trace);
    snapshot = activeTick.snapshot;
    const hide = observeClock(world, snapshot, { kind: 'visibility-change', wallClockEpochMilliseconds: 1_060_001, visibility: 'hidden', focused: true }, runtime);
    history.push(hide.trace);
    snapshot = hide.snapshot;
    const resume = observeClock(world, snapshot, { kind: 'resume', wallClockEpochMilliseconds: 1_360_001, visibility: 'visible', focused: true }, runtime);
    history.push(resume.trace);
    snapshot = resume.snapshot;

    expect(resume.diagnostics.diagnostics).toEqual([]);
    expect(snapshot.gameTimeMilliseconds).toBe(120_001);
    expect(snapshot.state.world['trust']).toBe(1);
    expect(snapshot.state.world['bell-rung']).toBe(true);
    expect(snapshot.state.world['bell-echoes']).toBe(3);
    expect(snapshot.entityTags['cellar-rowan']).toContain('startled');
    expect(randomCalls).toBe(1);
    const scriptTraceOrder = resume.trace.filter((record) => record.kind === 'script')
      .map((record) => record.source.kind === 'script' ? record.source.scriptId : null)
      .filter((scriptId, index, records) => index === 0 || scriptId !== records[index - 1]);
    expect(scriptTraceOrder).toEqual(['echo-check', 'keeper-check', 'witness-check']);
    expect(resume.trace.map((record) => record.sequence)).toEqual(resume.trace.map((_, sequence) => sequence));

    const beforeInspection = structuredClone(snapshot);
    const availability = inspectActionAvailability(world, snapshot, { completeFromSessionStart: false, transitions: history });
    const secret = availability.dialogueOptions.find((option) => option.id === 'tell-secret');
    expect(secret).toMatchObject({ result: true, visibility: 'visible', enabled: true });
    expect(secret?.reads[0]).toMatchObject({
      conditionPath: [], conditionKind: 'compare-state', observed: { kind: 'state', value: 1 },
      provenance: { kind: 'recorded', stateChange: { transitionIndex: 4 } },
    });
    expect(snapshot).toEqual(beforeInspection);
  });
});
