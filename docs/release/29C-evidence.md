# DungeonScrivener 1.0 release evidence: 29C

Status: candidate evidence for independent phase 3 review. This is not a 1.0 release approval.

Build source was the shared worktree at base revision `8d766129377ad20f56edfa68d5b0536a0e336444`; accepted 29A/29B and concurrent package changes were uncommitted. The artifact hashes below identify the built output precisely. The base revision alone is not the candidate source snapshot.

## Candidate artifacts

The Studio production build is in [`artifacts/studio-web/`](artifacts/studio-web/). Build command from the repository root:

```sh
npx vite build --config apps/studio/vite.config.ts --outDir ../../docs/release/artifacts/studio-web
```

The build completed with warnings for React Flow's `use client` module directive and the 2.4 MB minified application chunk. Tree SHA-256 is `aaa1ed2bb82a7643df6ec4f13c7e63641fb9f81ee307d4401a6717fcbd11ebf1`. It is computed by sorting relative paths, formatting each as `path NUL file-SHA256`, joining those records with LF, and hashing the result with SHA-256.

The separately tested Tavern fixture export is [`artifacts/tavern-at-dusk-1.0.0-game.zip`](artifacts/tavern-at-dusk-1.0.0-game.zip), SHA-256 `f0e1cda2ba76443724e9c352550004b690a14acd57f8e39258ff778c803251ca`. It contains `index.html` and is opened from `file://` by the exported-game E2E. The generated ZIP embeds the Tavern content fingerprint `sha256:eba68a00f286dd699b6ff737954115d5601c79087b7952c6d8559d8016089897`.

The export E2E used the existing portable player artifact `packages/player/dist/dungeon-scrivener-player.js`, SHA-256 `3ca31881ea0067c4ce78bcb9ae00ffee4f18929eff410990928d16172862f82b`. That generated package artifact was not rebuilt in 29C because the task's writable ownership is limited to `tests/` and `docs/release/`. For a clean-checkout reproduction, build it first with `npm run build:portable --workspace @dungeon-scrivener/player`.

## Verification record

Environment: Playwright 1.63.0, Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6.

| Command | Result |
| --- | --- |
| `npm test -- --reporter=dot` | Passed: 28 files, 153 tests. Includes VFS exact-byte fixture round-trip, malformed content preservation, traversal/casing rejection, and archive limit cases. |
| `npm run check:contracts` | Passed: 42 schema examples, 10 fixture documents, 2 fixtures, 3 syntax-only script parses. This check does not execute fixture scripts. |
| `npx playwright test tests/e2e/export/export.spec.ts --config=playwright.config.ts --output=/tmp/ds-29c-export-results` | Passed: 9/9, three direct-open game cases per browser. |
| `npx playwright test --config tests/e2e/studio/playwright.config.ts --output=/tmp/ds-29c-studio-results` | 20/21 passed. The only failure is WebKit offline reload described below. Chromium and Firefox passed 7/7 each; WebKit passed 6/7. |
| `npx playwright test tests/e2e/export/export.spec.ts --config=playwright.config.ts --project=chromium --grep 'opens extracted export' --output=/tmp/ds-29c-candidate-result` | Passed: 1/1; generated the candidate Tavern ZIP above. |
| `npx vite build --config apps/studio/vite.config.ts --outDir ../../docs/release/artifacts/studio-web` | Passed; emitted the warnings noted above. |
| `npm run typecheck:studio` | Failed on two errors in `packages/scripting/src/frontends/lua/index.ts:212`: `next` may be undefined and `undefined` cannot be used as an index type. No Studio-owned type error was reported. |

The Studio E2E covers starter edit in Sage and Apprentice, recovery, project ZIP download/reimport, offline reload, Tavern script compilation and hosted play, README download, direct-open export, safe/unsafe CSS, invalid script compilation, malformed project validation, locale fallback, a 375px viewport, skip-link keyboard activation, and the dismissible save reminder. Invalid validation, script compilation, and unsafe CSS cases verified that no game ZIP was downloaded.

The exported-game E2E opened the ZIP from disk with HTTP(S) blocked in all three engines. It exercised the Tavern JS, Lua, and Python script paths, image/audio media, the authored node link, Japanese locale, elapsed time, player save download/import, and missing-entry startup diagnostics. All nine cases reported zero HTTP(S) requests and no uncaught page errors. The VFS unit cases check original fixture file bytes after a project ZIP round-trip; the game-export checks also verify expected embedded media paths and save compatibility data.

