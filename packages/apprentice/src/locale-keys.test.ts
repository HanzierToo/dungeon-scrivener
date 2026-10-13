import { describe, expect, it } from 'vitest';
import type { LocaleDocument, WorldDocument } from '@dungeon-scrivener/model';
import worldJson from '../../../fixtures/linear-three-nodes/world.json';
import localeJson from '../../../fixtures/linear-three-nodes/locales/en-GB.json';
import { removeLocaleKey, removeLocaleKeys } from './locale-keys.js';

const world = () => structuredClone(worldJson) as WorldDocument;
const english = () => structuredClone(localeJson) as LocaleDocument;

describe('Apprentice locale key deletion', () => {
  it('replaces every in-use text source with the default-language literal before removing translations', () => {
    const original = world();
    const englishLocale = english();
    const french: LocaleDocument = { ...englishLocale, locale: 'fr-FR', strings: { 'gate-title': 'La vieille porte' } };
    const result = removeLocaleKey(original, [englishLocale, french], 'en-GB', 'gate-title');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references).toBe(1);
    expect(result.world.nodes[0]?.title).toEqual({ kind: 'literal', text: 'The Old Gate' });
    expect(result.locales.every(locale => !Object.hasOwn(locale.strings, 'gate-title'))).toBe(true);
    expect(result.world.nodes[0]?.content).toEqual(original.nodes[0]?.content);
    expect(original.nodes[0]?.title).toEqual({ kind: 'locale-key', key: 'gate-title' });
    expect(englishLocale.strings['gate-title']).toBe('The Old Gate');
  });

  it('removes an unused key without changing the world', () => {
    const original = world();
    const locale = { ...english(), strings: { ...english().strings, unused: 'Unused text' } };
    const result = removeLocaleKey(original, [locale], 'en-GB', 'unused');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references).toBe(0);
    expect(result.world).toBe(original);
    expect(result.locales[0]?.strings['unused']).toBeUndefined();
  });

  it('blocks in-use deletion when the default language has no replacement text', () => {
    const original = world();
    const locale = english();
    const { 'gate-title': _missing, ...strings } = locale.strings;
    const result = removeLocaleKey(original, [{ ...locale, strings }], 'en-GB', 'gate-title');
    expect(result).toEqual({ ok: false, message: expect.stringContaining('Add text') });
    expect(original.nodes[0]?.title).toEqual({ kind: 'locale-key', key: 'gate-title' });
  });

  it('removes a mixed selection atomically across the world and every language', () => {
    const original = world();
    const englishLocale = english();
    const selected = ['gate-title', 'unused'];
    const french: LocaleDocument = { ...englishLocale, locale: 'fr-FR', strings: { 'gate-title': 'La vieille porte', unused: 'Inutilisé' } };
    const result = removeLocaleKeys(original, [{ ...englishLocale, strings: { ...englishLocale.strings, unused: 'Unused' } }, french], 'en-GB', selected);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references).toBe(1);
    expect(result.world.nodes[0]?.title).toEqual({ kind: 'literal', text: 'The Old Gate' });
    expect(result.locales.every(locale => selected.every(key => !Object.hasOwn(locale.strings, key)))).toBe(true);
    expect(original.nodes[0]?.title).toEqual({ kind: 'locale-key', key: 'gate-title' });
  });

  it('does not partially remove a selection if any in-use key lacks default text', () => {
    const original = world();
    const locale = english();
    const { 'gate-title': _missing, ...strings } = locale.strings;
    const result = removeLocaleKeys(original, [{ ...locale, strings: { ...strings, unused: 'Unused' } }], 'en-GB', ['unused', 'gate-title']);
    expect(result.ok).toBe(false);
    expect(original.nodes[0]?.title).toEqual({ kind: 'locale-key', key: 'gate-title' });
    expect(locale.strings['gate-title']).toBe('The Old Gate');
  });
});
