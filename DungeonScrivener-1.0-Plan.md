# DungeonScrivener 1.0: Product contract and agent implementation plan

Status: Phase 2 handoff plan. Phase 3 is an independent orchestration review after implementation. No repository or code exists yet.

## 1. Fixed product contract

**The Scribe** is a single-player, deterministic-when-seeded text adventure engine. **The Interpreter** is the local-first authoring website. Sage Mode is a file-tree IDE. Apprentice Mode is a graph and form editor over the same underlying files. The first internal milestone is a linear story, but the shipped 1.0 includes the systems below. There are no accounts, server-side game state, collaboration, paid services, video, animated images, built-in combat framework, or built-in simulated economy. Authors can make simple combat, currency, and stock using generic state and rules. The more extensive economy and editable advanced script blocks belong to 2.0; a dedicated combat framework is later.

### Engine semantics

- Stable-ID nodes form a containment hierarchy and a separate navigation graph. A parent can organize children, inherit defaults and rules, and be marked nonvisitable. Entry, revisit, and exit effects each support `every time`, `first time`, or `once per playthrough`. An entry node is required.
- Creators configure choices, typed commands with aliases and parameters, and node navigation at game level and override them per node. Both choices and commands can be available together. Typed commands match authored patterns; no natural-language AI is implied.
- Generic entities with custom typed fields and tags, scoped variables, events, conditions, effects, and ordered rules represent characters, factions, relationships, resources, quests, and other mechanics. Rules sort by priority and author order; triggered work enters a bounded event queue. Every change and trigger has a reason in the debug trace. Cycles stop with an actionable diagnostic.
- World time can advance on actions or elapsed time. Elapsed time pauses when the tab is hidden or closed by default. Creators can opt into catch-up on return with a maximum interval and can show a clock HUD. Seeded random is reproducible; unseeded random is logged and saved for replay. A save records the seed and outcomes.
- Conversations have stable IDs, multiple speakers, interruptions, resumable context, conditional lines and options, and show-disabled versus hidden option policies. Character traits and opinions arise from authored state/rules rather than automatic personality simulation.
- Inventory supports optional definitions, quantities, containers, item use, and equipment slots. Quality, durability, and other properties are custom fields. No dedicated combat engine is in 1.0.
- Rich Markdown supports standard formatting, tables, callouts, wiki-style node links, and asset/node embeds. Node links navigate using stable IDs; duplicate human-readable labels must not create ambiguous targets. Sanitization prevents content from executing HTML/JS.
- Media includes static images, ASCII art, audio and customizable typing sounds by key or key group, with volume controls. Content-addressed assets share one stored binary across references. The author can change the player's visual style, including CSS, subject to isolated rendering and validation.
- Locales are structured JSON keyed by stable string keys. Game text may instead be hard-coded. Missing translations fall back to the project default locale and produce nonblocking diagnostics. Keyboard use and readable focus states are required; mobile authoring is not a target.

### Project, runtime, and security contracts

- A project is a versioned virtual file tree. `project.json` is the manifest, `world.json` contains structured author data, `locales/*.json` translations, `scripts/*` supported source, `assets/*` deduplicated media, and arbitrary other paths/files are retained byte for byte. The exact schema is frozen in 1B. Never normalize untouched file bytes on import/export. Distinct paths remain distinct even if their bytes coincide, except the managed asset store. Reject unsafe ZIP paths, path collisions, excessive decompression, and unsupported archive features with clear errors.
- Authoring recovery uses IndexedDB; ZIP import/export is the deliberate portable project save. The save reminder appears after 10–15 minutes of unsaved work and can be dismissed. Recovery failure/quota exhaustion is visible. ZIP saves must be possible even if author data has validation errors.
- Player save ZIPs contain versioned session state, node/conversation context, game time, seed and random outcomes, and a playable-content fingerprint. They import on the hosted game and exported game of the same version. An older/incompatible game version is rejected clearly. Creators choose disabled, one or multiple UI slots and allowable save locations; an optional checkpoint is supported. ZIPs are explicit downloads/imports, not silent writes to the game's folder. Portable files cannot enforce that a player keeps only one physical copy.
- Scripts in JS, Lua, and Python are supported **as documented subsets**, with equivalent access to the same capability-limited engine API. They compile to a common intermediate representation executed by a JavaScript-only browser runtime. No arbitrary language packages, imports, browser globals, DOM, network, filesystem, async operations, reflection, or `eval`. Unsupported syntax is a compile diagnostic, never a lossy or silent conversion. Scripts read a snapshot and request validated effects/events; the engine owns state mutation. Limit work, event cascades, recursion, and allocation. Arbitrary project files remain inert unless explicitly declared. Treat hostile project input as untrusted throughout.
- The authored site runs offline after first load through an installed app cache. Export is a ZIP with `index.html`, static assets, and an optional generated README. The player opens `index.html` directly, with no local server, remote request, module import, fetch of local data, or installed dependency. A feasibility spike proves this across Chromium, Firefox, and WebKit before choosing the final bundling/isolation technique. The same runtime and project data power hosted play, preview, and export. The emitted HTML has inlined classic JS and serialized game data as needed; use safe escaping. Chrome and Edge are covered by Chromium plus targeted branded-browser smoke tests. If direct-open support cannot be delivered across target browsers, pause and report the smallest proposed contract change; broad browser support has priority.
- Diagnostics are nonblocking for project saves and present an acknowledgment before deliberate ZIP save, play, or export. Automatic recovery never waits for a modal. A malformed game must produce a precise runtime/build error rather than silently skipping a broken path. A missing/invalid entry node may prevent starting play while leaving save/export and a clear error report available.

