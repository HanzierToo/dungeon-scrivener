# DungeonScrivener 1.0: Authoring and player UX flows

Task 2 deliverable, revised against the corrected 1B contracts and the Task 2 brief. These are desktop-first, low-fidelity flows. They describe supported author and player controls; they do not define schemas or implement UI.

## Shared navigation and diagnostic behavior

- Apprentice and Sage operate on the same project. A mode switch must preserve files and opaque script source byte for byte.
- Keep project title, current mode, recovery status, diagnostics, **Playtest**, **Download project ZIP**, and **Export game ZIP** reachable in both authoring modes.
- Show validation feedback at its source and in a persistent **Diagnostics** panel. In Apprentice, associate the message with its field, scene, or effect. In Sage, include file and source location when available. Keep invalid source available for correction and project ZIP download.
- Show a diagnostic's action blockers separately from its acknowledgment requirements. A diagnostic may block play or export, or require acknowledgment before a specific action; severity alone does not decide either. Project ZIP recovery remains available when authored content is invalid.
- Keep the scene containment outline distinct from the navigation map. Adding or moving a contained scene does not imply a player route.

## Screen 1: Projects, create, and import

```text
┌ DungeonScrivener ───────────────────────────────────────────────────────┐
│ Projects                                      [New project] [Import ZIP]│
├─────────────────────────────────────────────────────────────────────────┤
│ Recent projects                                                         │
│                                                                         │
│  [Project title]   Game version [1.0.0]   [Open]                        │
│  [Project title]   Game version [1.2.0]   [Open]                        │
│                                                                         │
│  No recent projects? Create a project or import a project ZIP.          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Create.** Ask for project title, default locale, and the required initial `gameVersion` value in SemVer format. Do not silently choose or increment a version. On creation, open the project in Apprentice Mode at an empty graph with **Add first scene**. The first scene form marks that scene as the entry scene while no entry exists.

**Import.** Choose a project ZIP and confirm **Import project**. Announce progress and prevent a duplicate import action while it is in flight. On success, open the project in Apprentice Mode and show a diagnostics summary if authored documents have validation errors. Invalid authored files remain available for recovery and project ZIP download. If the archive is unsafe or unreadable, leave the current project open and show the reason with **Choose another ZIP**.

```text
┌ Import project ZIP ─────────────────────────────────────────────────────┐
│ File: tavern-story.zip                                   [Choose file]  │
│                                                                         │
│ Import adds the project to local recovery. Imported scripts are not run │
│ by opening the archive.                                                 │
│                                                                         │
│                                      [Cancel] [Import project]          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Screen 2: Apprentice Mode, graph and forms

```text
┌ Lantern Story · Apprentice ─────────────────────────────────────────────┐
│ [Apprentice ▾] [Project settings] [Playtest] [Download ZIP] [Export]   │
├─────────────────┬──────────────────────────┬──────────────────────────┤
│ Scene outline   │ Navigation map            │ Scene inspector          │
│                 │                           │                          │
│ ▾ Scenes        │ [Entry: Market] ────────► │ Story text               │
│   Market        │         │                 │ [                       ]│
│   Alley         │         ▼                 │                          │
│                 │       [Alley]             │ Choices and commands    │
│ [+ Add scene]   │ [+ Add connection]        │ Conditions and effects  │
│                 │                           │ State, rules, dialogue   │
│                 │                           │ Scripts                  │
├─────────────────┴──────────────────────────┴──────────────────────────┤
│ Recovery: up to date · Diagnostics: 1 warning [Review]                 │
└─────────────────────────────────────────────────────────────────────────┘
```

The outline is the containment hierarchy; the map is player navigation. Selecting a scene opens its forms in the inspector. Provide labeled controls for adding a child scene and adding a navigation connection. Dragging is an optional shortcut. An empty graph offers **Add first scene**; a scene without outgoing navigation offers **Add connection**.

### Command form

