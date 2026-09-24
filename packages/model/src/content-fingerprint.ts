import type {
  ContentFingerprint,
  ContentFingerprintFailure,
  ContentFingerprintResult,
  Diagnostic,
  FingerprintedFile,
  LocaleDocument,
  ProjectManifest,
  ProjectVfsSnapshot,
  WorldDocument,
} from './public-types.js';
import {
  parseJsonDocument,
  validateLocaleDocument,
  validateProjectManifest,
  validateWorldDocument,
} from './validation.js';

const textEncoder = new TextEncoder();
const hashConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const initialHash = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Synchronous SHA-256 over exact bytes. Uses no Node or Web Crypto APIs. */
function sha256(bytes: Uint8Array): string {
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  let bitLength = BigInt(bytes.byteLength) * 8n;
  for (let index = 0; index < 8; index += 1) {
    padded[paddedLength - index - 1] = Number(bitLength & 0xffn);
    bitLength >>= 8n;
  }

  const hash = new Uint32Array(initialHash);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] = (
        (padded[byteOffset] ?? 0) << 24 |
        (padded[byteOffset + 1] ?? 0) << 16 |
        (padded[byteOffset + 2] ?? 0) << 8 |
        (padded[byteOffset + 3] ?? 0)
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + (hashConstants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

const invalidUtf16 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const controlCharacters = /[\u0000-\u001F\u007F-\u009F]/u;
const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function validatePath(path: string): string | undefined {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || invalidUtf16.test(path)) return 'must be a valid relative UTF-8 path';
  if (path !== path.normalize('NFC')) return 'must already be Unicode NFC normalized';
  if (controlCharacters.test(path) || textEncoder.encode(path).byteLength > 1024) return 'contains controls or exceeds the path byte limit';
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') || windowsDevice.test(segment)) {
      return 'contains an unsafe path segment';
    }
    if (textEncoder.encode(segment).byteLength > 255) return 'contains an overlong path segment';
  }
  return undefined;
}

function diagnostic(code: string, message: string, path: string, entityId?: string): Diagnostic {
  const safePath = validatePath(path) === undefined ? path : 'world.json';
  return {
    code,
    severity: 'error',
    message: safePath === path ? message : `${message} (source path: ${path})`,
    path: safePath,
    ...(entityId && /^[a-z][a-z0-9-]{0,63}$/u.test(entityId) ? { entityId } : {}),
    suggestedFix: 'Restore the referenced file at its contract path and make its contents agree with the accepted project document.',
    blocks: ['play', 'export'],
  };
}

function reportFailure(diagnostics: Diagnostic[]): ContentFingerprintFailure {
  return {
    ok: false,
    diagnostics: { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics },
  };
}

function getJson(bytes: Uint8Array, path: string, diagnostics: Diagnostic[]): unknown | undefined {
  const parsed = parseJsonDocument(bytes, path);
  if (!parsed.ok) {
    diagnostics.push(...parsed.diagnostics);
    return undefined;
  }
  return parsed.value;
}

function collectMarkdownStrings(world: WorldDocument, locales: readonly LocaleDocument[]): string[] {
  const content = world.nodes.flatMap((node) => node.content.kind === 'literal' ? [node.content.text] : []);
  return [...content, ...locales.flatMap((locale) => Object.values(locale.strings))];
}

function extractAssetHashes(texts: readonly string[], diagnostics: Diagnostic[]): Set<string> {
  const hashes = new Set<string>();
  for (const text of texts) {
    let searchFrom = 0;
    while (true) {
      const marker = text.indexOf('[[asset:', searchFrom);
      if (marker < 0) break;
      const close = text.indexOf(']]', marker + 8);
      if (close < 0) {
        diagnostics.push(diagnostic('DS-MOD-037', 'Markdown contains an unterminated managed asset reference.', 'world.json'));
        break;
      }
      const body = text.slice(marker + 8, close);
      const match = /^sha256:([^|]+)(?:\|[^\]]*)?$/u.exec(body);
      if (!match || !/^[a-f0-9]{64}$/u.test(match[1] ?? '')) {
        diagnostics.push(diagnostic('DS-MOD-037', 'Markdown asset references must use a lowercase 64-digit SHA-256 ID.', 'world.json'));
      } else {
        hashes.add(match[1] ?? '');
      }
      searchFrom = close + 2;
    }
  }
  return hashes;
}

