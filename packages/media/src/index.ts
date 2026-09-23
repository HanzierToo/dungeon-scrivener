import type {
  ContentDigest,
  Diagnostic,
  MediaAssetApi,
  MediaAssetResolution,
  ResolvedMediaAsset
} from '@dungeon-scrivener/model';

export interface AssetRegistration {
  readonly bytes: Uint8Array;
  readonly originalFilename: string;
  readonly mediaType?: string;
  /** When loading a stored VFS asset, require its managed digest to match this ID. */
  readonly expectedAssetId?: ContentDigest;
}

export interface RegisteredAsset {
  readonly assetId: ContentDigest;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly originalFilenames: readonly string[];
}

export interface MediaAssetCatalog extends MediaAssetApi {
  registerAsset(registration: AssetRegistration): Promise<RegisteredAsset>;
  listAssets(): readonly RegisteredAsset[];
}

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const SAFE_FILENAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const IMAGE_SIGNATURES: ReadonlyArray<{ mediaType: string; test: (bytes: Uint8Array) => boolean }> = [
  { mediaType: 'image/png', test: bytes => hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mediaType: 'image/jpeg', test: bytes => hasPrefix(bytes, [0xff, 0xd8, 0xff]) },
  { mediaType: 'image/webp', test: bytes => ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' }
];

function diagnostic(code: string, message: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    blocks: ['play', 'export'],
    acknowledgementRequired: []
  };
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function detectMediaType(bytes: Uint8Array): string | undefined {
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.test(bytes)) return signature.mediaType;
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
  if (isSupportedOggAudio(bytes)) return 'audio/ogg';
  if (hasPrefix(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  return undefined;
}

function isSupportedOggAudio(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 4) !== 'OggS' || bytes.byteLength < 28) return false;
  const segmentCount = bytes[26]!;
  const segmentTableEnd = 27 + segmentCount;
  if (segmentTableEnd >= bytes.byteLength) return false;
  const firstPacketLength = bytes[27]!;
  if (firstPacketLength > bytes.byteLength - segmentTableEnd - 1) return false;
  const packet = bytes.subarray(segmentTableEnd + 1, segmentTableEnd + 1 + firstPacketLength);
  return (packet[0] === 1 && ascii(packet, 1, 6) === 'vorbis') || ascii(packet, 0, 8) === 'OpusHead';
}

function isStaticImage(mediaType: string, bytes: Uint8Array): boolean {
  if (mediaType === 'image/png') {
    let offset = 8;
    let hasHeader = false;
    let hasImageData = false;
    let hasEnd = false;
    while (offset + 12 <= bytes.byteLength) {
      const length = readU32(bytes, offset);
      const kind = ascii(bytes, offset + 4, 4);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > bytes.byteLength || hasEnd) return false;
      if (kind === 'IHDR') {
        if (hasHeader || offset !== 8 || length !== 13) return false;
        hasHeader = true;
      }
      if (kind === 'IDAT') hasImageData = true;
      if (kind === 'acTL') return false;
      if (kind === 'IEND') {
        if (length !== 0 || chunkEnd !== bytes.byteLength) return false;
        hasEnd = true;
      }
      offset = chunkEnd;
    }
    return offset === bytes.byteLength && hasHeader && hasImageData && hasEnd;
  }
  if (mediaType === 'image/jpeg') {
    return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9;
  }
  if (mediaType === 'image/webp') {
    if (bytes.byteLength < 20 || readU32(bytes, 4) + 8 !== bytes.byteLength) return false;
    let offset = 12;
    let hasImageChunk = false;
    while (offset + 8 <= bytes.byteLength) {
      const kind = ascii(bytes, offset, 4);
      const length = readU32(bytes, offset + 4);
      const chunkStart = offset + 8;
      if (kind === 'VP8X' && length > 0 && (bytes[chunkStart]! & 0x02) !== 0) return false;
      if (kind === 'VP8 ' || kind === 'VP8L') hasImageChunk = true;
      offset = chunkStart + length + (length % 2);
      if (offset > bytes.byteLength) return false;
    }
    return offset === bytes.byteLength && hasImageChunk;
  }
  return true;
}

function normalizeMediaType(mediaType: string | undefined, bytes: Uint8Array): string | undefined {
  const detected = detectMediaType(bytes);
  if (detected === undefined || (detected.startsWith('image/') && !isStaticImage(detected, bytes))) return undefined;
  if (mediaType !== undefined && mediaType.toLowerCase().split(';', 1)[0]!.trim() !== detected) return undefined;
  return detected;
}

function validWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return false;
  if (readU32(bytes, 4) + 8 !== bytes.byteLength) return false;

  let offset = 12;
  let formatCount = 0;
  let dataCount = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataLength = 0;
  let encoding = 0;

  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return false;
    const chunkName = ascii(bytes, offset, 4);
    const chunkLength = readU32(bytes, offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    const paddedEnd = chunkEnd + (chunkLength % 2);
    if (chunkEnd > bytes.byteLength || paddedEnd > bytes.byteLength) return false;

    if (chunkName === 'fmt ') {
      formatCount += 1;
      if (formatCount !== 1 || chunkLength < 16) return false;
      encoding = readU16(bytes, chunkStart);
      channels = readU16(bytes, chunkStart + 2);
      sampleRate = readU32(bytes, chunkStart + 4);
      byteRate = readU32(bytes, chunkStart + 8);
      blockAlign = readU16(bytes, chunkStart + 12);
      bitsPerSample = readU16(bytes, chunkStart + 14);
    } else if (chunkName === 'data') {
      dataCount += 1;
      if (dataCount !== 1) return false;
      dataLength = chunkLength;
    }
    offset = paddedEnd;
  }

  if (offset !== bytes.byteLength || formatCount !== 1 || dataCount !== 1) return false;
  const pcm = encoding === 1 && [8, 16, 24, 32].includes(bitsPerSample);
  const float = encoding === 3 && bitsPerSample === 32;
  if (!pcm && !float) return false;
  if (channels < 1 || channels > 2 || sampleRate < 8_000 || sampleRate > 192_000) return false;
  const expectedAlign = channels * bitsPerSample / 8;
  return blockAlign === expectedAlign && byteRate === sampleRate * blockAlign && dataLength % blockAlign === 0;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

async function sha256(bytes: Uint8Array): Promise<ContentDigest> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error('SHA-256 hashing is unavailable in this runtime.');
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

function validFilename(filename: string): boolean {
  return filename.length > 0 && filename.length <= 255 && !SAFE_FILENAME_CONTROL.test(filename) &&
    !filename.includes('/') && !filename.includes('\\') && filename !== '.' && filename !== '..';
}

/**
 * Create a deduplicating in-memory asset catalog. Registration hashes and copies
 * the input before retaining it; lookup returns a new copy on each successful call.
 */
export function createMediaAssetCatalog(): MediaAssetCatalog {
  const assets = new Map<ContentDigest, { mediaType: string; bytes: Uint8Array; originalFilenames: Set<string> }>();

  return {
    async registerAsset(registration): Promise<RegisteredAsset> {
      if (!(registration.bytes instanceof Uint8Array) || registration.bytes.byteLength === 0 || registration.bytes.byteLength > MAX_ASSET_BYTES) {
        throw new TypeError('Asset bytes must be a non-empty Uint8Array no larger than 64 MiB.');
      }
      if (!validFilename(registration.originalFilename)) {
        throw new TypeError('Original filename must be a safe basename of at most 255 characters.');
      }
      const bytes = new Uint8Array(registration.bytes.byteLength);
      bytes.set(registration.bytes);
      const mediaType = normalizeMediaType(registration.mediaType, bytes);
      if (mediaType === undefined) {
        throw new TypeError('Unsupported or mismatched media type. Supported assets are static PNG, JPEG, WebP, WAV, Vorbis/Opus Ogg audio, and MPEG audio.');
      }
      const assetId = await sha256(bytes);
      if (registration.expectedAssetId !== undefined && registration.expectedAssetId !== assetId) {
        throw new TypeError('Managed asset bytes do not match the declared SHA-256 asset ID.');
      }
      let stored = assets.get(assetId);
      if (stored === undefined) {
        stored = { mediaType, bytes, originalFilenames: new Set() };
        assets.set(assetId, stored);
      } else if (stored.mediaType !== mediaType) {
        throw new TypeError('The same bytes cannot be registered under conflicting media types.');
      }
      stored.originalFilenames.add(registration.originalFilename);
      return Object.freeze({
        assetId,
        mediaType: stored.mediaType,
        byteLength: stored.bytes.byteLength,
        originalFilenames: Object.freeze([...stored.originalFilenames])
      });
    },

    resolveAsset(assetId): MediaAssetResolution {
      if (!DIGEST_PATTERN.test(assetId)) {
        return { ok: false, diagnostic: diagnostic('DS-MEDIA-DIGEST', 'Asset ID must be a lowercase SHA-256 content digest.') };
      }
      const stored = assets.get(assetId);
      if (stored === undefined) {
        return { ok: false, diagnostic: diagnostic('DS-MEDIA-MISSING', 'The requested managed asset is unavailable.') };
      }
      if (stored.mediaType === 'audio/wav' && !validWav(stored.bytes)) {
        return { ok: false, diagnostic: diagnostic('DS-MEDIA-WAV', 'The WAV asset is malformed or uses an unsupported encoding.') };
      }
      const asset: ResolvedMediaAsset = {
        assetId,
        mediaType: stored.mediaType,
        byteLength: stored.bytes.byteLength,
        bytes: new Uint8Array(stored.bytes)
      };
      return { ok: true, asset };
    },

    listAssets(): readonly RegisteredAsset[] {
      return Object.freeze([...assets].map(([assetId, stored]) => Object.freeze({
        assetId,
        mediaType: stored.mediaType,
        byteLength: stored.bytes.byteLength,
        originalFilenames: Object.freeze([...stored.originalFilenames])
      })));
    }
  };
}