Apprentice Mode supports bounded forms for choices and typed commands. A command form exposes the canonical pattern, aliases, typed parameters, condition/availability policy, navigation edge, and ordered effects. Show inline help that a placeholder occupies one input token. Quoted and multi-token captures are unsupported. Explain that patterns are normalized for matching, but the first pattern is only the canonical pattern and does not win an overlap.

```text
┌ Typed command ──────────────────────────────────────────────────────────┐
│ Canonical pattern  [count candles {count}                              ]│
│ Aliases            [                                                   ]│
│ Parameters         count · integer                                      │
│ Availability       [Always available ▾]                                 │
│ Effects            [+ Add effect]                                       │
│                                                                         │
│ Overlap with another command can make player input ambiguous.           │
└─────────────────────────────────────────────────────────────────────────┘
```

Different command IDs may overlap. That is a runtime ambiguity, not a model validation error. A duplicate or malformed pattern within one command is a validation error. The form must not resolve overlaps by priority or alias order.

### Time and typing-sound settings

**Project settings** exposes the Apprentice forms authorized for these settings:

```text
┌ Project settings ───────────────────────────────────────────────────────┐
│ Time                                                                   │
│ Advance time [Per accepted action ▾]                                    │
│ Milliseconds per accepted action [ 1000 ]                               │
│ Clock HUD [ ] Show game clock to the player                             │
│                                                                         │
│ Typing sounds                                                          │
│ Target [letters ▾]  WAV asset [birds.wav ▾]  Volume [────●──] 0.25     │
│ [+ Add mapping]                                                         │
│ Fallback [Silent ▾]                                                     │
│                                                                         │
│ Player saves                                                           │
│ [Enabled ☑] Slots [ 2 ] (1–10)  Location [Anywhere ▾]                   │
│ Checkpoint nodes [select…] (required for Checkpoint)                    │
└─────────────────────────────────────────────────────────────────────────┘
```

When time mode is **Per accepted action**, expose milliseconds per accepted action; the inactive-time policy is pause and the catch-up limit is zero. When time mode is **Elapsed**, expose **When the game page is hidden or the window is unfocused: Pause / Bounded catch-up**. If bounded catch-up is selected, require a positive maximum interval in milliseconds. **Show game clock to the player** controls the optional HUD. The same policy covers hidden and unfocused states.

A typing-sound mapping assigns a local WAV asset and a volume from 0 to 1 to either one standardized, case-sensitive keyboard code or a key group: letters, digits, space, punctuation, editing, or other. The form can add an exact key such as `Enter` or `KeyA`; an exact-key mapping takes precedence over a group mapping. Offer fallback **Silent** or **WAV asset + volume**. Volume 0 mutes that mapping; 1 applies no extra attenuation. Prevent duplicate targets and show missing/non-WAV assets as validation errors. Do not add an uncontracted master volume slider to the player.

**Player saves** exposes the `savePolicy`: disable saves, or enable 1–10 in-app slots and allow saves anywhere or at selected checkpoint nodes. Checkpoint mode requires at least one declared checkpoint. Explain that slot count controls in-app slots only; downloaded save ZIPs can still be copied.

### Script references in Apprentice

The **Scripts** section shows a named, noneditable reference with the declared script ID, language, path, and entrypoint, plus **Edit in Sage**. A standard Effects form may select a declared script for a `run-script` effect where the effect is allowed. Selecting the source never opens a visual script editor. Do not add a block editor for script statements or promise an author-authored script summary field.

## Screen 3: Sage Mode, files and script invocation

