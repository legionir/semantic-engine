# Phase 3 — Semantic Graph Pilot

## Scope

This patch implements one bounded TypeScript pilot, additively over `ProjectIndexReader`:

- relative TypeScript import extraction;
- deterministic module resolution for indexed `.ts/.tsx/.js` files;
- `exact`, `ambiguous`, and `unresolved` resolution states;
- provenance via `import-graph` and candidate lists;
- `symbol_references` query;
- bounded semantic dependency inspection;
- snapshot identity inherited from the existing Phase 1 platform;
- explicit `buildIncremental(previous, changedPaths)` contract with safe full-rebuild fallback (no stale partial graph);
- experimental registry gating (`experimental['semantic-graph'] === true`).

## Files

- `src/core/codeintel/Phase3SemanticGraph.ts`
- `src/ai/tools/Phase3SemanticTools.ts`
- `src/core/codeintel/Phase3SemanticGraph.test.ts`
- `src/ai/tools/Phase3SemanticTools.test.ts`
- `src/ai/AiToolRegistry.ts` (conditional additive registration)

## Safety and boundaries

- Default registry behavior does not expose Phase 3 tools.
- A configured `workspaceRoot` is required.
- Source content remains `untrusted-source-content`.
- No files are written and no mutation path is introduced.
- Unresolved imports are retained in graph output; they are not silently dropped.
- Name-only matching is not labeled `exact`; the pilot only labels a unique import-to-export mapping `exact`.

## Evidence status

- Code: `IMPLEMENTED`
- Focused tests: `WRITTEN / NOT EXECUTED`
- Build/typecheck/lint: `NOT VERIFIED`
- MCP/Gateway: `NOT VERIFIED`
- Full/incremental producer parity: `NOT VERIFIED` (incremental method is a conservative full-rebuild fallback, not dirty-propagation optimization)
- LSP provider: `NOT IMPLEMENTED` (optional and degraded by design)
- Precision/recall/calibration: `NOT MEASURED`
- Persistence migration/rollback: `NOT IMPLEMENTED IN THIS PILOT`

This document is not a Phase 3 gate approval. The implementation remains experimental until the gold fixture, incremental/full equality, MCP execution, and precision threshold are executed and evidenced.

## Gate closure 2026-09-21 — 🔴 BLOCKED / REMAINS EXPERIMENTAL

Validation on `c2c7396` (+ gate-closure fixes): exact precision 1.0 ≥ 0.95 on
the gold micro-fixture, incremental==full, ambiguity/unresolved retention, MCP
e2e, experimental gating, and real-index execution all evidenced. Blocking
gaps: G-3.1/G-3.5 (no persisted graph store or migration — stateless by
design, owner decision required), G-3.7 (recall vs B0/B1, calibration, and
adopted-tool comparison unmeasured; no Spike-S), G-3.9 (adopt-vs-build
decision missing). Per the plan the pilot stays experimental-gated.
Full report: `docs/validation/gate-closure-2026-09-21.md`.

## Spike-S executed 2026-09-22 — NO-GO as-is (decision input, not a gate)

Real-pilot run on the frozen gold fixture (`docs/validation/spike-s/`):
macro M1 P=0.925/R=0.742 vs B0 R=0.787 vs B1 R=0.896 — all three locked
bars fail (P<0.95; R<B1; R<B0). Structural causes evidenced: scope-blind
`exact`, first-only imports, same-file blindness, no graph walk,
default/re-export gaps, colliding overload keys. Calibration green
(unresolved 4/4, ambiguous surfaced, incremental==full). Recommendation:
no-go on the current pilot; go only with scoped resolver work, re-gated
by the same fixture. Full report: `docs/validation/spike-s/report.md`.
G-3.7 inputs (recall vs B0/B1, calibration) now measured; G-3.1/G-3.5/G-3.9 remain owner decisions. Phase 3 stays 🔴/experimental.

## Owner ruling 2026-09-22 (D-0021) — persisted store REQUIRED

G-3.1: PERSISTED SNAPSHOT STORE REQUIRED. G-3.5: PERSISTED RUNTIME/MCP
HANDLE LIFECYCLE REQUIRED. Stateless pilot rejected for Phase 3
acceptance / production contract / MCP lifecycle (spike/debug harness
use only). G-3.7: FAIL (resolution fix required). G-3.9: FAIL (fix +
re-gate). Phase 3: BLOCKED / NO-GO AS-IS. Ten executed-test acceptance
criteria for the store + ordered next steps recorded in D-0021; order:
record vote → fix resolution (five Spike-S blindnesses) → persisted
lifecycle → re-run frozen goldens → re-gate → only then Phase 4.

## Design freeze submitted 2026-09-22 (D-0022) — extended Step 2

