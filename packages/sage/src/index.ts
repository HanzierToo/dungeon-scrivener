import { EditorView, basicSetup } from 'codemirror';
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
    if (this.active === from) this.active = to;
    this.dirty.add(from);
    this.dirty.add(to);
    return this.afterEdit();
  }

  delete(path: string): SageWorkspaceState {
    this.current = deleteProjectPath(this.current, path);
    this.scriptDiagnostics.delete(path);
    if (this.active === path) this.active = undefined;
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
}

/** File-tree IDE view. File bytes remain in the VFS while tabs are switched. */
export function SageMode({ workspace, onStateChange }: SageModeProps): React.ReactElement {
  const [state, setState] = useState(workspace.getState());
  const [tabs, setTabs] = useState<string[]>([]);
  const [pathInput, setPathInput] = useState('');
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
      extensions: [basicSetup, ...editorExtensions(currentFile.path), EditorView.updateListener.of(update => {
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

  const paths = [...state.snapshot.directories, ...state.snapshot.files.keys()].sort((a, b) => a.localeCompare(b));
  const open = (path: string) => {
    update(workspace.open(path));
    setTabs(existing => existing.includes(path) ? existing : [...existing, path]);
  };
  const create = (directory: boolean) => {
    if (!pathInput) return;
    try {
      const next = directory ? workspace.createDirectory(pathInput) : workspace.createFile(pathInput);
      update(next);
      if (!directory) { setTabs(existing => [...existing, pathInput]); open(pathInput); }
      setPathInput('');
    } catch (error) { window.alert(error instanceof Error ? error.message : 'Unable to create path.'); }
  };
  const rename = (path: string) => {
    const target = window.prompt('Rename path', path);
    if (target && target !== path) {
      try { update(workspace.rename(path, target)); setTabs(existing => existing.map(tab => tab === path ? target : tab)); }
      catch (error) { window.alert(error instanceof Error ? error.message : 'Unable to rename path.'); }
    }
  };
  const remove = (path: string) => {
    if (!window.confirm(`Delete ${path}${state.snapshot.files.has(path) ? '?' : ' and its contents? '}`)) return;
    update(workspace.delete(path));
    setTabs(existing => existing.filter(tab => tab !== path));
  };

  return React.createElement('section', { className: 'sage-mode', 'aria-label': 'Sage Mode file editor' },
    React.createElement('aside', { className: 'sage-file-tree', 'aria-label': 'Project files' },
      React.createElement('h2', null, 'Project files'),
      React.createElement('ul', null, ...paths.map(path => React.createElement('li', { key: path },
        React.createElement('button', { type: 'button', onClick: () => open(path) }, path),
        React.createElement('button', { type: 'button', onClick: () => rename(path), 'aria-label': `Rename ${path}` }, 'Rename'),
        React.createElement('button', { type: 'button', onClick: () => remove(path), 'aria-label': `Delete ${path}` }, 'Delete')))),
      React.createElement('label', null, 'New path', React.createElement('input', { value: pathInput, onChange: event => setPathInput(event.currentTarget.value) })),
      React.createElement('button', { type: 'button', onClick: () => create(false) }, 'New file'),
      React.createElement('button', { type: 'button', onClick: () => create(true) }, 'New folder'),
      React.createElement('button', { type: 'button', onClick: () => { void workspace.exportZip().then(bytes => {
        const zipBytes = new Uint8Array(bytes);
        const url = URL.createObjectURL(new Blob([zipBytes.buffer], { type: 'application/zip' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'project.zip'; anchor.click(); URL.revokeObjectURL(url);
      }); } }, 'Export project ZIP')),
    React.createElement('main', { className: 'sage-editor-area' },
      React.createElement('nav', { 'aria-label': 'Open files', role: 'tablist' }, ...tabs.map(path => React.createElement('button', {
        key: path, type: 'button', role: 'tab', 'aria-selected': state.activePath === path, onClick: () => open(path)
      }, path))),
      currentFile ? textFile
        ? React.createElement('div', { className: 'sage-code-editor', ref: editorHost, 'aria-label': `Editor for ${currentFile.path}` })
        : React.createElement('section', { className: 'sage-binary-preview', 'aria-label': `Binary preview for ${currentFile.path}` },
          React.createElement('p', null, `${currentFile.bytes.byteLength} bytes`),
          React.createElement('pre', null, Array.from(currentFile.bytes.slice(0, 256), (byte: number) => byte.toString(16).padStart(2, '0')).join(' ')),
          currentFile.bytes.byteLength > 256 ? React.createElement('p', null, 'Preview limited to the first 256 bytes.') : null)
        : React.createElement('p', null, 'Choose a project file to edit.'),
      React.createElement('section', { className: 'sage-diagnostics', 'aria-live': 'polite' },
        React.createElement('h2', null, 'Diagnostics'),
        state.diagnostics.length === 0 ? React.createElement('p', null, 'No diagnostics.') : React.createElement('ul', null,
          ...state.diagnostics.map((diagnostic, index) => React.createElement('li', { key: `${diagnostic.code}:${diagnostic.path ?? ''}:${index}` },
            `${diagnostic.severity.toUpperCase()} ${diagnostic.path ?? ''}: ${diagnostic.message}`)))))
  );
}

export { isText as isSageTextFile };