function isSupportedWave(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readTag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (readTag(0) !== 'RIFF' || readTag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) return false;
  let offset = 12;
  let formatChunk: { encoding: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number } | undefined;
  let dataLength: number | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return false;
    const tag = readTag(offset);
    const length = view.getUint32(offset + 4, true);
    const contentOffset = offset + 8;
    const end = contentOffset + length;
    if (end > bytes.byteLength) return false;
    if (tag === 'fmt ') {
      if (formatChunk || length < 16) return false;
      formatChunk = {
        encoding: view.getUint16(contentOffset, true),
        channels: view.getUint16(contentOffset + 2, true),
        sampleRate: view.getUint32(contentOffset + 4, true),
        byteRate: view.getUint32(contentOffset + 8, true),
        blockAlign: view.getUint16(contentOffset + 12, true),
        bitsPerSample: view.getUint16(contentOffset + 14, true),
      };
    } else if (tag === 'data') {
      if (dataLength !== undefined) return false;
      dataLength = length;
    }
    offset = end + (length % 2);
  }
  if (offset !== bytes.byteLength || !formatChunk || dataLength === undefined || dataLength === 0) return false;
  const { encoding, channels, sampleRate, byteRate, blockAlign, bitsPerSample } = formatChunk;
  const validFormat = encoding === 1
    ? [8, 16, 24, 32].includes(bitsPerSample)
    : encoding === 3 && bitsPerSample === 32;
  return validFormat && channels >= 1 && channels <= 2 && sampleRate >= 8_000 && sampleRate <= 192_000 &&
    blockAlign === channels * bitsPerSample / 8 && byteRate === sampleRate * blockAlign && dataLength % blockAlign === 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/** Compute the RFC 8785 fingerprint of the accepted playable files in a project snapshot. */
