# Traceability matrix — gate-closure review (2026-09-21/22)

Scope: diff `c2c7396` (validated) → `3d4f64e` (gate-closure), 75 files.
Source changes: 14 modified + 3 new test suites + `package-lock.json`.
Review question per row: does the claimed fix exist in the diff, is it covered
by an executed test, and do the stored logs show fail-before / pass-after?

## Finding → files → tests → evidence

| Finding | Changed files (diff c2c7396..HEAD) | Covering tests (executed) | Fail-before → pass-after logs |
|---|---|---|---|
| F-01 build TS2345 | `src/ai/tools/Phase4ControlledTools.ts` (`metadata: { ...e }`) | Full build itself (no unit test; type-level) | `00-build-prefix-f01-fail.log` (exit 2, TS2345 @22,293) → `01-build.log`, `41-build-final.log` (exit 0) |
| F-02 `ProjectInfoTool.execute({})` TS2554 | `src/ai/tools/Phase1ReadTools.ts` (optional `_input`) | `Phase1ReadTools.test.ts` (suite was dead, now 6/6) | `11-focused-ai-tools.log` (suite failed to run) → `22-…-Phase1ReadTools.log` (6/6), `50-…` PASS |
| F-03 structural matcher empty | `src/core/codeintel/Phase2Structural.ts` (span matching + `$NAME` tokenizer) | `Phase2Structural.test.ts` 4/4 (unmodified) + `McpPhaseGating` search step | `10-focused-Phase2Structural.log` (exit 1, 2 failed) → `22-…-Phase2Structural.log` (4/4) |
| F-06 fixture contradiction | `src/ai/tools/Phase1ReadTools.test.ts` ONLY (2 lines: `endLine` 2→4) | Same suite; `enclosingSymbol: s1` assertion unchanged, now passes | Same logs as F-02 (failure surfaced after F-02 fix) |
| F-07 MCP opt-in missing | `src/ai/mcp/SemanticEngineMcpServer.ts` (options + reload preservation), `src/ai/mcp/cli.ts` (`--allow-edits`, `--experimental` + allowlist map) | `McpPhaseGating.test.ts` (default-closed + opt-in e2e) | No pre-fix log (gap found by inspection); post: new suite 4/4 in `50-…` |
| F-08 mutation cache | `src/ai/AiToolRegistry.ts` (`NON_CACHEABLE_TOOLS`: plan/approve/apply/rollback/status) | `McpPhaseGating` replay-apply (`STALE_SNAPSHOT`) + post-rollback status (`rolled_back`) | Caught during validation (stale `applied` observed); post: e2e green |
| F-09 `::` in FQN crash | `src/core/contracts/codeintel.ts` (`sanitizeKeyPart`) + `Phase1Platform.ts`, `Phase3SemanticGraph.ts`, `Phase1ReadTools.ts` (2 sites), `Phase4Controlled.ts` (2 sites) | `SymbolKeyMapping.test.ts` 3/3 + bench `referencesSuccess` | `32-phase4-bench.log` history: `referencesSuccess: false` (`IO_ERROR … must not contain "::"`) → `53-final2-phase4-bench.js.log` (`referencesSuccess: true`, BENCH GATE: PASS) |
| F-10 undo conflict + status | `src/core/codeintel/Phase2Transactions.ts` (`after[]`, `UNDO_CONFLICT`), `src/ai/tools/Phase2StructuralTools.ts` (`EditStatusTool`), `src/ai/AiToolRegistry.ts` (registration) | `Phase2FuzzRecovery` conflict case + `McpPhaseGating` status assertions | No pre-fix log (gap found by criterion audit vs plan §2.11); post: suites green in `50-…` |
| VULN-01 4 audit findings | `package-lock.json` ONLY (`package.json` untouched: fast-uri 3.1.8, hono 4.13.8, qs 6.16.0, js-yaml bump) | Full suite re-run (regression) | `35-audit-prefix.log` (4 vulns) → `36-audit-fix.log` (0) → `40-ci-final.log` (0) + `50-…` (233/3090) |
| ENV-01 check:audit inputs | — (none; owner must supply docs) | — | `05-check-audit.log`, `52-check-audit-final2.log` (exit 1, same missing files) |
| FLK-01 LspClient timing | — (none; pre-existing, untouched) | Isolation re-run | `03-test-full.log` (1 fail) → `13-lspclient-rerun.log` (28/28) + 3 later full runs clean |
| Lint hygiene | `Phase1ReadTools.ts`, `Phase4Controlled.ts` (dead imports/const removed) | — | `02-lint.log` (0 err/9 warn) → `42-lint-final.log` (0 err/4 warn, all pre-existing) |

## Independent re-verification performed (2026-09-22)

Each report claim was re-checked against the stored artifacts (not trusted):

1. Final counts: `50-test-full-final2.log` = 233 suites / 3090 tests, 0 `FAIL`,
   exit 0. (Report-correction note: an interim summary cited 3088; the two
   F-10 tests account for the difference. 3090 is correct.)
2. `test:gate`: `04-…` exit 1 → `24-…`/`51-…` exit 0 with "all suites ran".
3. Fuzz: `53-final2-fuzz-apply-undo.js.log` = 1500 cycles, 1495 applied,
   5 skipped no-ops, `byteExact: true`.
4. Precision: `exactPrecision: 1`, `pass: true`.
5. Bench: `BENCH GATE: PASS`, fold `0.6314 ≥ 0.60`, unfold `402/402`,
   `contextWithinBudget: true`, both determinism flags true.
6. Parity/publication: 65/65; gateway: 20/20; MCP suites: all pass.
7. Diff contains every claimed fix (spot-grep per finding, all positive);
   `package.json` byte-identical (lockfile-only audit fix confirmed).
8. Only ONE pre-existing test file modified (`Phase1ReadTools.test.ts`, the
   documented F-06 2-line fixture correction — no assertion was weakened;
   the `enclosingSymbol` expectation is unchanged). All other coverage is
   additive (3 new suites, all PASS in the final run).
9. Worktree used for the F-01 reproduction was removed; `git worktree list`
   shows only the main checkout; working tree clean.

## Discrepancy found and corrected during this review

- **R-01 (evidence pointer, corrected)**: `findings-2026-09-21.md` cited
  `01-build.log` as the F-01 *failure* log, but that file holds the post-fix
  *passing* build (correctly labeled inside). Root cause: the original failure
  run's `tee` targeted a not-yet-existing evidence path, so only terminal
  output existed. Remedy: reproduced the failure on a pristine detached
  worktree at `c2c7396` (verified clean, no modifications) and stored it as
  `00-build-prefix-f01-fail.log` — byte-identical error (TS2345 @22,293,
  exit 2). Findings doc pointer corrected. No code or verdict affected.

## Residual review notes (for the owner)

- R-02: `01-build.log`'s filename suggests "first build" but content is the
  post-F-01-fix build; the in-file header is accurate. Kept as-is for
  append-only evidence integrity; this matrix documents the ordering.
- R-03: F-07/F-10 pre-fix states have no failing-run logs (found by code
  inspection / criterion audit, not by a red test). Their post-fix coverage
  is executed and green; a reviewer wanting fail-before proof can revert the
  single-hunk fix and re-run the named suite.
- R-04: G-2.1 (ast-grep seam ratification) is still the pending owner
  decision. Nothing in this review changes the gate verdicts:
  P1 🟢 · P2 🟡 · P3 🔴/experimental · P4 🔴/experimental · release NOT GRANTED.
