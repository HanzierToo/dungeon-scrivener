# Python frontend subset

`parsePython(source, { scriptId, sourcePath })` parses source with the pinned Lezer Python grammar and compiles it to the shared `ScriptIR`. It never runs Python. Diagnostics use a 1-based line and Unicode-scalar column and include a supported example.

Supported syntax is deliberately small: top-level synchronous `def` functions, required zero-argument `main`, helpers with positional identifier parameters, initialized local assignment, local reassignment, `if`/`else`, bounded `while`, `return`, expression statements for `api.request(...)` and `api.emit(...)`, finite numeric/string/boolean literals, list and string-keyed dict literals, read-only indexing, unary `not` and `-`, numeric arithmetic and ordering, same-type equality, boolean `and`/`or`, helper calls, `len`, and the fixed `api.read`, `api.hasTag`, `api.request`, `api.emit`, `api.randomInt`, and `api.randomFloat` capabilities.

Semantics map to the IR rather than Python's full runtime:

- Indentation uses spaces only, with consistent indentation width within each suite. Tabs, mixed indentation, indentation changes within a suite, and empty suites are rejected. A simple statement occupies one line; semicolons, continuations, and compound one-line suites are unsupported.
- `None` is rejected because the common IR has no null value. `True` and `False` are supported. Conditions and `not`/`and`/`or` operands must be booleans; Python's truthiness and operand-returning `and`/`or` are not used.
- Integers must be exactly representable safe integers (absolute value at most 2^53-1). Floats and arithmetic results must be finite IEEE-754 binary64 values. Division by zero, modulo by zero, overflow, and mixed-type arithmetic fail. `/` and `//` both produce the IR's binary64 numeric result; `%` is supported only when divisor is nonzero. There is no arbitrary-precision integer behavior.
- Lists map to immutable IR arrays; dicts map to immutable string-keyed IR maps. Dict keys must be string literals and unique. Tuples, sets, comprehensions, generators, mutation, slices, and iteration are unsupported. Index reads use numeric indexes for lists/strings and string keys for maps.
- Helpers are synchronous and share the IR's call-depth and instruction budgets. `while` loops share the runtime limit of 1,000 iterations per invocation; literal-true loops are rejected statically.

Imports, decorators, classes, lambdas, async, annotations, defaults, keyword arguments, unpacking, comprehensions, generators, introspection, attribute traversal (except the fixed `api` capability namespace), arbitrary calls, implicit globals, and any syntax outside this list are rejected with a source location and example. No Python runtime is needed or emitted by exported games.
