# Task 28B export browser evidence

## Run

The spec compiles the Tavern's JS, Lua, and Python sources, supplies Agent 22's standalone runtime artifact, and passes Agent 13's compiled script bundle and the accepted source-content fingerprint to `exportGame`. It extracts each generated ZIP to a temporary directory and opens `index.html` through `file://`. HTTP and HTTPS requests are blocked; local files and blob URLs remain available.

```sh
npx playwright test tests/e2e/export/export.spec.ts --config=playwright.config.ts
```

Playwright version: **1.63.0**. Browser versions: **Chromium 153.0.8010.12**, **Firefox 155.0**, **WebKit 26.6**.

## Result on 2026-09-24

Run result after rebuilding the portable player from `main` at `70ec1401fa327f59c28e5d421892bed790062dc5`: **9 passed, 0 failed** (three cases in each browser engine).

In all three engines, the exported file opened directly from disk, the game rendered, image and audio assets resolved, and the embedded payload carried the accepted save target unchanged:

```json
{
  "manifest": { "projectId": "tavern-at-dusk", "gameVersion": "1.0.0" },
  "engineVersion": "1.0.0",
  "contentFingerprint": "sha256:eba68a00f286dd699b6ff737954115d5601c79087b7952c6d8559d8016089897"
}
```

The authored wiki link was clicked and navigated to The Cellar in all three browsers. The bounded clock and JS/Lua/Python script checks, Japanese locale projection (`酒場の広間`), and missing-entry startup diagnostic passed. The missing-entry diagnostic is the invalid-startup case covered by this fixture; a separate invalid-script-content warning was not exercised.

For the save-enabled export, each browser downloaded a `.zip` save while at The Cellar, navigated back to The Taproom, imported the downloaded ZIP, and restored The Cellar. No HTTP(S) requests or uncaught page exceptions were observed across the nine cases.

Sample Tavern export ZIP SHA-256: `5e3fde7db792cefe43984c40c6e49c3a33fd235cb72c6a5c583e8984af32f24e`.

Chrome/Edge branded-browser smoke checks were not run separately. Playwright WebKit is not manual Safari evidence.

A separate WebKit version-probe attempt using Playwright's cached `pw_run.sh --version` helper crashed at launch. macOS dyld reported missing `_OBJC_CLASS_$__WKBrowserContext` in the system WebKit framework (macOS 26.6.2). This crash happened outside the E2E run and is distinct from its result: the WebKit E2E project completed all three cases successfully. Do not use the `pw_run.sh --version` probe as a version check on this OS.
