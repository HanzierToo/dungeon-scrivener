import { describe, expect, it } from 'vitest';
import type { EventOccurrence, RuleDefinition, SessionSnapshot, WorldDocument } from '@dungeon-scrivener/model';
import { createInitialState } from './state.js';
import { processEventQueue, shouldRunLifecycleEffects } from './rules.js';

const baseWorld: WorldDocument = {
  format: 'dungeon-scrivener-world', schemaVersion: 1, entryNodeId: 'entry',
  settings: { time: { mode: 'per-action', hiddenBehavior: 'pause', maxCatchUpMilliseconds: 0, showClockHud: false }, randomness: { mode: 'seeded' } },
  savePolicy: { enabled: false, slotCount: 0, allowedLocation: 'anywhere' },
  stateDefinitions: [{ key: 'score', scopeKind: 'world', valueType: 'integer', defaultValue: 0 }], worldState: {},
  nodes: [
    { id: 'root', parentId: null, visitable: false, title: { kind: 'literal', text: 'Root' }, content: { kind: 'literal', text: '' }, ruleIds: ['parent-rule'] },
    { id: 'entry', parentId: 'root', visitable: true, title: { kind: 'literal', text: 'Entry' }, content: { kind: 'literal', text: '' }, inheritance: { defaults: false, rules: true }, ruleIds: [] },
  ],
  navigationEdges: [], entityDefinitions: [], entities: [], actionDefaults: { choices: [], commands: [] },
  eventDefinitions: [{ id: 'start', payloadFields: [] }, { id: 'next', payloadFields: [] }],
  rules: [], conversations: [], itemDefinitions: [], initialInventory: [], scripts: [],
};

function makeSnapshot(world: WorldDocument = baseWorld): SessionSnapshot {
  return {
    projectId: 'demo', currentNodeId: 'entry', state: createInitialState(world),
    nodeVisitCounts: Object.fromEntries(world.nodes.map((node) => [node.id, 0])), conversationStack: [], gameTimeMilliseconds: 0,
    randomnessMode: 'seeded', randomInitialSeed: 1, randomSeed: 1, randomOutcomes: [], entityTags: {},
    clockState: { visibility: 'visible', focused: true, lastObservedEpochMilliseconds: 0, inactiveSinceEpochMilliseconds: null },
    ruleGuards: {}, inventory: [],
  };
}

function rule(id: string, eventId: string, priority: number, effects: RuleDefinition['effects']): RuleDefinition {
  return { id, trigger: { kind: 'event', eventId }, priority, effects };
}

const startEvent: EventOccurrence = { eventId: 'start', payload: {}, source: 'test-action' };

describe('event and rule processing', () => {
  it('evaluates every-time, first-time, and once-per-playthrough lifecycle guards', () => {
    expect(shouldRunLifecycleEffects('every-time', 5, true)).toBe(true);
    expect(shouldRunLifecycleEffects('first-time', 0, false)).toBe(true);
    expect(shouldRunLifecycleEffects('first-time', 1, false)).toBe(false);
    expect(shouldRunLifecycleEffects('once-per-playthrough', 3, false)).toBe(true);
    expect(shouldRunLifecycleEffects('once-per-playthrough', 0, true)).toBe(false);
  });

  it('runs equal-priority rules in authored order', () => {
    const world: WorldDocument = {
      ...baseWorld,
      nodes: baseWorld.nodes.map((node) => node.id === 'entry' ? { ...node, ruleIds: ['first', 'second'] } : node),
      rules: [
        rule('first', 'start', 10, [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'score' }, amount: 1 }]),
        rule('second', 'start', 10, [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'score' }, amount: 10 }]),
      ],
    };
    const result = processEventQueue(world, makeSnapshot(world), [startEvent], { kind: 'action', actionId: 'raise' }, 'The action emits start.');
    expect(result.snapshot.state.world['score']).toBe(11);
    expect(result.trace.filter((entry) => entry.kind === 'rule').map((entry) => entry.source.kind === 'rule' ? entry.source.ruleId : '')).toEqual(['first', 'second']);
  });

  it('queues events emitted by a rule and handles them after the current event rules', () => {
    const world: WorldDocument = {
      ...baseWorld,
      nodes: baseWorld.nodes.map((node) => node.id === 'entry' ? { ...node, ruleIds: ['emit-next', 'handle-next'] } : node),
      rules: [
        rule('emit-next', 'start', 1, [{ kind: 'emit-event', eventId: 'next', payload: {} }]),
        rule('handle-next', 'next', 1, [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'score' }, amount: 4 }]),
      ],
    };
    const result = processEventQueue(world, makeSnapshot(world), [startEvent], { kind: 'action', actionId: 'begin' }, 'Begin the chain.');
    expect(result.snapshot.state.world['score']).toBe(4);
    expect(result.trace.filter((entry) => entry.kind === 'rule').map((entry) => entry.source.kind === 'rule' ? entry.source.ruleId : '')).toEqual(['emit-next', 'handle-next']);
    expect(result.trace.filter((entry) => entry.kind === 'event').map((entry) => entry.eventId)).toEqual(['start', 'next']);
  });

  it('executes inherited parent rules before child rules even when child priority is higher', () => {
    const world: WorldDocument = {
      ...baseWorld,
      nodes: baseWorld.nodes.map((node) => node.id === 'entry' ? { ...node, ruleIds: ['child-rule'] } : node),
      rules: [
        rule('parent-rule', 'start', 1, [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'score' }, amount: 1 }]),
        rule('child-rule', 'start', 999, [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'score' }, amount: 10 }]),
      ],
    };
    const result = processEventQueue(world, makeSnapshot(world), [startEvent], { kind: 'action', actionId: 'inherit' }, 'Raise start.');
    expect(result.snapshot.state.world['score']).toBe(11);
    expect(result.trace.filter((entry) => entry.kind === 'rule').map((entry) => entry.source.kind === 'rule' ? entry.source.ruleId : '')).toEqual(['parent-rule', 'child-rule']);
  });

  it('runs the same event rule again for a later occurrence', () => {
    const world: WorldDocument = {
      ...baseWorld,
      nodes: baseWorld.nodes.map((node) => node.id === 'entry' ? { ...node, ruleIds: ['every-start'] } : node),
      rules: [rule('every-start', 'start', 1, [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'score' }, amount: 1 }])],
    };
    const result = processEventQueue(world, makeSnapshot(world), [startEvent, { ...startEvent, source: 'another-action' }], { kind: 'action', actionId: 'repeat' }, 'Emit start twice.');
    expect(result.snapshot.state.world['score']).toBe(2);
  });

  it('rolls back a self-triggering rule at the bounded event budget', () => {
    const world: WorldDocument = {
      ...baseWorld,
      nodes: baseWorld.nodes.map((node) => node.id === 'entry' ? { ...node, ruleIds: ['loop'] } : node),
      rules: [rule('loop', 'start', 1, [{ kind: 'emit-event', eventId: 'start', payload: {} }])],
    };
    const snapshot = makeSnapshot(world);
    const result = processEventQueue(world, snapshot, [startEvent], { kind: 'action', actionId: 'loop' }, 'Start the loop.');
    expect(result.snapshot).toBe(snapshot);
    expect(result.diagnostics.diagnostics[0]?.code).toBe('DS-ENG-003');
    expect(result.diagnostics.diagnostics[0]?.message).toContain('1000 occurrence budget');
    expect(result.trace.length).toBeLessThanOrEqual(20_000);
  });
});
