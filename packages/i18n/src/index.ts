import type {
  Diagnostic,
  LocaleDocument,
  LocaleTag,
  TextSource,
} from '@dungeon-scrivener/model';

export interface ResolveTextRequest {
  readonly source: TextSource;
  readonly locales?: readonly LocaleDocument[];
  readonly requestedLocale?: LocaleTag;
  readonly defaultLocale: LocaleTag;
  readonly sourceNodeId?: string;
}

export interface ResolveTextResult {
  readonly text: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Resolve display text without altering the authored source value. */
export function resolveText(request: ResolveTextRequest): ResolveTextResult {
  if (request.source.kind === 'literal') {
    return { text: request.source.text, diagnostics: [] };
  }

  const key = request.source.key;
  const locales = request.locales ?? [];
  const requestedLocale = request.requestedLocale ?? request.defaultLocale;
  const requestedText = locales.find((locale) => locale.locale === requestedLocale)?.strings[key];
  if (requestedText !== undefined) return { text: requestedText, diagnostics: [] };

  const fallbackText = locales.find((locale) => locale.locale === request.defaultLocale)?.strings[key];
  const text = fallbackText ?? key;
  const diagnostics: Diagnostic[] = [{
    code: 'DS-I18N-001',
    severity: 'warning',
    message: fallbackText === undefined
      ? `Locale key '${key}' is missing from requested locale '${requestedLocale}' and default locale '${request.defaultLocale}'; the key is shown as fallback text.`
      : `Locale key '${key}' is missing from requested locale '${requestedLocale}'; default locale '${request.defaultLocale}' is shown instead.`,
    path: fallbackText === undefined ? 'world.json' : `locales/${request.defaultLocale}.json`,
    ...(request.sourceNodeId ? { entityId: request.sourceNodeId } : {}),
    suggestedFix: 'Add a translation for this key to the requested locale.',
  }];
  return { text, diagnostics };
}
