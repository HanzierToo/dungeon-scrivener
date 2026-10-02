import { EditorView, basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { StreamLanguage, syntaxTree } from '@codemirror/language';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { parse as parseLuaSyntax } from 'luaparse';
import type { Diagnostic, ProjectFile, ProjectVfsSnapshot } from '@dungeon-scrivener/model';
import { parseJsonDocument, validateLocaleDocument, validateProjectManifest, validateWorldDocument } from '@dungeon-scrivener/model';
import { addProjectDirectory, addProjectFile, deleteProjectPath, renameProjectPath, replaceProjectFile, writeProjectZip } from '@dungeon-scrivener/vfs';
import React, { useEffect, useMemo, useRef, useState } from 'react';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export interface SageProjectView {
  readonly manifest?: unknown;
  readonly world?: unknown;
  readonly locales: Readonly<Record<string, unknown>>;
}

export interface SageWorkspaceState {
  readonly snapshot: ProjectVfsSnapshot;
  readonly activePath?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly parsedProject?: SageProjectView;
  readonly dirtyPaths: ReadonlySet<string>;
}

type ParsedFile = { file: ProjectFile; value?: unknown; diagnostics: Diagnostic[] };

function parseView(snapshot: ProjectVfsSnapshot, cache: Map<string, ParsedFile>): { view?: SageProjectView; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const decoded = new Map<string, unknown>();
  for (const path of cache.keys()) if (!snapshot.files.has(path)) cache.delete(path);
  for (const path of ['project.json', 'world.json', ...[...snapshot.files.keys()].filter(item => /^locales\/[^/]+\.json$/u.test(item))]) {
    const file = snapshot.files.get(path);
    if (!file) continue;
    let parsed = cache.get(path);
    if (parsed?.file !== file) {
      const result = parseJsonDocument(file.bytes, path);
      const fileDiagnostics = [...result.diagnostics];
      if (result.ok) {
        if (path === 'project.json') fileDiagnostics.push(...validateProjectManifest(result.value, path).diagnostics);
        else if (path === 'world.json') fileDiagnostics.push(...validateWorldDocument(result.value, path).diagnostics);
        else fileDiagnostics.push(...validateLocaleDocument(result.value, path).diagnostics);
      }
      parsed = { file, ...(result.ok ? { value: result.value } : {}), diagnostics: fileDiagnostics };
      cache.set(path, parsed);
    }
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value !== undefined) decoded.set(path, parsed.value);
  }
  if (diagnostics.some(item => item.severity === 'error' || item.severity === 'fatal')) return { diagnostics };
  const locales: Record<string, unknown> = {};
  for (const [path, value] of decoded) if (path.startsWith('locales/')) locales[path] = value;
  return {
    diagnostics,
    view: {
      ...(decoded.has('project.json') ? { manifest: decoded.get('project.json') } : {}),
      ...(decoded.has('world.json') ? { world: decoded.get('world.json') } : {}),
      locales
    }
  };
}

export class SageWorkspace {
  private current: ProjectVfsSnapshot;
  private lastValid: SageProjectView | undefined;
  private diagnostics: readonly Diagnostic[] = [];
  private scriptDiagnostics = new Map<string, readonly Diagnostic[]>();
  private dirty = new Set<string>();
  private active: string | undefined;
  private openPaths: string[] = [];
  private parsedCache = new Map<string, ParsedFile>();

  constructor(snapshot: ProjectVfsSnapshot) {
    this.current = snapshot;
    const parsed = parseView(snapshot, this.parsedCache);
    this.lastValid = parsed.view;
    this.diagnostics = parsed.diagnostics;
  }

  getState(): SageWorkspaceState {
    return {
      snapshot: this.current,
      ...(this.active === undefined ? {} : { activePath: this.active }),
      diagnostics: this.diagnostics,
      ...(this.lastValid === undefined ? {} : { parsedProject: this.lastValid }),
      dirtyPaths: new Set(this.dirty)
    };
  }

