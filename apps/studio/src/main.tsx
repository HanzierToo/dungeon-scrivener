import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprenticeForms, ApprenticeGraph, ApprenticeScripts, emptyGraphLayout, parseGraphLayout, type GraphLayout } from '@dungeon-scrivener/apprentice';
import { PlaytestDebugger } from '@dungeon-scrivener/debugger';
import { collectDiagnostics, getAcknowledgementStatus } from '@dungeon-scrivener/diagnostics';
import { createGameEngine } from '@dungeon-scrivener/engine';
import { exportGame } from '@dungeon-scrivener/exporter';
import { createMediaAssetCatalog, type RegisteredAsset } from '@dungeon-scrivener/media';
import { computeContentFingerprint, resolveNodeActions, validateProject, validateProjectManifest, type CompiledScriptBundle, type Diagnostic, type LocaleDocument, type PlayerSaveArchive, type ProjectFile, type ProjectManifest, type ProjectVfsSnapshot, type SaveCompatibilityTarget, type SessionSnapshot, type WorldDocument } from '@dungeon-scrivener/model';
import { clearRecovery, loadRecovery, saveRecovery } from '@dungeon-scrivener/persistence';
import { addProjectFile, readProjectFile, readProjectZip, replaceProjectFile, writeProjectZip, createSnapshot } from '@dungeon-scrivener/vfs';
import { SageMode, SageWorkspace } from '@dungeon-scrivener/sage';
import { EnginePlayer, isOfflineSafeTheme, PORTABLE_PLAYER_ENGINE_VERSION } from '@dungeon-scrivener/player';
import { downloadPlayerSave, getSaveSlotChoices, importHostedSaveFile } from '@dungeon-scrivener/player-save';
import { getPortablePlayerArtifact } from '@dungeon-scrivener/player/portable-artifact';
import { compileWorldScripts, scriptExecutor } from '@dungeon-scrivener/scripting';
import { shouldOfferModeTour, shouldOfferStudioTour, StudioTour, type TourKind, type TourPhase } from './StudioTour.js';
import { StudioErrorBoundary } from './StudioErrorBoundary.js';
import { ashenLayout, ashenLocale, ashenManifest, ashenWorld } from './examples/ashen-bell.js';
import { SamplePreview } from './examples/SamplePreview.js';
import linearManifest from '../../../fixtures/linear-three-nodes/project.json';
import linearWorld from '../../../fixtures/linear-three-nodes/world.json';
import linearLocale from '../../../fixtures/linear-three-nodes/locales/en-GB.json';
import readmeTemplate from '../../../docs/exports/README.template.md?raw';
import '@xyflow/react/dist/style.css';
import './studio.css';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const GRAPH_LAYOUT_PATH = 'studio/graph-layout.json';
let lastAuthorSnapshot: ProjectVfsSnapshot | null = null;
const starterWorld = {
  ...linearWorld,
  nodes: [
    {
      ...linearWorld.nodes[0],
      actions: { choices: [
        ...(linearWorld.nodes[0]!.actions?.choices ?? []),
        { id: 'climb-watchtower', label: { kind: 'literal', text: 'Climb to the watchtower' }, effects: [], navigationEdgeId: 'gate-to-tower' },
      ] },
    },
    ...linearWorld.nodes.slice(1),
    {
      id: 'watchtower', parentId: null, visitable: true,
      title: { kind: 'literal', text: 'The Watchtower' },
      content: { kind: 'literal', text: 'From above, you spot a safe way across the river. Type “descend” to return to the bridge.' },
      actions: { commands: [{ id: 'descend-tower', patterns: ['descend'], parameters: [], effects: [], navigationEdgeId: 'tower-to-bridge' }] },
    },
  ],
  navigationEdges: [
    ...linearWorld.navigationEdges,
    { id: 'gate-to-tower', fromNodeId: 'old-gate', toNodeId: 'watchtower' },
    { id: 'tower-to-bridge', fromNodeId: 'watchtower', toNodeId: 'stone-bridge' },
  ],
};
type Mode = 'home' | 'sage' | 'apprentice' | 'playtest' | 'play';
type PreparedProject = { snapshot: ProjectVfsSnapshot; manifest: ProjectManifest; world: WorldDocument; locales: LocaleDocument[]; scripts: CompiledScriptBundle; media: ReturnType<typeof createMediaAssetCatalog>; resolvedMedia: import('@dungeon-scrivener/model').ResolvedMediaAsset[]; themeCss: string };
type PlayConfig = { scripts: CompiledScriptBundle; media: ReturnType<typeof createMediaAssetCatalog>; compatibility: SaveCompatibilityTarget; themeCss: string };
type StudioAction = 'save-project' | 'play' | 'export';

function snapshotFromData(manifest: unknown, world: unknown, locales: Record<string, unknown> = {}, layout?: GraphLayout): ProjectVfsSnapshot {
  const files: ProjectFile[] = [
    { path: 'project.json', bytes: encoder.encode(JSON.stringify(manifest, null, 2)), role: 'manifest' as const },
    { path: 'world.json', bytes: encoder.encode(JSON.stringify(world, null, 2)), role: 'world' as const },
    { path: GRAPH_LAYOUT_PATH, bytes: encoder.encode(JSON.stringify(layout ?? { schemaVersion: 2, positions: {
      'old-gate': { x: 0, y: 0 },
      'stone-bridge': { x: -240, y: 240 },
      'watchtower': { x: 240, y: 240 },
      'lantern-house': { x: 0, y: 480 },
    }, sections: [] }, null, 2)), role: 'arbitrary' as const },
    ...Object.entries(locales).map(([path, locale]) => ({ path, bytes: encoder.encode(JSON.stringify(locale, null, 2)), role: 'locale' as const })),
  ];
  return createSnapshot(files);
}

