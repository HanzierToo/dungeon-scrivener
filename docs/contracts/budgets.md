# v1 input and execution budgets

Limits are inclusive maxima. Exceeding one produces a diagnostic naming the relevant project path, source span, or operation. Implementations must enforce byte and count limits before allocating or recursively processing the full input. Limits are contract values, not recommendations.

## Project ZIP and virtual files

| Limit | Maximum |
| --- | ---: |
| ZIP input bytes | 128 MiB |
| Total extracted file bytes | 256 MiB |
| One extracted file | 64 MiB |
| ZIP entries, including explicit directories | 20,000 |
| UTF-8 path bytes | 1,024 |
| One path segment's UTF-8 bytes | 255 |
| Structured JSON file bytes | 16 MiB |
| JSON nesting depth | 64 |
| Player-save ZIP input bytes | 8 MiB |

Supported ZIP members use `store` or `deflate`. Reject encryption, split volumes, Zip64 structures, symlinks/special files, unsupported compression, invalid UTF-8 names, CRC mismatch, duplicate/case-colliding paths, traversal, absolute paths, and total/entry budget overflow. ZIP output may use `store` or `deflate`. Directory entries are permitted. Do not trust declared sizes; compare actual inflate output as it is produced.

Validation and extraction run in a worker where supported, and are cancellable. Timeouts are 30 seconds per project import and 5 seconds per individual member. On timeout or failure, discard the partial snapshot and preserve the source ZIP for recovery/export. Do not rewrite file bytes or accepted path spelling.

Paths are relative, slash-separated Unicode strings. Reject empty segments, `.` or `..`, leading slash, backslash, colon, C0/C1 controls, trailing dot/space, Windows device names, and names that are not already NFC. Collision keys use NFC plus locale-independent lowercase. Preserve the original accepted UTF-8 path and bytes. Reserved structured paths are exactly `project.json`, `world.json`, `locales/<locale>.json`, `scripts/<relative path>`, `assets/sha256/<hex>`, and the optional referenced player CSS path. A case-insensitive collision with a reserved path is rejected.

## Script parser, IR, and execution

| Limit | Maximum |
| --- | ---: |
| UTF-8 source bytes per script | 128 KiB |
| Parsed syntax nodes | 10,000 |
| Function declarations | 256 |
| Parameters per function | 32 |
| Source/control nesting depth | 64 |
| Executed IR instructions per script activation | 50,000 |
| Iterations per individual `while` invocation | 1,000 |
| Script activations per top-level action | 256 |
| Aggregate executed IR instructions per top-level action | 250,000 |
| Script capability calls per top-level action | 10,000 |
| Raw uint32 draws per random integer request | 64 |
| Helper call depth | 16 |
| Members in one array or map | 1,024 |
| String value bytes | 16 KiB |
| Aggregate allocated string/collection bytes per activation | 1 MiB |
| Value nesting depth | 32 |
| Requested effects/events per action from scripts | 256 |

IR instruction fuel is shared across all helper calls in one activation. A nested while loop also consumes the total instruction budget. Every script activation reached directly or through an event/rule cascade counts toward both action-wide script limits. Every API request counts toward the per-action request limit. A limit breach aborts the containing action transaction, including effects already requested by any script or rule in that action. The failed transition returns the original snapshot plus diagnostics/error trace; none of its state, tags, inventory, time, rule guards, RNG state, or random outcomes commit. Requested-effect count includes api.request and api.emit calls, whether or not a later rule consumes the event.

The engine passes the executor `maxInstructions = min(50,000, remaining action instructions)`, as well as remaining action-wide capability-call, effect/event-request, and trace-record budgets. The executor stops before executing an instruction or emitting executor trace records beyond those values. The engine independently counts every `api.*` capability call (including reads, tag checks, random calls, requests and emits) and rejects call 10,001 synchronously. It adds each returned `instructionsExecuted` count to the action total and treats a negative, non-integer, or over-limit report, or a trace longer than its passed allowance, as a fatal executor contract violation. Effect/event requests are counted separately and rejected synchronously at request 257; the rejection fails the activation and rolls back the action. The 16,384th unseeded outcome may be committed; a later unseeded draw fails the action rather than omitting or truncating history. If neither entropy nor replay source is configured when an unseeded random call occurs, that action fails with a randomness diagnostic. All trace records, including script trace records, count toward the action cap of 20,000.

