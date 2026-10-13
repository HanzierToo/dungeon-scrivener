# DungeonScrivener

DungeonScrivener is a local-first toolkit for making and playing single-player text adventures. **The Interpreter** is the browser-based authoring studio. **The Scribe** is the player used for hosted play and downloadable games. A project can contain branching scenes, typed commands, dialogue, state and rules, media, translations, and restricted scripts. Authoring projects, playable exports, and player saves are separate ZIP files.

This repository contains the Studio app, its TypeScript packages, example games, contracts, and tests. No account or hosted game service is required to develop locally. The accepted v1 data and API definitions are in [`docs/contracts/`](docs/contracts/README.md).

## Changelog

### v1.4, 2026-10-13

#### For players

- Scene responses can append to a running terminal transcript, replace its text, or restore the opening description. Looking around and inspecting objects can stay in one scene without repeated Return choices.
- New responses scroll into view inside a stable text panel. Long responses open at their beginning, command input keeps focus after submission, and text fills the panel's width. Scrollbars match the terminal palette.
- One action can have different results according to game state, including different descriptions, destinations, items, and other effects. Games can offer one button for an interaction whose outcome changes on repeat use.
- Translated appended passages change with the selected language and survive compatible game saves. Exported games expose their included languages in Settings and support the same scene-response behavior as Play.
- The home page includes **The Ashen Bell**, a complete playable example with inventory, dialogue, and two endings. Authors can open an editable copy to explore how it works.
- Portable startup supplies the engine's randomness sources, and save downloads retain their object URL long enough for the browser to receive the file.

#### For authors

- Apprentice creates a player choice or command together with its route. Existing actions can reuse routes, and route-only arrows can gain an action later. Destinations can be corrected directly; deleting a direct route retains its owning actions for repair, with Undo available.
- The map supports multiple selection, familiar pan/selection gestures, visual sections, and editable arrow centers. Selecting a route opens its source action; selecting a hidden action from a scene card opens the corresponding editor. Deselecting a scene clears the Inspector.
- **Conditional outcomes** checks named results in order and runs the first match. **Otherwise** supplies the fallback. Availability conditions still control whether the action is offered.
- **Scene text after this action** offers Keep, Replace, Append, and Restore for both ordinary results and conditional outcomes. Switching between Replace and Append retains drafted response text.
- Command phrases accept spaces, comma or `|` separators, and escaped literal separators. Captured input values have a structured editor and clearer help.
- One **Text / Translations** screen manages languages and key creation, renaming, editing, and deletion. Empty language files and projects using only literal text are supported.
- Diagnostics link to the relevant scene, action, collection, translation, or source and keep a stable panel height while checking. Notifications float above the page, dismiss automatically after three seconds, and have a dismiss button.
- New remembered values start as booleans. Incomplete accidental creations can be deleted when surviving references allow it. Sage file operations, recovery paths, and terminology/help have also been improved.

#### For developers

- `ChoiceDefinition` and `CommandDefinition` now accept optional `outcomes`. Each `ActionOutcome` has a condition, effects, and an optional route. Selection uses the input snapshot before action-start rules; the selected result is complete and does not also run fallback effects.
- `show-scene-text`, `append-scene-text`, and `reset-scene-text` are supported by the shared model/schema, engine, restricted script requests, and player projection. Failed action transactions roll back their text changes with the other effects.
- Optional saved `sceneText` stores the base description and ordered appended text sources. Existing saves without it remain valid. Each passage is localized and rendered independently so unfinished Markdown cannot absorb later output. Travel clears the current scene transcript.
- Map sections and route centers persist as editor layout metadata. Route references, translation traversal, and diagnostic navigation include conditional outcomes.
- Browser journeys cover editing, route correction/removal, conditional outcomes, scripted and translated responses, save restoration, and actual exported games. Recent targeted Chromium/Firefox checks passed for hosted/exported desktop/mobile terminal layouts; the prior export gate passed 9/9 across Chromium, Firefox, and WebKit. These focused results do not represent a fresh complete Studio matrix or native Safari/accessibility verification.

