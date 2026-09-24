# Task 28B export browser evidence

## Run

The spec compiles the Tavern's JS, Lua, and Python sources, supplies Agent 22's standalone runtime artifact, and passes Agent 13's compiled script bundle and the accepted source-content fingerprint to `exportGame`. It extracts each generated ZIP to a temporary directory and opens `index.html` through `file://`. HTTP and HTTPS requests are blocked; local files and blob URLs remain available.

```sh
npx playwright test tests/e2e/export/export.spec.ts --config=playwright.config.ts
```

Playwright version: **1.63.0**. Browser versions: **Chromium 153.0.8010.12**, **Firefox 155.0**, **WebKit 26.6**.

## Result on 2026-09-24

Run result: **3 passed, 6 failed** (three cases in each browser engine). The six failing cases are the core runtime case and save round-trip case in Chromium, Firefox, and WebKit.

In all three engines, the exported file opened directly from disk, the game rendered, image and audio assets resolved, and the embedded payload carried the accepted save target unchanged:

```json
{
  "manifest": { "projectId": "tavern-at-dusk", "gameVersion": "1.0.0" },
  "engineVersion": "1.0.0",
  "contentFingerprint": "sha256:eba68a00f286dd699b6ff737954115d5601c79087b7952c6d8559d8016089897"
}
```

The bounded clock and JS/Lua/Python script checks, Japanese locale projection (`酒場の広間`), and missing-entry startup diagnostic also passed. The missing-entry diagnostic is the invalid-startup case covered by this fixture; a separate invalid-script-content warning was not exercised.

The wiki node was not rendered as a link in any browser. The save-enabled export exposed neither a Save nor Load control, so the requested save ZIP download, state change, and import restoration sequence could not run. The e2e assertions now record these gaps explicitly and still complete the independent runtime and network checks. No HTTP(S) requests or uncaught page exceptions were observed across the nine cases.

The failed behavior is absent from the supplied portable player runtime (`packages/player/src/Player.tsx` and `packages/player/src/portable-entry.tsx`). Task 28B owns `packages/exporter/` and `tests/e2e/export/`; implementing the missing navigation/save UI here would duplicate Agent 22/27 behavior. 28B browser acceptance remains open pending a runtime artifact that supports those flows.

Sample Tavern export ZIP SHA-256: `63a97a3eead40d099622ab4cb5f9c4a79a9bfc0edffb4737dc73d96c0dfe44ea`.

Chrome/Edge branded-browser smoke checks were not run separately. Playwright WebKit is not manual Safari evidence.

A separate attempt to query the WebKit version by launching Playwright's cached `pw_run.sh --version` helper caused a native Playwright WebKit app crash at launch. macOS dyld reported missing `_OBJC_CLASS_$__WKBrowserContext` in the system WebKit framework (macOS 26.6.2). This happened outside the Playwright E2E run. The WebKit E2E project itself completed all three test cases in the recorded run; the missing link and save controls were assertion failures, not browser crashes. Do not use the `pw_run.sh --version` probe as a version check on this OS.
