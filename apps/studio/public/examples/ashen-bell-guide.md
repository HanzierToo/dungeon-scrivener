# The Ashen Bell

A flood is rising beneath a village with a silent warning bell. Your goal is to reach the bell chamber and decide how to warn people before dawn. This short example can be played from the Studio home page or opened as an editable project.

## What to notice

- The village square offers several routes. The map shows routes; choices make them available to the player.
- The archive ledger changes a world state value. The keeper responds to that state in dialogue.
- Showing the archive record to the keeper earns one bell key. Read her reply, then thank her to end the conversation. Asking again reminds you where to use the key.
- Type `talk to ferryman` at the ferry landing. A command can start dialogue without moving scenes. Ask about the bell and read his answer before thanking him.
- Entering the riverbank runs a node-entry rule that records that you saw the flood.
- Story text, choice labels, dialogue, and item names use locale keys. Open **World → Translations** in Apprentice to edit them.
- In the editable map, **The search** and **The crossing** are side branches that feed the central route to the keeper. **The bell** groups the finale. Their header arrows collapse those visual sections without changing the game.
- You can speak to the keeper before finding proof, leave to search the archive, and continue the conversation when you return.

## Endings, spoilers

**Ring the bell:** From the square, search the archive and read the marked ledger. Take the page to the keeper. Speak to her and show her the ledger to receive the key. Go through the flooded lane and tower to the chamber, then unlock and ring the bell.

**Warn the nearby houses:** Go to the keeper or straight toward the tower. At the bell chamber, leave the bell and warn who you can. This ending remains available without the key.

## Try editing the copy

Open an editable copy on the home page. Select a scene and change its story text in the Inspector. Add a new scene and connect it to a reachable one. Give a choice the new navigation link, then use Playtest to check both branches. Download a project ZIP to retain the editable version.