export function computeContentFingerprint(
  snapshot: ProjectVfsSnapshot,
  manifest: ProjectManifest,
  world: WorldDocument,
  locales: readonly LocaleDocument[],
): ContentFingerprintResult | ContentFingerprintFailure {
  const diagnostics: Diagnostic[] = [];
  const acceptedManifest = validateProjectManifest(manifest);
  const acceptedWorld = validateWorldDocument(world);
  diagnostics.push(...acceptedManifest.diagnostics, ...acceptedWorld.diagnostics);
  for (const locale of locales) diagnostics.push(...validateLocaleDocument(locale, `locales/${locale.locale}.json`).diagnostics);
  if (!acceptedManifest.value || !acceptedWorld.value || diagnostics.some((item) => item.severity === 'error')) return reportFailure(diagnostics);
  if (manifest.projectId !== snapshot.projectId) {
    diagnostics.push(diagnostic('DS-MOD-038', 'Manifest project ID does not match the accepted VFS snapshot.', 'project.json'));
  }

  const filesByPath = new Map<string, Array<{ mapPath: string; bytes: Uint8Array }>>();
  const pathKeys = new Map<string, string>();
  for (const [mapPath, file] of snapshot.files) {
    const pathError = validatePath(file.path);
    if (pathError) diagnostics.push(diagnostic('DS-MOD-039', `Project file path ${pathError}.`, file.path));
    if (mapPath !== file.path) diagnostics.push(diagnostic('DS-MOD-040', `VFS map key '${mapPath}' does not match file path '${file.path}'.`, file.path));
    const bucket = filesByPath.get(file.path) ?? [];
    bucket.push({ mapPath, bytes: file.bytes });
    filesByPath.set(file.path, bucket);
    const key = file.path.normalize('NFC').toLowerCase();
    const collidedPath = pathKeys.get(key);
    if (collidedPath !== undefined && collidedPath !== file.path) {
      diagnostics.push(diagnostic('DS-MOD-041', `Project paths '${collidedPath}' and '${file.path}' collide case-insensitively.`, file.path));
    } else {
      pathKeys.set(key, file.path);
    }
  }

  const getFile = (path: string, entityId?: string): Uint8Array | undefined => {
    const matches = filesByPath.get(path) ?? [];
    if (matches.length !== 1) {
      const caseMatch = pathKeys.get(path.normalize('NFC').toLowerCase());
      diagnostics.push(diagnostic(
        matches.length === 0 ? 'DS-MOD-042' : 'DS-MOD-041',
        matches.length === 0
          ? caseMatch === undefined ? `Required playable file '${path}' is missing.` : `Required path '${path}' conflicts with differently-cased file '${caseMatch}'.`
          : `Playable path '${path}' is represented more than once in the VFS.`,
        path,
        entityId,
      ));
      return undefined;
    }
    return matches[0]?.bytes;
  };

  const manifestBytes = getFile('project.json');
  const worldBytes = getFile('world.json');
  if (manifestBytes) {
    const parsed = getJson(manifestBytes, 'project.json', diagnostics);
    const fileManifest = parsed === undefined ? undefined : validateProjectManifest(parsed);
    if (fileManifest) diagnostics.push(...fileManifest.diagnostics);
    if (fileManifest?.value && !sameJson(fileManifest.value, acceptedManifest.value)) diagnostics.push(diagnostic('DS-MOD-043', 'The supplied manifest does not match project.json bytes in the VFS.', 'project.json'));
  }
  let fileWorld: WorldDocument | undefined;
  if (worldBytes) {
    const parsed = getJson(worldBytes, 'world.json', diagnostics);
    const fileWorldResult = parsed === undefined ? undefined : validateWorldDocument(parsed);
    if (fileWorldResult) diagnostics.push(...fileWorldResult.diagnostics);
    fileWorld = fileWorldResult?.value;
    if (fileWorld && !sameJson(fileWorld, acceptedWorld.value)) diagnostics.push(diagnostic('DS-MOD-043', 'The supplied world does not match world.json bytes in the VFS.', 'world.json'));
  }

  const localeByTag = new Map<string, LocaleDocument>();
  for (const locale of locales) {
    if (localeByTag.has(locale.locale)) diagnostics.push(diagnostic('DS-MOD-044', `Locale '${locale.locale}' is supplied more than once.`, `locales/${locale.locale}.json`));
    localeByTag.set(locale.locale, locale);
    const path = `locales/${locale.locale}.json`;
    const bytes = getFile(path);
    if (!bytes) continue;
    const parsed = getJson(bytes, path, diagnostics);
    const fileLocale = parsed === undefined ? undefined : validateLocaleDocument(parsed, path);
    if (fileLocale) diagnostics.push(...fileLocale.diagnostics);
    if (fileLocale?.value && !sameJson(fileLocale.value, locale)) diagnostics.push(diagnostic('DS-MOD-043', `The supplied locale '${locale.locale}' does not match its VFS bytes.`, path));
  }
  const acceptedLocales: LocaleDocument[] = [];
  for (const [path, entries] of filesByPath) {
    if (!path.startsWith('locales/') || !path.endsWith('.json')) continue;
    if (entries.length !== 1) continue;
    const parsed = getJson(entries[0]?.bytes ?? new Uint8Array(), path, diagnostics);
    const fileLocale = parsed === undefined ? undefined : validateLocaleDocument(parsed, path);
    if (fileLocale) diagnostics.push(...fileLocale.diagnostics);
    if (fileLocale?.value) {
      const supplied = localeByTag.get(fileLocale.value.locale);
      if (!supplied) diagnostics.push(diagnostic('DS-MOD-045', `Locale file '${path}' is not present in the supplied accepted locales.`, path));
      else if (path !== `locales/${fileLocale.value.locale}.json`) diagnostics.push(diagnostic('DS-MOD-046', `Locale document '${fileLocale.value.locale}' is stored at an unexpected path.`, path));
      acceptedLocales.push(fileLocale.value);
    }
  }
  for (const locale of locales) if (!acceptedLocales.some((accepted) => accepted.locale === locale.locale)) {
    diagnostics.push(diagnostic('DS-MOD-042', `Locale file 'locales/${locale.locale}.json' is missing or invalid.`, `locales/${locale.locale}.json`));
  }

  const playablePaths = new Set<string>(['project.json', 'world.json']);
  for (const path of filesByPath.keys()) if (path.startsWith('locales/')) playablePaths.add(path);
  const playableWorld = fileWorld ?? acceptedWorld.value;
  for (const script of playableWorld.scripts) playablePaths.add(script.path);
  const assetHashes = extractAssetHashes(collectMarkdownStrings(playableWorld, acceptedLocales), diagnostics);
  const typingSoundHashes = new Set<string>();
  for (const mapping of playableWorld.settings.typingSounds?.mappings ?? []) {
    assetHashes.add(mapping.assetHash);
    typingSoundHashes.add(mapping.assetHash);
  }
  if (playableWorld.settings.typingSounds?.fallback.kind === 'asset') {
    assetHashes.add(playableWorld.settings.typingSounds.fallback.assetHash);
    typingSoundHashes.add(playableWorld.settings.typingSounds.fallback.assetHash);
  }
  for (const hash of assetHashes) playablePaths.add(`assets/sha256/${hash}`);
  if (playableWorld.settings.playerStylePath) playablePaths.add(playableWorld.settings.playerStylePath);

  const fingerprintFiles: FingerprintedFile[] = [];
  for (const path of playablePaths) {
    const pathError = validatePath(path);
    if (pathError) {
      diagnostics.push(diagnostic('DS-MOD-039', `Referenced playable path ${pathError}.`, path));
      continue;
    }
    const bytes = getFile(path, path.startsWith('scripts/') ? playableWorld.scripts.find((script) => script.path === path)?.id : undefined);
    if (!bytes) continue;
    const fileHash = sha256(bytes);
    if (/^assets\/sha256\//u.test(path) && path.slice('assets/sha256/'.length) !== fileHash) {
      diagnostics.push(diagnostic('DS-MOD-047', `Managed asset bytes do not match content hash in '${path}'.`, path));
      continue;
    }
    const referencedHash = /^assets\/sha256\/([a-f0-9]{64})$/u.exec(path)?.[1];
    if (referencedHash && typingSoundHashes.has(referencedHash) && !isSupportedWave(bytes)) {
      diagnostics.push(diagnostic('DS-MOD-048', `Typing sound asset '${path}' is not a supported PCM or IEEE-float WAV file.`, path));
      continue;
    }
    fingerprintFiles.push({ path, byteLength: bytes.byteLength, sha256: fileHash });
  }

  if (diagnostics.some((item) => item.severity === 'error')) return reportFailure(diagnostics);
  fingerprintFiles.sort((left, right) => compareUtf8(left.path, right.path));
  const fingerprintInput = {
    algorithm: 'sha-256',
    files: fingerprintFiles,
    format: 'dungeon-scrivener-content-fingerprint-input',
    schemaVersion: 1,
    scope: 'playable-files-v1',
  };
  const digest = `sha256:${sha256(textEncoder.encode(canonicalJson(fingerprintInput)))}` as ContentFingerprint['digest'];
  const value: ContentFingerprint = {
    format: 'dungeon-scrivener-content-fingerprint',
    schemaVersion: 1,
    algorithm: 'sha-256',
    scope: 'playable-files-v1',
    digest,
    files: fingerprintFiles,
  };
  const result: ContentFingerprintResult = { ok: true, value };
  return result;
}