### Suggested implementation stack

TypeScript throughout; npm workspaces; Vite and React for the authoring site; CodeMirror for Sage; React Flow for Apprentice; a small shared player UI; IndexedDB for recovery; a maintained ZIP library, Markdown parser/sanitizer, and AST parsers selected in 1B; Vitest for focused module tests and Playwright for Chromium, Firefox, and WebKit. Pin versions and licenses in the lockfile at scaffolding. No CDN is required at runtime. Do not add dependencies to root manifests from parallel tasks. Instead, ask the integration owner to update the lockfile in a scheduled step.

## 2. Task numbering and shared-repository rules

Within a numbered chain, lettered tasks are strict sequence: `1A → 1B → 1C`. A task may also list prerequisites from other chains. A bare number has **no implementation prerequisites**, may run whenever, and owns isolated documents or templates. Tasks in different chains may run concurrently only when all listed prerequisites are done and their exclusive paths do not overlap. The contract in this document is immutable until the orchestrator records a change for every affected task.

One agent owns one task. A task may change only its listed directory. Only 1B and the integration chain may change root configuration, workspace manifests, lockfile, shared schemas, or public interface declarations. Agents must not silently repair another task's code. Each handoff includes files changed, API exported, test command/result, unresolved issue, and any needed integration change. A later integration task owns shared wiring.

Suggested directories: `apps/studio`, `packages/model`, `packages/vfs`, `packages/persistence`, `packages/engine`, `packages/scripting`, `packages/markdown`, `packages/media`, `packages/player`, `packages/sage`, `packages/apprentice`, `packages/diagnostics`, `packages/debugger`, `packages/player-save`, `packages/exporter`, `fixtures`, `docs`, `spikes`, and `tests/e2e`. The orchestrator commits or checkpoints at each accepted task boundary; agents working simultaneously receive distinct path ownership.

## 3. Agent tasks

Each row is a complete task assignment when paired with the fixed product contract above. “Done” is an observable acceptance check, not a request for a screenshot alone.

### Gate and shared contracts

| ID | Prerequisite | Exclusive ownership | Assignment and done check |
| --- | --- | --- | --- |
| **1A** | None | `spikes/direct-open/`, `docs/feasibility.md` | Build a minimal ZIP with an inline classic JS runtime, media assets, a restricted user-script example, and save ZIP download/import. Open its `index.html` directly with no server or network in Chromium, Firefox, and WebKit. Test opaque script isolation, no local fetch/module, Unicode, and image/audio loading. Record exact pass/fail evidence and browser differences. If the contract fails, report a proposed change before any full implementation. No production scaffolding. |
| **1B** | 1A | Root config, `docs/contracts/`, `packages/model/src/public-types.ts` | Create npm workspace, TS strict settings, Vitest/Playwright config, pinned dependencies, CI commands, and canonical JSON schemas. Freeze IDs, manifest, world, script IR, diagnostic, event/effect, player view, project VFS, save format, content fingerprint, and public package API contracts. State exact allowed script grammar and budgets in `docs/contracts/`. Do not implement features. `npm ci`, typecheck, and an empty test suite work. |
| **1C** | 1B | `fixtures/` | Author a tiny linear story plus a comprehensive “Tavern at Dusk” fixture covering revisits, inheritance, commands, dialogue interruption, two speakers, inventory, a rule cascade, time, two locales, media, and three script sources. Include expected action sequences and expected state/trace snapshots. Fixtures validate against 1B schemas and become acceptance inputs for later chains. |

