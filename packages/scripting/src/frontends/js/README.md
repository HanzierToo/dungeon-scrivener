# JavaScript frontend subset

`parseJavaScript(source, { scriptId, sourcePath })` parses source with Acorn in ECMAScript 2022 script mode and converts the accepted syntax to the shared `ScriptIR`. It never evaluates source. Diagnostics include the source path, 1-based line and Unicode-scalar column span, and a suggested supported example where one can clarify the fix.

Supported syntax follows `docs/contracts/script-subset.md`:

- Top-level `function` declarations only. `main()` is required and has no parameters; helpers accept positional identifier parameters.
- `let` and `const` declarations with one initialized identifier, local assignment using `=`, `if`/`else`, `while`, return, and expression statements for `api.request(...)` and `api.emit(...)`.
- Finite decimal, string, and boolean literals; arrays; explicit string-keyed object literals; computed read-only collection indexing; unary `!` and `-`; arithmetic, strict comparisons, and boolean operators.
- Calls to declared helper names, `len`, and the fixed `api.read`, `api.hasTag`, `api.request`, `api.emit`, `api.randomInt`, and `api.randomFloat` capabilities. The shared IR validator and runtime validate capability argument and effect values.

The frontend rejects, with the offending source span and a supported example, imports, top-level statements, `var`, arrow/nested/async/generator functions, destructuring, defaults, spread, templates, null-like and non-finite values, unsupported escapes, loose equality, assignment expressions, compound assignment, collection mutation, direct property traversal, computed capability lookup, optional chaining, arbitrary globals, `eval`, browser APIs, and unsupported statements or expressions.

`while` is bounded by the shared runtime budget of 1,000 iterations per loop invocation. A literal-`true` loop is rejected at compile time. Other conditions are evaluated by the executor and must stop within that runtime limit.
