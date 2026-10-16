# Phase 0 — Executed Evidence (2026-09-21)

**Repository:** `legionir/semantic-engine-structured-ai`
**Branch:** `arena/01a0c3c9-semantic-engine-structured-ai` @ `673c3e52e617565bcb5a30d7c9986b158baaf79a`
**Package under test:** `semantic-engine/`
**Supersedes:** the command-evidence section of `phase0-baseline-2026-09-21.md`, which was
written without an executable checkout. That file's limitation — "commands were **not**
executed" — no longer holds.

## 1. Environment (observed)

| Item | Value |
|---|---|
| Node | `v22.22.3` (package declares `>=20`) |
| npm | `10.9.8` |
| Lockfile | `semantic-engine/package-lock.json` (npm) |
| `npm ci` | succeeded in this checkout |
| Registry reachability | `npm ping` → `PONG 230ms` |
| OS | Linux x86_64 container (not the repository CI image) |

## 2. Commands of record (exact, with results)

| # | Command | Result |
|---|---|---|
| 1 | `npm run build` (`tsc -p ./`) | **exit 0**; `dist/` produced |
| 2 | `npm run lint` (`eslint src`) | **exit 0**; 4 warnings, 0 errors (`src/ai/tools/QueryIndexTool.ts:165`, `src/cli/commands/watch-command.ts:18,20,21` — unused bindings) |
| 3 | `npm test -- --silent` **before** `npm run build` | `Test Suites: 5 failed, 9 skipped, 199 passed, 204 of 213 total` · `Tests: 6 failed, 87 skipped, 2736 passed, 2829 total` |
| 4 | `npm test -- --silent` **after** `npm run build` (baseline of record) | `Test Suites: 5 failed, 208 passed, 213 total` · `Tests: 6 failed, 2823 passed, 2829 total` · 214 s |
| 5 | `npm test -- --silent` after this stage's changes (with `dist/` present) | `Test Suites: 2 failed, 216 passed, 218 total` · `Tests: 4 failed, 3014 passed, 3018 total` |
| 6 | `npm run test:gate` (fixture + `check-tests.js` + `check-artifact-location.js`) after this stage's changes | `Test Suites: 2 failed, 216 passed, 218 total` · `Tests: 4 failed, 3014 passed, 3018 total` · **exit 1** — every suite *ran* (216 + 2 = 218), and the four failures are the two pre-existing red suites listed in §4. The repo's own gate is red because those two suites are red; it is not red because of anything added here. |
| 7 | `npm run check:audit` | **fails**: `ENOENT … semantic-engine/AUDIT-2026-08.md` — the script also reads `EXECUTION-PLAN.md` and `GRAPH-INTELLIGENCE-GAPS.md`, none of which exist in this snapshot |

Why run 3 and run 4 differ: `describeIfBuilt` guards three suites on the presence of `dist/`
(`gateway/multiProject.e2e.test.ts:33`, `lsp/LspClient.test.ts:495`,
`host/barrelLoad.test.ts:54`). Without a build those 87 tests are *skipped*, so **`npm run
build` is a prerequisite for `npm test`** — a skipped suite is not a passing one.

**Evidence-integrity note:** jest's exit status was masked in several exploratory runs by
piping output to `tail` (the pipeline's status is `tail`'s). All numbers above come from
jest's own summary lines, not from a pipeline's exit code.

## 3. Defects found by the new tests, and fixed

