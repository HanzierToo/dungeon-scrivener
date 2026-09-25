# DungeonScrivener

DungeonScrivener is a local-first toolkit for making and playing single-player text adventures. **The Interpreter** is the browser-based authoring studio. **The Scribe** is the player used for hosted play and downloadable games. A project can contain branching scenes, typed commands, dialogue, state and rules, media, translations, and restricted scripts. Authoring projects, playable exports, and player saves are separate ZIP files.

This repository contains the Studio app, its TypeScript packages, example games, contracts, and tests. No account or hosted game service is required to develop locally. The accepted v1 data and API definitions are in [`docs/contracts/`](docs/contracts/README.md); the original [plan](DungeonScrivener-Agent-Prompts/DungeonScrivener-1.0-Plan.md) and [agent brief](DungeonScrivener-Agent-Prompts/00-MASTER.md) explain product intent and historical implementation handoffs.

## Run Studio locally

Use Node.js 24.19.0 from [`.nvmrc`](.nvmrc), or another supported Node.js version from 22.12 up to, but not including, 25. The repository pins npm 11.17.0 and accepts npm 10 or newer.

```sh
nvm use                         # if you use nvm
npm ci
npm run dev:studio
```

Open the local URL printed by Vite, normally `http://127.0.0.1:5173`. The dev command builds the player module that Studio imports before starting the server. Restart the dev command after changing the player runtime. `npm run build:studio` also creates that artifact automatically.

## Make a first game

1. Select **Create project**, enter a title and a semantic game version such as `1.0.0`, and open the starter story. You can also **Import project ZIP** to resume an existing authoring project.
   On your first new project in this browser, choose **Start tour** for a short guided look around the Studio, or **Not now** to go straight to work. The tour asks whether you prefer the visual Apprentice map or the file-based Sage editor. After the Studio tour, an optional **Game tutorial** teaches the steps of building a small game. Both can be replayed from the workspace header. Each mode also has a short **Tour this view** guide.
2. Start in **Apprentice** to arrange scenes on the map and edit the selected scene in the inspector. Drag a scene to move it. Drag from one scene’s bottom dot to another scene’s top dot to create a navigation edge, then assign that edge to a choice or command in the inspector so players can use it. Map positions are saved in the project ZIP. Switch to **Sage** to open `world.json` and work directly with the starter scenes, choices, and navigation edges. Its Explorer can show folders or flat paths and sort by name or type. Right-click a path for Rename or Delete, use tabs to move between files, and press Tab in the editor to indent. Changes in either mode belong to one project.
3. Choose **Playtest** to try scene choices and commands in an isolated session. Create a checkpoint to revisit a branch; open the inspection panels for state and engine traces or advanced inputs. Choose **Play** to see the terminal-styled reader interface. Fix blocking issues shown in **Project diagnostics** before exporting.
4. Choose **Download project ZIP** to keep an editable copy outside browser storage. Studio also keeps a local recovery copy and reminds you about unsaved work, but the ZIP is the deliberate portable authoring save.
5. Choose **Export game ZIP** to make a playable copy. Extract the ZIP and open its `index.html` directly in a supported browser. The optional README downloads beside the game ZIP.

The starter project has player saves disabled. When a game's `world.json` enables a valid save policy, **Save game** downloads a player-save ZIP and **Load game** imports one. A save must match the game's project ID, game version, engine version, and playable-content fingerprint.

For a small worked example, read [The Lantern Crossing](fixtures/linear-three-nodes/README.md). [Tavern at Dusk](fixtures/tavern-at-dusk/README.md) demonstrates commands, conversations, inventory, time, three script languages, locales, and media. The [learning guide](docs/learning/README.md) explains those concepts in sequence; its older implementation-status notes are historical, so use the current code and test results for verification claims.

## The three ZIP files

| File | Who uses it | What it contains |
| --- | --- | --- |
| **Project ZIP** | Author | The editable project file tree, including files the editor does not interpret. Import it back into Studio. |
| **Game ZIP** | Player | A portable game with `index.html`. Extract it before opening it. |
| **Player-save ZIP** | Player | One `player-save.json` session document. Download and import it through a compatible game's controls. It does not replace the project ZIP. |

The main project files are `project.json` for identity, version, and default locale; `world.json` for story and game behavior; `locales/*.json` for translated text; `scripts/*` for declared source; and `assets/sha256/*` for managed media. The project ZIP also retains unrelated files byte for byte. See the [archive and save contract](docs/contracts/archive-save-fingerprint.md) for the exact formats.

## Feature dictionary

| Term | Meaning in DungeonScrivener |
| --- | --- |
| **Sage / Apprentice** | Direct file editing / visual graph and form editing of the same project. |
| **Node / navigation edge** | A scene with a stable ID / an authored route between scenes. Parent-child organization is separate from navigation. |
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
```

The root `npm run typecheck` checks **only** `packages/model`. `npm run check:contracts` does not execute fixture scripts, game transitions, project ZIP import/export, or browsers.

For browser checks, install Playwright's browser binaries once if needed, then run the two suites with their own configurations:

```sh
npx playwright install chromium firefox webkit
npx playwright test tests/e2e/export/export.spec.ts --config=playwright.config.ts
npx playwright test --config=tests/e2e/studio/playwright.config.ts
```

The Studio suite builds and serves a production bundle. Browser results and remaining platform limitations should be reported separately from unit and contract checks. Historical candidate evidence is in [`docs/release/29C-evidence.md`](docs/release/29C-evidence.md); it is not approval for the current checkout.
