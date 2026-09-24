import { strToU8, zipSync } from 'fflate';
import type {
  Diagnostic,
  DiagnosticReport,
  EmbeddedPortableGameData,
  ExportGameInput,
  ExportGameResult,
  ExporterApi,
  ResolvedMediaAsset,
} from '@dungeon-scrivener/model';

const GAME_DATA_MARKER = '<!--DUNGEON_SCRIVENER_EMBEDDED_GAME_DATA-->';
const GAME_DATA_OPEN = '<script type="application/json" id="dungeon-scrivener-game-data">';
const GAME_DATA_CLOSE = '</script>';
const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const ENGINE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
};

function error(code: string, message: string, path?: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...(path ? { path } : {}),
    blocks: ['export'],
  };
}

function failure(...diagnostics: Diagnostic[]): ExportGameResult {
  return {
    ok: false,
    diagnostics: { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics },
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!;
    const hasB = offset + 1 < bytes.length;
    const hasC = offset + 2 < bytes.length;
    const b = hasB ? bytes[offset + 1]! : 0;
    const c = hasC ? bytes[offset + 2]! : 0;
    result += alphabet[a >>> 2];
    result += alphabet[((a & 3) << 4) | (b >>> 4)];
    result += hasB ? alphabet[((b & 15) << 2) | (c >>> 6)] : '=';
    result += hasC ? alphabet[c & 63] : '=';
  }
  return result;
}

async function verifyAsset(asset: ResolvedMediaAsset): Promise<string | undefined> {
  const match = SHA256_PATTERN.exec(asset.assetId);
  if (!match || !(asset.bytes instanceof Uint8Array) || asset.byteLength !== asset.bytes.byteLength) {
    return 'Media asset metadata is malformed or its declared byte length does not match.';
  }
  if (!MIME_EXTENSIONS[asset.mediaType]) return `Unsupported media type '${asset.mediaType}'.`;
  if (!globalThis.crypto?.subtle) return 'SHA-256 verification is unavailable in this runtime.';
  const copy = new Uint8Array(asset.bytes.byteLength);
  copy.set(asset.bytes);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return hex === match[1] ? undefined : 'Media bytes do not match their declared content hash.';
}

function validateScriptBundle(input: ExportGameInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const bundle = input.scripts;
  if (!bundle || bundle.format !== 'dungeon-scrivener-compiled-script-bundle' || bundle.schemaVersion !== 1 || !Array.isArray(bundle.scripts)) {
    return [error('DS-EXPORT-SCRIPT', 'Compiled script bundle is malformed.')];
  }
  const declared = new Map(input.world.scripts.map(script => [script.id, script]));
  const compiled = new Map<string, number>();
  for (const script of bundle.scripts) {
    compiled.set(script.scriptId, (compiled.get(script.scriptId) ?? 0) + 1);
  }
  for (const [id, reference] of declared) {
    const matches = bundle.scripts.filter(script => script.scriptId === id);
    if (matches.length !== 1) {
      diagnostics.push(error('DS-EXPORT-SCRIPT', `Declared script '${id}' must have exactly one compiled IR.`, reference.path));
      continue;
    }
    const ir = matches[0]!;
    if (ir.sourcePath !== reference.path || ir.sourceLanguage !== reference.language || ir.entrypoint !== reference.entrypoint) {
      diagnostics.push(error('DS-EXPORT-SCRIPT', `Compiled IR metadata does not match declared script '${id}'.`, reference.path));
    }
  }
  for (const [id, count] of compiled) {
    if (!declared.has(id)) diagnostics.push(error('DS-EXPORT-SCRIPT', `Compiled IR '${id}' is not declared by the world.`));
    else if (count !== 1) diagnostics.push(error('DS-EXPORT-SCRIPT', `Compiled script '${id}' occurs ${count} times in the bundle.`));
  }
  return diagnostics;
}

function injectGameData(shell: string, data: EmbeddedPortableGameData): string | undefined {
  if (shell.split(GAME_DATA_MARKER).length - 1 !== 1) return undefined;
  return shell.replace(GAME_DATA_MARKER, `${GAME_DATA_OPEN}${safeJson(data)}${GAME_DATA_CLOSE}`);
}