| ID | Where | Defect | Fix |
|---|---|---|---|
| **SE-P0-PARITY-01** | `src/incremental/IncrementalEngine.ts`, `ProjectIndexStore.ts` | A rename whose content was unchanged ran `removeFile` + `upsertFile`. `removeFile` also drops `symbolsByFileId` (the SE-INC-11 fix), so the renamed file lost every symbol: incremental index 5 symbols where a full rebuild had 6. | New `ProjectIndexStore.renameFile(fileId, newPath)`: path keys move, symbols stay. `handleRename` uses it. |
| **SE-P0-PARITY-02** | `src/incremental/IncrementalEngine.ts` | The rename paths never reported removed symbol ids and never reprocessed the *old path's* dependents, so a rename with changed content left stale resolved imports, stale dependency edges and stale call edges pointing at the removed file (`b.ts` kept `resolvedFileId` of a file that no longer existed). | `handleRename` now returns `removedSymbolIds`, collects old dependents before removal (and new dependents after reprocessing), and the caller adds the ids to the graph-cleanup set. The "rename to a missing target" branch gets the same delete-grade bookkeeping. |
| **SE-P0-SYM-01** | `src/services/source/SourceSecurityGuard.ts` | `validateSymlink` called `fs.existsSync` (which follows links, so a cycle reported "does not exist") and then `fs.realpathSync` (which resolves the whole chain at once). Measured: a two-link cycle and a five-deep chain both returned `ok: true`; `maxSymlinkDepth` was unreachable. | The chain is now walked with `lstat` + `readlink` one hop at a time, keys are compared for cycles, and the hop count enforces `maxSymlinkDepth`. |
| **SE-P0-CLI-01** | `src/cli/cli.test.ts` | The test named "`--artifact-location in-root` همان خروجی قدیمی را میدهد" never passed the flag; since فاز ۴ the default is `external`, so it asserted the legacy layout while exercising the new default and had been red under `npm test`. | The flag is passed, as the test's own name and the phase-4 decision require. |

## 4. Gaps recorded, not fixed

| ID | Gap | Evidence |
|---|---|---|
| **SE-P0-PUB-01** | The legacy two-file publication cannot atomically rename two independent paths. It is now fail-closed for consumers using `readCoherentArtifactSet()`: digest and byte count are verified before an index is exposed, and mismatch raises `INCOHERENT_ARTIFACT_SET`. The underlying writer interruption window remains open until all consumers migrate to a generation-directory/pointer layout. | `src/pipeline/Publication.phase0.test.ts` measures the interruption; `src/pipeline/ArtifactSetReader.phase0.test.ts` proves mismatch rejection. |
| **SE-P0-COORD-01** | `file.lines` counts line terminators (`wc -l`: a file ending in `\n` with 3 breaks reports 3) while `LineIndex.lineCount` counts the empty line a trailing break opens (4). The explicit bridge `toProjectIndexLineCount()` now defines and tests the conversion, including empty text, LF, CRLF and trailing breaks. | `src/core/contracts/codeintel.ts` + `codeintel.test.ts`; `CONTRACTS.md` mapping row. |
| **SE-P0-GRAPH-01** | `LayeredGraph` cross-layer path finding returns `path: null` in three acceptance tests, including the API → Database route its own phase-47 criterion requires. | `npx jest src/graphs/LayeredGraph.test.ts` → 3 failed. **Pre-existing**: identical in the pristine tree (run 4) before any change in this stage. |
| **SE-P0-API-01** | `GET /api/v1/projects/:id/visualization/architecture` answers `level: "file"` where the platform e2e expects `"architecture"`. | `npx jest src/server/platform.e2e.test.ts` → 1 failed. **Pre-existing**, unchanged by this stage. |

### The two contract suites named in the task, verified

```
npx jest src/core/contracts
→ Test Suites: 3 passed, 3 total · Tests: 155 passed, 155 total
```

## 5. Files added or changed in this stage

Added (tests): `src/core/contracts/fileProvider.test.ts`,
`src/security/ReadBoundary.phase0.test.ts`, `src/pipeline/IncrementalParity.phase0.test.ts`,
`src/pipeline/Publication.phase0.test.ts`, `src/ai/mcp/McpReadOnlyLifecycle.phase0.test.ts`.

Added (implementation / contract): `src/core/contracts/fileProvider.ts`
(`ConfinedFileProvider`, reference implementation of the `FileProvider` port).

Changed: `src/core/contracts/codeintel.ts` and `ports.ts` (contract rules documented and
tightened), `src/core/contracts/codeintel.test.ts` and `ports.test.ts` (rebuilt),
`src/core/contracts/snapshotStore.ts` + `snapshotStore.test.ts` (reference handle issuer/verifier),
`src/pipeline/OutputWriter.ts` + `ArtifactSetReader.phase0.test.ts` (fail-closed artifact reader),
`src/services/source/SourceSecurityGuard.ts` (SE-P0-SYM-01),
`src/incremental/IncrementalEngine.ts` + `ProjectIndexStore.ts` (SE-P0-PARITY-01/02),
`src/cli/cli.test.ts` (SE-P0-CLI-01).

Docs: this file, `phase0-test-coverage-matrix.md`, and updates to `CONTRACTS.md`,
`DECISIONS.md`, `GATES.md`.

