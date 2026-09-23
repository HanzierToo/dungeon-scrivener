# Script source subset and common IR

Scripts are authored in JavaScript, Lua, or Python and compile to `schemas/script-ir.schema.json`. The exported game runs only the validated IR in the JavaScript capability runtime. It never evaluates original source. Syntax outside this document is a compile diagnostic; a frontend may not silently approximate it.

## Source and program structure

- Source is UTF-8 without a byte-order mark. JavaScript is parsed as an ECMAScript 2022 script, Lua as the Lua 5.3 grammar, and Python with the Python 3.12 grammar. Only the syntax listed below is accepted.
- A source contains top-level function declarations only. Exactly one zero-argument function named `main` is required. Other functions are named helpers with positional parameters. Nested functions, closures, function values, default parameters, keyword arguments, and duplicate function names are rejected.
- Identifiers are ASCII `[A-Za-z_][A-Za-z0-9_]{0,63}`. `api` and `len` are reserved.
- Top-level statements, assignments to undeclared names, variable shadowing/redeclaration, and writes to map/list members are rejected. A local may be assigned again only if it was declared mutable.
- Every local declaration has an initializer. `main` returns no value. Helpers return either one value or no value on every path; a no-value helper cannot be used in an expression.

## Statements

Accepted statements map to `declare-local`, `assign-local`, `if`, `while`, expression-call, and `return` IR nodes.

| Meaning | JavaScript | Lua | Python |
| --- | --- | --- | --- |
| Local declaration | `let x = expr;` or `const x = expr;` | `local x = expr` | `x = expr` |
| Assignment | `x = expr;` | `x = expr` after a local declaration | `x = expr` after a local declaration |
| Branch | `if (condition) { ... } else { ... }` | `if condition then ... elseif condition then ... else ... end` | `if condition:`, `elif condition:`, `else:` |
| Loop | `while (condition) { ... }` | `while condition do ... end` | `while condition:` |
| Helper | `function score(x) { ... }` | `local function score(x) ... end` | `def score(x):` |
| Return | `return;` or `return expr;` | `return` or `return expr` | `return` or `return expr` |

`for`, `repeat`, `break`, `continue`, `switch`, `match`, comprehensions, generators, exceptions, classes, decorators, imports, modules, annotations, and async constructs are unsupported. Python indentation must be consistent within a block. Lua global function declarations are rejected. JavaScript `var`, arrow functions, and destructuring are rejected.

## Expressions and value semantics

- Literals: finite decimal numbers, strings, and booleans. Null-like values (`null`, `nil`, `None`), `NaN`, infinities, BigInt, hexadecimal/binary/octal numbers, numeric separators, regular expressions, and template/f-string interpolation are rejected.
- Collections: JavaScript arrays and string-keyed object literals, Lua sequence or string-keyed table constructors, Python lists and string-keyed dictionaries. Mixed Lua array/map constructors, duplicate keys, tuple/set literals, spread, slicing, and collection mutation are rejected. Maps have no prototype. Collection values are immutable; local bindings may be reassigned.
- Indexing is read-only. JavaScript and Python arrays use zero-based indexes. Lua sequence tables use one-based source indexes, which the frontend converts to the same zero-based IR. Negative and non-integer indexes are rejected in every language. Maps use string keys.
- Arithmetic uses finite IEEE-754 binary64 values. Integer state fields must be safe integers. `+`, `-`, `*`, `/`, and `%` are allowed on numbers; a division or remainder by zero is a runtime diagnostic. Modulo is defined as `a - floor(a / b) * b`, so a non-zero result has the divisor's sign. Arithmetic that produces a non-finite number is a runtime diagnostic. Negative zero is normalized to zero.
- String concatenation is JavaScript/Python `+` when both operands are strings and Lua `..`. These forms compile to `concat`. Other mixed-type addition is rejected. Strings are Unicode scalar sequences, compared exactly, with no implicit normalization or coercion.
- Equality is strict and same-type: JavaScript `===`/`!==`, Lua `==`/`~=`, Python `==`/`!=`. Ordering operators apply to numbers only. Arrays/maps have no equality operation.
- Boolean operators are JavaScript `!`, `&&`, `||`; Lua/Python `not`, `and`, `or`. Operands must be booleans, operators short-circuit, and results are booleans. No language-specific truthiness is used. `if` and `while` conditions must evaluate to boolean.
- Operator precedence is the source language's normal precedence; each frontend emits explicit IR operators. Parentheses are allowed. Assignment expressions and comma expressions are rejected.
- String quotes may be single or double. Direct Unicode and escaped quote, backslash, newline, carriage return, and tab are accepted. Unicode escapes are accepted only when they resolve to a valid Unicode scalar value. Raw/byte strings, Lua long-bracket strings, and language-specific formatted strings are rejected.
- `len(value)` returns a collection's member count or a string's Unicode scalar count.