/** Convenience registration helper matching the public package API. */
export function registerAsset(catalog: MediaAssetCatalog, registration: AssetRegistration): Promise<RegisteredAsset> {
  return catalog.registerAsset(registration);
}

/** Validate WAV-specific typing sound references before they are projected to the player. */
export function validateTypingSoundAsset(resolution: MediaAssetResolution): MediaAssetResolution {
  if (!resolution.ok) return resolution;
  if (resolution.asset.mediaType !== 'audio/wav' || !validWav(resolution.asset.bytes)) {
    return { ok: false, diagnostic: diagnostic('DS-MEDIA-WAV', 'Typing sounds require a supported, well-formed WAV asset.') };
  }
  return resolution;
}

/** Convert an authored 64-character asset hash to the content-digest API form. */
export function contentDigestFromHash(hash: string): ContentDigest | undefined {
  return /^[a-f0-9]{64}$/u.test(hash) ? `sha256:${hash}` : undefined;
}

export type TypingSoundResolution =
  | { readonly kind: 'asset'; readonly asset: ResolvedMediaAsset; readonly volume: number; readonly fallback: boolean }
  | { readonly kind: 'silent'; readonly diagnostic?: Diagnostic };

function keyGroup(code: string): string {
  if (/^Key[A-Z]$/u.test(code)) return 'letters';
  if (/^(?:Digit[0-9]|Numpad[0-9])$/u.test(code)) return 'digits';
  if (code === 'Space') return 'space';
  if (/^(?:Backquote|Backslash|BracketLeft|BracketRight|Comma|Equal|IntlBackslash|IntlRo|IntlYen|Minus|Period|Quote|Semicolon|Slash)$/u.test(code)) return 'punctuation';
  if (/^(?:Backspace|Delete|Enter|Tab|Escape|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert)$/u.test(code)) return 'editing';
  return 'other';
}

/** Resolve one typing key with exact-code precedence, then group, then fallback. */
export function resolveTypingSound(
  sounds: import('@dungeon-scrivener/model').PlayerTypingSoundView,
  code: string,
  mediaAssets: MediaAssetApi,
  primaryUnavailable = false
): TypingSoundResolution {
  const exact = sounds.mappings.find(mapping => mapping.target.kind === 'key' && mapping.target.code === code);
  const group = sounds.mappings.find(mapping => mapping.target.kind === 'group' && mapping.target.group === keyGroup(code));
  const primary = exact ?? group;

  if (primary !== undefined && !primaryUnavailable) {
    const resolved = validateTypingSoundAsset(mediaAssets.resolveAsset(primary.asset.assetId));
    if (resolved.ok) return { kind: 'asset', asset: resolved.asset, volume: primary.volume, fallback: false };
    return resolveFallback(sounds, mediaAssets, resolved.diagnostic);
  }
  return resolveFallback(sounds, mediaAssets);
}

function resolveFallback(
  sounds: import('@dungeon-scrivener/model').PlayerTypingSoundView,
  mediaAssets: MediaAssetApi,
  priorDiagnostic?: Diagnostic
): TypingSoundResolution {
  if (sounds.fallback.kind === 'silent') return { kind: 'silent', ...(priorDiagnostic === undefined ? {} : { diagnostic: priorDiagnostic }) };
  const resolved = validateTypingSoundAsset(mediaAssets.resolveAsset(sounds.fallback.asset.assetId));
  if (resolved.ok) return { kind: 'asset', asset: resolved.asset, volume: sounds.fallback.volume, fallback: true };
  return { kind: 'silent', diagnostic: resolved.diagnostic };
}