### Truly independent tasks, runnable in any order

| ID | Exclusive ownership | Assignment and done check |
| --- | --- | --- |
| **2** | `docs/ux/` | Draw low-fidelity author flows for create/import, Sage file editing, Apprentice graph/form editing, switching modes with preserved opaque scripts, playtest/debug, and export. Specify empty/error states and keyboard navigation. Do not implement UI or alter schema. Deliver annotated screens and interaction rules. |
| **3** | `docs/learning/` | Write a plain-language tutorial outline and worked story examples for nodes, state, rules, conversations, and script subsets. Include beginner-to-Sage transition and reference manual contents. Keep examples descriptive until schemas are frozen. |
| **4** | `docs/security/` | Threat-model untrusted ZIPs, arbitrary files, scripts, Markdown, CSS, assets, exports, and browser storage. Produce concrete attack cases and a verification checklist, without editing runtime or claiming an absolute sandbox guarantee. |
| **5** | `docs/exports/` | Draft the optional generated README and distribution notice. Explain extracting the ZIP, opening `index.html`, save ZIP downloads/imports, compatibility, and limitations. Deliver templates with placeholders; no generator code. |

### Data and persistence chains

| ID | Prerequisite | Exclusive ownership | Assignment and done check |
| --- | --- | --- | --- |
| **10A** | 1B | `packages/vfs/` | Implement byte-preserving virtual files, safe normalized path lookup without rewriting bytes, explicit directories, atomic add/rename/delete, and content hashing for managed assets. Reject traversal, duplicate/case-colliding paths, and oversized inputs. Round-trip an unrelated binary and comments exactly. |
| **10B** | 10A | `packages/vfs/` | Implement project ZIP import/export with versioned manifest checks, extraction budgets, unsupported-feature diagnostics, and arbitrary-file preservation. Import then export the fixture and verify every untouched entry's bytes and relative path. Preserve invalid authored files for recovery without treating them as executable. |
| **11A** | 10A | `packages/persistence/` | Implement IndexedDB project recovery and crash-safe snapshots through the VFS adapter. On quota/storage failure preserve in-memory work and show a recoverable diagnostic; never claim a save succeeded if it failed. Reload a project including a large audio blob. |
| **11B** | 11A | `packages/persistence/` | Implement dirty-state tracking, a dismissible 10–15 minute reminder, last exported ZIP timestamp, and recovery restore prompt. A dismissed reminder does not reset the meaning of an unsaved project. Test tab reload and dismissal behavior with a fake clock. |
| **12A** | 1B | `packages/model/` except public types | Implement schema validation and defaults for nodes, world graph, entity definitions, variables, scripts, locale keys, media references, and settings. Stable IDs and containment/navigation are distinct. Return typed diagnostics with path and entity ID; do not mutate imported bytes on validation. |
| **12B** | 12A | `packages/model/` except public types | Implement migration policy and semantic reference checks. Validate unique IDs, reachable entry, missing references, cycles in containment, inherited settings, and ambiguous wiki labels. No automatic migration for an unknown future schema. Add fixture-based tests. |

### Engine chains

| ID | Prerequisite | Exclusive ownership | Assignment and done check |
| --- | --- | --- | --- |
| **13A** | 12A | `packages/engine/src/core/` | Implement immutable session snapshot, scoped typed state, validated effects, transactions, and transition traces. Only reducer effects change state. Test actor, world, and node scopes, rejected type changes, and rollback of a failed action. |
| **13B** | 13A | `packages/engine/src/core/` | Implement event queue, conditions, rule priority/order, inherited rules, `first/every/once` guards, reason trace, and finite work budget. A self-triggering rule produces a cycle/budget diagnostic with no hung tab. |
| **13C** | 13B | `packages/engine/src/core/` | Implement node entry/exit/revisit, choices, command aliases and parameters, fallback responses, and combined choice/command availability. Invalid input leaves state unchanged and responds predictably. Demonstrate both input methods at the tavern node. |
| **13D** | 13C | `packages/engine/src/core/` | Implement action time, elapsed time with hidden/closed pause or capped catch-up, clock HUD data, seeded PRNG, and logged unseeded outcomes. Use injectable clocks and entropy; deterministic action sequences reproduce state/trace. |
| **14A** | 13C | `packages/engine/src/dialogue/` | Implement multi-speaker conversations, conditional lines/options, hidden/disabled policy, interruption/resume stack, and remembered history. Simulate leaving during a conversation, changing a relationship, and resuming with the appropriate lines. |
| **15A** | 13C | `packages/engine/src/inventory/` | Implement opt-in item definitions, quantity, containers, use dispatch, optional equipment slots, and custom fields such as quality. Reject negative stock, unknown items, and invalid slot/container references; no combat assumptions. |

