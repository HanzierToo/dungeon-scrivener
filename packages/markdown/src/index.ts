import MarkdownIt from 'markdown-it';
import type {
  ContentDigest,
  Diagnostic,
  LocaleDocument,
  MediaAssetApi,
  NodeDefinition,
  SafeBlock,
  SafeInline,
  SourceSpan,
  TextSource,
  WorldDocument,
} from '@dungeon-scrivener/model';
import { resolveWikiNodeTarget } from '@dungeon-scrivener/model';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_EMBED_DEPTH = 8;
const MAX_EXPANDED_NODES = 128;
const MAX_RENDERED_TEXT = 2 * 1024 * 1024;
const nodeLinkPattern = /^\[\[node:([a-z][a-z0-9-]{0,63})(?:\|([^\]]*))?\]\]/;
const nodeEmbedPattern = /^!\[\[node:([a-z][a-z0-9-]{0,63})\]\]$/;
const assetEmbedPattern = /^!\[\[asset:(sha256:[a-f0-9]{64})(?:\|([^\]]*))?\]\]/;

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

export interface RenderMarkdownRequest {
  readonly source: string;
  readonly path?: string;
  readonly world: WorldDocument;
  readonly locales?: readonly LocaleDocument[];
  readonly locale?: string;
  readonly defaultLocale?: string;
  readonly assets?: MediaAssetApi;
}

export interface RenderMarkdownResult {
  readonly blocks: readonly SafeBlock[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Parses untrusted author Markdown into the package's safe, data-only render tree. */
export function renderMarkdown(request: RenderMarkdownRequest): RenderMarkdownResult {
  const path = request.path ?? 'world.json';
  const diagnostics: Diagnostic[] = [];
  const context: RenderContext = {
    request,
    path,
    diagnostics,
    activeNodes: [],
    expandedNodes: 0,
    renderedTextBytes: 0,
  };
  return { blocks: renderSource(request.source, context, 0), diagnostics };
}

interface RenderContext {
  readonly request: RenderMarkdownRequest;
  readonly path: string;
  readonly diagnostics: Diagnostic[];
  readonly activeNodes: string[];
  expandedNodes: number;
  renderedTextBytes: number;
}

interface ParsedInline {
  readonly nodes: SafeInline[];
  readonly text: string;
}

function diagnostic(context: RenderContext, code: string, message: string, line = 1, column = 1, entityId?: string): void {
  const sourceSpan: SourceSpan = { path: context.path, startLine: line, startColumn: column, endLine: line, endColumn: column + 1 };
  context.diagnostics.push({
    code,
    severity: 'warning',
    message,
    path: context.path,
    ...(entityId ? { entityId } : {}),
    sourceSpan,
    suggestedFix: 'Correct or remove the unresolved or unsupported Markdown reference.',
  });
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function renderSource(source: string, context: RenderContext, depth: number): SafeBlock[] {
  const bytes = utf8Length(source);
  if (bytes > MAX_SOURCE_BYTES) {
    diagnostic(context, 'DS-MD-001', `Markdown source exceeds the ${MAX_SOURCE_BYTES}-byte limit.`);
    return [{ kind: 'paragraph', children: [{ kind: 'text', text: '[Markdown source exceeds the rendering limit.]' }] }];
  }
  context.renderedTextBytes += bytes;
  if (context.renderedTextBytes > MAX_RENDERED_TEXT) {
    diagnostic(context, 'DS-MD-002', 'Expanded Markdown exceeds the 2 MiB rendered-text limit.');
    return [{ kind: 'paragraph', children: [{ kind: 'text', text: '[Markdown expansion exceeds the rendering limit.]' }] }];
  }
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1] ?? '';
    if (!safeHref(href)) {
      const before = source.slice(0, match.index ?? 0);
      diagnostic(context, 'DS-MD-003', `Rejected unsafe or unsupported link destination '${href}'.`, before.split('\n').length, (before.split('\n').at(-1)?.length ?? 0) + 1);
    }
  }
  const tokens = markdown.parse(source, {});
  return parseBlocks(tokens, context, depth);
}

function parseBlocks(tokens: ReturnType<typeof markdown.parse>, context: RenderContext, depth: number): SafeBlock[] {
  const blocks: SafeBlock[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.type === 'paragraph_open' || token.type === 'heading_open') {
      const closeType = token.type === 'paragraph_open' ? 'paragraph_close' : 'heading_close';
      const close = findClose(tokens, i + 1, closeType);
      const inline = tokens.slice(i + 1, close).find((item) => item.type === 'inline');
      const line = (token.map?.[0] ?? 0) + 1;
      const rawText = inline?.content ?? '';
      if (token.type === 'paragraph_open') {
        const embed = nodeEmbedPattern.exec(rawText.trim());
        if (embed) {
          const expansion = expandNode(embed[1] ?? '', context, depth + 1, line);
          blocks.push(expansion);
          i = close;
          continue;
        }
      }
      const parsed = parseInline(inline?.children ?? [], context, line);
      if (token.type === 'heading_open') {
        const level = Number(token.tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({ kind: 'heading', level, children: parsed.nodes });
      } else {
        blocks.push({ kind: 'paragraph', children: parsed.nodes });
      }
      i = close;
      continue;
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      const language = token.info.trim().split(/\s+/, 1)[0];
      blocks.push({ kind: 'code-block', text: token.content, ...(language ? { language } : {}) });
      continue;
    }
    if (token.type === 'hr') {
      blocks.push({ kind: 'thematic-break' });
      continue;
    }
    if (token.type === 'blockquote_open') {
      const close = findClose(tokens, i + 1, 'blockquote_close');
      const children = parseBlocks(tokens.slice(i + 1, close), context, depth);
      blocks.push(asCallout(children) ?? { kind: 'blockquote', blocks: children });
      i = close;
      continue;
    }
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const closeType = token.type === 'bullet_list_open' ? 'bullet_list_close' : 'ordered_list_close';
      const close = findClose(tokens, i + 1, closeType);
      const items: SafeBlock[][] = [];
      let cursor = i + 1;
      while (cursor < close) {
        if (tokens[cursor]?.type === 'list_item_open') {
          const itemClose = findClose(tokens, cursor + 1, 'list_item_close');
          items.push(parseBlocks(tokens.slice(cursor + 1, itemClose), context, depth));
          cursor = itemClose + 1;
        } else {
          cursor += 1;
        }
      }
      blocks.push({ kind: 'list', ordered: token.type === 'ordered_list_open', items });
      i = close;
      continue;
    }
    if (token.type === 'table_open') {
      const close = findClose(tokens, i + 1, 'table_close');
      blocks.push(parseTable(tokens.slice(i + 1, close), context));
      i = close;
    }
  }
  return blocks;
}

