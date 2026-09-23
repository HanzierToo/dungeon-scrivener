# Learning guide glossary

**Action**. A choice or typed command the player can perform. An action may have conditions and effects.

**Apprentice Mode**. The visual graph and form editor for a project. It edits the same underlying project as Sage Mode.

**Asset**. A media file such as a static image or audio clip used by the project. Repeated references to the same managed content can share one stored binary.

**Condition**. A read-only check that returns true or false from the current game state or triggering event. It can control whether an action, line, or option is available.

**Containment**. The organization of nodes into a parent and child hierarchy. It is separate from the links the player follows.

**Conversation context**. The remembered place and history in a conversation, used when dialogue is interrupted and later resumed.

**Diagnostic**. A structured report about invalid, missing, unsupported, or risky authored content. It should point to the affected path or game element and explain the problem.

**Effect**. A validated request to change state or ask the engine to perform an operation. The engine applies effects; a script or UI does not write session state directly.

**Entity**. A generic world object with an identity, definition, fields, and tags. A character can be represented as an entity.

**Event**. A named occurrence with an optional declared payload. Rules can listen for events and add further work to the bounded event queue.

**Exported game ZIP**. The portable playable game package. Its extracted `index.html` is intended to open directly from disk without a local server.

**Locale key**. A stable text key whose translated values are stored in locale files. Missing values fall back to the project default locale and produce a diagnostic.

**Navigation link**. An authored connection that lets the player move from one node to another. Parent-child organization alone does not make a route.

**Node**. A stable-identity part of the story that can hold player-facing content, state, actions, lifecycle behavior, and references to other game data.

**Player save ZIP**. A portable snapshot of a play session. It is explicitly downloaded or imported and is distinct from both the author's project ZIP and the exported game ZIP.

**Project ZIP**. The author's deliberate portable project save. It preserves the project file tree, including unrelated files, even when some authored data is invalid.

**Rule**. Ordered authored logic triggered by an event or lifecycle phase. A rule can check a condition and request effects.

**Sage Mode**. The file-tree IDE for direct project inspection and editing, including supported script source. It works on the same project as Apprentice Mode.

**Scope**. The part of the world to which a state value belongs: the whole world, one node, or one entity.

**Script subset**. The documented portion of JavaScript, Lua, or Python accepted by a frontend. Unsupported source produces a diagnostic rather than being silently approximated.

**Script intermediate representation (IR)**. The common structured form produced from a supported script source and executed by the browser runtime with limited engine capabilities.

**Stable identifier**. A machine-facing identity that remains the same when display text or a title is renamed. References should use the identifier, not the human-readable label.

**State**. A typed value remembered by the game and stored at a declared scope.

**Typing sound**. Optional audio associated with player text appearing. It can be configured by key or key group, with volume controls.

**Visitable node**. A node that can be a player location. A nonvisitable node may organize other nodes without becoming a playable scene.
