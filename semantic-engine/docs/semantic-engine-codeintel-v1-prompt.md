# PROMPT — Semantic Engine Code Intelligence v1 (Project-Adapted)

## 0. Purpose and status

This document adapts `codeintel-v1-prompt.en.md` to the existing `semantic-engine` package in the `legionir/semantic-engine-structured-ai` repository.

It is an **implementation specification and verification contract**, not evidence that the current repository already satisfies these requirements. Existing behavior, schemas, tools, and execution plans must be read and verified before changing them. Do not replace the existing engine with a parallel implementation.

Target package:

```text
semantic-engine/
```

The package currently presents itself as a semantic code-indexing platform exposing symbols, dependencies, graphs, diagnostics, AI-facing tools, MCP, CLI, project/Gateway lifecycle, and derived artifacts. The current package metadata and source are the authority for actual behavior; README claims and this prompt are not runtime evidence.

## 1. Non-negotiable working method

1. Before implementation, create or update `semantic-engine/docs/DECISIONS.md` and `semantic-engine/docs/CONTRACTS.md`. Preserve existing contracts; record every intentional incompatibility.
2. Establish a reproducible baseline before editing:
   - exact Git revision and branch;
   - Node/npm versions;
   - dependency lockfile hash;
   - package scripts and their exact commands;
   - generated-artifact policy;
   - current test/build/lint/validation results, including exit codes.
3. Read installed package type definitions and the current implementations before relying on any third-party API. Do not infer runtime behavior from names, README prose, or test names.
4. Work in small, reversible stages. Each stage must include implementation, focused tests, build/type validation where applicable, and captured evidence.
5. Never claim measured compression, latency, coverage, compatibility, or correctness without executing the measurement and recording its output.
6. Do not silently remove existing tools, schema fields, migration behavior, CLI flags, Gateway routes, MCP fields, or consumer compatibility. Additive changes are preferred.
7. Unknown or unexecuted behavior is `UNKNOWN / REQUIRES VERIFICATION`, not a defect and not a pass.
8. Do not modify production data, use real credentials, or run destructive migrations. Cache/artifact rebuilds must use isolated fixtures or an explicitly disposable test directory.

## 2. Product context and target outcome

`semantic-engine` is a standalone package nested in a monorepo. Its output is a project index and related derived artifacts consumed by:

- the semantic-engine library and CLI;
- AI tools registered through `AiToolRegistry`;
- the stdio MCP server;
- the HTTP/Gateway and dashboard layers;
- external or sibling Structured-AI consumers.

The target v1 outcome is a reliable, deterministic, evidence-producing semantic index service that can:

- scan a project within an explicit root and policy;
- extract files, symbols, imports/exports, diagnostics, and graph edges;
- preserve provenance and confidence for inferred data;
- expose stable, validated AI-tool and MCP contracts;
- support full and incremental indexing without stale consumers;
- provide bounded context assembly and semantic retrieval;
- survive project selection, worker, restart, and artifact-reload workflows;
- report limitations instead of presenting partial or heuristic data as authoritative.

The target is **not** a new generic `codeintel` product. Existing semantic-engine behavior remains the compatibility baseline unless a documented migration explicitly changes it.

## 3. Scope adapted to semantic-engine

### 3.1 In scope

- Workspace/project registration, canonical identity, selection, and lifecycle.
- Scanner and file-policy behavior: roots, ignore rules, generated/binary/oversized files, encoding, symlink/traversal policy where implemented.
- Parser and extractor adapters already supported by the package; language support must be discovered from source/configuration and reported per language.
- Project index schema v2 and its validator, including files, symbols, diagnostics, metrics, imports/exports, and graphs.
- Symbol extraction and stable IDs; file/symbol parent-child relationships.
- Dependency graph, reverse dependency graph, call graph, type graph, and edge provenance/confidence.
- Full and incremental indexing, invalidation, removed files, partial output, and artifact atomicity.
- SQLite/vector/JSON artifacts only where they are part of the existing implementation; derived artifacts must never be treated as source truth.
- AI tool registry, input validation, result caching, cache invalidation, context assembly, discovery, search, impact analysis, explain/find tools, mutation simulation, architecture checks, and related tools actually registered by the package.
- MCP stdio transport, `tools/list`, `tools/call`, structured content, `projectId`, `indexGeneration`, and reload/watch behavior.
- CLI, HTTP/Gateway, worker supervision, project persistence, and dashboard behavior when these are part of the selected acceptance path.
- Deterministic evaluation, contract tests, MCP end-to-end tests, fixture tests, benchmark measurements, and artifact/schema validation.

