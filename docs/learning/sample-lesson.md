# Worked lesson: remember the dry wick

This lesson adds one remembered fact to **The Lantern at Low Bridge** and uses it to change what the player can do at Tollhouse. It is written in prose rather than schema or source syntax so the behavior can be taught before the project contracts are accepted.

## The story before the lesson

The player travels from North Bank to Tollhouse and then to Beacon Tower. At Tollhouse, Keeper Sela says the tower needs a dry wick before the beacon can be lit. The scene has no way to remember whether the player collected the wick.

| Moment | What the player sees before this lesson |
| --- | --- |
| North Bank | A dry wick is mentioned, but taking it has no recorded consequence. |
| Tollhouse | Sela gives the same response on every visit. The game cannot tell whether the player has the wick. |
| Beacon Tower | The story continues without checking whether the beacon can be prepared. |

The problem is not the prose. The game has no stored fact to connect the scenes.

## Add one typed fact

Add a world-level yes/no state value that means “the player has collected the dry wick.” Give it the starting value **no**. A yes/no value is a good fit because there are only two meaningful states. Do not store the words “yes” or “no” as text, and do not use a number for this fact.

At North Bank, make the choice to take the wick change the value to **yes**. The authored description can still say the player pockets it, but later conditions should read the state value rather than search for matching prose.

For this story, track one more yes/no fact: “the beacon is ready.” It begins as **no**. This separates finding the wick from delivering it to Sela.

| Story moment | Has the wick | Beacon ready |
| --- | --- | --- |
| Story begins | No | No |
| Player takes the wick at North Bank | Yes | No |
| Player offers it to Sela | Yes | Yes |

These are teaching names and values, not a serialized data example.

## Add the condition and response

At Tollhouse, add an “Offer the dry wick” action. Its condition reads the saved has-the-wick value. Choose one of two clear behaviors when the condition is false:

- **Hide it:** players who have not taken the wick do not see the offer.
- **Disable it:** show the offer as unavailable and add a short explanation such as “Find a dry wick first.”

When the available action is selected, an authored effect changes the beacon-ready value to **yes**. Sela then thanks the player and directs them to the tower. The condition itself only reads; the effect performs the change.

The next time the story checks for entry to Beacon Tower, it can use the beacon-ready fact to show the appropriate scene response or make an authored route available. Do not make the route appear merely because the condition was checked.

## Player behavior after the lesson

| Moment | What the player sees after this lesson |
| --- | --- |
| Story begins | The wick action is available at North Bank. At Tollhouse, the offer is hidden or clearly disabled because the player has not collected it. |
| Player takes the wick | The game remembers that the player has it. Leaving North Bank does not erase the fact. |
| Player returns to Tollhouse | The offer is now available. Choosing it makes the beacon ready and changes Sela's response. |
| Player reaches Beacon Tower | The authored scene can acknowledge that the wick is ready. |

## Walk through it

1. Start at North Bank. Confirm both facts are no.
2. Travel to Tollhouse without taking the wick. Confirm the offer is unavailable in the chosen way.
3. Return to North Bank, take the wick, then travel to Tollhouse again.
4. Confirm the offer is now available. Select it and confirm the beacon-ready fact changes to yes.
5. Continue to the tower and confirm its response matches the prepared beacon.

The route back to North Bank is a teaching addition. If the initial story has no return route, the author can test the first pass by restarting after adding the pickup action.

## What this teaches

- State records a fact that must survive movement between scenes.
- A declared type should match the fact's meaning.
- The scope should match how broadly the fact matters.
- A condition decides whether something is available; an effect changes the game.
- A visible disabled option needs a useful explanation.
- Later scenes can use the same remembered state without reading or rewriting the player's earlier prose.
