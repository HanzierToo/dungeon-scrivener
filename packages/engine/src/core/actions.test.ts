import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, WorldDocument } from '@dungeon-scrivener/model';
import tavernWorldJson from '../../../../fixtures/tavern-at-dusk/world.json';
import { createInitialState } from './state.js';
import { dispatchPlayerInput, getAvailableActions, matchCommandText } from './actions.js';

const tavernWorld = tavernWorldJson as unknown as WorldDocument;

function makeSnapshot(world: WorldDocument, currentNodeId = world.entryNodeId): SessionSnapshot {
  return {
    projectId: 'tavern-at-dusk', currentNodeId, state: createInitialState(world),
    nodeVisitCounts: Object.fromEntries(world.nodes.map((node) => [node.id, node.id === currentNodeId ? 1 : 0])),
    conversationStack: [], gameTimeMilliseconds: 0, randomnessMode: 'seeded', randomInitialSeed: 1, randomSeed: 1,
    randomOutcomes: [], entityTags: Object.fromEntries(world.entities.map((entity) => [entity.id, [...entity.tags]])),
    clockState: { visibility: 'visible', focused: true, lastObservedEpochMilliseconds: 0, inactiveSinceEpochMilliseconds: null },
    ruleGuards: {}, inventory: world.initialInventory,
  };
}

const smallWorld: WorldDocument = {
  ...tavernWorld,
  entryNodeId: 'start',
  stateDefinitions: [
    { key: 'entries', scopeKind: 'world', valueType: 'integer', defaultValue: 0 },
    { key: 'exits', scopeKind: 'world', valueType: 'integer', defaultValue: 0 },
    { key: 'revisits', scopeKind: 'world', valueType: 'integer', defaultValue: 0 },
  ],
  worldState: {},
  nodes: [
    { id: 'start', parentId: null, visitable: true, title: { kind: 'literal', text: 'Start' }, content: { kind: 'literal', text: '' }, actions: { choices: [{ id: 'go', label: { kind: 'literal', text: 'Go' }, navigationEdgeId: 'start-to-room', effects: [] }], commands: [] }, lifecycle: { exit: { policy: 'every-time', effects: [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'exits' }, amount: 1 }] } } },
    { id: 'room', parentId: null, visitable: true, title: { kind: 'literal', text: 'Room' }, content: { kind: 'literal', text: '' }, actions: { choices: [{ id: 'back', label: { kind: 'literal', text: 'Back' }, navigationEdgeId: 'room-to-start', effects: [] }], commands: [] }, lifecycle: {
      entry: { policy: 'once-per-playthrough', effects: [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'entries' }, amount: 1 }] },
      revisit: { policy: 'every-time', effects: [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'revisits' }, amount: 1 }] },
    } },
  ],
  navigationEdges: [
    { id: 'start-to-room', fromNodeId: 'start', toNodeId: 'room' },
    { id: 'room-to-start', fromNodeId: 'room', toNodeId: 'start' },
  ],
  actionDefaults: { choices: [], commands: [] }, rules: [],
};

