# Worked lesson: why Rowan tells the secret after the chime

This lesson traces a real example from [Tavern at Dusk](../../fixtures/tavern-at-dusk/README.md). It follows the checked fixture documents and its expected transcript. The repository check does not execute the rules or scripts, so the before-and-after states below describe the fixture's intended behavior, not a captured engine run.

## The condition

Dialogue option `tell-secret` in conversation `rowan-story` has a `compare-state` condition on world integer `trust`: the option requires `trust >= 1`. The Tavern world defines `trust` with default `0`, and the initial session starts with `trust: 0`. The condition is false at the start, so the default false policy hides the option.

The condition only reads state. It does not raise trust. The change comes from a rule and a script reached by the host clock.

## Before the clock threshold

The Tavern world uses elapsed time with `hiddenBehavior: "bounded-catch-up"` and `maxCatchUpMilliseconds: 60000`. It does not add time for player choices or typed commands. The host reports clock observations through `observeClock`.

At the fixture's start, the world state includes `trust = 0`, `bell-rung = false`, and `bell-echoes = 0`. Rowan's `startled` tag is absent from the mutable session tag set. At this point, the condition for `tell-secret` is false.

## Reach the threshold

The [expected clock transcript](../../fixtures/tavern-at-dusk/README.md#expected-host-clock-observations) uses these observations:

1. At epoch millisecond `1060000`, the host reports an active tick. Elapsed game time increases from `0` to `60000`.
2. At `1060000`, the host reports the page hidden and unfocused. No more time is added at that observation. This begins an inactive interval.
3. At `1360000`, the host reports resume. The inactive duration is `300000` ms, but catch-up is capped at `60000` ms. Game time advances from `60000` to `120000`.

The host, rather than a script or browser global, supplies these observations. The engine stores the clock baseline and activity flags in `clockState`, including in a player-save snapshot.

## Follow the rule and script cascade

At `120000` ms, rule `clock-rings` is triggered by `time-advanced`. Its condition checks the threshold and that `bell-rung` is still false. In authored effect order it sets `bell-rung` to true, then runs declared script `echo-check`.

The [Lua source](../../fixtures/tavern-at-dusk/scripts/echo.lua) reads world `trust`, requests a validated `set-state` effect that adds one, and emits `midnight-chime`. The emitted event enters the FIFO queue. After the current effect list finishes, rule `keeper-hears-chime` runs the [JavaScript source](../../fixtures/tavern-at-dusk/scripts/keeper.js). That script draws an unseeded integer from 1 through 3, requests an increment to `bell-echoes`, and emits `tavern-stir`. Rule `room-startles` then runs the [Python source](../../fixtures/tavern-at-dusk/scripts/witness.py). It reads Rowan's mutable tag set with `api.hasTag`; when `startled` is absent, it requests an `add-tag` effect.

Each script runs through an authored `run-script` effect. Script capability calls are validated and applied to the provisional transaction in source order. An event is queued; it does not interrupt the rest of the current effect list. If compilation, execution, effect validation, or a budget check fails, the whole top-level action is rolled back, including the clock advance, state, tag changes, RNG state, and saved unseeded outcomes.

## After the cascade

| Value | Before resume | After expected resume cascade |
| --- | ---: | ---: |
| Game time | 60000 ms | 120000 ms |
| World `trust` | 0 | 1 |
| World `bell-rung` | false | true |
| World `bell-echoes` | 0 | An integer from 1 through 3; the save example records 2 |
| `cellar-rowan` mutable tags | no `startled` tag | includes `startled` |
| Rowan option `tell-secret` | hidden because `trust < 1` | condition true because `trust >= 1` |

The expected transcript then selects `tell-secret` and advances Rowan's conversation. The state change makes the option condition true; the condition did not cause the state change.

## What `npm run check:contracts` verifies

The command validates the fixture JSON, IDs and references, save payload fields, tag declarations in saves, content fingerprint, and selected command resolutions. It parses the three source files with their JavaScript, Lua, and Python parsers. It does not compile these sources to the restricted IR, execute the scripts or event cascade, compare the expected trace anchors with runtime output, or verify clock transitions in an engine. Do not describe this lesson as a runtime-validated playthrough.
