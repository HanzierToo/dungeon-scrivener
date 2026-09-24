import type {
  CompiledScriptBundle, Diagnostic, GameEngineHost, ProjectId, ScriptIR, SessionCreationResult,
  SessionSnapshot, SessionStartOptions, WorldDocument,
} from '@dungeon-scrivener/model';
import { enterSessionNode } from './actions.js';
import { createInitialState } from './state.js';
import { obtainSeed } from './random.js';

const INVALID_SESSION = 'DS-ENG-013';

function failed(diagnostics: readonly Diagnostic[]): SessionCreationResult {
  return {
    ok: false,
    diagnostics: { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics },
  };
}

function checkScriptBundle(world: WorldDocument, bundle: CompiledScriptBundle): readonly Diagnostic[] {
  if (!bundle || bundle.format !== 'dungeon-scrivener-compiled-script-bundle' || bundle.schemaVersion !== 1 || !Array.isArray(bundle.scripts)) {
    return [{ code: INVALID_SESSION, severity: 'error', message: 'Compiled script bundle is malformed or unsupported.', blocks: ['play'] }];
  }
  const diagnostics: Diagnostic[] = [];
  const scripts: ScriptIR[] = [];
  for (const candidate of bundle.scripts as readonly unknown[]) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: 'Compiled script bundle contains a malformed script entry.', blocks: ['play'] });
      continue;
    }
    const script = candidate as ScriptIR;
    if (typeof script.scriptId !== 'string' || typeof script.sourcePath !== 'string' ||
        typeof script.sourceLanguage !== 'string' || script.entrypoint !== 'main' ||
        script.format !== 'dungeon-scrivener-script-ir' || script.schemaVersion !== 1 || !Array.isArray(script.functions)) {
      diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: 'Compiled script bundle contains a malformed or unsupported script entry.', blocks: ['play'] });
      continue;
    }
    scripts.push(script);
  }
  const byId = new Map<string, number>();
  for (const script of scripts) byId.set(script.scriptId, (byId.get(script.scriptId) ?? 0) + 1);
  for (const [scriptId, count] of byId) {
    if (count !== 1) diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: `Compiled script bundle contains ${count} entries for ${scriptId}; exactly one is allowed.`, entityId: scriptId, blocks: ['play'] });
  }
  const declared = new Map(world.scripts.map((script) => [script.id, script]));
  for (const reference of world.scripts) {
    const matches = scripts.filter((script) => script.scriptId === reference.id);
    if (matches.length !== 1) {
      if (matches.length === 0) diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: `Compiled script ${reference.id} is missing from the bundle.`, entityId: reference.id, path: reference.path, blocks: ['play'] });
      continue;
    }
    const script = matches[0]!;
    if (script.sourcePath !== reference.path || script.sourceLanguage !== reference.language || script.entrypoint !== reference.entrypoint) {
      diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: `Compiled script ${reference.id} does not match its declared path, language, or entrypoint.`, entityId: reference.id, path: reference.path, blocks: ['play'] });
    }
  }
  for (const script of scripts) {
    if (!declared.has(script.scriptId)) diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: `Compiled script ${script.scriptId} is not declared by the world.`, entityId: script.scriptId, path: script.sourcePath, blocks: ['play'] });
  }
  return diagnostics;
}

/** Creates a complete initial session using only host-supplied seed and clock values. */
export function createSession(
  host: Pick<GameEngineHost, 'seededSeedSource'>,
  bundle: CompiledScriptBundle,
  projectId: ProjectId,
  world: WorldDocument,
  options: SessionStartOptions,
): SessionCreationResult {
  const diagnostics: Diagnostic[] = [...checkScriptBundle(world, bundle)];
  if (!Number.isSafeInteger(options.wallClockEpochMilliseconds) || options.wallClockEpochMilliseconds < 0) {
    diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: 'Session start clock must be a nonnegative safe integer epoch timestamp.', blocks: ['play'] });
  }
  if (options.visibility !== 'visible' && options.visibility !== 'hidden') {
    diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: 'Session start visibility must be visible or hidden.', blocks: ['play'] });
  }
  if (typeof options.focused !== 'boolean') {
    diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: 'Session start focus must be a boolean.', blocks: ['play'] });
  }
  if (world.settings.randomness.mode === 'unseeded' && options.randomSeed !== undefined) {
    diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: 'Unseeded sessions cannot supply a random seed.', blocks: ['play'] });
  }
  if (world.settings.randomness.mode === 'seeded' && options.randomSeed !== undefined &&
      (!Number.isInteger(options.randomSeed) || options.randomSeed < 0 || options.randomSeed > 0xffff_ffff)) {
    diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: 'Supplied seeded random seed must be a uint32.', blocks: ['play'] });
  }
  if (diagnostics.length > 0) return failed(diagnostics);

  let seed: number | null = null;
  if (world.settings.randomness.mode === 'seeded') {
    let obtained: number | undefined;
    try { obtained = obtainSeed(options.randomSeed, host.seededSeedSource); }
    catch (error) {
      diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: error instanceof Error ? `Seed source failed: ${error.message}` : 'Seed source failed.', blocks: ['play'] });
    }
    if (obtained === undefined) diagnostics.push({ code: INVALID_SESSION, severity: 'error', message: 'Seeded session requires a valid explicit seed or host seed source.', blocks: ['play'] });
    else seed = obtained;
  }
  if (diagnostics.length > 0) return failed(diagnostics);

  const initiallyActive = options.visibility === 'visible' && options.focused;
  const snapshot: SessionSnapshot = {
    projectId,
    currentNodeId: world.entryNodeId,
    state: createInitialState(world),
    nodeVisitCounts: Object.fromEntries(world.nodes.map((node) => [node.id, 0])),
    conversationStack: [],
    dialogueHistory: [],
    nextInventoryStackOrdinal: 0,
    gameTimeMilliseconds: 0,
    randomnessMode: world.settings.randomness.mode,
    randomInitialSeed: seed,
    randomSeed: seed,
    randomOutcomes: [],
    entityTags: Object.fromEntries(world.entities.map((entity) => [entity.id, [...entity.tags]])),
    clockState: {
      visibility: options.visibility,
      focused: options.focused,
      lastObservedEpochMilliseconds: world.settings.time.mode === 'elapsed' ? options.wallClockEpochMilliseconds : null,
      inactiveSinceEpochMilliseconds: world.settings.time.mode === 'elapsed' && !initiallyActive ? options.wallClockEpochMilliseconds : null,
    },
    ruleGuards: Object.fromEntries(world.rules.map((rule) => [rule.id, false])),
    inventory: world.initialInventory.map((stack) => ({ ...stack, owner: { ...stack.owner }, fields: { ...stack.fields } })),
  };
  const entered = enterSessionNode(world, snapshot);
  if (entered.diagnostics.diagnostics.length > 0) return failed(entered.diagnostics.diagnostics);
  return { ok: true, snapshot: entered.snapshot };
}
