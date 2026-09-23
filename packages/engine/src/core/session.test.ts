import { describe, expect, it } from 'vitest';
import type { CompiledScriptBundle, SessionStartOptions, WorldDocument } from '@dungeon-scrivener/model';
import tavernWorldJson from '../../../../fixtures/tavern-at-dusk/world.json';
import { createSession } from './session.js';
import { ZERO_SEED_REPLACEMENT } from './random.js';

const baseWorld = tavernWorldJson as unknown as WorldDocument;
const emptyBundle: CompiledScriptBundle = {
  format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts: [],
};

function makeWorld(timeMode: 'elapsed' | 'per-action' = 'elapsed'): WorldDocument {
  return {
    ...baseWorld,
    scripts: [],
    settings: {
      ...baseWorld.settings,
      time: {
        ...baseWorld.settings.time,
        mode: timeMode,
        ...(timeMode === 'per-action' ? { millisecondsPerAction: 100 } : {}),
      },
      randomness: { mode: 'seeded' },
    },
  };
}

const options: SessionStartOptions = {
  wallClockEpochMilliseconds: 12_345,
  visibility: 'visible',
  focused: true,
};

describe('engine session creation', () => {
  it('normalizes a supplied zero seed and starts without advancing per-action time', () => {
    const world = makeWorld('per-action');
    const created = createSession({}, emptyBundle, 'tavern-at-dusk', world, { ...options, randomSeed: 0 });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.diagnostics.diagnostics.map((item) => item.message).join('\n'));
    expect(created.snapshot.randomInitialSeed).toBe(ZERO_SEED_REPLACEMENT);
    expect(created.snapshot.randomSeed).toBe(ZERO_SEED_REPLACEMENT);
    expect(created.snapshot.gameTimeMilliseconds).toBe(0);
    expect(created.snapshot.nodeVisitCounts[world.entryNodeId]).toBe(1);
  });

  it('requires a valid host seed when no explicit seed is supplied', () => {
    const noSource = createSession({}, emptyBundle, 'tavern-at-dusk', makeWorld(), options);
    expect(noSource.ok).toBe(false);
    const invalidSource = createSession({ seededSeedSource: { nextUint32: () => 0x1_0000_0000 } }, emptyBundle, 'tavern-at-dusk', makeWorld(), options);
    expect(invalidSource.ok).toBe(false);
    const supplied = createSession({ seededSeedSource: { nextUint32: () => 42 } }, emptyBundle, 'tavern-at-dusk', makeWorld(), options);
    expect(supplied.ok).toBe(true);
    if (supplied.ok) expect(supplied.snapshot.randomInitialSeed).toBe(42);
  });

  it('returns diagnostics without a snapshot for invalid clock, seed, or script bundle', () => {
    const world = makeWorld();
    const invalidClock = createSession({}, emptyBundle, 'tavern-at-dusk', world, { ...options, wallClockEpochMilliseconds: Number.MAX_SAFE_INTEGER + 1, randomSeed: 1 });
    const invalidSeed = createSession({}, emptyBundle, 'tavern-at-dusk', world, { ...options, randomSeed: -1 });
    const bundleMismatch = createSession({}, emptyBundle, 'tavern-at-dusk', baseWorld, { ...options });
    for (const result of [invalidClock, invalidSeed, bundleMismatch]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result).not.toHaveProperty('snapshot');
    }
  });
});