```text
┌ Lantern Story · Sage ───────────────────────────────────────────────────┐
│ [Sage ▾] [Playtest] [Download project ZIP] [Export game ZIP]            │
├─────────────────────┬────────────────────────────────┬─────────────────┤
│ Project files       │ Editor tabs                    │ Diagnostics     │
│                     │                                │                 │
│   project.json      │ world.json   scripts/keeper.js │ 1 error         │
│   world.json        │                                │ [Open location] │
│   locales/          │  "effects": [                 │                 │
│   scripts/          │    { "kind": "run-script",   │                 │
│   assets/           │      "scriptId": "keeper-check" }│              │
│   other files       │  ]                             │                 │
├─────────────────────┴────────────────────────────────┴─────────────────┤
│ Recovery: up to date · Modified tab marked with ●                       │
└─────────────────────────────────────────────────────────────────────────┘
```

Sage edits project files directly. `project.json` contains the author-controlled `gameVersion`. `world.json` contains the `randomness.mode` selector as `seeded` or `unseeded`; the contract defines no separate host entropy-provider selector. Script source is edited as JS, Lua, or Python text in its declared subset.

A script is invoked by adding a `run-script` effect to an allowed authored effect list: a choice, command, dialogue option, lifecycle effect, or rule. The effect names a declared script ID and invokes its zero-argument `main`. In Sage, this is an ordinary effect entry in `world.json`, for example:

```json
{ "kind": "run-script", "scriptId": "keeper-check" }
```

The script runs at that effect's position. A script cannot directly invoke another script. The source file remains separately visible in `scripts/`; source or compile errors link to its diagnostic location. The authoring UI does not execute the raw file merely because it is opened.

## Screen 4: Playtest and player controls

```text
┌ Lantern Story · Playtest ───────────────────────────────────────────────┐
│ [Return to editing] [Restart…]                       [Load save ZIP]   │
├───────────────────────────────────────────┬─────────────────────────────┤
│ Player                                    │ Debug                       │
│ Game clock: 02:00 (only when enabled)     │ Current scene: Market       │
│                                           │ State                       │
│ The market is closing...                 │ Trace                       │
│                                           │ random · unseeded · 2       │
│ [Ask the keeper]                          │ rule · reason: ...          │
│ [Leave for the alley]                     │ Diagnostics                 │
│                                           │                             │
│ Available patterns: count candles {count} │                             │
│ [Type a command…________________] [Send]  │                             │
└───────────────────────────────────────────┴─────────────────────────────┘
```

### Start and restart a seeded run

Starting a regular player session uses the host's configured seed source when the world is seeded and no seed override is supplied. The engine requests one uint32 seed. There is no promise that this value is unique or differs from a previous run. If the host source is missing or returns an invalid value, session creation returns `{ ok: false, diagnostics }`; it does not silently fall back to a clock value, a constant, or unseeded randomness.

The creator/playtester may expose an optional seed override in the **Start playtest** and **Restart** form. Leave it blank for the default host-source behavior. If entered, accept only an integer from 0 through 4,294,967,295; the supplied value bypasses the host source. In seeded mode, zero is normalized by the engine to `0x6d2b79f5`. Do not show the seed field for unseeded mode; the engine rejects a seed supplied to an unseeded session.

```text
┌ Start / restart playtest ───────────────────────────────────────────────┐
│ Randomness: Seeded (from world settings)                                │
│ Seed override (optional) [                         ]                    │
│ Leave blank to use the configured host seed source.                    │
│ Enter a uint32 value: 0–4,294,967,295.                                  │
│                                                                         │
│                         [Cancel] [Start new run]                        │
└─────────────────────────────────────────────────────────────────────────┘
```

If session creation fails, keep the playtest closed and show the returned `DiagnosticReport` in a blocking start dialog, including each diagnostic code and message; keep the same diagnostics available in the project's Diagnostics panel. For an invalid override, associate the message with the seed field. The contract examples include `DS-ENG-002` for a non-uint32 seed, `DS-ENG-001` when seeded mode has no valid supplied or host seed, and `DS-CLK-001` for an invalid start timestamp. No session is created on these failures.