  open(path: string): SageWorkspaceState {
    if (!this.current.files.has(path) && !this.current.directories.has(path)) throw new Error(`No file or directory at ${path}.`);
    this.active = path;
    if (!this.current.directories.has(path) && !this.openPaths.includes(path)) this.openPaths.push(path);
    return this.getState();
  }

  getOpenPaths(): readonly string[] { return this.openPaths; }

  closeTab(path: string): SageWorkspaceState {
    this.openPaths = this.openPaths.filter(item => item !== path);
    if (this.active === path) this.active = this.openPaths.at(-1);
    return this.getState();
  }

  createFile(path: string, bytes = new Uint8Array()): SageWorkspaceState {
    this.current = addProjectFile(this.current, { path, bytes, role: 'arbitrary' });
    this.dirty.add(path);
    return this.afterEdit();
  }

  createDirectory(path: string): SageWorkspaceState {
    this.current = addProjectDirectory(this.current, path);
    this.dirty.add(path);
    return this.getState();
  }

  rename(from: string, to: string): SageWorkspaceState {
    this.current = renameProjectPath(this.current, from, to);
    this.scriptDiagnostics.delete(from);
    this.scriptDiagnostics.delete(to);
    if (this.active === from || this.active?.startsWith(`${from}/`)) this.active = to + this.active.slice(from.length);
    this.openPaths = this.openPaths.map(path => path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    this.dirty.add(from);
    this.dirty.add(to);
    return this.afterEdit();
  }

  delete(path: string): SageWorkspaceState {
    this.current = deleteProjectPath(this.current, path);
    this.scriptDiagnostics.delete(path);
    if (this.active === path || this.active?.startsWith(`${path}/`)) this.active = undefined;
    this.openPaths = this.openPaths.filter(item => item !== path && !item.startsWith(`${path}/`));
    if (!this.active) this.active = this.openPaths.at(-1);
    this.dirty.add(path);
    return this.afterEdit();
  }

  editText(path: string, text: string): SageWorkspaceState {
    const file = this.current.files.get(path);
    if (!file) throw new Error(`No file at ${path}.`);
    this.current = replaceProjectFile(this.current, path, encoder.encode(text));
    this.scriptDiagnostics.delete(path);
    this.dirty.add(path);
    return this.afterEdit();
  }

  async exportZip(): Promise<Uint8Array> {
    return writeProjectZip(this.current);
  }

  setScriptDiagnostics(path: string, diagnostics: readonly Diagnostic[]): SageWorkspaceState {
    if (diagnostics.length === 0) this.scriptDiagnostics.delete(path);
    else this.scriptDiagnostics.set(path, diagnostics);
    this.diagnostics = [
      ...this.diagnostics.filter(item => item.code !== 'DS-SAGE-001'),
      ...[...this.scriptDiagnostics.values()].flat()
    ];
    return this.getState();
  }

  private afterEdit(): SageWorkspaceState {
    const parsed = parseView(this.current, this.parsedCache);
    this.diagnostics = [...parsed.diagnostics, ...[...this.scriptDiagnostics.values()].flat()];
    if (parsed.view !== undefined) this.lastValid = parsed.view;
    return this.getState();
  }
}

function isText(bytes: Uint8Array): boolean {
  try {
    const text = decoder.decode(bytes);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0 || (code < 0x09) || (code > 0x0d && code < 0x20)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function editorExtensions(path: string) {
  if (path.endsWith('.json')) return [json()];
  if (path.endsWith('.js') || path.endsWith('.mjs')) return [javascript()];
  if (path.endsWith('.py')) return [python()];
  if (path.endsWith('.lua')) return [StreamLanguage.define(lua)];
  if (path.endsWith('.md') || path.endsWith('.markdown')) return [markdown()];
  return [];
}

export function diagnoseSageScript(source: string, path: string, view?: EditorView): Diagnostic[] {
  const language = path.endsWith('.mjs') || path.endsWith('.js') ? 'JavaScript'
    : path.endsWith('.lua') ? 'Lua'
      : path.endsWith('.py') ? 'Python' : undefined;
  if (language === undefined) return [];
  if (language === 'Lua') {
    try {
      if (new TextEncoder().encode(source).byteLength > 128 * 1024) {
        return [{ code: 'DS-SAGE-001', severity: 'error', message: 'Lua source exceeds the 128 KiB limit.', path,
          sourceSpan: { path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } }];
      }
      parseLuaSyntax(source, { luaVersion: '5.3' });
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid Lua syntax';
      const match = /^\[(\d+):(\d+)\]/u.exec(message);
      const line = match?.[1] ? Number(match[1]) : 1;
      const column = match?.[2] ? Number(match[2]) + 1 : 1;
      return [{ code: 'DS-SAGE-001', severity: 'error', message: `${language} syntax error: ${message}`, path,
        sourceSpan: { path, startLine: line, startColumn: column, endLine: line, endColumn: column + 1 } }];
    }
  }
  if (view === undefined) return [];
  const diagnostics: Diagnostic[] = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      if (!node.type.isError) return;
      const line = view.state.doc.lineAt(node.from);
      diagnostics.push({
        code: 'DS-SAGE-001', severity: 'error',
        message: `Unrecognized ${language} syntax near line ${line.number}, column ${node.from - line.from + 1}.`,
        path,
        sourceSpan: {
          path, startLine: line.number, startColumn: node.from - line.from + 1,
          endLine: line.number, endColumn: Math.max(node.to - line.from + 1, node.from - line.from + 2)
        }
      });
    }
  });
  return diagnostics;
}

