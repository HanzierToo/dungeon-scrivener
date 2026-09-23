# Schema and contract versioning

## Serialized document versions

Every canonical JSON document has `format` and integer `schemaVersion`. All v1 schemas require `schemaVersion: 1`. Unknown future versions are rejected with an actionable diagnostic. Older versions require an explicit, named migration before normal validation. Validation and migration operate on an in-memory copy; untouched imported file bytes remain available for recovery and export.

A change is compatible only when v1 readers can continue to interpret existing documents without guessing, data loss, or changed meaning. Optional fields may be added only when their default behavior is specified here and the v1 schemas intentionally permit them. This v1 schema set currently rejects unknown fields, so any added field requires an explicit schema update and compatibility review.

## Contract change procedure

1. Identify every affected schema, TypeScript type, package API, task, fixture, and save/export compatibility rule.
2. Write the proposed change and its compatibility classification in a dated decision record under this directory. State the smallest reason for the change.
3. Update the affected JSON Schemas, TypeScript public types, valid and invalid examples, and package ownership map together.
4. Run `npm run check:contracts`, `npm run typecheck`, and `npm test`. Add runtime tests only in the owning implementation task.
5. Update the contract version or provide an explicit migration when existing v1 meanings or required shapes change. Do not silently reinterpret v1 data.
6. The orchestrator accepts the change and records the affected successor tasks before implementation resumes.

No implementation task may create a competing schema or public type file. If an assigned task finds a contract insufficient, it stops only the dependent behavior, reports the smallest proposed amendment, and continues independent work within its ownership boundary.