### 3.2 Explicit non-goals for this adaptation

- Do not introduce the original prompt's `codeintel`-specific L0–L4 fold API unless a compatibility need is first demonstrated and the new API is additive.
- Do not replace `ProjectIndex` with the original prompt's `OutlineNode[]` plus SQLite-only model.
- Do not remove existing graphs, diagnostics, vector chunks, Git metadata, AI metadata, or schema provenance fields in favor of a smaller model.
- Do not claim reference resolution, LSP diagnostics, call-graph completeness, semantic search quality, or architecture detection are complete merely because a type or tool exists.
- Do not add file-writing/editing tools in v1. Read-only and simulation behavior remain the default.
- Do not implement new language injections, watchers, databases, embeddings, or providers solely because they are listed in the source prompt. Add them only through a documented requirement and adapter/feature gate.
- Do not audit or change the sibling `structured-ai` product unless the execution scope explicitly includes it. Cross-repository consumer behavior is an evidence boundary.

## 4. Architecture and source-of-truth rules

The intended flow is:

```text
ProjectRegistry / CLI / Gateway
  → project root and artifact policy
  → scanner and parser/extractor pipeline
  → ProjectIndex v2
  → JSON/schema validation + derived artifacts
  → ProjectIndexReader / AiToolRegistry
  → AI tools and cache
  → MCP stdio / HTTP / CLI consumers
```

Required rules:

1. `ProjectIndex` and `semantic-engine/contracts/project-index.schema.json` must remain synchronized. Schema changes require a migration/version decision and corresponding TypeScript type/test updates.
2. `root` and `rootPath` must not be conflated. The short project name is not a readable filesystem root.
3. Filesystem access must go through the existing project/file policy boundary. AI tools and consumers must not bypass it with direct storage access.
4. Blueprint/context artifacts are derived from the project index unless an explicit contract says otherwise. They must not silently become a second source of truth.
5. Each graph edge must expose its basis/provenance and confidence. Heuristic name matching must remain distinguishable from AST, import-resolved, LSP, or TypeScript-derived edges.
6. Partial, truncated, skipped, unavailable, and not-run states must be represented explicitly. Empty data must not mean both “none found” and “not analyzed.”
7. Index replacement and manifest/generation updates must be atomic from a consumer's perspective. A watcher must never expose a partially written snapshot as valid.
8. A long-lived MCP registry must not serve stale index data after a full or incremental rebuild. Cache invalidation must be tied to a verified project/index identity, not only process lifetime.
9. Project context must remain attached to every Gateway worker, MCP server, tool execution, artifact path, and continuation/reload path.
10. Existing public names and aliases may be retained for compatibility, but there must be one validated execution path for each tool.

## 5. Stable contracts

### 5.1 Project index envelope

The canonical index remains schema version `2.0.0` unless a migration is explicitly approved. At minimum, validate:

```ts
interface ProjectIndex {
  schemaVersion: '2.0.0';
  root: string;
  rootPath?: string;
  generatedAt: string;
  generatorVersion?: string;
  languages: readonly string[];
  languageSupport?: Readonly<Record<string, {
    symbols: 'full' | 'structural' | 'heuristic';
    callGraph: boolean;
  }>>;
  incremental?: {
    mode: 'full' | 'incremental';
    baseGeneratedAt: string | null;
    changedFileIds: readonly string[];
    removedFileIds: readonly string[];
  };
  diagnosticsRun?: {
    filesWithFindings: number;
    filesSkippedByBudget: number;
    budgetMs: number;
    completedAt: string;
  };
  files: readonly FileEntry[];
  symbols: readonly SymbolEntry[];
  graphs: Graphs;
  diagnostics: readonly Diagnostic[];
  metrics: ProjectMetrics;
}
```

The exact schema is authoritative. This excerpt is a compatibility reminder, not permission to omit optional or newly added fields.

### 5.2 File and symbol identity

