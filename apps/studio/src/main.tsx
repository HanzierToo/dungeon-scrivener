import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprenticeForms, ApprenticeGraph, ApprenticeScripts, type GraphPositions } from '@dungeon-scrivener/apprentice';
import { PlaytestDebugger } from '@dungeon-scrivener/debugger';
import { collectDiagnostics, getAcknowledgementStatus } from '@dungeon-scrivener/diagnostics';
import { createGameEngine } from '@dungeon-scrivener/engine';
import { exportGame } from '@dungeon-scrivener/exporter';
import { createMediaAssetCatalog, type RegisteredAsset } from '@dungeon-scrivener/media';
import { computeContentFingerprint, validateProject, validateProjectManifest, type CompiledScriptBundle, type Diagnostic, type LocaleDocument, type PlayerSaveArchive, type ProjectFile, type ProjectManifest, type ProjectVfsSnapshot, type SaveCompatibilityTarget, type SessionSnapshot, type WorldDocument } from '@dungeon-scrivener/model';
import { clearRecovery, loadRecovery, saveRecovery } from '@dungeon-scrivener/persistence';
import { readProjectFile, readProjectZip, writeProjectZip, createSnapshot } from '@dungeon-scrivener/vfs';
import { SageMode, SageWorkspace } from '@dungeon-scrivener/sage';
import { EnginePlayer, isOfflineSafeTheme, PORTABLE_PLAYER_ENGINE_VERSION } from '@dungeon-scrivener/player';
import { downloadPlayerSave, getSaveSlotChoices, importHostedSaveFile } from '@dungeon-scrivener/player-save';
import { getPortablePlayerArtifact } from '@dungeon-scrivener/player/portable-artifact';
import { compileWorldScripts, scriptExecutor } from '@dungeon-scrivener/scripting';
import { shouldOfferModeTour, shouldOfferStudioTour, StudioTour, type TourKind, type TourPhase } from './StudioTour.js';
import linearManifest from '../../../fixtures/linear-three-nodes/project.json';
import linearWorld from '../../../fixtures/linear-three-nodes/world.json';
import linearLocale from '../../../fixtures/linear-three-nodes/locales/en-GB.json';
import readmeTemplate from '../../../docs/exports/README.template.md?raw';
import '@xyflow/react/dist/style.css';
import './studio.css';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const GRAPH_LAYOUT_PATH = 'studio/graph-layout.json';
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

function readGraphPositions(snapshot: ProjectVfsSnapshot): GraphPositions {
  const layout = parseFile(snapshot, GRAPH_LAYOUT_PATH);
  if (!layout || typeof layout !== 'object' || !('schemaVersion' in layout) || layout.schemaVersion !== 1 || !('positions' in layout) || !layout.positions || typeof layout.positions !== 'object') return {};
  return Object.fromEntries(Object.entries(layout.positions).filter((entry): entry is [string, { x: number; y: number }] => {
    const value = entry[1];
    return !!value && typeof value === 'object' && 'x' in value && 'y' in value
      && typeof value.x === 'number' && Number.isFinite(value.x) && Math.abs(value.x) <= 100000
      && typeof value.y === 'number' && Number.isFinite(value.y) && Math.abs(value.y) <= 100000;
  }));
}

function diagnosticMessage(item: Diagnostic, world: WorldDocument | undefined, locale: LocaleDocument | undefined): string {
  if (item.code !== 'DS-MOD-031' || !item.entityId || !world) return item.message;
  const node = world.nodes.find(candidate => candidate.id === item.entityId);
  if (!node) return item.message;
  const title = node.title.kind === 'literal' ? node.title.text : locale?.strings[node.title.key] ?? node.title.key;
  return `“${title}” is unreachable from the entry scene. Drag from a reachable scene’s bottom dot to this scene’s top dot, or use “Link selected scene to” in the map toolbar.`;
}

