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
| Helper call depth | 16 |
| Members in one array or map | 1,024 |
| String value bytes | 16 KiB |
| Aggregate allocated string/collection bytes per activation | 1 MiB |
| Value nesting depth | 32 |
| Requested effects/events per action from scripts | 256 |

IR instruction fuel is shared across all helper calls in one activation. A nested while loop also consumes the total instruction budget. Every API request counts toward the per-action request limit. A limit breach aborts the containing action transaction, including effects already requested by that script activation.

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
