# Gate closure — Phases 1–4 validation (2026-09-21, UTC)

Canonical plan: `docs/semantic-engine-codeintel-execution-plan.md`
Revision validated: `c2c7396d93022db649412fb6dc0c390700ef7c6a`
Environment: Node v22.22.3 · npm 10.9.8 · Linux x86_64 (see `evidence-c2c7396/environment.txt`)
Findings: `docs/validation/findings-2026-09-21.md` (F-01…F-10 fixed+verified; ENV-01, FLK-01 recorded; VULN-01 cleared)
Evidence scripts: `docs/validation/scripts/` (run against `dist/`, outputs in `evidence-c2c7396/`)

Final validation state (all commands executed, outputs + exit codes stored):

| Command | Result | Evidence |
|---|---|---|
| `npm ci` | ✅ exit 0, 0 vulnerabilities | `40-ci-final.log` |
| `npm run build` | ✅ exit 0 | `41-build-final.log` |
| `npm run lint` | ✅ exit 0 (0 errors; 4 pre-existing warnings in untouched files) | `42-lint-final.log` |
| `npm test -- --runInBand --silent` | ✅ 233 suites / 3090 tests, exit 0 | `50-test-full-final2.log` |
| `npm run test:gate` | ✅ exit 0 | `51-test-gate-final2.log` |
| `npm run check:audit` | ❌ exit 1 — inputs never committed (ENV-01, pre-existing) | `52-check-audit-final2.log` |
| fuzz apply→undo ×1500 | ✅ byte-exact, exit 0 | `53-final2-fuzz-apply-undo.js.log` |
| Phase 3 precision probe | ✅ exact precision 1.0 ≥ 0.95, exit 0 | `53-final2-phase3-precision.js.log` |
| Phase 4 bench + fold/unfold | ✅ PASS, exit 0 | `53-final2-phase4-bench.js.log` |

---

## Phase 1 — v1 Index and Platform → 🟢 ACCEPTED

Blocking criteria (plan §Phase 1), each with executed evidence:

- `ProjectIndex` and schema/type in sync and versioned — `schemaSync` +
  contract suites pass in the full run; Phase 1 is purely additive
  (no second source of truth; all producers read `ProjectIndexReader`).
- full/incremental, file deletion, partial states, atomic publication —
  `33-parity-publication.log` (IncrementalParity, Publication, OutputWriter,
  IncrementalEngine, IndexPipeline: 65/65); Phase 1 `snapshotId` is a pure
  function of `(path, contentHash)`; MCP reload keeps serving the last
  manifest-consistent snapshot (fail-closed pair check).
- Deterministic output — fold/context/outline byte-equal across repeated runs
  (`53-final2-phase4-bench.js.log`: `foldDeterministic`,
  `contextDeterministic`); canonical ordering unit-tested.
- Unfold 100% correct — 402/402 lines of the real 402-line
  `src/util/large.ts` re-read via `code_read` and byte-compared
  (`unfoldLinesVerified: 402, unfoldExact: true`).
- Fold L2 reaches threshold — 63.14% ≥ 60% on the >200-line file
  (`foldFile: src/util/large.ts`, `foldPass: true`, not truncated).
  Honest scope note: the fixture contains exactly one >200-line file, so
  n=1; a wider corpus measurement is future work, not a gap in the claim.
- `broken` fixture without crash, partial outline — `Phase1Platform`
  diagnostics tests pass (9/9).
- Read security tests 100% — `ReadBoundary.phase0`, source-guard, traversal /
  stale-handle / denylist tests pass; `code_read` refuses `../secret` and
  stale handles (MCP-level too).
- Registry, MCP, lifecycle with correct identity/generation — **MCP VERIFIED**:
  `tools/list` exposes all 10 Phase 1 tools, `tools/call` executes them with
  `structuredContent.indexGeneration` (`SemanticEngineMcpServer.test.ts`,
  5/5); **Gateway**: server + protocol-matrix + multi-project suites pass
  (20/20, `34-gateway.log`).
