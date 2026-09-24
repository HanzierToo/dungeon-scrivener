import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Diagnostic, DiagnosticReport, MediaAssetApi, PlayerInput, PlayerInputTransitionResult, PlayerView, ResolvedMediaAsset, SafeBlock, SafeInline, TransitionTraceRecord } from '@dungeon-scrivener/model';
import { isOfflineSafeTheme } from './theme.js';
import './player.css';

export interface PlayerLocaleOption { readonly locale: string; readonly label: string }
export interface PlayerProps {
  readonly view?: PlayerView | undefined;
  readonly onInput: (input: PlayerInput) => PlayerInputTransitionResult | void | Promise<PlayerInputTransitionResult | void>;
  readonly startupFailure?: DiagnosticReport | undefined;
  readonly themeCss?: string;
  readonly mediaAssets?: MediaAssetApi | undefined;
  readonly locales?: readonly PlayerLocaleOption[];
  readonly onLocaleChange?: (locale: string) => void;
  readonly onLoad?: (file: File) => void;
  readonly saveSlots?: readonly { readonly slotId: string; readonly label: string }[];
  readonly onSave?: (slotId: string) => Promise<string | undefined>;
  readonly persistenceNotice?: string;
  readonly onOpenSettings?: () => void;
  readonly titleContent?: ReactNode;
  readonly settingsContent?: ReactNode;
}

interface PlayerFeedback { readonly trace: readonly TransitionTraceRecord[]; readonly diagnostics: readonly Diagnostic[] }

