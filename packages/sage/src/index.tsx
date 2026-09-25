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
import { addProjectDirectory, addProjectFile, deleteProjectPath, readProjectFile, renameProjectPath, writeProjectZip } from '@dungeon-scrivener/vfs';
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

function parseView(snapshot: ProjectVfsSnapshot): { view?: SageProjectView; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const decoded = new Map<string, unknown>();
  for (const path of ['project.json', 'world.json', ...[...snapshot.files.keys()].filter(item => /^locales\/[^/]+\.json$/u.test(item))]) {
    const file = readProjectFile(snapshot, path);
    if (!file) continue;
    const parsed = parseJsonDocument(file.bytes, path);
    diagnostics.push(...parsed.diagnostics);
    if (!parsed.ok) continue;
    decoded.set(path, parsed.value);
    if (path === 'project.json') diagnostics.push(...validateProjectManifest(parsed.value, path).diagnostics);
    else if (path === 'world.json') diagnostics.push(...validateWorldDocument(parsed.value, path).diagnostics);
    else diagnostics.push(...validateLocaleDocument(parsed.value, path).diagnostics);
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

  constructor(snapshot: ProjectVfsSnapshot) {
    this.current = snapshot;
    const parsed = parseView(snapshot);
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
    if (!readProjectFile(this.current, path) && !this.current.directories.has(path)) throw new Error(`No file or directory at ${path}.`);
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
    const file = readProjectFile(this.current, path);
    if (!file) throw new Error(`No file at ${path}.`);
    const replacement: ProjectFile = { path: file.path, bytes: encoder.encode(text), role: file.role, ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }) };
    this.current = addProjectFile(deleteProjectPath(this.current, path), replacement);
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
    const parsed = parseView(this.current);
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

/** File-tree IDE view. File bytes remain in the VFS while tabs are switched. */
export function SageMode({ workspace, onStateChange, showExport = true }: SageModeProps): React.ReactElement {
  const [state, setState] = useState(workspace.getState());
  const [tabs, setTabs] = useState<string[]>(() => [...workspace.getOpenPaths()]);
  const [pathInput, setPathInput] = useState('');
  const [view, setView] = useState<'tree' | 'flat'>(() => localStorage.getItem('ds-sage-view') === 'flat' ? 'flat' : 'tree');
  const [sort, setSort] = useState<'name' | 'type'>(() => localStorage.getItem('ds-sage-sort') === 'type' ? 'type' : 'name');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['locales', 'scripts', 'assets', 'styles']));
  const [context, setContext] = useState<{ path: string; x: number; y: number }>();
  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const currentFile = useMemo(() => state.activePath ? readProjectFile(state.snapshot, state.activePath) : undefined, [state]);
  const textFile = currentFile !== undefined && isText(currentFile.bytes);

  const update = (next: SageWorkspaceState) => {
    setState(next);
    onStateChange?.(next);
  };

  useEffect(() => {
    if (!editorHost.current || !currentFile || !textFile) return undefined;
    const value = decoder.decode(currentFile.bytes);
    const view = new EditorView({
      doc: value,
      extensions: [basicSetup, keymap.of([indentWithTab]), ...editorExtensions(currentFile.path), EditorView.updateListener.of(update => {
        if (update.docChanged) {
          const source = update.state.doc.toString();
          workspace.editText(currentFile.path, source);
          const scriptDiagnostics = diagnoseSageScript(source, currentFile.path, update.view);
          updateState(workspace.setScriptDiagnostics(currentFile.path, scriptDiagnostics));
        }
      })],
      parent: editorHost.current
    });
    editor.current = view;
    return () => { view.destroy(); editor.current = undefined; };
  }, [workspace, currentFile?.path, textFile]);

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

  const files = [...state.snapshot.files.keys()];
  const directories = new Set(state.snapshot.directories);
  for (const path of files) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  }
  const paths = [...directories, ...files];
  const compare = (a: string, b: string) => {
    if (sort === 'type') {
      const aDirectory = directories.has(a);
      const bDirectory = directories.has(b);
      if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
      const aExtension = a.split('.').at(-1) ?? '';
      const bExtension = b.split('.').at(-1) ?? '';
      if (!aDirectory && aExtension !== bExtension) return aExtension.localeCompare(bExtension);
    }
    return a.split('/').at(-1)!.localeCompare(b.split('/').at(-1)!);
  };
  const open = (path: string) => {
    if (directories.has(path)) { setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; }); return; }
    update(workspace.open(path));
    setTabs([...workspace.getOpenPaths()]);
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
        setTabs([...workspace.getOpenPaths()]);
        update(next);
      }
      catch (error) { window.alert(error instanceof Error ? error.message : 'Unable to rename path.'); }
    }
  };
  const remove = (path: string) => {
    if (!window.confirm(`Delete ${path}${state.snapshot.files.has(path) ? '?' : ' and its contents? '}`)) return;
    const next = workspace.delete(path);
    setTabs([...workspace.getOpenPaths()]);
    update(next);
  };

  const showContext = (path: string, x: number, y: number) => {
    setContext({ path, x: Math.min(x, window.innerWidth - 190), y: Math.min(y, window.innerHeight - 110) });
  };
  const renderEntry = (path: string, depth: number): React.ReactNode => {
    const isDirectory = directories.has(path);
    const children = paths.filter(candidate => candidate !== path && candidate.startsWith(path ? `${path}/` : '') && candidate.slice(path ? path.length + 1 : 0).indexOf('/') === -1).sort(compare);
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
  const visiblePaths = view === 'flat' ? paths.sort(compare) : paths.filter(path => !path.includes('/')).sort(compare);

  return <section className="sage-mode" aria-label="Sage Mode file editor">
    <aside className="sage-file-tree" aria-label="Project files">
      <div className="sage-explorer-heading"><h2>Explorer</h2><span>{files.length} files</span></div>
      <div className="sage-explorer-settings"><label>View<select aria-label="Explorer view" value={view} onChange={event => { const next = event.currentTarget.value as 'tree' | 'flat'; setView(next); localStorage.setItem('ds-sage-view', next); }}><option value="tree">Folders</option><option value="flat">Flat paths</option></select></label><label>Sort<select aria-label="Explorer sort" value={sort} onChange={event => { const next = event.currentTarget.value as 'name' | 'type'; setSort(next); localStorage.setItem('ds-sage-sort', next); }}><option value="name">Name</option><option value="type">Type</option></select></label></div>
      <ul className="sage-explorer-list">{visiblePaths.map(path => renderEntry(path, 0))}</ul>
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
      <section className="sage-diagnostics" aria-live="polite"><h2>Diagnostics</h2>{state.diagnostics.length === 0 ? <p>No diagnostics.</p> : <ul>{state.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}:${diagnostic.path ?? ''}:${index}`}>{diagnostic.severity.toUpperCase()} {diagnostic.path ?? ''}: {diagnostic.message}</li>)}</ul>}</section>
    </main>
  </section>;
}

export { isText as isSageTextFile };