## Failures and limitations

1. **WebKit Studio offline reload:** the Studio journey fails at `page.reload()` after `context.setOffline(true)`, with `WebKit encountered an internal error`. The preceding save/reimport flow succeeds. WebKit's other six Studio journeys pass, and all three exported-game journeys pass. This does not establish Safari offline-reload support.

   Reproduce with:

   ```sh
   npx playwright test --config tests/e2e/studio/playwright.config.ts --project=webkit --grep 'create, edit in Sage' --output=/tmp/ds-29c-webkit-offline
   ```

2. **Studio typecheck:** reproduce with `npm run typecheck:studio`. The failure is in the Lua frontend, outside 29C's owned paths. The Studio Vite production bundle succeeds independently.
3. **Build warnings:** the Studio bundle retains the React Flow directive warning and produces a 2.4 MB minified JavaScript chunk. These were not changed during this release-evidence task.
4. **Manual browser evidence:** branded Chrome and Edge, Safari outside Playwright, screen-reader behavior, and assistive-technology coverage remain untested. The E2E viewport and keyboard checks are smoke coverage, not a full accessibility audit.
5. **Release packaging:** the README remains a separate download beside the game ZIP because the public exporter contract has no README field. The game archive itself is tested direct-open.

## Phase 3 manual procedure

Run this procedure against the exact candidate artifacts above, record browser names and versions, and attach failures to the independent phase 3 review.

1. On a clean candidate checkout, install the lockfile dependencies. Build the portable player before running exported-game tests:

   ```sh
   npm ci
   npm run build:portable --workspace @dungeon-scrivener/player
   ```

2. Serve the Studio candidate from a local HTTP origin so its service worker can operate:

   ```sh
   npx vite preview --config apps/studio/vite.config.ts --outDir ../../docs/release/artifacts/studio-web --host 127.0.0.1
   ```

   Visit `http://127.0.0.1:4173`. Create a project, edit a file in Sage, add a scene in Apprentice, return to Sage, and download/reimport a project ZIP. For a fixture byte check, compare `shasum -a 256 fixtures/tavern-at-dusk/scripts/keeper.js` with `unzip -p /path/to/downloaded-project.zip scripts/keeper.js | shasum -a 256`; the digests must match.

3. Import the Tavern fixture project ZIP. Start hosted play, confirm the `echo-check`, `keeper-check`, and `witness-check` scripts run, switch to Japanese, and verify missing Japanese strings fall back to English. Repeat at a 375px-wide viewport. Check the skip link, visible keyboard focus, warning acknowledgment modal, validation error alert, and the ten-minute reminder flow (the E2E clock advances the reminder timer).

   To create a fixture ZIP on macOS, run from the repository root:

   ```sh
   cd fixtures/tavern-at-dusk && zip -qr /tmp/tavern-at-dusk-project.zip . && cd ../..
   ```

   Import `/tmp/tavern-at-dusk-project.zip` through Studio's project ZIP control.
4. In a disposable Tavern project copy, set `world.settings.playerStylePath` to `styles/player.css`, add that VFS file with `.ds-player { color: #211; }`, and verify export includes the safe stylesheet. Export the Tavern game. Extract the complete game ZIP and open `index.html` directly from disk in Chromium, Firefox, and Safari/WebKit. Disable network access or block HTTP(S); verify the Taproom appears, the image/audio assets resolve, the cellar link navigates, the Japanese locale renders, time/scripts progress, and the player save ZIP can be downloaded and reimported. Confirm there are no external requests or uncaught errors.
5. Repeat negative checks with an invalid declared script, malformed entry-node reference, and unsafe player stylesheet. Confirm diagnostics are visible and no game ZIP download occurs. Retain the successful project ZIP and recovery copy as authoring artifacts.
6. Run branded Chrome and Edge smoke checks and a manual keyboard/screen-reader pass. Record any differences from Playwright results. Do not treat this evidence package as self-approval; phase 3 review decides release readiness.

## Reproduction commands

```sh
npm test -- --reporter=dot
npm run check:contracts
npx playwright test tests/e2e/export/export.spec.ts --config=playwright.config.ts
npx playwright test --config=tests/e2e/studio/playwright.config.ts
npx vite build --config apps/studio/vite.config.ts --outDir ../../docs/release/artifacts/studio-web
```