function hasExternalDocumentDependency(html: string): boolean {
  return /<script\b[^>]*\bsrc\s*=|<script\b[^>]*\btype\s*=\s*["']module["']|<link\b[^>]*\brel\s*=\s*["'](?:stylesheet|modulepreload|preload)["'][^>]*\bhref\s*=/iu.test(html);
}

function addBootstrap(html: string): string | undefined {
  const closingBody = html.toLowerCase().lastIndexOf('</body>');
  if (closingBody < 0) return undefined;
  const bootstrap = `<script>(function(){\n  'use strict';\n  var bundle=window.DungeonScrivenerPlayer;\n  var runtime=bundle&&(bundle.portablePlayerRuntime||bundle);\n  if(!runtime||!runtime.startFromEmbeddedData)throw new Error('Portable player runtime is unavailable.');\n  var data=JSON.parse(document.getElementById('dungeon-scrivener-game-data').textContent||'null');\n  if(!data||data.format!=='dungeon-scrivener-embedded-game-data'||!Array.isArray(data.media)||!data.scripts||!data.saveCompatibility)throw new Error('Embedded game data is malformed or incomplete.');\n  var assets=new Map();\n  data.media.forEach(function(item){var raw=atob(item.base64),bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);assets.set(item.assetId,{bytes:bytes,mediaType:item.mediaType,byteLength:item.byteLength});});\n  var mediaAssets={resolveAsset:function(id){var asset=assets.get(id);return asset?{ok:true,asset:Object.assign({assetId:id},asset)}:{ok:false,diagnostic:{code:'DS-MEDIA-MISSING',severity:'error',message:'The referenced game asset is missing.',blocks:['play']}};}};\n  runtime.startFromEmbeddedData(document.getElementById('player-root'),{manifest:data.manifest,world:data.world,locales:data.locales,compiledScripts:data.scripts,sessionStart:{wallClockEpochMilliseconds:Date.now(),visibility:document.visibilityState==='hidden'?'hidden':'visible',focused:document.hasFocus()},saveCompatibility:data.saveCompatibility},{factory:runtime.engine,host:{mediaAssets:mediaAssets},themeCss:data.authorStyle.cssText,saveCompatibility:data.saveCompatibility});\n})();</script>`;
  return `${html.slice(0, closingBody)}${bootstrap}${html.slice(closingBody)}`;
}

/** Generate a self-contained direct-open game archive from validated package artifacts. */
export async function exportGame(input: ExportGameInput): Promise<ExportGameResult> {
  const diagnostics: Diagnostic[] = [];
  if (!input || input.manifest?.format !== 'dungeon-scrivener-project' || input.manifest.schemaVersion !== 1 ||
      input.world?.format !== 'dungeon-scrivener-world' || input.world.schemaVersion !== 1 ||
      input.manifest.projectId.length === 0 || input.world.entryNodeId.length === 0) {
    return failure(error('DS-EXPORT-INPUT', 'Manifest or world document is malformed.'));
  }
  if (!Array.isArray(input.locales) || !Array.isArray(input.media) ||
      input.authorStyle?.cssText === undefined || input.player?.format !== 'dungeon-scrivener-portable-player' ||
      input.player.schemaVersion !== 1 || !(input.player.indexHtml instanceof Uint8Array) ||
      !ENGINE_VERSION_PATTERN.test(input.player.engineVersion)) {
    return failure(error('DS-EXPORT-INPUT', 'Portable export inputs do not match the v1 contract.'));
  }
  const fingerprint = input.acceptedContentFingerprint;
  if (fingerprint?.format !== 'dungeon-scrivener-content-fingerprint' || fingerprint.schemaVersion !== 1 ||
      fingerprint.algorithm !== 'sha-256' || fingerprint.scope !== 'playable-files-v1' ||
      !SHA256_PATTERN.test(fingerprint.digest) || !Array.isArray(fingerprint.files) || fingerprint.files.length < 2) {
    return failure(error('DS-EXPORT-FINGERPRINT', 'The accepted playable-content fingerprint is malformed.'));
  }
  diagnostics.push(...validateScriptBundle(input));
  const assets = new Map<string, ResolvedMediaAsset>();
  for (const asset of input.media) {
    const assetProblem = await verifyAsset(asset);
    if (assetProblem) {
      diagnostics.push(error('DS-EXPORT-ASSET', assetProblem, asset.assetId));
      continue;
    }
    if (assets.has(asset.assetId)) {
      diagnostics.push(error('DS-EXPORT-ASSET', `Duplicate media asset '${asset.assetId}'.`));
      continue;
    }
    assets.set(asset.assetId, asset);
  }
  if (diagnostics.length > 0) return failure(...diagnostics);

  let shell: string;
  try {
    shell = new TextDecoder('utf-8', { fatal: true }).decode(input.player.indexHtml);
  } catch {
    return failure(error('DS-EXPORT-PLAYER', 'Portable player HTML is not valid UTF-8.'));
  }
  if (!/^<!doctype html>/iu.test(shell.trimStart()) || !/id="player-root"/u.test(shell)) {
    return failure(error('DS-EXPORT-PLAYER', 'Portable player artifact must be a standalone HTML page with a player-root mount point.'));
  }
  if (hasExternalDocumentDependency(shell)) {
    return failure(error('DS-EXPORT-PLAYER', 'Portable player artifact must inline its runtime and styles without external scripts, modules, or stylesheets.'));
  }

  const embeddedAssets = [...assets.values()].map(asset => ({
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    base64: toBase64(asset.bytes),
    path: `assets/${asset.assetId.slice('sha256:'.length)}.${MIME_EXTENSIONS[asset.mediaType]}`,
  }));
  const data: EmbeddedPortableGameData = {
    format: 'dungeon-scrivener-embedded-game-data',
    schemaVersion: 1,
    manifest: input.manifest,
    world: input.world,
    locales: input.locales,
    scripts: input.scripts,
    authorStyle: input.authorStyle,
    media: embeddedAssets,
    saveCompatibility: {
      manifest: { projectId: input.manifest.projectId, gameVersion: input.manifest.gameVersion },
      engineVersion: input.player.engineVersion,
      contentFingerprint: fingerprint.digest,
    },
  };
  let html = injectGameData(shell, data);
  if (!html) return failure(error('DS-EXPORT-PLAYER', 'Portable player shell must contain exactly one embedded-game-data marker.'));
  html = addBootstrap(html) ?? '';
  if (!html) return failure(error('DS-EXPORT-PLAYER', 'Portable player shell must contain a closing body element.'));

  const zipEntries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  zipEntries['index.html'] = strToU8(html);
  for (const asset of assets.values()) {
    const digest = asset.assetId.slice('sha256:'.length);
    const extension = MIME_EXTENSIONS[asset.mediaType]!;
    zipEntries[`assets/${digest}.${extension}`] = new Uint8Array(asset.bytes);
  }
  try {
    return { ok: true, zipBytes: zipSync(zipEntries, { level: 6, mtime: new Date(1980, 0, 1) }) };
  } catch (cause) {
    return failure(error('DS-EXPORT-ZIP', `Could not create the portable game ZIP: ${cause instanceof Error ? cause.message : String(cause)}`));
  }
}

export const exporterApi: ExporterApi = { exportGame };
