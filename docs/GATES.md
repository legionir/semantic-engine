# Phase 0–4 Gates

> **Note (2026-10-23):** the phase status reports, evidence directories, regate scripts/fixtures and plan/prompt documents cited below were removed from the tree as completed. They are recoverable from git history at commit `0d8d4cf`. Still-open work is tracked only in `docs/OPEN-ITEMS.md`.

**Revision:** `d1289aec99987065657c6ad824c900c7a7b36dc5` plan baseline
**Date locked:** 2026-09-21
**Owner:** Pouya Rahimi / project owner

Thresholds below are starting values from Appendix B. They are locked before measurement; changing one requires a dated entry in `DECISIONS.md` with reason, owner, scope and review date.

| Phase | Metric | Starting threshold | Blocking |
|---|---|---:|:---:|
| 1 | Fold L2 median token reduction for files >200 lines | ≥60% | Yes |
| 1 | Unfold correctness for all symbols | 100% | Yes |
| 1 | Determinism excluding stats | 100% | Yes |
| 1 | Read security tests | 100% | Yes |
| 1 | MCP text/structured parity | 100% | Yes |
| 1 | Warm vs cold outline | ≥5× | No |
| 2 | apply→undo fuzz | ≥1000 cycles, 100% byte equality | Yes |
| 2 | Crash-injection recovery | 100% | Yes |
| 2 | ast-grep Range conversion | 100% | Yes |
| 2 | Rejection of validator outside allowlist | 100% | Yes |
| 3 | Exact-class precision on gold fixture | ≥0.95 | Yes |
| 3 | Semantic incremental == full | 100% | Yes |
| 3 | Unresolved registration without silent deletion | 100% | Yes |
| 3 | Recall vs baseline | ≥B1 and >B0 | Yes |
| 4 | context_build recall@budget | ≥B1 and >B0 | Yes |
| 4 | No budget overrun | 100% | Yes |

## Gate semantics

- **🟢 ACCEPTED:** all blocking criteria have the required evidence level.
- **🟡 CONDITIONAL:** all blocking criteria pass; only explicitly owned, dated, non-blocking gaps remain.
- **🔴 BLOCKED:** any blocking criterion fails or lacks evidence.

Required evidence: data/functional metrics require `LOCALLY VERIFIED`; tool paths require `MCP VERIFIED`; lifecycle/worker paths require `GATEWAY VERIFIED`. A static type, schema, test file, README, or prompt is not evidence of completion.

## Summary (2026-10-24)

| Phase | State |
|---|---|
| 0 | 🟡 CONDITIONAL — two owned, non-blocking gaps (D-0014 set-atomic publication; read boundary not yet wired into MCP/HTTP) |
| 1 | 🟢 ACCEPTED |
| 2 | 🟢 ACCEPTED (D-0018) |
| 3 | 🟢 ACCEPTED (D-0026) |
| 4 | 🟢 ACCEPTED (D-0027) |

The detailed per-phase sections below are the historical record; the Phase 0 section describes the 2026-09-21 state.

## Current gate

**Phase 0: 🟡 CONDITIONAL** (updated 2026-09-21, continuation) — every executable check in
this repository now passes: `npm run test:gate` exits **0** with **222/222 suites and
3040/3040 tests**, `npm run build` and `npx eslint src` exit 0. The four pre-existing red
tests are root-caused and fixed (D-0010…D-0012); the artifact-integrity gate is wired on all
serve paths (D-0013). Thresholds above are untouched; nothing in this table was re-measured or
adjusted beyond what the cited suites execute.

What remains is, by the definitions above, **owned and dated, non-blocking**:

1. `check:audit` — unsatisfiable in-repo; its three input documents have never been committed
   here and must come from the owner (D-0015);
2. ~~true set-atomic publication~~ **CLOSED 2026-10-24** (D-0014): manifest commit point plus
   digest-addressed `generations/` copies; readers never see a torn pair;
3. ~~snapshot/handle runtime wiring~~ **CLOSED 2026-10-24**: `code_read` freshness handles answer
   `STALE_HANDLE` over MCP (`GraphSnapshotMcp.test.ts`), Phase 3 handles use `GraphSnapshotStore`;
   `InMemorySnapshotStore` stays the reference implementation of the contract;
4. apply→undo fuzz — NOT APPLICABLE until the feature exists (D-0015).

Evidence now exists (see `phase0-executed-evidence-2026-09-21.md`):

| Criterion | Evidence class | State |
|---|---|---|
| Determinism excluding stats | LOCALLY VERIFIED | 🟢 executed (`IncrementalParity.phase0.test.ts`) |
| Semantic incremental == full | LOCALLY VERIFIED | 🟢 executed (same suite; two defects found and fixed) |
| Read security tests | LOCALLY VERIFIED | 🟢 executed (`ReadBoundary.phase0.test.ts`, `fileProvider.test.ts`); port not yet wired into MCP/HTTP |
| MCP text/structured parity | MCP VERIFIED | 🟢 executed (`mcpIndexGeneration.test.ts`, `McpReadOnlyLifecycle.phase0.test.ts`) |
| Artifact consumption integrity | LOCALLY VERIFIED + MCP VERIFIED | 🟢 fail-closed on HTTP, MCP and CLI (`artifactManifest.test.ts`, `McpArtifactIntegrity.phase0.test.ts`); pair-level layout atomicity deferred (D-0014) |
| Build + full suite | LOCALLY VERIFIED | 🟢 `npm run build` exit 0; **`npm run test:gate` exit 0 — 222/222 suites, 3040/3040 tests** |
| Audit coverage gate (`npm run check:audit`) | — | 🔴 cannot run in-repo: the three input documents were never committed here; script now names the gap instead of ENOENT (D-0015); owner input required |
| apply→undo fuzz (Phase 2) | — | ⛔ no implementation exists in this revision |
| Gateway/worker lifecycle | GATEWAY VERIFIED | 🟢 existing suites (worker supervisor, worker CLI, project lock, protocol matrix) |

