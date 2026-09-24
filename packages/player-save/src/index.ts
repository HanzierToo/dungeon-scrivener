import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { strToU8, Unzip, UnzipInflate, UnzipPassThrough, zipSync } from 'fflate';
import type {
  Diagnostic, DiagnosticReport, PlayerSaveArchive, PlayerSaveApi, SaveSlotPolicy,
  PlayerSaveDecodeResult, PlayerSaveEncodeResult, SaveCompatibilityMismatch, SaveCompatibilityResult,
  SaveCompatibilityTarget, SessionSnapshot,
} from '@dungeon-scrivener/model';
import commonSchema from '../../../docs/contracts/schemas/common.schema.json';
import playerSaveSchema from '../../../docs/contracts/schemas/player-save.schema.json';

export const PLAYER_SAVE_LIMIT_BYTES = 8 * 1024 * 1024;
export const PLAYER_SAVE_JSON_PATH = 'player-save.json';
const policyIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(commonSchema);
const validateSave = ajv.compile(playerSaveSchema);
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function diagnostic(code: string, message: string, path?: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...(path === undefined ? {} : { path }),
    blocks: ['play'],
  };
}

function report(diagnostics: readonly Diagnostic[]): DiagnosticReport {
  return { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics };
}

function failure(operation: 'encode' | 'decode', ...diagnostics: Diagnostic[]): PlayerSaveEncodeResult | PlayerSaveDecodeResult {
  return { ok: false, operation, diagnostics: report(diagnostics) } as PlayerSaveEncodeResult | PlayerSaveDecodeResult;
}

function validateArchive(value: unknown): value is PlayerSaveArchive {
  return validateSave(value) as boolean;
}

function validateInternalReferences(save: PlayerSaveArchive): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const stacks = new Map(save.session.inventory.map((stack) => [stack.id, stack]));
  if (stacks.size !== save.session.inventory.length) {
    diagnostics.push(diagnostic('DS-SAVE-004', 'Inventory stack IDs must be unique within a player save.', '/session/inventory'));
  }
  for (const stack of save.session.inventory) {
    if (stack.containerStackId !== undefined && !stacks.has(stack.containerStackId)) {
      diagnostics.push(diagnostic('DS-SAVE-004', `Inventory stack ${stack.id} refers to missing container stack ${stack.containerStackId}.`, '/session/inventory'));
    }
    const seen = new Set([stack.id]);
    let parentId = stack.containerStackId;
    while (parentId !== undefined) {
      if (seen.has(parentId)) {
        diagnostics.push(diagnostic('DS-SAVE-004', `Inventory container references contain a cycle at stack ${parentId}.`, '/session/inventory'));
        break;
      }
      seen.add(parentId);
      parentId = stacks.get(parentId)?.containerStackId;
    }
  }
  return diagnostics;
}

/** Serialize a complete save as a one-entry portable ZIP. No game source is loaded or evaluated. */
export async function encodePlayerSave(save: PlayerSaveArchive): Promise<PlayerSaveEncodeResult> {
  if (!validateArchive(save)) {
    const errors = (validateSave.errors ?? []).map((error) => diagnostic(
      'DS-SAVE-001',
      `${error.instancePath || '/'} ${error.message ?? 'does not match the player-save schema.'}`,
      error.instancePath || '/',
    ));
    return failure('encode', ...(errors.length > 0 ? errors : [diagnostic('DS-SAVE-001', 'Player save does not match the player-save schema.')])) as PlayerSaveEncodeResult;
  }
  const referenceErrors = validateInternalReferences(save);
  if (referenceErrors.length > 0) return failure('encode', ...referenceErrors) as PlayerSaveEncodeResult;

  let json: string;
  try {
    json = JSON.stringify(save);
  } catch {
    return failure('encode', diagnostic('DS-SAVE-002', 'Player save could not be serialized as JSON.')) as PlayerSaveEncodeResult;
  }
  const jsonBytes = strToU8(json);
  if (jsonBytes.byteLength > PLAYER_SAVE_LIMIT_BYTES) {
    return failure('encode', diagnostic('DS-SAVE-003', 'Expanded player-save JSON exceeds the 8 MiB limit.')) as PlayerSaveEncodeResult;
  }
  try {
    const bytes = zipSync({ [PLAYER_SAVE_JSON_PATH]: jsonBytes }, { level: 6 });
    if (bytes.byteLength > PLAYER_SAVE_LIMIT_BYTES) {
      return failure('encode', diagnostic('DS-SAVE-003', 'Player-save ZIP exceeds the 8 MiB limit.')) as PlayerSaveEncodeResult;
    }
    return { ok: true, bytes };
  } catch {
    return failure('encode', diagnostic('DS-SAVE-002', 'Player-save ZIP could not be created.')) as PlayerSaveEncodeResult;
  }
}