export interface SageModeProps {
  readonly workspace: SageWorkspace;
  readonly onStateChange?: (state: SageWorkspaceState) => void;
  readonly showExport?: boolean;
}

type SearchHit = { path: string; line: number; preview: string };

/** File-tree IDE view. File bytes remain in the VFS while tabs are switched. */
export function SageMode({ workspace, onStateChange, showExport = true }: SageModeProps): React.ReactElement {
  const [state, setState] = useState(workspace.getState());
  const [tabs, setTabs] = useState<string[]>(() => [...workspace.getOpenPaths()]);
  const [pathInput, setPathInput] = useState('');
  const [view, setView] = useState<'tree' | 'flat'>(() => localStorage.getItem('ds-sage-view') === 'flat' ? 'flat' : 'tree');
  const [sort, setSort] = useState<'name' | 'type'>(() => localStorage.getItem('ds-sage-sort') === 'type' ? 'type' : 'name');
  const [fileQuery, setFileQuery] = useState('');
  const [filePage, setFilePage] = useState(0);
  const [contentQuery, setContentQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [resultPage, setResultPage] = useState(0);
  const [diagnosticQuery, setDiagnosticQuery] = useState('');
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['locales', 'scripts', 'assets', 'styles']));
  const [context, setContext] = useState<{ path: string; x: number; y: number }>();
  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const editorStates = useRef(new Map<string, EditorView['state']>());
  const quickOpenInput = useRef<HTMLInputElement>(null);
  const searchWorker = useRef<Worker | null>(null);
  const pendingJump = useRef<{ path: string; line: number } | null>(null);
  const currentFile = useMemo(() => state.activePath ? state.snapshot.files.get(state.activePath) : undefined, [state]);
  const textFile = currentFile !== undefined && isText(currentFile.bytes);

  const update = (next: SageWorkspaceState) => {
    setState(next);
    onStateChange?.(next);
  };

  useEffect(() => {
    if (!editorHost.current || !currentFile || !textFile) return undefined;
    const value = decoder.decode(currentFile.bytes);
    const view = new EditorView({
      ...(editorStates.current.has(currentFile.path) ? { state: editorStates.current.get(currentFile.path)! } : { doc: value }),
      ...(!editorStates.current.has(currentFile.path) ? { extensions: [basicSetup, keymap.of([indentWithTab]), ...editorExtensions(currentFile.path), EditorView.updateListener.of(update => {
        if (update.docChanged) {
          const source = update.state.doc.toString();
          workspace.editText(currentFile.path, source);
          const scriptDiagnostics = diagnoseSageScript(source, currentFile.path, update.view);
          updateState(workspace.setScriptDiagnostics(currentFile.path, scriptDiagnostics));
        }
      })] } : {}),
      parent: editorHost.current
    });
    editor.current = view;
    if (pendingJump.current?.path === currentFile.path) {
      const line = view.state.doc.line(Math.min(pendingJump.current.line, view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
      view.focus();
      pendingJump.current = null;
    }
    return () => { editorStates.current.set(currentFile.path, view.state); view.destroy(); editor.current = undefined; };
  }, [workspace, currentFile?.path, textFile]);

  useEffect(() => {
    const quickOpen = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        quickOpenInput.current?.focus();
        quickOpenInput.current?.select();
      }
    };
    window.addEventListener('keydown', quickOpen);
    return () => window.removeEventListener('keydown', quickOpen);
  }, []);

  useEffect(() => () => searchWorker.current?.terminate(), []);

  const updateState = (next: SageWorkspaceState) => {
    setState(next);
    onStateChange?.(next);
  };

  useEffect(() => {
    if (!context) return;
    const dismiss = () => setContext(undefined);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss); };
  }, [context]);

  const explorer = useMemo(() => {
    const files = [...state.snapshot.files.keys()];
    const directories = new Set(state.snapshot.directories);
    for (const path of files) {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
    }
    const compare = (a: string, b: string) => {
      if (sort === 'type') {
        const aDirectory = directories.has(a);
        const bDirectory = directories.has(b);
        if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
        const aExtension = a.split('.').at(-1) ?? '';
        const bExtension = b.split('.').at(-1) ?? '';
        if (!aDirectory && aExtension !== bExtension) return aExtension.localeCompare(bExtension);
      }
      return (a.split('/').at(-1) ?? '').localeCompare(b.split('/').at(-1) ?? '');
    };
    const children = new Map<string, string[]>();
    for (const path of [...directories, ...files]) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const siblings = children.get(parent) ?? [];
      siblings.push(path);
      children.set(parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort(compare);
    return { files, directories, children, flatPaths: [...directories, ...files].sort(compare) };
  }, [state.snapshot, sort]);
  const { files, directories } = explorer;
  const fileMatches = useMemo(() => fileQuery.trim()
    ? files.filter(path => path.toLocaleLowerCase().includes(fileQuery.trim().toLocaleLowerCase())).sort((a, b) => a.localeCompare(b))
    : [], [files, fileQuery]);
  const filteredDiagnostics = useMemo(() => state.diagnostics.filter(item =>
    `${item.severity} ${item.code} ${item.path ?? ''} ${item.message}`.toLocaleLowerCase().includes(diagnosticQuery.trim().toLocaleLowerCase())), [state.diagnostics, diagnosticQuery]);
  const open = (path: string) => {
    if (directories.has(path)) { setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; }); return; }
    update(workspace.open(path));
    setTabs([...workspace.getOpenPaths()]);
  };
  const jumpTo = (path: string, line: number) => {
    pendingJump.current = { path, line };
    if (state.activePath === path && editor.current) {
      const position = editor.current.state.doc.line(Math.min(line, editor.current.state.doc.lines)).from;
      editor.current.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
      editor.current.focus();
      pendingJump.current = null;
    } else open(path);
  };
  const searchContent = () => {
    searchWorker.current?.terminate();
    const query = contentQuery.trim();
    setSearchResults([]);
    setResultPage(0);
    setSearchTruncated(false);
    if (!query) { setSearching(false); return; }
    const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
    searchWorker.current = worker;
    const sourceFiles = [...state.snapshot.files.values()];
    let index = 0;
    let total = 0;
    let truncated = false;
    const next = () => {
      const file = sourceFiles[index++];
      if (!file) { setSearching(false); setSearchTruncated(truncated); worker.terminate(); if (searchWorker.current === worker) searchWorker.current = null; return; }
      worker.postMessage({ path: file.path, bytes: file.bytes, query });
    };
    worker.onmessage = (event: MessageEvent<{ hits: SearchHit[]; more: boolean }>) => {
      if (searchWorker.current !== worker) return;
      const remaining = 1000 - total;
      const accepted = event.data.hits.slice(0, remaining);
      total += accepted.length;
      if (accepted.length) setSearchResults(previous => [...previous, ...accepted]);
      truncated ||= event.data.more || accepted.length < event.data.hits.length;
      if (total >= 1000) { truncated = true; setSearching(false); setSearchTruncated(true); worker.terminate(); searchWorker.current = null; }
      else next();
    };
    worker.onerror = () => { setSearching(false); worker.terminate(); if (searchWorker.current === worker) searchWorker.current = null; };
    setSearching(true);
    next();
  };
  const closeTab = (path: string) => {
    update(workspace.closeTab(path));
    setTabs([...workspace.getOpenPaths()]);
  };
  const create = (directory: boolean) => {
    if (!pathInput) return;
    try {
      const next = directory ? workspace.createDirectory(pathInput) : workspace.createFile(pathInput);
      update(next);
      if (!directory) open(pathInput);
      else setExpanded(current => new Set(current).add(pathInput));
      setPathInput('');
    } catch (error) { window.alert(error instanceof Error ? error.message : 'Unable to create path.'); }
  };
  const rename = (path: string) => {
    const target = window.prompt('Rename path', path);
    if (target && target !== path) {
      try {
        const next = workspace.rename(path, target);
        for (const storedPath of [...editorStates.current.keys()]) if (storedPath === path || storedPath.startsWith(`${path}/`)) editorStates.current.delete(storedPath);
        setTabs([...workspace.getOpenPaths()]);
        update(next);
      }
      catch (error) { window.alert(error instanceof Error ? error.message : 'Unable to rename path.'); }
    }
  };
  const remove = (path: string) => {
    if (!window.confirm(`Delete ${path}${state.snapshot.files.has(path) ? '?' : ' and its contents? '}`)) return;
    const next = workspace.delete(path);
    for (const storedPath of [...editorStates.current.keys()]) if (storedPath === path || storedPath.startsWith(`${path}/`)) editorStates.current.delete(storedPath);
    setTabs([...workspace.getOpenPaths()]);
    update(next);
  };

  const showContext = (path: string, x: number, y: number) => {
    setContext({ path, x: Math.min(x, window.innerWidth - 190), y: Math.min(y, window.innerHeight - 110) });
  };
  const renderEntry = (path: string, depth: number): React.ReactNode => {
    const isDirectory = directories.has(path);
    const children = explorer.children.get(path) ?? [];
    return <li key={path}>
      <div className={`sage-entry${state.activePath === path ? ' is-active' : ''}`} style={{ paddingLeft: `${.45 + depth * .85}rem` }} onContextMenu={event => { event.preventDefault(); showContext(path, event.clientX, event.clientY); }}>
        <button type="button" className="sage-entry__name" aria-expanded={isDirectory ? expanded.has(path) : undefined} onClick={() => open(path)} onKeyDown={event => { if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); showContext(path, rect.left, rect.bottom); } }} title={path}>
          <span aria-hidden="true" className="sage-entry__icon">{isDirectory ? expanded.has(path) ? '▾' : '▸' : '◇'}</span>{view === 'flat' ? path : path.split('/').at(-1)}
        </button>
        <button type="button" className="sage-entry__menu" aria-label={`Actions for ${path}`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); showContext(path, rect.right - 180, rect.bottom); }}>···</button>
      </div>
      {isDirectory && expanded.has(path) && view === 'tree' && <ul>{children.map(child => renderEntry(child, depth + 1))}</ul>}
    </li>;
  };
  const visiblePaths = view === 'flat' ? explorer.flatPaths : explorer.children.get('') ?? [];

  return <section className="sage-mode" aria-label="Sage Mode file editor">
    <aside className="sage-file-tree" aria-label="Project files">
      <div className="sage-explorer-heading"><h2>Explorer</h2><span>{files.length} files</span></div>
      <div className="sage-explorer-settings"><label>View<select aria-label="Explorer view" value={view} onChange={event => { const next = event.currentTarget.value as 'tree' | 'flat'; setView(next); localStorage.setItem('ds-sage-view', next); }}><option value="tree">Folders</option><option value="flat">Flat paths</option></select></label><label>Sort<select aria-label="Explorer sort" value={sort} onChange={event => { const next = event.currentTarget.value as 'name' | 'type'; setSort(next); localStorage.setItem('ds-sage-sort', next); }}><option value="name">Name</option><option value="type">Type</option></select></label></div>
      <label className="sage-quick-open">Quick open <kbd>⌘/Ctrl P</kbd><input ref={quickOpenInput} type="search" aria-label="Quick open file" value={fileQuery} onChange={event => { setFileQuery(event.target.value); setFilePage(0); }} onKeyDown={event => {
        if (event.key === 'Escape') setFileQuery('');
        if (event.key === 'Enter' && fileMatches[0]) { open(fileMatches[0]); setFileQuery(''); }
      }} placeholder="Find a file by path" /></label>
      {fileQuery.trim() ? <div className="sage-explorer-list sage-quick-results" aria-label="Matching files">
        {fileMatches.slice(filePage * 60, (filePage + 1) * 60).map(path => <button key={path} type="button" onClick={() => { open(path); setFileQuery(''); }}>{path}</button>)}
        {!fileMatches.length && <p>No matching files.</p>}
        {fileMatches.length > 60 && <div className="sage-quick-results__pages"><button type="button" disabled={filePage === 0} onClick={() => setFilePage(page => page - 1)}>Previous</button><span>{filePage * 60 + 1}–{Math.min((filePage + 1) * 60, fileMatches.length)} of {fileMatches.length}</span><button type="button" disabled={(filePage + 1) * 60 >= fileMatches.length} onClick={() => setFilePage(page => page + 1)}>Next</button></div>}
      </div> : <ul className="sage-explorer-list">{visiblePaths.map(path => renderEntry(path, 0))}</ul>}
      <details className="sage-content-search"><summary>Search project text</summary>
        <form onSubmit={event => { event.preventDefault(); searchContent(); }}><input type="search" aria-label="Project text query" value={contentQuery} onChange={event => setContentQuery(event.target.value)} placeholder="Words or IDs" /><button type="submit" disabled={!contentQuery.trim()}>Search</button></form>
        {searching && <p role="status">Searching project files…</p>}
        {!searching && searchTruncated && <p>Showing the first 1,000 matches or first 50 from a file. Narrow the query for more.</p>}
        <div className="sage-content-search__results" aria-label="Project text results">{searchResults.slice(resultPage * 50, (resultPage + 1) * 50).map((hit, index) => <button key={`${hit.path}:${hit.line}:${index}`} type="button" onClick={() => jumpTo(hit.path, hit.line)}><strong>{hit.path}:{hit.line}</strong><span>{hit.preview}</span></button>)}</div>
        {searchResults.length > 50 && <div className="sage-quick-results__pages"><button type="button" disabled={resultPage === 0} onClick={() => setResultPage(page => page - 1)}>Previous</button><span>{resultPage * 50 + 1}–{Math.min((resultPage + 1) * 50, searchResults.length)} of {searchResults.length}</span><button type="button" disabled={(resultPage + 1) * 50 >= searchResults.length} onClick={() => setResultPage(page => page + 1)}>Next</button></div>}
      </details>
      <div className="sage-explorer-create"><label>New path<input value={pathInput} onChange={event => setPathInput(event.currentTarget.value)} placeholder="folder/file.json" /></label><div><button type="button" onClick={() => create(false)}>New file</button><button type="button" onClick={() => create(true)}>New folder</button></div></div>
      {showExport ? <button type="button" onClick={() => { void workspace.exportZip().then(bytes => {
        const zipBytes = new Uint8Array(bytes);
        const url = URL.createObjectURL(new Blob([zipBytes.buffer], { type: 'application/zip' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'project.zip'; anchor.click(); URL.revokeObjectURL(url);
      }); }}>Export project ZIP</button> : null}
      {context && <div className="sage-context-menu" role="menu" aria-label={`Actions for ${context.path}`} style={{ left: context.x, top: context.y }} onPointerDown={event => event.stopPropagation()}><button role="menuitem" onClick={() => { rename(context.path); setContext(undefined); }}>Rename</button><button role="menuitem" onClick={() => { remove(context.path); setContext(undefined); }}>Delete</button></div>}
    </aside>
    <main className="sage-editor-area">
      <nav aria-label="Open files" role="tablist">{tabs.map(path => <div className="sage-tab" key={path}><button type="button" role="tab" aria-selected={state.activePath === path} onClick={() => open(path)}>{path.split('/').at(-1)}</button><button type="button" className="sage-tab__close" aria-label={`Close ${path}`} onClick={() => closeTab(path)}>×</button></div>)}</nav>
      {currentFile ? textFile
        ? <div className="sage-code-editor" ref={editorHost} aria-label={`Editor for ${currentFile.path}`} />
        : <section className="sage-binary-preview" aria-label={`Binary preview for ${currentFile.path}`}><p>{currentFile.bytes.byteLength} bytes</p><pre>{Array.from(currentFile.bytes.slice(0, 256), (byte: number) => byte.toString(16).padStart(2, '0')).join(' ')}</pre>{currentFile.bytes.byteLength > 256 && <p>Preview limited to the first 256 bytes.</p>}</section>
        : <div className="sage-empty-editor"><span aria-hidden="true">✦</span><p>Open a file from Explorer to begin editing.</p></div>}
      <section className="sage-diagnostics" aria-live="polite"><h2>Diagnostics · {state.diagnostics.length}</h2>
        {state.diagnostics.length > 10 && <input type="search" aria-label="Filter diagnostics" value={diagnosticQuery} onChange={event => { setDiagnosticQuery(event.target.value); setDiagnosticPage(0); }} placeholder="Filter by file, code, or message" />}
        {state.diagnostics.length === 0 ? <p>No diagnostics.</p> : <ul>{filteredDiagnostics.slice(diagnosticPage * 50, (diagnosticPage + 1) * 50).map((diagnostic, index) => <li key={`${diagnostic.code}:${diagnostic.path ?? ''}:${index}`}>{diagnostic.path && state.snapshot.files.has(diagnostic.path) ? <button type="button" onClick={() => jumpTo(diagnostic.path!, diagnostic.sourceSpan?.startLine ?? 1)}>{diagnostic.severity.toUpperCase()} {diagnostic.path}</button> : `${diagnostic.severity.toUpperCase()} ${diagnostic.path ?? ''}`} : {diagnostic.message}</li>)}</ul>}
        {filteredDiagnostics.length > 50 && <div className="sage-quick-results__pages"><button type="button" disabled={diagnosticPage === 0} onClick={() => setDiagnosticPage(page => page - 1)}>Previous</button><span>{diagnosticPage * 50 + 1}–{Math.min((diagnosticPage + 1) * 50, filteredDiagnostics.length)} of {filteredDiagnostics.length}</span><button type="button" disabled={(diagnosticPage + 1) * 50 >= filteredDiagnostics.length} onClick={() => setDiagnosticPage(page => page + 1)}>Next</button></div>}
      </section>
    </main>
  </section>;
}

export { isText as isSageTextFile };