**Not in the audit snapshot:** `AUDIT_FILE_STATUS.md` is a snapshot of the *previous*
revision's 881 files. The files above are new; they are deliberately not appended to a
snapshot table, and `npm run check:audit` cannot run here anyway (§2 row 6).

## 6. Bug found and fixed in the two contract suites the task named

Both suites named in the task were **red** in the pristine tree:

- `src/core/contracts/codeintel.test.ts` — `CRLF round-trips every decoded UTF-16 offset`
  failed (`Expected: 6, Received: 5`). The expectation is *unsatisfiable* as written: with
  `offsetAt` clamping to the end of the line's content, the `\n` of a `\r\n` has no
  `Position` at all, so no implementation can round-trip it. The policy is now explicit in
  `codeintel.ts` (representable offsets round-trip; the interior of a multi-unit break
  collapses to the line end and never moves past the requested offset; `positionAt` is
  idempotent for *every* offset; `isRepresentableOffset()` answers the question directly),
  and the suite asserts each clause.
- `src/core/contracts/ports.test.ts` — did not compile (`TS2554: Expected 0 arguments, but
  got 1`): the mock's `exists` was inferred as zero-argument. The suite is rebuilt against a
  typed port, a runtime check that no mutating member exists, and the real
  `ConfinedFileProvider`.

After the rewrite: `npx jest src/core/contracts` → **3 suites passed, 155 tests passed**.

## 7. Gate verdict (unchanged in kind, changed in evidence)

`GATES.md` requires `LOCALLY VERIFIED` / `MCP VERIFIED` / `GATEWAY VERIFIED` evidence. This
stage produces that class of evidence for: determinism, full/incremental parity, read
security, size/count limits, deadline/cancellation, MCP read-only behaviour, and restart.

**Phase 0 stays 🔴 BLOCKED**, for reasons that are now measured rather than assumed:

1. SE-P0-PUB-01 — publication of the artifact *set* is not atomic;
2. SE-P0-GRAPH-01 and SE-P0-API-01 — four pre-existing red tests remain;
3. the compatibility matrix (step 0.8), the traceability matrix (step 0.9) and adopt-vs-build
   (step 0.10) are not written;
4. ten of the 24 required items are still 🟡 with named missing halves (matrix rows 3, 4, 5, 7,
   10, 17, 18, 19, 23, 24), one is blocked by design (row 20 — no apply/undo implementation).
   Row 13 now has an in-memory issuer/verifier contract with stale-handle tests; production
   snapshot-store wiring and MCP exposure remain unverified.
5. the repository's own gate, `npm run test:gate`, exits 1 because of the four pre-existing
   red tests in §4 — it cannot be green while those two suites are;
6. `npm run check:audit` cannot run in this snapshot at all.

A 🟡 or ⛔ is not a failure of the code; it is the honest state of the evidence.

## 8. Post-fix validation status

The follow-up commit `14231578c8422b345e0e7bede5c8de85f55c7f8e` was authored after the
recorded npm run. Its new TypeScript and Jest files were reviewed statically and are
**WRITTEN / NOT EXECUTED** in this environment. The earlier command results above must
not be relabeled as evidence for the follow-up changes; rerun `npm ci`, `npm run build`,
`npm test -- --silent`, `npm run lint`, and the focused suites before changing any gate
status.

---

## 9. Continuation — transferred patch integrated and validated (2026-09-21, same day)

The four follow-up commits (`14231578`, `721be53`, `673c3e5`, `52ab0636`, head `52ab0636`)
landed on `arena/01a0c3c9-semantic-engine-structured-ai` on top of `fbc6164`. They were
**WRITTEN / NOT EXECUTED** when authored (§8). They are now fetched, integrated and executed
in this environment (same Node/npm/toolchain as §1), and the gaps they left open are fixed or
recorded.

### 9.1 Transferred-change defects found by the first execution

| Defect | Root cause | Fix |
|---|---|---|
| `codeintel.test.ts` line-count bridge ×4 red | both the test data and the shipped regex were double-escaped (`'one\\\\n'` literal backslash sequences; `/(?:\\\\r\\\\n|…)/` matching literal backslashes) — the suite had never run | real terminators in data; `/(?:\r\n\|\r\|\n)$/` in `toProjectIndexLineCount()`; 165/165 contract tests green |

