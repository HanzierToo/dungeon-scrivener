# Large-project authoring workflow

This note describes the local authoring behavior added after the v1.3 Apprentice redesign. It does not change the project, world, or locale file formats.

## Finding and editing content

- Apprentice World shows a directory of sections. One section mounts at a time, so a large inventory or rule set does not make unrelated forms slow or force a long scroll.
- Repeatable collections show up to 40 rows per page, a text filter, a count, and one selected editor. This applies to state definitions, actions, effects, rules, dialogue, actors, inventory, script declarations, and sound mappings. Nested collections use the same pattern where they can grow independently.
- Scene state overrides and rule assignments use the same bounded editor. State references can filter large key lists. Renaming a state field updates its authored condition and effect references and initial values together. A definition with live references cannot be deleted until those references are removed; the editor shows their paths. Scope changes are disabled while references or node overrides depend on the field.
- State renaming covers structured references in `world.json`. It cannot rewrite dynamically constructed key names in script source. Search those scripts in Sage before changing a key used by code.
- Translations list up to 40 keys per page and can filter keys that need text, are in use, or are unused. A newly added language starts with one authored translation. Missing translations fall back to the default language during play.
- The scene map can find a scene or folder by name or ID and center it. React Flow renders visible elements in the viewport. Its stored coordinates and graph semantics are unchanged.
- Sage Explorer indexes directory children for each snapshot. Quick open searches paths, while project text search runs in a worker and shows 50 results per page. It stops at 50 hits in a file or 1,000 total hits and asks for a narrower query. Open editor tabs keep their cursor and undo state. Sage and Studio reuse unchanged VFS file entries and parsed structured documents after edits.
- Studio diagnostics, Sage diagnostics, and Playtest traces show bounded result pages. Playtest's expensive trace inspection mounts when its panel opens. Checkpoints retain the immutable trace history by reference. Playtest state fields have a search control when the list grows.

## Folder links

A dashed containment edge is selectable. Select it and choose **Remove from folder** in Map tools, or use the edge's context menu. This moves the child to the top level and leaves the child and its navigation links intact. Undo and Redo include this operation.

## Scale boundaries

These controls bound the number of mounted rows and editors. They do not impose a new authoring limit. The VFS retains its existing per-file and total byte limits. Full world serialization, graph projection, validation, ZIP export, and Playtest session creation still process the whole project. Their cost will grow with project size. The search worker transfers one file at a time; very large individual text files may still take time to scan. A realistic long-form authoring session and assistive-technology review remain useful follow-up checks before claiming a production scale target.

## Local verification

Verified on the uncommitted `dc29502` checkout with the earlier v1.2 and v1.3 edits still present in the working tree:

- `npm run check`: 42 contract examples, 10 fixture documents, two fixtures, three syntax-only script parses, 29 test files, and 155 tests passed.
- `npm run build:studio`: TypeScript and production bundle passed. The existing React Flow directive and large-chunk warnings remain.
- `npm run test:e2e:export`: 9/9 passed across Chromium, Firefox, and WebKit.
- `npm run test:e2e:studio`: 68 passed across the three browsers, one accepted WebKit offline-reload skip. The browser coverage includes 160 scenes, 160 state fields, and 160 extra locale keys, folder-link removal with Undo and Redo, Sage search and editor continuity, state-key rename persistence, ZIP round trips, and Playtest trace filtering.
- `git diff --check`: passed.
