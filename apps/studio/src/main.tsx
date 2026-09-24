import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprenticeGraph } from '@dungeon-scrivener/apprentice';
import { PlaytestDebugger } from '@dungeon-scrivener/debugger';
import { collectDiagnostics, getAcknowledgementStatus } from '@dungeon-scrivener/diagnostics';
import { createGameEngine } from '@dungeon-scrivener/engine';
import { exportGame } from '@dungeon-scrivener/exporter';
import { createMediaAssetCatalog } from '@dungeon-scrivener/media';
import { computeContentFingerprint, validateProject, validateProjectManifest, type CompiledScriptBundle, type Diagnostic, type LocaleDocument, type PlayerSaveArchive, type ProjectFile, type ProjectManifest, type ProjectVfsSnapshot, type SaveCompatibilityTarget, type SessionSnapshot, type WorldDocument } from '@dungeon-scrivener/model';
import { clearRecovery, loadRecovery, saveRecovery } from '@dungeon-scrivener/persistence';
import { readProjectFile, readProjectZip, writeProjectZip, createSnapshot } from '@dungeon-scrivener/vfs';
import { SageMode, SageWorkspace } from '@dungeon-scrivener/sage';
import { EnginePlayer, isOfflineSafeTheme, PORTABLE_PLAYER_ENGINE_VERSION } from '@dungeon-scrivener/player';
import { downloadPlayerSave, getSaveSlotChoices, importHostedSaveFile } from '@dungeon-scrivener/player-save';
import { getPortablePlayerArtifact } from '@dungeon-scrivener/player/portable-artifact';
import { compileWorldScripts, scriptExecutor } from '@dungeon-scrivener/scripting';
import linearManifest from '../../../fixtures/linear-three-nodes/project.json';
import linearWorld from '../../../fixtures/linear-three-nodes/world.json';
import linearLocale from '../../../fixtures/linear-three-nodes/locales/en-GB.json';
import readmeTemplate from '../../../docs/exports/README.template.md?raw';
import '@xyflow/react/dist/style.css';
import './studio.css';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
type Mode = 'home' | 'sage' | 'apprentice' | 'playtest' | 'play';
type PreparedProject = { snapshot: ProjectVfsSnapshot; manifest: ProjectManifest; world: WorldDocument; locales: LocaleDocument[]; scripts: CompiledScriptBundle; media: ReturnType<typeof createMediaAssetCatalog>; resolvedMedia: import('@dungeon-scrivener/model').ResolvedMediaAsset[]; themeCss: string };
type PlayConfig = { scripts: CompiledScriptBundle; media: ReturnType<typeof createMediaAssetCatalog>; compatibility: SaveCompatibilityTarget; themeCss: string };
type StudioAction = 'save-project' | 'play' | 'export';

function snapshotFromData(manifest: unknown, world: unknown, locales: Record<string, unknown> = {}): ProjectVfsSnapshot {
  const files: ProjectFile[] = [
    { path: 'project.json', bytes: encoder.encode(JSON.stringify(manifest, null, 2)), role: 'manifest' as const },
    { path: 'world.json', bytes: encoder.encode(JSON.stringify(world, null, 2)), role: 'world' as const },
    ...Object.entries(locales).map(([path, locale]) => ({ path, bytes: encoder.encode(JSON.stringify(locale, null, 2)), role: 'locale' as const })),
  ];
  return createSnapshot(files);
}

function parseFile(snapshot: ProjectVfsSnapshot, path: string): unknown {
  const file = readProjectFile(snapshot, path);
  if (!file) return undefined;
  try { return JSON.parse(decoder.decode(file.bytes)); } catch { return undefined; }
}

function download(bytes: Uint8Array, name: string, type: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function referencedMedia(world: WorldDocument, locales: readonly LocaleDocument[]): Set<`sha256:${string}`> {
  const referenced = new Set<`sha256:${string}`>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/!\[\[asset:(sha256:[a-f0-9]{64})(?:\|[^\]]*)?\]\]/gu)) {
        referenced.add(match[1] as `sha256:${string}`);
      }
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(scan);
  };
  scan(world);
  scan(locales);
  const typingSounds = world.settings?.typingSounds;
  for (const mapping of Array.isArray(typingSounds?.mappings) ? typingSounds.mappings : []) {
    if (mapping && typeof mapping.assetHash === 'string' && /^[a-f0-9]{64}$/u.test(mapping.assetHash)) {
      referenced.add(`sha256:${mapping.assetHash}`);
    }
  }
  if (typingSounds?.fallback?.kind === 'asset' && /^[a-f0-9]{64}$/u.test(typingSounds.fallback.assetHash)) {
    referenced.add(`sha256:${typingSounds.fallback.assetHash}`);
  }
  return referenced;
}

