# Phase 0 Boundary Revalidation — Static Evidence Only

**Revision:** `3af64db1fc84a014ed01e6f274d115d313932acc`
**Evidence class:** static repository inspection; no runtime claim.

| Boundary | Observed evidence | Classification |
|---|---|---|
| `ProjectIndex` types | `semantic-engine/src/core/types/project-index.types.ts`, blob `489e8481c8e11f31f064cec4d7cba14be516794d`; `schemaVersion: '2.0.0'`, `root`, optional `rootPath`, files/symbols/graphs/diagnostics/metrics and incremental metadata are present. | IMPLEMENTED surface; target Range/SymbolKey/Envelope conformance UNKNOWN |
| `IncrementalEngine` | `semantic-engine/src/incremental/IncrementalEngine.ts`, blob `c7f38f65ab91636f44dc00a60afc3a76edcc28a3`; serializes `applyChanges`, handles create/modify/delete/rename, rebuilds affected graph portions and clears incremental diagnostics. | IMPLEMENTED surface; parity, crash recovery, atomic publication and concurrency runtime UNKNOWN |
| MCP server | `semantic-engine/src/ai/mcp/SemanticEngineMcpServer.ts`, blob `a883a82244a108c861dbee13af8a5581ccf9ba20`; registers `tools/list`/`tools/call`, returns `content` plus `structuredContent`, tracks generation, watches/reloads index, exposes close. | IMPLEMENTED surface; MCP e2e, text/structured parity, lifecycle and stale-snapshot behavior UNKNOWN |
| Registry/reader | Paths `src/ai/AiToolRegistry.ts` and `src/ai/ProjectIndexReader.ts` exist in tree. | PATH-EXISTS only; direct content/test execution pending |
| Paths/registry | Paths `src/core/config/ProjectPaths.ts` and `ProjectRegistry.ts` exist in tree. | PATH-EXISTS only; confinement/identity runtime pending |
| Scanner/parser/output | Paths for `WorkspaceScanner`, `OutputWriter`, extractor managers and pipeline exist in tree. | PATH-EXISTS only; direct mapping and fixture execution pending |
| Gateway/worker | Gateway server/proxy and worker supervisor/process paths exist in tree. | PATH-EXISTS only; cancellation/dispose/Gateway verification pending |
| Filesystem port | `src/host/FileSystem.ts` and tests exist in tree. | PATH-EXISTS only; security execution pending |

## Static gaps requiring verification

1. Target UTF-16 `Range`/`LineIndex`, `SymbolKey`, `Handle`, envelope `trust`, and error/config mapping are not established by the inspected excerpts.
2. Existing `ProjectIndex` uses line-oriented symbol fields and existing IDs; additive mapping to the planned contracts is required and has not been decided from full source inspection.
3. The presence of serialized incremental updates and MCP reload code does not prove full/incremental equivalence, atomic publication, crash recovery, or transport correctness.
4. No defect or release decision is inferred from these static gaps.
