# Phase 3 Persisted Graph Snapshot Store — Design (G-3.1 / G-3.5)

**Date:** 2026-09-22
**Authority:** D-0021 (owner ruling: persisted snapshot store + persisted runtime/MCP handle
lifecycle REQUIRED; stateless pilot rejected for Phase 3 acceptance), executed under the D-0023
delegation. This design adds no new acceptance criteria — it maps D-0021's ten executed-test
criteria onto a concrete layout, API and test plan.

## 1. Problem

`Phase3SemanticGraphPilot` is stateless: every tool call rebuilds the graph from the project
index + sources. There is no graph store, no durable handle, no lifecycle — exactly what D-0021
rejected for G-3.1 (persisted resolver state) and G-3.5 (persisted runtime/MCP handle lifecycle).

## 2. On-disk layout (generation directories + atomic pointer)

```
<workspace>/.semantic-engine/graph-snapshots/
  current.json                     ← pointer (the ONLY entry readers consult)
  generations/
    gen-000001/meta.json           ← store schema, graph snapshot id, source index digest, counts
    gen-000001/graph.json          ← the serialized SemanticGraph (deterministic build output)
    gen-000002/…
  .tmp-publish-<n>-<rand>/         ← in-flight publication (never read; swept on next publish)
```

- **Publication** (single writer): write `.tmp-publish-…/{meta.json,graph.json}` (fsync) →
  `rename()` the directory to `generations/gen-<n>` → write `current.json.tmp` → `rename()` to
  `current.json`. Every rename is atomic within a filesystem, so `current.json` always names a
  **complete** generation; a crash can leave an orphan generation or a swept-up tmp dir, never a
  torn pointer. This is the generation-directory migration D-0014 deferred; it is additive (a new
  subdirectory) and does not move the existing index/manifest pair, so no consumer paths break.
- **`current.json`**: `{ storeSchemaVersion, generation, handle, graphSnapshotId }`.
- **Handle** (durable, plain string, stable across restarts): `gen-<n>@<snapshotId[0..12]>`.
  The generation ordinal locates the directory; the id suffix binds the handle to one snapshot
  content so a mismatch is detectable.

## 3. API (`src/core/codeintel/GraphSnapshotStore.ts`, dependency-free core)

| Member | Contract |
|---|---|
| `publish(graph, sourceIndexDigest, opts?)` | Writes the next generation + atomically swaps the pointer. `opts.crashAt` is an explicit crash-injection point (`'before-generation-rename'` \| `'before-pointer-swap'`) used by the recovery tests; it throws at that exact step. Sweeps leftover tmp dirs. Optionally `keep` generations. |
| `current()` | Reads the pointer → loads that generation → validates → migrates if older store schema. Returns `null` only for a fresh store (no pointer). A pointer naming a missing generation, a snapshotId mismatch, or a future schema is a **hard error**, never a silent fallback. |
| `resolveHandle(handle)` | Durable-handle resolution: loads the named generation, verifies the handle's id suffix against the stored `graphSnapshotId`. Missing generation → `STALE_HANDLE`; id mismatch → `SNAPSHOT_MISMATCH`; malformed → `INVALID_HANDLE`. **Never falls back to `current()`.** |
| `listGenerations()` | Ordinals + handles present on disk. |
| `cleanup(keep)` | Deletes oldest generations beyond `keep`, re-reading and never deleting the pointer's target. Idempotent. |

Validation on every load (fail-closed): `meta.graphSnapshotId === graph.snapshotId`; recorded
counts match the arrays actually loaded; `storeSchemaVersion` ≤ current (older → migrate, newer →
`FUTURE_SCHEMA` rejection).

## 4. Schema versioning / migration

`meta.storeSchemaVersion` is the compatibility contract (current: `1`).
`graphSchemaVersion` mirrors the graph's own `schemaVersion` (`'3-pilot'`).
Migration `0 → 1` (executed test): v0 records lack `engineVersion`/`counts` and their graph may
lack `occurrenceAudit`; the loader fills defaults and revalidates. Unknown future versions are
rejected fail-closed. Engine version is recorded informationally (`engineVersion`), not a
compatibility gate.

## 5. Runtime / MCP lifecycle (`src/ai/tools/Phase3SemanticTools.ts`)

Both experimental Phase 3 tools (`symbol_references`, `semantic_graph_inspect`) accept an optional
`GraphSnapshotStore` (the registry constructs one under the existing `experimental['semantic-graph']`
gate — no gating changes):

- **Without a handle** the tool runs get-or-build: if `current()` is valid AND its
  `sourceIndexDigest` equals the live index snapshot id AND its graph schema matches, the
  persisted graph is reused (`metadata.snapshotReused: true`); otherwise a fresh graph is built,
  published, and returned (`metadata.snapshotReused: false`). Either way the response carries
  `metadata.snapshotHandle`.
- **With `snapshotHandle`** the tool resolves through the persisted generation only — a stale or
  mismatched handle fails closed with the store's error, even though a rebuild could have
  "helped". This is the D-0021 handle-lifecycle requirement: handles are references to persisted
  state, not suggestions.
- Restart durability falls out: handle + store on disk, no in-memory state required.

## 6. D-0021 criteria → executed tests

| # | Criterion | Test |
|---|---|---|
| 1 | Restart save/restore | `GraphSnapshotStore.test.ts`: publish → **new store instance** → `current()` deep-equal |
| 2 | Durable handles | publish → new instance → `resolveHandle` serves the same graph |
| 3 | Stale/mismatch rejection fail-closed | `cleanup` deletes old gen → its handle → `STALE_HANDLE`; wrong id suffix → `SNAPSHOT_MISMATCH`; malformed → `INVALID_HANDLE`; never a fallback |
| 4 | Kill-during-publication recovery | `crashAt` both points → `current()` still serves the previous complete generation; next publish succeeds; tmp dirs swept |
| 5 | Atomic/generation-dir publication | layout assertions + pointer↔meta agreement + no tmp dirs after publish |
| 6 | Incremental == full after restart | persisted snapshot (same index) deep-equals a fresh full build; changed index → rebuild+publish, deep-equals a fresh full build of the new index |
| 7 | Same scenarios via MCP/Gateway | `GraphSnapshotMcp.test.ts`: tools/call returns a handle → new server instance (restart) → same handle gives the identical result; stale handle fails closed; direct-API parity |
| 8 | Schema migration/versioning | v0 record migrates + revalidates; future `storeSchemaVersion` rejected fail-closed |
| 9 | Safe old-generation cleanup | 4 generations → `cleanup(2)` keeps pointer target + predecessor; idempotent; deleted handle → `STALE_HANDLE` |
| 10 | No silent partial serve | pointer without generations / torn state → hard error, never a partial graph |

## 7. Scope guards

- The store persists the **graph snapshot** only; the project index and its manifest keep their
  existing publication path (D-0013/D-0014) — this design does not move or rewrite them.
- `Phase3SemanticGraphPilot` remains the single graph producer (deterministic, verified by
  Spike-S regate); the store adds persistence, not a second resolver.
- Experimental gating is unchanged: no tool is exposed unless the host opts in.