### Scripting chains

| ID | Prerequisite | Exclusive ownership | Assignment and done check |
| --- | --- | --- | --- |
| **16A** | 1B, 13A | `packages/scripting/src/ir/` | Implement documented expression/statement IR, typed engine capability calls, source spans, and validator. Contract: literals, arithmetic/comparisons, booleans, local bindings, branches, bounded loops, arrays/maps, helper functions, and return. No implicit globals, imports, async, reflection, or arbitrary calls. IR cannot contain direct state writes. |
| **16B** | 16A | `packages/scripting/src/frontends/js/` | Parse the documented JS subset to IR. Retain line/column spans; reject unsupported constructs with examples. Golden tests prove equivalent effects to the other two frontends for the same small scripts. No `eval` or executing source to parse it. |
| **17A** | 16A | `packages/scripting/src/frontends/lua/` | Parse the documented Lua subset to the same IR. Define `nil`/truthiness/indexing conversions explicitly and reject constructs with different semantics rather than guessing. Golden tests cover branches, bounded loops, helpers, and API calls. No Lua runtime in exported games. |
| **18A** | 16A | `packages/scripting/src/frontends/python/` | Parse the documented Python subset to the same IR. Define indentation, `None`, truthiness, integer/float behavior, and supported collections explicitly. Reject imports, introspection, decorators, classes, and unsupported syntax. Golden tests match JS/Lua fixture outcomes. No Python runtime in exported games. |
| **19A** | 16A, 1A | `packages/scripting/src/executor/` | Execute validated IR in an isolated capability-limited context using the browser strategy proven in 1A. Only the bridge receives snapshot reads and effect requests. Bound steps, recursion, memory, elapsed work, and event emissions. Demonstrate denial of DOM/storage/network/file access in all target browsers. Do not claim arbitrary malicious code can be made harmless merely by string filtering. |

### Rendering and player chains

| ID | Prerequisite | Exclusive ownership | Assignment and done check |
| --- | --- | --- | --- |
| **20A** | 12A | `packages/markdown/` | Render safe Markdown, tables, callouts, wiki links to stable nodes, and asset/node embeds with bounded transclusion depth. Resolve missing/ambiguous targets to diagnostics. Sanitize raw HTML/URLs and prevent script execution. Preserve author source for round-trip editing. |
| **30A** | 12A | `packages/i18n/` | Resolve stable locale keys and hard-coded source text from separate locale JSON files. Support a project default and missing-key fallback with diagnostics, without changing author strings. Test accented text, non-Latin characters, and a game with no translation files. |
| **21A** | 10A, 12A | `packages/media/` | Implement shared asset registry by content hash; retain original author filenames as metadata. Render static images, ASCII text, audio and key/key-group typing sounds. Include volume adjustment, user gesture for audio activation, and no editing/trimming, video, GIF, SVG script, or animation. Verify repeated node references share one binary. |
| **22A** | 13D, 14A, 15A, 20A, 21A, 30A | `packages/player/` | Build keyboard-accessible player UI from engine `PlayerView`: title/settings/load, content, choices, typed command field, dialogue speaker attribution, inventory view, HUD clock, and configurable CSS theme. Reject network-loading CSS constructs in offline exports. Credits/endings are nodes. No engine state is stored inside UI components. Run the fixture through an actual browser. |
| **22B** | 22A, 19A | `packages/player/` | Wire validated script effects and engine diagnostics into hosted play and preview. Imported arbitrary files and rich text must not execute as browser code. A broken scripted option remains visible with a precise error on attempted action. |

### Editor, validation, and debugger chains

