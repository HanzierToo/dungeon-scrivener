import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, WorldDocument } from '@dungeon-scrivener/model';
import tavernWorldJson from '../../../../fixtures/tavern-at-dusk/world.json';
import { dispatchPlayerInput } from './actions.js';
import { createInitialState } from './state.js';
import { clockHudValue, observeClock } from './time.js';

const baseWorld = tavernWorldJson as unknown as WorldDocument;

function makeWorld(hiddenBehavior: 'pause' | 'bounded-catch-up' = 'pause', cap = 500): WorldDocument {
  return {
    ...baseWorld,
    settings: {
      ...baseWorld.settings,
      time: { mode: 'elapsed', hiddenBehavior, maxCatchUpMilliseconds: cap, showClockHud: true },
    },
  };
}

function makeSnapshot(world: WorldDocument, baseline = 1_000): SessionSnapshot {
  return {
    projectId: 'tavern-at-dusk', currentNodeId: world.entryNodeId, state: createInitialState(world),
    nodeVisitCounts: Object.fromEntries(world.nodes.map((node) => [node.id, 0])), conversationStack: [],
    gameTimeMilliseconds: 0, randomnessMode: world.settings.randomness.mode, randomInitialSeed: null, randomSeed: null,
    randomOutcomes: [], entityTags: Object.fromEntries(world.entities.map((entity) => [entity.id, [...entity.tags]])),
    clockState: { visibility: 'visible', focused: true, lastObservedEpochMilliseconds: baseline, inactiveSinceEpochMilliseconds: null },
    ruleGuards: {}, inventory: world.initialInventory,
  };
}

describe('engine clock and game time', () => {
  it('pauses hidden elapsed time across a saved snapshot and resume', () => {
    const world = makeWorld('pause');
    const initial = makeSnapshot(world);
    const hidden = observeClock(world, initial, {
      kind: 'visibility-change', wallClockEpochMilliseconds: 1_100, visibility: 'hidden', focused: true,
    });
    expect(hidden.snapshot.gameTimeMilliseconds).toBe(100);

    const restored = structuredClone(hidden.snapshot);
    const resumed = observeClock(world, restored, {
      kind: 'resume', wallClockEpochMilliseconds: 20_000, visibility: 'visible', focused: true,
    });
    expect(resumed.snapshot.gameTimeMilliseconds).toBe(100);
    expect(resumed.snapshot.clockState.lastObservedEpochMilliseconds).toBe(20_000);
    expect(resumed.snapshot.clockState.inactiveSinceEpochMilliseconds).toBeNull();
  });

  it('caps catch-up on resume and exposes only game time to the HUD', () => {
    const world = makeWorld('bounded-catch-up', 500);
    const hidden = observeClock(world, makeSnapshot(world), {
      kind: 'visibility-change', wallClockEpochMilliseconds: 1_100, visibility: 'hidden', focused: true,
    });
    const resumed = observeClock(world, hidden.snapshot, {
      kind: 'resume', wallClockEpochMilliseconds: 20_000, visibility: 'visible', focused: true,
    });
    expect(resumed.snapshot.gameTimeMilliseconds).toBe(600);
    expect(clockHudValue(world, resumed.snapshot)).toBe(600);
    expect(clockHudValue({ ...world, settings: { ...world.settings, time: { ...world.settings.time, showClockHud: false } } }, resumed.snapshot)).toBeUndefined();
  });

  it('advances per-action time only for accepted player actions', () => {
    const world: WorldDocument = {
      ...baseWorld,
      settings: { ...baseWorld.settings, time: { ...baseWorld.settings.time, mode: 'per-action', millisecondsPerAction: 250 } },
    };
    const initial = makeSnapshot(world);
    const accepted = dispatchPlayerInput(world, initial, { kind: 'choice', actionId: 'enter-cellar' });
    expect(accepted.snapshot.gameTimeMilliseconds).toBe(250);
    const invalid = dispatchPlayerInput(world, initial, { kind: 'choice', actionId: 'missing-choice' });
    expect(invalid.snapshot.gameTimeMilliseconds).toBe(0);
  });

  it('rejects backwards timestamps and invalid catch-up caps without changing the snapshot', () => {
    const world = makeWorld();
    const snapshot = makeSnapshot(world);
    expect(observeClock(world, snapshot, {
      kind: 'tick', wallClockEpochMilliseconds: 999, visibility: 'visible', focused: true,
    }).snapshot).toBe(snapshot);
    const invalidWorld = makeWorld('bounded-catch-up', 86_400_001);
    expect(observeClock(invalidWorld, snapshot, {
      kind: 'resume', wallClockEpochMilliseconds: 2_000, visibility: 'visible', focused: true,
    }).snapshot).toBe(snapshot);
  });
});