function findClose(tokens: ReturnType<typeof markdown.parse>, start: number, type: string): number {
  for (let i = start; i < tokens.length; i += 1) if (tokens[i]?.type === type) return i;
  return tokens.length;
}

function parseTable(tokens: ReturnType<typeof markdown.parse>, context: RenderContext): SafeBlock {
  const rows: SafeInline[][][] = [];
  let row: SafeInline[][] | undefined;
  let cellTokens: ReturnType<typeof markdown.parse> = [];
  for (const token of tokens) {
    if (token.type === 'tr_open') row = [];
    else if (token.type === 'th_open' || token.type === 'td_open') cellTokens = [];
    else if (token.type === 'inline') cellTokens = [token];
    else if (token.type === 'th_close' || token.type === 'td_close') row?.push(parseInline(cellTokens[0]?.children ?? [], context, (token.map?.[0] ?? 0) + 1).nodes);
    else if (token.type === 'tr_close' && row) { rows.push(row); row = undefined; }
  }
  return { kind: 'table', header: rows[0] ?? [], rows: rows.slice(1) };
}

function parseInline(tokens: NonNullable<ReturnType<typeof markdown.parse>[number]['children']>, context: RenderContext, line: number): ParsedInline {
  const nodes: SafeInline[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain) nodes.push({ kind: 'text', text: plain });
    plain = '';
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.type === 'text') {
      flush();
      nodes.push(...splitTextReferences(token.content, context, line).nodes);
      continue;
    }
    if (token.type === 'softbreak') {
      plain += ' ';
      continue;
    }
    if (token.type === 'hardbreak') {
      flush();
      nodes.push({ kind: 'text', text: '\n' });
      continue;
    }
    if (token.type === 'code_inline') {
      flush();
      nodes.push({ kind: 'code', text: token.content });
      continue;
    }
    if (token.type === 'em_open' || token.type === 'strong_open') {
      flush();
      const closeType = token.type === 'em_open' ? 'em_close' : 'strong_close';
      let end = i + 1;
      let nesting = 1;
      while (end < tokens.length && nesting > 0) {
        if (tokens[end]?.type === token.type) nesting += 1;
        if (tokens[end]?.type === closeType) nesting -= 1;
        end += 1;
      }
      nodes.push({ kind: token.type === 'em_open' ? 'emphasis' : 'strong', children: parseInline(tokens.slice(i + 1, end - 1), context, line).nodes });
      i = end - 1;
      continue;
    }
    if (token.type === 'link_open') {
      flush();
      let end = i + 1;
      while (end < tokens.length && tokens[end]?.type !== 'link_close') end += 1;
      const label = parseInline(tokens.slice(i + 1, end), context, line);
      const href = String(token.attrGet('href') ?? '');
      const safe = safeHref(href);
      if (!safe) {
        diagnostic(context, 'DS-MD-003', `Rejected unsafe or unsupported link destination '${href}'.`, line);
        nodes.push(...label.nodes);
      } else {
        nodes.push({ kind: 'external-link', href: safe, label: label.text || textOf(label.nodes) });
      }
      i = end;
      continue;
    }
    if (token.type === 'image') {
      flush();
      diagnostic(context, 'DS-MD-004', 'Standard Markdown images are unsupported. Use a managed asset embed.', line);
      nodes.push({ kind: 'text', text: token.content || String(token.attrGet('alt') ?? '[unsupported image]') });
    }
  }
  flush();
  return { nodes, text: textOf(nodes) };
}