| ID | Prerequisite | Exclusive ownership | Assignment and done check |
| --- | --- | --- | --- |
| **23A** | 10A, 12A | `packages/sage/` | Build IDE file tree, create/rename/delete, raw text and binary previews, CodeMirror editing, JSON/script diagnostics, and arbitrary-file support. Keep a last valid parsed project view while invalid raw text remains available and exportable. No Git/versioning UI. |
| **23B** | 23A, 16B, 17A, 18A | `packages/sage/` | Add JS/Lua/Python source editors, language-aware error locations, locale JSON editor, and safe switching between editor/file views. Editing a file changes only its intended bytes and metadata; unsupported script text is not silently rewritten. |
| **24A** | 12A | `packages/apprentice/` | Build graph and hierarchy views with add/link/reparent/delete of visitable and organizational nodes. Use structured commands against the common project model. Differentiate containment from navigation visually; undo/redo graph edits without losing IDs. |
| **24B** | 24A, 13B, 14A, 15A | `packages/apprentice/` | Add forms for text, choices, commands, conditions, effects, events, priorities, actors, dialogue, time, and inventory. The form-generated output runs through the same engine and validation as Sage. Provide readable summaries for inherited settings and rules. |
| **24C** | 24B, 23B | `packages/apprentice/` | Display advanced scripts as named, readable, noneditable blocks with “Edit in Sage” navigation. Preserve source byte for byte when changing nearby visual content or switching modes. Never discard unknown supported fields. |
| **24D** | 24C, 20A, 21A, 30A | `packages/apprentice/` | Add visual rich-text/Markdown editing with a source escape hatch, asset assignment/reuse, typing sounds, author CSS/theme settings, translation keys, and language fallback preview. Switching to Sage and back preserves unknown Markdown and script source. Test one node with media and two locales. |
| **25A** | 12B | `packages/diagnostics/` | Aggregate structural, reference, reachability, Markdown, locale, and asset diagnostics with severity, exact source path/node, and suggested fix. Warnings do not block project ZIP export. Create a reusable acknowledgment UI contract for play/export. |
| **25B** | 25A, 16B, 17A, 18A, 19A | `packages/diagnostics/` | Include script syntax/runtime errors, rule cycle/budget, and invalid content-fingerprint save reasons. A fatal start error shows a precise screen rather than blank play. Add test cases for broken content and acknowledgment before play/export. |
| **26A** | 13D | `packages/debugger/` | Implement optional trace panel for action input, rule decisions, state changes, source spans, event queue, clock, and randomness, with filtering. Engine emits the log; panel never mutates engine directly. Replay a fixture and explain why a conditional choice appeared. |
| **26B** | 26A, 14A, 15A | `packages/debugger/` | Add sandboxed playtest checkpoints, restart, step, inspect, and explicitly labeled state editing through validated effects. Debug edits are confined to test session and do not silently alter the authored project. |

### Saves, export, and integration chains

| ID | Prerequisite | Exclusive ownership | Assignment and done check |
| --- | --- | --- | --- |
| **27A** | 10A, 13D, 14A, 15A | `packages/player-save/` | Define versioned player save snapshot, content fingerprint, seed and unseeded outcomes, conversation stack, inventory, rule guards, and time. Verify serialization/deserialization reproduces a mid-dialogue session without evaluating source. |
| **27B** | 27A | `packages/player-save/` | Add ZIP download/import and policy: disabled, single/multiple UI slots, allowed nodes/anywhere, optional checkpoint. Reject incompatible game versions with a clear message. Test one save ZIP with both the hosted and portable save-codec adapters; final exported-browser interchange is checked in 28B. Do not assume `file://` persistent storage or directory writes. |
| **28A** | 1A, 10B, 16B, 17A, 18A, 19A, 22B, 27B | `packages/exporter/` | Generate ZIP with direct-open `index.html`, bundled/inlined classic runtime, serialized compiled IR and data, relative media, and optional README template. Escape embedded JSON/script boundaries, avoid network/CDN/module/local fetch, and include author style safely. Build once and verify assets and text round-trip. |
| **28B** | 28A | `packages/exporter/`, `tests/e2e/export/` | Run exported ZIP unpacked from disk in Chromium, Firefox, and WebKit with network disabled. Test JS/Lua/Python-authored script paths, media, node link, locale, time, save/download/import, invalid content warning, and no uncaught exceptions. Record branded Chrome/Edge manual smoke checks separately. |
| **29A** | 1C, 11B, 22B, 23B, 24D, 25B, 26B, 27B, 28B | `apps/studio/`, root manifests/lockfile, `tests/e2e/studio/` | Integrate package public APIs, wire home/create/import/recovery/Sage/Apprentice/playtest/export flows and offline service-worker cache. This owner alone changes root dependencies/wiring. Test creator edits in both modes, closes/reloads, ZIP round-trips, and exports a working direct-open game. |
| **29B** | 29A, 2, 3, 4, 5 | `apps/studio/`, `docs/`, `tests/e2e/` | Incorporate UX/tutorial/security/README results; finish accessibility, keyboard use, nonblocking save reminder and validation modals, language fallback, no-network operation, and documentation. Test on Chromium/Firefox/WebKit and report known limitations without burying them. |
| **29C** | 29B | `tests/`, `docs/release/` | Run final fixture-based journey and release checklist. Produce build artifact, exact test results, failed cases, open limitations, and a reproducible manual test procedure for phase 3. No untracked “cleanup” refactors. |

