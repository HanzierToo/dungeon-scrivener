import { describe, expect, it } from 'vitest';
import {
  createMediaAssetCatalog,
  resolveTypingSound,
  validateTypingSoundAsset
} from './index.js';
import type { ContentDigest, PlayerTypingSoundView } from '@dungeon-scrivener/model';

function makeWav(): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, 2, true);
  view.setInt16(44, 0, true);
  return bytes;
}

function digest(hex: string): ContentDigest {
  return `sha256:${hex}`;
}

const unavailableAsset = {
  assetId: digest('0'.repeat(64)),
  mediaType: 'audio/wav' as const,
  byteLength: 46
};

function typingSounds(overrides: Partial<PlayerTypingSoundView> = {}): PlayerTypingSoundView {
  return {
    mappings: [],
    fallback: { kind: 'silent' },
    ...overrides
  };
}

describe('content-addressed media', () => {
  it('deduplicates identical files while retaining every original filename', async () => {
    const catalog = createMediaAssetCatalog();
    const wav = makeWav();
    const first = await catalog.registerAsset({ bytes: wav, originalFilename: 'typing.wav' });
    const second = await catalog.registerAsset({ bytes: wav, originalFilename: 'tavern-key.wav' });

    expect(second.assetId).toBe(first.assetId);
    expect(catalog.listAssets()).toHaveLength(1);
    expect(first.originalFilenames).toEqual(['typing.wav']);
    expect(second.originalFilenames).toEqual(['typing.wav', 'tavern-key.wav']);
    const resolved = catalog.resolveAsset(first.assetId);
    const secondNodeReference = catalog.resolveAsset(second.assetId);
    expect(resolved.ok && resolved.asset.bytes).toEqual(wav);
    expect(secondNodeReference.ok && secondNodeReference.asset.bytes).toEqual(wav);
  });

  it('returns defensive bytes, verifies hash identity at registration, and diagnoses missing IDs', async () => {
    const catalog = createMediaAssetCatalog();
    const registered = await catalog.registerAsset({ bytes: makeWav(), originalFilename: 'sound.wav' });
    const resolved = catalog.resolveAsset(registered.assetId);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) resolved.asset.bytes.fill(0);
    const resolvedAgain = catalog.resolveAsset(registered.assetId);
    expect(resolvedAgain.ok && validateTypingSoundAsset(resolvedAgain).ok).toBe(true);
    expect(catalog.resolveAsset(digest('f'.repeat(64))).ok).toBe(false);
    expect(catalog.resolveAsset('bad-digest' as ContentDigest).ok).toBe(false);
    await expect(catalog.registerAsset({
      bytes: makeWav(),
      originalFilename: 'wrong-hash.wav',
      expectedAssetId: digest('f'.repeat(64))
    })).rejects.toThrow(/do not match/u);
  });

  it('rejects malformed WAV data and unsafe or unsupported image formats', async () => {
    const catalog = createMediaAssetCatalog();
    const malformed = makeWav();
    new DataView(malformed.buffer).setUint32(4, 1, true);
    const malformedAsset = await catalog.registerAsset({ bytes: malformed, originalFilename: 'broken.wav' });
    expect(validateTypingSoundAsset(catalog.resolveAsset(malformedAsset.assetId)).ok).toBe(false);

    await expect(catalog.registerAsset({
      bytes: new TextEncoder().encode('<svg><script>alert(1)</script></svg>'),
      originalFilename: 'unsafe.svg'
    })).rejects.toThrow(/unsupported or mismatched media type/iu);
    await expect(catalog.registerAsset({
      bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
      originalFilename: 'moving.gif'
    })).rejects.toThrow(/unsupported or mismatched media type/iu);
    await expect(catalog.registerAsset({
      bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
      originalFilename: 'movie.mp4'
    })).rejects.toThrow(/unsupported or mismatched media type/iu);
  });

  it('maps Enter separately from letters and preserves authored zero and full volume', async () => {
    const catalog = createMediaAssetCatalog();
    const wav = makeWav();
    const exact = await catalog.registerAsset({ bytes: wav, originalFilename: 'enter.wav' });
    const groupBytes = makeWav();
    groupBytes[44] = 1;
    const letters = await catalog.registerAsset({ bytes: groupBytes, originalFilename: 'letter.wav' });
    const sounds = typingSounds({ mappings: [
      { target: { kind: 'group', group: 'letters' }, asset: { assetId: letters.assetId, mediaType: 'audio/wav', byteLength: letters.byteLength }, volume: 0 },
      { target: { kind: 'key', code: 'Enter' }, asset: { assetId: exact.assetId, mediaType: 'audio/wav', byteLength: exact.byteLength }, volume: 1 }
    ] });

    const enter = resolveTypingSound(sounds, 'Enter', catalog);
    const letter = resolveTypingSound(sounds, 'KeyA', catalog);
    expect(enter.kind === 'asset' && enter.volume).toBe(1);
    expect(letter.kind === 'asset' && letter.volume).toBe(0);
  });

  it('uses fallback after the preferred asset fails, and remains silent if fallback fails', async () => {
    const catalog = createMediaAssetCatalog();
    const validFallback = await catalog.registerAsset({ bytes: makeWav(), originalFilename: 'fallback.wav' });
    const withFallback = typingSounds({
      mappings: [{ target: { kind: 'key', code: 'Enter' }, asset: { ...unavailableAsset }, volume: 0.5 }],
      fallback: { kind: 'asset', asset: { assetId: validFallback.assetId, mediaType: 'audio/wav', byteLength: validFallback.byteLength }, volume: 0.25 }
    });
    const fallback = resolveTypingSound(withFallback, 'Enter', catalog);
    expect(fallback.kind === 'asset' && fallback.fallback && fallback.volume).toBe(0.25);

    const failedFallback = typingSounds({
      mappings: withFallback.mappings,
      fallback: { kind: 'asset', asset: unavailableAsset, volume: 0.25 }
    });
    expect(resolveTypingSound(failedFallback, 'Enter', catalog).kind).toBe('silent');
    expect(resolveTypingSound(typingSounds(), 'Enter', catalog).kind).toBe('silent');
  });
});