### 9.2 Pre-existing red tests — root-caused and FIXED (no longer "pre-existing failures")

| Id | Root cause (measured, not assumed) | Fix |
|---|---|---|
| SE-P0-GRAPH-01 (`LayeredGraph` ×3) | `shortestPath` inherited the 2-hop neighborhood default; the فاز ۴۷ acceptance path needs five hops. Resolution, edges, and BFS were all correct — the query died at `depthLimit=2` | point-to-point path queries default to unbounded depth, bounded by `maxNodes` + component exhaustion; explicit `depth` unchanged (D-0010). 155/155 graph tests green |
| SE-P0-API-01 (`platform.e2e` "LoD Architecture Graph") | two causes: (a) the visualization `basis` guard was a stale subset (`resolved/name-match/transitive/blueprint`) that silently dropped every real `import-resolved` edge; (b) the e2e fixture fit every file in one module, which *correctly* triggers the SE-VIZ-01 file-level fallback | (a) vocabulary aligned to canonical `EdgeBasis` in `server/types.ts`, `GraphViewModelMapper`, `LodService` (D-0011); (b) fixture now has a module boundary, assertions untouched (D-0012). Suite 6/6 green |

### 9.3 Open gaps closed this stage

- **Artifact-integrity wiring (SE-P0-PUB-01 consumer half):** one shared gate
  `core/config/artifactManifest.ts` now guards all three serve paths — HTTP `ProjectService`
  (previously inline), MCP `SemanticEngineMcpServer.reloadFromDisk`, MCP `cli.ts` (both load
  sites). Legacy artifacts without a manifest remain accepted by policy. Proofs:
  `artifactManifest.test.ts` (7), `McpArtifactIntegrity.phase0.test.ts` (coherent served → torn
  refused, last-good stays, generation frozen → coherent republish picked up, gen 1→2) (D-0013).
  Layout-level atomicity deferred by decision (D-0014).
- **check:audit:** preflight names the missing inputs (`AUDIT-2026-08.md`, `EXECUTION-PLAN.md`,
  `GRAPH-INTELLIGENCE-GAPS.md` — never committed to this repository) and exits 1 with the named
  gap instead of an ENOENT stack (D-0015). Still exit 1: owner input required.
- **Steps 0.8–0.10 delivered:** `phase0-compatibility-matrix.md`,
  `phase0-traceability-matrix.md`, `phase0-adopt-vs-build.md`.

### 9.4 Commands of record (continuation)

| # | Command | Result |
|---|---|---|
| C1 | `npm ci` (both packages) | exit 0 |
| C2 | `npm run build` | exit 0 |
| C3 | `npx eslint src` | exit 0 (same 4 pre-existing warnings, none new) |
| C4 | `npx jest src/core/contracts` | 4 suites / 165 tests passed |
| C5 | targeted Phase 0 suites (`pipeline`, `security`, `mcp`) | all green |
| C6 | `npm test -- --silent` (after transfer, before §9.2 fixes) | 2 failed / 218 passed suites; 4 failed / 3028 / 3032 |
| C7 | **`npm run test:gate` — run of record** | **exit 0 — 222/222 suites, 3040/3040 tests passed** |
| C8 | `npm run check:audit` | exit 1 with named missing inputs (was: ENOENT stack) |
| C9 | `git ls-remote origin` | remote session branch at `52ab0636`; `docs/audit-file-status` unchanged at `6a67a7f` |

### 9.5 Gate verdict (updated)

**Phase 0: 🟡 CONDITIONAL** — every executable check in this repository passes
(`test:gate` exit 0, 3040/3040). Remaining blockers are explicitly **not** code:

1. `check:audit` — unsatisfiable in-repo; the three audit documents live outside this
   repository and must be committed by the owner (D-0015);
2. true set-atomic publication — deferred architecture migration to a generation-directory
   layout, needs owner sign-off (D-0014); the crash window is meanwhile fail-closed at every
   serve path;
3. snapshot/handle reference (`InMemorySnapshotStore`, LOCALLY tested) is not wired to the
   permanent store or the MCP runtime — named gap, matrix row 13;
4. apply→undo fuzz — NOT APPLICABLE until the feature exists (D-0015);
5. ten 🟡 matrix rows keep their named missing halves (3, 4, 5, 7, 10, 13, 17, 18, 23, 24).
