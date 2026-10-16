# ast-grep integration — implementation + evidence (2026-09-22)

Owner decision: D-0016 (G-2.1: AST-GREP REQUIRED). Implementation record:
D-0017. Contract: `CONTRACTS.md` ("Phase 2 ast-grep engine contract").
Findings: `findings-2026-09-22-astgrep.md` (F-11…F-13).
Evidence bundle: `docs/validation/evidence-astgrep/`.

## What changed (diff vs `34df0d3`)

- **Dependency:** `@ast-grep/napi` exactly `0.45.3` in `dependencies`
  (mandatory; pin test fails on drift). `npm audit`: 0 vulnerabilities.
- **New:** `src/core/codeintel/Phase2AstGrep.ts` — real engine behind the
  unchanged request/result contract (lazy native load, language map,
  UTF-16 ranges + bounds validation, `LineIndex`-derived line/column,
  `$`/`$$$` captures, deterministic ordering, honest errors).
- **Modified:** `Phase2Structural.ts` — `engine?: 'ast-grep' | 'legacy-seam'`
  (default ast-grep); seam renamed to `searchLegacySeam`, documented
  experimental and not-ast-grep-compatible. Tools/MCP never select it.
- **Modified:** `Phase2StructuralTools.ts` — F-11 (rule errors propagate,
  never `passed: true`) + F-12 (verbatim adapter errors, `IO_ERROR` reads).
- **Modified:** `src/host/packaging.test.ts` — SE-BUILD-10 allowlist extended
  with conscious-decision comment; test renamed to the verified invariant
  (F-13).
- **Tests:** `Phase2AstGrep.test.ts` (23: version pin, $NAME, $$$ARGS span +
  empty, nesting + order, duplicate-var, multiline, UTF-16 Persian/emoji,
  CRLF, lone-CR, broken source, unparseable pattern, bare-$$$ error, empty
  pattern/bounds, 4× unsupported language, truncation, determinism +
  ruleId, 3 parsers, metavar declaration, 2× legacy-seam incl.
  not-compatible proof). `Phase2Structural.test.ts` runs UNCHANGED on the
  new engine (fixture parity). `McpPhaseGating.test.ts` +1 (rule e2e on
  ast-grep + honest python failures over real `tools/call`).

## Executed validation (all stored with revision/env/output/exit code)

| Command | Result | Evidence |
|---|---|---|
| `npm run build` | ✅ exit 0 | `evidence-astgrep/02-build.log` |
| `npm run lint` | ✅ exit 0 (0 errors; 4 pre-existing warnings) | `…/01-lint.log` |
| `npm test -- --runInBand --silent` | ✅ 234 suites / 3114 tests, exit 0 | `…/04-test-full-final.log` |
| `npm run test:gate` | ✅ exit 0 | `…/05-test-gate.log` |
| `npm audit` | ✅ 0 vulnerabilities | (terminal; dep added clean) |
| fuzz ×1500 / precision / bench | ✅ all exit 0, numbers unchanged | `…/06-*.log` |

(`03-test-full.log` records the mid-work red run that surfaced F-13;
`04-…` is the final green run. `check:audit` still unsatisfiable — ENV-01,
owner inputs missing; unrelated to this integration.)

## D-0016 acceptance checklist

- [x] Pinned ast-grep implementation integrated (`0.45.3`, exact).
- [x] Range behavior covered by executed tests (UTF-16/CRLF/lone-CR with
      exact offsets; bounds validation at runtime).
- [x] Capture behavior covered (`$NAME`, `$$$ARGS` span+empty, duplicates,
      nesting, multiline).
- [x] Parity with current fixtures (existing suite green unmodified).
- [x] Seam retained ONLY as explicit experimental fallback, never
      ast-grep-compatible (contract + test proof).
- [x] Full build/test/gate green; no regression (suite count grew
      233→234, tests 3090→3114, zero failures).

## Status proposal (verdict authority: owner)

Phase 2 acceptance conditions from D-0016 are met with executed evidence.
Proposed: Phase 2 🟢 ACCEPTED with one recorded non-blocking follow-up
(Python/PHP structural search explicitly unavailable; CLI-fallback or
dynamic dylibs as future work). Awaiting owner confirmation; on
confirmation the next step is Spike-S on the real engine (plan §Spike-S,
branch-separated, no main migrations).