Earlier release notes are in the [changelog archive](changelog/README.md). Release names such as `v1.4` are Git commit/tag identifiers; npm package versions, document schema versions, engine compatibility versions, and authors' game versions are maintained separately.

## Run Studio locally

Use Node.js 24.19.0 from [`.nvmrc`](.nvmrc), or another supported Node.js version from 22.12 up to, but not including, 25. The repository pins npm 11.17.0 and accepts npm 10 or newer.

```sh
nvm use                         # if you use nvm
npm ci
npm run dev:studio
```

Open the local URL printed by Vite, normally `http://127.0.0.1:5173`. The dev command builds the player module that Studio imports before starting the server. Restart the dev command after changing the player runtime. `npm run build:studio` also creates that artifact automatically.

## Make a first game

1. Select **Create project**, enter a title and a semantic game version such as `1.0.0`, and open the starter story. Its first scene branches between the gate and watchtower. The watchtower demonstrates a typed `descend` command; the gate route demonstrates a state-changing choice. You can also **Import project ZIP** to resume an existing authoring project.
   On your first new project in this browser, a small nonmodal card offers **Start tour** for a guided look around the Studio or **Not now** to go straight to work. The tour asks whether you prefer the visual Apprentice map or the file-based Sage editor. After the Studio tour, an optional **Game tutorial** teaches the steps of building a small game. Both can be replayed from the workspace header. Each mode also has a short **Tour this view** guide.
2. Start in **Apprentice**. The small **Start here** card gives you a first experiment without taking over the screen. Drag empty canvas to select several boxes. Hold Shift or Command/Ctrl while dragging to pan, or use the Pan tool on touch. Drag boxes to arrange the map. Drag from a scene’s lower dot to another scene’s upper dot. A small prompt beside the map lets you name the player's clickable choice or typed command and creates its route together. Existing unbound actions can be attached there, and **Route only** is an advanced option for effects or rules that travel without a direct player action. Right-click a route-only arrow to add a player action later. The source box and arrow show the action. Select an arrow and drag its target endpoint to another scene, or use **Change destination…**. Click an action on its scene card to edit its destination locally. The source endpoint stays fixed. If a route already reaches the target, change the individual action destination to reuse it; the editor does not silently merge shared routes. A **logic folder** groups scenes for inherited actions and rules; drag from its lower dot to a box’s upper dot to set that relationship. A **section** is a visual background group that you can move, resize, and collapse. It never changes game logic. Right-click empty canvas to create a scene, logic folder, or section at that location. Removing a route keeps its choices and commands, including their text, conditions, and effects, and clears only their direct destinations. Deleting a scene removes that scene’s own actions but keeps actions owned elsewhere. References inside effects, rules, and dialogue must be repaired before their route can be removed. The confirmation names the affected actions, and Undo restores the whole edit. To delete the current start scene, first select another scene and use **Make start scene** in Map tools or its right-click menu. The Inspector separates **Scene**, **Actions**, **Text / Translations**, **Logic**, **World**, and **Scripts**; hover or focus its `?` buttons for help, resize its left edge, collapse it, or expand the workbench to full screen. Select a route label and drag it to bend the path around other scenes. Arrow keys move the selected center, and Home or double-click resets it. Map layout, including route centers, is saved in the project ZIP. Open **Text / Translations** to create, rename, edit, or delete keys used by scene text, choices, and dialogue. Language files may be empty. Assign a key to content in that scene or action’s editor. Switch to **Sage** to edit `world.json` directly. Use **Undo project edit** and **Redo project edit** for Inspector edits or file changes. History retains the latest 60 project snapshots during this session; it is separate from portable ZIP saves. Its Explorer can show folders or flat paths and sort by name or type. Right-click a path for its actions or right-click empty Explorer space to create at the project root. Use tabs to move between files, and press Tab in the editor to indent. Changes in either mode belong to one project.
3. Choose **Playtest** to try scene choices and commands in an isolated session. Create a checkpoint to revisit a branch; open the inspection panels for state and engine traces or advanced inputs. Choose **Play** to see the terminal-styled reader interface. Click an issue in **Project diagnostics** to open its scene, action, world collection, translation screen, or Sage source. Its fixed-height panel stays stable while checking edits. Fix blocking issues before exporting.
4. Choose **Download project ZIP** to keep an editable copy outside browser storage. Studio also keeps a local recovery copy and reminds you about unsaved work, but the ZIP is the deliberate portable authoring save.
5. Choose **Export game ZIP** to make a playable copy. Extract the ZIP and open its `index.html` directly in a supported browser. The optional README downloads beside the game ZIP.