## 4. Safe parallel schedule

1. **Before code:** 1A is the direct-open feasibility gate. Tasks 2–5 may start at any time. Pause architecture decisions if 1A fails.
2. **Freeze contracts:** 1B. Then 1C, 10A, 12A, and 24A (after 12A) can begin on distinct paths. Parallel agents use the frozen public types and may not edit them.
3. **Engine and utilities:** after 13A/13B, start dialogue, inventory, script IR, Markdown, media, debugger, persistence, and validation in their separate directories. JS/Lua/Python frontends run concurrently once 16A is accepted.
4. **Interfaces and export:** Sage and Apprentice proceed independently by path; the player starts when engine + rendering contracts are ready; export starts only after the player and save contracts exist.
5. **One integration owner:** 29A–29C are sequential and should not overlap any writer touching root config, editor shell, or cross-package wiring. Leave phase 3 review to the orchestrator, not the implementation agent.

## 5. Reusable small-agent handoff format

Supply each agent only this fixed product contract, the exact task row, approved predecessor API/types, and the relevant fixture. Use this prompt wrapper:

> Implement task **[ID]** for DungeonScrivener 1.0. Prerequisites **[IDs]** are accepted. You own only **[paths]**. Implement exactly **[assignment]** and satisfy **[done check]**. Do not edit root manifests, lockfile, shared contracts, or other packages. Preserve invalid authored content for recovery, report unsupported behavior clearly, and never execute arbitrary project files. Run the smallest meaningful tests for this slice. Return changed paths, exported API, test command and result, unresolved issues, and any required integration change. If an interface in the accepted contract is insufficient, stop that change and describe the smallest proposed amendment; do not invent a parallel API.

Before dispatch, the orchestrator records the accepted predecessor commit/checkpoint, assigns paths, and confirms no active agent owns them. After handoff, the orchestrator checks changed paths, tests, public API, and fixture behavior before releasing the next dependent task. A failed task is repaired in its own ownership area before successors start. Only the orchestrator may approve contract amendments and update affected assignments.

## 6. Phase 3 review owned by the orchestrator

Review the final product against the fixed contract, not just passing unit tests. Walk a project from new creation through both modes, invalid edits, recovery, playtest/debug, save ZIP import/export, static export, direct file play, cross-platform player save, and offline restart. Independently inspect adversarial ZIP paths, Markdown/script/CSS isolation, resource limits, failed storage, rule cycles, missing translations, script conversion diagnostics, and keyboard operation. Compare the comprehensive fixture's expected state/event trace to hosted and exported runs in Chromium, Firefox, and WebKit. File concrete defects with reproduction steps, assign narrow repairs, rerun only affected gates, then issue a release decision with explicit unresolved limitations.

## 7. Decisions that must never be inferred away

1. No silent best-effort Lua/Python translation. Unsupported language features fail visibly at compile time. All three supported subsets run through one browser engine.
2. A ZIP can retain arbitrary files byte for byte while still refusing to execute them.
3. The browser cannot promise to write a save into an extracted game folder. Save ZIP import/download is the portable contract.
4. A project save is always recoverable/exportable even if validation fails; invalid play has a precise error.
5. “Single save slot” is a UI policy, not a restriction on copying an exported ZIP.
6. An implementation task is not independent merely because two agents edit different files; freeze the relevant interfaces before they work in parallel.
