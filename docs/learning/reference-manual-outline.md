# Reference manual contents

The tutorial teaches one story from first scene to export. The reference manual should answer precise questions without requiring a reader to repeat that path. Add exact field names, accepted values, and links to frozen contracts only after task 1B is accepted.

## 1. Project basics

- Create, open, recover, import, and deliberately save a project.
- Project manifest, default locale, schema version, and stable identifiers.
- Project file tree and the difference between structured author data and opaque files.
- Byte preservation, safe paths, ZIP limits, and what a project ZIP retains.

## 2. World and player actions

- Node identity, displayed title, content, containment, visitability, and navigation links.
- Entry, revisit, and exit behavior, including every-time, first-time, and once-per-playthrough policies.
- World defaults, node overrides, parent inheritance, and disabling an action category.
- Choice availability, disabled versus hidden behavior, and typed commands.
- Command patterns, aliases, parameters, normalization, ambiguity, and no-match responses.

## 3. State and rules

- Supported scalar types, defaults, exact type matching, and world/node/entity scopes.
- Entity definitions, instances, tags, fields, and actor terminology.
- Conditions, effects, events, event payloads, and validated state changes.
- Rule triggers, priority, author order, inheritance, queue behavior, finite budgets, rollback, and trace reasons.
- Debugging a missing choice, rejected effect, rule cycle, or budget diagnostic.

## 4. Conversations, time, and randomness

- Conversation identity, speakers, lines, options, conditions, and history.
- Interrupting, resuming, and continuing a conversation after state changes.
- Hidden and disabled dialogue option policies.
- Action time, elapsed time, hidden/closed pause, bounded catch-up, and clock display.
- Seeded repeatability, unseeded outcome logging, and replay information.

## 5. Inventory and presentation

- Optional item definitions, quantities, containers, use, and equipment slots.
- Custom item properties such as quality and durability.
- Markdown formatting, tables, callouts, stable-node wiki links, and bounded embeds.
- Locale keys, literal text, default-locale fallback, and missing-translation diagnostics.
- Static images, ASCII art, audio, typing sounds, volume controls, and content-addressed assets.
- Custom player styles, validation, isolation, and limits on remote or active content.

## 6. Supported scripts

- When a rule or effect is sufficient and when a script is useful.
- The exact JavaScript, Lua, and Python grammar after it is frozen.
- Common intermediate representation and the capability API.
- State reads, validated effect requests, event emission, random values, and source locations.
- Unsupported syntax, diagnostics, execution budgets, rollback, and the absence of DOM, storage, network, filesystem, imports, and `eval` access.
- Equivalent behavior across source languages and examples that fail compilation.

## 7. Validation, playtest, and portability

- Diagnostic fields, severity, blocking behavior, acknowledgments, and source locations.
- Playtest checkpoints, restart, step, trace filtering, and test-session-only edits.
- Project ZIP versus player save ZIP versus exported game ZIP.
- Save policy, allowed save locations, content fingerprint, version compatibility, and import errors.
- Exporting, extracting, direct-opening `index.html`, local assets, and offline use.
- Browser-specific limits and reproducible manual checks for Chromium, Firefox, WebKit, Chrome, and Edge.

## Appendices

- Glossary and stable identifier lookup.
- Keyboard operation and focus behavior for authoring and play.
- Common diagnostics and recovery steps.
- Small complete examples that validate against the accepted schemas.
- Change log for schema, script-subset, and behavior contracts.