- File IDs must be stable for the same normalized relative path and project identity.
- Symbol IDs must be stable across body-only changes and must not silently change because of array order, timestamps, or generated output ordering.
- If the existing ID algorithm cannot guarantee this, document the observed limitation and add a versioned migration rather than silently changing IDs.
- `line`/`endLine` are 1-based in the current type contract; any new offset/range API must state whether offsets are UTF-16 code units, bytes, or code points.
- `hash` and `contentHash` must be used for staleness/change detection only as their contract states; never use a content hash as the identity of a logical symbol/chunk unless explicitly intended.

### 5.3 Tool result contract

Preserve the current `AiToolOutput` success/error shape and validate inputs through the canonical validator. For every registered tool, document:

- exact name and aliases;
- input schema and rejected inputs;
- project/index snapshot used;
- whether output is full, partial, heuristic, cached, or unavailable;
- error behavior and retryability;
- deterministic ordering;
- cache key and invalidation conditions;
- whether file content is returned as untrusted data.

The original prompt's `ToolOk/ToolErr` envelope may be adopted only as an additive compatibility envelope. It must not break existing `success`, `error`, `items`, structured-content, or MCP consumers.

### 5.4 MCP contract

The MCP server must continue to support stdio and the SDK version pinned in `semantic-engine/package.json`. `tools/list` and `tools/call` must be tested against the installed SDK.

Every successful structured result should identify, where available:

- `projectId`;
- `indexGeneration`;
- index/schema version;
- partial/degraded state;
- provenance/confidence where the tool returns inferred graph or symbol data.

`content` text and `structuredContent` must remain semantically compatible. A consumer that only reads text must not receive a different answer from a consumer reading structured content, except for explicitly documented serialization metadata.

### 5.5 Determinism

Sort files, symbols, graph edges, diagnostics, and tool result lists using documented stable tie-breakers. Exclude timestamps, process IDs, unordered object traversal, and random IDs from semantic output. Timestamps may appear only in explicitly temporal metadata and benchmark stats.

## 6. Scanner, parser, and index pipeline

1. Establish the current scanner boundary and supported language adapters from source and fixtures. Do not infer support from README claims.
2. Record grammar/parser versions and adapter versions in generated metadata or an equivalent verifiable manifest.
3. Preserve file metadata needed for invalidation: normalized path, size, modification data where reliable, full-content hash, language, truncation/binary/generated state, and parser/extractor version.
4. A truncated file must remain visibly partial. Its hash may cover the full file, but symbols and metrics derived from a prefix must not be represented as complete.
5. Full indexing must account for additions, modifications, renames where supported, and removals. An incremental index must not retain symbols, edges, vectors, or diagnostics from removed files.
6. Parse failures should retain best-effort output only when marked partial and accompanied by diagnostics. A parse error must never be silently converted to “no symbols.”
7. If an optional provider or grammar is missing, report `unavailable` or `degraded` and continue only where the contract permits.
8. Artifact output must be written atomically and validated before publication. Corrupt or incompatible derived artifacts must be recoverable from source files.

## 7. AI tools and context behavior

The registry is the single execution path. Each built-in tool must be tested through the registry and, where applicable, through MCP. The current registry includes tools for symbol lookup, dependencies, file summaries, semantic search, context assembly/discovery, impact analysis, explanation, tests, recent changes, configuration usage, mutation simulation, architecture violations, and Git hotspots; the exact set must be obtained from source at implementation time.

For context-building tools:

- enforce project scope and path boundaries;
- state whether content is raw, summarized, generated, or heuristic;
- preserve symbol/file provenance;
- apply deterministic size/token budgets;
- degrade by dropping lower-priority details first, never silently cutting a semantic record;
- report truncation and omitted counts;
- ensure a cache hit cannot cross project or index-generation boundaries;
- verify that `assemble_context` and `discover_context` do not disagree on the source-of-truth index.

For semantic/vector search:

- distinguish unavailable provider, empty index, no match, and failed query;
- bind embeddings to model/version and content hash;
- test stale-vector invalidation after file/symbol changes;
- do not present heuristic or lexical fallback results as equivalent to vector results.

## 8. Project/Gateway/runtime lifecycle

Where the selected scope includes Gateway/runtime:

- registration must persist all lifecycle-relevant fields, including `autoStart` if supported;
- process restart must deterministically restore registry state and the intended worker state;
- project IDs, roots, worker arguments, artifact directories, and MCP metadata must remain aligned;
- concurrent starts must be idempotent and capacity-bounded;
- stop/cancel must prevent a worker from later publishing a stale `completed` state;
- reload/watch must handle atomic rename sequences and transient incomplete files without replacing a valid snapshot with invalid data;
- dashboard fields must map one-to-one to the API payload actually sent;
- displayed statistics must either be sourced from the worker/index or be explicitly labeled unavailable, never hard-coded as real counts;
- every advertised UI action must have a verified server route and an end-to-end test.

These are acceptance requirements to verify against the current code, not claims that they currently pass.

## 9. CLI and API compatibility

Preserve existing commands and flags unless a migration is documented. At minimum verify the actual package scripts and entry points for:

```text
build / compile / lint / test / test:gate / fixture / validate / snapshot / check:audit / benchmark
```

The adapted project does not inherit the original prompt's `codeintel outline|fold|read|find|search` CLI. If these capabilities are useful, expose them through existing semantic-engine commands or add explicitly versioned aliases after checking collision and consumer impact.

## 10. Evaluation and benchmark requirements

Add or maintain deterministic evaluation that measures, rather than assumes:

1. schema validation success and rejected-invalid-fixture count;
2. full vs incremental index equivalence on unchanged files;
3. removed-file cleanup;
4. symbol/file ID stability across body-only edits and deterministic re-runs;
5. graph-edge provenance and confidence distribution;
6. tool result determinism, cache hit/miss behavior, and generation invalidation;
7. MCP `tools/list` and every registered `tools/call` result shape;
8. context/token reduction for representative repositories, reporting chars and token estimator used;
9. cold/warm indexing and query latency, p50/p95, peak RSS, file count, and fixture characteristics;
10. restart, worker, project-scope, artifact-reload, and cancellation behavior when runtime scope is enabled.

Starting targets may be configured, but they are not pass criteria until measured on named fixtures. Never fabricate benchmark values. Reports must separate static, test-executed, local runtime, CI, and production evidence.

## 11. Required fixtures and tests

Use existing fixtures first; add only minimal isolated fixtures when a missing contract requires one. Tests should cover:

- project identity and canonical-root collision;
- root/path separation and path boundary behavior;
- JavaScript/TypeScript and every language adapter actually supported by the repository;
- Unicode, mixed line endings, BOM, tabs, and large/truncated files;
- generated/binary/ignored files;
- syntax errors and partial index semantics;
- file/symbol ID stability;
- import/export and graph provenance;
- full/incremental additions, changes, and removals;
- schema version mismatch, corrupt artifact recovery, and atomic publication;
- cache hit/miss, project isolation, generation invalidation, TTL/size bounds;
- vector/model/content-hash invalidation where vector search is enabled;
- MCP stdio end-to-end, tools/list, every registered tool, structuredContent, and error paths;
- Gateway registration, restart/hydration, worker scope, cancellation, dashboard/API mapping, and advertised routes where enabled;
- deterministic output and benchmark smoke tests.

Tests that are conditionally skipped must report the reason and must not be counted as runtime coverage without executing the guarded path.

## 12. Staged Definition of Done

A stage is complete only when all implementation, integration, tests, build/validation, and acceptance evidence for that stage are green. Suggested order:

### Stage 1 — Baseline and contracts

- freeze revision/dependency/runtime baseline;
- inventory current commands, schemas, tools, adapters, artifacts, and consumers;
- write decisions/contracts and compatibility matrix;
- capture current failures and evidence gaps.

### Stage 2 — Index correctness

- schema/type synchronization;
- path/root and identity correctness;
- scanner/parser partial-state semantics;
- full/incremental equivalence and removed-file cleanup;
- atomic artifact publication.

### Stage 3 — Graph and metadata integrity

- provenance/confidence;
- symbol/file identity stability;
- diagnostics and language-support status;
- vector/Git/AI metadata correctness where enabled.

### Stage 4 — AI tools and MCP

- one validated registry path;
- deterministic tools and bounded context;
- cache/generation invalidation;
- MCP text/structured-content compatibility and full tool matrix.

### Stage 5 — Runtime/project lifecycle

- persistence and restart hydration;
- worker/project scope;
- cancellation/reload/watch behavior;
- dashboard/API action and statistics parity.

### Stage 6 — Evaluation, benchmark, and release evidence