For “look around” and similar interactions, add a choice or command and keep **Destination** at **Stay in this scene**. Under **Scene text after this action**, choose **Append to the description** to build a running transcript, **Replace the description** to show a new response, or **Restore the original description** to clear the transcript and show the opening text. The scene’s actions remain available. Use an availability condition to gate the action, or **Conditional outcomes** to choose a complete response and its other effects according to state. The first matching outcome runs; **Otherwise** runs when none match. Travel clears the scene transcript, and a compatible player save retains it.

Command phrases accept spaces, comma or `|` between alternatives, and `\,` / `\|` for literal separators. Optional input values are named placeholders such as `{item}` in `take {item}`; fixed phrases need none.

The starter project has player saves disabled. When a game's `world.json` enables a valid save policy, **Save game** downloads a player-save ZIP and **Load game** imports one. A save must match the game's project ID, game version, engine version, and playable-content fingerprint.

You can clear the starter story entirely in Apprentice. Select all map items and delete them, then add a new scene to establish a new start. Remove the starter state definition after removing any effects that reference it. In **Text / Translations**, select a key and choose **Delete key from all languages**. When the key is in use, Studio asks before replacing its references with the default-language text as literals; the other translations for that key are removed. Script source is not rewritten.

To see a complete story before editing one, choose **Play example** on the home page. **Open editable copy** loads The Ashen Bell into Apprentice with its state, dialogue, inventory, and two endings. Its [sample guide](apps/studio/public/examples/ashen-bell-guide.md) shows both paths. For a smaller worked example, read [The Lantern Crossing](fixtures/linear-three-nodes/README.md). [Tavern at Dusk](fixtures/tavern-at-dusk/README.md) is a contract fixture with commands, conversations, inventory, time, three script languages, locales, and media; Studio does not expose it as a home-page game. The [learning guide](docs/learning/README.md) explains those concepts in sequence.

## The three ZIP files

| File | Who uses it | What it contains |
| --- | --- | --- |
| **Project ZIP** | Author | The editable project file tree, including files the editor does not interpret. Import it back into Studio. |
| **Game ZIP** | Player | A portable game with `index.html`. Extract it before opening it. |
| **Player-save ZIP** | Player | One `save.json` session document. Download and import it through a compatible game's controls. It does not replace the project ZIP. |

The main project files are `project.json` for identity, version, and default locale; `world.json` for story and game behavior; `locales/*.json` for translated text; `scripts/*` for declared source; and `assets/sha256/*` for managed media. The project ZIP also retains unrelated files byte for byte. See the [archive and save contract](docs/contracts/archive-save-fingerprint.md) for the exact formats.

## Feature dictionary

| Term | Meaning in DungeonScrivener |
| --- | --- |
| **Sage / Apprentice** | Direct file editing / visual graph and form editing of the same project. |
| **Node / navigation edge** | A scene with a stable ID / an authored route between scenes. A route needs a choice, command, or effect to move a player; drawing a scene connection can create a choice and route together. Parent-child organization is separate from navigation. |
| **Choice / command** | A button the player selects / typed text matched against authored patterns and aliases. Both can be available together. |
| **State / condition / effect** | A typed remembered value / a read-only check / a validated request to change the session. |
| **Event / rule** | A named occurrence / ordered logic triggered by an event or game phase. Cascades have work limits and traceable reasons. |
| **Conversation / inventory** | Conditional, resumable dialogue / optional item stacks, quantities, containers, use, and equipment. |
| **Clock / randomness** | Per-action or elapsed game time / seeded reproducible draws or recorded unseeded outcomes. |
| **Script** | A declared JavaScript, Lua, or Python source file compiled from a documented subset into a shared restricted runtime. Unsupported syntax produces a diagnostic. |
| **Markdown / media / locale** | Safe formatted story text with stable-ID links and managed embeds / local images and audio / keyed translations with default-locale fallback. |
| **Diagnostic / playtest trace** | A specific validation or runtime finding / the ordered explanation of what an action read, requested, and changed. |

