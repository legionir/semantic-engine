# Phase 4 — Controlled Expansion Status

## Scope implemented

This increment adds an opt-in, additive Phase 4 slice:

- `Phase4ProviderRegistry`: explicit provider status for TypeScript/JavaScript/TSX/Python and a conservative Python heuristic provider;
- `Phase4ConstraintGraph`: deterministic constraints (`calls`, `enclosingClass`, `dependsOn`, `hasTest`) derived from the existing `ProjectIndex`;
- `Phase4ContextBuilder`: bounded, deterministic context selection with snapshot identity, omitted summary, and untrusted-source marking;
- `Phase4ImpactAnalyzer`: provenance-preserving impact results with heuristic filtering;
- `Phase4SemanticRenamer`: exact-only, approval-gated `EditPlan` producer backed by `TransactionalEditEngine`;
- registry exposure behind `experimental.controlled-expansion`.

## Safety contract

The Phase 4 tools are not exposed by default. They are enabled only when the host explicitly sets `experimental.controlled-expansion: true`. Rename planning never writes files; applying a plan still requires the existing Phase 2 approval token and transaction journal. All source-derived output remains untrusted.

## Test inventory

- `src/core/codeintel/Phase4Controlled.test.ts`
- `src/ai/tools/Phase4ControlledTools.test.ts`

Coverage includes provider status, deterministic Python extraction, graph provenance, context budget/snapshot, invalid input, and tool validation. Full test execution, build, MCP/Gateway execution, precision/recall, benchmark/RSS, crash injection, and rollback execution are **NOT VERIFIED** in this environment.

## Gate status

```text
Phase 4 implementation: IMPLEMENTED
Focused tests: WRITTEN / NOT EXECUTED
Build/typecheck: NOT VERIFIED
MCP/Gateway: NOT VERIFIED
Performance: NOT MEASURED
Semantic rename runtime rollback: NOT VERIFIED
Phase 3 prerequisite gate: NOT VERIFIED
Phase 4 gate: 🔴 BLOCKED / NOT ACCEPTED
```

This document does not waive the Phase 3 prerequisite. Each additional Phase 4 capability still requires its own contract, fixture, failure-state, security boundary, metric, rollback evidence, and dated acceptance decision before it can be promoted beyond experimental status.

## Gate closure 2026-09-21 — 🔴 BLOCKED / REMAINS EXPERIMENTAL

Validation on `c2c7396` (+ gate-closure fixes): safety contract evidenced over
real MCP calls (experimental gating, approval-gated rename planning, untrusted
marking), deterministic budget-adherent context building, explicit provider
status. Blocked because the Phase 3 prerequisite gate is unmet and quality
criteria (recall@budget vs B0/B1, ablations; PPR/ranking not implemented) are
unmeasured. Per-capability gates under plan §4.1–4.9 still required.
Full report: `docs/validation/gate-closure-2026-09-21.md`.

## Gate measurement 2026-09-22 (D-0027) — 🔴 → 🟢 ACCEPTED (executive)

The Phase 3 prerequisite gate is ACCEPTED (D-0026). `context_build_v4` now consumes the
measured Phase 3 retrieval layer (goal-aware candidates; name-only fallback; fail-closed
unknown seed). Measured on the frozen 20-task gold fixture (`phase4-regate.js`,
freeze-hash verified): macro recall@2000 = **1.000** (R≥B1 0.896 ✓, R>B0 0.787 ✓),
budget adherence 20/20 ✓, deterministic ✓. Name-only ablation: 0.500 (< B0) — the
semantic layer is what closes the gate. Unit tests: 2 added (11 total in the Phase 4
suites). GATES.md Phase 4 section records the executive closure under the D-0026 honesty
clause. Results: `docs/validation/spike-s/results-phase4-regate.json`.
