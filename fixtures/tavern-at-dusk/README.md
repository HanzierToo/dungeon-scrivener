# Tavern at Dusk

A reference world for later model, engine, dialogue, inventory, time, localization, media, and script work. Its organizational node supplies shared defaults and rules to the taproom and cellar.

## Contract coverage

- project.json is authoritative for gameVersion 1.0.0. Both save examples copy this value; the legacy save uses 0.9.0 and must be rejected without replacing the active session.
- tavern-hall is nonvisitable and contains visitable taproom and cellar. Both children opt into inherited actions and rules.
- The inherited choices and typed commands coexist. Command patterns cover aliases, whitespace/case normalization, one-token string capture, and strict integer conversion. Invalid integer input is a no-match.
- Mira and Rowan are separate entity speakers with typed entity state. Mira's conversation is interrupted by Rowan's, then resumed. Conditional Rowan dialogue requires trust >= 1.
- The elapsed clock is host-driven. Hidden or unfocused intervals use bounded catch-up capped at 60000 ms; per-action inputs do not advance elapsed time.
- The clock-rings rule is reachable by the host resume input at the expected threshold. It runs the Lua echo-check script, which raises trust and emits midnight-chime. The keeper-hears-chime rule runs the JavaScript keeper-check script, which makes an unseeded integer draw from 1 through 3, adds that count to bell-echoes, and emits tavern-stir. The room-startles rule runs Python witness-check, reads the mutable tag set, and adds Rowan's startled tag if absent.
- All three source scripts are declared by world.json and reachable through actual rule effects. Script requests execute in order inside the enclosing atomic action. Any runtime/budget/validation failure leaves the original session and random log unchanged.
- Engine setup compiles all three declarations into one `CompiledScriptBundle`, verifies exact IDs/paths/languages/entrypoints against world.json, then calls `createGameEngine(host, bundle)` with the injected `ScriptExecutorApi`. The timed rule's `run-script(echo-check)` effect synchronously calls `executeScript` at its effect-list position. Later rules in the same cascade invoke `keeper-check` and `witness-check` through the same executor. The executor receives only IR, origin, bounded remaining limits, and capability callbacks; it does not receive or mutate a session snapshot.
- The sample save persists mutable entity tags, randomness mode/outcomes, elapsed time, and clock baseline. One save is compatible with gameVersion 1.0.0; the other differs only by author gameVersion and is incompatible.
- Both locales contain the same stable keys and locally managed PNG/WAV media. The world references the WAV as the letters typing sound at volume 0.25 and falls back to silence. Missing matching mappings use the declared fallback.
- The silver key is added to world inventory through Mira's dialogue option. Returning to the taproom fires an inherited node-revisit rule and increments its return-visits state.

## Initial session and clock baseline

World randomness is unseeded, so the host supplies an entropy source and no seed. The starting session has currentNodeId taproom, trust 0, bell-rung false, bell-echoes 0, return-visits 0, empty runtime tags, gameTimeMilliseconds 0, and no random outcomes. nodeVisitCounts.taproom begins at 1. Entity state starts with Mira disposition welcoming and Rowan disposition guarded.

For this transcript, create the session with wallClockEpochMilliseconds 1000000, visibility visible, and focused true. The persisted clock baseline is lastObservedEpochMilliseconds 1000000 and inactiveSinceEpochMilliseconds null.

## Expected host clock observations

| Input | Expected elapsed behavior and state | Trace anchors |
| --- | --- | --- |
| tick at 1060000, visible and focused | Add 60000 ms. The threshold is not reached. Save baseline becomes 1060000; inactive start remains null. | time(0 → 60000) |
| visibility-change at 1060000, hidden and unfocused | Add 0 ms. Save visibility hidden, focused false, last observation 1060000, inactive start 1060000. | clock(hidden, unfocused) |
| resume at 1360000, visible and focused | Hidden duration is 300000 ms. Add min(300000, 60000) = 60000 ms, reaching game time 120000. Set baseline to 1360000 and clear inactive start. Then the threshold rule cascade below runs atomically. | time(60000 → 120000) → rule(clock-rings) → state(bell-rung:false → true) → script(echo-check:lua) → state(trust:0 → 1) → event(midnight-chime) → rule(keeper-hears-chime) → script(keeper-check:javascript) → random(unseeded integer 1..3 → N) → state(bell-echoes:0 → N) → event(tavern-stir) → rule(room-startles) → script(witness-check:python) → tag(cellar-rowan:startled) |

