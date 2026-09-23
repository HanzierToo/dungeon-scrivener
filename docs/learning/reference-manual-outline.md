# Reference manual contents

Use the tutorial for the sequence of ideas. Use this manual for exact names and rules. Each section should link its implementation-independent contract and at least one checked fixture where one exists. The repository check validates document shapes and selected fixture relationships; it is not an engine or archive runtime test.

## 1. Project files and versions

- Project manifest fields: [`project-manifest.schema.json`](../contracts/schemas/project-manifest.schema.json), [manifest example in The Lantern Crossing](../../fixtures/linear-three-nodes/project.json), [Tavern manifest](../../fixtures/tavern-at-dusk/project.json).
- `schemaVersion` versus author-controlled manifest `gameVersion` versus save `engineVersion`: [versioning contract](../contracts/versioning.md).
- Project tree, safe paths, opaque files, and byte preservation: [archive and VFS contract](../contracts/archive-save-fingerprint.md#project-archive-and-vfs), [project VFS schema](../contracts/schemas/project-vfs.schema.json).

## 2. World graph, actions, and command input

- World document: [`world.schema.json`](../contracts/schemas/world.schema.json).
- `entryNodeId`, node IDs, `parentId`, `visitable`, `navigationEdges`, and inheritance: [data model](../contracts/data-model.md#project-and-world-documents) and [The Lantern Crossing world](../../fixtures/linear-three-nodes/world.json).
- Choices and commands together, condition policies, `patterns`, canonical pattern and aliases: [node and action semantics](../contracts/data-model.md#nodes-and-actions), [command normalization and resolution](../contracts/script-subset.md#typed-command-matching), [Tavern commands](../../fixtures/tavern-at-dusk/world.json).
- `PlayerInput`, `matchCommandText`, and `dispatchPlayerInput`: [package API ownership](../contracts/package-apis.md#package-names-and-public-api-ownership).
- Fixture command cases: [`Tavern at Dusk` transcript](../../fixtures/tavern-at-dusk/README.md#expected-player-input-transcript). The contract checker checks its selected raw-input resolutions, not engine dispatch or time effects.

## 3. State, entities, and tags

- Typed world/node/entity state, exact comparison types, and effects: [data model](../contracts/data-model.md#state-entities-events-and-effects), [world schema](../contracts/schemas/world.schema.json).
- Authored `EntityInstance.tags` versus mutable session `entityTags`; `add-tag`, `remove-tag`, and `api.hasTag`: [tag semantics](../contracts/data-model.md#state-entities-events-and-effects), [Tavern definitions and entities](../../fixtures/tavern-at-dusk/world.json), [Python witness script](../../fixtures/tavern-at-dusk/scripts/witness.py).
- State examples: `lantern-lit` in [The Lantern Crossing](../../fixtures/linear-three-nodes/world.json), and Tavern's world `trust`, `bell-rung`, `bell-echoes` plus node `return-visits` in [Tavern at Dusk](../../fixtures/tavern-at-dusk/world.json).

## 4. Events, rules, and trace ordering

- Event payloads, FIFO queue, priority ordering, inherited rules, atomic action transactions, and trace reasons: [data model](../contracts/data-model.md#script-invocation-and-action-transactions), [execution budgets](../contracts/budgets.md#rules-conditions-and-trace).
- Rule examples `clock-rings`, `keeper-hears-chime`, `room-startles`, and `count-taproom-returns`: [Tavern world](../../fixtures/tavern-at-dusk/world.json) and [expected clock/input transcripts](../../fixtures/tavern-at-dusk/README.md).

## 5. Dialogue and inventory

- Conversation entry, lines, participants, options, conditions, interrupt, and resume: [world schema](../contracts/schemas/world.schema.json), [Tavern conversation definitions](../../fixtures/tavern-at-dusk/world.json), [expected player-input transcript](../../fixtures/tavern-at-dusk/README.md#expected-player-input-transcript).
- Inventory effects and item stacks: [world schema](../contracts/schemas/world.schema.json), [player-save schema](../contracts/schemas/player-save.schema.json), [Tavern's silver-key option and save payload](../../fixtures/tavern-at-dusk/README.md).

## 6. Time and randomness

- Per-action and elapsed time, `observeClock`, hidden/unfocused inactivity, resume, and bounded catch-up: [lifecycle and time contract](../contracts/data-model.md#lifecycle-and-time), [clock state in player saves](../contracts/archive-save-fingerprint.md#player-save-archive).
- `per-action` example: The Lantern Crossing, 1000 ms per accepted action, [world settings](../../fixtures/linear-three-nodes/world.json) and [expected transcript](../../fixtures/linear-three-nodes/README.md).
- `elapsed` example: Tavern at Dusk, `bounded-catch-up` capped at 60000 ms, [world settings](../../fixtures/tavern-at-dusk/world.json) and [expected host clock observations](../../fixtures/tavern-at-dusk/README.md#expected-host-clock-observations).
- Seeded/unseeded behavior and recorded random outcomes: [randomness contract](../contracts/data-model.md#randomness-and-typing-sounds), [Tavern JavaScript script](../../fixtures/tavern-at-dusk/scripts/keeper.js), [Tavern save payload](../../fixtures/tavern-at-dusk/saves/compatible-save.json).

## 7. Script source and execution

- Exact JavaScript, Lua, and Python subsets; `main`, `api.read`, `api.hasTag`, `api.request`, `api.emit`, and random calls: [script subset](../contracts/script-subset.md).
- Script IR document: [`script-ir.schema.json`](../contracts/schemas/script-ir.schema.json).
- Source and `run-script` declarations: [world schema](../contracts/schemas/world.schema.json), [Tavern declarations and reachable rules](../../fixtures/tavern-at-dusk/world.json).
- Actual fixture sources: [Lua `echo-check`](../../fixtures/tavern-at-dusk/scripts/echo.lua), [JavaScript `keeper-check`](../../fixtures/tavern-at-dusk/scripts/keeper.js), [Python `witness-check`](../../fixtures/tavern-at-dusk/scripts/witness.py).
- Instruction, loop, activation, action, allocation, and request limits: [budgets](../contracts/budgets.md#script-parser-ir-and-execution).
- The fixture checker parses source languages and checks declaration/reachability references; it does not enforce subset-to-IR compilation or execute script behavior.

## 8. Locales, Markdown, and media

- Locale documents, stable keys, default locale fallback: [`locale.schema.json`](../contracts/schemas/locale.schema.json), [data model](../contracts/data-model.md#identifiers-and-values), [Tavern English locale](../../fixtures/tavern-at-dusk/locales/en-GB.json), and [Japanese locale](../../fixtures/tavern-at-dusk/locales/ja-JP.json).
- Allowed Markdown, stable node links, asset embeds, and rejected URLs: [Markdown contract](../contracts/markdown.md), [world schema](../contracts/schemas/world.schema.json).
- Content-addressed assets and typing sound mapping/fallback: [world schema](../contracts/schemas/world.schema.json), [Tavern media and settings](../../fixtures/tavern-at-dusk/README.md#media-bytes).

## 9. Saves and portability

- `gameVersion`, fingerprint inputs, exact compatibility fields, archive limits, and explicit import/download: [archive/save/fingerprint contract](../contracts/archive-save-fingerprint.md), [`player-save.schema.json`](../contracts/schemas/player-save.schema.json), [`project-manifest.schema.json`](../contracts/schemas/project-manifest.schema.json).
- Compatible and incompatible JSON payload examples: [Tavern save notes](../../fixtures/tavern-at-dusk/README.md#save-examples), [compatible payload](../../fixtures/tavern-at-dusk/saves/compatible-save.json), [incompatible game-version payload](../../fixtures/tavern-at-dusk/saves/incompatible-game-version-save.json).
- Tavern's `savePolicy` is disabled. Its save payload examples do not demonstrate an enabled UI or ZIP import/export. The repository check validates JSON and selected compatibility facts, not player-save archive behavior.
- Project ZIP, player-save ZIP, and exported game ZIP are distinct. Direct-open behavior belongs to browser/export verification, not `npm run check:contracts`. The current [feasibility record](../feasibility.md) has Chromium and Firefox passes, a Playwright WebKit failure before page load, and incomplete Safari action/save evidence.

## 10. Diagnostics, accessibility, and authoring modes

- Diagnostic document and action acknowledgments: [`diagnostics.schema.json`](../contracts/schemas/diagnostics.schema.json), [contract README](../contracts/README.md#common-document-rules).
- Keyboard and focus requirements, and Apprentice/Sage mode boundaries: [shared agent brief](../../DungeonScrivener-Agent-Prompts/00-MASTER.md#immutable-behavior-for-all-agents).
- The repository has no editor fixture or UI implementation in the referenced projects. The learning guide describes contract intent; it does not claim Sage or Apprentice behavior has been exercised.

## Appendices

- [Glossary](glossary.md).
- [Fixture index](../../fixtures/README.md).
- Contract commands: [`package.json`](../../package.json). `npm run check:contracts` has the scope stated in [the learning guide](README.md#what-the-repository-check-establishes); `npm test` remains empty at the fixture task boundary.
