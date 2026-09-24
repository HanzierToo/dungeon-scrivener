import type {
  Diagnostic,
  DiagnosticReport,
  ContentFingerprintFailure,
  LocaleDocument,
  MediaAssetApi,
  ProjectManifest,
  SaveCompatibilityMismatch,
  SaveCompatibilityResult,
  TextSource,
  WorldDocument,
} from '@dungeon-scrivener/model';
import { validateProject } from '@dungeon-scrivener/model';
import { renderMarkdown } from '@dungeon-scrivener/markdown';
import { resolveText } from '@dungeon-scrivener/i18n';

export interface CollectDiagnosticsRequest {
  readonly manifest: unknown;
  readonly world: unknown;
  readonly locales?: Readonly<Record<string, unknown>>;
  readonly filePaths?: ReadonlySet<string>;
  readonly assetHashes?: ReadonlySet<string>;
  readonly assets?: MediaAssetApi;
  readonly additionalDiagnostics?: readonly Diagnostic[];
  /** Owner-package reports, such as script compilation/execution and engine transitions. */
  readonly diagnosticReports?: readonly DiagnosticReport[];
  readonly fingerprintFailure?: ContentFingerprintFailure;
  readonly saveCompatibility?: SaveCompatibilityResult;
}

export interface AcknowledgementStatus {
  readonly required: boolean;
  readonly actions: readonly ('save-project' | 'play' | 'export')[];
  readonly acknowledged: boolean;
  readonly pendingActions: readonly ('save-project' | 'play' | 'export')[];
}

/** Aggregate owner-package diagnostics while retaining their source locations and messages. */
export function collectDiagnostics(request: CollectDiagnosticsRequest): DiagnosticReport {
  const validation = validateProject({
    manifest: request.manifest,
    world: request.world,
    ...(request.locales ? { locales: request.locales } : {}),
    ...(request.filePaths ? { filePaths: request.filePaths } : {}),
    ...(request.assetHashes ? { assetHashes: request.assetHashes } : {}),
  });
  const diagnostics = [
    ...validation.diagnostics,
    ...(request.additionalDiagnostics ?? []),
    ...(request.diagnosticReports ?? []).flatMap((report) => report.diagnostics),
    ...(request.fingerprintFailure?.diagnostics.diagnostics ?? []),
    ...compatibilityDiagnostics(request.saveCompatibility),
  ];
  if (validation.value) {
    const { manifest, world, locales } = validation.value;
    const localeList = Object.values(locales);
    for (const node of world.nodes) {
      diagnostics.push(...renderMarkdown({
        source: textFor(node.content, localeList, manifest, node.id),
        path: 'world.json', world, locales: localeList,
        defaultLocale: manifest.defaultLocale,
        ...(request.assets ? { assets: request.assets } : {}),
      }).diagnostics);
      // Locale lookup reports missing keys while the Markdown renderer resolves presentation text.
      resolveAuthoredText(node.content, localeList, manifest, node.id, diagnostics);
    }
    collectWorldTextDiagnostics(world, localeList, manifest, diagnostics);
  }
  const normalized = deduplicate(diagnostics).map((item) => withAcknowledgementPolicy(item));
  return Object.freeze({
    format: 'dungeon-scrivener-diagnostics',
    schemaVersion: 1,
    diagnostics: Object.freeze(normalized),
  });
}

/** Return actions whose warning acknowledgment is still outstanding. */
export function getAcknowledgementStatus(
  diagnostics: readonly Diagnostic[],
  action: 'save-project' | 'play' | 'export',
  acknowledgedCodes: ReadonlySet<string> = new Set(),
): AcknowledgementStatus {
  const relevant = diagnostics.filter((item) =>
    item.severity === 'warning' && item.acknowledgementRequired?.includes(action));
  const pending = relevant.filter((item) => !acknowledgedCodes.has(item.code));
  return {
    required: relevant.length > 0,
    actions: [...new Set(relevant.flatMap((item) => item.acknowledgementRequired ?? []))],
    acknowledged: pending.length === 0,
    pendingActions: pending.length > 0 ? [action] : [],
  };
}

/** Fatal play-start diagnostics are distinct from warnings requiring acknowledgment. */
export function getPlayStartBlockers(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return diagnostics.filter((item) => item.severity === 'fatal' || item.blocks?.includes('play'));
}

