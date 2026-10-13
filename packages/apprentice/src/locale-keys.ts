import type { LocaleDocument, WorldDocument } from '@dungeon-scrivener/model';

export type LocaleKeyRemoval =
  | { readonly ok: true; readonly world: WorldDocument; readonly locales: readonly LocaleDocument[]; readonly references: number }
  | { readonly ok: false; readonly message: string };

/** Convert authored text sources before removing a key from every language file. */
export function removeLocaleKey(world: WorldDocument, locales: readonly LocaleDocument[], defaultLocale: string, key: string): LocaleKeyRemoval {
  return removeLocaleKeys(world, locales, defaultLocale, [key]);
}

/** Remove a selection in one world and locale update, or leave every key untouched. */
export function removeLocaleKeys(world: WorldDocument, locales: readonly LocaleDocument[], defaultLocale: string, keys: readonly string[]): LocaleKeyRemoval {
  const selected = new Set(keys);
  const defaultStrings = locales.find(locale => locale.locale === defaultLocale)?.strings ?? {};
  const counts = new Map<string, number>();
  let references = 0;
  const count = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(count); return; }
    const record = value as Record<string, unknown>;
    if (record['kind'] === 'locale-key' && typeof record['key'] === 'string' && selected.has(record['key'])) {
      references++;
      counts.set(record['key'], (counts.get(record['key']) ?? 0) + 1);
      return;
    }
    Object.values(record).forEach(count);
  };
  count(world);
  const missing = [...counts.keys()].filter(key => defaultStrings[key] === undefined);
  if (missing.length) return { ok: false, message: `Add text for ${missing.map(key => `“${key}”`).join(', ')} in the default language (${defaultLocale}) before deleting ${missing.length === 1 ? 'this in-use key' : 'these in-use keys'}, or change their references to literal text.` };

  let nextWorld = world;
  if (references) {
    nextWorld = structuredClone(world);
    const replace = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(replace); return; }
      const record = value as Record<string, unknown>;
      if (record['kind'] === 'locale-key' && typeof record['key'] === 'string' && selected.has(record['key'])) {
        const literal = defaultStrings[record['key']];
        record['kind'] = 'literal';
        record['text'] = literal;
        delete record['key'];
        return;
      }
      Object.values(record).forEach(replace);
    };
    replace(nextWorld);
  }
  const nextLocales = locales.map(locale => {
    if (![...selected].some(key => Object.hasOwn(locale.strings, key))) return locale;
    const strings = { ...locale.strings };
    selected.forEach(key => { delete strings[key]; });
    return { ...locale, strings };
  });
  return { ok: true, world: nextWorld, locales: nextLocales, references };
}

export function renameLocaleKey(world: WorldDocument, locales: readonly LocaleDocument[], oldKey: string, newKey: string): LocaleKeyRemoval {
  if (!newKey || locales.some(locale => Object.hasOwn(locale.strings, newKey))) return { ok: false, message: 'Choose a new key name that is not already in use.' };
  const nextWorld = structuredClone(world);
  let references = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (record['kind'] === 'locale-key' && record['key'] === oldKey) { record['key'] = newKey; references++; }
    Object.values(record).forEach(visit);
  };
  visit(nextWorld);
  return { ok: true, world: nextWorld, references, locales: locales.map(locale => {
    const strings = { ...locale.strings };
    if (Object.hasOwn(strings, oldKey)) { strings[newKey] = strings[oldKey]!; delete strings[oldKey]; }
    return { ...locale, strings };
  }) };
}