- Performance below threshold is non-blocking — measured, not thresholded:
  fold 4.4 ms, context 4.7 ms, impact 28.6 ms, references 22 ms on a
  58-file/200-symbol real index; sampled RSS peak ≈ 74 MB.

Non-blocking gaps recorded (accepted with rationale, no owner waiver needed
for 🟢 but listed for the record):

- **G-1.2**: adapter status reporting exists, but grammar versions are not
  pinned and per-adapter conformance snapshots do not fail on grammar change.
- **G-1.7**: `GenerationOwnership` CAS guard is implemented and unit-tested but
  not wired into any producer/worker path (atomic publication itself is
  evidenced via OutputWriter + manifest digest).
- **G-1.14**: cold/warm ≥5× ratio unmeasured (non-blocking by Appendix B).

## Phase 2 — v2 Structural Search and Safe Mutation → 🟡 CONDITIONAL

Blocking criteria, each with executed evidence:

- Search without mutation, clear scope/provenance — `structural_search` is
  read-only, path/language-scoped, deterministic with capture metadata; MCP e2e
  (`McpPhaseGating.test.ts`).
- Diff preview changes no file — byte-verified between plan and apply in MCP e2e.
- Apply only after approval + valid precondition — `APPROVAL_REQUIRED` /
  `STALE_SNAPSHOT` enforced and tested; F-08 cache bypass keeps repeat calls
  honest (replay provably fails instead of returning stale success).
- Failure/crash → zero corruption, zero unrecoverable half-commit — fuzz
  1500/1500 apply→rollback byte-exact; partial-failure restore via fault
  injection (read-only directory); cross-instance journal recovery
  (`Phase2FuzzRecovery.test.ts` + `53-final2-fuzz-apply-undo.js.log`).
- Explicit rollback/undo conflict — F-10: disk-verified `after[]` hashes,
  `UNDO_CONFLICT` on any post-apply change, conflicting bytes preserved;
  `edit_status` exposes journal state read-only.
- Range conversion 100% — the matcher reports UTF-16 spans of the matched code
  span (JS string indices by construction); Unicode/emoji/CRLF covered by
  seeded fuzz and transaction tests. (ast-grep–specific conversion is N/A —
  see G-2.1.)
- Validator allowlist 100% — validators are host-constructed only; tool inputs
  carry no command/validator path (extra fields provably ignored, MCP test).
- Overlay, validator, MCP contract with evidence — overlay planning without
  persistence tested; full `structural_search → edit_plan → edit_approve →
  edit_apply → edit_rollback` path executed over real `tools/call` with byte
  verification and journal-artifact assertion.
- v1 regression green — full suite 3090/3090.

Condition (one open gap, requires owner ratification):

- **G-2.1** — plan step 2.1 expects a pinned real ast-grep engine
  (`@ast-grep/napi` or CLI fallback) and rules "no dependency = BLOCKED". The
  implementation is a deliberately dependency-free matcher implementing the
  documented line-pattern + `$NAME`/`$$$ARGS` subset contract (declared scope
  in `phase2-implementation-status.md`), with all behavioral criteria above
  evidenced. The gate judges the verdict on the acceptance criteria (all
  passing) and records G-2.1 as a scope decision for the owner: ratify the
  seam as the implementation (then 🟢) or require ast-grep integration
  (then 🔴 until integrated). Strict-reading note preserved so the owner can
  overrule this 🟡 to 🔴.

## Phase 3 — v3 Semantic Graph Pilot → 🔴 BLOCKED (remains EXPERIMENTAL)

Evidenced and passing:

- `exact` precision 1.0 ≥ 0.95 on the gold micro-fixture (unique import
  resolution; same-name export in a non-target file does not poison it).
- `incremental == full` (conservative full-rebuild fallback; never a stale
  partial graph) — unit-tested and script-evidenced.
- Ambiguity/unresolved never hidden — `ambiguous` with candidates,
  `unresolved` retained with reasons; file-dep resolution flags explicit.
