import { describe, expect, it } from 'vitest';
import linearWorld from '../../../fixtures/linear-three-nodes/world.json';
import tavernWorld from '../../../fixtures/tavern-at-dusk/world.json';
import linearLocale from '../../../fixtures/linear-three-nodes/locales/en-GB.json';
import tavernLocale from '../../../fixtures/tavern-at-dusk/locales/en-GB.json';
import type { MediaAssetApi, WorldDocument } from '@dungeon-scrivener/model';
import { renderMarkdown } from './index.js';

const world = (): WorldDocument => structuredClone(linearWorld) as WorldDocument;
const linearLocales = [structuredClone(linearLocale) as import('@dungeon-scrivener/model').LocaleDocument];
const imageHash = 'sha256:db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399' as const;
const assets: MediaAssetApi = {
  resolveAsset: (assetId) => ({
    ok: true,
    asset: { assetId, mediaType: 'image/png', byteLength: 3, bytes: new Uint8Array([1, 2, 3]) },
  }),
};

describe('safe Markdown rendering', () => {
  it('renders nested formatting, tables, callouts, and local asset embeds as typed nodes', () => {
    const result = renderMarkdown({
      source: '**bold *nested***\n\n| A | B |\n| - | - |\n| x | y |\n\n> [!WARNING]\n> Stay alert.\n\n![[asset:' + imageHash + '|map]]',
      world: world(),
      locales: linearLocales,
      defaultLocale: 'en-GB',
      locale: 'en-GB',
      assets,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.blocks.some((block) => block.kind === 'table')).toBe(true);
    expect(result.blocks.some((block) => block.kind === 'callout' && block.tone === 'warning')).toBe(true);
    expect(JSON.stringify(result.blocks)).toContain('"kind":"asset"');
    expect(JSON.stringify(result.blocks)).toContain('"kind":"emphasis"');
  });

  it('keeps raw HTML inert and reports unsafe links without producing executable markup', () => {
    const source = '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[bad](javascript:alert(3))';
    const result = renderMarkdown({ source, path: 'locales/en-GB.json', world: world() });
    expect(result.diagnostics.some((item) => item.code === 'DS-MD-003')).toBe(true);
    const serialized = JSON.stringify(result.blocks);
    expect(serialized).toContain('<script>');
    expect(serialized).toContain('onerror=');
    expect(serialized).not.toContain('"href":"javascript:');
    expect(result.blocks.every((block) => block.kind !== 'code-block')).toBe(true);
  });

  it('resolves node links and expands content while preserving the author source', () => {
    const source = 'Visit [[node:stone-bridge|the bridge]].\n\n![[node:stone-bridge]]';
    const untouched = source;
    const result = renderMarkdown({ source, world: world(), locales: linearLocales, defaultLocale: 'en-GB', locale: 'en-GB' });
    expect(source).toBe(untouched);
    expect(JSON.stringify(result.blocks)).toContain('"nodeId":"stone-bridge"');
    expect(result.diagnostics).toEqual([]);
  });

  it('reports unknown targets, unsafe media and recursive node embeds', () => {
    const recursive = world();
    const node = recursive.nodes.find((entry) => entry.id === 'stone-bridge');
    expect(node).toBeDefined();
    if (node) (node as { content: { kind: 'literal'; text: string } }).content = { kind: 'literal', text: '![[node:stone-bridge]]' };
    const result = renderMarkdown({
      source: '[[node:not-a-node]]\n\n![[node:stone-bridge]]\n\n![[asset:' + imageHash + '|unknown]]',
      world: recursive,
      assets: { resolveAsset: (assetId) => ({ ok: true, asset: { assetId, mediaType: 'application/javascript', byteLength: 0, bytes: new Uint8Array() } }) },
    });
    expect(result.diagnostics.some((item) => item.code === 'DS-MOD-032')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'DS-MD-008')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'DS-MD-005')).toBe(true);
  });

  it('uses stable IDs in the accepted link syntax even when node labels are duplicated', () => {
    const source = '[[node:stone-bridge]] and [[node:lantern-house]]';
    const duplicateTitles = world();
    const second = duplicateTitles.nodes.find((node) => node.id === 'stone-bridge');
    const third = duplicateTitles.nodes.find((node) => node.id === 'lantern-house');
    if (second && third) {
      (second as { title: { kind: 'literal'; text: string } }).title = { kind: 'literal', text: 'Same' };
      (third as { title: { kind: 'literal'; text: string } }).title = { kind: 'literal', text: 'Same' };
    }
    const result = renderMarkdown({ source, world: duplicateTitles, locales: linearLocales, defaultLocale: 'en-GB', locale: 'en-GB' });
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result.blocks)).toContain('"nodeId":"lantern-house"');
  });

  it('renders the tavern fixture managed assets and links', () => {
    const result = renderMarkdown({
      source: 'A [[node:cellar|cellar link]].\n\n![[asset:' + imageHash + '|map]]',
      world: structuredClone(tavernWorld) as WorldDocument,
      locales: [structuredClone(tavernLocale) as import('@dungeon-scrivener/model').LocaleDocument],
      defaultLocale: 'en-GB',
      locale: 'en-GB',
      assets,
    });
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result.blocks)).toContain('"nodeId":"cellar"');
    expect(JSON.stringify(result.blocks)).toContain(imageHash);
  });
});
