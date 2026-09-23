# Learning guide glossary

**Action**. A selected choice or dispatched typed command. Accepted actions may apply effects and may advance per-action time. Rejected, ambiguous, disabled, or rolled-back actions do not advance that clock. See [action semantics](../contracts/data-model.md#nodes-and-actions).

**Apprentice Mode**. The visual graph and form editor over a project. It shares the underlying project with Sage Mode; it does not have a separate model.

**Asset**. A managed media file referenced by its SHA-256 content address. The Tavern fixture includes a local PNG and WAV; its typing sound refers to the WAV asset hash.

**Bounded catch-up**. Elapsed-time policy that adds no more than `maxCatchUpMilliseconds` for an inactive interval on resume. In Tavern at Dusk, a 300000 ms inactive interval adds 60000 ms.

**Command pattern**. Authored text pattern matched against raw player command text. The first pattern is canonical; later patterns are aliases. A `{parameter}` captures one token. Different command IDs may both match and produce an `ambiguous` result.

**Condition**. A read-only check of the current snapshot or triggering event. It returns whether an option or action is available; it does not change state.

**Containment**. Parent-child organization of nodes. It does not itself provide navigation.

**Diagnostic**. A structured report for invalid, missing, unsupported, or risky content. Structural/reference checks and runtime diagnostics come from different work; a passing contract check is not a runtime test.

**Effect**. A validated request that the engine applies in the provisional action transaction, such as `set-state`, `add-tag`, or `run-script`. Scripts request effects and cannot directly write state.

**Elapsed time**. Game time advanced from host calls to `observeClock`. The engine does not read browser time or visibility globals itself.

**Entity**. A generic world object with authored identity, a definition, fields, and tags. Mira and Rowan are entities in Tavern at Dusk.

**EntityInstance.tags**. Authored initial tags for an entity. At session creation they seed the mutable runtime tag set.

**Event**. A named occurrence with a declared payload. `api.emit` appends it to the FIFO event queue; matching rules run according to priority and author order.

**Exported game ZIP**. A portable playable game package. The contract requires the extracted `index.html` to open directly from disk. `npm run check:contracts` does not build or browser-test this archive.

**Game version (`gameVersion`)**. Author-controlled version stored only in `project.json`. Player saves copy it. It is distinct from the JSON document's `schemaVersion` and the software `engineVersion`.

**Locale key**. Stable key resolved from locale files using the requested locale and then the project's default locale.

**Mutable session tags (`entityTags`)**. Runtime tag sets initialized from each entity's authored tags. `add-tag` and `remove-tag` update them idempotently. Conditions and `api.hasTag` read this session set, which player saves persist.

**Navigation edge**. Authored connection from one node to another. A choice or command can reference an edge; containment alone is not a route.

**Node**. Stable-identity story location with content and authored behavior. A node may be a nonvisitable organizer or a visitable player location.

**Per-action time**. Time advanced by `millisecondsPerAction` after each accepted action. The Lantern Crossing uses 1000 ms per accepted action.

**Player input (`PlayerInput`)**. Either a choice ID or raw command text. `matchCommandText` resolves raw text before `dispatchPlayerInput` handles it; callers do not construct parameter maps.

**Player-save ZIP**. ZIP containing exactly one `save.json` document. Import compares project ID, manifest game version, engine version, and playable-content fingerprint. Saves are explicit downloads/imports.

**Player-save payload**. The JSON session document stored inside a player-save ZIP. Tavern's `saves/*.json` fixture files are payload examples, not ZIP archives.

**Project ZIP**. The author's portable project save. It retains the VFS tree, including opaque arbitrary files, and is distinct from a player save or exported game.

**Rule**. Logic triggered by an event or lifecycle/time phase. Matching rules execute by descending priority, then authored array order; their event work is bounded and part of the enclosing action transaction.

**Sage Mode**. File-tree IDE for direct project file inspection and editing. It edits the same project as Apprentice Mode.

**Schema version (`schemaVersion`)**. Version of a serialized document shape. It is not the author-controlled game version or the software engine version.

**Scope**. The owner of a state value: world, node, or entity.

**Script capability API**. Limited `api` calls available in the documented script subsets: `read`, `hasTag`, `request`, `emit`, `randomInt`, and `randomFloat`. Scripts have no DOM, storage, network, filesystem, imports, reflection, or `eval` access.

**Script IR**. Validated common intermediate representation produced by a supported frontend and run by the capability runtime. Parsing source syntax alone does not establish IR compilation or execution.

**`run-script` effect**. Authored effect naming a declared script. It invokes that script's zero-argument `main` synchronously at that position in the effect list. Scripts cannot recursively request `run-script`.

**Stable identifier**. Machine-facing lowercase kebab-case reference that remains unchanged when display text is renamed.

**State**. Typed value remembered by the game at world, node, or entity scope. The declared value type must match exactly.

**Unseeded random outcome**. Accepted random result from the host entropy source, recorded in order with source script, operation, bounds, and value. Failed actions do not commit outcomes.

**Visitable node**. Node that can be a player location. `visitable: false` may be used for a node that only organizes child nodes.
