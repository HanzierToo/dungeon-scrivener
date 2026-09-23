# Shared data model and execution ordering

## Identifiers and values

Stable IDs are ASCII lowercase kebab-case, 1-64 characters, starting with a letter. IDs are references, not names. Display text may change without changing an ID. Script local names use ASCII identifiers and are a separate namespace.

A locale tag uses the syntax in the common schema and is resolved by exact tag, then the project's default locale. Missing keys produce a diagnostic and visible key fallback. No source text is rewritten.

A scalar is a string, finite number, or boolean. Integer-typed values must be safe integers. Enum values are strings from the declared set. Validation uses exact types with no coercion. State comparisons require both operands to have the same declared value type; ordering operators apply only to numbers. Equality and inequality apply to scalar values.

## Project and world documents

`project.json` is the project identity and default-locale manifest. `world.json` is the game model. Both are independent schema-versioned documents. The world has one `entryNodeId`, node containment through `parentId`, and player navigation through separate `navigationEdges`. A node with `parentId: null` is a containment root. Containment cycles, duplicate IDs, unresolved references, and a nonvisitable entry node are semantic errors.

A node's `parentId` organizes it. It does not make the parent navigable. `visitable: false` marks an organizational node. Navigation only follows an authored navigation edge or an explicit `navigate` effect naming that edge.

`TextSource` is either literal text or a locale key. Locale lookup never changes the stored source. Raw text is valid even when no locale key is used.

## State, entities, events, and effects

State is scoped to the world, one node, or one entity. `StateReference` always names both a scope and a key. `world.stateDefinitions` declares typed world and node state keys; `EntityDefinition.fields` declares typed state keys for entities of that definition. `worldState`, `NodeDefinition.state`, and `EntityInstance.state` provide initial values; omitted declared keys use their definition default. Extra or mistyped values are semantic errors. Entity tags are separate from state and are queried with `has-tag` or `api.hasTag`.

Conditions are pure reads. `all`, `any`, and `not` compose conditions; `compare-state` reads a declared state key; `has-tag`, `at-node`, `event-is`, and `time-at-least` inspect the current snapshot or triggering event. Conditions do not mutate state.

Effects are requests handled by the engine reducer. `set-state`, `increment-state`, tag changes, event emission, navigation, inventory changes, and conversation control are the complete v1 effect union. The reducer validates every target and value before commit. A failed action rolls back all state changes and requested effects from that action. No UI or script mutates session state directly. Each transition returns ordered trace records; each record carries a sequence, source, and reason, and state-change records identify their state target and before/after values.

An event definition declares its payload fields and types. Each occurrence carries one event ID, JSON payload, and source reason. Event payload validation checks required declared fields and rejects unknown or mistyped fields. The event queue is FIFO. Rule effects that emit events append occurrences to its tail.

A rule listens to one event ID or one lifecycle phase. Eligible rules run by descending priority, with equal-priority rules in authored array order. Inherited rules run parent before child; each node retains its own array order. A rule condition is evaluated against the snapshot and triggering event for that rule activation. Cascades stop at the limits in `budgets.md`; a limit failure rolls back the enclosing action.

## Nodes and actions

The node hierarchy is independent of navigation. `inheritance.defaults` and `inheritance.rules` opt into inheritance from the parent chain. If either flag is omitted, it is false. World-level `actionDefaults` are the baseline. For each action category independently, inherited parent configuration is applied first, then the node's present category replaces that category. An empty array explicitly disables a category. Choices and typed commands may both be available.

Choice and command conditions determine whether the action is available. A false condition hides the action by default; `falsePolicy: "disable"` keeps it visible and disabled. Commands carry an ordered `patterns` array: the first is canonical and following patterns are aliases. Each placeholder such as `{target}` must name one declared parameter and occupies one whole input token. A command may also carry a navigation edge and ordered effects.

Command matching normalizes both authored patterns and user input to Unicode NFC, trims leading and trailing Unicode White_Space, collapses each internal run of Unicode White_Space to one ASCII space, and applies locale-independent lowercase before literal comparison. Token boundaries are the normalized ASCII spaces. Matching requires the same token count. A placeholder captures exactly one token; quoted phrases and multi-token captures are not supported. String captures preserve their normalized spelling. Number captures use JSON decimal syntax `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?` and must be finite. Integer captures must also be safe integers. Boolean captures are `true` or `false`, case-insensitively. Enum captures compare case-insensitively to a declared value and return its declared spelling. A capture that fails conversion does not match. If no command matches, the engine reports no match. If different command IDs match, it reports ambiguity and changes no state; it never selects by author order.

The `patterns` array order only identifies the canonical pattern; it does not give matching precedence over another command. Repeated patterns after normalization, placeholders that are missing/unused/duplicated, type-invalid patterns, and duplicate command IDs are semantic validation errors.

## Lifecycle and time

Entry, revisit, and exit lifecycle effects use one of `every-time`, `first-time`, or `once-per-playthrough`. `first-time` runs on the first visit. `once-per-playthrough` runs only once in the session even if the node is revisited. Rule guards and visit counts are session state and are included in player saves.

Per-action time adds the positive `millisecondsPerAction` after each accepted action. Elapsed time uses a wall-clock source supplied by the host. `pause` discards elapsed wall time while hidden or closed; `bounded-catch-up` adds no more than `maxCatchUpMilliseconds` on return. Visibility/closure time is not itself serialized as game time. `showClockHud` controls whether a clock projection is included in `PlayerView`.

## Player view and diagnostics

`PlayerView` is a read-only snapshot projection. It contains resolved locale strings, safe Markdown AST, available choices and commands, optional dialogue/inventory/clock sections, and compact diagnostic summaries. The safe AST never contains trusted raw HTML.

Diagnostic codes are stable identifiers in the form `DS-<AREA>-<NUMBER>`. `blocks` names behavior that cannot proceed. `acknowledgementRequired` separately names the user actions that require acknowledging a warning. A blocking action and an acknowledgment are distinct controls; severity alone does not imply either.
