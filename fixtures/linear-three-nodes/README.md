# The Lantern Crossing

A minimal three-node linear story for validating project structure, state effects, and navigation. The final node is the ending.

## Initial session

- Current node: `old-gate`
- World state: `lantern-lit = false`
- Game time: `0 ms`
- Initial random seed: `17` (no random operation is used)

## Expected action transcript

| Step | Input | Expected state after action | Expected trace anchors in order |
| --- | --- | --- | --- |
| 1 | Choice `open-gate` | Node `stone-bridge`; `lantern-lit = true`; time `1000 ms` | `action(open-gate)` → `state-change(world.lantern-lit: false → true)` → `node-transition(old-gate → stone-bridge)` → `time(0 → 1000)` |
| 2 | Choice `cross-bridge` | Node `lantern-house` (ending); `lantern-lit = true`; time `2000 ms` | `action(cross-bridge)` → `node-transition(stone-bridge → lantern-house)` → `time(1000 → 2000)` |

Trace anchors abbreviate `TransitionTraceRecord` fields. They describe required semantic events and ordering, not a runtime capture. The runtime is implemented in a later task.
