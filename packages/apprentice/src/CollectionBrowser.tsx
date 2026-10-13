import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

const PAGE_SIZE = 40;

export interface CollectionBrowserProps<T> {
  readonly name: string;
  readonly requestedIndex?: number | undefined;
  readonly requestKey?: number | undefined;
  readonly items: readonly T[];
  readonly title: (item: T, index: number) => string;
  readonly summary?: (item: T, index: number) => string;
  readonly renderEditor: (item: T, index: number) => ReactNode;
  readonly addLabel?: string;
  readonly onAdd?: () => void;
  readonly addDisabled?: boolean;
  readonly emptyText?: string;
  readonly onDeleteSelected?: (indices: readonly number[]) => void;
  readonly canDeleteSelected?: (indices: readonly number[]) => boolean;
  readonly deleteBlockedText?: string;
}

/** One mounted editor and a bounded result page, even when the project has thousands of entries. */
export function CollectionBrowser<T>({ name, items, requestedIndex, requestKey, title, summary, renderEditor, addLabel, onAdd, addDisabled = false, emptyText, onDeleteSelected, canDeleteSelected, deleteBlockedText }: CollectionBrowserProps<T>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedIndices, setSelectedIndices] = useState<readonly number[]>([]);
  const [selectionAnchor, setSelectionAnchor] = useState(0);
  const [page, setPage] = useState(0);
  useEffect(() => { setSelectedIndices([]); }, [items.length]);
  useEffect(() => { if (requestedIndex === undefined || requestedIndex < 0) return; setQuery(''); setSelectedIndex(requestedIndex); setSelectedIndices([requestedIndex]); setPage(Math.floor(requestedIndex / PAGE_SIZE)); }, [requestedIndex, requestKey]);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.map((item, index) => ({ item, index, label: title(item, index), detail: summary?.(item, index) ?? '' }))
      .filter(row => !needle || `${row.label} ${row.detail}`.toLocaleLowerCase().includes(needle));
  }, [items, query, title, summary]);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const visiblePage = Math.min(page, lastPage);
  const selected = items[Math.min(selectedIndex, items.length - 1)];
  const selectedRow = matches.find(row => row.index === selectedIndex);
  const selection = selectedIndices.filter(index => index < items.length);
  const canDelete = !!onDeleteSelected && (canDeleteSelected?.(selection) ?? true);
  const select = (index: number, event: MouseEvent<HTMLButtonElement>) => {
    if (!onDeleteSelected) { setSelectedIndex(index); return; }
    if (event.shiftKey) {
      const start = matches.findIndex(row => row.index === selectionAnchor);
      const end = matches.findIndex(row => row.index === index);
      const range = start < 0 ? [index] : matches.slice(Math.min(start, end), Math.max(start, end) + 1).map(row => row.index);
      setSelectedIndices(event.metaKey || event.ctrlKey ? [...new Set([...selection, ...range])] : range);
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedIndices(selection.includes(index) ? selection.filter(item => item !== index) : [...selection, index]);
      setSelectionAnchor(index);
    } else {
      setSelectedIndices([index]);
      setSelectionAnchor(index);
    }
    setSelectedIndex(index);
  };
  const deleteSelection = (indices: readonly number[]) => {
    if (!indices.length || !onDeleteSelected || canDeleteSelected?.(indices) === false) return;
    onDeleteSelected(indices);
    setSelectedIndices([]);
    setSelectedIndex(Math.min(...indices));
  };

  return <div className="apprentice-collection" aria-label={`${name} browser`}>
    <div className="apprentice-collection__bar">
      <span>{items.length} {name.toLocaleLowerCase()}</span>
      {addLabel && onAdd && <button type="button" disabled={addDisabled} onClick={() => { onAdd(); setSelectedIndex(items.length); setSelectedIndices([]); setQuery(''); setPage(Math.floor(items.length / PAGE_SIZE)); }}>{addLabel}</button>}
    </div>
    {items.length > 1 || onDeleteSelected && items.length > 0 ? <div className="apprentice-collection__navigation">
      <label>Find {name.toLocaleLowerCase()} <input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      {onDeleteSelected && <p className="apprentice-collection__hint">Shift-click for a range, Command/Ctrl-click to add, Command/Ctrl+A for filtered items, Delete or Command+Backspace to remove.</p>}
      <div className="apprentice-collection__list" aria-label={name} onKeyDown={event => {
        if (!onDeleteSelected) return;
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); setMenuOpen(true); return; }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault(); event.stopPropagation(); setSelectedIndices(matches.map(row => row.index)); setSelectionAnchor(matches[0]?.index ?? 0);
        } else if (event.key === 'Delete' || event.metaKey && event.key === 'Backspace') {
          event.preventDefault(); event.stopPropagation();
          const focusedIndex = event.target instanceof HTMLButtonElement ? Number(event.target.dataset['collectionIndex']) : NaN;
          deleteSelection(selection.length ? selection : Number.isInteger(focusedIndex) ? [focusedIndex] : []);
        } else if (event.key === 'Escape' && selection.length) {
          event.preventDefault(); event.stopPropagation(); setSelectedIndices([]);
        }
      }}>
        {matches.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE).map(row => <button key={row.index} type="button" data-collection-index={row.index} aria-pressed={onDeleteSelected ? selection.includes(row.index) : row.index === selectedIndex} onClick={event => select(row.index, event)} onContextMenu={event => { if (!onDeleteSelected) return; event.preventDefault(); if (!selection.includes(row.index)) { setSelectedIndices([row.index]); setSelectedIndex(row.index); } setMenuOpen(true); }}>
          <strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}
        </button>)}
        {!matches.length && <p>No matching {name.toLocaleLowerCase()}.</p>}
      </div>
      {matches.length > PAGE_SIZE && <div className="apprentice-collection__pages">
        <button type="button" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Previous</button>
        <span>{visiblePage * PAGE_SIZE + 1}–{Math.min((visiblePage + 1) * PAGE_SIZE, matches.length)} of {matches.length}</span>
        <button type="button" disabled={visiblePage === lastPage} onClick={() => setPage(visiblePage + 1)}>Next</button>
      </div>}
    </div> : null}
    {menuOpen && <div role="menu" aria-label={`${name} actions`} onKeyDown={event => { if (event.key === 'Escape') setMenuOpen(false); }}>
      <button autoFocus role="menuitem" type="button" onClick={() => { setSelectedIndices(matches.map(row => row.index)); setMenuOpen(false); }}>Select all filtered items</button>
      <button role="menuitem" type="button" disabled={!canDelete} onClick={() => { deleteSelection(selection.length ? selection : [selectedIndex]); setMenuOpen(false); }}>Delete selected</button>
      <button role="menuitem" type="button" onClick={() => setMenuOpen(false)}>Close menu</button>
    </div>}
    {onDeleteSelected && selection.length > 0 && <div className="apprentice-collection__bulk" aria-label={`Selected ${name.toLocaleLowerCase()}`}>
      <strong>{selection.length} selected</strong>
      <button type="button" className="apprentice-remove" disabled={!canDelete} onClick={() => deleteSelection(selection)}>Delete selected</button>
      {!canDelete && <p role="status">{deleteBlockedText ?? 'One or more selected items cannot be deleted while they are in use.'}</p>}
    </div>}
    {selected && selection.length <= 1 && <div className="apprentice-collection__detail" aria-label={`Edit ${name.toLocaleLowerCase()}: ${title(selected, Math.min(selectedIndex, items.length - 1))}`}>
      {query && !selectedRow && <p className="apprentice-collection__notice">The selected item is outside these search results. Choose a result to edit it.</p>}
      {renderEditor(selected, Math.min(selectedIndex, items.length - 1))}
    </div>}
    {!items.length && <p className="apprentice-empty">{emptyText ?? `No ${name.toLocaleLowerCase()} yet.`}</p>}
  </div>;
}
