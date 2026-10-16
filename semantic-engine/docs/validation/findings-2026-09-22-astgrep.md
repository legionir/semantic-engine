# Validation findings addendum — ast-grep integration (2026-09-22 Asia/Tehran)

Parent: `findings-2026-09-21.md` (F-01…F-10). Owner decision: D-0016 (G-2.1:
AST-GREP REQUIRED). Evidence bundle: `docs/validation/evidence-astgrep/`.

## Code findings (fixed and verified in this branch)

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| F-11 | High | `structural_rule_test` reported `passed: true` when a rule ERRORED (inner failure swallowed, zero rows look like pass) | FIXED + VERIFIED |
| F-12 | Medium | `structural_search` threw on IO/adapter errors instead of returning honest tool failures; adapter errors risked mislabelling downstream | FIXED + VERIFIED |
| F-13 | Medium | SE-BUILD-10 packaging gate red: new mandatory dep outside the explicit allowlist; test name ("pure JS") no longer stated the real invariant | FIXED + VERIFIED |

Details:

- **F-11** (`src/ai/tools/Phase2StructuralTools.ts`, `RuleTestTool`): the loop
  pushed `result.items` without checking `result.success`, so an
  `UNSUPPORTED_LANGUAGE`/`INVALID_PATTERN` rule contributed zero rows and the
  call returned `passed: true`. Fix: propagate the first failing rule's
  result verbatim. Evidence: new `McpPhaseGating` case (python rule →
  `UNSUPPORTED_LANGUAGE`, not `INVALID_RULE_PACK`, never `passed`).
- **F-12** (same file, `StructuralSearchTool`): `source()` and
  `searchTextStructurally()` throws propagated as rejections. Fix: read
  failures → `IO_ERROR` result (matching `SyntaxTreeDumpTool` idiom);
  adapter errors → verbatim result (preserving `UNSUPPORTED_LANGUAGE` /
  `INVALID_PATTERN` / `AST_GREP_*` prefixes). Evidence: `McpPhaseGating`
  python-search case returns `isError` with the honest message.
- **F-13** (`src/host/packaging.test.ts` + `package.json`): adding
  `@ast-grep/napi@0.45.3` (mandatory per D-0017) broke the explicit
  allowlist, as designed. Fix: allowlist extended with a conscious-decision
  comment; test renamed to the real invariant (no install-time
  download/build — verified: binary inside tarball, no install scripts).
  Evidence: `packaging.test.ts` 29/29.

## Verified API facts (from installed `@ast-grep/napi@0.45.3` types + probes)

- Built-in napi parsers: Html, JavaScript, Tsx, Css, TypeScript ONLY
  (`No Python/PHP`; `parse('Python', …)` throws `not supported in napi`).
  Dynamic languages need compiled dylibs (`registerDynamicLanguage`).
- `node.range().*.index` is UTF-16, not bytes as the `.d.ts` comment claims
  (Persian/emoji/CRLF probes; `slice(start, end) === text()`).
- Engine line/column ignores lone `\r`; adapter derives line/column from
  `LineIndex` instead (contract authority).
- Unparseable patterns match nothing (no throw); bare `$$$A` throws a clear
  error; error-tolerant parse finds matches in broken sources; repeated
  `$X` enforces identical text; `$$$` bindings include anonymous nodes
  (adapter uses span, not join).
- No install/postinstall scripts; platform `.node` inside the tarball;
  platform packages are optional with `os`/`cpu` guards.

## Not done (recorded follow-up, not gaps in this integration)

- Python/PHP structural search via CLI fallback or dynamic dylibs.
- `syntax_tree_dump` remains a deterministic line-dump stub (pre-existing,
  out of G-2.1 scope); a real S-expression dump via `root().toString()` is
  available as future work.
- `strictness` tuning: default string-pattern strictness is used and pinned
  by behavioral tests; no requirement to expose it was set.
