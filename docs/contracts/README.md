# DungeonScrivener v1 contracts

These contracts freeze the JSON document shapes and package boundaries for tasks after 1B. Schema documents use JSON Schema Draft 2020-12. The shared `common.schema.json` file only supplies `$defs`; each other `*.schema.json` file describes a versioned document.

## Contract set

- `schemas/project-manifest.schema.json`: `project.json`.
- `schemas/world.schema.json`: `world.json`, including nodes, separate navigation edges, entities, state, actions, rules, dialogue, inventory, time, and script references.
- `schemas/locale.schema.json`: `locales/*.json`.
- `schemas/script-ir.schema.json`: parsed source compiled to the shared interpreter representation.
- `schemas/diagnostics.schema.json`: stable diagnostic reports.
- `schemas/player-view.schema.json`: immutable render data consumed by player UI.
- `schemas/project-vfs.schema.json`: metadata index for an in-memory virtual file tree.
- `schemas/project-archive.schema.json`: validated metadata for a project ZIP. It is not an extra ZIP member.
- `schemas/save-policy.schema.json`: player save slot policy document. `world.json` carries the same policy fields inline.
- `schemas/player-save.schema.json`: portable player session payload inside a save ZIP.
- `schemas/content-fingerprint.schema.json`: digest input manifest and resulting digest.

Each document schema has a `.valid.json` and `.invalid.json` example under `examples/`. `npm run check:contracts` checks the examples against all schemas and verifies the example classifications. The Vitest suite remains empty at this task boundary.

Additional semantics are frozen in `data-model.md` and `archive-save-fingerprint.md`.

`npm run check:contracts` validates JSON Schema syntax/references and checks the expected accept/reject classification of the shape examples. It does not perform cross-file semantic validation, hash file contents, parse ZIP archives, or execute scripts.

## Common document rules

- All stable identifiers are lowercase ASCII kebab-case, 1 to 64 characters, beginning with a letter. They are immutable after creation. A renamed title does not change an ID.
- Every serialized document has a format tag and integer `schemaVersion`. v1 documents use value `1`.
- Structured objects reject unknown keys. Arbitrary files remain opaque VFS bytes and are not parsed or dropped by schema validation.
- String values and file bytes are preserved exactly. Validation does not normalize source bytes or rewrite author files.
- State values are strings, finite numbers, safe integers where an `integer` definition applies, booleans, or a declared enum value. There is no implicit string/number/boolean coercion.
- World, node, and entity are the only state scopes. An actor is an entity with authored tags and fields.
- JSON Schema validates local shape. Cross-file references, unique IDs, compatible value types, graph reachability, unique command matches, and file collisions are semantic validation owned by `@dungeon-scrivener/model`.

## Decisions carried forward

The user authorized starting 1B while the 1A Playwright WebKit navigation failure and incomplete Safari save-round-trip evidence remain recorded in `docs/feasibility.md`. This advances the implementation sequence; it does not change the direct-open product requirement or claim that WebKit's full flow was verified. Recheck the limitation before 19A script isolation and 28B exported-browser acceptance.

The current 1A result passes all recorded Playwright checks in Chromium and Firefox. Safari screenshots establish direct opening and local media loading only. Browser teams must not reinterpret the open 1A evidence as a broad claim that hostile code is harmless.

## Build and validation commands

```sh
npm ci
npm run check:contracts
npm run typecheck
npm test
```

Playwright configuration covers Chromium, Firefox, and WebKit. CI installs browser binaries only when `tests/e2e/` contains a spec; an empty E2E suite exits successfully.
