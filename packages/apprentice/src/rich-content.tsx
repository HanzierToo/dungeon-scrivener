import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContentDigest,
  LocaleDocument,
  MediaAssetApi,
  SafeBlock,
  SafeInline,
  TextSource,
  WorldDocument,
} from '@dungeon-scrivener/model';
import { renderMarkdown } from '../../markdown/src/index.js';
import type { RegisteredAsset } from '../../media/src/index.js';
import { resolveText } from '../../i18n/src/index.js';

export interface RichContentEditorProps {
  readonly value: TextSource;
  readonly onChange: (value: TextSource) => void;
  readonly world: WorldDocument;
  readonly locales?: readonly LocaleDocument[] | undefined;
  readonly defaultLocale?: string | undefined;
  readonly assets?: readonly RegisteredAsset[] | undefined;
  readonly mediaAssets?: MediaAssetApi | undefined;
  readonly onLocalesChange?: ((locales: readonly LocaleDocument[]) => void) | undefined;
  /** The host registers bytes once and adds the resulting content-addressed file to the project VFS. */
  readonly onImportAsset?: ((file: File) => Promise<RegisteredAsset>) | undefined;
}

export function applyMarkdownSourceEdit(source: string, start: number, end: number, replacement: string): { readonly text: string; readonly cursor: number } {
  return { text: source.slice(0, start) + replacement + source.slice(end), cursor: start + replacement.length };
}

function AssetInline({ value, mediaAssets }: { value: Extract<SafeInline, { kind: 'asset' }>; mediaAssets?: MediaAssetApi | undefined }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!mediaAssets) return undefined;
    const resolution = mediaAssets.resolveAsset(value.assetId);
    if (!resolution.ok || (!resolution.asset.mediaType.startsWith('image/') && !resolution.asset.mediaType.startsWith('audio/'))) return undefined;
    const objectUrl = URL.createObjectURL(new Blob([resolution.asset.bytes.slice().buffer], { type: resolution.asset.mediaType }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [mediaAssets, value.assetId]);
  if (!url) return <span>[Media: {value.alt || value.assetId}]</span>;
  return value.mediaType.startsWith('image/')
    ? <img src={url} alt={value.alt} style={{ maxWidth: '100%', maxHeight: 360 }} />
    : <audio src={url} controls aria-label={value.alt || 'Embedded audio'} />;
}

function InlineView({ value, mediaAssets }: { value: SafeInline; mediaAssets?: MediaAssetApi | undefined }) {
  switch (value.kind) {
    case 'text': return <>{value.text}</>;
    case 'code': return <code>{value.text}</code>;
    case 'emphasis': return <em>{value.children.map((child, index) => <InlineView key={index} value={child} mediaAssets={mediaAssets} />)}</em>;
    case 'strong': return <strong>{value.children.map((child, index) => <InlineView key={index} value={child} mediaAssets={mediaAssets} />)}</strong>;
    case 'node-link': return <span title={`Node ${value.nodeId}`}>{value.label}</span>;
    case 'external-link': return <a href={value.href} rel="noreferrer">{value.label}</a>;
    case 'asset': return <AssetInline value={value} mediaAssets={mediaAssets} />;
  }
}

function BlockView({ block, mediaAssets }: { block: SafeBlock; mediaAssets?: MediaAssetApi | undefined }): React.ReactElement {
  const inline = (children: readonly SafeInline[]) => children.map((child, index) => <InlineView key={index} value={child} mediaAssets={mediaAssets} />);
  switch (block.kind) {
    case 'paragraph': return <p>{inline(block.children)}</p>;
    case 'heading': {
      const Heading = `h${block.level}` as keyof React.JSX.IntrinsicElements;
      return <Heading>{inline(block.children)}</Heading>;
    }
    case 'blockquote': return <blockquote>{block.blocks.map((child, index) => <BlockView key={index} block={child} mediaAssets={mediaAssets} />)}</blockquote>;
    case 'callout': return <aside className={`markdown-callout markdown-callout-${block.tone}`}><strong>{block.tone}</strong>{block.blocks.map((child, index) => <BlockView key={index} block={child} mediaAssets={mediaAssets} />)}</aside>;
    case 'node-embed': return <aside aria-label={`Embedded node ${block.nodeId}`}>{block.blocks.map((child, index) => <BlockView key={index} block={child} mediaAssets={mediaAssets} />)}</aside>;
    case 'code-block': return <pre><code>{block.text}</code></pre>;
    case 'thematic-break': return <hr />;
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return <List>{block.items.map((item, index) => <li key={index}>{item.map((child, childIndex) => <BlockView key={childIndex} block={child} mediaAssets={mediaAssets} />)}</li>)}</List>;
    }
    case 'table': return <table><thead><tr>{block.header.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table>;
  }
}

