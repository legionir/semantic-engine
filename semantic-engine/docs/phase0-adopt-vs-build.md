# Phase 0 — Adopt vs Build (step 0.10)

Date: 2026-09-21 · Branch: `arena/01a0c3c9-semantic-engine-structured-ai`

The dependency surface is deliberately tiny: **8 runtime dependencies**.
Everything else in the graph/pipeline/security/AI layers is built in-house.
This document records the split and the reason, so Phase 1 does not re-litigate
it by accident.

## Adopted (external, kept)

| Package | Why adopted | Boundary |
|---|---|---|
| `@modelcontextprotocol/sdk` | The MCP wire protocol and server lifecycle; reimplementing JSON-RPC session semantics adds risk with zero differentiating value | Wrapped: all tool calls go through `AiToolRegistry.executeWithValidation`; SDK never touches the index directly |
| `web-tree-sitter` | Incremental parsing of many languages; grammars are maintained upstream | Wrapped in `symbols/tree-sitter/`; tree-sitter output is normalized to internal `SymbolEntry` before entering the index |
| `typescript` (API, `~5.9.3`) | TypeScript resolution (`import-resolved` edges), type relationships | Wrapped in `dependencies/typescript/`; provenance recorded per edge |
| `vscode-jsonrpc` | LSP client transport | `lsp/LspClient`; language servers are separate OS processes, never linked in |
| `chokidar` | Cross-platform fs watching with rename semantics | `host/FileWatcher`; debounce/ignore logic in-house |
| `minimatch` | ignore-file glob semantics | `core/config/IgnoreMatcher` |
| `ajv` + `ajv-formats` | JSON-schema validation of the artifact format | `export/schemaValidation`; the schema itself is in-house |
| `typescript` language server (external process) | LSP enrichment, resolution, diagnostics | spawn-only via `lsp/` |

## Built in-house (do NOT replace with a dependency without a DECISIONS entry)

| Subsystem | Why built |
|---|---|
| `ProjectIndex` artifact shape, `OutputWriter` publication, manifest/generation protocol | The artifact IS the product contract; publication ordering and fail-closed reading (SE-P0-PUB-01, `artifactManifest.ts`) are correctness-critical |
| `IncrementalEngine` / `ProjectIndexStore` | Parity with full rebuild is a hard requirement (rename parity defects SE-P0-PARITY-01/02 lived here); an off-the-shelf cache cannot know symbol identity |
| `GraphQueryEngine`, `FactStore`, `LayeredGraph` | Multi-layer BFS with provenance-weighted edges (فاز ۴۷ criterion; D-0010) has no library equivalent without re-shaping the model |
| `SourceSecurityGuard`, confinement/denylist policy (incl. `ConfinedFileProvider`) | Security policy belongs to us; SE-P0-SYM-01 (cyclic symlink) is proof that subtle edges matter |
| AI tools (14), `ContextRanker`, `TokenBudget`, discovery | The tool semantics are the MCP product surface |
| Contract layer (`codeintel`, `ports`, `fileProvider`, `snapshotStore`) | Frozen, tested contracts are the interoperability surface for Phase 1 |
| Hashing embeddings (`HashingEmbeddingGenerator`) | Zero-dependency vectors for offline operation (فاز ۴۴) |
| Visualization mapping (`LodService`, `GraphViewModelMapper`) | Consumes the canonical graph vocabulary directly (D-0011) |

## Rules going forward

1. New runtime dependency ⇔ a DECISIONS entry with the adopt-vs-build
   analysis (supply-chain cost vs. correctness cost).
2. External processes (LSP servers) stay spawn-only; nothing binary is
   linked into this package.
3. Anything that touches the artifact format, publication, or symbol
   identity stays in-house.
4. Test-only dependencies (jest/ts-jest/eslint) do not count against the
   runtime surface but follow the same DECISIONS rule.
