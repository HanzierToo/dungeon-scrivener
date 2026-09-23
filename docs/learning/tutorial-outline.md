# Tutorial outline: The Lantern at Low Bridge

## Teaching approach

The reader builds one story in small steps. Every lesson names the behavior the player can observe, explains the authoring idea in everyday language, then gives a small practice task. There are no copy-paste data files or language-specific code samples here. Exact document shapes, editor controls, and script spelling belong in the relevant accepted contracts and product UI documentation.

The story begins with three scenes and a single route:

**North Bank → Tollhouse → Beacon Tower**

A storm is approaching. The player finds a dry wick at the riverbank, meets Keeper Sela at the tollhouse, and helps Sela and apprentice Lio light the beacon. The route can grow over the lessons, but the setting and characters stay the same.

## 1. A path through three scenes

**Goal:** Make a beginning, middle, and ending that the player can reach.

**Explain:** A node holds a scene's identity and authored content. A navigation link says where the player may go. Organizing one node beneath another does not by itself create a playable route. A node can also be marked as a nonvisitable organizer.

**Work the story:** Create North Bank as the entry scene. Link it to Tollhouse, then link Tollhouse to Beacon Tower. Give each scene a short description. The tower scene ends the first draft. Keep the route linear so the author can confirm the basic story before adding choices.

**Practice:** Put a short title and a few sentences in each scene. Read the route aloud from beginning to end. Then group the scenes beneath a nonvisitable Bridge Region organizer. Confirm that this grouping has not added a new stop to the player's route.

**Check:** Starting at North Bank reaches the tower in the intended order. Renaming a scene's displayed title does not change which scene a navigation link targets.

## 2. Give the player ways to act

**Goal:** Offer a visible choice and a typed command in the same scene.

**Explain:** A choice is selected from the actions shown by the game. A typed command is text matched against a pattern the author supplied. A command can have aliases and typed parameters. It is not a natural-language parser, so the author should make the accepted forms clear.

**Work the story:** At Tollhouse, offer a choice to ask Sela about the beacon. Also allow a short typed command asking about the beacon, with one authored alternate wording. Both actions lead to Sela's explanation. Keep the option to continue toward the tower available as well.

**Practice:** Add one more command with a single-word target, such as asking about the bridge. Write down one input that should match and one that should not. Avoid relying on quoted phrases or an unspecified natural-language interpretation.

**Check:** The player can choose from the displayed actions or type a supported command. If two different commands would match the same input, validation reports the ambiguity instead of choosing one silently.

## 3. Remember a fact

**Goal:** Let a later scene depend on something the player did earlier.

**Explain:** State is a typed value the game remembers. A value has a scope: it may belong to the whole world, one scene, or one entity. Choose the narrowest scope that matches the meaning. The fact “the player has the dry wick” belongs to the story as a whole, while Sela's opinion of the player would belong to Sela. Types matter: a boolean is not interchangeable with the string “true” or the number one.

**Work the story:** The wick is visible on North Bank. Add a world-level yes/no fact for whether the player has picked it up. It starts as no. The “take the wick” choice changes it to yes. The prose can still describe the wick, but the state is what later actions check.

**Practice:** Add one fact that belongs only to the Tollhouse, such as whether its gate has been opened. Explain why it should not be stored as a world-wide fact if the player can leave and return.

**Check:** Picking up the wick changes one declared value of the intended type. Leaving and revisiting does not erase it unless an authored effect says to do so.

## 4. Respond to a condition

**Goal:** Show an action or response only when its requirement is met.

**Explain:** A condition reads the current game snapshot and answers yes or no. It does not change state. An effect changes state or requests another engine action. Keeping those jobs distinct makes it easier to understand why an option appeared and what happened after it was chosen. A false condition can hide an option or leave it visible but disabled, according to the author's choice.

**Work the story:** At Tollhouse, “Offer the dry wick” is available only when the wick fact is yes. If the player has not collected it, either hide this action or show it disabled with a short explanation. Choosing it when available sets a second fact, “beacon ready,” to yes. It does not make the option available merely by checking the condition.

**Practice:** Add an alternate line from Sela when the beacon is ready. Decide whether the unmet action should be hidden or disabled and make that behavior understandable in the scene text.

**Check:** Before the wick is collected, the offer is unavailable in the chosen way. After collecting it, the offer appears. Selecting the offer changes the beacon fact through an authored effect.

See [a complete before-and-after example](sample-lesson.md) for this lesson.

## 5. Write a conversation

**Goal:** Create an exchange with more than one speaker and a player response.

**Explain:** A conversation has its own stable identity and remembers where the exchange paused. Lines may have conditions; options may be hidden or disabled. Leaving during an exchange can interrupt it. Returning can resume the saved context rather than restarting from the first line. A character's attitude comes from authored state and rules, not automatic personality simulation.