- run build, lint, tests, validation, gates, benchmark, and MCP smoke tests;
- capture exact commands, outputs, exit codes, environment, and artifact paths;
- publish measured limitations and unresolved blockers;
- issue no release approval unless all required gates are actually verified.

## 13. Required final report

The final report must include:

- exact revision and environment;
- files and contracts changed;
- measured command results with exit codes;
- test/build/lint/validation/benchmark/MCP evidence;
- schema and migration status;
- full vs incremental correctness results;
- tool and cache matrix;
- runtime/Gateway evidence or explicit unverified status;
- known limitations, deferred work, deviations from this prompt, and rollback instructions;
- a verdict of `VERIFIED`, `PARTIALLY VERIFIED`, or `NOT VERIFIED` with the evidence boundary.

No section may call the project production-ready solely because source code or tests exist.

## 14. Differences from the original CodeIntel v1 prompt

| Area | Original CodeIntel v1 | Semantic-engine adaptation |
|---|---|---|
| Product shape | New standalone Node library + MCP + CLI | Existing nested package in a monorepo with library, CLI, MCP, HTTP/Gateway, workers, and dashboard |
| Primary output | Outline/fold/read model | `ProjectIndex` v2 with files, symbols, diagnostics, metrics, graphs, provenance, vectors, Git and AI metadata |
| Source of truth | Disk scanner plus derived SQLite cache | Existing index/artifact pipeline; schema and source files remain authoritative; derived artifacts are disposable |
| Languages | Explicit TS/TSX/JS, Python, PHP adapters | Discover and preserve the repository's real adapter set; do not claim or add languages without evidence |
| Parsing | New `ParserPort` and parser pool | Reuse and verify current scanner/parser/extractor pipeline; add adapters only through existing boundaries |
| Ranges | UTF-16 offset/position contract | Existing model is line-based; add offsets only with an explicit additive contract and unit definition |
| Symbols | `SymbolKey` based on path/qualified name/kind | Existing stable file/symbol IDs and parent IDs; preserve IDs and version changes if stability is insufficient |
| Folding | L0–L4 fold engine and unfold handles | Not inherited. Context assembly/discovery and file/symbol tools are the relevant existing capabilities |
| Storage | SQLite derived-data cache, no CST | JSON/schema/index artifacts plus any existing SQLite/vector stores; verify each artifact's ownership and recovery path |
| Tool names | New snake_case `code_*` tools, max ten | Preserve the current registered AI tools and aliases; inventory exact names before changing contracts |
| Envelope | New `ok/data/warnings/stats/snapshotId/trust` envelope | Preserve current `success/error/items` and MCP content/structuredContent; add metadata additively |
| Snapshot | Hash over sorted path/content hashes | Existing `generatedAt`, project identity, artifact manifest, and `indexGeneration` must be reconciled into one verified freshness contract |
| Search | Text search with enclosing symbol | Existing semantic/vector/search tools; distinguish vector, lexical, heuristic, empty, unavailable, and stale states |
| Persistence | Cache DB migrations | Project registry, manifests, index artifacts, worker lifecycle, and cache/vector persistence require separate recovery and migration evidence |
| Runtime | No VS Code host; stdio server and CLI | Standalone package plus optional HTTP/Gateway, worker supervision, dashboard, and sibling consumer boundaries |
| Evaluation | Compression/unfold/retrieval gate | Add schema, incremental, graph provenance, cache invalidation, MCP contract, project scope, restart, and artifact consistency gates |
| Security | Scanner denylist and root confinement | Preserve existing project/path policies and add read-only AI/MCP/Gateway boundary verification; do not silently expand security scope |
| Release gate | `npm run build && npm test`, eval, bench | Use actual package scripts (`build`, `test`, `test:gate`, `validate`, `benchmark`, etc.) and record skipped/conditional suites |
| Forward compatibility | v2 structural search, v3 semantic graph | Existing engine already exposes graphs, context, vectors, and AI tools; compatibility means schema/tool/consumer stability and versioned migration |

## 15. Evidence boundary

At the time this prompt is written, the adapted requirements are a target specification. Existing forensic audit material identifies implementation observations and evidence gaps, but it does not substitute for executing the package's build, tests, runtime, MCP, Gateway, persistence, or benchmark paths. Every future status must preserve the distinction between:

- implemented in source;
- merged into a branch;
- executed locally;
- executed in CI;
- verified at runtime;
- verified against a real consumer.
