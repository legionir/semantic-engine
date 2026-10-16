# Phase 0 — Traceability Matrix (step 0.9)

Date: 2026-09-21 · Branch: `arena/01a0c3c9-semantic-engine-structured-ai`

Requirement → implementation artifact(s) → proof test(s). Execution evidence
and statuses live in `phase0-test-coverage-matrix.md`; this matrix is the
cross-reference a reviewer follows from a contract line to the code that
enforces it and the test that proves it.

## Canonical contracts

| Contract | Enforced in | Proven by |
|---|---|---|
| UTF-16 offsets over BOM-stripped text; 0-based positions; end-exclusive ranges | `core/contracts/codeintel.ts` `LineIndex` | `codeintel.test.ts` (92 tests: empty file, offset 0, round-trips, LF/CRLF/CR, trailing newline, BOM, emoji/surrogates, out-of-range, end-exclusive) |
| CRLF collapse rule (representability, idempotence, `isRepresentableOffset`) | `LineIndex.positionAt/offsetAt` | `codeintel.test.ts` representability block; D-0005 |
| `SymbolKey = path::qualifiedName::kind[#ordinal]`, deterministic, relative POSIX paths only | `makeSymbolKey/parseSymbolKey` | `codeintel.test.ts` SymbolKey block; D-0006 |
| `Handle = path:start-end#hash8`, parse/round-trip, rejection of bad hash/range/path | `makeHandle/parseHandle` | `codeintel.test.ts` Handle block |
| Envelope: `ok`, `fail(code,message,retryable)`, snapshotId/sessionId, `trust:"untrusted-source-content"`, warnings, stats | `ok/fail` + frozen error taxonomy | `codeintel.test.ts` envelope block |
| Closed error taxonomy + retryable set (TIMEOUT/IO_ERROR/STALE_SNAPSHOT) | `CodeIntelError` codes | `codeintel.test.ts` taxonomy block |
| Safe default config: `enabled:false`… `readOnly:true`, caps, timeout, no-mutation default | `DEFAULT_CODEINTEL_CONFIG` (frozen) | `codeintel.test.ts` config block |
| Deterministic canonical JSON independent of property insertion order | `canonicalJson` (code-unit order) | `codeintel.test.ts` determinism block |
| `file.lines` (terminator count) ↔ `LineIndex.lineCount` (logical lines) mapping | `toProjectIndexLineCount()` + `toProjectIndexLine()` | `codeintel.test.ts` line-count bridge block; SE-P0-COORD-01 recorded in CONTRACTS.md |
| STALE_HANDLE / STALE_SNAPSHOT runtime contract | `core/contracts/snapshotStore.ts` `InMemorySnapshotStore` (reference, **LOCAL only — not wired to runtime**) | `snapshotStore.test.ts` |
| Read-only `FileProvider` port, confinement, denylist, caps, TIMEOUT/CANCELLED, binary sniff | `core/contracts/ports.ts` + `fileProvider.ts` `ConfinedFileProvider` | `ports.test.ts` (18), `fileProvider.test.ts` (45) |

## Pipeline / persistence

| Requirement | Enforced in | Proven by |
|---|---|---|
| Full vs incremental parity (incl. add/modify/delete/rename, Unicode/CRLF/BOM) | `incremental/IncrementalEngine.ts`, `ProjectIndexStore.renameFile` | `pipeline/IncrementalParity.phase0.test.ts` (8) — caught SE-P0-PARITY-01/02 |
| Rename keeps symbols; removed ids + old∪new dependents reprocessed | `IncrementalEngine.handleRename` | same suite, rename cases |
| Publication: reader never sees a torn index; two writers; crash window | `pipeline/OutputWriter.write` (index→manifest order) | `pipeline/Publication.phase0.test.ts` (7) |
| Crash between index and manifest → mismatched pair | recorded gap SE-P0-PUB-01 | pinned by `Publication.phase0.test.ts`; closed at consumption by integrity gate (below) |
| Fail-closed consumption of a byte-mismatched pair on **every** serve path | `core/config/artifactManifest.ts`; wired into `ProjectService` (HTTP), `SemanticEngineMcpServer.reloadFromDisk`, `ai/mcp/cli.ts` | `core/config/artifactManifest.test.ts`, `ai/mcp/McpArtifactIntegrity.phase0.test.ts`, `pipeline/ArtifactSetReader.phase0.test.ts` |
| Deterministic index output (path-keyed ordering) | `IndexPipeline.projection()` | `IncrementalParity.phase0.test.ts` determinism case |
| Generation on every publish + restart reload | `nextIndexGeneration`, MCP `refreshGeneration` | `McpReadOnlyLifecycle.phase0.test.ts` (5) |

## Security / boundaries

| Requirement | Enforced in | Proven by |
|---|---|---|
| Workspace path confinement, traversal rejection | `services/source/SourceSecurityGuard.ts` | `security/ReadBoundary.phase0.test.ts` (31) |
| Symlink policy incl. cyclic-link rejection and depth cap | `SourceSecurityGuard.validateSymlink` (SE-P0-SYM-01 fixed) | same suite |
| Read-only enforcement on the real MCP path (measurement, not trust) | tool registry has no write tools; digest around real calls | `ai/mcp/McpReadOnlyLifecycle.phase0.test.ts` |
| File count/size caps, timeout, cancellation | `ConfinedFileProvider` (reference impl) | `fileProvider.test.ts` |

## Graph / visualization (defects fixed this stage)

| Requirement | Enforced in | Proven by |
|---|---|---|
| فاز ۴۷: `path("API /login", "Database")` بین‌لایه‌ای | `GraphQueryEngine.shortestPath` — point-to-point no longer capped at the 2-hop default (D-0010) | `graphs/LayeredGraph.test.ts` (3 previously red cases green) |
| LoD level-1 architecture view returns real module edges | visualization `basis` vocabulary aligned to canonical `EdgeBasis` (D-0011) | `server/platform.e2e.test.ts` step 4 green |
| Single-module project degrades to file-level view (kept contract) | `LodService` SE-VIZ-01 fallback; e2e fixture now has a module boundary (D-0012) | same suite |

## Explicitly NOT traceable to runtime (kept open)

| Item | State |
|---|---|
| `STALE_HANDLE` on the real MCP path | contract + reference store tested LOCALLY; runtime wiring open (named Phase-0 blocker) |
| Atomic publication of the pair as one operation | not possible with two-file layout; fail-closed consumption shipped; generation-directory layout decision recorded (D-0014) |
| apply→undo fuzz | **NOT APPLICABLE** — no apply/undo implementation exists; recorded, not silently dropped |
| `check:audit` | unsatisfiable in-repo: `AUDIT-2026-08.md` / `EXECUTION-PLAN.md` / `GRAPH-INTELLIGENCE-GAPS.md` have never been committed; script now fails closed with the named gap (owner input required) |