## Capability API

The only non-local name besides `len` is the fixed `api` capability object. Only these calls are accepted:

| Call | Signature | Meaning |
| --- | --- | --- |
| `api.read(scope, key)` | `StateScope × StateKey -> Scalar` | Read a declared world, node, or entity value. Missing/unknown values produce a runtime diagnostic. |
| `api.hasTag(entityId, tag)` | `EntityId × string -> boolean` | Read the entity's mutable session tag set, including authored initial tags. |
| `api.request(effect)` | `ScriptEffect -> void` | Submit one typed effect for engine validation. The script cannot write state directly or request `run-script`. |
| `api.emit(eventId, payload)` | `EventId × JSON object -> void` | Submit a declared event through the engine event queue. |
| `api.randomInt(min, max)` | safe integer × safe integer -> safe integer | Inclusive bounds, with `min <= max` and at most `2^32` possible values; seeded and unseeded draws use rejection sampling, with at most 64 raw uint32 draws per request. |
| `api.randomFloat()` | `void -> number` | Returns a uint32 divided by `2^32`, a binary64 value in `[0, 1)`; outcome is logged. |

`api.request` and `api.emit` are statement calls only. The scope argument uses the common record shape, for example `{"kind":"world"}` or `{"kind":"entity","ownerId":"traveler"}`. The frontends translate each language's map literal to this record. Capability results and effects are validated by the host engine. A script call has no DOM, storage, network, filesystem, clock, reflection, dynamic import, `eval`, or native package capability.

## Invocation, ordering, and atomicity

The model compiles each declared source to one `ScriptIR`. A `CompiledScriptBundle` may contain zero IRs. At `createSession(projectId, world, options)`, the engine validates that its bundle contains exactly one IR per `world.scripts` entry, with matching ID, source path, language, and entrypoint. Missing, duplicate, extra, or mismatched IR returns a failed `SessionCreationResult` with diagnostics and no snapshot. The engine receives the bundle and a `ScriptExecutorApi` at construction. Before each later `dispatchPlayerInput`, `observeClock`, or `dispatchAction`, it repeats the same check against the supplied world before any effects execute. If a later world changes the declared script set or metadata incompatibly, the transition returns the original snapshot and a diagnostic; a different world with identical script declarations is compatible for script execution. When a `run-script` effect is reached, in authored effect order, the engine selects the matching IR and synchronously calls `executeScript(ir, context)`. The context contains caller origin, clamped remaining limits, and capabilities bridged to the current provisional transaction. A successful call returns `{ ok: true, instructionsExecuted, trace }`; a script failure returns `{ ok: false, instructionsExecuted, diagnostic, trace }`. If a capability callback rejects an operation or exhausts a budget, it throws `ScriptCapabilityError` with a diagnostic; the executor catches it and returns the failure result. Unexpected exceptions escaping the executor are caught by the engine and converted to an executor diagnostic and failure trace. The scripting package never receives a mutable session snapshot.