/** Decode and validate a player save without changing any active game session. */
export async function decodePlayerSave(bytes: Uint8Array): Promise<PlayerSaveDecodeResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PLAYER_SAVE_LIMIT_BYTES) {
    return failure('decode', diagnostic('DS-SAVE-005', 'Player-save archive is empty or exceeds the 8 MiB limit.')) as PlayerSaveDecodeResult;
  }
  const files = new Map<string, Uint8Array>();
  let activePath: string | undefined;
  let activeChunks: Uint8Array[] = [];
  let expandedBytes = 0;
  let streamError = false;
  try {
    const unzip = new Unzip((file) => {
      if (files.has(file.name) || activePath !== undefined || file.name !== PLAYER_SAVE_JSON_PATH) {
        streamError = true;
        return;
      }
      activePath = file.name;
      activeChunks = [];
      file.ondata = (error, chunk, final) => {
        if (error) {
          streamError = true;
          return;
        }
        expandedBytes += chunk.byteLength;
        if (expandedBytes > PLAYER_SAVE_LIMIT_BYTES) {
          streamError = true;
          return;
        }
        activeChunks.push(chunk);
        if (final) {
          const content = new Uint8Array(expandedBytes);
          let offset = 0;
          for (const part of activeChunks) {
            content.set(part, offset);
            offset += part.byteLength;
          }
          files.set(file.name, content);
          activePath = undefined;
          activeChunks = [];
        }
      };
      file.start();
    });
    unzip.register(UnzipPassThrough);
    unzip.register(UnzipInflate);
    unzip.push(bytes, true);
  } catch {
    return failure('decode', diagnostic('DS-SAVE-005', 'Player-save ZIP is malformed or unsupported.')) as PlayerSaveDecodeResult;
  }
  if (streamError || activePath !== undefined || files.size !== 1 || !files.has(PLAYER_SAVE_JSON_PATH)) {
    return failure('decode', diagnostic('DS-SAVE-005', `Player-save ZIP must contain exactly ${PLAYER_SAVE_JSON_PATH}.`)) as PlayerSaveDecodeResult;
  }
  const jsonBytes = files.get(PLAYER_SAVE_JSON_PATH)!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(jsonBytes));
  } catch {
    return failure('decode', diagnostic('DS-SAVE-006', 'Player-save JSON is malformed or is not valid UTF-8.')) as PlayerSaveDecodeResult;
  }
  if (!validateArchive(parsed)) {
    const errors = (validateSave.errors ?? []).map((error) => diagnostic(
      'DS-SAVE-007',
      `${error.instancePath || '/'} ${error.message ?? 'does not match the player-save schema.'}`,
      error.instancePath || '/',
    ));
    return failure('decode', ...(errors.length > 0 ? errors : [diagnostic('DS-SAVE-007', 'Player-save data does not match the v1 schema.')])) as PlayerSaveDecodeResult;
  }
  const referenceErrors = validateInternalReferences(parsed);
  if (referenceErrors.length > 0) return failure('decode', ...referenceErrors) as PlayerSaveDecodeResult;
  return { ok: true, save: parsed };
}

export function checkSaveCompatibility(save: PlayerSaveArchive, target: SaveCompatibilityTarget): SaveCompatibilityResult {
  const mismatches: ('projectId' | 'gameVersion' | 'engineVersion' | 'contentFingerprint')[] = [];
  if (save.projectId !== target.manifest.projectId) mismatches.push('projectId');
  if (save.gameVersion !== target.manifest.gameVersion) mismatches.push('gameVersion');
  if (save.engineVersion !== target.engineVersion) mismatches.push('engineVersion');
  if (save.contentFingerprint !== target.contentFingerprint) mismatches.push('contentFingerprint');
  return mismatches.length === 0 ? { compatible: true, mismatches: [] } : { compatible: false, mismatches: mismatches as [typeof mismatches[number], ...typeof mismatches[number][]] };
}

/** Reconstitute the engine's immutable runtime snapshot after decode and compatibility checks. */
export function restoreSessionSnapshot(save: PlayerSaveArchive): SessionSnapshot {
  return { ...save.session, projectId: save.projectId };
}