describe('node actions and player input', () => {
  it('keeps choices and commands available together through inherited actions', () => {
    const snapshot = makeSnapshot(tavernWorld, 'taproom');
    const actions = getAvailableActions(tavernWorld, snapshot);
    expect(actions.choices.map((choice) => choice.id)).toContain('enter-cellar');
    expect(actions.commands.map((command) => command.id)).toContain('ask-about-topic');
  });

  it('selects a tavern choice, returns, and resolves a typed command alias', () => {
    const initial = makeSnapshot(tavernWorld, 'taproom');
    const enter = dispatchPlayerInput(tavernWorld, initial, { kind: 'choice', actionId: 'enter-cellar' });
    expect(enter.resolution).toEqual({ kind: 'choice', actionId: 'enter-cellar' });
    expect(enter.snapshot.currentNodeId).toBe('cellar');

    const back = dispatchPlayerInput(tavernWorld, enter.snapshot, { kind: 'choice', actionId: 'return-to-taproom' });
    expect(back.snapshot.currentNodeId).toBe('taproom');
    expect(back.snapshot.state.nodes['taproom']?.['return-visits']).toBe(1);

    const typed = dispatchPlayerInput(tavernWorld, back.snapshot, { kind: 'command-text', rawText: '  ASK   MIRA about   lantern ' });
    expect(typed.resolution).toMatchObject({ kind: 'command', action: { actionId: 'ask-about-topic', parameters: { topic: 'lantern' } } });
    expect(typed.snapshot).toBe(back.snapshot);
  });

  it('runs first-entry effects once when the node is revisited', () => {
    const start = makeSnapshot(smallWorld);
    const entered = dispatchPlayerInput(smallWorld, start, { kind: 'choice', actionId: 'go' }).snapshot;
    const returned = dispatchPlayerInput(smallWorld, entered, { kind: 'choice', actionId: 'back' });
    expect(returned.snapshot.currentNodeId).toBe('start');
    const enterAgain = dispatchPlayerInput(smallWorld, returned.snapshot, { kind: 'choice', actionId: 'go' });
    expect(enterAgain.snapshot.state.world['entries']).toBe(1);
    expect(enterAgain.snapshot.state.world['exits']).toBe(2);
    expect(enterAgain.snapshot.state.world['revisits']).toBe(1);
  });

  it('follows visitable node links directly and applies exit, entry, and revisit lifecycle effects', () => {
    const world: WorldDocument = {
      ...smallWorld,
      navigationEdges: [],
      settings: {
        ...smallWorld.settings,
        time: { ...smallWorld.settings.time, mode: 'per-action', millisecondsPerAction: 1_000 },
      },
      nodes: [...smallWorld.nodes, {
        id: 'organizer', parentId: null, visitable: false,
        title: { kind: 'literal', text: 'Organizer' }, content: { kind: 'literal', text: '' },
      }],
    };
    const initial = makeSnapshot(world);
    const firstLink = dispatchPlayerInput(world, initial, { kind: 'node-link', nodeId: 'room' });
    expect(firstLink.resolution).toEqual({ kind: 'node-link', nodeId: 'room' });
    expect(firstLink.snapshot.currentNodeId).toBe('room');
    expect(firstLink.snapshot.state.world).toMatchObject({ exits: 1, entries: 1 });
    expect(firstLink.snapshot.gameTimeMilliseconds).toBe(1_000);

    const back = dispatchPlayerInput(world, firstLink.snapshot, { kind: 'node-link', nodeId: 'start' });
    const revisit = dispatchPlayerInput(world, back.snapshot, { kind: 'node-link', nodeId: 'room' });
    expect(revisit.resolution).toEqual({ kind: 'node-link', nodeId: 'room' });
    expect(revisit.snapshot.state.world).toMatchObject({ exits: 2, entries: 1, revisits: 1 });
    expect(revisit.snapshot.nodeVisitCounts.room).toBe(2);
    expect(revisit.snapshot.gameTimeMilliseconds).toBe(3_000);

    for (const nodeId of ['missing', 'organizer', 'start']) {
      const rejected = dispatchPlayerInput(world, initial, { kind: 'node-link', nodeId });
      expect(rejected.resolution.kind).toBe('invalid-node-link');
      expect(rejected.snapshot).toBe(initial);
      expect(rejected.diagnostics.diagnostics).toHaveLength(1);
    }
  });

  it('rolls back a node link when destination lifecycle effects fail', () => {
    const world: WorldDocument = {
      ...smallWorld,
      nodes: smallWorld.nodes.map((node) => node.id === 'room' ? {
        ...node,
        lifecycle: {
          ...node.lifecycle,
          entry: { policy: 'every-time', effects: [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'undeclared' }, amount: 1 }] },
        },
      } : node),
    };
    const initial = makeSnapshot(world);
    const rejected = dispatchPlayerInput(world, initial, { kind: 'node-link', nodeId: 'room' });
    expect(rejected.resolution.kind).toBe('invalid-node-link');
    expect(rejected.snapshot).toBe(initial);
    expect(rejected.snapshot.currentNodeId).toBe('start');
    expect(rejected.snapshot.state.world['exits']).toBe(0);
    expect(rejected.snapshot.nodeVisitCounts.room).toBe(0);
  });

  it('suspends dialogue on a node link and resumes it when returning to its node', () => {
    const world = { ...tavernWorld, scripts: [] };
    const initial = makeSnapshot(world, 'taproom');
    const started = dispatchPlayerInput(world, initial, { kind: 'command-text', rawText: 'speak with Mira' });
    expect(started.snapshot.activeConversation).toMatchObject({ conversationId: 'mira-story', lineId: 'mira-first' });

    const left = dispatchPlayerInput(world, started.snapshot, { kind: 'node-link', nodeId: 'cellar' });
    expect(left.resolution).toEqual({ kind: 'node-link', nodeId: 'cellar' });
    expect(left.snapshot.activeConversation).toBeNull();
    expect(left.snapshot.conversationStack).toEqual([{ conversationId: 'mira-story', lineId: 'mira-first', returnNodeId: 'taproom' }]);

    const returned = dispatchPlayerInput(world, left.snapshot, { kind: 'node-link', nodeId: 'taproom' });
    expect(returned.resolution).toEqual({ kind: 'node-link', nodeId: 'taproom' });
    expect(returned.snapshot.activeConversation).toMatchObject({ conversationId: 'mira-story', lineId: 'mira-first' });
    expect(returned.snapshot.conversationStack).toEqual([]);
  });

  it('returns no-match, ambiguous, and invalid input without mutating state', () => {
    const world: WorldDocument = {
      ...smallWorld,
      nodes: smallWorld.nodes.map((node) => node.id === 'start' ? {
        ...node,
        actions: { choices: [], commands: [
          { id: 'one', patterns: ['use {count}'], parameters: [{ id: 'count', valueType: 'integer' }], effects: [] },
          { id: 'two', patterns: ['use {amount}'], parameters: [{ id: 'amount', valueType: 'integer' }], effects: [] },
        ] },
      } : node),
    };
    const snapshot = makeSnapshot(world);
    expect(matchCommandText(world, snapshot, 'use 3')).toMatchObject({ kind: 'ambiguous', commandIds: ['one', 'two'] });
    expect(dispatchPlayerInput(world, snapshot, { kind: 'command-text', rawText: 'other' }).resolution.kind).toBe('no-match');
    expect(dispatchPlayerInput(world, snapshot, { kind: 'command-text', rawText: `use ${'x'.repeat(4097)}` }).resolution.kind).toBe('invalid-input');
    expect(snapshot.state.world['entries']).toBe(0);
  });
});
