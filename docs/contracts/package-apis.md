# Package names and public API ownership

All workspace packages use the `@dungeon-scrivener/` scope. A public API has one owner. Cross-package imports use the owner package's public entry point and model types from `@dungeon-scrivener/model`. Internal source paths are not public imports.

| Package | Public responsibility and API boundary |
| --- | --- |
| `@dungeon-scrivener/model` | Owns `packages/model/src/public-types.ts`, canonical schemas, structural validation, semantic reference diagnostics, migrations, contract types, and playable-content fingerprint computation. Types are the only implementation artifact in 1B. |
| `@dungeon-scrivener/vfs` | Owns byte-preserving project files, safe path index/edit operations, ZIP import/export, ZIP feature and extraction budgets, SHA-256 of managed assets. Public operations: `createSnapshot`, `readProjectZip`, `writeProjectZip`. |
| `@dungeon-scrivener/persistence` | Owns IndexedDB recovery only. Public operations: `loadRecovery`, `saveRecovery`, `clearRecovery`. It does not own deliberate project ZIP saves. |
| `@dungeon-scrivener/engine` | Owns immutable session state, validated effects, action dispatch, event/rule queue, node lifecycle, time and randomness, dialogue and inventory state. The package exposes `createGameEngine(host)`; the host always supplies a uint32 entropy source, which seeded worlds do not consume and unseeded worlds require. `createSession` initializes the complete resumable session from world settings, start seed, and host clock state. `matchCommandText` normalizes and resolves raw text; `dispatchPlayerInput` routes choices and raw command text through that matcher. `observeClock` accepts host clock/focus/visibility/resume inputs. Dispatch/clock transitions return a snapshot, ordered trace, and diagnostics. `getPlayerView` separately projects the manifest, world, locales, snapshot, and requested locale. |
| `@dungeon-scrivener/scripting` | Owns JS/Lua/Python subset frontends, IR validation, capability execution, and execution budgets. Public operations: `compileScript`, `validateScriptIr`, `executeScript`. It does not mutate model state directly. |
| `@dungeon-scrivener/markdown` | Owns Markdown parse, node-link/asset resolution, bounded node embeds, safe rich AST output, and diagnostics. Public operation: `renderMarkdown`. It does not return trusted raw HTML. |
| `@dungeon-scrivener/media` | Owns content-addressed asset lookup and static image/audio metadata. Public operations: `registerAsset`, `resolveAsset`. It does not edit or transcode media. |
| `@dungeon-scrivener/i18n` | Owns locale key resolution and default-locale fallback. Public operation: `resolveText`. It does not rewrite source strings. |
| `@dungeon-scrivener/player` | Owns accessible player UI over `PlayerView` and `PlayerInput`. It sends choice IDs or raw command text through `dispatchPlayerInput`; it does not construct converted command parameters, store session state, or mutate engine state. |
| `@dungeon-scrivener/player-save` | Owns session snapshot codec, save-slot policy enforcement, compatibility checks, and explicit save ZIP download/import. Public operations: `encodePlayerSave`, `decodePlayerSave`, `checkSaveCompatibility`. |
| `@dungeon-scrivener/exporter` | Owns portable game ZIP output from accepted model, IR, media, and player runtime artifacts. Public operation: `exportGame`. |
| `@dungeon-scrivener/sage` | Owns IDE/file-tree controller and text/binary editor integration. It does not own the VFS data representation. |
| `@dungeon-scrivener/apprentice` | Owns graph/form editing commands over model APIs. It does not own a separate project model or engine. |
| `@dungeon-scrivener/diagnostics` | Owns aggregation, path/entity linking, acknowledgment policy, and suggested fixes over diagnostics emitted by owner packages. Public operation: `collectDiagnostics`. |
| `@dungeon-scrivener/debugger` | Owns trace presentation and playtest controls. It reads engine trace data and submits explicitly labeled validated actions; it does not mutate state directly. |
| `@dungeon-scrivener/studio` | Owns the app shell and integration wiring in `apps/studio`. It composes package APIs and owns no duplicate model, parser, player-save codec, or VFS implementation. |

`packages/model/src/public-types.ts` defines the shared data types and initial signatures for model, VFS, engine, script compiler, and player-save boundaries. Engine snapshots contain every field required for portable save/resume. Transition trace records have a zero-based sequence per action and always include their source and reason. The additional operation names in this table are reserved public contracts; each owning package adds exact call types only within its task. A package may not introduce an overlapping API under another package name.

## Effect and state ownership

Script and UI callers submit `PlayerInput`, resolved `ActionInput`, or typed `Effect` requests. `ScriptEffect` excludes `run-script`, so scripts cannot recursively start scripts. The engine validates requests against the current world and applies state changes atomically within one top-level action. A requested effect is not evidence that state changed. `PlayerView` is a read-only projection produced by the engine. The VFS owns file bytes and paths, not world semantics. The model owns schema/reference diagnostics, not session state.