function App(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('home');
  const [snapshot, setSnapshot] = useState<ProjectVfsSnapshot | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('');
  const [operationError, setOperationError] = useState('');
  const [playActivity, setPlayActivity] = useState('');
  const [persistenceNotice, setPersistenceNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [requestedLocale, setRequestedLocale] = useState<string>();
  const [unsavedSince, setUnsavedSince] = useState<number>();
  const [reminderVisible, setReminderVisible] = useState(false);
  const [reminderDismissedFor, setReminderDismissedFor] = useState<number>();
  const [confirmation, setConfirmation] = useState<{ action: StudioAction; warnings: Diagnostic[]; run: () => void }>();
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [newTitle, setNewTitle] = useState(String(linearManifest.title));
  const [newVersion, setNewVersion] = useState(String(linearManifest.gameVersion));
  const [newProjectError, setNewProjectError] = useState('');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [includeReadme, setIncludeReadme] = useState(true);
  const [creatorAttribution, setCreatorAttribution] = useState('');
  const [distributionAttribution, setDistributionAttribution] = useState('');
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [recoveryProjectId, setRecoveryProjectId] = useState<string | null>(null);
  const [playSnapshot, setPlaySnapshot] = useState<SessionSnapshot>();
  const [playConfig, setPlayConfig] = useState<PlayConfig>();
  const [diagnosticMedia, setDiagnosticMedia] = useState<{ snapshot: ProjectVfsSnapshot; media: ReturnType<typeof createMediaAssetCatalog>; diagnostics: Diagnostic[] }>();
  const playSnapshotRef = useRef<SessionSnapshot | undefined>(undefined);
  const confirmationRef = useRef<HTMLDialogElement>(null);
  const errorDialogRef = useRef<HTMLDialogElement>(null);
  const exportDialogRef = useRef<HTMLDialogElement>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => new Set());
  const workspaceRef = useRef<SageWorkspace | null>(null);
  const snapshotRef = useRef<ProjectVfsSnapshot | null>(null);
  const manifest = useMemo(() => snapshot ? parseFile(snapshot, 'project.json') as ProjectManifest | undefined : undefined, [snapshot, revision]);
  const world = useMemo(() => snapshot ? parseFile(snapshot, 'world.json') as WorldDocument | undefined : undefined, [snapshot, revision]);
  const locales = useMemo(() => snapshot ? [...snapshot.files.keys()]
    .filter(path => /^locales\/[^/]+\.json$/u.test(path))
    .map(path => parseFile(snapshot, path))
    .filter((item): item is LocaleDocument => typeof item === 'object' && item !== null && 'locale' in item) : [], [snapshot, revision]);
  const localeMap = useMemo(() => Object.fromEntries(locales.map(locale => [`locales/${locale.locale}.json`, locale])), [locales]);
  const assetHashes = useMemo(() => new Set([...(snapshot?.files.keys() ?? [])].flatMap(path => {
    const match = /^assets\/sha256\/([a-f0-9]{64})$/u.exec(path);
    return match ? [match[1]!] : [];
  })), [snapshot]);
  const report = useMemo(() => manifest && world && snapshot && diagnosticMedia?.snapshot === snapshot
    ? collectDiagnostics({ manifest, world, locales: localeMap, filePaths: new Set(snapshot.files.keys()), assetHashes, assets: diagnosticMedia.media, additionalDiagnostics: diagnosticMedia.diagnostics })
    : undefined, [manifest, world, localeMap, snapshot, assetHashes, diagnosticMedia]);
  const validation = useMemo(() => manifest && world ? validateProject({ manifest, world, locales: localeMap, filePaths: new Set(snapshot?.files.keys()), assetHashes }) : undefined, [manifest, world, localeMap, snapshot, assetHashes]);
  const activeEngine = useMemo(() => playConfig ? createGameEngine({
    scriptExecutor, mediaAssets: playConfig.media,
    seededSeedSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! },
    unseededRandomSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! },
  }, playConfig.scripts) : undefined, [playConfig]);

  useEffect(() => {
    if (!snapshot || !world) return;
    let active = true;
    const media = createMediaAssetCatalog();
    void (async () => {
      const diagnostics: Diagnostic[] = [];
      for (const assetId of referencedMedia(world, locales)) {
        const path = `assets/sha256/${assetId.slice('sha256:'.length)}`;
        const file = readProjectFile(snapshot, path);
        if (!file) {
          diagnostics.push({ code: 'DS-MEDIA-MISSING', severity: 'error', message: `Referenced media asset is missing: ${path}`, path, blocks: ['play', 'export'] });
          continue;
        }
        try { await media.registerAsset({ bytes: file.bytes, originalFilename: 'managed-asset', expectedAssetId: assetId }); }
        catch (error) {
          diagnostics.push({ code: 'DS-MEDIA-001', severity: 'error', message: `${path}: ${error instanceof Error ? error.message : 'Asset registration failed.'}`, path, blocks: ['play', 'export'] });
        }
      }
      if (active) setDiagnosticMedia({ snapshot, media, diagnostics });
    })();
    return () => { active = false; };
  }, [snapshot, world, locales]);

  useEffect(() => {
    const savedId = localStorage.getItem('dungeon-scrivener-last-project');
    if (!savedId) return;
    setRecoveryProjectId(savedId);
    void loadRecovery(savedId).then(result => setRecoveryAvailable(result.ok && result.snapshot !== null));
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js').then(async registration => {
      await navigator.serviceWorker.ready;
      const worker = registration.active;
      if (!worker) return;
      const urls = [...new Set(performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(url => url.startsWith(location.origin) && /\.(?:js|css)(?:$|\?)/u.test(url)))] as string[];
      worker.postMessage({ type: 'PRECACHE_URLS', urls });
    }).catch(() => setStatus('Offline cache could not be installed.'));
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const timer = window.setTimeout(() => {
      void saveRecovery(snapshot).then(result => setStatus(result.ok ? 'Recovery copy saved locally.' : result.diagnostic.message));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [snapshot, revision]);

  useEffect(() => {
    if (!snapshot) { return; }
    let active = true;
    void loadRecovery(snapshot.projectId).then(result => {
      if (active) { setRecoveryAvailable(result.ok && result.snapshot !== null); setRecoveryProjectId(snapshot.projectId); }
    });
    return () => { active = false; };
  }, [snapshot?.projectId]);

  useEffect(() => {
    if (!unsavedSince || reminderDismissedFor === unsavedSince) return;
    const checkReminder = (): void => {
      if (Date.now() - unsavedSince >= 10 * 60 * 1000) setReminderVisible(true);
    };
    checkReminder();
    const timer = window.setInterval(checkReminder, 15_000);
    return () => window.clearInterval(timer);
  }, [unsavedSince, reminderDismissedFor]);

  useEffect(() => {
    if (confirmation) {
      if (!confirmationRef.current?.open) confirmationRef.current?.showModal();
    } else if (confirmationRef.current?.open) confirmationRef.current.close();
  }, [confirmation]);

  useEffect(() => {
    if (errorDialogOpen) {
      if (!errorDialogRef.current?.open) errorDialogRef.current?.showModal();
    } else if (errorDialogRef.current?.open) errorDialogRef.current.close();
  }, [errorDialogOpen]);

  useEffect(() => {
    if (exportDialogOpen) {
      if (!exportDialogRef.current?.open) exportDialogRef.current?.showModal();
    } else if (exportDialogRef.current?.open) exportDialogRef.current.close();
  }, [exportDialogOpen]);

  useEffect(() => {
    if (mode !== 'play' || !activeEngine || !world || !playSnapshot) return;
    playSnapshotRef.current = playSnapshot;
    const timer = window.setInterval(() => {
      const current = playSnapshotRef.current;
      if (!current) return;
      const result = activeEngine.observeClock(world, current, {
        kind: 'tick', wallClockEpochMilliseconds: Date.now(),
        visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible', focused: document.hasFocus(),
      });
      if (result.diagnostics.diagnostics.some(item => item.severity === 'error' || item.severity === 'fatal')) {
        setStatus(result.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' '));
        return;
      }
      playSnapshotRef.current = result.snapshot;
      setPlaySnapshot(result.snapshot);
      const scriptsRun = [...new Set(result.trace.filter(item => item.source.kind === 'script').map(item => item.source.kind === 'script' ? item.source.scriptId : ''))];
      if (scriptsRun.length) setPlayActivity(`Hosted play ran scripts: ${scriptsRun.join(', ')}.`);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [mode, activeEngine, world, playSnapshot?.projectId]);

  function openProject(next: ProjectVfsSnapshot, message: string, unsaved = false): void {
    setOperationError('');
    setPersistenceNotice('');
    setErrorDialogOpen(false);
    snapshotRef.current = next;
    setSnapshot(next);
    setRecoveryProjectId(next.projectId);
    localStorage.setItem('dungeon-scrivener-last-project', next.projectId);
    workspaceRef.current = new SageWorkspace(next);
    setRevision(value => value + 1);
    setAcknowledged(new Set());
    setUnsavedSince(unsaved ? Date.now() : undefined);
    setReminderVisible(false);
    setReminderDismissedFor(undefined);
    setRequestedLocale(undefined);
    setMode('sage');
    setStatus(message);
  }

  async function importZip(file?: File): Promise<void> {
    if (!file || importing) return;
    setImporting(true);
    try {
      const imported = await readProjectZip(new Uint8Array(await file.arrayBuffer()));
      openProject(imported, `Imported ${file.name}. Review diagnostics before play or export.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Project ZIP could not be read.');
    } finally {
      setImporting(false);
    }
  }

  function currentReport(): readonly Diagnostic[] { return report?.diagnostics ?? []; }

  function failOperation(message: string): void { setOperationError(message); setErrorDialogOpen(true); setStatus(message); }

  async function prepareProject(): Promise<PreparedProject | undefined> {
    setOperationError('');
    const acceptedSnapshot = snapshotRef.current ?? snapshot;
    if (!acceptedSnapshot) return undefined;
    const acceptedManifest = parseFile(acceptedSnapshot, 'project.json') as ProjectManifest | undefined;
    const acceptedWorld = parseFile(acceptedSnapshot, 'world.json') as WorldDocument | undefined;
    const acceptedLocales = [...acceptedSnapshot.files.keys()]
      .filter(path => /^locales\/[^/]+\.json$/u.test(path))
      .map(path => parseFile(acceptedSnapshot, path))
      .filter((item): item is LocaleDocument => typeof item === 'object' && item !== null && 'locale' in item);
    if (!acceptedManifest || !acceptedWorld) {
      failOperation('Project manifest or world document is missing or invalid JSON.');
      return undefined;
    }
    const acceptedLocaleMap = Object.fromEntries(acceptedLocales.map(locale => [`locales/${locale.locale}.json`, locale]));
    const assetHashes = new Set([...acceptedSnapshot.files.keys()].flatMap(path => {
      const match = /^assets\/sha256\/([a-f0-9]{64})$/u.exec(path);
      return match ? [match[1]!] : [];
    }));
    const projectValidation = validateProject({ manifest: acceptedManifest, world: acceptedWorld, locales: acceptedLocaleMap, filePaths: new Set(acceptedSnapshot.files.keys()), assetHashes });
    const errors = projectValidation.diagnostics.filter(item => item.severity === 'error' || item.severity === 'fatal');
    if (errors.length) {
      failOperation(errors.map(item => `${item.code}: ${item.message}`).join(' '));
      return undefined;
    }
    let scripts: ReturnType<typeof compileWorldScripts>;
    try {
      scripts = compileWorldScripts(acceptedWorld, path => {
        const file = readProjectFile(acceptedSnapshot, path);
        return file ? decoder.decode(file.bytes) : undefined;
      });
    } catch (error) {
      failOperation(error instanceof Error ? error.message : 'Script source could not be decoded.');
      return undefined;
    }
    if ('diagnostics' in scripts) {
      failOperation(scripts.diagnostics.map(item => `${item.code}: ${item.message}`).join(' '));
      return undefined;
    }
    const referenced = referencedMedia(acceptedWorld, acceptedLocales);
    const media = createMediaAssetCatalog();
    const resolvedMedia = [];
    for (const assetId of referenced) {
      const digest = assetId.slice('sha256:'.length);
      const path = `assets/sha256/${digest}`;
      const file = readProjectFile(acceptedSnapshot, path);
      if (!file) { failOperation(`Referenced media asset is missing: ${path}`); return undefined; }
      try {
        await media.registerAsset({ bytes: file.bytes, originalFilename: `asset-${digest}`, expectedAssetId: assetId });
      } catch (error) {
        failOperation(`${path}: ${error instanceof Error ? error.message : 'Asset registration failed.'}`);
        return undefined;
      }
      const result = media.resolveAsset(assetId);
      if (!result.ok) { failOperation(`${result.diagnostic.code}: ${result.diagnostic.message}`); return undefined; }
      resolvedMedia.push(result.asset);
    }
    let themeCss = '';
    const stylePath = acceptedWorld.settings.playerStylePath;
    if (stylePath) {
      const styleFile = readProjectFile(acceptedSnapshot, stylePath);
      if (!styleFile) { failOperation(`Player style file is missing: ${stylePath}`); return undefined; }
      try { themeCss = decoder.decode(styleFile.bytes); } catch { failOperation(`Player style file is not valid UTF-8: ${stylePath}`); return undefined; }
      if (!isOfflineSafeTheme(themeCss)) { failOperation(`Player style is not accepted for offline play or export: ${stylePath}`); return undefined; }
    }
    return { snapshot: acceptedSnapshot, manifest: acceptedManifest, world: acceptedWorld, locales: acceptedLocales, scripts, media, resolvedMedia, themeCss };
  }

  function requestAction(action: StudioAction, run: () => void): void {
    const decision = getAcknowledgementStatus(currentReport(), action, acknowledged);
    if (!decision.required || decision.acknowledged) { run(); return; }
    const pending = currentReport().filter(item => item.severity === 'warning' && item.acknowledgementRequired?.includes(action) && !acknowledged.has(item.code));
    setConfirmation({ action, warnings: pending, run });
  }

  async function saveZip(): Promise<void> {
    if (!snapshot) return;
    try {
      download(await writeProjectZip(snapshot), `${manifest?.projectId ?? snapshot.projectId}.zip`, 'application/zip');
      await clearRecovery(snapshot.projectId);
      setRecoveryAvailable(false);
      setUnsavedSince(undefined);
      setReminderVisible(false);
      setStatus('Project ZIP downloaded.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Project ZIP could not be written.');
    }
  }

  function updateWorld(next: WorldDocument): void {
    if (!snapshot) return;
    const current = snapshotRef.current ?? snapshot;
    const files = [...current.files.values()].map(file => file.path === 'world.json'
      ? { ...file, bytes: encoder.encode(JSON.stringify(next, null, 2)) }
      : file);
    const updated = createSnapshot(files, current.directories);
    snapshotRef.current = updated;
    setSnapshot(updated);
    workspaceRef.current = new SageWorkspace(updated);
    setUnsavedSince(Date.now());
    setReminderVisible(false);
    setStatus('Apprentice changes saved to the project.');
    setRevision(value => value + 1);
  }

  function configurePlay(prepared: PreparedProject): PlayConfig | undefined {
    const fingerprint = computeContentFingerprint(prepared.snapshot, prepared.manifest, prepared.world, prepared.locales);
    if (!fingerprint.ok) {
      failOperation(fingerprint.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' '));
      return undefined;
    }
    return {
      scripts: prepared.scripts, media: prepared.media, themeCss: prepared.themeCss,
      compatibility: {
        manifest: { projectId: prepared.manifest.projectId, gameVersion: prepared.manifest.gameVersion },
        engineVersion: PORTABLE_PLAYER_ENGINE_VERSION,
        contentFingerprint: fingerprint.value.digest,
      },
    };
  }

  async function startPlay(): Promise<void> {
    setPlayActivity('');
    const prepared = await prepareProject();
    if (!prepared) return;
    const config = configurePlay(prepared);
    if (!config) return;
    const engine = createGameEngine({ scriptExecutor, mediaAssets: prepared.media, seededSeedSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! }, unseededRandomSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! } }, prepared.scripts);
    const started = engine.createSession(prepared.manifest.projectId, prepared.world, { wallClockEpochMilliseconds: Date.now(), visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible', focused: document.hasFocus() });
    if (!started.ok) {
      failOperation(started.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' '));
      return;
    }
    setPlaySnapshot(started.snapshot);
    playSnapshotRef.current = started.snapshot;
    setPlayConfig(config);
    setPersistenceNotice('');
    setMode('play');
  }

  async function startPlaytest(): Promise<void> {
    const prepared = await prepareProject();
    if (!prepared) return;
    const config = configurePlay(prepared);
    if (!config) return;
    const engine = createGameEngine({ scriptExecutor, mediaAssets: prepared.media, seededSeedSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! }, unseededRandomSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! } }, prepared.scripts);
    const started = engine.createSession(prepared.manifest.projectId, prepared.world, { wallClockEpochMilliseconds: Date.now(), visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible', focused: document.hasFocus() });
    if (!started.ok) {
      failOperation(started.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' '));
      return;
    }
    setPlaySnapshot(started.snapshot);
    playSnapshotRef.current = started.snapshot;
    setPlayConfig(config);
    setMode('playtest');
  }

  async function saveHosted(slotId: string): Promise<string | undefined> {
    const current = playSnapshotRef.current;
    if (!playConfig || !world || !current) return 'No active game session is available.';
    const slot = getSaveSlotChoices(world.savePolicy).find(choice => choice.slotId === slotId);
    if (!slot) return 'That save slot is not enabled for this game.';
    const { projectId: _projectId, ...session } = current;
    const archive: PlayerSaveArchive = {
      format: 'dungeon-scrivener-player-save', schemaVersion: 1,
      projectId: playConfig.compatibility.manifest.projectId,
      gameVersion: playConfig.compatibility.manifest.gameVersion,
      engineVersion: playConfig.compatibility.engineVersion,
      contentFingerprint: playConfig.compatibility.contentFingerprint,
      slotId, slotLabel: slot.label, savedAt: new Date().toISOString(), session,
    };
    const result = await downloadPlayerSave(archive, world.savePolicy, current.currentNodeId, `${archive.projectId}-${slotId}-save.zip`);
    return result.ok ? undefined : result.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' ');
  }

  async function loadHosted(file: File): Promise<void> {
    if (!playConfig || !world || !world.savePolicy.enabled) {
      setPersistenceNotice('Player saves are disabled for this game.');
      return;
    }
    const imported = await importHostedSaveFile(file, playConfig.compatibility);
    if (!imported.ok) {
      setPersistenceNotice(imported.reason === 'decode'
        ? imported.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' ')
        : imported.message);
      return;
    }
    if (!getSaveSlotChoices(world.savePolicy).some(slot => slot.slotId === imported.save.slotId)) {
      setPersistenceNotice('The save slot is not available under this game policy.');
      return;
    }
    playSnapshotRef.current = imported.snapshot;
    setPlaySnapshot(imported.snapshot);
    setPersistenceNotice('');
  }

  async function exportProject(): Promise<void> {
    const prepared = await prepareProject();
    if (!prepared) return;
    const fingerprint = computeContentFingerprint(prepared.snapshot, prepared.manifest, prepared.world, prepared.locales);
    if (!fingerprint.ok) { failOperation(fingerprint.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' ')); return; }
    const result = await exportGame({ manifest: prepared.manifest, world: prepared.world, locales: prepared.locales, scripts: prepared.scripts, acceptedContentFingerprint: fingerprint.value, media: prepared.resolvedMedia, authorStyle: { cssText: prepared.themeCss }, player: getPortablePlayerArtifact() });
    if (!result.ok) { failOperation(result.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' ')); return; }
    download(result.zipBytes, `${prepared.manifest.projectId}-game.zip`, 'application/zip');
    if (includeReadme) {
      const readme = readmeTemplate
        .replaceAll('{{GAME_NAME}}', prepared.manifest.title)
        .replaceAll('{{GAME_VERSION}}', prepared.manifest.gameVersion)
        .replaceAll('{{CREATOR_ATTRIBUTION}}', creatorAttribution.trim() || 'Not provided by the author.')
        .replaceAll('{{TESTED_BROWSERS}}', 'Browser and version test details should be supplied by the author alongside this README.')
        .replaceAll('{{DISTRIBUTION_ATTRIBUTION_OR_LICENSE}}', distributionAttribution.trim() || 'No distribution attribution or license details were provided.');
      download(encoder.encode(readme), `${prepared.manifest.projectId}-README.md`, 'text/markdown;charset=utf-8');
    }
    setOperationError('');
    setStatus('Portable game ZIP downloaded.');
  }

  async function restoreRecovery(): Promise<void> {
    if (!recoveryProjectId) return;
    const result = await loadRecovery(recoveryProjectId);
    if (!result.ok) { setStatus(result.diagnostic.message); return; }
    if (!result.snapshot) { setRecoveryAvailable(false); setStatus('No recovery copy is available.'); return; }
    openProject(result.snapshot, 'Recovery copy restored.', true);
  }

  if (!snapshot || mode === 'home') {
    return <main className="home">
      <h1>DungeonScrivener</h1>
      <p>Create and edit a text adventure in Sage or Apprentice Mode.</p>
      <label>Project title<input value={newTitle} onChange={event => setNewTitle(event.currentTarget.value)} required /></label>
      <label>Default language<select defaultValue="en-GB" disabled aria-describedby="default-language-help"><option value="en-GB">English (en-GB)</option></select></label>
      <span id="default-language-help">The starter project currently provides English (en-GB).</span>
      <label>Game version<input value={newVersion} onChange={event => setNewVersion(event.currentTarget.value)} required aria-describedby="game-version-help" /></label>
      <span id="game-version-help">Enter a semantic version such as 1.0.0. This version is used for save compatibility.</span>
      {newProjectError && <p role="alert">{newProjectError}</p>}
      <button onClick={() => {
        const title = newTitle.trim();
        if (!title) { setNewProjectError('Enter a project title.'); return; }
        const projectId = `project-${crypto.randomUUID()}`;
        const manifestResult = validateProjectManifest({ ...linearManifest, title, gameVersion: newVersion.trim(), defaultLocale: 'en-GB', projectId });
        if (!manifestResult.ok || !manifestResult.value) {
          setNewProjectError(manifestResult.diagnostics.map(item => `${item.code}: ${item.message}`).join(' ') || 'The project manifest is invalid.');
          return;
        }
        setNewProjectError('');
        openProject(snapshotFromData(manifestResult.value, linearWorld, { 'locales/en-GB.json': linearLocale }), 'Starter project created.', true);
      }}>Create project</button>
      <label className={`button${importing ? ' is-disabled' : ''}`} aria-busy={importing}>Import project ZIP<input type="file" accept=".zip,application/zip" disabled={importing} onChange={event => void importZip(event.currentTarget.files?.[0])} /></label>
      {importing && <p role="status" aria-live="polite">Importing project ZIP. Please wait.</p>}
      {recoveryAvailable && <button onClick={() => void restoreRecovery()}>Restore recovery</button>}
      {status && <p role="status">{status}</p>}
    </main>;
  }

  const workspace = workspaceRef.current;
  function markUnsaved(): void { setUnsavedSince(Date.now()); setReminderVisible(false); setReminderDismissedFor(undefined); }

  return <div className="studio">
    <a className="skip-link" href="#studio-workspace">Skip to project workspace</a>
    <header>
      <button onClick={() => setMode('home')}>Projects</button>
      <strong>{manifest?.title ?? manifest?.projectId ?? 'Untitled project'}</strong>
      <nav aria-label="Studio actions">
        <button aria-pressed={mode === 'sage'} onClick={() => { const current = snapshotRef.current ?? snapshot; if (current) { workspaceRef.current = new SageWorkspace(current); setStatus('Sage Mode is using the current project snapshot.'); } setMode('sage'); }}>Sage</button>
        <button aria-pressed={mode === 'apprentice'} onClick={() => setMode('apprentice')}>Apprentice</button>
        <button onClick={() => requestAction('play', () => { void startPlaytest(); })}>Playtest</button>
        <button onClick={() => requestAction('play', () => { void startPlay(); })}>Play</button>
        <button onClick={() => requestAction('save-project', () => { void saveZip(); })}>Download project ZIP</button>
        <button onClick={() => requestAction('export', () => setExportDialogOpen(true))}>Export game ZIP</button>
      </nav>
    </header>
    {status && <p className="status" role="status">{status}</p>}
    {playActivity && mode === 'play' && <p className="status" data-testid="hosted-play-activity">{playActivity}</p>}
    {operationError && <p className="status" role="alert">{operationError}</p>}
    {unsavedSince !== undefined && reminderVisible && <aside className="save-reminder" role="status" aria-live="polite" aria-label="Unsaved work reminder">
      <p>You have unsaved project work. Download a project ZIP to keep a portable copy. Recovery is saved locally.</p>
      <button onClick={() => requestAction('save-project', () => { void saveZip(); })}>Download project ZIP</button>
      <button onClick={() => { setReminderVisible(false); setReminderDismissedFor(unsavedSince); }}>Dismiss reminder</button>
    </aside>}
    <a className="visually-hidden-focusable" href="#project-diagnostics">Skip to diagnostics</a>
    <div id="studio-workspace" className="studio-workspace" role={mode === 'play' ? 'region' : 'main'} aria-label={mode === 'play' ? 'Game player' : 'Project workspace'} tabIndex={-1}>
    {mode === 'sage' && workspace && <SageMode workspace={workspace} onStateChange={state => {
      if (state.snapshot !== snapshotRef.current) {
        snapshotRef.current = state.snapshot;
        setSnapshot(state.snapshot);
        markUnsaved();
        setRevision(value => value + 1);
      }
    }} />}
    {mode === 'apprentice' && world && <ApprenticeGraph world={world} onWorldChange={updateWorld} />}
    {mode === 'playtest' && world && playSnapshot && activeEngine && <PlaytestDebugger world={world} initialSnapshot={playSnapshot}
      stepSession={(current, input) => activeEngine.dispatchPlayerInput(world, current, input)}
      observeClock={(current, input) => activeEngine.observeClock(world, current, input)} />}
    {mode === 'play' && manifest && world && playSnapshot && playConfig && activeEngine && <EnginePlayer
      engine={activeEngine}
      manifest={manifest} world={world} locales={locales} snapshot={playSnapshot} {...(requestedLocale ? { requestedLocale } : {})}
      localeOptions={locales.map(locale => ({ locale: locale.locale, label: locale.locale }))} onLocaleChange={setRequestedLocale}
      onSnapshot={next => { playSnapshotRef.current = next; setPlaySnapshot(next); }}
      mediaAssets={playConfig.media} themeCss={playConfig.themeCss} persistenceNotice={persistenceNotice}
      saveSlots={getSaveSlotChoices(world.savePolicy)} onSave={saveHosted}
      {...(world.savePolicy.enabled ? { onLoad: (file: File) => { void loadHosted(file); } } : {})}
    />}
    {validation && report && <aside className="diagnostics" id="project-diagnostics" tabIndex={-1} aria-label="Project diagnostics" aria-live="polite">
      <strong>Project diagnostics</strong>
      {report.diagnostics.length ? <ul>{report.diagnostics.map((item, index) => <li key={`${item.code}:${index}`}>{item.severity}: {item.code}: {item.message}</li>)}</ul> : <p>No diagnostics.</p>}
    </aside>}
    <button className="clear-recovery" onClick={async () => {
      if (!snapshot) return;
      const result = await clearRecovery(snapshot.projectId);
      setStatus(result.ok ? 'Recovery copy cleared.' : result.diagnostic.message);
      if (result.ok) setRecoveryAvailable(false);
    }}>Clear recovery copy</button>
    </div>
    <dialog ref={confirmationRef} aria-labelledby="warning-title" aria-describedby="warning-description" onCancel={event => { event.preventDefault(); setConfirmation(undefined); }}>
      {confirmation && <><h2 id="warning-title">Review warnings before {confirmation.action === 'save-project' ? 'downloading the project' : confirmation.action}</h2>
        <p id="warning-description">These warnings require your acknowledgment before continuing.</p>
        <ul>{confirmation.warnings.map((warning, index) => <li key={`${warning.code}:${index}`}><strong>{warning.code}</strong>: {warning.message}</li>)}</ul>
        <div className="dialog-actions"><button autoFocus onClick={() => setConfirmation(undefined)}>Cancel</button><button onClick={() => {
          const pending = confirmation;
          setAcknowledged(new Set([...acknowledged, ...pending.warnings.map(warning => warning.code)]));
          setConfirmation(undefined);
          window.setTimeout(pending.run, 0);
        }}>Acknowledge and continue</button></div></>}
    </dialog>
    <dialog ref={exportDialogRef} aria-labelledby="export-title" aria-describedby="export-description" onCancel={event => { event.preventDefault(); setExportDialogOpen(false); }}>
      <h2 id="export-title">Export {manifest?.title} ({manifest?.gameVersion})</h2>
      <p id="export-description">The ZIP contains a playable game and its referenced local assets. Extract the complete ZIP and open index.html in a supported desktop browser. Play requires no server or network connection after download. Player saves are separate ZIP downloads that players import later.</p>
      <p>Share the complete ZIP and make sure you have permission to distribute the story and bundled assets.</p>
      <label><input type="checkbox" checked={includeReadme} onChange={event => setIncludeReadme(event.currentTarget.checked)} />Also download a README template filled with the game name and version</label>
      {includeReadme && <><label>Creator attribution<input value={creatorAttribution} onChange={event => setCreatorAttribution(event.currentTarget.value)} /></label><label>Distribution attribution or license<input value={distributionAttribution} onChange={event => setDistributionAttribution(event.currentTarget.value)} /></label><p>The README downloads beside the game ZIP. Browser coverage remains in the release evidence document.</p></>}
      <div className="dialog-actions"><button autoFocus onClick={() => setExportDialogOpen(false)}>Cancel</button><button onClick={() => { setExportDialogOpen(false); void exportProject(); }}>Build and download</button></div>
    </dialog>
    <dialog ref={errorDialogRef} aria-labelledby="error-title" onCancel={event => { event.preventDefault(); setErrorDialogOpen(false); }}>
      <h2 id="error-title">Action could not continue</h2><p>{operationError}</p>
      <button autoFocus onClick={() => setErrorDialogOpen(false)}>Close</button>
    </dialog>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
