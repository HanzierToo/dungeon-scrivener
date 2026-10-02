import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const PAGE_SIZE = 40;

export interface CollectionBrowserProps<T> {
  readonly name: string;
  readonly items: readonly T[];
  readonly title: (item: T, index: number) => string;
  readonly summary?: (item: T, index: number) => string;
  readonly renderEditor: (item: T, index: number) => ReactNode;
  readonly addLabel?: string;
  readonly onAdd?: () => void;
  readonly addDisabled?: boolean;
  readonly emptyText?: string;
}

/** One mounted editor and a bounded result page, even when the project has thousands of entries. */
export function CollectionBrowser<T>({ name, items, title, summary, renderEditor, addLabel, onAdd, addDisabled = false, emptyText }: CollectionBrowserProps<T>) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [page, setPage] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.map((item, index) => ({ item, index, label: title(item, index), detail: summary?.(item, index) ?? '' }))
      .filter(row => !needle || `${row.label} ${row.detail}`.toLocaleLowerCase().includes(needle));
  }, [items, query, title, summary]);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const visiblePage = Math.min(page, lastPage);
  const selected = items[Math.min(selectedIndex, items.length - 1)];
  const selectedRow = matches.find(row => row.index === selectedIndex);

  return <div className="apprentice-collection" aria-label={`${name} browser`}>
    <div className="apprentice-collection__bar">
      <span>{items.length} {name.toLocaleLowerCase()}</span>
      {addLabel && onAdd && <button type="button" disabled={addDisabled} onClick={() => { onAdd(); setSelectedIndex(items.length); setQuery(''); setPage(Math.floor(items.length / PAGE_SIZE)); }}>{addLabel}</button>}
    </div>
    {items.length > 1 && <div className="apprentice-collection__navigation">
      <label>Find {name.toLocaleLowerCase()} <input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <div className="apprentice-collection__list" aria-label={name}>
        {matches.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE).map(row => <button key={row.index} type="button" aria-pressed={row.index === selectedIndex} onClick={() => setSelectedIndex(row.index)}>
          <strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}
        </button>)}
        {!matches.length && <p>No matching {name.toLocaleLowerCase()}.</p>}
      </div>
      {matches.length > PAGE_SIZE && <div className="apprentice-collection__pages">
        <button type="button" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Previous</button>
        <span>{visiblePage * PAGE_SIZE + 1}–{Math.min((visiblePage + 1) * PAGE_SIZE, matches.length)} of {matches.length}</span>
        <button type="button" disabled={visiblePage === lastPage} onClick={() => setPage(visiblePage + 1)}>Next</button>
      </div>}
    </div>}
    {selected && <div className="apprentice-collection__detail" aria-label={`Edit ${name.toLocaleLowerCase()}: ${title(selected, Math.min(selectedIndex, items.length - 1))}`}>
      {query && !selectedRow && <p className="apprentice-collection__notice">The selected item is outside these search results. Choose a result to edit it.</p>}
      {renderEditor(selected, Math.min(selectedIndex, items.length - 1))}
    </div>}
    {!items.length && <p className="apprentice-empty">{emptyText ?? `No ${name.toLocaleLowerCase()} yet.`}</p>}
  </div>;
}