export function Player({ view, onInput, startupFailure, themeCss, mediaAssets, locales = [], onLocaleChange, onLoad, saveSlots = [], onSave, persistenceNotice, onOpenSettings, titleContent, settingsContent }: PlayerProps) {
  const [command, setCommand] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typingSoundsEnabled, setTypingSoundsEnabled] = useState(true);
  const [mediaNotice, setMediaNotice] = useState('');
  const [actionFeedback, setActionFeedback] = useState<PlayerFeedback>();
  const [actionPending, setActionPending] = useState(false);
  const [saveSlotId, setSaveSlotId] = useState(saveSlots[0]?.slotId ?? '');
  const [saveFeedback, setSaveFeedback] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputId = useId();
  const commandId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const safeTheme = themeCss && isOfflineSafeTheme(themeCss) ? themeCss : undefined;
  const hasRejectedTheme = Boolean(themeCss && !safeTheme);

  if (startupFailure || !view) return <main className="ds-player ds-player__startup-error" role="alert"><h1>Game could not be started</h1>{startupFailure?.diagnostics.length ? startupFailure.diagnostics.map((diagnostic, index) => <DiagnosticMessage key={`${diagnostic.code}-${index}`} diagnostic={diagnostic} />) : <p>No playable session is available.</p>}</main>;
  const activeView = view;


  function playTypingSound(code: string) {
    if (!typingSoundsEnabled || !mediaAssets) return;
    const mapping = activeView.typingSounds.mappings.find(item => item.target.kind === 'key' && item.target.code === code)
      ?? activeView.typingSounds.mappings.find(item => item.target.kind === 'group' && item.target.group === keyGroup(code));
    const primary = mapping ? mediaAssets.resolveAsset(mapping.asset.assetId) : undefined;
    if (primary?.ok) playResolvedSound({ asset: primary.asset, volume: mapping!.volume, fallback: false }, false);
    else playFallback(primary && !primary.ok ? primary.diagnostic.message : '');
  }

  function playFallback(reason: string) {
    const fallback = activeView.typingSounds.fallback;
    if (fallback.kind === 'silent' || !mediaAssets) { if (reason) setMediaNotice(reason); return; }
    const resolved = mediaAssets.resolveAsset(fallback.asset.assetId);
    if (!resolved.ok) { setMediaNotice(resolved.diagnostic.message); return; }
    playResolvedSound({ asset: resolved.asset, volume: fallback.volume, fallback: true }, true);
  }

  function playResolvedSound(result: { readonly asset: ResolvedMediaAsset; readonly volume: number; readonly fallback: boolean }, triedFallback: boolean) {
    try {
      const url = URL.createObjectURL(new Blob([new Uint8Array(result.asset.bytes)], { type: 'audio/wav' }));
      const audio = new Audio(url);
      audio.volume = result.volume;
      audioRef.current?.pause();
      audioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (!triedFallback && !result.fallback && mediaAssets) {
          playFallback('');
        } else setMediaNotice('A typing sound could not be played.');
      };
      void audio.play().catch(() => {
        URL.revokeObjectURL(url);
        if (!triedFallback && !result.fallback && mediaAssets) {
          playFallback('');
        } else setMediaNotice('A typing sound could not be played.');
      });
      setMediaNotice('');
    } catch {
      if (!triedFallback && !result.fallback && mediaAssets) {
        playFallback('');
      } else setMediaNotice('A typing sound could not be played.');
    }
  }

  async function submitPlayerInput(input: PlayerInput) {
    setActionPending(true);
    try {
      const result = await onInput(input);
      setActionFeedback(result ? { trace: result.trace, diagnostics: result.diagnostics.diagnostics } : undefined);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The action could not be completed.';
      setActionFeedback({ trace: [], diagnostics: [{ code: 'DS-PLAYER-ACTION', severity: 'error', message, entityId: activeView.currentNode.id, blocks: ['play'] }] });
      return undefined;
    } finally {
      setActionPending(false);
    }
  }

  function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!command.trim()) return;
    void submitPlayerInput({ kind: 'command-text', rawText: command }).then(result => {
      if (!result || !result.diagnostics.diagnostics.some(diagnostic => diagnostic.severity === 'error' || diagnostic.severity === 'fatal')) setCommand('');
    });
  }

  return <div className="ds-player" data-project-id={view.projectId}>
    {safeTheme ? <style data-player-theme="author">{safeTheme}</style> : null}
    <header className="ds-player__header">
      <div className="ds-player__brand">{titleContent ?? <h1>{view.gameTitle}</h1>}{view.clock ? <p className="ds-player__clock" aria-label={`Game time: ${view.clock.display}`}>{view.clock.display}</p> : null}</div>
      <nav className="ds-player__toolbar" aria-label="Game controls">
        {onOpenSettings || settingsContent || (locales.length && onLocaleChange) ? <button type="button" onClick={() => { setSettingsOpen(value => !value); onOpenSettings?.(); }} aria-expanded={settingsOpen} aria-controls="ds-player-settings">Settings</button> : null}
        {onSave && saveSlots.length ? <><label htmlFor="ds-player-save-slot">Save slot</label><select id="ds-player-save-slot" value={saveSlotId} onChange={event => setSaveSlotId(event.currentTarget.value)}>{saveSlots.map(slot => <option key={slot.slotId} value={slot.slotId}>{slot.label}</option>)}</select><button type="button" onClick={() => { void onSave(saveSlotId).then(message => setSaveFeedback(message ?? 'Game saved.')).catch(error => setSaveFeedback(error instanceof Error ? error.message : 'The game could not be saved.')); }}>Save game</button></> : null}
        {onLoad ? <><button type="button" onClick={() => fileInput.current?.click()}>Load game</button><label className="ds-player__visually-hidden" htmlFor={fileInputId}>Choose a game save file</label><input ref={fileInput} id={fileInputId} className="ds-player__visually-hidden" type="file" accept=".zip,application/zip" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) onLoad(file); event.currentTarget.value = ''; }} /></> : null}
      </nav>
    </header>
    {hasRejectedTheme ? <p className="ds-player__notice" role="status">Custom theme blocked because it can load external resources or is too large.</p> : null}
    {mediaNotice ? <p className="ds-player__notice" role="status">{mediaNotice}</p> : null}
    {saveFeedback ? <p className="ds-player__notice" role={saveFeedback === 'Game saved.' ? 'status' : 'alert'}>{saveFeedback}</p> : null}
    {persistenceNotice ? <p className="ds-player__notice" role="alert">{persistenceNotice}</p> : null}
    {actionFeedback?.diagnostics.length ? <section className="ds-player__diagnostics ds-player__action-errors" aria-label="Action diagnostics" role="alert">{actionFeedback.diagnostics.map((diagnostic, index) => <DiagnosticMessage key={`${diagnostic.code}-${index}`} diagnostic={diagnostic} nodeId={view.currentNode.id} trace={actionFeedback.trace} />)}</section> : null}
    {view.diagnostics.length ? <section className="ds-player__diagnostics" aria-label="Game notices" aria-live="polite">{view.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}>{diagnostic.message}</p>)}</section> : null}
    <div className="ds-player__layout">
      <main className="ds-player__main">
        <article className="ds-player__scene" aria-labelledby="ds-player-scene-title"><h2 id="ds-player-scene-title">{view.currentNode.title}</h2><div className="ds-player__content">{view.currentNode.blocks.map((block, index) => renderBlock(block, `block-${index}`, mediaAssets, nodeId => { void submitPlayerInput({ kind: 'node-link', nodeId }); }))}</div></article>
        {view.dialogue ? <section className="ds-player__dialogue" aria-labelledby="ds-player-speaker"><h3 id="ds-player-speaker">{view.dialogue.speakerName}</h3><p>{view.dialogue.text}</p><div className="ds-player__actions" aria-label="Dialogue options">{view.dialogue.options.map(option => <button type="button" key={option.id} disabled={!option.enabled || actionPending} title={!option.enabled ? option.disabledReason : undefined} onClick={() => void submitPlayerInput({ kind: 'dialogue-option', conversationId: view.dialogue!.conversationId, lineId: view.dialogue!.lineId, optionId: option.id })}>{option.label}{!option.enabled && option.disabledReason ? ` . ${option.disabledReason}` : ''}</button>)}{view.dialogue.canResume && !view.dialogue.options.length ? <p>Conversation can be resumed by an available game action.</p> : null}</div></section> : null}
        {(view.choices.length || view.commands.length) ? <section className="ds-player__choices" aria-labelledby="ds-player-choices-title"><h3 id="ds-player-choices-title">What do you do?</h3><div className="ds-player__actions">{view.choices.map(choice => <button type="button" key={choice.id} disabled={!choice.enabled || actionPending} title={!choice.enabled ? choice.disabledReason : undefined} onClick={() => void submitPlayerInput({ kind: 'choice', actionId: choice.id })}>{choice.label}{!choice.enabled && choice.disabledReason ? ` . ${choice.disabledReason}` : ''}</button>)}</div>
          {view.commands.length ? <form className="ds-player__command" onSubmit={submitCommand}><label htmlFor={commandId}>Type an action</label><div className="ds-player__command-row"><input id={commandId} value={command} onChange={event => setCommand(event.currentTarget.value)} onKeyDown={event => playTypingSound(event.code)} autoComplete="off" /><button type="submit" disabled={actionPending}>Send</button></div><details><summary>Available commands</summary><ul>{view.commands.map(item => <li key={item.id}>{item.patterns.join(' / ')}{!item.enabled && item.disabledReason ? ` . ${item.disabledReason}` : ''}</li>)}</ul></details></form> : null}
        </section> : null}
      </main>
      {view.inventory ? <aside className="ds-player__inventory" aria-labelledby="ds-player-inventory-title"><h2 id="ds-player-inventory-title">Inventory</h2>{view.inventory.length ? <ul>{view.inventory.map(item => <li key={item.stackId}><span>{item.label}{item.quantity > 1 ? ` × ${item.quantity}` : ''}</span>{item.equippedSlot ? <span className="ds-player__item-detail">Equipped: {item.equippedSlot}</span> : null}</li>)}</ul> : <p>Your inventory is empty.</p>}</aside> : null}
    </div>
    {actionFeedback?.trace.length ? <details className="ds-player__trace"><summary>Recent action trace</summary><ol>{actionFeedback.trace.map(record => <li key={`${record.sequence}-${record.kind}`}>{record.reason}</li>)}</ol></details> : null}
    {settingsOpen ? <section className="ds-player__settings" id="ds-player-settings" aria-label="Settings" tabIndex={-1}><div className="ds-player__settings-heading"><h2>Settings</h2><button type="button" onClick={() => setSettingsOpen(false)}>Close settings</button></div>{view.typingSounds.mappings.length ? <label><input type="checkbox" checked={typingSoundsEnabled} onChange={event => setTypingSoundsEnabled(event.currentTarget.checked)} />Enable typing sounds</label> : null}{locales.length && onLocaleChange ? <label>Language<select value={view.locale} onChange={event => onLocaleChange(event.currentTarget.value)}>{locales.map(locale => <option key={locale.locale} value={locale.locale}>{locale.label}</option>)}</select></label> : null}{settingsContent}</section> : null}
    <p className="ds-player__locale" aria-label={`Current language: ${view.locale}`}>{view.locale}</p>
  </div>;
}

