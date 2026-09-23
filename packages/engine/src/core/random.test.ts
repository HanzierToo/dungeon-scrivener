import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, WorldDocument } from '@dungeon-scrivener/model';
import tavernWorldJson from '../../../../fixtures/tavern-at-dusk/world.json';
import { createInitialState } from './state.js';
import { drawRandomFloat, drawRandomInt } from './random.js';

const baseWorld = tavernWorldJson as unknown as WorldDocument;

function makeWorld(mode: 'seeded' | 'unseeded'): WorldDocument {
  return { ...baseWorld, settings: { ...baseWorld.settings, randomness: { mode } } };
}

function makeSnapshot(world: WorldDocument, seed: number | null): SessionSnapshot {
  return {
    projectId: 'tavern-at-dusk', currentNodeId: world.entryNodeId, state: createInitialState(world),
    nodeVisitCounts: Object.fromEntries(world.nodes.map((node) => [node.id, 0])), conversationStack: [],
    gameTimeMilliseconds: 0, randomnessMode: world.settings.randomness.mode,
    randomInitialSeed: seed, randomSeed: seed, randomOutcomes: [],
    entityTags: Object.fromEntries(world.entities.map((entity) => [entity.id, [...entity.tags]])),
    clockState: { visibility: 'visible', focused: true, lastObservedEpochMilliseconds: null, inactiveSinceEpochMilliseconds: null },
    ruleGuards: {}, inventory: world.initialInventory,
  };
}

describe('engine random outcomes', () => {
  it('repeats seeded values, current state, and trace for the same draw sequence', () => {
    const world = makeWorld('seeded');
    const host = {};
    const run = () => {
      let snapshot = makeSnapshot(world, 123);
      const traces = [];
      const values = [];
      for (let ordinal = 0; ordinal < 3; ordinal += 1) {
        const draw = drawRandomFloat(world, snapshot, 'script-one', host, ordinal);
        expect(draw.ok).toBe(true);
        if (!draw.ok) throw new Error(draw.diagnostic.message);
        snapshot = draw.snapshot;
        values.push(draw.value);
        traces.push(...draw.trace);
      }
      return { snapshot, values, traces };
    };
    expect(run()).toEqual(run());
  });

  it('records distinct unseeded values and replays them from an exact transcript', () => {
    const world = makeWorld('unseeded');
    const initial = makeSnapshot(world, null);
    const rawValues = [0x4000_0000, 0xc000_0000];
    let sourceIndex = 0;
    const entropy = { nextUint32: () => rawValues[sourceIndex++]! };
    const first = drawRandomFloat(world, initial, 'script-one', { unseededRandomSource: entropy });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.diagnostic.message);
    const second = drawRandomFloat(world, first.snapshot, 'script-one', { unseededRandomSource: entropy });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.diagnostic.message);
    expect([first.value, second.value]).toEqual([0.25, 0.75]);
    expect(second.snapshot.randomOutcomes).toHaveLength(2);

    let replayIndex = 0;
    const replay = { nextOutcome: () => second.snapshot.randomOutcomes[replayIndex++] };
    const replayFirst = drawRandomFloat(world, initial, 'script-one', { unseededRandomReplaySource: replay });
    expect(replayFirst.ok).toBe(true);
    if (!replayFirst.ok) throw new Error(replayFirst.diagnostic.message);
    const replaySecond = drawRandomFloat(world, replayFirst.snapshot, 'script-one', { unseededRandomReplaySource: replay });
    expect(replaySecond).toEqual(second);
  });

  it('uses bounded unbiased integer draws and fails on replay request mismatch', () => {
    const seeded = makeWorld('seeded');
    const int = drawRandomInt(seeded, makeSnapshot(seeded, 123), 'script-one', -2, 2, {}, 4);
    expect(int.ok).toBe(true);
    if (int.ok) {
      expect(int.value).toBeGreaterThanOrEqual(-2);
      expect(int.value).toBeLessThanOrEqual(2);
    }

    const unseeded = makeWorld('unseeded');
    const mismatch = drawRandomInt(unseeded, makeSnapshot(unseeded, null), 'script-one', 1, 2, {
      unseededRandomReplaySource: { nextOutcome: () => ({ ordinal: 0, sourceScriptId: 'script-one', operation: 'integer', minimum: 0, maximum: 2, value: 1, provider: 'unseeded' }) },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.snapshot.randomOutcomes).toHaveLength(0);
  });
});
