import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprenticeGraph } from '@dungeon-scrivener/apprentice';
import { PlaytestDebugger } from '@dungeon-scrivener/debugger';
import { collectDiagnostics, getAcknowledgementStatus } from '@dungeon-scrivener/diagnostics';
import { createGameEngine } from '@dungeon-scrivener/engine';
import { createMediaAssetCatalog } from '@dungeon-scrivener/media';
import { validateProject, type CompiledScriptBundle, type Diagnostic, type LocaleDocument, type ProjectFile, type ProjectManifest, type ProjectVfsSnapshot, type ScriptExecutionContext, type ScriptExecutionResult, type ScriptExecutorApi, type SessionSnapshot, type WorldDocument } from '@dungeon-scrivener/model';
import { clearRecovery, loadRecovery, saveRecovery } from '@dungeon-scrivener/persistence';
import { readProjectFile, readProjectZip, writeProjectZip, createSnapshot } from '@dungeon-scrivener/vfs';
import { SageMode, SageWorkspace } from '@dungeon-scrivener/sage';
import { EnginePlayer } from '@dungeon-scrivener/player';
import linearManifest from '../../../fixtures/linear-three-nodes/project.json';
import linearWorld from '../../../fixtures/linear-three-nodes/world.json';
import linearLocale from '../../../fixtures/linear-three-nodes/locales/en-GB.json';
import '@xyflow/react/dist/style.css';
import './studio.css';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
type Mode = 'home' | 'sage' | 'apprentice' | 'playtest' | 'play';
const EMPTY_BUNDLE: CompiledScriptBundle = { format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts: [] };
const noScriptsExecutor: ScriptExecutorApi = {
  executeScript(script, _context: ScriptExecutionContext): ScriptExecutionResult {
    return { ok: false, instructionsExecuted: 0, trace: [], diagnostic: {
      code: 'DS-STUDIO-SCRIPT-EXECUTOR-UNAVAILABLE', severity: 'error',
      message: `The scripting package executor is not available from its public workspace export (${script.sourcePath}).`,
      path: script.sourcePath, blocks: ['play', 'export'],
    } };
  },
};

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