function renderBlock(block: SafeBlock, key: string, mediaAssets?: MediaAssetApi, onNodeLink?: (nodeId: string) => void): ReactNode {
  switch (block.kind) {
    case 'paragraph': return <p key={key}>{block.children.map((child, i) => renderInline(child, `${key}-${i}`, mediaAssets, onNodeLink))}</p>;
    case 'heading': { const children = block.children.map((child, i) => renderInline(child, `${key}-${i}`, mediaAssets, onNodeLink)); const headings = { 1: <h1 key={key}>{children}</h1>, 2: <h2 key={key}>{children}</h2>, 3: <h3 key={key}>{children}</h3>, 4: <h4 key={key}>{children}</h4>, 5: <h5 key={key}>{children}</h5>, 6: <h6 key={key}>{children}</h6> }; return headings[block.level]; }
    case 'blockquote': return <blockquote key={key}>{block.blocks.map((child, i) => renderBlock(child, `${key}-${i}`, mediaAssets, onNodeLink))}</blockquote>;
    case 'code-block': return <pre key={key}><code>{block.text}</code></pre>;
    case 'thematic-break': return <hr key={key} />;
    case 'table': return <table key={key}><thead><tr>{block.header.map((cell, i) => <th key={i} scope="col">{cell.map((child, j) => renderInline(child, `${key}-h${i}-${j}`, mediaAssets, onNodeLink))}</th>)}</tr></thead><tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell.map((child, k) => renderInline(child, `${key}-r${i}-${j}-${k}`, mediaAssets, onNodeLink))}</td>)}</tr>)}</tbody></table>;
    case 'list': { const items = block.items.map((item, i) => <li key={i}>{item.map((child, j) => renderBlock(child, `${key}-${i}-${j}`, mediaAssets, onNodeLink))}</li>); return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>; }
    case 'callout': return <aside key={key} className={`ds-player__callout ds-player__callout--${block.tone}`}><strong>{block.tone}</strong>{block.blocks.map((child, i) => renderBlock(child, `${key}-${i}`, mediaAssets, onNodeLink))}</aside>;
    case 'node-embed': return <section key={key} className="ds-player__embed" aria-label="Embedded passage">{block.blocks.map((child, i) => renderBlock(child, `${key}-${i}`, mediaAssets, onNodeLink))}</section>;
  }
}