`ScriptExecutionResult` is a discriminated `{ok:true, instructionsExecuted, trace}` or `{ok:false, instructionsExecuted, diagnostic, trace}` value. The executor catches runtime faults and returns the failure form; an unexpected thrown exception is caught by the engine and converted to a fatal script diagnostic. On success the engine verifies that the reported instruction count is an integer within the passed limit. A malformed result or count above the limit is an executor contract fault and rolls back the transaction. The engine appends executor trace records in activation order to the transition trace, assigning the enclosing action's sequence numbers. Script trace records mark activation start/end, capability calls and failures with source spans where available; they are bounded and do not emit one record per IR instruction.

Each `api.request` capability call is validated and applied to the private provisional state immediately, in source order, before the next script instruction. `api.read` and `api.hasTag` therefore observe earlier accepted requests in the same activation and action. `api.emit` validates the event and appends it to the shared FIFO queue; the engine does not drain that queue until the current authored effect list completes. Rules then run under the data-model priority and ordering contract. Script random capabilities call back into the engine's selected random provider and transaction state. A script cannot invoke another script through capabilities. A rule triggered by an emitted event may invoke the next script inline in that rule's effect list, within the same top-level action.

Every top-level choice, command, dialogue selection, lifecycle transition, clock observation that advances time, and resulting rule/event cascade is one transaction. Script requests and rule effects are visible to later effects in that provisional transaction. The full transaction commits only if every validation, script, rule, and budget check succeeds. A compile/runtime error, invalid capability request, or exceeded limit returns diagnostics and an error trace, discards the complete provisional transaction, and returns the original snapshot. This includes state, entity tags, inventory, time, rule guards, seeded RNG state, and saved unseeded outcomes. The host's external entropy source itself cannot be rolled back, so retrying a failed unseeded action can draw a different value.

Seeded random calls use the session PRNG and update its persisted current state only on commit. Unseeded calls use the engine host's injected uint32 entropy source; each accepted result is recorded with ordinal, source script ID, operation, bounds, and value. Saves persist the complete ordered unseeded history. Replay supplies these records in order and requires every request's ordinal, source script, operation, and bounds to match; missing, extra, or mismatched records fail replay and never substitute a fresh entropy draw. No seed is required or stored in unseeded mode.

## IR rules

- The IR carries the source language, source path, stable script ID, `main` entrypoint, helper functions, typed local/control-flow/expression/call nodes, and source spans on every node.
- Spans use 1-based line and Unicode-scalar column positions. Start is inclusive and end is exclusive. Tabs count as one source column.
- Helper calls target declared function IDs/names. Capability calls target the allowlist above. The IR validator rejects unknown call names and invalid state/effect payloads.
- Frontends may normalize syntax into common operators but must preserve source spans and reject constructs whose source meaning cannot be represented faithfully.
- A script execution is part of its enclosing engine transaction. A budget or validation failure produces a diagnostic and does not partially commit effects.

Cross-language semantic differences are limited to source spelling and array indexing noted above. The same IR value operations, strict booleans, number rules, map semantics, bounds, and capability behavior apply to all three.


## Typed command matching

Command patterns are authored in the world document; this rule is shared with the engine command matcher. Normalize patterns and input by Unicode NFC, trim leading/trailing Unicode White_Space, collapse each internal run of Unicode White_Space to one ASCII space, then apply locale-independent lowercase. The resulting tokens compare literally. The token count must match. A parameter placeholder is a whole token and captures exactly one token; quoted and multi-token values are unsupported.

String captures keep the normalized NFC spelling before case folding. Number captures use JSON decimal syntax, must be finite, and do not allow a leading plus, separators, hexadecimal, or surrounding tokens. Integer captures must be safe integers. Boolean captures accept true or false case-insensitively. Enum captures compare case-insensitively against declared values and return the declared value's spelling. A failed conversion does not match.

All matching command IDs are considered together. No match returns no-match. A match shared by different command IDs returns ambiguous and applies no state changes. Author order and canonical-versus-alias order do not resolve ambiguity. Patterns that become identical after normalization, repeated/missing/unused placeholders, and duplicate command IDs are model validation errors.
