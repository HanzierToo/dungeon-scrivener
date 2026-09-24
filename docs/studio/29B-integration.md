# Studio integration and release notes

This guide records the 29B application behavior against the accepted UX, learning, security, and export documents. It describes the integrated Studio shell and its verification evidence, not a release approval.

## Create, import, and recover

The starter-project form asks for a title and semantic game version. Its language selector currently offers English (`en-GB`) because that is the only locale shipped with the starter fixture. Import accepts a project ZIP without executing declared or arbitrary source files. Script compilation happens only when the author starts play, playtest, or export.

Recovery snapshots are written locally after changes. A separate, dismissible reminder appears ten minutes after a new project or edit that has not been downloaded as a project ZIP. Dismissing it does not clear the unsaved state. Downloading a project ZIP clears the reminder state. Recovery is local browser storage and is not a substitute for a portable project ZIP.

## Validation, warnings, and keyboard access

The project diagnostics panel stays available in the workspace, including when there are no findings. Blocking play/export preparation errors show their diagnostic codes and messages in a dismissible dialog and remain in an inline alert. Warnings that require acknowledgment use a keyboard-operable modal dialog with explicit cancel and continue actions. Project ZIP download remains available for invalid authoring content.

The workspace has a skip link, labeled project-creation fields, visible focus styles for links and controls, and native modal focus handling. At narrow viewport widths, the header and reminder actions wrap. Sage and Apprentice remain reachable by keyboard through their existing controls. The visual graph's detailed node and edge keyboard behavior belongs to the Apprentice package and is not expanded by this integration task.

## Language and offline behavior

Hosted play exposes available locale files in its Settings panel. The requested locale is passed to the player's public engine adapter; missing keys use the project's default locale through the existing localization contract. Locale selection affects the run display and does not rewrite project files.

Studio validates a referenced stylesheet with the player package's offline-style check. The authored stylesheet is used in the standalone export, but not injected into hosted Studio play because the player API does not document a scoped styling boundary that protects the authoring shell. The direct-open E2E verifies the custom stylesheet is embedded and that the exported page makes no HTTP or HTTPS requests; this is not a general proof against every CSS rendering trick.

Studio precaches its local JavaScript and CSS through its service worker. The exported game is a self-contained direct-open document with local referenced media. The export E2E blocks HTTP and HTTPS requests while opening the extracted `index.html` from `file://` and checks that the document makes no such requests.

## Export notice and README

Before building an export, Studio explains extraction, direct-open play, local assets, offline use, player-save ZIP behavior, and the author's distribution responsibility. The author may request a README generated from `docs/exports/README.template.md`; Studio substitutes the game title/version and optional attribution fields and downloads the Markdown beside the game ZIP. The current public `exportGame` API has no README input, so this file is a separate download and is not inserted into the game archive. Browser test details are intentionally not inferred from the app; provide the release record when sharing the README.

## Verification record

The focused Studio E2E suite is `npx playwright test --config tests/e2e/studio/playwright.config.ts`. It covers starter create/edit/recovery/project-ZIP round-trip/offline reload, Tavern script activation in hosted play, game ZIP direct-open, optional README generation, invalid validation, script compilation and unsafe-style export gates, locale fallback, responsive layout, keyboard skip activation, and the dismissible reminder.

Browser run on this checkout with Playwright 1.63.0: Chromium 7/7 passed; Firefox 7/7 passed; WebKit 6/7 passed after making skip-link activation test independent of the host OS's link-Tab preference. WebKit's remaining case fails when reloading offline with `WebKit encountered an internal error`; its direct-open, script, export, locale, style, validation, and reminder cases pass. This is an unresolved offline-reload limitation, not a Safari release pass.

`npm run check:contracts` passed: 42 schema examples, 10 fixture documents, 2 fixtures, and 3 syntax-only script parses. It validates schemas and fixture references and parses fixture scripts; it does not establish runtime, ZIP, or browser behavior. Vite bundling passed and emitted warnings for the React Flow `use client` directive and the 2.4 MB JavaScript chunk. `npm run typecheck:studio` remains blocked by two errors in the accepted scripting package's Lua frontend (`next` possibly undefined and `undefined` used as an index); Studio has no reported type errors. Do not describe the overall workspace typecheck as clean until that package error is resolved within its ownership task.

## Known limitations

- The project home currently has one starter action and a restore-recovery action, not a recent-project library or a configurable locale catalog for new projects.
- The save reminder tracks whether project content has been downloaded as a project ZIP; it is not a server backup and cannot protect against browser storage removal.
- The generated README is downloaded beside the game archive because the accepted exporter contract does not accept README content.
- Browser and assistive-technology coverage is limited to the exact E2E runs recorded for this task. Screen readers, branded Chrome/Edge, and Safari require separate release smoke checks.
- Hosted Studio play deliberately does not inject author CSS into the editor page until a scoped styling boundary is available. Export validates and embeds the stylesheet, but the accepted style check is not a complete CSS sandbox proof.
- Studio's `build` script runs TypeScript before Vite. The scripting package currently has an unresolved TypeScript error in its Lua frontend; a successful Vite bundle alone does not close that check.
