/** Returns false when CSS can cause external resource loads or escape its stylesheet context. */
export function isOfflineSafeTheme(css: string): boolean {
  if (css.length > 128_000 || css.includes('\\')) return false;
  const normalized = css.replace(/\/\*[\s\S]*?\*\//gu, '').toLowerCase();
  return !/(?:@\s*import\b|@\s*font-face\b|\burl\s*\(|\bimage-set\s*\(|\bwebkit-image-set\s*\(|\bexpression\s*\(|-moz-binding\s*:|\bdisplay\s*:\s*none\b|\bvisibility\s*:\s*hidden\b|\bopacity\s*:\s*0(?:\.0+)?\b|\bpointer-events\s*:\s*none\b)/u.test(normalized);
}