export type SavePolicyCheck =
  | { readonly ok: true; readonly policy: SaveSlotPolicy }
  | { readonly ok: false; readonly diagnostics: DiagnosticReport };

/** Validate the exact SaveSlotPolicy fields consumed from world.json. */
export function validateSavePolicy(policy: SaveSlotPolicy): SavePolicyCheck {
  if (typeof policy !== 'object' || policy === null || typeof policy.enabled !== 'boolean') {
    return { ok: false, diagnostics: report([diagnostic('DS-SAVE-008', 'Save policy must be an object with the documented fields.', '/savePolicy')]) };
  }
  const diagnostics: Diagnostic[] = [];
  const checkpointNodeIds = Array.isArray(policy.checkpointNodeIds) ? policy.checkpointNodeIds : [];
  if (policy.checkpointNodeIds !== undefined && !Array.isArray(policy.checkpointNodeIds)) {
    diagnostics.push(diagnostic('DS-SAVE-008', 'checkpointNodeIds must be an array.', '/savePolicy/checkpointNodeIds'));
  }
  if (!Number.isInteger(policy.slotCount) || policy.slotCount < 0 || policy.slotCount > 10) {
    diagnostics.push(diagnostic('DS-SAVE-008', 'Save policy slotCount must be an integer from 0 through 10.', '/savePolicy/slotCount'));
  }
  if (policy.enabled && policy.slotCount < 1) diagnostics.push(diagnostic('DS-SAVE-008', 'Enabled save policy must provide at least one UI slot.', '/savePolicy/slotCount'));
  if (!policy.enabled && policy.slotCount !== 0) diagnostics.push(diagnostic('DS-SAVE-008', 'Disabled save policy must set slotCount to zero.', '/savePolicy/slotCount'));
  if (policy.allowedLocation !== 'anywhere' && policy.allowedLocation !== 'checkpoint') {
    diagnostics.push(diagnostic('DS-SAVE-008', 'Save policy allowedLocation must be anywhere or checkpoint.', '/savePolicy/allowedLocation'));
  }
  if (policy.allowedLocation === 'checkpoint' && checkpointNodeIds.length === 0) {
    diagnostics.push(diagnostic('DS-SAVE-008', 'Checkpoint save policy must name at least one checkpoint node.', '/savePolicy/checkpointNodeIds'));
  }
  if (policy.allowedLocation === 'anywhere' && checkpointNodeIds.length > 0) {
    diagnostics.push(diagnostic('DS-SAVE-008', 'checkpointNodeIds must be empty when allowedLocation is anywhere.', '/savePolicy/checkpointNodeIds'));
  }
  if (new Set(checkpointNodeIds).size !== checkpointNodeIds.length || checkpointNodeIds.some((id) => !policyIdPattern.test(id))) {
    diagnostics.push(diagnostic('DS-SAVE-008', 'Checkpoint node IDs must be unique stable IDs.', '/savePolicy/checkpointNodeIds'));
  }
  return diagnostics.length === 0 ? { ok: true, policy } : { ok: false, diagnostics: report(diagnostics) };
}

export interface SaveSlotChoice {
  readonly slotId: string;
  readonly label: string;
}

/** Return no controls for disabled saves; slot count is an in-app UI limit only. */
export function getSaveSlotChoices(policy: SaveSlotPolicy): readonly SaveSlotChoice[] {
  const checked = validateSavePolicy(policy);
  if (!checked.ok || !policy.enabled) return [];
  return Array.from({ length: policy.slotCount }, (_, index) => ({
    slotId: `slot-${index + 1}`,
    label: policy.slotCount === 1 ? 'Save' : `Save ${index + 1}`,
  }));
}

export type SaveLocationCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'disabled' | 'invalid-policy' | 'checkpoint-required' };

export function canSaveAtNode(policy: SaveSlotPolicy, currentNodeId: string): SaveLocationCheck {
  const checked = validateSavePolicy(policy);
  if (!checked.ok) return { allowed: false, reason: 'invalid-policy' };
  if (!policy.enabled) return { allowed: false, reason: 'disabled' };
  if (policy.allowedLocation === 'checkpoint' && !(policy.checkpointNodeIds ?? []).includes(currentNodeId)) {
    return { allowed: false, reason: 'checkpoint-required' };
  }
  return { allowed: true };
}

export type PlayerSaveImportResult =
  | { readonly ok: true; readonly save: PlayerSaveArchive; readonly snapshot: SessionSnapshot }
  | { readonly ok: false; readonly operation: 'import'; readonly reason: 'decode'; readonly diagnostics: DiagnosticReport }
  | { readonly ok: false; readonly operation: 'import'; readonly reason: 'incompatible'; readonly mismatches: readonly SaveCompatibilityMismatch[]; readonly message: string };