function createSageWorkspace(snapshot: ProjectVfsSnapshot, preferredPath?: string): SageWorkspace {
  const workspace = new SageWorkspace(snapshot);
  const firstPath = [preferredPath, 'world.json', 'project.json'].find(path => path && snapshot.files.has(path));
  if (firstPath) workspace.open(firstPath);
  return workspace;
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
  const [tourPhase, setTourPhase] = useState<TourPhase>(null);
  const [tourKind, setTourKind] = useState<TourKind>('studio');
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [inspectorTab, setInspectorTab] = useState<'scene' | 'world' | 'scripts'>('scene');
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
  const graphPositions = useMemo(() => snapshot ? readGraphPositions(snapshot) : {}, [snapshot]);
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
    if (tourPhase === 'invite' && tourKind !== 'studio' && tourKind !== 'tutorial' && tourKind !== mode) {
      setTourPhase(null);
      return;
    }
    if (!snapshot || mode === 'home' || tourPhase || !shouldOfferModeTour(mode)) return;
    const timer = window.setTimeout(() => { setTourKind(mode); setTourPhase('invite'); }, 250);
    return () => window.clearTimeout(timer);
  }, [snapshot, mode, tourPhase, tourKind]);

  useEffect(() => {
    if (!snapshot || !world) return;
    let active = true;
    const media = createMediaAssetCatalog();
    void (async () => {
      const diagnostics: Diagnostic[] = [];
      const referenced = referencedMedia(world, locales);
      const assetPaths = [...snapshot.files.keys()].filter(path => /^assets\/sha256\/[a-f0-9]{64}$/u.test(path));
      for (const path of assetPaths) {
        const file = readProjectFile(snapshot, path);
        if (!file) continue;
        const assetId = `sha256:${path.slice('assets/sha256/'.length)}` as `sha256:${string}`;
        try { await media.registerAsset({ bytes: file.bytes, originalFilename: 'managed-asset', expectedAssetId: assetId }); }
        catch (error) {
          if (referenced.has(assetId)) diagnostics.push({ code: 'DS-MEDIA-001', severity: 'error', message: `${path}: ${error instanceof Error ? error.message : 'Asset registration failed.'}`, path, blocks: ['play', 'export'] });
        }
      }
      for (const assetId of referenced) {
        const path = `assets/sha256/${assetId.slice('sha256:'.length)}`;
        if (!snapshot.files.has(path)) diagnostics.push({ code: 'DS-MEDIA-MISSING', severity: 'error', message: `Referenced media asset is missing: ${path}`, path, blocks: ['play', 'export'] });
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
    if (import.meta.env.DEV) {
      void navigator.serviceWorker.getRegistration().then(registration => registration?.unregister());
      void caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('dungeon-scrivener-studio-')).map(key => caches.delete(key))));
      return;
    }
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

  function openProject(next: ProjectVfsSnapshot, message: string, unsaved = false, initialMode: 'sage' | 'apprentice' = 'sage'): void {
    window.scrollTo(0, 0);
    setOperationError('');
    setPersistenceNotice('');
    setErrorDialogOpen(false);
    snapshotRef.current = next;
    setSnapshot(next);
    setRecoveryProjectId(next.projectId);
    localStorage.setItem('dungeon-scrivener-last-project', next.projectId);
    workspaceRef.current = createSageWorkspace(next);
    setRevision(value => value + 1);
    setAcknowledged(new Set());
    setUnsavedSince(unsaved ? Date.now() : undefined);
    setReminderVisible(false);
    setReminderDismissedFor(undefined);
    setRequestedLocale(undefined);
    const openedWorld = parseFile(next, 'world.json') as WorldDocument | undefined;
    setSelectedNodeId(openedWorld?.entryNodeId);
    setInspectorTab('scene');
    setMode(initialMode);
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
    workspaceRef.current = createSageWorkspace(updated);
    setUnsavedSince(Date.now());
    setReminderVisible(false);
    setStatus('Apprentice changes saved to the project.');
    setRevision(value => value + 1);
  }

  function updateGraphPositions(positions: GraphPositions): void {
    const current = snapshotRef.current;
    if (!current) return;
    const bytes = encoder.encode(JSON.stringify({ schemaVersion: 1, positions }, null, 2));
    const files = [...current.files.values()].filter(file => file.path !== GRAPH_LAYOUT_PATH);
    files.push({ path: GRAPH_LAYOUT_PATH, bytes, role: 'arbitrary' });
    const updated = createSnapshot(files, current.directories);
    snapshotRef.current = updated;
    setSnapshot(updated);
    workspaceRef.current = createSageWorkspace(updated);
    setUnsavedSince(Date.now());
    setReminderVisible(false);
    setRevision(value => value + 1);
  }

  function updateLocales(nextLocales: readonly LocaleDocument[]): void {
    const current = snapshotRef.current;
    if (!current) return;
    const replacements = new Map(nextLocales.map(locale => [`locales/${locale.locale}.json`, encoder.encode(JSON.stringify(locale, null, 2))]));
    const files = [...current.files.values()].map(file => replacements.has(file.path)
      ? { ...file, bytes: replacements.get(file.path)! } : file);
    for (const [path, bytes] of replacements) if (!current.files.has(path)) files.push({ path, bytes, role: 'locale' });
    const updated = createSnapshot(files, current.directories);
    snapshotRef.current = updated;
    setSnapshot(updated);
    workspaceRef.current = createSageWorkspace(updated);
    setUnsavedSince(Date.now());
    setReminderVisible(false);
    setRevision(value => value + 1);
  }

  async function importMediaAsset(file: File): Promise<RegisteredAsset> {
    const current = snapshotRef.current;
    if (!current) throw new Error('No project is open.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const media = createMediaAssetCatalog();
    const asset = await media.registerAsset({ bytes, originalFilename: file.name });
    const path = `assets/sha256/${asset.assetId.slice('sha256:'.length)}`;
    if (!current.files.has(path)) {
      const updated = createSnapshot([...current.files.values(), { path, bytes, role: 'asset' }], current.directories);
      snapshotRef.current = updated;
      setSnapshot(updated);
      workspaceRef.current = createSageWorkspace(updated);
      setUnsavedSince(Date.now());
      setReminderVisible(false);
      setRevision(value => value + 1);
    }
    return asset;
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
    return <div className="landing">
      <div className="landing-topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">✦</span><span>DungeonScrivener</span></div><span className="landing-topbar__meta">THE INTERPRETER <span aria-hidden="true">/</span> AUTHORING STUDIO</span></div>
      <main className="home">
      <section className="home-intro" aria-labelledby="home-title">
        <p className="eyebrow"><span className="eyebrow-line" /> A place to make worlds</p>
        <h1 id="home-title">DungeonScrivener</h1>
        <p className="home-intro__lead">Turn a story into a place someone can explore.</p>
        <p>Write scenes, connect paths, test every turn, then share a game that runs straight from a ZIP. Nothing is uploaded. Download a project ZIP to keep an editable copy.</p>
        <div className="home-steps" aria-label="How it works">
          <div><span>01</span><strong>Shape the story</strong><small>Write in files or build a scene map.</small></div>
          <div><span>02</span><strong>Walk the paths</strong><small>Playtest choices, commands, and state.</small></div>
          <div><span>03</span><strong>Send it out</strong><small>Export a portable game for readers.</small></div>
        </div>
      </section>
      <section className="home-panel" aria-labelledby="new-project-title">
        <div className="home-panel__heading"><span className="eyebrow">YOUR NEXT CHAPTER</span><h2 id="new-project-title">Begin a project</h2><p>Start with a small playable story. You can change it as you learn.</p></div>
        <div className="home-form">
        <label>Project title<input value={newTitle} onChange={event => setNewTitle(event.currentTarget.value)} required /></label>
        <label>Default language<select defaultValue="en-GB" disabled aria-describedby="default-language-help"><option value="en-GB">English (en-GB)</option></select></label>
        <span className="field-help" id="default-language-help">The starter story is available in English (en-GB).</span>
        <label>Game version<input value={newVersion} onChange={event => setNewVersion(event.currentTarget.value)} required aria-describedby="game-version-help" /></label>
        <span className="field-help" id="game-version-help">Use a semantic version such as 1.0.0. Saves use it for compatibility.</span>
        {newProjectError && <p role="alert">{newProjectError}</p>}
        <button className="button-primary home-create" onClick={() => {
        const title = newTitle.trim();
        if (!title) { setNewProjectError('Enter a project title.'); return; }
        const projectId = `project-${crypto.randomUUID()}`;
        const manifestResult = validateProjectManifest({ ...linearManifest, title, gameVersion: newVersion.trim(), defaultLocale: 'en-GB', projectId });
        if (!manifestResult.ok || !manifestResult.value) {
          setNewProjectError(manifestResult.diagnostics.map(item => `${item.code}: ${item.message}`).join(' ') || 'The project manifest is invalid.');
          return;
        }
        setNewProjectError('');
        openProject(snapshotFromData(manifestResult.value, linearWorld, { 'locales/en-GB.json': linearLocale }), 'Starter project created.', true, 'apprentice');
        if (shouldOfferStudioTour()) { setTourKind('studio'); setTourPhase('invite'); }
      }}>Create project</button>
        </div>
        <div className="home-import"><div><strong>Already have a project?</strong><span>Bring your editable ZIP back into the studio.</span></div><label className={`button${importing ? ' is-disabled' : ''}`} aria-busy={importing}>Import project ZIP<input type="file" accept=".zip,application/zip" disabled={importing} onChange={event => void importZip(event.currentTarget.files?.[0])} /></label></div>
      {importing && <p role="status" aria-live="polite">Importing project ZIP. Please wait.</p>}
      {recoveryAvailable && <div className="home-recovery"><span>A local recovery copy is available on this device.</span><button onClick={() => void restoreRecovery()}>Restore recovery</button></div>}
      {status && <p role="status">{status}</p>}
      </section>
      </main>
      <footer className="landing-footer"><span>CRAFTED FOR STORIES THAT BRANCH</span><span>LOCAL FIRST · PORTABLE BY DESIGN</span></footer>
    </div>;
  }

  const workspace = workspaceRef.current;
  function markUnsaved(): void { setUnsavedSince(Date.now()); setReminderVisible(false); setReminderDismissedFor(undefined); }

  return <div className="studio">
    <a className="skip-link" href="#studio-workspace">Skip to project workspace</a>
    <header className="studio-header">
      <div className="studio-header__identity"><div className="brand"><span className="brand-mark" aria-hidden="true">✦</span><span>DungeonScrivener</span></div><button className="studio-projects" onClick={() => setMode('home')}>Projects</button><span className="studio-header__divider" aria-hidden="true">/</span><div data-tour="project-heading" className="studio-project-name"><strong>{manifest?.title ?? manifest?.projectId ?? 'Untitled project'}</strong><span>v{manifest?.gameVersion ?? '1.0.0'}</span></div></div>
      <div className="studio-header__learning"><button className="tour-replay" onClick={() => { setTourKind('studio'); setTourPhase('tour'); }}>Take the tour</button><button className="tour-replay" onClick={() => { setTourKind('tutorial'); setTourPhase('invite'); }}>Game tutorial</button></div>
    </header>
    <div className="studio-commandbar">
      <nav data-tour="mode-switch" className="mode-nav" aria-label="Editing modes">
        <button aria-pressed={mode === 'sage'} onClick={() => { const current = snapshotRef.current ?? snapshot; if (current) { if (!workspaceRef.current || workspaceRef.current.getState().snapshot !== current) workspaceRef.current = createSageWorkspace(current); setStatus('Sage Mode is using the current project snapshot.'); } setTourPhase(null); setMode('sage'); }}>Sage</button>
        <button aria-pressed={mode === 'apprentice'} onClick={() => { setTourPhase(null); setMode('apprentice'); }}>Apprentice</button>
      </nav>
      <nav className="studio-actions" aria-label="Studio actions">
        <button data-tour="playtest-action" onClick={() => requestAction('play', () => { void startPlaytest(); })}>Playtest</button>
        <button onClick={() => requestAction('play', () => { void startPlay(); })}>Play</button>
        <button data-tour="project-download" onClick={() => requestAction('save-project', () => { void saveZip(); })}>Download project ZIP</button>
        <button data-tour="game-export" className="button-primary" onClick={() => requestAction('export', () => setExportDialogOpen(true))}>Export game ZIP</button>
      </nav>
    </div>
    <section className="workspace-heading" aria-label="Current workspace"><div><p className="eyebrow">{mode === 'sage' ? 'THE FILE DESK' : mode === 'apprentice' ? 'THE STORY MAP' : mode === 'playtest' ? 'THE TEST CHAMBER' : 'THE READER VIEW'}</p><div className="workspace-heading__title"><h1>{mode === 'sage' ? 'Sage' : mode === 'apprentice' ? 'Apprentice' : mode === 'playtest' ? 'Playtest' : 'Play'}</h1><p>{mode === 'sage' ? 'Edit the project at its source.' : mode === 'apprentice' ? 'Shape scenes and their connections.' : mode === 'playtest' ? 'Try a run and inspect what happened.' : 'Experience the story as a reader.'}</p></div></div><div className="workspace-heading__aside"><span className="workspace-heading__project">CURRENT PROJECT · {manifest?.title ?? manifest?.projectId ?? 'Untitled project'}</span><button type="button" onClick={() => { setTourKind(mode); setTourPhase('tour'); }}>Tour this view</button></div></section>
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
    {mode === 'sage' && workspace && <SageMode workspace={workspace} showExport={false} onStateChange={state => {
      if (state.snapshot !== snapshotRef.current) {
        snapshotRef.current = state.snapshot;
        setSnapshot(state.snapshot);
        markUnsaved();
        setRevision(value => value + 1);
      }
    }} />}
    {mode === 'apprentice' && world && <div className="apprentice-workbench">
      <div className="apprentice-map"><ApprenticeGraph world={world} positions={graphPositions} onPositionsChange={updateGraphPositions} {...(selectedNodeId ? { selectedNodeId } : {})}
        nodeLabels={Object.fromEntries(world.nodes.map(node => [node.id, node.title.kind === 'literal' ? node.title.text : locales.find(locale => locale.locale === manifest?.defaultLocale)?.strings[node.title.key] ?? node.title.key]))}
        onSelectNode={nodeId => { setSelectedNodeId(nodeId); setInspectorTab('scene'); }} onWorldChange={updateWorld} /></div>
      <aside className="apprentice-inspector" aria-label="Story inspector">
        <div className="apprentice-inspector__heading"><span className="eyebrow">THE INSPECTOR</span><h2>{inspectorTab === 'scene' ? 'Scene details' : inspectorTab === 'world' ? 'World settings' : 'Scripts'}</h2></div>
        <div className="apprentice-inspector__tabs" role="tablist" aria-label="Inspector sections">
          <button role="tab" aria-selected={inspectorTab === 'scene'} onClick={() => setInspectorTab('scene')}>Scene</button>
          <button role="tab" aria-selected={inspectorTab === 'world'} onClick={() => setInspectorTab('world')}>World</button>
          <button role="tab" aria-selected={inspectorTab === 'scripts'} onClick={() => setInspectorTab('scripts')}>Scripts</button>
        </div>
        {inspectorTab !== 'scripts' && <ApprenticeForms world={world} view={inspectorTab} {...(selectedNodeId ? { selectedNodeId } : {})} onWorldChange={updateWorld}
          project={snapshot} locales={locales} defaultLocale={manifest?.defaultLocale}
          assets={diagnosticMedia?.snapshot === snapshot ? diagnosticMedia.media.listAssets() : []}
          mediaAssets={diagnosticMedia?.snapshot === snapshot ? diagnosticMedia.media : undefined}
          onLocalesChange={updateLocales} onImportAsset={importMediaAsset} />}
        {inspectorTab === 'scripts' && <ApprenticeScripts world={world} project={snapshot} onEditInSage={path => {
          const current = snapshotRef.current ?? snapshot;
          workspaceRef.current = createSageWorkspace(current, path);
          setMode('sage');
        }} />}
      </aside>
    </div>}
    {mode === 'playtest' && world && playSnapshot && activeEngine && <PlaytestDebugger world={world} initialSnapshot={playSnapshot}
      localeStrings={locales.find(locale => locale.locale === manifest?.defaultLocale)?.strings ?? {}}
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
      <div className="diagnostics__heading"><strong>Project diagnostics</strong><span className={report.diagnostics.length ? 'diagnostics__count has-issues' : 'diagnostics__count'}>{report.diagnostics.length ? `${report.diagnostics.length} to review` : 'All clear'}</span></div>
      {report.diagnostics.length ? <ul>{report.diagnostics.map((item, index) => <li key={`${item.code}:${index}`}>{item.severity}: {item.code}: {diagnosticMessage(item, world, locales.find(locale => locale.locale === manifest?.defaultLocale))}</li>)}</ul> : <p>No diagnostics.</p>}
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
    <StudioTour phase={tourPhase} kind={tourKind} mode={mode} onModeChange={setMode} onClose={(outcome, kind) => {
      if (kind === 'studio' && outcome === 'finished') {
        setMode(localStorage.getItem('dungeon-scrivener-preferred-mode') === 'sage' ? 'sage' : 'apprentice');
        if (localStorage.getItem('dungeon-scrivener-tutorial-tour-v1') === null) { setTourKind('tutorial'); setTourPhase('invite'); return; }
      }
      setTourPhase(null);
    }} onStart={() => setTourPhase('tour')} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