**Work the story:** Sela explains why the beacon needs a dry wick. Lio interrupts to point out that the tower stairs are already filling with fog. If the player has the wick, offer a response that lets Sela accept help. If the player leaves to collect it, keep the conversation resumable. On return, continue from the interrupted context and make the newly available response clear.

**Practice:** Add one optional question for Lio. Give it a condition based on an authored fact, then choose whether an unmet question disappears or remains disabled.

**Check:** Both characters can speak. The player can interrupt by leaving and resume the conversation later. Conditional lines and options respond to authored state rather than an inferred character mood.

## 6. Let rules react over time

**Goal:** Use world time and an ordered rule to make the same route feel urgent.

**Explain:** Time may advance after accepted actions or by elapsed time. By default, elapsed time pauses while the tab is hidden or closed. Catch-up on return is an explicit option with a maximum interval. A rule listens for an authored event or lifecycle phase, checks a condition, and requests effects. Eligible rules run by priority and then author order. The engine records why each change happened and stops work that exceeds its finite budget.

**Work the story:** Make each accepted action advance the story clock by five minutes. When evening fog arrives, a rule changes the “fog at bridge” fact and adds a warning to the next scene. If several rules can react, give their priorities deliberate values and inspect the resulting trace during playtest.

**Practice:** Add a second response to the fog event, such as having Lio move the lantern indoors. Decide which response must happen first and why. Keep the rule chain small enough that a reader can follow it.

**Check:** A rejected action does not advance the action-based clock. The fog rule runs at its authored trigger, and the debug trace identifies the input, rule decision, and state change. A self-triggering cycle ends with a diagnostic rather than hanging the game.

## 7. Add a supported script

**Goal:** Know what scripts can add and where their boundary is.

**Explain:** Scripts are an advanced option, not a prerequisite for making a story. JavaScript, Lua, and Python sources are accepted only within their documented subsets. The three frontends compile supported source into one intermediate representation. The browser runtime executes that representation with the same limited engine capabilities. A script can read declared state, request validated effects, emit declared events, and use the documented random capabilities. It cannot directly write session state or access the DOM, browser storage, network, filesystem, arbitrary packages, or `eval`. Unsupported syntax produces a compile diagnostic instead of a best-effort translation.

**Work the story:** Describe a small tower signal behavior in plain language: read whether the beacon is ready; if it is, request the authored signal event; otherwise do nothing. Keep this behavior as a regular choice or rule unless the script genuinely makes it easier to maintain. When the language contract is accepted, add equivalent examples in the supported source languages and verify that each produces the same engine-visible result.

**Practice:** Before writing a script, ask whether the same behavior is easier to express with a condition and effect. If a script is justified, identify the state it reads and the exact effect or event it requests. Do not write code that assumes browser access.

**Check:** The example never changes state directly. Each accepted language version has the same intended result, and an unsupported construct is reported at its source location.

## 8. Package the game

**Goal:** Give another person a portable game they can open and play.

**Explain:** The project ZIP is the author's deliberate save and preserves project files. The exported game ZIP contains the playable game. A player save ZIP records a session and can be imported or downloaded through the game UI. These are separate files with different purposes. The exported game's `index.html` is intended to open directly from disk without a local server or runtime network request. The authoring website itself works offline after its first load.

**Work the story:** Resolve or acknowledge the diagnostics requested before export. Export the game, extract the ZIP, and open its `index.html`. Confirm the story begins at North Bank, the wick condition still behaves as expected, and local media does not depend on a hosted URL. Create a player save only if the game's save policy enables it. Import and download that save through the provided game controls.

**Practice:** Add a second locale key for Sela's warning and review how the project default locale is used when a translation is missing. Export once more and confirm the game remains playable without a network connection.

**Check:** The exported story uses the same project content and runtime behavior as preview. Project save, player save, and exported-game ZIP are not confused with one another. A save from incompatible playable content is rejected clearly.

## From Apprentice to Sage

Apprentice Mode is the visual graph and form editor over the project. Sage Mode is the file-tree IDE for direct inspection and editing. Use Apprentice while learning the story structure and common fields. Move to Sage when you need to inspect the project's actual files, review an advanced setting, or edit a supported script source.

A practical transition is:

1. Finish the three-scene route and a few state-driven actions in Apprentice.
2. Open the same project in Sage and locate the story data and any locale, media, or script files you have added.
3. Compare a scene's display title with its stable identity. The title is author-facing text; the stable identity is what links refer to.
4. Read one small, familiar piece of authored data before changing it. Make one deliberate edit, then use diagnostics to catch malformed content.
5. Return to Apprentice and confirm the same project still contains your work. Unknown or Sage-only source should remain intact even if Apprentice cannot visually edit it.

There is no separate “Sage copy” of a project. A mode switch must not discard opaque script or Markdown source, silently convert an unsupported construct, or change an ID just because its display title changed. Keep deliberate project ZIP saves as recovery points before broad manual edits.