Executor subtrace anchors for that cascade are `activation-start(echo-check)` → `capability-call(api.read)` → `capability-call(api.request)` → `capability-call(api.emit)` → `activation-end`; then the equivalent activation records for `keeper-check` (including `api.randomInt`) and `witness-check` (including `api.hasTag` and `api.request`). The engine assigns each imported record the next action-wide trace sequence. A failure in any activation emits `failure` plus a diagnostic and discards the whole clock/rule/script transaction, including time, tags, state, PRNG changes, and logged outcomes.

N is an integer from 1 through 3. The save sample records N = 2 to demonstrate one valid outcome. A real unseeded play may record any value in the inclusive range. Resume is treated as an inactive interval even when the persisted last-known flags were active, because a closed page may not send a final visibility event.

## Expected player-input transcript

The clock cascade above runs before these player inputs. Every row below leaves game time at 120000 ms because the world uses elapsed time and no later host clock observation is supplied.

| Step | Raw player input | Expected resolution and resulting state | Trace anchors |
| --- | --- | --- | --- |
| 1 | COUNT   CANDLES 3 | Match count-candles with strict integer capture count = 3; no authored effect. | command-capture(count=3) |
| 2 | count candles two | no-match because strict integer conversion fails; full snapshot is unchanged. | input(no-match) |
| 3 | count candles 2 | Ambiguous between count-candles and count-candles-two; IDs are returned in code-point order and no action runs. | input(ambiguous:[count-candles,count-candles-two]) |
| 4 |   ASK   ABOUT   RAiN   | Match alias of ask-about-topic; one string capture topic = RAiN, preserving NFC spelling and case. | command-capture(topic=RAiN) |
| 5 | Choice enter-cellar | Node changes from taproom to cellar. | node-transition(taproom → cellar) |
| 6 | Choice return-to-taproom | Node changes back to taproom; nodeVisitCounts.taproom = 2 and return-visits = 1. | node-transition(cellar → taproom) → rule(count-taproom-returns) → state(taproom.return-visits:0 → 1) |
| 7 | speak with Mira | Match alias of talk-to-mira; active conversation becomes mira-story at mira-first. | action(talk-to-mira) → effect(start-conversation:mira-story) |
| 8 | Choice interrupt-for-rowan | Active conversation becomes rowan-story at rowan-first; Mira is suspended at mira-after-return. | effect(interrupt:mira-story) → effect(start:rowan-story) |
| 9 | Dialogue option tell-secret | The trust >= 1 condition is true; Rowan advances to rowan-secret. | dialogue-line(rowan-first → rowan-secret) |
| 10 | Dialogue option return-to-mira | Mira resumes at mira-after-return; Rowan's conversation is complete. | effect(resume-conversation:mira-story) |
| 11 | Dialogue option claim-silver-key | Mira advances to mira-farewell; world inventory receives one silver-key. | effect(add-item:world/silver-key/1) → inventory(+silver-key×1) |

A no-match raw command and an ambiguous command both preserve the snapshot and consume no action time. Command ambiguities report unique command IDs in code-point order. This fixture has no ambiguous authored patterns because such collisions are model validation errors.

## Save examples

saves/compatible-save.json has projectId tavern-at-dusk, gameVersion 1.0.0, unseeded randomness, one representative random outcome, Rowan's persisted startled tag, game time 120000, a visible/focused clock baseline at 1360000, and the computed playable-content fingerprint.

saves/incompatible-game-version-save.json has the same compatibility fields except gameVersion 0.9.0. The compatibility expectation is rejected for gameVersion only. It is still structurally valid JSON and a structurally valid player-save document.

## Media bytes

- assets/sha256/db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399 is the PNG from the accepted direct-open feasibility spike. Its SHA-256 is db74122853c858b16bcc3b58363d3bdd89c38f9f720240626458f13c21219399.
- assets/sha256/dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690 is its local WAV sample and the typing-sound asset. Its SHA-256 is dadc41ce60b07eb817ef2b92628e664126cd877fcfb0628278e89bd7f9acb690.