Owner approved option A (goal-aware retrieval) for design-freeze review only;
implementation NOT authorized. Submitted: retrieval-design.md v1.0.0 +
cue-lexicon.json v1.0.0 (frozen, hashed; golds untouched). Resolver fixes
F1–F7 + 5-cue direction layer + anti-gaming protocol + re-gate criteria +
preregistered predictions (aware 1.0/1.0; blind 0.8875 < B1). G-3.7/G-3.9
still FAIL; Phase 3/4 BLOCKED. Awaiting owner ratification; persisted store
(D-0021) continues independently.

## Re-gate executed 2026-09-22 (D-0023/D-0024) — resolution + retrieval GREEN

Implemented retrieval-design.md v1.0.0 end-to-end. Commits: e4fdda9
(F1–F7 + GoalRetrieval + regate.js + fixture-1 results + tests), 7bf3f4d
(unseen fixture-2 + gold-2 frozen BEFORE first run; star-conflict ambiguity
fix; fixture-1 re-verified).

Results (regate.js, deterministic):
- Fixture-1 (frozen golds): AWARE macro P=R=1.000, 20/20 exact sets,
  wrong-exact=0 → G-3.7 bars P≥0.95 ✓, R≥B1(0.896) ✓, R>B0(0.787) ✓;
  G-3.9 re-gate ✓ (calibration §8.3 all green: unresolved 2/2, hard
  bindings 1/1, ambiguous 1/1, unclassified 0, incremental==full, 3/3
  deterministic, B0/B1 exactly reproduced). Blind (cues off) 0.975/0.875
  fails R≥B1 → cue layer necessary. All single-cue ablations still ≥B1.
- Fixture-2 (unseen, first contact, zero tuning): AWARE macro P=R=1.000
  (16/16); blind 0.927/0.757; star conflict surfaced ambiguous; fileDeps
  18/18; incremental/determinism green. Soft bars pass.
- 3 prediction errata root-caused (hand-derivation slips, not engine
  behavior; conclusions unchanged) — regate-report.md §3.2.
- Tests: Phase3Retrieval.test.ts +18 executed tests (F1–F7, cues,
  ablations, anti-gaming invariant incl. fixture-2 identifiers); full
  suite 235 suites / 3132 tests green; build + eslint clean.

Phase 3 overall: still 🔴 BLOCKED — only G-3.1/G-3.5 (persisted store +
handle lifecycle per D-0021, ten executed-test criteria) remain. Phase 4
still blocked behind Phase 3. Full report:
docs/validation/spike-s/regate-report.md.

## Persisted store executed 2026-09-22 (D-0021 / D-0025) — G-3.1 + G-3.5 evidenced

`GraphSnapshotStore` (generation dirs + atomic pointer, durable handles, fail-closed
rejection, schema migration, safe cleanup) + store-backed `symbol_references` /
`semantic_graph_inspect` under the unchanged experimental gate. Two defects found and
fixed during execution: the tool result cache could mask stale handles (Phase 3 tools
are now non-cacheable), and gateway workers had no experimental plumbing
(`--experimental` / `SEMANTIC_ENGINE_EXPERIMENTAL`, allowlisted).

Evidence table (all executed, suite counts include these):

| D-0021 criterion | Evidence class | State |
|---|---|---|
| 1 restart save/restore | LOCALLY VERIFIED | 🟢 `GraphSnapshotStore.test.ts` |
| 2 durable handles | LOCALLY VERIFIED | 🟢 same |
| 3 stale/mismatch fail-closed | LOCALLY VERIFIED | 🟢 same (no fallback to current) |
| 4 kill-during-publication recovery | LOCALLY VERIFIED | 🟢 both crash points, tmp sweep, pointer never torn |
| 5 atomic/generation-dir publication | LOCALLY VERIFIED | 🟢 layout + pointer↔meta + counts |
| 6 incremental == full after restart | LOCALLY VERIFIED | 🟢 persisted == fresh rebuild, unchanged + changed inputs |
| 7 same scenarios via MCP/Gateway | MCP VERIFIED + GATEWAY VERIFIED | 🟢 `GraphSnapshotMcp.test.ts` (tools/call, restart, parity) + `GraphSnapshotGateway.e2e.test.ts` (real workers, real restart, stale via proxy) |
| 8 schema migration/versioning | LOCALLY VERIFIED | 🟢 v0→v1 migration; future schema rejected |
| 9 safe old-generation cleanup | LOCALLY VERIFIED | 🟢 idempotent; pointer target never deleted |
| 10 no silent partial serve | LOCALLY VERIFIED | 🟢 torn pointer/generation/counts → hard error; fresh store = null |

Frozen goldens re-run through the persisted path: regate.js STORE leg green on both
fixtures (graphEqual, handleResolves, taskParity — every task byte-identical to the
in-memory aware run).

Phase 3 executive summary: every blocking criterion now has executed evidence
(precision/recall/calibration per D-0024; store/handle lifecycle per D-0025; incremental
== full; unresolved registration). Build + eslint clean; **238 suites / 3144 tests
green**. Formal Phase 3 promotion in GATES.md awaits owner review (executive-report
rule). Phase 4 stays blocked until then.
