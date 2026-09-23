# Direct-open feasibility spike

This task 1A spike tests an exported `index.html` opened directly from a ZIP extraction. It is deliberately separate from production code. `index.html` has one inline classic runtime, relative local media, an offline CSP, a restricted bridge example in a sandboxed opaque-origin iframe, and a small stored-ZIP save importer/exporter.

The ZIP writer/reader exists only to test the browser contract. It supports stored entries only, caps input size and entry count, validates CRC32 and safe paths, and rejects unsupported data. It is not the project archive or final player-save implementation.

## Rebuild the demo ZIP

From this directory:

```sh
npm run build:zip
```

This regenerates the PNG/WAV fixtures, writes `dungeon-scrivener-direct-open.zip`, and checks its entries, CRCs, paths, compression mode, and byte identity. Extract that ZIP and open its `index.html` with no server.

## Run offline browser evidence

The package pins Playwright in this spike only. Install it and the matching browser binaries before running the verifier:

```sh
npm ci
npx playwright install chromium firefox webkit
npm run build:zip
npm run verify
```

The verifier opens the local file URL with browser networking disabled, exercises a story action, local media, opaque script probes, and save ZIP download/import. It records console messages, page errors, requested URLs, failed requests, state round-trip, and bridge trace in `evidence/browser-results.json`. It fails if remote requests occur, a page error is raised, a required capability probe succeeds, or a round-trip differs. The Playwright dependency and its lockfile are pinned in this directory.

The harness does not claim that a browser sandbox makes arbitrary hostile code harmless. This spike tests the opaque-origin, capability-bridge pattern only. The product contract still requires script subsets to compile to validated IR; this page's illustrative script is not that compiler or executor.