function splitTextReferences(value: string, context: RenderContext, line: number): ParsedInline {
  const nodes: SafeInline[] = [];
  let cursor = 0;
  let unmatched = value;
  const matches = [...value.matchAll(/!?\[\[(?:node|asset):[^\]]*\]\]/g)];
  for (const match of matches) {
    const start = match.index ?? 0;
    const raw = match[0];
    unmatched = unmatched.replace(raw, '');
    const before = value.slice(cursor, start);
    if (before) nodes.push({ kind: 'text', text: before });
    if (raw.startsWith('![[asset:')) {
      const parsed = assetEmbedPattern.exec(raw);
      if (parsed) {
        const assetId = parsed[1] as ContentDigest;
        const resolved = context.request.assets?.resolveAsset(assetId);
        if (resolved?.ok && (resolved.asset.mediaType.startsWith('image/') || resolved.asset.mediaType.startsWith('audio/'))) {
          nodes.push({ kind: 'asset', assetId, mediaType: resolved.asset.mediaType, alt: parsed[2] ?? '' });
        } else {
          diagnostic(context, 'DS-MD-005', `Unknown, unavailable, or unsupported asset '${assetId}'.`, line);
          nodes.push({ kind: 'text', text: parsed[2] ?? '[unavailable asset]' });
        }
      } else {
        diagnostic(context, 'DS-MD-006', 'Malformed managed asset embed.', line);
        nodes.push({ kind: 'text', text: '[malformed asset embed]' });
      }
    } else if (raw.startsWith('![[node:')) {
      diagnostic(context, 'DS-MD-007', 'Node embeds must be a standalone block.', line);
      nodes.push({ kind: 'text', text: '[node embed must be standalone]' });
    } else if (raw.startsWith('[[node:')) {
      const parsed = nodeLinkPattern.exec(raw);
      if (parsed) {
        const targetId = parsed[1] ?? '';
        const target = resolveWikiNodeTarget(context.request.world, targetId);
        if (target.ok && target.value) nodes.push({ kind: 'node-link', nodeId: targetId, label: parsed[2] ?? titleText(target.value.title, context) ?? targetId });
        else {
          for (const item of target.diagnostics) context.diagnostics.push({ ...item, path: context.path, sourceSpan: spanAt(line, context.path) });
          nodes.push({ kind: 'text', text: parsed[2] ?? `[missing node: ${targetId}]` });
        }
      } else {
        diagnostic(context, 'DS-MD-007', 'Malformed or unresolved node link.', line);
        nodes.push({ kind: 'text', text: '[malformed node link]' });
      }
    }
    cursor = start + raw.length;
  }
  const after = value.slice(cursor);
  if (after) nodes.push({ kind: 'text', text: after });
  const malformed = unmatched.match(/!?\[\[(?:node|asset):/);
  if (malformed) diagnostic(context, 'DS-MD-007', 'Malformed embed syntax.', line, (malformed.index ?? 0) + 1);
  return { nodes, text: textOf(nodes) };
}

function spanAt(line: number, path: string): SourceSpan {
  return { path, startLine: line, startColumn: 1, endLine: line, endColumn: 2 };
}

function textOf(nodes: readonly SafeInline[]): string {
  return nodes.map((node) => node.kind === 'text' || node.kind === 'code' ? node.text : node.kind === 'node-link' || node.kind === 'external-link' ? node.label : node.kind === 'asset' ? node.alt : textOf(node.children)).join('');
}

function safeHref(href: string): string | undefined {
  const normalized = href.trim();
  if (normalized.startsWith('#')) return normalized;
  if (/^mailto:[^\s]+$/i.test(normalized)) return normalized;
  if (!/^https:\/\//i.test(normalized)) return undefined;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:' && parsed.hostname ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function titleText(title: TextSource, context: RenderContext): string | undefined {
  if (title.kind === 'literal') return title.text;
  const selected = context.request.locale;
  const fallback = context.request.defaultLocale;
  return localeValue(context.request.locales ?? [], selected, title.key) ?? localeValue(context.request.locales ?? [], fallback, title.key);
}

function localeValue(locales: readonly LocaleDocument[], locale: string | undefined, key: string): string | undefined {
  if (!locale) return undefined;
  return locales.find((item) => item.locale === locale)?.strings[key];
}

function nodeContent(node: NodeDefinition, context: RenderContext): string | undefined {
  const source = node.content;
  if (source.kind === 'literal') return source.text;
  return localeValue(context.request.locales ?? [], context.request.locale, source.key)
    ?? localeValue(context.request.locales ?? [], context.request.defaultLocale, source.key);
}

function expandNode(nodeId: string, context: RenderContext, depth: number, line: number): SafeBlock {
  if (context.activeNodes.includes(nodeId)) {
    diagnostic(context, 'DS-MD-008', `Node embed cycle detected at '${nodeId}'.`, line, 1, nodeId);
    return { kind: 'node-embed', nodeId, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: `[recursive embed: ${nodeId}]` }] }] };
  }
  if (depth > MAX_EMBED_DEPTH || context.expandedNodes >= MAX_EXPANDED_NODES) {
    diagnostic(context, 'DS-MD-009', 'Node embed expansion exceeded its depth or node-count limit.', line, 1, nodeId);
    return { kind: 'node-embed', nodeId, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: `[embed limit: ${nodeId}]` }] }] };
  }
  const target = resolveWikiNodeTarget(context.request.world, nodeId);
  if (!target.ok || !target.value) {
    for (const item of target.diagnostics) context.diagnostics.push({ ...item, path: context.path, sourceSpan: spanAt(line, context.path) });
    return { kind: 'node-embed', nodeId, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: `[missing node: ${nodeId}]` }] }] };
  }
  const source = nodeContent(target.value, context);
  if (source === undefined) {
    diagnostic(context, 'DS-MD-010', `Node '${nodeId}' has no text for the selected or default locale.`, line, 1, nodeId);
    return { kind: 'node-embed', nodeId, blocks: [] };
  }
  context.expandedNodes += 1;
  context.activeNodes.push(nodeId);
  const blocks = renderSource(source, context, depth);
  context.activeNodes.pop();
  return { kind: 'node-embed', nodeId, blocks };
}

function asCallout(blocks: SafeBlock[]): SafeBlock | undefined {
  const first = blocks[0];
  if (first?.kind !== 'paragraph') return undefined;
  const text = textOf(first.children);
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*)/i.exec(text);
  if (!match) return undefined;
  const tone = match[1]?.toLowerCase() as 'note' | 'tip' | 'important' | 'warning' | 'caution';
  const body = first.children.slice();
  const firstChild = body[0];
  if (firstChild?.kind === 'text') {
    const remainder = firstChild.text.slice(match[0].length);
    if (remainder) body[0] = { kind: 'text', text: remainder };
    else body.shift();
  }
  const rest = body.length ? [{ kind: 'paragraph' as const, children: body }, ...blocks.slice(1)] : blocks.slice(1);
  return { kind: 'callout', tone, blocks: rest };
}
