import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, StateReference, WorldDocument } from '@dungeon-scrivener/model';
import { createInitialState, reduceEffects } from './state.js';

const world = {
  format: 'dungeon-scrivener-world', schemaVersion: 1, entryNodeId: 'entry',
  settings: { time: { mode: 'per-action', hiddenBehavior: 'pause', maxCatchUpMilliseconds: 0, showClockHud: false }, randomness: { mode: 'seeded' } },
  savePolicy: { enabled: false, slotCount: 0, allowedLocation: 'anywhere' },
  stateDefinitions: [
    { key: 'gold', scopeKind: 'world', valueType: 'integer', defaultValue: 0 },
    { key: 'visited', scopeKind: 'node', valueType: 'boolean', defaultValue: false },
  ], worldState: {},
  nodes: [{ id: 'entry', parentId: null, visitable: true, title: { kind: 'literal', text: 'Entry' }, content: { kind: 'literal', text: '' }, state: {} }],
  navigationEdges: [],
  entityDefinitions: [{ id: 'person', name: { kind: 'literal', text: 'Person' }, fields: [{ key: 'mood', valueType: { kind: 'enum', values: ['calm', 'angry'] }, defaultValue: 'calm' }], allowedTags: ['friend'] }],
  entities: [{ id: 'keeper', definitionId: 'person', name: { kind: 'literal', text: 'Keeper' }, tags: [], state: {} }],
  actionDefaults: { choices: [], commands: [] }, eventDefinitions: [], rules: [], conversations: [], itemDefinitions: [], initialInventory: [], scripts: [],
} satisfies WorldDocument;

const worldGold: StateReference = { scope: { kind: 'world' }, key: 'gold' };
const nodeVisited: StateReference = { scope: { kind: 'node', ownerId: 'entry' }, key: 'visited' };
const keeperMood: StateReference = { scope: { kind: 'entity', ownerId: 'keeper' }, key: 'mood' };

function createSnapshot(): SessionSnapshot {
  return {
    projectId: 'demo', currentNodeId: 'entry', state: createInitialState(world),
    nodeVisitCounts: { entry: 0 }, conversationStack: [], gameTimeMilliseconds: 0,
    randomnessMode: 'seeded', randomInitialSeed: 1, randomSeed: 1, randomOutcomes: [],
    entityTags: { keeper: [] },
    clockState: { visibility: 'visible', focused: true, lastObservedEpochMilliseconds: 0, inactiveSinceEpochMilliseconds: null },
    ruleGuards: {}, inventory: [],
  };
}

describe('immutable state reducer', () => {
  it('initializes typed world, node, and entity scopes from defaults', () => {
    const snapshot = createSnapshot();
    expect(snapshot.state.world['gold']).toBe(0);
    expect(snapshot.state.nodes['entry']?.['visited']).toBe(false);
    expect(snapshot.state.entities['keeper']?.['mood']).toBe('calm');
    expect(Object.isFrozen(snapshot.state.entities['keeper'])).toBe(true);
  });
  it('commits multiple scoped effects atomically and records their reason/source', () => {
    const before = createSnapshot();
    const result = reduceEffects(world, before, [
      { kind: 'increment-state', target: worldGold, amount: 3 },
      { kind: 'set-state', target: nodeVisited, value: true },
      { kind: 'set-state', target: keeperMood, value: 'angry' },
    ], { kind: 'action', actionId: 'open-door' }, 'The keeper opens the door.');
    expect(result.diagnostics.diagnostics).toEqual([]);
    expect(result.snapshot.state.world['gold']).toBe(3);
    expect(result.snapshot.state.nodes['entry']?.['visited']).toBe(true);
    expect(result.snapshot.state.entities['keeper']?.['mood']).toBe('angry');
    expect(result.trace.filter((record) => record.kind === 'state-change')).toHaveLength(3);
    expect(result.trace[0]).toMatchObject({ source: { kind: 'action', actionId: 'open-door' }, reason: 'The keeper opens the door.' });
    expect(before.state.world['gold']).toBe(0);
  });
  it('rejects type changes and unknown targets with full rollback', () => {
    const before = createSnapshot();
    const typeFailure = reduceEffects(world, before, [
      { kind: 'increment-state', target: worldGold, amount: 1 },
      { kind: 'set-state', target: keeperMood, value: 'sleeping' },
    ], { kind: 'action', actionId: 'bad-type' }, 'This action is invalid.');
    expect(typeFailure.snapshot).toBe(before);
    expect(typeFailure.snapshot.state.world['gold']).toBe(0);
    expect(typeFailure.diagnostics.diagnostics).toHaveLength(1);
    const missing = reduceEffects(world, before, [
      { kind: 'set-state', target: { scope: { kind: 'entity', ownerId: 'missing' }, key: 'mood' }, value: 'calm' },
    ], { kind: 'action', actionId: 'missing-target' }, 'This target is missing.');
    expect(missing.snapshot).toBe(before);
    expect(missing.diagnostics.diagnostics[0]?.code).toBe('DS-ENG-001');
  });
});