In the creator's run/debug information, show the effective normalized **initial seed** (`randomInitialSeed`) and a **Copy seed** action. To reproduce a seeded run, start from the entry with that seed and repeat the same accepted action sequence against the same playable-content fingerprint and engine version. Restart without an override requests a value from the host source; the contract does not require that it differ from the prior seed. Loading a compatible save is different: it resumes the saved session, including its current PRNG state (`randomSeed`), so future draws continue from the saved point; it does not request a new start seed. Do not present the current PRNG state as the seed to reuse for a fresh run.

An unseeded save contains the ordered random outcomes and supports call-verified replay through the replay harness. The contracts do not define a player or creator UI for selecting a saved outcome log, supplying the matching action transcript, or displaying replay mismatch state. Do not label ordinary **Restart** as an unseeded replay feature.

Choices and typed commands may both be available. The command field submits the user's raw text as `command-text`; the player UI does not construct typed parameter maps. Show authored patterns as help, not as a promise of natural-language parsing. Keep submitted text available when no command matches or when it is ambiguous.

- **One match:** dispatch the matched command and converted captures as one action.
- **No match:** show a message next to the field, preserve the session snapshot and clock, and let the player edit the text.
- **Ambiguous:** say that the input matched multiple commands and that no action ran. List the matching IDs in the contract's sorted order with their canonical patterns; return focus to the command field. Do not choose a match or resolve ambiguity by priority.
- **Disabled match:** show the returned disabled reason and leave the snapshot unchanged.

The `Tavern at Dusk` fixture demonstrates these outcomes. `COUNT   CANDLES 3` matches `count-candles`; `count candles two` is no-match; `count candles 2` is ambiguous between `count-candles` and `count-candles-two` in that order. No-match and ambiguous input do not consume action time. If raw input is malformed UTF-16, exceeds 4,096 UTF-8 bytes or 1,024 Unicode scalar values, or normalizes to more than 128 tokens, show the returned invalid-input diagnostic beside the command field. Preserve the text for correction; never truncate it or match a prefix. Invalid input does not mutate state or time.

If the author enabled the clock HUD, show the projected clock. Elapsed-time behavior pauses or catches up by the configured maximum while the player page is hidden or unfocused. On return/resume, show the resulting time; do not advance the HUD independently of the engine. The debug trace can show the recorded randomness provider and outcome. The player cannot change the author's seeded/unseeded mode.

Typing-sound mappings and their per-target volumes are authored settings. The player uses the authored mapping and fallback. The 1B data model has no player-wide volume override; see contract gaps below.

For player saves, inspect the typed result's `ok` flag. On encode failure, show its `DiagnosticReport` beside the save action, do not offer a download, and keep the current session. The example size failure is `DS-SAVE-001`; its message explains that expanded `save.json` or the final ZIP exceeds 8 MiB. On decode failure, show the returned diagnostic beside the selected file in the load panel; `DS-SAVE-002` covers malformed or unsupported ZIP, size, JSON, schema, and reference errors. Keep the active session unchanged for every decode failure. Compatibility mismatches are checked only after decode succeeds and remain the separate blocking dialog below. A successful load resumes the saved session. If a runtime transition would exceed the session-size limit, or an unseeded action would exceed the random-outcome history limit, show the returned action diagnostic in Playtest Diagnostics and retain the pre-action snapshot, clock, and randomness state.

## Screen 5: Load a player save and show incompatibility

**Load save ZIP** opens a file chooser, decodes the selected save, then checks compatibility before replacing the active session. A typed decode failure appears beside the selected file in the load panel with the returned diagnostic code/message; no decoded value is installed, and the current session is unchanged. Only after decode succeeds does the app check compatibility. If incompatible, show the mismatching fields and saved/current values in a blocking dialog:

```text
┌ This save cannot be loaded in this game ─────────────────────────────────┐
│ Game version     Save 0.9.0      This game 1.0.0                        │
│ Content          Save sha256:…   This game sha256:…                     │
│                                                                         │
│ Version 1.0 does not migrate player saves. Your current session         │
│ has not been replaced.                                                  │
│                                                                         │
│                         [Choose another save] [Cancel]                 │
└─────────────────────────────────────────────────────────────────────────┘
```