export interface PlayStartFailureScreen {
  readonly title: 'Unable to start this game';
  readonly summary: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Build a nonblank, source-linked failure view when validation prevents play. */
export function createPlayStartFailureScreen(diagnostics: readonly Diagnostic[]): PlayStartFailureScreen | undefined {
  const blockers = getPlayStartBlockers(diagnostics);
  if (blockers.length === 0) return undefined;
  return {
    title: 'Unable to start this game',
    summary: blockers[0]?.message ?? 'The game has a fatal validation error.',
    diagnostics: blockers,
  };
}

/** Project ZIP saves remain available for recovery even when game play/export is invalid. */
export function canSaveProjectZip(_diagnostics: readonly Diagnostic[]): true {
  return true;
}

/** Recovery autosave never waits for a warning acknowledgment. */
export function requiresWarningAcknowledgement(
  diagnostics: readonly Diagnostic[],
  action: 'save-project' | 'play' | 'export' | 'recovery-autosave',
): boolean {
  return action !== 'recovery-autosave'
    && diagnostics.some((item) => item.severity === 'warning' && item.acknowledgementRequired?.includes(action));
}

function compatibilityDiagnostics(result: SaveCompatibilityResult | undefined): Diagnostic[] {
  if (!result || result.compatible) return [];
  return result.mismatches.map((mismatch) => ({
    code: 'DS-SAVE-005',
    severity: 'error',
    message: saveMismatchMessage(mismatch),
    blocks: ['play'],
    suggestedFix: 'Load a save created for this project, game version, engine version, and playable-content fingerprint.',
  }));
}

function saveMismatchMessage(mismatch: SaveCompatibilityMismatch): string {
  switch (mismatch) {
    case 'projectId': return 'The player save belongs to a different project.';
    case 'gameVersion': return 'The player save was created for a different game version.';
    case 'engineVersion': return 'The player save was created for a different engine version.';
    case 'contentFingerprint': return 'The player save does not match this playable-content fingerprint.';
  }
}

function textFor(source: TextSource, locales: readonly LocaleDocument[], manifest: ProjectManifest, nodeId: string): string {
  return source.kind === 'literal' ? source.text : resolveText({
    source, locales, defaultLocale: manifest.defaultLocale, sourceNodeId: nodeId,
  }).text;
}

function resolveAuthoredText(
  source: TextSource,
  locales: readonly LocaleDocument[],
  manifest: ProjectManifest,
  entityId: string,
  diagnostics: Diagnostic[],
): void {
  diagnostics.push(...resolveText({ source, locales, defaultLocale: manifest.defaultLocale, sourceNodeId: entityId }).diagnostics);
}

function collectWorldTextDiagnostics(
  world: WorldDocument,
  locales: readonly LocaleDocument[],
  manifest: ProjectManifest,
  diagnostics: Diagnostic[],
): void {
  const visit = (value: unknown, entityId?: string): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item, entityId); return; }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    const owner = typeof record['id'] === 'string' ? record['id'] : entityId;
    if ((record['kind'] === 'literal' || record['kind'] === 'locale-key') && typeof record['kind'] === 'string') {
      resolveAuthoredText(record as unknown as TextSource, locales, manifest, owner ?? 'world', diagnostics);
      return;
    }
    for (const item of Object.values(record)) visit(item, owner);
  };
  // Node content is parsed as Markdown above; skip duplicate locale resolution for content.
  for (const node of world.nodes) {
    for (const [key, value] of Object.entries(node)) if (key !== 'content') visit(value, node.id);
  }
  const { nodes: _nodes, ...worldRemainder } = world;
  visit(worldRemainder);
}

function deduplicate(items: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const item of items) {
    const span = item.sourceSpan;
    const key = [item.code, item.path ?? '', item.entityId ?? '', span?.startLine ?? '', span?.startColumn ?? '', span?.endLine ?? '', span?.endColumn ?? ''].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function withAcknowledgementPolicy(item: Diagnostic): Diagnostic {
  if (item.severity !== 'warning' || item.acknowledgementRequired !== undefined) return item;
  return { ...item, acknowledgementRequired: ['save-project', 'play', 'export'] };
}