function renderInline(node: SafeInline, key: string, mediaAssets?: MediaAssetApi, onNodeLink?: (nodeId: string) => void): ReactNode {
  switch (node.kind) {
    case 'text': return node.text;
    case 'code': return <code key={key}>{node.text}</code>;
    case 'emphasis': return <em key={key}>{node.children.map((child, i) => renderInline(child, `${key}-${i}`, mediaAssets, onNodeLink))}</em>;
    case 'strong': return <strong key={key}>{node.children.map((child, i) => renderInline(child, `${key}-${i}`, mediaAssets, onNodeLink))}</strong>;
    case 'node-link': return <a key={key} href={`#${encodeURIComponent(node.nodeId)}`} onClick={event => { event.preventDefault(); onNodeLink?.(node.nodeId); }}>{node.label}</a>;
    case 'external-link': return <a key={key} href={node.href} rel="noreferrer noopener">{node.label}</a>;
    case 'asset': return <ManagedAsset key={key} assetId={node.assetId} mediaType={node.mediaType} alt={node.alt} mediaAssets={mediaAssets} />;
  }
}

function keyGroup(code: string): string {
  if (/^Key[A-Z]$/u.test(code)) return 'letters';
  if (/^(?:Digit[0-9]|Numpad[0-9])$/u.test(code)) return 'digits';
  if (code === 'Space') return 'space';
  if (/^(?:Backquote|Backslash|BracketLeft|BracketRight|Comma|Equal|IntlBackslash|IntlRo|IntlYen|Minus|Period|Quote|Semicolon|Slash)$/u.test(code)) return 'punctuation';
  if (/^(?:Backspace|Delete|Enter|Tab|Escape|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert)$/u.test(code)) return 'editing';
  return 'other';
}


function DiagnosticMessage({ diagnostic, nodeId, trace = [] }: { readonly diagnostic: Diagnostic; readonly nodeId?: string; readonly trace?: readonly TransitionTraceRecord[] }) {
  const scriptRecord = trace.find(record => record.source.kind === 'script');
  const scriptId = diagnostic.entityId ?? (scriptRecord?.source.kind === 'script' ? scriptRecord.source.scriptId : undefined);
  const location = diagnostic.sourceSpan;
  return <p><strong>{diagnostic.code}</strong>: {diagnostic.message}{nodeId ? <><br />Node: {nodeId}</> : null}{scriptId ? ` · Script: ${scriptId}` : ''}{location ? ` · ${location.path}:${location.startLine}:${location.startColumn}` : diagnostic.path ? ` · ${diagnostic.path}` : ''}{diagnostic.suggestedFix ? <><br />Suggested fix: {diagnostic.suggestedFix}</> : null}</p>;
}

function ManagedAsset({ assetId, mediaType, alt, mediaAssets }: { readonly assetId: string; readonly mediaType: string; readonly alt: string; readonly mediaAssets: MediaAssetApi | undefined }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    if (!mediaAssets || (!mediaType.startsWith('image/') && !mediaType.startsWith('audio/'))) return;
    const resolved = mediaAssets.resolveAsset(assetId as `sha256:${string}`);
    if (!resolved.ok || resolved.asset.mediaType !== mediaType) return;
    const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(resolved.asset.bytes)], { type: mediaType }));
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [assetId, mediaAssets, mediaType]);

  if (!source) return <span data-asset-id={assetId}>{alt}</span>;
  if (mediaType.startsWith('image/')) return <img src={source} alt={alt} data-asset-id={assetId} />;
  if (mediaType.startsWith('audio/')) return <audio controls preload="none" src={source} aria-label={alt} data-asset-id={assetId} />;
  return <span data-asset-id={assetId}>{alt}</span>;
}
