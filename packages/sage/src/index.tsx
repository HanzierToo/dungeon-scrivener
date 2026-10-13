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
    return this.deleteMany([path]);
  }

  deleteMany(paths: readonly string[]): SageWorkspaceState {
    const roots = [...new Set(paths)].filter(path => !paths.some(parent => parent !== path && path.startsWith(`${parent}/`)));
    if (!roots.length) return this.getState();
    const removing = (path: string) => roots.some(root => path === root || path.startsWith(`${root}/`));
    const core = ['project.json', 'world.json'].filter(removing);
    if (core.length) throw new Error(`Keep ${core.join(', ')} to retain an editable project. Clear its content through Apprentice or edit the document instead.`);
    for (const path of ['project.json', 'world.json']) {
      const file = this.current.files.get(path);
      if (!file) continue;
      const parsed = parseJsonDocument(file.bytes, path);
      if (!parsed.ok) throw new Error(`Repair ${path} before deleting project files so its references can be checked.`);
      const used: string[] = [];
      const inspect = (value: unknown, location: string): void => {
        if (typeof value === 'string' && (removing(value) || value.startsWith('sha256:') && [...this.current.files.keys()].some(candidate => removing(candidate) && candidate.startsWith(`assets/sha256/${value.slice(7)}`)))) used.push(location);
        else if (Array.isArray(value)) value.forEach((child, index) => inspect(child, `${location}[${index}]`));
        else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) inspect(child, `${location}.${key}`);
      };
      inspect(parsed.value, path);
      if (path === 'project.json' && parsed.value && typeof parsed.value === 'object' && 'defaultLocale' in parsed.value && removing(`locales/${parsed.value.defaultLocale}.json`)) used.push('project.json.defaultLocale');
      if (used.length) throw new Error(`Nothing was deleted. These project references still use selected files: ${used.join(', ')}. Update those references first.`);
    }
    let next = this.current;
    for (const path of roots) next = deleteProjectPath(next, path);
    this.current = next;
    const removed = (path: string) => roots.some(root => path === root || path.startsWith(`${root}/`));
    for (const path of this.scriptDiagnostics.keys()) if (removed(path)) this.scriptDiagnostics.delete(path);
    if (this.active && removed(this.active)) this.active = undefined;
    this.openPaths = this.openPaths.filter(path => !removed(path));
    if (!this.active) this.active = this.openPaths.at(-1);
    roots.forEach(path => this.dirty.add(path));
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
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);
  const [selectionAnchor, setSelectionAnchor] = useState('');
  const [context, setContext] = useState<{ path?: string; x: number; y: number }>();
  const [contextCreate, setContextCreate] = useState<{ directory: boolean; parent: string }>();
  const [contextName, setContextName] = useState('');
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextNameRef = useRef<HTMLInputElement>(null);
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
    const menu = contextMenuRef.current;
    if (menu) {
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(context.x, window.innerWidth - rect.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(context.y, window.innerHeight - rect.height - 8))}px`;
      (contextCreate ? contextNameRef.current : menu.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();
    }
    const dismiss = (event: PointerEvent) => { if (!menu?.contains(event.target as Node)) { setContext(undefined); setContextCreate(undefined); } };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [context, contextCreate]);

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
  const selected = selectedPaths.filter(path => directories.has(path) || state.snapshot.files.has(path));
  const orderedPaths = useMemo(() => {
    if (view === 'flat') return explorer.flatPaths;
    const order: string[] = [];
    const visit = (parent: string) => {
      for (const path of explorer.children.get(parent) ?? []) {
        order.push(path);
        if (explorer.directories.has(path) && expanded.has(path)) visit(path);
      }
    };
    visit('');
    return order;
  }, [explorer, expanded, view]);
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
  const selectPath = (path: string, event: React.MouseEvent<HTMLButtonElement>, order: readonly string[]) => {
    if (event.shiftKey && order.includes(selectionAnchor)) {
      const start = order.indexOf(selectionAnchor);
      const end = order.indexOf(path);
      const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
      setSelectedPaths(event.metaKey || event.ctrlKey ? [...new Set([...selected, ...range])] : range);
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedPaths(selected.includes(path) ? selected.filter(item => item !== path) : [...selected, path]);
      setSelectionAnchor(path);
    } else {
      setSelectedPaths([path]);
      setSelectionAnchor(path);
      open(path);
    }
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
  const removePaths = (paths: readonly string[]) => {
    const targets = [...new Set(paths)].filter(path => directories.has(path) || state.snapshot.files.has(path));
    if (!targets.length) return;
    const description = targets.length === 1 ? `Delete ${targets[0]}${state.snapshot.files.has(targets[0]!) ? '?' : ' and its contents?'}` : `Delete ${targets.length} selected files or folders and their contents?`;
    if (!window.confirm(`${description} Current edits are included. Undo project edit restores the files.`)) return;
    try {
      const next = workspace.deleteMany(targets);
      for (const storedPath of [...editorStates.current.keys()]) if (targets.some(path => storedPath === path || storedPath.startsWith(`${path}/`))) editorStates.current.delete(storedPath);
      setTabs([...workspace.getOpenPaths()]);
      setSelectedPaths([]);
      setSelectionAnchor('');
      update(next);
    } catch (error) { window.alert(error instanceof Error ? error.message : 'Unable to delete the selection.'); }
  };
  const handleExplorerKeys = (event: React.KeyboardEvent<HTMLElement>, order: readonly string[]) => {
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault();
      const focusedPath = event.target instanceof HTMLButtonElement ? event.target.dataset['path'] : undefined;
      const rect = (event.target instanceof HTMLElement ? event.target : event.currentTarget).getBoundingClientRect();
      showContext(focusedPath, rect.left + 12, rect.bottom + 4);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); event.stopPropagation(); setSelectedPaths(order); setSelectionAnchor(order[0] ?? '');
    } else if (event.key === 'Delete' || event.metaKey && event.key === 'Backspace') {
      event.preventDefault(); event.stopPropagation();
      const focusedPath = event.target instanceof HTMLButtonElement ? event.target.dataset['path'] : undefined;
      removePaths(selected.length ? selected : focusedPath ? [focusedPath] : []);
    } else if (event.key === 'Escape' && selected.length) {
      event.preventDefault(); event.stopPropagation(); setSelectedPaths([]); setSelectionAnchor('');
    }
  };

  const showContext = (path: string | undefined, x: number, y: number) => {
    if (path && !selected.includes(path)) { setSelectedPaths([path]); setSelectionAnchor(path); }
    if (!path) { setSelectedPaths([]); setSelectionAnchor(''); }
    setContextCreate(undefined);
    setContext({ ...(path ? { path } : {}), x, y });
  };
  const contextParent = context?.path ? directories.has(context.path) ? context.path : context.path.includes('/') ? context.path.slice(0, context.path.lastIndexOf('/')) : '' : '';
  const createFromContext = () => {
    if (!contextCreate || !contextName.trim()) return;
    const path = [contextCreate.parent, contextName.trim()].filter(Boolean).join('/');
    try {
      const next = contextCreate.directory ? workspace.createDirectory(path) : workspace.createFile(path);
      update(next);
      if (contextCreate.directory) setExpanded(current => new Set(current).add(path));
      else open(path);
      if (contextCreate.parent) setExpanded(current => new Set(current).add(contextCreate.parent));
      setContext(undefined);
      setContextCreate(undefined);
      setContextName('');
    } catch (error) { window.alert(error instanceof Error ? error.message : 'Unable to create path.'); contextNameRef.current?.focus(); }
  };
  const renderEntry = (path: string, depth: number): React.ReactNode => {
    const isDirectory = directories.has(path);
    const children = explorer.children.get(path) ?? [];
    return <li key={path}>
      <div className={`sage-entry${state.activePath === path ? ' is-active' : ''}${selected.includes(path) ? ' is-selected' : ''}`} style={{ paddingLeft: `${.45 + depth * .85}rem` }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); showContext(path, event.clientX, event.clientY); }}>
        <button type="button" className="sage-entry__name" data-path={path} aria-pressed={selected.includes(path)} aria-expanded={isDirectory ? expanded.has(path) : undefined} onClick={event => selectPath(path, event, orderedPaths)} title={path}>
          <span aria-hidden="true" className="sage-entry__icon">{isDirectory ? expanded.has(path) ? '▾' : '▸' : '◇'}</span>{view === 'flat' ? path : path.split('/').at(-1)}
        </button>
        <button type="button" className="sage-entry__menu" aria-label={`Actions for ${path}`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); showContext(path, rect.right - 180, rect.bottom); }}>···</button>
      </div>
      {isDirectory && expanded.has(path) && view === 'tree' && <ul>{children.map(child => renderEntry(child, depth + 1))}</ul>}
    </li>;
  };
  const visiblePaths = view === 'flat' ? explorer.flatPaths : explorer.children.get('') ?? [];
  const groupContext = !!context?.path && selected.length > 1 && selected.includes(context.path);

  return <section className="sage-mode" aria-label="Sage Mode file editor">
    <aside className="sage-file-tree" aria-label="Project files">
      <div className="sage-explorer-heading"><h2>Explorer</h2><span>{files.length} files</span></div>
      <div className="sage-explorer-settings"><label>View<select aria-label="Explorer view" value={view} onChange={event => { const next = event.currentTarget.value as 'tree' | 'flat'; setView(next); localStorage.setItem('ds-sage-view', next); }}><option value="tree">Folders</option><option value="flat">Flat paths</option></select></label><label>Sort<select aria-label="Explorer sort" value={sort} onChange={event => { const next = event.currentTarget.value as 'name' | 'type'; setSort(next); localStorage.setItem('ds-sage-sort', next); }}><option value="name">Name</option><option value="type">Type</option></select></label></div>
      <p className="sage-explorer-hint">Shift-click for a range, Command/Ctrl-click to add, Command/Ctrl+A for visible entries, Delete or Command+Backspace to remove.</p>
      {selected.length > 1 && <div className="sage-explorer-selection" aria-label="Explorer selection"><strong>{selected.length} selected</strong><button type="button" onClick={() => removePaths(selected)}>Delete selected</button></div>}
      <label className="sage-quick-open">Quick open <kbd>⌘/Ctrl P</kbd><input ref={quickOpenInput} type="search" aria-label="Quick open file" value={fileQuery} onChange={event => { setFileQuery(event.target.value); setFilePage(0); }} onKeyDown={event => {
        if (event.key === 'Escape') setFileQuery('');
        if (event.key === 'Enter' && fileMatches[0]) { open(fileMatches[0]); setFileQuery(''); }
      }} placeholder="Find a file by path" /></label>
      {fileQuery.trim() ? <div className="sage-explorer-list sage-quick-results" aria-label="Matching files" tabIndex={0} onContextMenu={event => { event.preventDefault(); showContext(undefined, event.clientX, event.clientY); }} onKeyDown={event => handleExplorerKeys(event, fileMatches)}>
        {fileMatches.slice(filePage * 60, (filePage + 1) * 60).map(path => <button key={path} type="button" data-path={path} aria-pressed={selected.includes(path)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); showContext(path, event.clientX, event.clientY); }} onClick={event => selectPath(path, event, fileMatches)}>{path}</button>)}
        {!fileMatches.length && <p>No matching files.</p>}
        {fileMatches.length > 60 && <div className="sage-quick-results__pages"><button type="button" disabled={filePage === 0} onClick={() => setFilePage(page => page - 1)}>Previous</button><span>{filePage * 60 + 1}–{Math.min((filePage + 1) * 60, fileMatches.length)} of {fileMatches.length}</span><button type="button" disabled={(filePage + 1) * 60 >= fileMatches.length} onClick={() => setFilePage(page => page + 1)}>Next</button></div>}
      </div> : <ul className="sage-explorer-list" tabIndex={0} aria-label="Explorer entries" onContextMenu={event => { event.preventDefault(); showContext(undefined, event.clientX, event.clientY); }} onKeyDown={event => handleExplorerKeys(event, orderedPaths)}>{visiblePaths.map(path => renderEntry(path, 0))}</ul>}
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
      {context && <div ref={contextMenuRef} className="sage-context-menu" role="menu" aria-label={context.path ? `Actions for ${context.path}` : 'Explorer background actions'} style={{ left: context.x, top: context.y }} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setContext(undefined); setContextCreate(undefined); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]; const index = items.indexOf(document.activeElement as HTMLElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
      }}>
        {contextCreate ? <label className="sage-context-create">{contextCreate.directory ? 'Folder name' : 'File name'}<input ref={contextNameRef} value={contextName} onChange={event => setContextName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); createFromContext(); } }} placeholder="Name" /><span>{contextCreate.parent || 'Project root'}</span><button type="button" role="menuitem" disabled={!contextName.trim()} onClick={createFromContext}>Create</button></label> : <>
          {groupContext ? <><button type="button" role="menuitem" onClick={() => { selected.filter(path => state.snapshot.files.has(path)).forEach(path => open(path)); setContext(undefined); }}>Open selected files</button><button type="button" role="menuitem" className="sage-context-menu__danger" onClick={() => { removePaths(selected); setContext(undefined); }}>Delete selected</button></> : <>
          {context.path && !directories.has(context.path) && <button type="button" role="menuitem" onClick={() => { open(context.path!); setContext(undefined); }}>Open</button>}
          <button type="button" role="menuitem" onClick={() => { setContextCreate({ directory: false, parent: contextParent }); setContextName(''); }}>New file{context.path ? directories.has(context.path) ? ' in folder' : ' beside this file' : ''}</button>
          <button type="button" role="menuitem" onClick={() => { setContextCreate({ directory: true, parent: contextParent }); setContextName(''); }}>New folder{context.path ? directories.has(context.path) ? ' in folder' : ' beside this file' : ''}</button>
          {context.path && directories.has(context.path) && <button type="button" role="menuitem" onClick={() => { open(context.path!); setContext(undefined); }}>{expanded.has(context.path) ? 'Collapse' : 'Expand'}</button>}
          {(!context.path && view === 'tree') && <button type="button" role="menuitem" onClick={() => { setExpanded(new Set()); setContext(undefined); }}>Collapse all</button>}
          {context.path && <><button type="button" role="menuitem" onClick={() => { rename(context.path!); setContext(undefined); }}>Rename</button><button type="button" role="menuitem" className="sage-context-menu__danger" onClick={() => { removePaths([context.path!]); setContext(undefined); }}>Delete</button></>}
          </>}
        </>}
      </div>}
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