Named non-blocking gaps: the ten 🟡 rows of `phase0-test-coverage-matrix.md` (3, 4, 5, 7,
10, 13, 17, 18, 23, 24) each carry their missing half explicitly. The blocking items listed
earlier on this page (SE-P0-PUB-01 consumption, the four pre-existing red tests, the
0.8–0.10 documents) are closed. **Phase 1 may begin** under the precondition that the four
owner-level items in the verdict stay tracked and that the 🟡 rows' missing halves join the
Phase 1 backlog rather than being forgotten.

## Phase 3 — 🟢 ACCEPTED (updated 2026-09-22, executive closure under owner delegation)

All four blocking criteria of the table above are at their required evidence level, plus the
plan-level gaps G-3.1/G-3.5/G-3.9 that the 2026-09-21 closure report had named:

| Criterion | Evidence class | State |
|---|---|---|
| Exact-class precision on gold fixture ≥ 0.95 | LOCALLY VERIFIED | 🟢 macro P = 1.000, wrong-exact = 0 on the frozen 20-task gold fixture (`regate.js` → `results-regate.json`); unseen fixture-2 16/16 on first contact, zero tuning |
| Recall vs baseline ≥ B1 and > B0 | LOCALLY VERIFIED | 🟢 macro R = 1.000 vs B1 0.896 / B0 0.787; B0/B1 reproduced exactly (independence check); blind (cues off) 0.875 < B1 — the retrieval layer is necessary |
| Semantic incremental == full 100% | LOCALLY VERIFIED | 🟢 JSON deep-equal incl. through the persisted store after reopen (regate STORE leg, both fixtures) |
| Unresolved registration without silent deletion 100% | LOCALLY VERIFIED | 🟢 unresolved 2/2 per preregistered calibration; zero unclassified occurrences; ambiguity surfaced with candidates |
| G-3.1 persisted resolver state | LOCALLY VERIFIED | 🟢 `GraphSnapshotStore` — all ten D-0021 executed-test criteria (`GraphSnapshotStore.test.ts`); design `phase3-store/graph-store-design.md` |
| G-3.5 runtime/MCP handle lifecycle | MCP VERIFIED + GATEWAY VERIFIED | 🟢 durable handles, fail-closed stale/mismatch, restart reuse over real `tools/call` (`GraphSnapshotMcp.test.ts`) and through real gateway workers with real process restart (`GraphSnapshotGateway.e2e.test.ts`) |
| G-3.9 re-gate | LOCALLY VERIFIED | 🟢 `regate.js` freeze-hash verification, blind/aware/8-ablation matrix, calibration; 3 prediction errata reported, not tuned (`regate-report.md` §3.2) |

Build + eslint clean; full suite **238 suites / 3144 tests green** (2026-09-22). Thresholds in
the table above are untouched.

Dated notes (owned, non-blocking):

1. **This closure is an executive closure executed by the agent under the owner's standing
   delegation** (D-0023; reiterated 2026-09-22: «ادامه بده مطابق دستورالعمل», «کار درست رو
   انجام بده»). Per the standing rule, a gate-closure report is an executive report, not
   independent validation: every artifact it rests on is committed and reviewable — the harness
   (`docs/validation/spike-s/regate.js`), both result files, the store tests, and the final
   commits (merged via PR #15: `e4fdda9`…`af7a2a8`) — and any owner review of those logs may
   reopen this status.
2. The Phase 3 tools remain behind the `experimental['semantic-graph']` host opt-in. The gate
   pass is measured; flipping the default is a rollout decision, not an evidence gap.
3. F1 resolver approximations are syntactic by design (heuristic degradation, never a wrong
   `exact`); both fixtures scan cleanly with 0 heuristic references. Real-project scale was not
   measured here (pilot fixtures are 12–17 files) — carries into Phase 4 measurement.

**Phase 4 may begin.**

## Phase 4 — 🟢 ACCEPTED (updated 2026-09-22, executive closure under owner delegation)

| Criterion | Evidence class | State |
|---|---|---|
| context_build recall@budget ≥ B1 and > B0 | LOCALLY VERIFIED | 🟢 goal-aware `context_build_v4` over the frozen 20-task gold fixture: macro recall@2000 = **1.000** vs B1 0.896 / B0 0.896→0.787 (frozen Phase 3 baselines); name-only ablation 0.500 (< B0) — the Phase 3 semantic layer is what closes the gap (`phase4-regate.js` → `results-phase4-regate.json`) |
| No budget overrun | LOCALLY VERIFIED | 🟢 20/20 tasks budget-adherent (Σ estimated tokens ≤ budget); deterministic byte-equal builds; unit-tested budget rejection and protected-path denial |

The Phase 3 prerequisite is ACCEPTED (above, D-0026). `context_build_v4` now consumes the
measured Phase 3 retrieval layer (goal text selects direction/class only); the legacy
name-only path remains as the no-goal fallback. Rollout note: Phase 4 tools stay behind the
`experimental['controlled-expansion']` host opt-in (rollout decision, not an evidence gap).
Same executive-closure clause as Phase 3 (D-0026 honesty clause applies): agent-executed under
the owner's standing delegation; all artifacts committed and reviewable.

**Phase 0–4 gate order preserved; thresholds untouched.**