function parseFile(snapshot: ProjectVfsSnapshot, path: string): unknown {
  const file = snapshot.files.get(path);
  if (!file) return undefined;
  try { return JSON.parse(decoder.decode(file.bytes)); } catch { return undefined; }
}

function readGraphLayout(snapshot: ProjectVfsSnapshot): GraphLayout | null {
  const layout = parseFile(snapshot, GRAPH_LAYOUT_PATH);
  return layout === undefined ? emptyGraphLayout() : parseGraphLayout(layout);
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
  const [samplePlaying, setSamplePlaying] = useState(false);
  const [snapshot, setSnapshot] = useState<ProjectVfsSnapshot | null>(null);
  const projectHistory = useRef<{ current: ProjectVfsSnapshot | null; past: ProjectVfsSnapshot[]; future: ProjectVfsSnapshot[]; restoring: boolean }>({ current: null, past: [], future: [], restoring: false });
  const [historyRevision, setHistoryRevision] = useState(0);
  useEffect(() => {
    const history = projectHistory.current;
    if (snapshot === history.current) return;
    if (!snapshot || snapshot.projectId !== history.current?.projectId) { history.past = []; history.future = []; }
    else if (!history.restoring && history.current) { history.past = [...history.past.slice(-59), history.current]; history.future = []; }
    history.current = snapshot;
    history.restoring = false;
    setHistoryRevision(value => value + 1);
  }, [snapshot]);

  const [analysisSnapshot, setAnalysisSnapshot] = useState<ProjectVfsSnapshot | null>(null);
  const [diagnosticQuery, setDiagnosticQuery] = useState('');
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('');
  useEffect(() => { if (!status) return; const timer = window.setTimeout(() => setStatus(''), 3000); return () => window.clearTimeout(timer); }, [status]);
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
  const [actionFocus, setActionFocus] = useState<{ kind: 'choice' | 'command'; id: string; outcomeId?: string | undefined; request: number }>();
  const [requestedWorldSection, setRequestedWorldSection] = useState<{ section: string; entityId?: string | undefined; request: number }>();
  const [selectedDiagnostic, setSelectedDiagnostic] = useState<Diagnostic>();
  const [inspectorTab, setInspectorTab] = useState<'scene' | 'actions' | 'text' | 'logic' | 'world' | 'scripts'>('scene');
  const [inspectorWidth, setInspectorWidth] = useState(440);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const [starterGuideVisible, setStarterGuideVisible] = useState(() => localStorage.getItem('dungeon-scrivener-starter-guide-v1') !== 'dismissed');
  const apprenticeWorkbenchRef = useRef<HTMLDivElement>(null);
  const resizingInspector = useRef(false);
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
  if (snapshotRef.current ?? snapshot) lastAuthorSnapshot = snapshotRef.current ?? snapshot;

  useEffect(() => {
    const reportUnexpected = (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason ?? 'An unexpected error occurred.');
      setOperationError(`Unexpected Studio error: ${message}`);
      setStatus(`Unexpected Studio error: ${message}`);
      setErrorDialogOpen(true);
      setTourPhase(null);
      if (mode === 'play' || mode === 'playtest') setMode('apprentice');
    };
    const onError = (event: ErrorEvent) => {
      // Browsers report ResizeObserver layout-cycle notices through window.error.
      // They are nonfatal and opening a modal here interrupts map interactions.
      if (/^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/.test(event.message)) return;
      reportUnexpected(event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => reportUnexpected(event.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, [mode]);
  const manifestFile = snapshot?.files.get('project.json');
  const worldFile = snapshot?.files.get('world.json');
  const layoutFile = snapshot?.files.get(GRAPH_LAYOUT_PATH);
  const manifest = useMemo(() => snapshot ? parseFile(snapshot, 'project.json') as ProjectManifest | undefined : undefined, [manifestFile]);
  const worldCache = useRef<{ file: ProjectFile; value: WorldDocument } | undefined>(undefined);
  const world = useMemo(() => {
    if (!snapshot || !worldFile) return undefined;
    if (worldCache.current?.file === worldFile) return worldCache.current.value;
    const value = parseFile(snapshot, 'world.json') as WorldDocument | undefined;
    if (value) worldCache.current = { file: worldFile, value };
    return value;
  }, [worldFile]);
  const graphLayout = useMemo(() => snapshot ? readGraphLayout(snapshot) : emptyGraphLayout(), [layoutFile]);
  const localeCache = useRef(new Map<string, { file: ProjectFile; value: LocaleDocument | undefined }>());
  const previousLocales = useRef<LocaleDocument[]>([]);
  const locales = useMemo(() => {
    const next: LocaleDocument[] = [];
    for (const [path, file] of snapshot?.files ?? []) {
      if (!/^locales\/[^/]+\.json$/u.test(path)) continue;
      const cached = localeCache.current.get(path);
      const value = cached?.file === file ? cached.value : parseFile(snapshot!, path) as LocaleDocument | undefined;
      localeCache.current.set(path, { file, value });
      if (value && typeof value === 'object' && 'locale' in value) next.push(value);
    }
    if (next.length === previousLocales.current.length && next.every((value, index) => value === previousLocales.current[index])) return previousLocales.current;
    previousLocales.current = next;
    return next;
  }, [snapshot]);
  const analysisManifest = useMemo(() => analysisSnapshot ? parseFile(analysisSnapshot, 'project.json') as ProjectManifest | undefined : undefined, [analysisSnapshot]);
  const analysisWorld = useMemo(() => analysisSnapshot ? parseFile(analysisSnapshot, 'world.json') as WorldDocument | undefined : undefined, [analysisSnapshot]);
  const analysisLocales = useMemo(() => analysisSnapshot ? [...analysisSnapshot.files.keys()]
    .filter(path => /^locales\/[^/]+\.json$/u.test(path))
    .map(path => parseFile(analysisSnapshot, path))
    .filter((item): item is LocaleDocument => typeof item === 'object' && item !== null && 'locale' in item) : [], [analysisSnapshot]);
  const analysisLocaleMap = useMemo(() => Object.fromEntries(analysisLocales.map(locale => [`locales/${locale.locale}.json`, locale])), [analysisLocales]);
  const assetHashes = useMemo(() => new Set([...(analysisSnapshot?.files.keys() ?? [])].flatMap(path => {
    const match = /^assets\/sha256\/([a-f0-9]{64})$/u.exec(path);
    return match ? [match[1]!] : [];
  })), [analysisSnapshot]);
  const report = useMemo(() => analysisManifest && analysisWorld && analysisSnapshot && diagnosticMedia?.snapshot === analysisSnapshot
    ? collectDiagnostics({ manifest: analysisManifest, world: analysisWorld, locales: analysisLocaleMap, filePaths: new Set(analysisSnapshot.files.keys()), assetHashes, assets: diagnosticMedia.media, additionalDiagnostics: diagnosticMedia.diagnostics })
    : undefined, [analysisManifest, analysisWorld, analysisLocaleMap, analysisSnapshot, assetHashes, diagnosticMedia]);
  const visibleDiagnostics = useMemo(() => report?.diagnostics.filter(item =>
    `${item.severity} ${item.code} ${item.path ?? ''} ${item.message}`.toLocaleLowerCase().includes(diagnosticQuery.trim().toLocaleLowerCase())) ?? [], [report, diagnosticQuery]);
  const visibleDiagnosticPage = Math.min(diagnosticPage, Math.max(0, Math.ceil(visibleDiagnostics.length / 50) - 1));
  const activeEngine = useMemo(() => playConfig ? createGameEngine({
    scriptExecutor, mediaAssets: playConfig.media,
    seededSeedSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! },
    unseededRandomSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! },
  }, playConfig.scripts) : undefined, [playConfig]);

  useEffect(() => {
    if (!inspectorExpanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setInspectorExpanded(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', onKeyDown); };
  }, [inspectorExpanded]);

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
    if (!snapshot) { setAnalysisSnapshot(null); return; }
    const timer = window.setTimeout(() => setAnalysisSnapshot(snapshot), 350);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  useEffect(() => {
    if (!analysisSnapshot || !analysisWorld) return;
    let active = true;
    const media = createMediaAssetCatalog();
    void (async () => {
      const diagnostics: Diagnostic[] = [];
      const referenced = referencedMedia(analysisWorld, analysisLocales);
      const assetPaths = [...analysisSnapshot.files.keys()].filter(path => /^assets\/sha256\/[a-f0-9]{64}$/u.test(path));
      for (const path of assetPaths) {
        const file = readProjectFile(analysisSnapshot, path);
        if (!file) continue;
        const assetId = `sha256:${path.slice('assets/sha256/'.length)}` as `sha256:${string}`;
        try { await media.registerAsset({ bytes: file.bytes, originalFilename: 'managed-asset', expectedAssetId: assetId }); }
        catch (error) {
          if (referenced.has(assetId)) diagnostics.push({ code: 'DS-MEDIA-001', severity: 'error', message: `${path}: ${error instanceof Error ? error.message : 'Asset registration failed.'}`, path, blocks: ['play', 'export'] });
        }
      }
      for (const assetId of referenced) {
        const path = `assets/sha256/${assetId.slice('sha256:'.length)}`;
        if (!analysisSnapshot.files.has(path)) diagnostics.push({ code: 'DS-MEDIA-MISSING', severity: 'error', message: `Referenced media asset is missing: ${path}`, path, blocks: ['play', 'export'] });
      }
      if (active) setDiagnosticMedia({ snapshot: analysisSnapshot, media, diagnostics });
    })();
    return () => { active = false; };
  }, [analysisSnapshot, analysisWorld, analysisLocales]);

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
    projectHistory.current = { current: next, past: [], future: [], restoring: false };
    setHistoryRevision(value => value + 1);
    window.scrollTo(0, 0);
    setOperationError('');
    setPersistenceNotice('');
    setErrorDialogOpen(false);
    snapshotRef.current = next;
    setSnapshot(next);
    setRecoveryProjectId(next.projectId);
    localStorage.setItem('dungeon-scrivener-last-project', next.projectId);
    workspaceRef.current = initialMode === 'sage' ? createSageWorkspace(next) : null;
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

  function currentReport(): readonly Diagnostic[] {
    const current = snapshotRef.current ?? snapshot;
    if (!current) return [];
    if (current === analysisSnapshot && report) return report.diagnostics;
    const currentManifest = parseFile(current, 'project.json');
    const currentWorld = parseFile(current, 'world.json');
    const currentLocales = Object.fromEntries([...current.files.keys()]
      .filter(path => /^locales\/[^/]+\.json$/u.test(path)).map(path => [path, parseFile(current, path)]));
    return collectDiagnostics({ manifest: currentManifest, world: currentWorld, locales: currentLocales,
      filePaths: new Set(current.files.keys()), assetHashes: new Set([...current.files.keys()].flatMap(path => {
        const match = /^assets\/sha256\/([a-f0-9]{64})$/u.exec(path);
        return match ? [match[1]!] : [];
      })) }).diagnostics;
  }

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
    const diagnostics = currentReport();
    const decision = getAcknowledgementStatus(diagnostics, action, acknowledged);
    if (!decision.required || decision.acknowledged) { run(); return; }
    const pending = diagnostics.filter(item => item.severity === 'warning' && item.acknowledgementRequired?.includes(action) && !acknowledged.has(item.code));
    setConfirmation({ action, warnings: pending, run });
  }

  async function saveZip(): Promise<void> {
    const current = snapshotRef.current ?? snapshot;
    if (!current) return;
    try {
      download(await writeProjectZip(current), `${manifest?.projectId ?? current.projectId}.zip`, 'application/zip');
      await clearRecovery(current.projectId);
      setRecoveryAvailable(false);
      setUnsavedSince(undefined);
      setReminderVisible(false);
      setStatus('Project ZIP downloaded.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Project ZIP could not be written.');
    }
  }

  function restoreProjectEdit(direction: 'undo' | 'redo'): void {
    const history = projectHistory.current;
    const current = snapshotRef.current;
    const source = direction === 'undo' ? history.past : history.future;
    const next = source.at(-1);
    if (!current || !next) return;
    source.pop();
    (direction === 'undo' ? history.future : history.past).push(current);
    history.restoring = true;
    snapshotRef.current = next;
    setSnapshot(next);
    workspaceRef.current = null;
    setUnsavedSince(Date.now());
    setRevision(value => value + 1);
    setStatus(direction === 'undo' ? 'Project edit undone.' : 'Project edit restored.');
  }

  function updateWorld(next: WorldDocument): void {
    if (!snapshot) return;
    const current = snapshotRef.current ?? snapshot;
    const updated = replaceProjectFile(current, 'world.json', encoder.encode(JSON.stringify(next, null, 2)));
    worldCache.current = { file: updated.files.get('world.json')!, value: next };
    snapshotRef.current = updated;
    setSnapshot(updated);
    workspaceRef.current = null;
    setUnsavedSince(Date.now());
    setReminderVisible(false);
    setStatus('Apprentice changes saved to the project.');
    setRevision(value => value + 1);
  }

  function updateGraphLayout(layout: GraphLayout): void {
    const current = snapshotRef.current;
    if (!current) return;
    if (readGraphLayout(current) === null) { setStatus('This project uses an unsupported map layout version. Edit it in Sage before changing map positions or sections.'); return; }
    const bytes = encoder.encode(JSON.stringify(layout, null, 2));
    const updated = current.files.has(GRAPH_LAYOUT_PATH)
      ? replaceProjectFile(current, GRAPH_LAYOUT_PATH, bytes)
      : addProjectFile(current, { path: GRAPH_LAYOUT_PATH, bytes, role: 'arbitrary' });
    snapshotRef.current = updated;
    setSnapshot(updated);
    workspaceRef.current = null;
    setUnsavedSince(Date.now());
    setReminderVisible(false);
    setRevision(value => value + 1);
  }

  function updateLocales(nextLocales: readonly LocaleDocument[]): void {
    const current = snapshotRef.current;
    if (!current) return;
    let updated = current;
    for (const locale of nextLocales) {
      if (locales.some(existing => existing.locale === locale.locale && existing === locale)) continue;
      const path = `locales/${locale.locale}.json`;
      const bytes = encoder.encode(JSON.stringify(locale, null, 2));
      updated = updated.files.has(path)
        ? replaceProjectFile(updated, path, bytes)
        : addProjectFile(updated, { path, bytes, role: 'locale' });
    }
    if (updated === current) return;
    snapshotRef.current = updated;
    setSnapshot(updated);
    workspaceRef.current = null;
    setUnsavedSince(Date.now());
    setReminderVisible(false);
    setRevision(value => value + 1);
  }

  function updateProjectContent(nextWorld: WorldDocument, nextLocales: readonly LocaleDocument[]): void {
    const current = snapshotRef.current;
    if (!current) return;
    let updated = nextWorld === world ? current : replaceProjectFile(current, 'world.json', encoder.encode(JSON.stringify(nextWorld, null, 2)));
    for (const locale of nextLocales) {
      if (locales.some(existing => existing.locale === locale.locale && existing === locale)) continue;
      const path = `locales/${locale.locale}.json`;
      const bytes = encoder.encode(JSON.stringify(locale, null, 2));
      updated = updated.files.has(path)
        ? replaceProjectFile(updated, path, bytes)
        : addProjectFile(updated, { path, bytes, role: 'locale' });
    }
    if (updated === current) return;
    if (nextWorld !== world) worldCache.current = { file: updated.files.get('world.json')!, value: nextWorld };
    snapshotRef.current = updated;
    setSnapshot(updated);
    workspaceRef.current = null;
    setUnsavedSince(Date.now());
    setReminderVisible(false);
    setStatus('Apprentice changes saved to the project.');
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
      workspaceRef.current = null;
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

  if (samplePlaying) return <SamplePreview onClose={() => setSamplePlaying(false)} />;

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
        <section className="home-sample" aria-labelledby="sample-title"><span className="eyebrow">PLAY A COMPLETE EXAMPLE</span><h2 id="sample-title">The Ashen Bell</h2><p>At dusk, a flood threatens a village whose warning bell has fallen silent. Follow the story, then open an editable copy to see its states, dialogue, commands, and branching endings.</p><div><button type="button" className="button-primary" onClick={() => setSamplePlaying(true)}>Play example</button><button type="button" onClick={() => {
          if (unsavedSince && !window.confirm('This project has work that has not been downloaded as a ZIP. Open an editable copy of the example anyway?')) return;
          const manifest = { ...ashenManifest, projectId: `project-${crypto.randomUUID()}` };
          openProject(snapshotFromData(manifest, ashenWorld, { 'locales/en-GB.json': ashenLocale }, ashenLayout), 'Editable copy of The Ashen Bell opened.', true, 'apprentice');
        }}>Open editable copy</button></div><a href="/examples/ashen-bell-guide.md" target="_blank" rel="noreferrer">Sample guide</a></section>
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
        openProject(snapshotFromData(manifestResult.value, starterWorld, { 'locales/en-GB.json': linearLocale }), 'Starter project created.', true, 'apprentice');
        if (shouldOfferStudioTour()) { setTourKind('studio'); setTourPhase('invite'); }
      }}>Create project</button>
        </div>
        <div className="home-import"><div><strong>Already have a project?</strong><span>Bring your editable ZIP back into the studio.</span></div><label className={`button${importing ? ' is-disabled' : ''}`} aria-busy={importing}>Import project ZIP<input type="file" accept=".zip,application/zip" disabled={importing} onChange={event => void importZip(event.currentTarget.files?.[0])} /></label></div>
      {importing && <p role="status" aria-live="polite">Importing project ZIP. Please wait.</p>}
      {recoveryAvailable && <div className="home-recovery"><span>A local recovery copy is available on this device.</span><button onClick={() => void restoreRecovery()}>Restore recovery</button></div>}
      {status && <div className="studio-toast" role="status"><span>{status}</span><button type="button" aria-label="Dismiss notification" onClick={() => setStatus('')}>×</button></div>}
      </section>
      </main>
      <footer className="landing-footer"><span>CRAFTED FOR STORIES THAT BRANCH</span><span>LOCAL FIRST · PORTABLE BY DESIGN</span></footer>
    </div>;
  }

  function diagnosticTarget(item: Diagnostic) {
    const id = item.entityId;
    const pointer = /(?:at |at)(\/[^: ]*)/u.exec(item.message)?.[1] ?? '';
    const node = world?.nodes.find(node => node.id === id || node.actions?.choices?.some(action => action.id === id || action.outcomes?.some(outcome => outcome.id === id)) || node.actions?.commands?.some(action => action.id === id || action.outcomes?.some(outcome => outcome.id === id)));
    const edge = world?.navigationEdges.find(edge => edge.id === id);
    const source = node ?? world?.nodes.find(node => node.id === edge?.fromNodeId);
    if (source) {
      const actions = resolveNodeActions(world!, source.id).value;
      const choice = actions?.choices.find(action => action.id === id || action.outcomes?.some(outcome => outcome.id === id) || !!edge && (action.navigationEdgeId === edge.id || action.outcomes?.some(outcome => outcome.navigationEdgeId === edge.id)));
      const command = actions?.commands.find(action => action.id === id || action.outcomes?.some(outcome => outcome.id === id) || !!edge && (action.navigationEdgeId === edge.id || action.outcomes?.some(outcome => outcome.navigationEdgeId === edge.id)));
      return { nodeId: source.id, tab: choice || command || pointer.includes('/actions/') ? 'actions' as const : /state|rule|inherit|lifecycle/u.test(pointer) ? 'logic' as const : 'scene' as const,
        ...(choice ? { action: { kind: 'choice' as const, id: choice.id, outcomeId: choice.outcomes?.find(outcome => outcome.id === id || !!edge && outcome.navigationEdgeId === edge.id)?.id } } : command ? { action: { kind: 'command' as const, id: command.id, outcomeId: command.outcomes?.find(outcome => outcome.id === id || !!edge && outcome.navigationEdgeId === edge.id)?.id } } : {}) };
    }
    const sections = [
      ['rules', world?.rules], ['dialogue', world?.conversations], ['actors', world?.eventDefinitions], ['actors', world?.entities], ['actors', world?.entityDefinitions], ['inventory', world?.itemDefinitions], ['inventory', world?.initialInventory], ['scripts', world?.scripts],
    ] as const;
    const collection = sections.find(([, items]) => items?.some(entry => entry.id === id));
    const section = collection?.[0] ?? (/stateDefinitions|worldState|state key/u.test(`${pointer} ${item.message}`) ? 'state' : /conversation|dialogue/u.test(pointer) ? 'dialogue' : /event|entit/u.test(pointer) ? 'actors' : /item|inventory/u.test(pointer) ? 'inventory' : /actionDefaults/u.test(pointer) ? 'defaults' : /locale|translation|key.*missing from default/u.test(`${item.path} ${item.message}`) ? 'text' : 'state');
    return { section, tab: section === 'text' ? 'text' as const : section === 'scripts' ? 'scripts' as const : 'world' as const };
  }
  function diagnosticContext(item: Diagnostic): string {
    const target = diagnosticTarget(item);
    if ('nodeId' in target) {
      const node = world?.nodes.find(node => node.id === target.nodeId);
      const title = node?.title.kind === 'literal' ? node.title.text : node?.title.kind === 'locale-key' ? locales.find(locale => locale.locale === manifest?.defaultLocale)?.strings[node.title.key] ?? node.title.key : 'Scene';
      return `${title} / ${target.tab === 'actions' ? 'Player actions' : target.tab === 'logic' ? 'Scene logic' : 'Scene content'}`;
    }
    return target.tab === 'text' ? 'Text / Translations' : `World / ${target.section}`;
  }
  function openDiagnostic(item: Diagnostic): void {
    const path = item.path ?? 'world.json';
    if (mode === 'sage' || path !== 'world.json' && !path.startsWith('locales/') && path !== 'project.json') {
      workspaceRef.current = createSageWorkspace(snapshot!, path); setMode('sage'); return;
    }
    const target = diagnosticTarget(item);
    setMode('apprentice'); setInspectorCollapsed(false); setInspectorTab(target.tab); setSelectedDiagnostic(item);
    if ('nodeId' in target) { setSelectedNodeId(target.nodeId); setActionFocus('action' in target && target.action ? { ...target.action, request: Date.now() } : undefined); }
    else if (target.section !== 'text' && target.section !== 'scripts') setRequestedWorldSection({ section: target.section, entityId: item.entityId, request: Date.now() });
    window.setTimeout(() => document.querySelector<HTMLElement>('.apprentice-diagnostic-target')?.scrollIntoView({ block: 'nearest' }), 0);
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
      <nav className="studio-actions" aria-label="Studio actions" data-history-revision={historyRevision}>
        <button disabled={!projectHistory.current.past.length} onClick={() => restoreProjectEdit('undo')}>Undo project edit</button>
        <button disabled={!projectHistory.current.future.length} onClick={() => restoreProjectEdit('redo')}>Redo project edit</button>
        <button data-tour="playtest-action" onClick={() => requestAction('play', () => { void startPlaytest(); })}>Playtest</button>
        <button onClick={() => requestAction('play', () => { void startPlay(); })}>Play</button>
        <button data-tour="project-download" onClick={() => requestAction('save-project', () => { void saveZip(); })}>Download project ZIP</button>
        <button data-tour="game-export" className="button-primary" onClick={() => requestAction('export', () => setExportDialogOpen(true))}>Export game ZIP</button>
      </nav>
    </div>
    <section className="workspace-heading" aria-label="Current workspace"><div><p className="eyebrow">{mode === 'sage' ? 'THE FILE DESK' : mode === 'apprentice' ? 'THE STORY MAP' : mode === 'playtest' ? 'THE TEST CHAMBER' : 'THE READER VIEW'}</p><div className="workspace-heading__title"><h1>{mode === 'sage' ? 'Sage' : mode === 'apprentice' ? 'Apprentice' : mode === 'playtest' ? 'Playtest' : 'Play'}</h1><p>{mode === 'sage' ? 'Edit the project at its source.' : mode === 'apprentice' ? 'Shape scenes and their connections.' : mode === 'playtest' ? 'Try a run and inspect what happened.' : 'Experience the story as a reader.'}</p></div></div><div className="workspace-heading__aside"><span className="workspace-heading__project">CURRENT PROJECT · {manifest?.title ?? manifest?.projectId ?? 'Untitled project'}</span><button type="button" onClick={() => { setTourKind(mode); setTourPhase('tour'); }}>Tour this view</button></div></section>
    {status && <div className="studio-toast" role="status"><span>{status}</span><button type="button" aria-label="Dismiss notification" onClick={() => setStatus('')}>×</button></div>}
    {playActivity && mode === 'play' && <p className="status" data-testid="hosted-play-activity">{playActivity}</p>}
    {operationError && <p className="status" role="alert">{operationError}</p>}
    {unsavedSince !== undefined && reminderVisible && <aside className="save-reminder" role="status" aria-live="polite" aria-label="Unsaved work reminder">
      <p>You have unsaved project work. Download a project ZIP to keep a portable copy. Recovery is saved locally.</p>
      <button onClick={() => requestAction('save-project', () => { void saveZip(); })}>Download project ZIP</button>
      <button onClick={() => { setReminderVisible(false); setReminderDismissedFor(unsavedSince); }}>Dismiss reminder</button>
    </aside>}
    <a className="visually-hidden-focusable" href="#project-diagnostics">Skip to diagnostics</a>
    <StudioErrorBoundary onReturn={() => { setTourPhase(null); setMode(mode === 'apprentice' ? 'sage' : 'apprentice'); }} onDownload={saveZip}>
    <div id="studio-workspace" className="studio-workspace" role={mode === 'play' ? 'region' : 'main'} aria-label={mode === 'play' ? 'Game player' : 'Project workspace'} tabIndex={-1} onKeyDown={event => {
      if (mode !== 'apprentice' && mode !== 'sage' || event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
      if ((event.target as Element).closest('input, textarea, select, [contenteditable="true"], .cm-editor, .apprentice-map')) return;
      if (event.key.toLowerCase() === 'z' || event.ctrlKey && event.key.toLowerCase() === 'y') {
        event.preventDefault(); restoreProjectEdit(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
      }
    }}>
    {mode === 'sage' && workspace && <SageMode workspace={workspace} showExport={false} onStateChange={state => {
      if (state.snapshot !== snapshotRef.current) {
        snapshotRef.current = state.snapshot;
        setSnapshot(state.snapshot);
        markUnsaved();
        setRevision(value => value + 1);
      }
    }} />}
    {mode === 'apprentice' && world && <div ref={apprenticeWorkbenchRef} className={`apprentice-workbench${inspectorCollapsed ? ' is-collapsed' : ''}${inspectorExpanded ? ' is-expanded' : ''}`} style={{ '--inspector-width': `${inspectorWidth}px` } as React.CSSProperties}>
      <div className="apprentice-map"><ApprenticeGraph world={world} layout={graphLayout ?? emptyGraphLayout()} {...(graphLayout ? { onLayoutChange: updateGraphLayout } : {})} {...(selectedNodeId ? { selectedNodeId } : {})}
        localeStrings={locales.find(locale => locale.locale === manifest?.defaultLocale)?.strings ?? {}}
        nodeLabels={Object.fromEntries(world.nodes.map(node => [node.id, node.title.kind === 'literal' ? node.title.text : locales.find(locale => locale.locale === manifest?.defaultLocale)?.strings[node.title.key] ?? node.title.key]))}
        onOpenActions={(nodeId, action) => { setSelectedNodeId(nodeId); setActionFocus(action ? { ...action, request: Date.now() } : undefined); setInspectorTab('actions'); setInspectorCollapsed(false); }} onSelectNode={nodeId => { setSelectedNodeId(nodeId); setActionFocus(undefined); setInspectorTab('scene'); setSelectedDiagnostic(undefined); }} onWorldChange={updateWorld} />
      </div>
      {!inspectorCollapsed && <div className="apprentice-divider" role="separator" aria-label="Resize inspector" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={900} aria-valuenow={inspectorWidth} tabIndex={0}
        onPointerDown={event => { resizingInspector.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (!resizingInspector.current) return; const rect = apprenticeWorkbenchRef.current?.getBoundingClientRect(); if (rect) setInspectorWidth(Math.max(320, Math.min(rect.width - 320, rect.right - event.clientX))); }}
        onPointerUp={event => { resizingInspector.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { resizingInspector.current = false; }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setInspectorWidth(width => Math.max(320, Math.min(900, width + (event.key === 'ArrowLeft' ? 24 : -24)))); } }} />}
      <aside className="apprentice-inspector" aria-label="Story inspector">
        <div className="apprentice-inspector__heading"><button type="button" className="apprentice-inspector__collapse" aria-label={inspectorCollapsed ? 'Show inspector' : 'Hide inspector'} title={inspectorCollapsed ? 'Show inspector' : 'Hide inspector'} onClick={() => { setInspectorCollapsed(value => !value); setInspectorExpanded(false); }}>{inspectorCollapsed ? '‹' : '›'}</button>{!inspectorCollapsed && <><div><span className="eyebrow">THE INSPECTOR</span><h2>{inspectorTab === 'scene' ? world.nodes.find(node => node.id === selectedNodeId)?.visitable === false ? 'Logic folder details' : 'Scene details' : inspectorTab === 'actions' ? 'Player actions' : inspectorTab === 'text' ? 'Text / Translations' : inspectorTab === 'logic' ? 'Scene logic' : inspectorTab === 'world' ? 'World settings' : 'Scripts'}</h2></div><button type="button" className="apprentice-inspector__expand" aria-label={inspectorExpanded ? 'Exit workspace full screen' : 'Workspace full screen'} title={inspectorExpanded ? 'Exit workspace full screen' : 'Expand map and inspector'} onClick={() => setInspectorExpanded(value => !value)}>{inspectorExpanded ? '↙' : '⤢'}</button></>}</div>
        {!inspectorCollapsed && <>
        <div className="apprentice-inspector__tabs" role="tablist" aria-label="Inspector sections">
          <button role="tab" aria-selected={inspectorTab === 'scene'} onClick={() => setInspectorTab('scene')}>Scene</button>
          <button role="tab" aria-selected={inspectorTab === 'actions'} onClick={() => setInspectorTab('actions')}>Actions</button>
          <button role="tab" aria-selected={inspectorTab === 'text'} onClick={() => setInspectorTab('text')}>Text / Translations</button>
          <button role="tab" aria-selected={inspectorTab === 'logic'} onClick={() => setInspectorTab('logic')}>Logic</button>
          <button role="tab" aria-selected={inspectorTab === 'world'} onClick={() => setInspectorTab('world')}>World</button>
          <button role="tab" aria-selected={inspectorTab === 'scripts'} onClick={() => setInspectorTab('scripts')}>Scripts</button>
        </div>
        {selectedDiagnostic && <aside className="apprentice-diagnostic-target" role="status"><button type="button" aria-label="Dismiss selected problem" onClick={() => setSelectedDiagnostic(undefined)}>×</button><strong>Problem to resolve</strong><p>{diagnosticMessage(selectedDiagnostic, world, locales.find(locale => locale.locale === manifest?.defaultLocale))}</p><p>{selectedDiagnostic.suggestedFix}</p></aside>}
        {starterGuideVisible && selectedNodeId && inspectorTab === 'scene' && world.entryNodeId === 'old-gate' && <aside className="apprentice-starter-guide" aria-label="Start making your game"><button type="button" className="apprentice-starter-guide__close" aria-label="Dismiss starter guide" onClick={() => { localStorage.setItem('dungeon-scrivener-starter-guide-v1', 'dismissed'); setStarterGuideVisible(false); }}>×</button><span className="eyebrow">START HERE</span><h2>Make this story yours</h2><ol><li>Try the sample gate and watchtower routes.</li><li>Select The Old Gate and rewrite its opening.</li><li>Add a scene, draw a route, then give a choice that route.</li></ol><div><button type="button" onClick={() => requestAction('play', () => { void startPlaytest(); })}>Try sample story</button><button type="button" onClick={() => { setTourKind('tutorial'); setTourPhase('invite'); }}>Game tutorial</button></div></aside>}
        {inspectorTab !== 'scripts' && <ApprenticeForms world={world} view={inspectorTab} actionFocus={actionFocus} requestedWorldSection={requestedWorldSection} {...(selectedNodeId ? { selectedNodeId } : {})} onWorldChange={updateWorld}
          project={snapshot} locales={locales} defaultLocale={manifest?.defaultLocale}
          assets={diagnosticMedia?.snapshot.projectId === snapshot.projectId ? diagnosticMedia.media.listAssets() : []}
          mediaAssets={diagnosticMedia?.snapshot.projectId === snapshot.projectId ? diagnosticMedia.media : undefined}
          onLocalesChange={updateLocales} onProjectContentChange={updateProjectContent} onImportAsset={importMediaAsset} />}
        {inspectorTab === 'scripts' && <ApprenticeScripts world={world} project={snapshot} onEditInSage={path => {
          const current = snapshotRef.current ?? snapshot;
          workspaceRef.current = createSageWorkspace(current, path);
          setMode('sage');
        }} />}
        </>}
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
      recoveryAction={{ label: 'Return to editor', onClick: () => setMode('apprentice') }}
      mediaAssets={playConfig.media} themeCss={playConfig.themeCss} persistenceNotice={persistenceNotice}
      saveSlots={getSaveSlotChoices(world.savePolicy)} onSave={saveHosted}
      {...(world.savePolicy.enabled ? { onLoad: (file: File) => { void loadHosted(file); } } : {})}
    />}
    <aside className={`diagnostics${inspectorExpanded && mode === 'apprentice' ? ' is-workbench-overlay' : ''}`} id="project-diagnostics" tabIndex={-1} aria-label="Project diagnostics" aria-busy={snapshot !== analysisSnapshot}>
      <div className="diagnostics__heading"><strong>Project diagnostics</strong><span className={report?.diagnostics.length ? 'diagnostics__count has-issues' : 'diagnostics__count'}>{snapshot !== analysisSnapshot ? 'Checking…' : report?.diagnostics.length ? `${report.diagnostics.length} to review` : 'All clear'}</span>
      <input type="search" aria-label="Filter project diagnostics" value={diagnosticQuery} onChange={event => { setDiagnosticQuery(event.target.value); setDiagnosticPage(0); }} placeholder="Find a scene, code, file, or message" /></div>
      <div className="diagnostics__body">
      {report?.diagnostics.length ? <>
        <ul>{visibleDiagnostics.slice(visibleDiagnosticPage * 50, (visibleDiagnosticPage + 1) * 50).map((item, index) => <li key={`${item.code}:${visibleDiagnosticPage * 50 + index}`}><button type="button" className="diagnostics__issue" onClick={() => openDiagnostic(item)}><span>{diagnosticContext(item)}: {diagnosticMessage(item, world, locales.find(locale => locale.locale === manifest?.defaultLocale))}</span><small>{item.severity} · {item.code} · {item.path ?? 'world.json'}{item.suggestedFix ? ` · ${item.suggestedFix}` : ''}</small></button></li>)}</ul>
        {visibleDiagnostics.length === 0 && <p>No matching diagnostics.</p>}
        {visibleDiagnostics.length > 50 && <nav className="diagnostics__pages" aria-label="Diagnostic pages"><button type="button" disabled={visibleDiagnosticPage === 0} onClick={() => setDiagnosticPage(visibleDiagnosticPage - 1)}>Previous</button><span>{visibleDiagnosticPage * 50 + 1}–{Math.min((visibleDiagnosticPage + 1) * 50, visibleDiagnostics.length)} of {visibleDiagnostics.length}</span><button type="button" disabled={(visibleDiagnosticPage + 1) * 50 >= visibleDiagnostics.length} onClick={() => setDiagnosticPage(visibleDiagnosticPage + 1)}>Next</button></nav>}
      </> : <p>{snapshot !== analysisSnapshot ? 'Reviewing the latest changes. Previous results stay available while checking.' : 'No diagnostics.'}</p>}
      </div>
    </aside>
    <button className="clear-recovery" onClick={async () => {
      if (!snapshot) return;
      const result = await clearRecovery(snapshot.projectId);
      setStatus(result.ok ? 'Recovery copy cleared.' : result.diagnostic.message);
      if (result.ok) setRecoveryAvailable(false);
    }}>Clear recovery copy</button>
    </div>
    </StudioErrorBoundary>
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
    <StudioTour phase={tourPhase} kind={tourKind} mode={mode} onModeChange={nextMode => {
      if (nextMode === 'sage') {
        const current = snapshotRef.current;
        if (current && (!workspaceRef.current || workspaceRef.current.getState().snapshot !== current)) workspaceRef.current = createSageWorkspace(current);
      }
      setMode(nextMode);
    }} onClose={(outcome, kind) => {
      if (kind === 'studio' && outcome === 'finished') {
        setMode(localStorage.getItem('dungeon-scrivener-preferred-mode') === 'sage' ? 'sage' : 'apprentice');
        if (localStorage.getItem('dungeon-scrivener-tutorial-tour-v1') === null) { setTourKind('tutorial'); setTourPhase('invite'); return; }
      }
      setTourPhase(null);
    }} onStart={() => setTourPhase('tour')} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<StudioErrorBoundary onDownload={async () => {
  if (!lastAuthorSnapshot) throw new Error('No in-memory project is available. Reload Studio and choose the local recovery copy, if offered.');
  download(await writeProjectZip(lastAuthorSnapshot), `${lastAuthorSnapshot.projectId}-recovery.zip`, 'application/zip');
}}><App /></StudioErrorBoundary>);