function insertAssetReference(source: string, start: number, end: number, asset: RegisteredAsset, alt: string) {
  const token = `![[asset:${asset.assetId}${alt ? `|${alt.replace(/[\]\n]/g, ' ')}` : ''}]]`;
  return applyMarkdownSourceEdit(source, start, end, token);
}

export function RichContentEditor({ value, onChange, world, locales = [], defaultLocale, assets = [], mediaAssets, onLocalesChange, onImportAsset }: RichContentEditorProps) {
  const [previewLocale, setPreviewLocale] = useState(defaultLocale ?? '');
  const [sourceMode, setSourceMode] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [altText, setAltText] = useState('');
  const [assetMessage, setAssetMessage] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const translationKeys = useMemo(() => [...new Set(locales.flatMap((locale) => Object.keys(locale.strings)))].sort(), [locales]);
  const defaultTag = defaultLocale ?? '';
  const textResolution = value.kind === 'literal'
    ? { text: value.text, diagnostics: [] }
    : resolveText({ source: value, locales, ...(previewLocale ? { requestedLocale: previewLocale } : {}), defaultLocale: defaultTag });
  const source = textResolution.text;
  const rendered = renderMarkdown({ source, world, locales, ...(previewLocale ? { locale: previewLocale } : {}), ...(defaultTag ? { defaultLocale: defaultTag } : {}), ...(mediaAssets ? { assets: mediaAssets } : {}) });
  const markdownDiagnostics = [...textResolution.diagnostics, ...rendered.diagnostics];

  const commitSource = (nextText: string) => {
    if (value.kind === 'literal') {
      onChange({ kind: 'literal', text: nextText });
      return;
    }
    const locale = locales.find((item) => item.locale === previewLocale);
    if (!locale || !onLocalesChange) return;
    onLocalesChange(locales.map((item) => item.locale === locale.locale
      ? { ...item, strings: { ...item.strings, [value.key]: nextText } }
      : item));
  };

  const editAvailable = value.kind === 'literal' || (locales.some((locale) => locale.locale === previewLocale && locale.strings[value.key] !== undefined) && onLocalesChange !== undefined);
  const insert = (before: string, after = before) => {
    if (!editAvailable) return;
    const element = textarea.current;
    const start = element?.selectionStart ?? source.length;
    const end = element?.selectionEnd ?? source.length;
    const selected = source.slice(start, end);
    const next = applyMarkdownSourceEdit(source, start, end, `${before}${selected}${after}`);
    commitSource(next.text);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(next.cursor, next.cursor); });
  };

  const addTranslation = () => {
    if (value.kind !== 'locale-key' || !previewLocale || !onLocalesChange) return;
    const existing = locales.find((locale) => locale.locale === previewLocale);
    const initialText = source;
    if (existing) {
      onLocalesChange(locales.map((locale) => locale.locale === previewLocale ? { ...locale, strings: { ...locale.strings, [value.key]: initialText } } : locale));
    } else {
      onLocalesChange([...locales, { format: 'dungeon-scrivener-locale', schemaVersion: 1, locale: previewLocale, strings: { [value.key]: initialText } }]);
    }
  };

  const chooseAsset = (asset: RegisteredAsset) => {
    const element = textarea.current;
    const start = element?.selectionStart ?? source.length;
    const end = element?.selectionEnd ?? source.length;
    const next = insertAssetReference(source, start, end, asset, altText);
    commitSource(next.text);
    setAssetMessage(`Inserted managed asset reference ${asset.assetId}.`);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(next.cursor, next.cursor); });
  };

  const importAsset = async (file: File) => {
    if (!onImportAsset) return;
    try {
      const asset = await onImportAsset(file);
      setSelectedAssetId(asset.assetId);
      chooseAsset(asset);
    } catch (error) {
      setAssetMessage(error instanceof Error ? error.message : 'Asset could not be added to this project.');
    }
  };

  return <section aria-label="Visual Markdown editor" style={{ display: 'grid', gap: 8 }}>
    <h3>Node text</h3>
    <label>Content source <select value={value.kind} onChange={(event) => onChange(event.target.value === 'literal' ? { kind: 'literal', text: source } : { kind: 'locale-key', key: '' })}><option value="literal">Markdown text</option><option value="locale-key">Translation key</option></select></label>
    {value.kind === 'locale-key' && <>
      <label>Translation key <input list="apprentice-locale-keys" value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })} /></label>
      <datalist id="apprentice-locale-keys">{translationKeys.map((key) => <option key={key} value={key} />)}</datalist>
    </>}
    <label>Preview language <select value={previewLocale} onChange={(event) => setPreviewLocale(event.target.value)}><option value="">Choose language</option>{[...new Set([...(defaultTag ? [defaultTag] : []), ...locales.map((locale) => locale.locale)])].map((locale) => <option key={locale} value={locale}>{locale}</option>)}</select></label>
    {value.kind === 'locale-key' && !editAvailable && <div><p role="status">Showing language fallback. Add a translation before editing this language.</p><button type="button" disabled={!onLocalesChange || !previewLocale} onClick={addTranslation}>Add translation for {value.key || 'new key'}</button></div>}
    <div role="tablist" aria-label="Markdown editing mode">
      <button type="button" role="tab" aria-selected={!sourceMode} onClick={() => setSourceMode(false)}>Visual editor</button>
      <button type="button" role="tab" aria-selected={sourceMode} onClick={() => setSourceMode(true)}>Source escape hatch</button>
    </div>
    {!sourceMode && <div role="toolbar" aria-label="Markdown formatting">
      <button type="button" disabled={!editAvailable} onClick={() => insert('**')}>Bold</button>
      <button type="button" disabled={!editAvailable} onClick={() => insert('*')}>Italic</button>
      <button type="button" disabled={!editAvailable} onClick={() => insert('`')}>Code</button>
      <button type="button" disabled={!editAvailable} onClick={() => insert('## ', '\n')}>Heading</button>
      <button type="button" disabled={!editAvailable} onClick={() => insert('> ', '\n')}>Callout / quote</button>
      <button type="button" disabled={!editAvailable} onClick={() => insert('- ', '\n')}>List item</button>
      <button type="button" disabled={!editAvailable} onClick={() => insert('[', '](https://)')}>Link</button>
      <button type="button" disabled={!editAvailable} onClick={() => insert('```\n', '\n```')}>Code block</button>
    </div>}
    <textarea ref={textarea} aria-label={sourceMode ? 'Markdown source' : 'Markdown visual editor source'} rows={12} style={{ fontFamily: 'monospace', width: '100%' }} value={source} readOnly={!editAvailable} onChange={(event) => commitSource(event.target.value)} />
    <section aria-label="Rendered Markdown preview">
      <h4>Rendered preview</h4>
      {rendered.blocks.map((block, index) => <BlockView key={index} block={block} mediaAssets={mediaAssets} />)}
      {markdownDiagnostics.map((item, index) => <p key={`${item.code}-${index}`} role="status">{item.message}</p>)}
    </section>
    <fieldset>
      <legend>Reuse a media asset</legend>
      <label>Existing asset <select value={selectedAssetId} onChange={(event) => setSelectedAssetId(event.target.value)}><option value="">Choose existing asset</option>{assets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.originalFilenames.join(', ')} · {asset.mediaType} · {asset.assetId}</option>)}</select></label>
      <label>Alternative text <input value={altText} onChange={(event) => setAltText(event.target.value)} /></label>
      <button type="button" disabled={!editAvailable || !assets.some((asset) => asset.assetId === selectedAssetId)} onClick={() => { const asset = assets.find((item) => item.assetId === selectedAssetId); if (asset) chooseAsset(asset); }}>Insert reference</button>
      {onImportAsset && <label>Add asset file <input type="file" accept="image/png,image/jpeg,image/webp,audio/wav,audio/ogg,audio/mpeg" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importAsset(file); event.currentTarget.value = ''; }} /></label>}
      {assetMessage && <p role="status">{assetMessage}</p>}
      <p>Assets are referenced by content digest. Reusing an existing asset adds another reference without copying its bytes.</p>
    </fieldset>
  </section>;
}

export function markdownAssetId(value: string): ContentDigest | undefined {
  return /^sha256:[a-f0-9]{64}$/u.test(value) ? value as ContentDigest : undefined;
}