`checkSaveCompatibility` returns the mismatching field keys, not a `DiagnosticReport`. Render those keys as field names and show saved/current values from the decoded save and compatibility target. Do not expect a diagnostic code/message for this result, offer **Load anyway**, or replace session state on mismatch. The `Tavern at Dusk` incompatible-save fixture differs by `gameVersion` only (`0.9.0` vs `1.0.0`). A malformed or unsupported save is a separate typed decode failure in the same load area; display the returned diagnostic code/message (the example uses `DS-SAVE-002`) and do not mislabel it as a version mismatch.

## Flow A: First story, no coding experience

1. Choose **New project**. Enter a title, default locale, and required game version; create the project.
2. In Apprentice Mode, add the first scene and write its title and story text. Confirm it is the entry scene.
3. Add a second scene and a navigation connection. Add a choice in the first scene's form.
4. If desired, add a typed command in **Choices and commands**. Enter a pattern and aliases, define token-sized typed parameters, and read the overlap/matching help.
5. In **Project settings**, choose per-action or elapsed time. For elapsed time, select pause or bounded catch-up for a hidden or unfocused page, set its maximum interval, and choose whether the player sees a clock HUD. Assign a key/group WAV and volume or leave the fallback silent.
6. Choose **Playtest**. Try the choice and enter a raw command. If a command is ambiguous, review the candidate IDs/patterns and edit the input; no action has been applied.
7. Review Diagnostics. Fix linked errors or download a project ZIP to keep the recoverable authoring source. Acknowledge any listed warning required for the selected deliberate action.
8. Choose **Export game ZIP** when ready. Review validation findings, acknowledge required warnings, and build/download the game.

## Flow B: Developer, Sage-first with a visual review

1. Create a project with an explicit initial game version or import a project ZIP. Open Sage Mode.
2. Edit `world.json` to select `settings.randomness.mode`; use `seeded` or `unseeded`. For a seeded playtest, leave the optional override blank to use the host's seed source, or enter a uint32 to reproduce a run. Record the normalized initial seed displayed in run information. Unseeded mode does not accept a seed override.
3. Edit the appropriate choice, command, dialogue, lifecycle, or rule effects to include a `run-script` effect naming a declared script. Open its `scripts/` file to edit the `main` source.
4. Switch to Apprentice Mode to review the graph and forms. A script reference remains noneditable there; **Edit in Sage** returns to its Sage file. A supported Effects form may select the declared script as an effect without exposing script statements.
5. In Apprentice project settings, configure time and optional clock HUD, then assign typing sounds and per-target volumes. Fix any diagnostics that link to a field or file.
6. Playtest choices and raw typed commands. Inspect trace reasons, randomness provider/outcome, and the effective initial seed. Reproduce seeded runs with the same initial seed and accepted action sequence. Test the fixture's no-match, ambiguous, and over-limit input results without expecting state or clock changes.
7. Use **Load save ZIP** to test a player save. A mismatch dialog lists the differing compatibility fields before any session replacement.
8. Download the project ZIP for authoring recovery. Export the game ZIP after resolving blocking diagnostics and acknowledging required warnings.

## Empty, loading, and error states

