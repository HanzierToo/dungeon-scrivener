# Schema and contract versioning

## Serialized document versions

Every canonical JSON document has `format` and integer `schemaVersion`. All v1 schemas require `schemaVersion: 1`. Unknown future versions are rejected with an actionable diagnostic. Older versions require an explicit, named migration before normal validation. Validation and migration operate on an in-memory copy; untouched imported file bytes remain available for recovery and export.

A change is compatible only when v1 readers can continue to interpret existing documents without guessing, data loss, or changed meaning. Optional fields may be added only when their default behavior is specified here and the v1 schemas intentionally permit them. This v1 schema set currently rejects unknown fields, so any added field requires an explicit schema update and compatibility review.

The v1 project manifest owns the required `gameVersion`. It is the only author-controlled game compatibility version; a player save copies that value, and a compatibility target reads it from the active manifest. The save compares exact values for project ID, manifest game version, engine version, and playable-content fingerprint. v1 does not migrate player saves.

## 2026-09-23 decision: revise the 1B/1C contract before runtime implementation

The original sequence had proceeded from 1B into 1C, but this review found required shapes and semantics missing. The user reopened 1B/1C and authorized correcting contracts, examples, fixtures, and validation before runtime/save-codec implementation. Add manifest gameVersion, world randomness and typing-sound settings, resumable clock state, mutable entity tags, run-script effects, a raw command input API, and save fields for those behaviors. Keep document `schemaVersion: 1` as the unreleased draft baseline because this repository has no game runtime or player-save codec consuming the old shapes. This is a pre-runtime rebaseline, not a migration or reinterpretation of released v1 data.

If an implementation or persisted document outside this repository has consumed the previous shapes, do not silently accept it under this corrected baseline; resolve that compatibility boundary through a new schema version and named migration. After the corrected 1B contract is accepted, any later breaking change to these required v1 shapes or meanings must use a new schema version and a named migration. Do not use a default to guess whether a legacy save is seeded, how tags changed, or which clock baseline applies.

## Contract change procedure

1. Identify every affected schema, TypeScript type, package API, task, fixture, and save/export compatibility rule.
2. Write the proposed change and its compatibility classification in a dated decision record under this directory. State the smallest reason for the change.
3. Update the affected JSON Schemas, TypeScript public types, valid and invalid examples, and package ownership map together.
4. Run `npm run check:contracts`, `npm run typecheck`, and `npm test`. Add runtime tests only in the owning implementation task.
5. Update the contract version or provide an explicit migration when existing v1 meanings or required shapes change. Do not silently reinterpret v1 data.
6. The orchestrator accepts the change and records the affected successor tasks before implementation resumes.

No implementation task may create a competing schema or public type file. If an assigned task finds a contract insufficient, it stops only the dependent behavior, reports the smallest proposed amendment, and continues independent work within its ownership boundary.