## Raw command input and matching

| Limit | Maximum |
| --- | ---: |
| Raw command UTF-8 bytes | 4,096 |
| Raw command Unicode scalar values | 1,024 |
| Normalized command tokens | 128 |
| Commands in the effective action set | 256 |
| Patterns per command | 32 |
| Parameters per command | 16 |
| Pattern UTF-8 bytes | 4,096 |
| Pattern tokens | 128 |
| Token comparisons per match operation | 1,048,576 |

Check UTF-16 validity and raw byte/scalar limits before normalization. Then NFC-normalize, collapse whitespace, and enforce normalized token limits. A boundary value is accepted. An over-limit or malformed Unicode input returns `invalid-input` with a diagnostic; it does not truncate text, match a prefix, advance time, or mutate the session. If a project exceeds the effective command, pattern, parameter, or matching-work bound, model validation rejects that action set and play is blocked until corrected.

## Session and player-save data

| Limit | Maximum |
| --- | ---: |
| Canonical serialized session JSON | 8 MiB |
| Expanded `save.json` member | 8 MiB |
| Player-save ZIP input | 8 MiB |
| JSON nesting depth | 64 |
| Unseeded random outcomes in one session | 16,384 |
| Inventory stacks in one session | 10,000 |
| Saved conversation contexts | 64 |
| Dialogue history IDs per context | 10,000 |
| Saved epoch timestamp | 0 through `Number.MAX_SAFE_INTEGER` milliseconds |
| Per-action game time | 0 through `Number.MAX_SAFE_INTEGER` milliseconds |

Before committing a session transition and before encoding a save, measure the canonical serialized session; exceeding 8 MiB fails the transition/save with a diagnostic and retains the old session. On import, reject an over-limit archive/member before replacing the active session. Do not truncate state, inventory, conversation history, seeded state, or random outcome history. When a collection limit is reached, the operation that would exceed it fails atomically. A save that cannot fit is a save failure; it is never reported as successful.

## Clock inputs

Clock input timestamps must be safe integers in the inclusive range 0 through `Number.MAX_SAFE_INTEGER`. `maxCatchUpMilliseconds` is at most 86,400,000 (one day). Repeated timestamps are valid no-op observations. A timestamp earlier than the persisted baseline is rejected with a clock diagnostic; it changes neither baseline nor game time, so the host may retry with a valid timestamp. Invalid visibility/focus values, invalid timestamps, arithmetic overflow, and invalid start baselines are rejected without mutating the session. Pause and bounded catch-up behavior still apply to valid large gaps; credited game time must remain within the safe-integer bound. Clock inputs are never coerced or clamped.

## Rules, conditions, and trace

| Limit | Maximum |
| --- | ---: |
| Condition tree nodes | 10,000 per condition |
| Rule executions | 10,000 per top-level action |
| Queued event occurrences | 1,000 per top-level action |
| Trace records | 20,000 per top-level action |
| Effects applied | 10,000 per top-level action |

Rules execute by descending numeric priority. Rules with equal priority execute in their authored array order. Inherited rule order is parent-before-child; each node retains local array order. Effects from a triggered rule append resulting events to the bounded queue. A budget breach stops rule processing and rolls back the action transaction with a cycle/budget diagnostic.

## Player saves and Markdown

Save archives contain one bounded stored/deflated ZIP with a single JSON session document. Their full input cap is 8 MiB; JSON nesting remains 64. Import never executes code from the save.

Markdown input is limited to 2 MiB UTF-8 per source node. Embed expansion is limited to depth 8, 128 expanded nodes, and 2 MiB of rendered text for one expansion. Link/embed resolution does not fetch network resources. Invalid or over-budget source remains unchanged.
