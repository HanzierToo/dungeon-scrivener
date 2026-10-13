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

## Correcting and removing routes in Studio

Select an existing map arrow and drag its target endpoint to another scene, or use **Change destination…**. Its source stays fixed. Click a scene-card action to change only that action’s destination. If a destination already has a route, the action editor reuses it rather than silently merging shared routes.

**Remove route, keep actions** preserves the choice or command, its text, conditions, and effects. It clears the direct destination. The retained action remains on its source scene and can be reconnected there. Effects, rules, or dialogue that explicitly use the route must be repaired first. **Undo project edit** restores a whole edit; text editors keep their own native Undo.

The Inspector separates Scene, Actions, Text / Translations, Logic, World, and Scripts. In Actions, a localized choice has its default-language text beside the key. Download an editable project ZIP before sharing a separate exported game ZIP.

### Small interactions within a scene

A choice such as “Look at the table” can replace the current description without travelling. In Actions, leave its Destination at Stay in this scene and choose Scene text after this action → Replace the description. Add a condition if it should only be available in a particular state. Another action can Restore the original description. Leaving the scene resets the response, and saving the game keeps it.

Command phrases are complete words and phrases. Separate alternatives with a comma or `|`; escape a literal delimiter with a backslash. A placeholder such as `{item}` captures one word from player input and has an optional input-value definition. A command like “say help” needs no captured values.

## One action, different outcomes

Use Conditional outcomes when the same choice or typed command should do different things depending on game state. Name each outcome, choose its requirement, and author its response, effects, and optional destination. The first matching outcome runs. Otherwise runs when none match. Use Check earlier/later to decide precedence when conditions overlap.

For Open the drawer, an Already emptied outcome can check whether the player has the manual and display the empty-drawer response. Otherwise can give the manual and display the discovery text. For Attempt to stand, an Already tried outcome checks the remembered value and displays the repeat response. Otherwise sets that value and displays the first response. Keep the action's availability condition for deciding when the choice should appear.

Each result is complete: a conditional outcome does not also run Otherwise effects. Put shared consequences in each result that needs them. Predicates read the state before the action starts, so setting an Already tried value does not change the selected result midway.

## A running terminal passage

Choose Append to the description in an action's scene text response to keep the current text and print the new passage below it. Use it for inspection, dialogue-like replies, or command output that should remain readable without a Return choice. The scene's choices and commands stay available. Append also works inside Conditional outcomes, so first and repeat uses can add different passages.

Replace the description starts a new display and clears accumulated output. Restore the original description clears the display back to the authored scene text. Leaving the scene starts the destination's normal description. A game save retains the current scene's accumulated output when saves are enabled. Markdown and translation keys work for each passage independently.

Scripts can request `api.request({ kind: "append-scene-text", text: { kind: "literal", text: "The terminal hums quietly." } });`. The same transaction and rollback rules apply to append, replace, and restore.
