# Archive, player-save, and fingerprint contracts

## Project archive and VFS

`ProjectVfsSnapshot` is the in-memory owner of file bytes and accepted relative paths. The JSON VFS schema describes only its metadata index; bytes remain `Uint8Array` values owned by the file entries and are not encoded into the index. A snapshot has one entry per file path and an explicit directory set.

A project ZIP contains the project files themselves. Its archive index is an API result, not a ZIP member. Archive entries retain the member path and compression method. Each file entry records actual compressed and expanded byte lengths, lowercase eight-digit CRC-32, and SHA-256 of the uncompressed file bytes. The index does not excuse reading and validating actual ZIP headers, sizes, CRC, or bytes. Explicit directory entries are optional on disk and are represented when present.

Only `store` and `deflate` are accepted. Encryption, split volumes, Zip64, symlinks/special files, traversal, absolute paths, invalid UTF-8, duplicate or case-colliding paths, and unsupported compression are rejected. Enforce all limits in `budgets.md` while reading, before retaining expanded data. Preserve accepted path spelling and file bytes. ZIP output may choose either supported compression method and may omit empty directory members.

Paths are NFC Unicode relative paths separated by `/`. Reject empty segments, `.` or `..`, leading slash, backslash, colon, C0/C1 controls, trailing dot or space, Windows device names, and any path not already NFC. Case-collision keys use Unicode NFC plus locale-independent lowercase. Reserved structured names are `project.json`, `world.json`, `locales/<locale>.json`, declared script paths under `scripts/`, managed assets at `assets/sha256/<64 lowercase hex digits>`, and the optional referenced player CSS path. A case-insensitive collision with a reserved path is invalid. Arbitrary files are retained byte-for-byte and stay inert unless explicitly declared.

## Player-save archive

A player save is a ZIP with exactly one file named `save.json`. That file is a `dungeon-scrivener-player-save` JSON document validated against `player-save.schema.json`; no project source code is executed during import. The ZIP input is capped at 8 MiB and uses only `store` or `deflate`.

`encodePlayerSave(save)` returns `Promise<PlayerSaveEncodeResult>` and `decodePlayerSave(bytes)` returns `Promise<PlayerSaveDecodeResult>`. Each result is a discriminated `ok` union: success contains the complete bytes or complete archive; failure contains diagnostics and no partial value. Encoding fails if the session JSON or final ZIP exceeds 8 MiB, or if data fails schema/semantic validation. Decoding fails for malformed or unsupported ZIP data, archive or expanded-member size overflow, malformed JSON, schema failure, or invalid save references. Decode does not mutate the active session. The caller validates save compatibility and installs the fully decoded snapshot only after every check succeeds; every failure leaves the current session untouched.

The save records project ID, game version, engine version, playable-content fingerprint, slot metadata, saved time, and the entire resumable session: current node, world/node/entity state, mutable entity tags, node visit counts, conversation stack and history, game time, randomness mode, initial seed and current PRNG state, complete unseeded random outcome history, clock baseline/activity, once-only rule guards, and inventory stacks. `randomInitialSeed` is the normalized seed chosen at session creation; `randomSeed` is the current xorshift32 state. Both are uint32 in seeded mode and null in unseeded mode. The current state resumes future seeded draws exactly. The ordered unseeded history supports call-verified replay and is never truncated. Mutable tags are saved as entity ID to sorted unique tag arrays, including unchanged authored tags, so save/load does not need to reconstruct runtime tag state from a potentially changed project. A save importer validates the entire archive and payload before replacing the active session.

The required `gameVersion` in `project.json` is the only author-controlled game version. Save creation copies `manifest.gameVersion` into the save; there is no second author setting in the world or save-compatibility target. The target supplies the current manifest, engine version, and recomputed playable-content fingerprint. Compatibility requires exact equality of save project ID and target manifest project ID, save game version and target manifest game version, engine version, and content fingerprint. Any mismatch rejects the save with a diagnostic and leaves the active session unchanged. There is no automatic migration of player saves in v1. Saves move between hosted and exported copies when all four values match. A save slot count limits in-app slots only; it cannot prevent the player from copying ZIP files. Save operations are explicit user downloads and imports.

Seeded sessions persist their uint32 PRNG state in `randomSeed`, have `randomnessMode: "seeded"`, and use an empty saved random-outcome log. Unseeded sessions persist `randomSeed: null`, have `randomnessMode: "unseeded"`, and keep ordered outcome records so nondeterministic results are retained. The two fields must agree. `entityTags` must name known entity IDs and contain only tags allowed by each entity's definition. The clock state stores last observation time and inactive interval start as epoch milliseconds, plus the last known visibility and focus. Per-action worlds use null clock baselines. Elapsed worlds use the stored baseline to apply the world's pause or bounded-catch-up policy on resume.

A disabled save policy has `enabled: false` and `slotCount: 0`. An enabled policy has 1-10 slots. `allowedLocation: "checkpoint"` requires at least one declared checkpoint node ID; `"anywhere"` permits saves at any visitable node. When disabled or unrestricted, `checkpointNodeIds` is absent or empty. The policy controls player UI and validation; it does not control file copying.

## Playable-content fingerprint

The fingerprint is SHA-256 over an RFC 8785 JSON Canonicalization Scheme encoding of this descriptor:

```json
{
  "format": "dungeon-scrivener-content-fingerprint-input",
  "schemaVersion": 1,
  "algorithm": "sha-256",
  "scope": "playable-files-v1",
  "files": [
    {
      "path": "project.json",
      "byteLength": 128,
      "sha256": "<lowercase SHA-256 hex of exact file bytes>"
    }
  ]
}
```

The file rows contain the exact UTF-8 path, byte length, and lowercase SHA-256 hex digest of each exact file byte sequence. Sort rows by unsigned UTF-8 path bytes before canonicalization. The digest field itself is not included in its input. The returned digest uses `sha256:<64 lowercase hex digits>`.

The `playable-files-v1` set contains `project.json`, `world.json`, every accepted file under `locales/`, every script file declared by `world.json`, every managed asset referenced by the world's Markdown or locale content, every asset referenced by a typing-sound mapping or asset fallback, and the optional player CSS file named by world settings. Resolve each reference to its accepted VFS path before hashing. Include each path once even when multiple images, sounds, or typing-sound mappings refer to the same content hash. A missing, unsafe, conflicting, or invalid referenced asset is a model diagnostic and cannot produce a successful fingerprint.

Exclude unrelated/arbitrary files, unreferenced media, ZIP metadata, file timestamps, directory entries, archive compression, generated `index.html`, and engine/runtime bytes. The format, schemaVersion, algorithm, and scope in the descriptor domain-separate this digest from other hash uses. The `files` array in the returned `ContentFingerprint` is the exact sorted set used for the digest. JSON schemas check its shape; implementations also recompute and compare every byte length, file hash, and final digest.

Two projects with identical playable file bytes and paths have the same fingerprint regardless of ZIP order or compression. Any change to an included path or byte changes the fingerprint. Save compatibility also checks project and software versions separately.
