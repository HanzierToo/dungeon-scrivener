type SearchRequest = { path: string; bytes: Uint8Array; query: string };
type SearchHit = { path: string; line: number; preview: string };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage: (message: { path: string; hits: SearchHit[]; more: boolean }) => void;
};
const decoder = new TextDecoder('utf-8', { fatal: true });

scope.onmessage = event => {
  const { path, bytes, query } = event.data;
  const hits: SearchHit[] = [];
  let more = false;
  try {
    const text = decoder.decode(bytes);
    if (text.includes('\0')) { scope.postMessage({ path, hits, more }); return; }
    const needle = query.toLocaleLowerCase();
    let line = 1;
    let start = 0;
    while (start <= text.length) {
      const end = text.indexOf('\n', start);
      const boundary = end === -1 ? text.length : end;
      const value = text.slice(start, boundary);
      if (value.toLocaleLowerCase().includes(needle)) {
        if (hits.length === 50) { more = true; break; }
        hits.push({ path, line, preview: value.trim().slice(0, 180) });
      }
      if (end === -1) break;
      start = end + 1;
      line += 1;
    }
  } catch {
    // Binary or malformed UTF-8 files are not project text search results.
  }
  scope.postMessage({ path, hits, more });
};
