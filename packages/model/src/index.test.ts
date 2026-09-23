import { describe, expect, it } from 'vitest';
import linearWorld from '../../../fixtures/linear-three-nodes/world.json';
import linearManifest from '../../../fixtures/linear-three-nodes/project.json';
import tavernWorld from '../../../fixtures/tavern-at-dusk/world.json';
import {
  applyWorldDefaults,
  inspectDocumentVersion,
  parseJsonDocument,
  validateProjectManifest,
  validateWorldDocument,
  resolveNodeActions,
  resolveNodeRules,
  resolveWikiNodeTarget,
} from './validation.js';

const loadWorld = () => structuredClone(linearWorld) as unknown;

describe('model validation', () => {
  it('accepts the minimal linear fixture and applies only documented defaults', () => {
    const world = loadWorld() as Record<string, unknown>;
    const result = validateWorldDocument(world);
    expect(result.ok).toBe(true);
    expect((result.value?.settings as { typingSounds: { fallback: { kind: string } } })['typingSounds'].fallback.kind).toBe('silent');
    expect((world['settings'] as Record<string, unknown>)['typingSounds']).toBeUndefined();
  });

  it('reports a missing entry node with its stable entity ID', () => {
    const world = loadWorld() as Record<string, unknown>;
    world['entryNodeId'] = 'missing-entry';
    const result = validateWorldDocument(world);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.entityId === 'missing-entry')).toBe(true);
  });

  it('reports duplicate node IDs', () => {
    const world = loadWorld() as { nodes: unknown[] };
    world.nodes.push(structuredClone(world.nodes[0]));
    const result = validateWorldDocument(world);
    expect(result.diagnostics.some((item) => item.code === 'DS-MOD-004')).toBe(true);
  });

  it('rejects an undeclared script language with a file and entity diagnostic', () => {
    const world = loadWorld() as Record<string, unknown>;
    (world['scripts'] as unknown[]).push({
      id: 'bad-script',
      path: 'scripts/bad-script.js',
      language: 'ruby',
      entrypoint: 'main',
    });
    const result = validateWorldDocument(world);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.path === 'world.json' && item.entityId === 'bad-script')).toBe(true);
  });

  it('rejects wrong typed values and malformed JSON without changing input bytes', () => {
    const world = loadWorld() as Record<string, unknown>;
    expect(validateProjectManifest({ ...linearManifest, schemaVersion: '1' }).ok).toBe(false);
    const bytes = new TextEncoder().encode('{"broken":');
    const before = bytes.slice();
    expect(parseJsonDocument(bytes, 'world.json').ok).toBe(false);
    expect(bytes).toEqual(before);
    const invalid = structuredClone(world) as Record<string, unknown>;
    (invalid['worldState'] as Record<string, unknown>)['bell-rung'] = 'yes';
    expect(validateWorldDocument(invalid).ok).toBe(false);
  });

  it('does not mutate the validated model while applying defaults', () => {
    const world = loadWorld() as import('./public-types.js').WorldDocument;
    const defaulted = applyWorldDefaults(world);
    expect(defaulted).not.toBe(world);
    expect(world.nodes.some((node) => node.inheritance === undefined)).toBe(true);
    const sparse = structuredClone(world) as import('./public-types.js').WorldDocument;
    (sparse as { worldState: import('./public-types.js').WorldDocument['worldState'] }).worldState = {};
    const withVariableDefaults = applyWorldDefaults(sparse);
    expect(withVariableDefaults.worldState['lantern-lit']).toBe(false);
  });

  it('warns when the linear fixture ending is disconnected from entry navigation', () => {
    const world = structuredClone(linearWorld) as import('./public-types.js').WorldDocument;
    const endingEdge = world.navigationEdges.find((edge) => edge.id === 'bridge-to-home');
    expect(endingEdge).toBeDefined();
    if (endingEdge) (endingEdge as { toNodeId: string }).toNodeId = 'old-gate';
    const result = validateWorldDocument(world);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'DS-MOD-031' && item.entityId === 'lantern-house' && item.severity === 'warning')).toBe(true);
  });

  it('rejects a two-node containment cycle in the linear fixture', () => {
    const world = structuredClone(linearWorld) as import('./public-types.js').WorldDocument;
    (world.nodes[0] as { parentId: string | null }).parentId = 'stone-bridge';
    (world.nodes[1] as { parentId: string | null }).parentId = 'old-gate';
    const result = validateWorldDocument(world);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.code === 'DS-MOD-030')).toBe(true);
  });

  it('reports missing navigation references with a suggested repair', () => {
    const world = structuredClone(linearWorld) as import('./public-types.js').WorldDocument;
    const entry = world.nodes.find((node) => node.id === 'old-gate');
    const firstChoice = entry?.actions?.choices?.[0];
    expect(firstChoice).toBeDefined();
    if (firstChoice) (firstChoice as { navigationEdgeId?: string }).navigationEdgeId = 'missing-edge';
    const result = validateWorldDocument(world);
    expect(result.diagnostics.some((item) => item.code === 'DS-MOD-024' && item.entityId === 'open-gate' && item.suggestedFix)).toBe(true);
  });

  it('resolves inherited action defaults before applying a child category override', () => {
    const world = structuredClone(tavernWorld) as import('./public-types.js').WorldDocument;
    expect(validateWorldDocument(world).ok).toBe(true);
    const inherited = resolveNodeActions(world, 'taproom');
    expect(inherited.ok).toBe(true);
    expect(inherited.value?.choices.map((choice) => choice.id)).toContain('enter-cellar');
    expect(inherited.value?.commands.map((command) => command.id)).toContain('talk-to-mira');
    expect(resolveNodeRules(world, 'taproom').value?.map((rule) => rule.id)).toContain('clock-rings');
    const taproom = world.nodes.find((node) => node.id === 'taproom');
    expect(taproom).toBeDefined();
    if (taproom) (taproom as unknown as { actions?: { choices: readonly []; } }).actions = { choices: [] };
    const overridden = resolveNodeActions(world, 'taproom');
    expect(overridden.value?.choices).toEqual([]);
    expect(overridden.value?.commands.map((command) => command.id)).toContain('talk-to-mira');
  });

  it('uses stable wiki node IDs even when display labels are duplicated', () => {
    const world = structuredClone(linearWorld) as import('./public-types.js').WorldDocument;
    (world.nodes[1] as { title: { kind: 'literal'; text: string } }).title = { kind: 'literal', text: 'Same title' };
    (world.nodes[2] as { title: { kind: 'literal'; text: string } }).title = { kind: 'literal', text: 'Same title' };
    expect(validateWorldDocument(world).ok).toBe(true);
    expect(resolveWikiNodeTarget(world, 'stone-bridge').value?.id).toBe('stone-bridge');
    expect(resolveWikiNodeTarget(world, 'lantern-house').value?.id).toBe('lantern-house');
  });

  it('rejects unknown future versions without rewriting them or claiming a migration', () => {
    const world = structuredClone(linearWorld) as Record<string, unknown>;
    world['schemaVersion'] = 2;
    const version = inspectDocumentVersion(world, 'world.json');
    expect(version.status).toBe('unsupported-future');
    expect(version.diagnostics[0]?.suggestedFix).toBeDefined();
    expect(validateWorldDocument(world).ok).toBe(false);
    expect(world['schemaVersion']).toBe(2);
  });
});
