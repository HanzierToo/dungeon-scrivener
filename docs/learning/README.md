# DungeonScrivener 1.0 learning guide

This guide teaches a first-time author how to build one small story, then shows how to move from the visual Apprentice workflow into Sage when direct file editing is useful.

## Status and example format

The story examples are descriptive lessons, not importable project files. They intentionally avoid JSON layouts and script code while the shared data and language contracts are being finalized. The names used for story places, characters, choices, and state are teaching labels. Once task 1B is accepted, replace this note with links to the exact contract references and add validated examples without changing the story behavior.

## Learning path

Follow the lessons in order. Each one extends **The Lantern at Low Bridge**, a single story about helping Keeper Sela and apprentice Lio relight a warning beacon before evening fog covers the bridge.

1. [A path through three scenes](tutorial-outline.md#1-a-path-through-three-scenes). Make a linear story from the North Bank to the Tollhouse and then the Beacon Tower.
2. [Give the player ways to act](tutorial-outline.md#2-give-the-player-ways-to-act). Add a choice and a typed command. Both may be offered in the same scene.
3. [Remember a fact](tutorial-outline.md#3-remember-a-fact). Track whether the player has a dry wick and learn where that state belongs.
4. [Respond to a condition](tutorial-outline.md#4-respond-to-a-condition). Offer a different response when the player has the wick.
5. [Write a conversation](tutorial-outline.md#5-write-a-conversation). Let Keeper Sela and Lio speak, give the player an option, and resume after an interruption.
6. [Let rules react over time](tutorial-outline.md#6-let-rules-react-over-time). Advance the clock on accepted actions and make a rule respond when fog arrives.
7. [Add a supported script](tutorial-outline.md#7-add-a-supported-script). Understand when a script helps and what its restricted capabilities mean.
8. [Package the game](tutorial-outline.md#8-package-the-game). Export a playable ZIP and distinguish it from project and player-save ZIPs.

The [worked sample lesson](sample-lesson.md) develops the wick state and conditional response in detail. The [reference manual contents](reference-manual-outline.md) are a separate lookup path for authors who already know the basics. The [glossary](glossary.md) defines the terms used throughout.

## Moving from Apprentice to Sage

Start in Apprentice Mode if arranging scenes and filling in forms is the clearest way to work. Open the same project in Sage Mode when you want to inspect or edit its files directly, understand an advanced setting, or work on a supported script. The two modes are views over the same project. Switching modes should preserve source that the visual editor does not understand; it is not a request to translate or simplify that source.

Use the [transition notes](tutorial-outline.md#from-apprentice-to-sage) after the first few lessons. Keep a deliberate project ZIP before a large direct edit, and use diagnostics to locate invalid authored data. A project remains saveable as a project ZIP even when some content needs repair.