function App(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('home');
  const [snapshot, setSnapshot] = useState<ProjectVfsSnapshot | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('');
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [recoveryProjectId, setRecoveryProjectId] = useState<string | null>(null);
  const [playSnapshot, setPlaySnapshot] = useState<SessionSnapshot>();
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => new Set());
  const workspaceRef = useRef<SageWorkspace | null>(null);
  const snapshotRef = useRef<ProjectVfsSnapshot | null>(null);
  const mediaAssets = useMemo(() => createMediaAssetCatalog(), []);
  const manifest = useMemo(() => snapshot ? parseFile(snapshot, 'project.json') as ProjectManifest | undefined : undefined, [snapshot, revision]);
  const world = useMemo(() => snapshot ? parseFile(snapshot, 'world.json') as WorldDocument | undefined : undefined, [snapshot, revision]);
  const locales = useMemo(() => snapshot ? [...snapshot.files.keys()]
    .filter(path => /^locales\/[^/]+\.json$/u.test(path))
    .map(path => parseFile(snapshot, path))
    .filter((item): item is LocaleDocument => typeof item === 'object' && item !== null && 'locale' in item) : [], [snapshot, revision]);
  const localeMap = useMemo(() => Object.fromEntries(locales.map(locale => [`locales/${locale.locale}.json`, locale])), [locales]);
  const report = useMemo(() => manifest && world ? collectDiagnostics({ manifest, world, locales: localeMap, filePaths: new Set(snapshot?.files.keys()) }) : undefined, [manifest, world, localeMap, snapshot]);
  const validation = useMemo(() => manifest && world ? validateProject({ manifest, world, locales: localeMap, filePaths: new Set(snapshot?.files.keys()) }) : undefined, [manifest, world, localeMap, snapshot]);

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

  function openProject(next: ProjectVfsSnapshot, message: string): void {
    snapshotRef.current = next;
    setSnapshot(next);
    setRecoveryProjectId(next.projectId);
    localStorage.setItem('dungeon-scrivener-last-project', next.projectId);
    workspaceRef.current = new SageWorkspace(next);
    setRevision(value => value + 1);
    setAcknowledged(new Set());
    setMode('sage');
    setStatus(message);
  }

  async function importZip(file?: File): Promise<void> {
    if (!file) return;
    try {
      const imported = await readProjectZip(new Uint8Array(await file.arrayBuffer()));
      openProject(imported, `Imported ${file.name}. Review diagnostics before play or export.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Project ZIP could not be read.');
    }
  }

  function currentReport(): readonly Diagnostic[] { return report?.diagnostics ?? []; }

  function allowed(action: 'save-project' | 'play' | 'export'): boolean {
    const decision = getAcknowledgementStatus(currentReport(), action, acknowledged);
    if (!decision.required || decision.acknowledged) return true;
    const pending = currentReport().filter(item => item.severity === 'warning' && item.acknowledgementRequired?.includes(action) && !acknowledged.has(item.code));
    const confirmed = window.confirm(`Warnings require acknowledgment before ${action}:\n\n${pending.map(item => `${item.code}: ${item.message}`).join('\n\n')}\n\nContinue?`);
    if (confirmed) setAcknowledged(new Set([...acknowledged, ...pending.map(item => item.code)]));
    return confirmed;
  }

  async function saveZip(): Promise<void> {
    if (!snapshot || !allowed('save-project')) return;
    try {
      download(await writeProjectZip(snapshot), `${manifest?.projectId ?? snapshot.projectId}.zip`, 'application/zip');
      await clearRecovery(snapshot.projectId);
      setRecoveryAvailable(false);
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
    setStatus('Apprentice changes saved to the project.');
    setRevision(value => value + 1);
  }

  function startPlay(): void {
    if (!manifest || !world || !allowed('play')) return;
    const engine = createGameEngine({ scriptExecutor: noScriptsExecutor, mediaAssets, seededSeedSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! } }, EMPTY_BUNDLE);
    const started = engine.createSession(manifest.projectId, world, { wallClockEpochMilliseconds: Date.now(), visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible', focused: document.hasFocus() });
    if (!started.ok) {
      setStatus(started.diagnostics.diagnostics.map(item => item.message).join(' '));
      return;
    }
    setPlaySnapshot(started.snapshot);
    setMode('play');
  }

  function startPlaytest(): void {
    if (!manifest || !world || !allowed('play')) return;
    const engine = createGameEngine({ scriptExecutor: noScriptsExecutor, mediaAssets, seededSeedSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! } }, EMPTY_BUNDLE);
    const started = engine.createSession(manifest.projectId, world, { wallClockEpochMilliseconds: Date.now(), visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible', focused: document.hasFocus() });
    if (!started.ok) {
      setStatus(started.diagnostics.diagnostics.map(item => item.message).join(' '));
      return;
    }
    setPlaySnapshot(started.snapshot);
    setMode('playtest');
  }

  function exportNotice(): void {
    if (!allowed('export')) return;
    setStatus('Static export is unavailable: the model fingerprint operation and scripting executor are missing from their documented public package exports.');
  }

  async function restoreRecovery(): Promise<void> {
    if (!recoveryProjectId) return;
    const result = await loadRecovery(recoveryProjectId);
    if (!result.ok) { setStatus(result.diagnostic.message); return; }
    if (!result.snapshot) { setRecoveryAvailable(false); setStatus('No recovery copy is available.'); return; }
    openProject(result.snapshot, 'Recovery copy restored.');
  }

  if (!snapshot || mode === 'home') {
    return <main className="home">
      <h1>DungeonScrivener</h1>
      <p>Create and edit a text adventure in Sage or Apprentice Mode.</p>
      <button onClick={() => openProject(snapshotFromData({ ...linearManifest, projectId: `project-${crypto.randomUUID()}` }, linearWorld, { 'locales/en-GB.json': linearLocale }), 'Starter project created.')}>Create project</button>
      <label className="button">Import project ZIP<input type="file" accept=".zip,application/zip" onChange={event => void importZip(event.currentTarget.files?.[0])} /></label>
      {recoveryAvailable && <button onClick={() => void restoreRecovery()}>Restore recovery</button>}
      {status && <p role="status">{status}</p>}
    </main>;
  }

  const workspace = workspaceRef.current;
  return <div className="studio">
    <header>
      <button onClick={() => setMode('home')}>Projects</button>
      <strong>{manifest?.title ?? manifest?.projectId ?? 'Untitled project'}</strong>
      <nav aria-label="Studio actions">
        <button onClick={() => { const current = snapshotRef.current ?? snapshot; if (current) { workspaceRef.current = new SageWorkspace(current); setStatus('Sage Mode is using the current project snapshot.'); } setMode('sage'); }}>Sage</button>
        <button onClick={() => setMode('apprentice')}>Apprentice</button>
        <button onClick={startPlaytest}>Playtest</button>
        <button onClick={startPlay}>Play</button>
        <button onClick={() => void saveZip()}>Save ZIP</button>
        <button onClick={exportNotice}>Export</button>
      </nav>
    </header>
    {status && <p className="status" role="status">{status}</p>}
    {mode === 'sage' && workspace && <SageMode workspace={workspace} onStateChange={state => {
      if (state.snapshot !== snapshotRef.current) {
        snapshotRef.current = state.snapshot;
        setSnapshot(state.snapshot);
        setRevision(value => value + 1);
      }
    }} />}
    {mode === 'apprentice' && world && <ApprenticeGraph world={world} onWorldChange={updateWorld} />}
    {mode === 'playtest' && world && playSnapshot && <PlaytestDebugger world={world} initialSnapshot={playSnapshot} />}
    {mode === 'play' && manifest && world && playSnapshot && <EnginePlayer
      engine={createGameEngine({ scriptExecutor: noScriptsExecutor, mediaAssets, seededSeedSource: { nextUint32: () => crypto.getRandomValues(new Uint32Array(1))[0]! } }, EMPTY_BUNDLE)}
      manifest={manifest} world={world} locales={locales} snapshot={playSnapshot} onSnapshot={setPlaySnapshot}
    />}
    {validation && report && report.diagnostics.length > 0 && <aside className="diagnostics" aria-label="Project diagnostics">
      <strong>Project diagnostics</strong>
      <ul>{report.diagnostics.map((item, index) => <li key={`${item.code}:${index}`}>{item.severity}: {item.message}</li>)}</ul>
    </aside>}
    <button className="clear-recovery" onClick={async () => {
      if (!snapshot) return;
      const result = await clearRecovery(snapshot.projectId);
      setStatus(result.ok ? 'Recovery copy cleared.' : result.diagnostic.message);
      if (result.ok) setRecoveryAvailable(false);
    }}>Clear recovery copy</button>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