| Context | Empty or loading state | Error state and recovery |
| --- | --- | --- |
| Projects | No recent projects: show **New project** and **Import ZIP**. While importing, announce progress and prevent duplicate import. | Unsafe or unreadable ZIP: explain the reason, keep the current project open, and offer another file. |
| New project | Label title, locale, and required SemVer game-version fields. | Invalid game version: show the manifest validation message next to the field and in Diagnostics; retain the entered value. |
| Apprentice graph | No scenes: offer **Add first scene**. No selection: prompt to select/add. No outgoing navigation: offer **Add connection**. | Invalid field/reference: show inline feedback plus linked diagnostic; preserve entered data. |
| Command form | No commands: offer **Add command** and explain canonical pattern/alias fields. | Duplicate or malformed patterns within one command: validation diagnostic. A collision across command IDs is shown only when player input produces an ambiguous match. |
| Player command input | Keep the raw typed text visible while submitting. | Invalid UTF-16, over 4,096 UTF-8 bytes, over 1,024 Unicode scalar values, or over 128 normalized tokens: show invalid-input diagnostic at the field; do not truncate, match a prefix, mutate state, or advance time. |
| Sage editor | No file selected: prompt to select a file. Empty text file: show an editable buffer. | Invalid JSON/script: show file and source location in Diagnostics, preserve invalid bytes, and keep the last valid parsed project available where applicable. |
| Time settings | Show controls for selected time mode only; inactive-time choices are not relevant to per-action time. | Incompatible fields or catch-up bounds: show the validation error next to the setting and in Diagnostics. |
| Typing sounds | No mappings: explain that no key mapping is assigned. | Duplicate target, unresolved asset, or non-WAV asset: show a linked validation error. Fallback is explicit: silent or a WAV mapping with volume. |
| Player command input | Show available authored patterns if any. | No-match, ambiguous, or disabled resolution appears adjacent to the input. Preserve input; no-match/ambiguous/disabled do not mutate the snapshot. |
| Diagnostics | No findings: “No diagnostics.” Keep validation status non-modal during editing. | Link to field, file, entity, or source span when present. Distinguish action blockers from acknowledgment requirements. |
| Playtest | No trace yet: “No actions yet.” Clock HUD appears only when enabled. | A blocking play diagnostic prevents start and links to its source. Runtime/script failure shows its diagnostic and leaves the pre-action snapshot intact. |
| Playtest start / restart | For seeded mode, blank optional override uses the host seed source. A supplied uint32 bypasses it; show effective normalized initial seed in creator run info. Unseeded mode has no seed field. | On `{ ok: false }`, keep the playtest closed and show every returned diagnostic code/message in the start dialog and project Diagnostics. Link a supplied-seed error to the seed field. Contract examples: `DS-ENG-002` invalid seed, `DS-ENG-001` unavailable/invalid seeded source, `DS-CLK-001` invalid start timestamp. |
| Player save creation | Show enabled slot count and whether saves are allowed anywhere or at checkpoints. | More than 10 enabled slots or invalid checkpoint selection is an author validation error linked to Save settings. On encode `{ ok: false, operation: "encode" }`, show each returned diagnostic beside Save, do not offer a download, and preserve the run; `DS-SAVE-001` identifies size-limit failure. |
| Player save load | Ask for a save ZIP. | On decode `{ ok: false, operation: "decode" }`, show each returned diagnostic beside the selected file and preserve the active session; `DS-SAVE-002` covers malformed/unsupported/over-limit input. Only a successful decode proceeds to compatibility checks. Mismatch lists project ID, game version, engine version, and/or fingerprint; session remains unchanged. |
| Session limits | No special state until a relevant operation reaches a limit. | The 16,384th unseeded outcome may commit; a later draw fails its action atomically without truncating history. A transition that would exceed 8 MiB canonical session JSON fails and keeps the previous session. Show the returned action diagnostic in Playtest Diagnostics. |
| Recovery / project ZIP | Show current recovery status and deliberate ZIP download state. | Storage or download failure: do not claim a successful backup; keep the project open, retain dirty state, and offer retry. Invalid authored data remains project-ZIP recoverable. |
| Game export | Show progress, validation summary, and required warning acknowledgment. | A blocking export diagnostic shows its precise source and keeps project ZIP download available. Never silently skip broken content. |

A dismissible unsaved-work reminder appears after 10–15 minutes of unsaved work. Dismissing it hides the reminder only; it does not mark the project saved.

## Interaction inventory

