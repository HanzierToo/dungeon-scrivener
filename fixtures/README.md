# Reference fixtures

- [The Lantern Crossing](linear-three-nodes/README.md) is a minimal linear story with three nodes, schema version 1, game version 1.0.0, and seeded randomness.
- [Tavern at Dusk](tavern-at-dusk/README.md) covers inherited actions and rules, normalized typed commands, dialogue interruption/resume, conditional dialogue, inventory, elapsed time with bounded catch-up, seeded/unseeded selection, two locales, managed image/audio, local typing sounds, reachable JS/Lua/Python scripts, mutable entity tags, and compatible/incompatible player-save examples.

The action transcripts are semantic expectations for later engine acceptance work. They are not runtime captures. Run npm run check:contracts from the repository root to validate schemas, fixture JSON, cross-file references, media bytes, save compatibility expectations, and source syntax.
