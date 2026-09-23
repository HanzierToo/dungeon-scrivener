# Tavern at Dusk

A reference world for later model, engine, dialogue, inventory, time, localization, media, and script work. Its organizational node supplies shared defaults and rules to the taproom and cellar.

## Coverage map

- `tavern-hall` is nonvisitable and contains visitable `taproom` and `cellar`. Both children opt into inherited actions and rules.
- The inherited choice set and command set coexist. Commands include aliases and `ask about {topic}`, which captures one normalized token as a string.
- Mira and Rowan are separate entity speakers with typed entity state. Mira's conversation is interrupted by Rowan's, then resumed at `mira-after-return`.
- A two-minute time rule emits `midnight-chime`; the chime rule increases trust and emits `tavern-stir`; the final rule startles Rowan and increments `bell-echoes`.
- Rowan's secret and Mira's silver-key option require world `trust >= 1`. The cascade makes those responses available.
- The silver key is added to world inventory through a dialogue option. Returning to the taproom fires an inherited node-revisit rule and increments its `return-visits` state.
- Both locales include the same stable keys and the same locally managed PNG/WAV embeds.
- Three declared, unbound source examples use only the documented JavaScript, Lua, and Python syntax. They read state and have no effects.

## Initial session

```json
{
  "currentNodeId": "taproom",
  "world": {"trust": 0, "bell-rung": false, "bell-echoes": 0},
  "nodes": {"taproom": {"return-visits": 0}},
  "entities": {"keeper-mira": {"disposition": "welcoming"}, "cellar-rowan": {"disposition": "guarded"}},
  "nodeVisitCounts": {"taproom": 1},
  "activeDialogue": null,
  "interruptedDialogue": [],
  "gameTimeMilliseconds": 0,
  "randomSeed": 42017,
  "randomOutcomes": [],
  "inventory": []
}
```

The seed is fixed for reproducibility; this transcript does not invoke randomness. `activeDialogue` and `interruptedDialogue` are readable shorthand for active and resumable conversation contexts, not a serialized `SavedSessionState` object. The initial taproom visit count is one; `return-visits` counts only later returns. The world advances two minutes per accepted action.

## Expected action transcript

Each row gives the expected state after the accepted action and ordered semantic trace anchors. `→` denotes trace order. Anchors abbreviate fields from `TransitionTraceRecord`; engine-generated condition and effect-request detail may add records between them. These are future acceptance expectations, not captures from a running engine.

| Step | Input | Expected state after action | Expected trace anchors in order |
| --- | --- | --- | --- |
| 1 | Choice `wait-for-dusk` | At `taproom`; time `120000`; `trust=1`, `bell-rung=true`, `bell-echoes=1`; Rowan has tag `startled`; no inventory | `action(wait-for-dusk)` → `time(0 → 120000)` → `rule(clock-rings)` → `state(bell-rung:false → true)` → `event(midnight-chime)` → `rule(keeper-hears-chime)` → `state(trust:0 → 1)` → `event(tavern-stir)` → `rule(room-startles)` → `tag(cellar-rowan:startled)` → `state(bell-echoes:0 → 1)` |
| 2 | Choice `enter-cellar` | At `cellar`; time `240000`; `trust=1`, `return-visits=0`; no inventory | `action(enter-cellar)` → `node-transition(taproom → cellar)` → `time(120000 → 240000)` |
| 3 | Choice `return-to-taproom` | At `taproom`; time `360000`; `nodeVisitCounts.taproom=2`; `return-visits=1`; world state unchanged | `action(return-to-taproom)` → `node-transition(cellar → taproom)` → `rule(count-taproom-returns)` → `state(taproom.return-visits:0 → 1)` → `time(240000 → 360000)` |
| 4 | Command `  ASK   ABOUT   rain ` (captures `topic="rain"`) | At `taproom`; time `480000`; command capture is `rain`; state and inventory unchanged | `action(ask-about-topic)` → `command-capture(topic="rain")` → `time(360000 → 480000)` |
| 5 | Command `speak with Mira` (alias of `talk to Mira`) | At `taproom`; time `600000`; active `mira-story@mira-first`; world state unchanged; no inventory | `action(talk-to-mira)` → `effect(start-conversation:mira-story)` → `time(480000 → 600000)` |
| 6 | Dialogue option `interrupt-for-rowan` | At `taproom`; time `720000`; active `rowan-story@rowan-first`; suspended Mira context resumes at `mira-after-return`; `trust=1`; Rowan's `tell-secret` is available | `action(interrupt-for-rowan)` → `effect(interrupt:mira-story)` → `effect(start:rowan-story)` → `time(600000 → 720000)` |
| 7 | Dialogue option `tell-secret` | At `taproom`; time `840000`; active `rowan-story@rowan-secret`; world state and inventory unchanged | `action(tell-secret)` → `dialogue-line(rowan-first → rowan-secret)` → `time(720000 → 840000)` |
| 8 | Dialogue option `return-to-mira` | At `taproom`; time `960000`; active `mira-story@mira-after-return`; Rowan context completed; world state unchanged | `action(return-to-mira)` → `effect(resume-conversation:mira-story)` → `time(840000 → 960000)` |
| 9 | Dialogue option `claim-silver-key` | At `taproom`; time `1080000`; current line `mira-farewell`; inventory has one `silver-key`; world state unchanged | `action(claim-silver-key)` → `effect(add-item:world/silver-key/1)` → `inventory(+silver-key×1)` → `time(960000 → 1080000)` |

The timed cascade and node revisit occur on different actions so their expected trace paths are distinct. The conditional `tell-secret` option is hidden before `trust` reaches one; after the cascade, it is available when Rowan's first line is projected. The final transcript step stops at Mira's farewell line and makes no claim about how the runtime closes a conversation with no successor.

## Media bytes

- `assets/sha256/db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399` is the PNG from the accepted direct-open feasibility spike; SHA-256 is `db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399`.
- `assets/sha256/dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690` is its local WAV sample; SHA-256 is `dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690`.