| Control | Mode / user | Supported behavior and visible result |
| --- | --- | --- |
| Project title, locale, game version | Create / author | Create a manifest with the required author-controlled `gameVersion`; show SemVer validation. |
| Command pattern, aliases, parameters | Apprentice / author | Define canonical pattern, aliases, one-token typed captures, condition, and effects. Overlap across IDs is not given precedence. |
| Save policy | Apprentice / author | Disable saves or set 1–10 in-app slots; allow anywhere or require one or more checkpoint nodes. Out-of-range slot counts and invalid checkpoint references are linked validation errors. |
| `run-script` effect | Sage / author; bounded effect form in Apprentice | Invoke a declared script's zero-argument `main` from a supported effect list. Source stays editable only in Sage. |
| Randomness mode | Sage / author | Select `seeded` or `unseeded` in `world.json`; do not expose a host entropy-source selector. |
| Seed override and run seed | Creator / playtester | Optional seeded start/restart uint32 override; blank uses the configured host seed source. Show normalized initial seed for reproduction. Loading a save resumes current PRNG state. |
| Time mode and inactive policy | Apprentice / author | Select per-action or elapsed; for elapsed, pause or cap catch-up while hidden/unfocused; set optional HUD. |
| Typing-sound target, asset, volume | Apprentice / author | Assign exact key or key group to WAV and 0–1 volume; choose explicit silent or WAV fallback. |
| Raw command field | Player / playtester | Submit raw text; show unique match, no-match, ambiguity, or disabled reason. Ambiguous candidates are not auto-selected. |
| Diagnostics panel | Author / playtester | Show precise path/entity/source location, blocking action, and acknowledgment requirements separately. |
| Load save ZIP | Player / playtester | Decode then compare project ID, game version, engine version, and fingerprint before replacing session. Reject mismatch. |
| Save ZIP limits | Player / playtester | Enforce 8 MiB ZIP input, 8 MiB expanded save member, and 8 MiB canonical session JSON. On failure, preserve the current session and show an error at the save/load action. |
| Clock HUD | Player | Show engine-projected time only when the author enabled it. |

## Keyboard and focus behavior

- Keep a visible skip link to the work area, a clear focus indicator, and logical tab order through mode, diagnostics, and project actions.
- In Apprentice, Up/Down moves through the scene outline; Left/Right expands or collapses containment. Enter selects. The navigation map visits nodes and links by keyboard; labeled forms create links without requiring drag.
- In Sage, Up/Down moves among files, Left/Right expands/collapses folders, and Enter opens a file. Source editor diagnostics link to the relevant line when a source span exists.
- The raw command field is labeled and can be submitted with **Send** or Enter. On no-match/ambiguous/disabled result, keep the input text and focus available for correction; announce the result without moving focus unexpectedly.
- The settings forms expose keyboard-operable selectors, inputs, and sliders. State the current volume value textually; do not rely on color for validation or mode.
- Dialogs keep focus inside while open and return focus to the invoking control when closed. A save compatibility mismatch cannot be dismissed by a “load anyway” action.

## Contract gaps to resolve before promising these controls

1. **Save compatibility diagnostic mismatch.** `archive-save-fingerprint.md` says a compatibility mismatch rejects with a diagnostic, while `SaveCompatibilityResult` returns only mismatch keys. The UI can still identify each field and render saved/current values from the save and target, but the contract does not define a stable diagnostic code/message for this case.
2. **Unseeded replay controls.** Saved unseeded outcomes and a call-verified replay source/harness are defined. The current player/debugger interface contract does not define how a creator selects the outcome log and matching action transcript or how replay mismatch is presented.
3. **Player-wide typing-sound volume.** The contract supports author-configured per-target and fallback volumes, but no player-wide volume override or mute setting. The wireframe exposes assigned volumes in author settings and does not promise a player master slider.
4. **Script summary text.** A declared script has ID, language, path, and `main` entrypoint; the contract has no author-authored summary field. The Apprentice script card therefore shows only those declared details and an **Edit in Sage** link.
