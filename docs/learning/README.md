# DungeonScrivener 1.0 learning guide

This guide follows a beginner from a three-scene game into state, commands, conversations, rules, time, scripts, and portability. It uses the repository's two reference fixtures for concrete names and behaviors.

## Learning path

1. [Build a three-node route](tutorial-outline.md#1-build-a-three-node-route) from **The Lantern Crossing**.
2. [Offer choices and typed commands](tutorial-outline.md#2-offer-choices-and-typed-commands), including normalized input and ambiguity, from **Tavern at Dusk**.
3. [Store typed state](tutorial-outline.md#3-store-typed-state) at world, node, and entity scope.
4. [Use conditions](tutorial-outline.md#4-use-conditions) to control dialogue options.
5. [Interrupt and resume conversations](tutorial-outline.md#5-interrupt-and-resume-conversations).
6. [Connect rules to time](tutorial-outline.md#6-connect-rules-to-time), distinguishing action time from host-observed elapsed time.
7. [Read and request effects with scripts](tutorial-outline.md#7-read-and-request-effects-with-scripts) in JavaScript, Lua, and Python.
8. [Understand saves and export boundaries](tutorial-outline.md#8-understand-saves-and-export-boundaries).

The [worked lesson](sample-lesson.md) traces the Tavern clock, rule, script, tag, and conditional-dialogue chain. The [reference manual contents](reference-manual-outline.md) are a lookup path; the [glossary](glossary.md) defines contract terms.

## Contract and fixture references

- [Project manifest schema](../contracts/schemas/project-manifest.schema.json), [world schema](../contracts/schemas/world.schema.json), [locale schema](../contracts/schemas/locale.schema.json), [script IR schema](../contracts/schemas/script-ir.schema.json), and [player-save schema](../contracts/schemas/player-save.schema.json).
- [Data model and execution ordering](../contracts/data-model.md), [script subset and capability API](../contracts/script-subset.md), [execution budgets](../contracts/budgets.md), [archive and save compatibility](../contracts/archive-save-fingerprint.md), and [schema versioning](../contracts/versioning.md).
- [The Lantern Crossing fixture](../../fixtures/linear-three-nodes/README.md), its [project manifest](../../fixtures/linear-three-nodes/project.json), and [world document](../../fixtures/linear-three-nodes/world.json).
- [Tavern at Dusk fixture](../../fixtures/tavern-at-dusk/README.md), its [world document](../../fixtures/tavern-at-dusk/world.json), [JavaScript script](../../fixtures/tavern-at-dusk/scripts/keeper.js), [Lua script](../../fixtures/tavern-at-dusk/scripts/echo.lua), [Python script](../../fixtures/tavern-at-dusk/scripts/witness.py), and [save payload examples](../../fixtures/tavern-at-dusk/saves/).

## What the repository check establishes

From the repository root, `npm run check:contracts` validates the schema examples and fixture JSON, fixture references, media hashes, selected save compatibility facts, and selected raw-command matching outcomes. It parses each fixture script with its source-language parser. It does not compile scripts to the restricted IR, execute scripts or game transitions, verify the expected trace transcripts, import project ZIPs, create or import player-save ZIPs, or verify browser export behavior. Fixture READMEs label their action transcripts as semantic expectations, not runtime captures.

The narrative exercises in the tutorial are explanations. When a behavior is tied to a fixture, the relevant fixture path is linked above and in that lesson. A JSON fixture document being checked does not by itself prove that an application can import or play it.

Direct-open export remains a product requirement, not a verified result of the contract check. The [feasibility record](../feasibility.md) still has Playwright WebKit failing before the main file loads and only partial Safari screenshot evidence for the full action/save flow.

## Moving from Apprentice to Sage

Apprentice Mode is the visual graph and form editor. Sage Mode is the file-tree IDE. The contract gives both modes the same project files. Start with Apprentice for graph and form edits, then open the same project in Sage when you want to inspect structured files or edit a supported script. Switching modes must preserve unknown Markdown and script source; it does not translate unsupported source into a different language. See the [transition notes](tutorial-outline.md#from-apprentice-to-sage).