- Exactly-once `exact` labeling discipline — name-only matching is never
  labeled `exact`.
- MCP e2e over real `tools/call` (`symbol_references`); experimental gating
  (`experimental['semantic-graph']`) verified closed-by-default and
  open-with-flag; works on the real 58-file pipeline index (F-09 fixed).
- Determinism + snapshot binding unit-tested.

Blocking criteria NOT met (genuine scope gaps, not code defects):

- **G-3.1 / G-3.5** — plan requires persisted resolver state and a
  backup/fixture-tested migration with rollback/recovery. The pilot is
  stateless by design (deterministic recompute from index + source); there is
  no graph store and therefore no migration. Owner decision required: accept
  stateless recompute as the pilot design (removing persistence from the
  claim) or require the store + migration work.
- **G-3.7** — recall vs baselines unmeasured: B0/B1 baselines, the 20-task
  gold set, calibration-per-class, and comparison with the 0.10 adopted tool
  do not exist (no Spike-S was executed). Precision is evidenced only on a
  micro-fixture. This is 1–2 weeks of eval work, not gate-closure work.
- **G-3.9** — adopt-vs-build decision for Phase 4 is missing.

Per the plan ("Gate v3 pilot: عدم عبور = قابلیت EXPERIMENTAL"), the pilot
correctly remains experimental-gated, which is its current implemented state.
No promotion beyond experimental until G-3.1/G-3.5/G-3.7/G-3.9 are resolved.

## Phase 4 — Controlled Expansion → 🔴 BLOCKED (remains EXPERIMENTAL)

Evidenced and passing:

- Safety contract: all Phase 4 tools hidden unless
  `experimental['controlled-expansion'] === true`; context needs workspaceRoot;
  rename needs `enablePhase2Edits` + workspaceRoot and only *plans* (apply
  still requires the Phase 2 approval token + journal); all output marked
  untrusted. Verified over real MCP `tools/call`, closed and open.
- Determinism + hard budget adherence: `context_build_v4` byte-equal across
  runs, 84/2000 tokens used, `omittedSummary` present.
- Provider status explicit (`degraded`/`unavailable`, no silent gaps).
- MCP executability of status/impact/context tools on the real index.

Blocking reasons:

- **Prerequisite unmet**: Phase 4 may only gate after the Phase 3 gate; Phase 3
  is 🔴, so no Phase 4 capability can be accepted now.
- **Quality criteria unmeasured**: `context_build` recall@budget vs B0/B1,
  ablations, and the PPR/ranking model of plan §4.4 are not implemented (the
  builder uses exact/qualified-name seed matching, honestly documented) and
  not measured. Each §4.1–4.9 capability still needs its contract, fixture,
  failure state, security boundary, metric, and rollback evidence.
- The implementation is present and safety-evidenced; the verdict concerns
  gate passage, not code breakage. Everything stays behind the experimental
  flag.

## Final status

```text
Phase 1: 🟢 ACCEPTED (3 non-blocking gaps recorded: G-1.2, G-1.7, G-1.14)
Phase 2: 🟡 CONDITIONAL (1 owner decision pending: G-2.1 ast-grep seam ratification)
Phase 3: 🔴 BLOCKED / REMAINS EXPERIMENTAL (G-3.1, G-3.5, G-3.7, G-3.9)
Phase 4: 🔴 BLOCKED / REMAINS EXPERIMENTAL (prerequisite + unmeasured quality criteria)
Release approval: NOT GRANTED
```

Next work, in gate order (no new capabilities, no Phase 5):

1. Owner rules on G-2.1 (ratify seam → Phase 2 🟢; require ast-grep → integrate).
2. Execute Spike-S (gold tasks + B0/B1 baselines) to unblock G-3.7/G-3.9.
3. Owner rules on G-3.1/G-3.5 (stateless pilot vs persisted store + migration).
4. Only then: Phase 3 re-gate → Phase 4 per-capability gates.
