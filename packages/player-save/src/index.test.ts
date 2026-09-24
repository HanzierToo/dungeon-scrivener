import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { PlayerSaveArchive } from '@dungeon-scrivener/model';
import compatibleSave from '../../../fixtures/tavern-at-dusk/saves/compatible-save.json';
import { decodePlayerSave, encodePlayerSave, PLAYER_SAVE_JSON_PATH } from './index.js';

describe('player save ZIP member', () => {
  it('writes and reads the single save.json member required by the v1 contract', async () => {
    const encoded = await encodePlayerSave(compatibleSave as PlayerSaveArchive);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(PLAYER_SAVE_JSON_PATH).toBe('save.json');
    expect(Object.keys(unzipSync(encoded.bytes))).toEqual(['save.json']);
    const decoded = await decodePlayerSave(encoded.bytes);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.save).toEqual(compatibleSave);
  });

  it('rejects the unversioned player-save.json alias', async () => {
    const legacy = zipSync({ 'player-save.json': strToU8(JSON.stringify(compatibleSave)) });
    const decoded = await decodePlayerSave(legacy);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.diagnostics.diagnostics[0]?.code).toBe('DS-SAVE-005');
  });
});