/** Decode first, then check every compatibility field before exposing a restorable snapshot. */
export async function importPlayerSave(bytes: Uint8Array, target: SaveCompatibilityTarget): Promise<PlayerSaveImportResult> {
  const decoded = await decodePlayerSave(bytes);
  if (!decoded.ok) return { ok: false, operation: 'import', reason: 'decode', diagnostics: decoded.diagnostics };
  const compatibility = checkSaveCompatibility(decoded.save, target);
  if (!compatibility.compatible) {
    return {
      ok: false,
      operation: 'import',
      reason: 'incompatible',
      mismatches: compatibility.mismatches,
      message: `This save does not match the current game (${compatibility.mismatches.join(', ')}).`,
    };
  }
  return { ok: true, save: decoded.save, snapshot: restoreSessionSnapshot(decoded.save) };
}

/** Download a permitted save only in response to the caller's explicit user action. */
export async function downloadPlayerSave(
  save: PlayerSaveArchive,
  policy: SaveSlotPolicy,
  currentNodeId: string,
  filename = 'dungeon-scrivener-save.zip',
  browser: Pick<typeof globalThis, 'Blob' | 'URL' | 'document'> = globalThis,
): Promise<PlayerSaveEncodeResult> {
  const location = canSaveAtNode(policy, currentNodeId);
  if (!location.allowed) {
    const message = location.reason === 'disabled'
      ? 'Player saves are disabled for this game.'
      : location.reason === 'checkpoint-required'
        ? 'A player save can only be downloaded at an authored checkpoint.'
        : 'The game has an invalid player-save policy.';
    return failure('encode', diagnostic('DS-SAVE-008', message, '/savePolicy')) as PlayerSaveEncodeResult;
  }
  if (!getSaveSlotChoices(policy).some((slot) => slot.slotId === save.slotId)) {
    return failure('encode', diagnostic('DS-SAVE-008', 'The selected save slot is not available under this game policy.', '/slotId')) as PlayerSaveEncodeResult;
  }
  const encoded = await encodePlayerSave(save);
  if (!encoded.ok) return encoded;
  try {
    const blobBytes = encoded.bytes.slice().buffer as ArrayBuffer;
    const blob = new browser.Blob([blobBytes], { type: 'application/zip' });
    const objectUrl = browser.URL.createObjectURL(blob);
    const anchor = browser.document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    browser.document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      browser.URL.revokeObjectURL(objectUrl);
    }
    return encoded;
  } catch {
    return failure('encode', diagnostic('DS-SAVE-009', 'The browser could not start the player-save download.')) as PlayerSaveEncodeResult;
  }
}

/** Adapter for a user-selected save file in hosted play. */
export async function importHostedSaveFile(file: Pick<File, 'arrayBuffer'>, target: SaveCompatibilityTarget): Promise<PlayerSaveImportResult> {
  try {
    return await importPlayerSave(new Uint8Array(await file.arrayBuffer()), target);
  } catch {
    return { ok: false, operation: 'import', reason: 'decode', diagnostics: report([diagnostic('DS-SAVE-005', 'The selected player-save file could not be read.')]) };
  }
}

/** Adapter for a user-selected file in the portable game; it shares the ZIP codec. */
export async function importPortableSaveFile(file: Pick<File, 'arrayBuffer'>, target: SaveCompatibilityTarget): Promise<PlayerSaveImportResult> {
  return importHostedSaveFile(file, target);
}

export interface PlayerSaveCodecAdapter {
  readonly encode: typeof encodePlayerSave;
  readonly decode: typeof decodePlayerSave;
  readonly importFile: typeof importHostedSaveFile;
}

/** Hosted and portable games intentionally consume and emit the same ZIP codec. */
export const hostedSaveCodecAdapter: PlayerSaveCodecAdapter = {
  encode: encodePlayerSave,
  decode: decodePlayerSave,
  importFile: importHostedSaveFile,
};

export const portableSaveCodecAdapter: PlayerSaveCodecAdapter = {
  encode: encodePlayerSave,
  decode: decodePlayerSave,
  importFile: importPortableSaveFile,
};

/** Make the codec and compatibility functions available through the contract API shape. */
export const playerSaveApi: PlayerSaveApi = { encodePlayerSave, decodePlayerSave, checkSaveCompatibility };
