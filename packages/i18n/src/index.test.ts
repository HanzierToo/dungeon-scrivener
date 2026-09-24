import { describe, expect, it } from 'vitest';
import type { LocaleDocument, TextSource } from '@dungeon-scrivener/model';
import { resolveText } from './index.js';

const english: LocaleDocument = {
  format: 'dungeon-scrivener-locale', schemaVersion: 1, locale: 'en-GB',
  strings: { greeting: 'Good evening', welcome: 'Welcome, traveler' },
};
const japanese: LocaleDocument = {
  format: 'dungeon-scrivener-locale', schemaVersion: 1, locale: 'ja-JP',
  strings: { greeting: 'こんばんは', welcome: 'ようこそ、旅人' },
};
const key = (value: string): TextSource => ({ kind: 'locale-key', key: value });

describe('resolveText', () => {
  it('resolves two locales and preserves accented and non-Latin text', () => {
    expect(resolveText({ source: key('greeting'), locales: [english, japanese], defaultLocale: 'en-GB', requestedLocale: 'en-GB' }).text).toBe('Good evening');
    expect(resolveText({ source: key('greeting'), locales: [english, japanese], defaultLocale: 'en-GB', requestedLocale: 'ja-JP' }).text).toBe('こんばんは');
    const accents: LocaleDocument = { ...english, strings: { greeting: 'Café déjà vu' } };
    expect(resolveText({ source: key('greeting'), locales: [accents], defaultLocale: 'en-GB' }).text).toBe('Café déjà vu');
  });

  it('falls back to the default locale and reports the key and source node', () => {
    const result = resolveText({ source: key('welcome'), locales: [english, japanese], defaultLocale: 'en-GB', requestedLocale: 'fr-FR', sourceNodeId: 'old-gate' });
    expect(result.text).toBe('Welcome, traveler');
    expect(result.diagnostics).toMatchObject([{ code: 'DS-I18N-001', severity: 'warning', entityId: 'old-gate', message: expect.stringContaining('welcome') }]);
  });

  it('keeps hard-coded text usable without locale files and uses the key as missing-file fallback', () => {
    expect(resolveText({ source: { kind: 'literal', text: 'Café' }, defaultLocale: 'en-GB' })).toEqual({ text: 'Café', diagnostics: [] });
    const result = resolveText({ source: key('welcome'), defaultLocale: 'en-GB', requestedLocale: 'ja-JP', sourceNodeId: 'taproom' });
    expect(result.text).toBe('welcome');
    expect(result.diagnostics[0]).toMatchObject({ code: 'DS-I18N-001', entityId: 'taproom', message: expect.stringContaining('en-GB') });
  });

  it('switches dialogue display locale without touching its authored sources or session state', () => {
    const line = key('greeting');
    const session = { currentNodeId: 'taproom', turn: 3 };
    const before = structuredClone(session);
    expect(resolveText({ source: line, locales: [english, japanese], defaultLocale: 'en-GB', requestedLocale: 'ja-JP' }).text).toBe('こんばんは');
    expect(resolveText({ source: line, locales: [english, japanese], defaultLocale: 'en-GB', requestedLocale: 'en-GB' }).text).toBe('Good evening');
    expect(line).toEqual({ kind: 'locale-key', key: 'greeting' });
    expect(session).toEqual(before);
  });
});
