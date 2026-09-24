import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LocaleDocument, ProjectFile, ProjectVfsSnapshot, WorldDocument } from '@dungeon-scrivener/model';
import enJson from '../../../fixtures/tavern-at-dusk/locales/en-GB.json';
import jaJson from '../../../fixtures/tavern-at-dusk/locales/ja-JP.json';
import tavernWorldJson from '../../../fixtures/tavern-at-dusk/world.json';
import { resolveText } from '../../i18n/src/index.js';
import { renderMarkdown } from '../../markdown/src/index.js';
import { ApprenticeAuthorSettings } from './author-settings.js';
import { ApprenticeScripts } from './ApprenticeScripts.js';
import { updateNodeDefinition } from './commands.js';
import { applyMarkdownSourceEdit, RichContentEditor } from './rich-content.js';

const localeDocuments = [enJson as LocaleDocument, jaJson as LocaleDocument];
const fixtureBytes = (path: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/tavern-at-dusk/${path}`, import.meta.url)));

describe('Apprentice rich content and author settings', () => {
  it('previews localized media Markdown and preserves script bytes and unknown source across editor handoff', async () => {
    const world = structuredClone(tavernWorldJson) as WorldDocument;
    const imageHash = 'db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399';
    const audioHash = 'dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690';
    const assets = [
      { assetId: `sha256:${imageHash}` as const, mediaType: 'image/png', byteLength: fixtureBytes(`assets/sha256/${imageHash}`).byteLength, originalFilenames: ['lantern-map.png'] },
      { assetId: `sha256:${audioHash}` as const, mediaType: 'audio/wav', byteLength: fixtureBytes(`assets/sha256/${audioHash}`).byteLength, originalFilenames: ['night-birds.wav'] },
    ];
    const mediaAssets = {
      resolveAsset: (assetId: string) => ({
        ok: true as const,
        asset: {
          assetId: assetId as `sha256:${string}`,
          mediaType: assetId === `sha256:${imageHash}` ? 'image/png' : 'audio/wav',
          byteLength: 1,
          bytes: new Uint8Array([1]),
        },
      }),
    };

    const scripts = world.scripts.map((script) => ({ path: script.path, bytes: fixtureBytes(script.path), role: 'script' as const } satisfies ProjectFile));
    const scriptBytes = new Map(scripts.map((file) => [file.path, file.bytes.slice()]));
    const project: ProjectVfsSnapshot = {
      format: 'dungeon-scrivener-project-vfs-index', schemaVersion: 1, projectId: 'tavern-at-dusk',
      directories: new Set(['scripts']), files: new Map(scripts.map((file) => [file.path, file])),
    };

    const taproom = world.nodes.find((node) => node.id === 'taproom');
    expect(taproom?.content.kind).toBe('locale-key');
    if (!taproom || taproom.content.kind !== 'locale-key') return;
    const key = taproom.content.key;
    const english = resolveText({ source: taproom.content, locales: localeDocuments, requestedLocale: 'en-GB', defaultLocale: 'en-GB' });
    const japanese = resolveText({ source: taproom.content, locales: localeDocuments, requestedLocale: 'ja-JP', defaultLocale: 'en-GB' });
    expect(english.text).not.toBe(japanese.text);
    expect(english.text).toContain('![[asset:sha256:');
    const preview = renderMarkdown({ source: english.text, world, locales: localeDocuments, locale: 'en-GB', defaultLocale: 'en-GB', assets: mediaAssets });
    expect(JSON.stringify(preview.blocks)).toContain(`sha256:${imageHash}`);
    expect(JSON.stringify(preview.blocks)).toContain(`sha256:${audioHash}`);

    const unknownMarkdown = '\n\n:::warning\nFuture block syntax remains authored.\n:::\n';
    const editedSource = applyMarkdownSourceEdit(english.text, english.text.length, english.text.length, unknownMarkdown);
    expect(editedSource.text.slice(0, english.text.length)).toBe(english.text);
    const taproomWithFutureField = { ...taproom, futureNodeField: { preserve: [1, 2, 3] } };
    const sourceWorld = { ...world, nodes: world.nodes.map((node) => node.id === taproom.id ? taproomWithFutureField : node) } as WorldDocument;
    const editedWorld = updateNodeDefinition(sourceWorld, taproom.id, (node) => ({ ...node, content: { kind: 'literal', text: editedSource.text } }));
    expect((editedWorld?.nodes.find((node) => node.id === taproom.id) as typeof taproomWithFutureField).futureNodeField).toEqual({ preserve: [1, 2, 3] });
    expect(editedWorld?.nodes.find((node) => node.id === taproom.id)?.content).toEqual({ kind: 'literal', text: editedSource.text });

    const richEditor = renderToStaticMarkup(createElement(RichContentEditor, {
      value: { kind: 'literal', text: editedSource.text }, onChange: () => undefined,
      world: editedWorld ?? world, locales: localeDocuments, defaultLocale: 'en-GB', assets, mediaAssets,
    }));
    expect(richEditor).toContain('Source escape hatch');
    expect(richEditor).toContain('Future block syntax remains authored.');
    const sageBlock = renderToStaticMarkup(createElement(ApprenticeScripts, { world: editedWorld ?? world, project, onEditInSage: () => undefined }));
    expect(sageBlock.match(/Edit in Sage/g)).toHaveLength(3);
    const settings = renderToStaticMarkup(createElement(ApprenticeAuthorSettings, { world, project, assets, onWorldChange: () => undefined }));
    expect(settings).toContain('Player CSS theme');
    expect(settings).toContain('Typing sound mappings');

    for (const [path, bytes] of scriptBytes) expect(project.files.get(path)?.bytes).toEqual(bytes);
    expect((editedWorld ?? world).scripts).toEqual(world.scripts);
    expect(key).toBe('taproom-content');
  });
});
