# Phase 2 implementation status

Revision target: branch `docs/audit-file-status` as pulled into the private drive.

## Implemented

- `Phase2Structural.ts`: deterministic structural-search adapter boundary, named metavariables, bounded results, rule-pack validation (JSON and constrained YAML), syntax-tree debug dump.
- `Phase2Transactions.ts`: source-independent edit model, UTF-16 ranges, expected-content hash checks, overlap rejection, dry-run unified diff, explicit approval token, atomic temp-file replacement, durable journal, rollback/undo, recovery listing, protected-path checks, and server-configured validators.
- `Phase2StructuralTools.ts`: `structural_search`, `structural_rule_test`, `syntax_tree_dump`, `edit_plan`, `edit_approve`, `edit_apply`, and `edit_rollback` registered through `AiToolRegistry`.
- Edit tools remain disabled unless `enablePhase2Edits` is explicitly enabled and a workspace root is supplied. Client input never supplies a command or validator.

## Tests written

- `src/core/codeintel/Phase2Structural.test.ts`
- `src/core/codeintel/Phase2Transactions.test.ts`

Coverage includes metavariable capture, deterministic ordering, result bounds, rule validation, line preservation, read-only preview, approval gating, stale snapshot rejection, overlap rejection, atomic apply, journal recovery, rollback, and protected paths.

## Not claimed

The structural adapter is intentionally dependency-free in this patch. It is an integration seam, not evidence of ast-grep runtime parity. MCP/Gateway execution, full/incremental producer parity, crash injection, validator process isolation, fuzz cycles, performance/RSS, build, lint, and tests require execution in a dependency-complete checkout and are not claimed here.

## Suggested focused execution

```bash
npx jest src/core/codeintel/Phase2Structural.test.ts --runInBand
npx jest src/core/codeintel/Phase2Transactions.test.ts --runInBand
npm run build
npm run lint
npm test -- --runInBand
npm run test:gate
```

Phase 2 status: `IMPLEMENTED / TESTS WRITTEN / NOT EXECUTED / GATE NOT ACCEPTED`.

## Gate closure 2026-09-21 — 🟡 CONDITIONAL

Validation on `c2c7396` (+ gate-closure fixes): all behavioral blocking
criteria evidenced — MCP e2e `structural_search → edit_plan → edit_approve →
edit_apply → edit_rollback` with byte verification, fuzz 1500/1500 byte-exact,
crash/partial-failure recovery, `UNDO_CONFLICT`, host-only validators, v1
regression green. Condition: G-2.1 — owner must ratify the dependency-free
matcher seam as the implementation (→ 🟢) or require ast-grep integration
(→ 🔴). Full report: `docs/validation/gate-closure-2026-09-21.md`.

## Owner decision 2026-09-22 — 🔴 BLOCKED UNTIL AST-GREP INTEGRATION

G-2.1 (D-0016 in `docs/DECISIONS.md`): AST-GREP REQUIRED. The dependency-free
matcher stays a temporary adapter boundary only and may remain solely as an
explicitly experimental fallback; it must not be described as
ast-grep-compatible. Phase 2 returns to 🔴 until a pinned `@ast-grep/napi`
(or CLI fallback) implementation is integrated with executed range/capture
coverage ($NAME, $$$ARGS, nested, multiline, UTF-16, CRLF, invalid syntax)
and parity with current fixtures, followed by full build/test/gate and
Spike-S on the real engine.

## Integration 2026-09-22 — D-0016 CONDITIONS MET, PROPOSED 🟢 (pending owner confirmation)

Pinned `@ast-grep/napi@0.45.3` integrated behind the unchanged contract;
executed matrix (23 engine tests + unchanged fixture parity + MCP rule e2e);
seam kept only as explicit experimental fallback with committed
not-compatible proof; full validation green (234/3114, gate exit 0, audit 0).
Non-blocking follow-up recorded: Python/PHP explicitly unavailable
(CLI-fallback or dynamic dylibs as future work).
Evidence: `docs/validation/ast-grep-integration-2026-09-22.md`.
On owner confirmation, next is Spike-S on the real engine.

## Owner confirmation 2026-09-22 — 🟢 ACCEPTED

D-0018: owner reviewed the ast-grep integration report and confirmed Phase 2
ACCEPTED (non-blocking follow-up: Python/PHP via future CLI-fallback or
dynamic dylibs). Spike-S authorized next.