The [full glossary](docs/learning/glossary.md) defines more terms. The [data model](docs/contracts/data-model.md), [script subset](docs/contracts/script-subset.md), and [Markdown contract](docs/contracts/markdown.md) define the precise rules.

## Repository map

| Path | Responsibility |
| --- | --- |
| [`apps/studio/`](apps/studio/) | Authoring website and integration between packages. Start at `src/main.tsx` when tracing a UI flow. |
| [`packages/model/`](packages/model/) | Shared public types, schemas, project validation, and content fingerprints. |
| [`packages/engine/`](packages/engine/), [`packages/scripting/`](packages/scripting/) | Session transitions and bounded script compilation/execution. |
| [`packages/sage/`](packages/sage/), [`packages/apprentice/`](packages/apprentice/) | File editor and graph/form editor. |
| [`packages/player/`](packages/player/), [`packages/exporter/`](packages/exporter/) | Player UI, portable runtime artifact, and game ZIP creation. |
| [`packages/vfs/`](packages/vfs/), [`packages/persistence/`](packages/persistence/), [`packages/player-save/`](packages/player-save/) | Project files and ZIPs, browser recovery, and player-save ZIPs. |
| [`packages/markdown/`](packages/markdown/), [`packages/media/`](packages/media/), [`packages/i18n/`](packages/i18n/) | Safe story text, managed assets, and locale resolution. |
| [`packages/diagnostics/`](packages/diagnostics/), [`packages/debugger/`](packages/debugger/) | Aggregated findings and playtest inspection. |
| [`fixtures/`](fixtures/), [`tests/e2e/`](tests/e2e/) | Reference stories and browser acceptance checks. |

## Check a change

Run commands from the repository root:

```sh
npm run check:contracts     # schemas, examples, fixtures, references, and script syntax
npm test                    # focused package tests
npm run typecheck:studio    # integrated Studio typecheck; builds its portable prerequisite
npm run build:studio        # typecheck and production bundle
npm run test:e2e:ux         # focused UI/UX contract in Chromium and Firefox
```

The root `npm run typecheck` checks **only** `packages/model`. `npm run check:contracts` does not execute fixture scripts, game transitions, project ZIP import/export, or browsers.

For browser checks, install Playwright's browser binaries once if needed, then run the two suites with their own configurations:

```sh
npx playwright install chromium firefox webkit
npm run test:e2e:export
npm run test:e2e:studio
```

The Studio suite builds and serves a production bundle. Review complete authoring journeys, including correction, deletion, Undo, keyboard use, and ZIP round trips. Browser results and remaining platform limitations should be reported separately from unit and contract checks. The [v1.3 Apprentice evidence](docs/release/1.3-apprentice.md) records an earlier local matrix. The [v1.2 follow-up](docs/release/1.2-follow-up-evidence.md) and [29C](docs/release/29C-evidence.md) documents are historical evidence for earlier checkouts.

Choices and commands support **Conditional outcomes**: ordered requirements select one complete response/effects/destination result, with **Otherwise** as the fallback. This keeps first/repeat interactions and state-dependent travel or item rewards under one player action. See [the authoring guide](docs/learning/README.md#one-action-different-outcomes).

Use **Append to the description** for a running terminal passage. Earlier text remains above each new response; **Replace** clears it for a new display and **Restore** returns to the authored description. Conditional outcomes and scripts can append, and enabled player saves retain the current scene's output.
