# Script IR validation and execution limits

`validateScriptIR` accepts serialized v1 `ScriptIR` only. It checks the closed node set, exact object fields, source-path and source-span bounds, declared functions and locals, capability names and arities, statically visible value types, and the limits that can be checked before execution. A failed validation returns diagnostics; executors must not run that IR.

## Values and evaluation

- Runtime values are finite binary64 numbers, Unicode strings, booleans, immutable arrays, and immutable string-keyed maps. Null is not a script value. Indexing reads an array, string, or map and never writes through it.
- Unary and binary operators use the common IR operator names. `and` and `or` short-circuit and require booleans. Equality is strict and same-type. Ordering is numeric. `concat` requires strings. Arithmetic overflow, division or modulo by zero, invalid indexes, and non-finite results fail the activation.
- A local declaration evaluates its initializer before binding the name. Assignments replace only mutable local bindings and must retain their value kind. Branches use the selected body. A helper call creates a parameter scope and returns to its caller; `return` exits the current function. `main` returns no value.
- A capability call invokes only the corresponding host-provided callback. `api.request` and `api.emit` are statement-only calls. They do not mutate host state directly; the engine validates and applies requests within its transaction.
- All operations are synchronous. The IR contains no host object references, property traversal, imports, implicit names, async operations, or direct state-write opcode.

## Budget enforcement

The exported `SCRIPT_IR_LIMITS` values mirror `docs/contracts/budgets.md`. Validation rejects excess functions, parameters, syntax nodes, nesting, literal string bytes, and collection members. Execution must enforce limits that depend on actual control flow or runtime values:

- Each statement and expression evaluation consumes one instruction before it runs. The 50,000-instruction activation limit is shared by all helper calls.
- Each individual `while` invocation may complete at most 1,000 body iterations. Check the condition again after iteration 1,000; if it remains true, fail before starting iteration 1,001. This bounds every loop, including loops whose termination depends on capability results. A literal `true` condition is also rejected statically.
- Helper calls share the activation budget and may reach depth 16. Fail before entering depth 17. Recursive helpers are allowed only within this depth limit.
- Every allocated string or collection member counts toward a 1 MiB activation allocation budget. String values are at most 16 KiB in UTF-8; arrays and maps contain at most 1,024 members; value nesting is at most 32.
- Engine capability calls and requested effects/events are additionally subject to the action-wide limits in `docs/contracts/budgets.md`. An executor must stop on a breached limit and return a diagnostic with the nearest IR source span.

The validator is deterministic and does not execute or mutate its input. The executor remains responsible for dynamic type checks, actual allocation accounting, loop and call fuel, and capability-result validation.
