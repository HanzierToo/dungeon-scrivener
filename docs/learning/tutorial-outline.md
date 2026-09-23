# Tutorial outline: from The Lantern Crossing to Tavern at Dusk

## How to use these lessons

Begin with the [The Lantern Crossing fixture](../../fixtures/linear-three-nodes/README.md). It is a minimal three-node story with real IDs, choices, a world boolean, and per-action time. Move to [Tavern at Dusk](../../fixtures/tavern-at-dusk/README.md) for typed commands, scoped state, dialogue, rules, elapsed time, scripts, mutable tags, locales, media, and save payloads.

The linked fixture documents describe intended behavior. Their action transcripts are semantic expectations, not runtime captures. `npm run check:contracts` verifies schemas and fixture JSON, references, media hashes, selected command matches and save facts, and source-language parseability. It does not execute an engine, verify transcript state transitions, compile source to the restricted script IR, or import ZIP archives. See the [contract check boundary](README.md#what-the-repository-check-establishes).

## 1. Build a three-node route

**Goal:** Make a beginning, a middle, and an ending the player can reach.

**Explain:** A node has a stable ID, content, and a displayed title. Navigation uses separate edges. A parent relationship organizes nodes; it does not create a route or make a nonvisitable organizer a playable location.

**Read the fixture:** In [The Lantern Crossing `world.json`](../../fixtures/linear-three-nodes/world.json), `entryNodeId` is `old-gate`. The authored route is `old-gate` to `stone-bridge` by `gate-to-bridge`, then `stone-bridge` to `lantern-house` by `bridge-to-home`. The last node is the ending. The [world schema](../contracts/schemas/world.schema.json) describes `nodes`, `entryNodeId`, and `navigationEdges`; the [data model](../contracts/data-model.md#project-and-world-documents) explains the distinction between containment and navigation.

**Practice:** Follow the two navigation edges from the entry node. Rename a display title in a copy of the exercise and observe that links use stable IDs rather than titles. This is an exercise, not a modification to the checked fixture.

**Check boundary:** The repository check validates the fixture's JSON and reference links. The README's expected route is not evidence of an implemented runtime traversal.

## 2. Offer choices and typed commands

**Goal:** Distinguish a selected choice from raw command text and understand matching results.

**Explain:** A player input is either a choice ID or raw command text. The engine API names these `PlayerInput`, `matchCommandText`, and `dispatchPlayerInput`. Commands are authored with `patterns`: the first pattern is canonical and later patterns are aliases. Input and patterns are normalized with Unicode NFC, surrounding whitespace trimmed, internal whitespace collapsed, and locale-independent lowercase for matching. A `{parameter}` occupies exactly one token. Quoted and multi-token captures are unsupported.

**Read the fixtures:** In [The Lantern Crossing](../../fixtures/linear-three-nodes/world.json), `open-gate` and `cross-bridge` are choices. `open-gate` sets world state `lantern-lit` to `true` and navigates by `gate-to-bridge`. In [Tavern at Dusk](../../fixtures/tavern-at-dusk/world.json), the nonvisitable `tavern-hall` defines choices and commands inherited by `taproom` and `cellar`. The `talk-to-mira` command has canonical pattern `talk to Mira` and aliases `speak with Mira` and `speak to Mira`. `ask-about-topic` has a one-token string parameter. The [command section of the data model](../contracts/data-model.md#nodes-and-actions) and [script-independent command contract](../contracts/script-subset.md#typed-command-matching) give the exact matching rules.

The checker exercises these Tavern inputs:

| Raw input | Resolution | Meaning |
| --- | --- | --- |
| `COUNT   CANDLES 3` | `count-candles`, with integer `count = 3` | Whitespace and case normalize before matching. |
| `count candles two` | No match | `two` is not an integer capture. |
| `count candles 2` | Ambiguous between `count-candles` and `count-candles-two` | Distinct command IDs can overlap. The result lists IDs in code-point order. |
| `  ASK   ABOUT   RAiN  ` | Alias of `ask-about-topic`, with string `topic = RAiN` | The capture preserves normalized spelling and case while matching is case-insensitive. |

A repeated normalized pattern within one command is a model error. Overlap between different command IDs is allowed and resolves to `ambiguous`; the matcher does not choose the earlier command. No-match, ambiguous, and disabled inputs preserve the session snapshot and consume no per-action time. The fixture check evaluates the raw command matching examples; it does not call the engine's dispatch API.

**Practice:** Choose whether a phrase belongs in a visible choice or in a typed pattern. If you add command parameters, keep each capture to one token and declare its type.

## 3. Store typed state

**Goal:** Record a fact that later actions can read.

**Explain:** A state definition declares a key, scope, value type, and default. The v1 scopes are `world`, `node`, and `entity`. Types are exact; a boolean is not the string `"true"` or integer `1`. State comparisons require matching value types. Entity tags are a separate mechanism, not state fields.

**Read the fixtures:** The Lantern Crossing declares world boolean `lantern-lit`, initially `false`; `open-gate` changes it to `true`. Tavern at Dusk declares world integer `trust` initially `0`, world boolean `bell-rung` initially `false`, world integer `bell-echoes` initially `0`, and node integer `return-visits` initially `0` for `taproom`. Mira and Rowan have entity string state `disposition`. These declarations and initial values are in [the Tavern world document](../../fixtures/tavern-at-dusk/world.json); the definitions are specified by the [world schema](../contracts/schemas/world.schema.json) and [state model](../contracts/data-model.md#state-entities-events-and-effects).

**Practice:** For every fact, say who or what it belongs to before choosing a scope. Use node state for a fact local to one scene, entity state for a character field, and world state for a fact shared across the game.

## 4. Use conditions

**Goal:** Make an authored option depend on state without having the check itself change state.

**Explain:** Conditions read a snapshot. Effects request state or engine changes. A false condition hides an option by default; `falsePolicy: "disable"` leaves it visible but unavailable. A condition does not grant an item, set state, or navigate.

**Read the fixture:** Rowan's `tell-secret` dialogue option in [Tavern at Dusk](../../fixtures/tavern-at-dusk/world.json) checks whether world `trust` is greater than or equal to `1`. The fixture starts `trust` at `0`. After the clock and script cascade described in lesson 6, the Lua script changes `trust` to `1`, so the expected transcript selects `tell-secret`. The default false policy is hide. The [condition and action definitions](../contracts/schemas/world.schema.json) and [data-model rules](../contracts/data-model.md#state-entities-events-and-effects) provide the current schema and semantics.

**Practice:** Add no new field to the fixture. Instead, inspect `tell-secret` and describe separately what its condition reads and what its selected option does. This reinforces the difference between availability and effects.

## 5. Interrupt and resume conversations

**Goal:** Follow two speakers through an interruption while retaining the suspended conversation point.

**Explain:** A conversation has an entry line and participant entities. A selected option may interrupt one conversation and start another. A later option can resume the suspended context. A conversation stack and history are session data; a portable save can retain them.

**Read the fixture:** Tavern at Dusk has `mira-story` and `rowan-story`. Command `talk-to-mira` starts Mira's conversation. Option `interrupt-for-rowan` interrupts it and starts Rowan's; Mira is suspended at `mira-after-return`. After Rowan's `tell-secret`, option `return-to-mira` resumes Mira. If trust is at least one, Mira's `claim-silver-key` option adds one `silver-key` to world inventory. See the [Tavern transcript](../../fixtures/tavern-at-dusk/README.md#expected-player-input-transcript), the world document, and the [conversation fields in the world schema](../contracts/schemas/world.schema.json).

**Practice:** Trace the fixture IDs in order and identify which effect suspends Mira, which starts Rowan, and which resumes Mira. The fixture check validates references; it does not execute the conversation stack.

## 6. Connect rules to time

**Goal:** Distinguish time added by accepted actions from elapsed time reported by the host.

**Explain:** In `per-action` mode, each accepted action adds the positive `millisecondsPerAction`; rejected, ambiguous, disabled, or rolled-back actions add none. In `elapsed` mode, time advances only when the host calls the engine's `observeClock`. The engine does not read browser globals. Hidden or unfocused states count as inactive. On resume, a pause policy adds no inactive time; `bounded-catch-up` adds at most `maxCatchUpMilliseconds`. The saved clock baseline prevents an interval from being counted twice.

**Compare the fixtures:** The Lantern Crossing uses `per-action`, `millisecondsPerAction: 1000`; its expected transcript reaches 1000 ms and then 2000 ms after the two accepted choices. Tavern at Dusk uses `elapsed`, `hiddenBehavior: "bounded-catch-up"`, and a 60000 ms cap. Its expected transcript starts at 0 ms, observes 60000 ms while active, adds 0 while hidden, then adds only 60000 of a 300000 ms inactive interval on resume, reaching 120000 ms. Player choices and commands do not advance that elapsed clock by themselves.

At 120000 ms, rule `clock-rings` listens for `time-advanced`, checks `time-at-least: 120000` and `bell-rung: false`, sets `bell-rung` to true, then runs `echo-check`. The [Tavern fixture README](../../fixtures/tavern-at-dusk/README.md#expected-host-clock-observations) gives the expected clock sequence. The [time and rule contracts](../contracts/data-model.md#lifecycle-and-time) define host observations, while [execution budgets](../contracts/budgets.md#rules-conditions-and-trace) bound rule cascades.

**Practice:** Explain why 300 seconds of inactivity adds only 60 seconds in this fixture. Explain why testing with a player choice after resume would not add more elapsed time without another host clock observation.

## 7. Read and request effects with scripts

**Goal:** Understand the current `run-script` path and the limits on script capabilities.

**Explain:** A script is declared in `world.scripts` with a stable ID, source path, language, and `entrypoint: "main"`. An authored `run-script` effect invokes that zero-argument `main` synchronously at its position in an effect list. The JavaScript, Lua, and Python frontends compile documented language subsets to the shared IR. Scripts do not mutate session state directly. `api.read` and `api.hasTag` read the current provisional snapshot; `api.request` submits a typed `ScriptEffect`; `api.emit` queues a declared event. Each request is validated and applied to the enclosing provisional transaction before the next authored effect. Events are drained FIFO after the current effect list. Any compile/runtime error, invalid request, or budget breach rolls back the whole top-level action, including state, tags, time, and saved random outcomes. See the [script subset](../contracts/script-subset.md), [script IR schema](../contracts/schemas/script-ir.schema.json), [transaction ordering](../contracts/data-model.md#script-invocation-and-action-transactions), and [script budgets](../contracts/budgets.md#script-parser-ir-and-execution).

**Read the fixture chain:** All three scripts are declared and reached from Tavern rules:

1. `clock-rings` runs Lua `echo-check` from [scripts/echo.lua](../../fixtures/tavern-at-dusk/scripts/echo.lua). It reads world `trust`, requests a `set-state` effect to increment it, then emits `midnight-chime` with `minute: 2`.
2. `keeper-hears-chime` runs JavaScript `keeper-check` from [scripts/keeper.js](../../fixtures/tavern-at-dusk/scripts/keeper.js). It calls `api.randomInt(1, 3)`, requests an `increment-state` effect on `bell-echoes`, then emits `tavern-stir` with source `midnight-chime`.
3. `room-startles` runs Python `witness-check` from [scripts/witness.py](../../fixtures/tavern-at-dusk/scripts/witness.py). It calls `api.hasTag("cellar-rowan", "startled")`; if false, it requests `add-tag` for that entity.

The script sources show the exact current spelling. The fixture check parses them as JavaScript, Lua, and Python and checks declarations, reachability, and referenced fixture data. It does not run the scripts through subset-to-IR compilation or execute their effects. The action transcript records expected outputs, including an example unseeded random result of `2`; an actual unseeded draw may be any integer from 1 through 3.

**Practice:** For each script, name its reads, requested effects, and emitted events. Then explain why an API request is not a direct state write and why a later error must roll back earlier requests from the same action.

## 8. Understand saves and export boundaries

**Goal:** Separate the three ZIP purposes and read the current save compatibility fields.

**Explain:** A project ZIP preserves the authoring file tree. An exported game ZIP contains a playable game whose extracted `index.html` is intended to open directly from disk. A player-save ZIP contains exactly one `save.json` document and is explicitly downloaded or imported. The save importer compares project ID, `gameVersion` from `project.json`, engine version, and a recomputed playable-content fingerprint. A mismatch rejects the save and leaves the active session unchanged. V1 does not migrate player saves. The UI slot limit cannot prevent copies of downloaded ZIPs.

**Read the fixtures:** [Tavern `project.json`](../../fixtures/tavern-at-dusk/project.json) sets `gameVersion` to `1.0.0`. [The compatible save payload](../../fixtures/tavern-at-dusk/saves/compatible-save.json) copies that version and has the fixture's playable-content fingerprint. [The incompatible payload](../../fixtures/tavern-at-dusk/saves/incompatible-game-version-save.json) differs from it only in `gameVersion`, which is `0.9.0`. These files are JSON payload examples, not ZIP archives. The Tavern world's save policy is disabled (`enabled: false`, `slotCount: 0`), so this fixture does not demonstrate an enabled in-game save UI or save creation.

`npm run check:contracts` validates the save documents, the compatible payload's game version and computed fingerprint, and the fixture's one-field version difference. It does not call the runtime compatibility API or create/import a save ZIP. The archive rules are in [archive-save-fingerprint.md](../contracts/archive-save-fingerprint.md); the data shapes are in the [manifest schema](../contracts/schemas/project-manifest.schema.json) and [player-save schema](../contracts/schemas/player-save.schema.json).

**Practice:** Explain why equal content fingerprints do not make the legacy payload compatible. The game version still differs. Keep schema version, author game version, and engine version distinct.

## From Apprentice to Sage

Apprentice Mode is the visual graph and form editor; Sage Mode is the file-tree IDE. Both edit the same project. In Apprentice, begin with the three nodes and two edges in The Lantern Crossing. Open the same project in Sage when you want to inspect `project.json`, `world.json`, locale files, managed assets, or scripts. A displayed title can change without changing a stable ID. A mode switch must preserve unknown Markdown and script source rather than silently translating it. This is a product contract; no Sage/Apprentice implementation is covered by the repository fixture check.
