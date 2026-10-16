# Semantic Engine Code Intelligence v3

> **Status:** Specification and verification contract only. This document does not prove that any v3 feature is implemented, installed, tested, or production-ready.
>
> **Target package:** `@aicoder/semantic-engine` (`semantic-engine/` in the existing repository)
>
> **Compatibility rule:** additive-only. Existing v1/v2 meanings, tools, schemas, scripts, lifecycle, and security boundaries remain valid.

## 0. Purpose and evidence boundary

Semantic Engine v3 adds a confidence-aware semantic index and graph above the existing index, structural-search, and transactional-edit capabilities. It specifies reference/import extraction, module resolution, optional demand-driven LSP resolution, graph storage and queries, ranking, context construction, semantic constraints, and semantic rename.

This is a **specification/verification contract**, not an implementation report. The following status vocabulary is mandatory in implementation reports:

| Label | Meaning |
|---|---|
| `TARGET` | Required by this document but not established in the repository inventory. |
| `DEPENDENCY` | Requires a pinned package, executable, adapter, or host capability; availability must be inspected. |
| `CONTRACT` | Required public behavior/type/schema; source presence alone is not verification. |
| `VERIFICATION` | A test, command, fixture, benchmark, or MCP/Gateway execution that must produce evidence. |
| `FACT` | Established by the adapted v2 specification/repository inventory, reproduced without implying v3 completion. |
| `EXPERIMENTAL` | A feature whose gate has failed, is unavailable, or has not yet produced required evidence. |

No section may say “implemented”, “green”, “supported”, or “complete” unless an evidence artifact demonstrates it. A type, migration file, or test is not runtime verification.

## 1. Existing repository facts and preserved source of truth

The following are facts carried forward from the adapted v2 specification; they are not newly re-inventoried by v3:

- Package identity is `@aicoder/semantic-engine`, version `0.1.0`, with Node `>=20` in the inspected package metadata.
- The package structure includes `src/ai`, `src/core`, `src/host`, `src/incremental`, `src/pipeline`, `src/runtime`, `src/scanner`, `src/server`, `src/gateway`, `src/symbols`, `src/dependencies`, `src/graphs`, `src/vector`, `contracts/`, `test/golden/`, and existing scripts.
- Canonical project data is `ProjectIndex`, schema `2.0.0`, defined by `contracts/project-index.schema.json` and `src/core/types/project-index.types.ts`.
- `ProjectIndex` is line-based for its existing `SymbolEntry` (`id`, `fileId`, `parentId`, `kind`, `name`, optional qualified name/signature, line/endLine, source, confidence). v3 must add offsets/ranges without replacing line semantics.
- `ProjectRegistry`, `ProjectIdentity`, `ProjectPaths`, and `DataRootResolver` define project identity, canonical workspace roots, artifact roots, registry state, manifests, locks, logs, and compatibility SQLite locations. New code must use them, never reconstruct paths independently.
- `AiToolRegistry` is the single AI-tool execution path. The established `AiToolOutput` shape (`success`, optional `error`, `items`, optional `context`, optional `metadata`) remains the outer envelope. `executeWithValidation` remains a compatibility alias for `execute`.
- `SemanticEngineMcpServer` is the existing MCP transport and supports `tools/list`, `tools/call`, text content, additive `structuredContent`, project identity, index generation, index watching/reload, and blueprint loading.
- The indexing lifecycle is `ProjectRegistry/CLI/Gateway → workspaceRoot/ProjectPaths → WorkspaceScanner → parser/extractor managers → IndexPipeline/IncrementalEngine → ProjectIndex → OutputWriter/artifact manifest → ProjectIndexReader/AiToolRegistry → MCP/HTTP/Gateway/CLI`. `JobManager`, `IndexingWorker`, `WorkerSupervisor`, `GatewayServer`, and `ProjectLock` remain in that lifecycle.
- `FileSystemPort`/`NodeFileSystem` provide atomic artifact writes, temporary handling, fsync-before-rename, stale temporary cleanup, and streaming JSON serialization. These guarantees do not by themselves prove multi-file edit transaction guarantees.
- Existing security includes root canonicalization, safe project IDs, data-root separation, scanner ignore/symlink-cycle handling, HTTP access controls, authentication/origin checks, request validation, and secret redaction. v3 extends these controls.
- The inspected package had scripts such as `build`, `compile`, `watch`, `lint`, `test`, `test:gate`, `fixture`, `validate`, `snapshot`, `snapshot:update`, `check:audit`, and `benchmark`; it did not establish `eval` or `bench`. Additive aliases may be proposed, but must not be claimed until added and executed.
- The v2 inventory did not establish that ast-grep, YAML, diff, fast-check, or zod were installed. v3 likewise must inspect and pin dependencies rather than assume them. Existing declared dependencies included `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `chokidar`, `minimatch`, `typescript`, `vscode-jsonrpc`, and `web-tree-sitter`; optional tree-sitter grammars and `usearch` were noted.

### 1.1 Branch, package, and path preservation

Implementation must preserve the current repository package, branch, directory layout, package name, and existing entry points. This document must not be interpreted as permission to create a standalone CodeIntel package or second MCP server. New files belong under the existing package and its documented `docs/`, `contracts/`, `src/`, `test/`, and migration boundaries.

Before implementation, record exact branch/revision, Node/npm versions, lockfile hash, package scripts, and configuration source paths. If those differ from the v2 inventory, record the discrepancy; do not silently update the fact table.

## 2. v1/v2 compatibility baseline

### 2.1 Compatibility contract

1. Preserve all v1 parsing, outline, fold, read, MCP, and evaluation meanings.
2. Preserve all v2 structural-search, overlay, source-independent edit-plan, diff, transactional apply, verification, validator, journal, undo, recovery, and MCP meanings that are actually established by implementation evidence.
3. Contracts are additive-only: new tools, config keys, error codes, tables/migrations, adapter methods, metadata, and optional fields only.
4. Existing line numbers remain line-based and 1-based as previously specified. New offsets/ranges must state encoding and units.
5. Preserve `AiToolOutput`, existing tool names, registry validation/caching/invalidation behavior, MCP text and `structuredContent`, `projectId`, and `indexGeneration` behavior.
6. Do not bypass `ProjectRegistry`, `ProjectPaths`, `ProjectIndex`, `IncrementalEngine`, `OutputWriter`, Gateway scope, worker locks, or overlay/file-provider boundaries.
7. A successful edit does not imply a fresh index; after mutation the result must say whether reindex/publication ran.
8. Existing defaults remain unchanged unless a new namespaced default is explicitly specified.
9. Unknown, unavailable, degraded, partial, and not-run states must remain representable.

### 2.2 v2 extension points consumed by v3

| Existing v2 extension point | v3 use | Compatibility requirement |
|---|---|---|
| `ConstraintProvider` | Graph constraints for structural search | Keep v2 `NOT_SUPPORTED` behavior where no provider is available; return confidence per edge. |
| Source-independent `Edit[]`/`EditPlan` | `edit_plan_rename` producer | Reuse overlap, preconditions, diff, apply, verification, validators, journal, and undo; do not add rename assumptions to the transaction engine. |
| Reusable outline diff | Rename verification | Add unresolved-count expectation without replacing structural verification. |
| Overlay provider | Context/search/rename source provenance | Never assume disk is the only source. |
| Project/index generation metadata | Semantic result freshness | Every index-derived result carries project identity and generation or explicit unavailable state. |
| Existing tool/MCP envelope | All new tools | New fields go in additive `metadata`/`structuredContent`; existing consumers still receive the established envelope. |

## 3. v3 versus v2

| Area | v2 baseline/adaptation | v3 addition and status rule |
|---|---|---|
| Semantic model | Line-based `ProjectIndex`, symbols, existing graphs/dependencies | Additive refs, confidence-tagged resolution, semantic edges, unresolved records; `TARGET` until migration and query evidence exist. |
| Resolution | No semantic multi-file rename; constraint provider extension only | TS/JS, Python, PHP module resolvers; heuristic provider; optional LSP provider; all must degrade safely. `DEPENDENCY/TARGET`. |
| Storage | Existing index/artifact rules; v2 edit persistence only if migration executed | New numbered migration for refs, edges, unresolved, file deps, FTS, tests map. `TARGET`; never assert SQLite/FTS5 exists before migration evidence. |
| Incrementality | Existing incremental files/symbols/graphs cleanup | Dirty propagation and `incremental == full` semantic equivalence. `VERIFICATION`. |
| Search | Structural ast-grep adapter and outline filters (v2 target) | BM25 symbol search and graph constraints. ast-grep, FTS5, and adapters are dependencies/targets unless proven. |
| Ranking | No v3 ranking contract | Deterministic personalized PageRank, roles, anchors, calibrated defaults. `TARGET`. |
| Context | v2 preserves context extension points | `context_build`/`context_expand`, budgets, fold levels, handles, sessions, dedup. `TARGET`. |
| Rename | v2 explicitly non-goal | Confidence-aware `edit_plan_rename`, conflicts, skipped sites, unresolved expectation. `TARGET`; reuses v2 transaction path. |
| Tests/Git/folds | Existing tests, Git metadata and v2 fold extension points | Test edges, allowlisted Git diff/status, two fold plugins. `TARGET`/`VERIFICATION`. |
| Evaluation | Existing `validate`/`benchmark`; no established `eval`/`bench` script | Gold tasks, B0/B1/B2, calibration, ablation, gates, latency and coverage. Add aliases only with evidence. |
| Scale | Benchmark is existing but scope must be inspected | End-to-end lifecycle profile; workers/streaming/interning only if justified by measurements. |

## 4. Non-goals

- Do not build compact NodeStore/arena, vector/embedding search, injection across HTML+JS/CSS, PHP+HTML, Vue/Svelte, query-by-example, community detection, team-shared graph artifacts, or full custom type inference.
- Do not replace tree-sitter indexing with ast-grep; if ast-grep is used, it is an additive adapter and dependency requiring API inspection.
- Do not treat LSP as a whole-repository indexing engine. It is demand-driven, bounded, optional, and degradable.
- Do not claim semantic certainty from name matching. Ambiguity and unresolved references are first-class persisted states.
- Do not change existing ProjectIndex source-of-truth or line semantics.
- Do not allow arbitrary commands, unrestricted Git subprocesses, shell interpolation, path escape, or writes outside project/security policy.
- Do not make LSP, FTS5, adapters, eval/bench, or fold plugins appear available merely because this document names them.
- Do not claim absence from the repository; absence statements must say “not found in the indexed graph (confidence: `<class>`)”.
- Do not implement a new standalone MCP or tool invocation path.

## 5. Working method and dependency verification

Before implementation:

1. Capture branch/revision, environment versions, lockfile hash, scripts, configuration, and baseline command outputs.
2. Read the adapted v1/v2 specifications, contracts, ProjectIndex schema/types, AI tool registry/types, MCP server, ProjectPaths/Registry, filesystem/output writer, incremental engine, runtime lifecycle, adapters, and tests.
3. Inspect and pin dependency versions and official types/docs before calling APIs. Candidates include FTS-capable SQLite, `fast-check`, an LSP JSON-RPC client/server, language parsers/adapters, and any existing ast-grep integration. No candidate is a fact of availability.
4. Record decisions in `docs/DECISIONS.md` and additive contracts in `docs/CONTRACTS.md`. Record rejected alternatives and capability gaps.
5. Run the established baseline commands that actually exist. Do not report `npm test`, `npm run eval`, or `npm run bench` as successful unless each exists and was executed; map requested commands to existing `validate`/`benchmark` only in the report.
6. Make all defaults deterministic. Capture command output, exit code, environment, fixture/repository identity, and artifact paths.

## 6. Semantic contracts

### 6.1 Core types

```ts
type Confidence = 'exact' | 'heuristic' | 'ambiguous' | 'unresolved';
type EdgeKind = 'imports' | 'calls' | 'extends' | 'implements' | 'references' | 'tests';
type ResolvedVia = 'lsp' | 'import-graph' | 'scope' | 'name-only';

interface Reference {
  fromFile: string;
  fromSymbolKey?: string;
  name: string;
  range: Range;
  kind: 'call'|'type'|'read'|'write'|'import'|'extends'|'implements';
  qualifier?: string;
}

interface ResolvedRef {
  ref: Reference;
  targetKey?: string;
  confidence: Confidence;
  via: ResolvedVia;
  candidates: { key: string; score: number }[];
}

interface SemanticProvider {
  id: string;
  languages: string[];
  status(): { state: 'ok'|'degraded'|'unavailable'; reason?: string };
  resolve(refs: Reference[], ctx: ResolveContext): Promise<ResolvedRef[]>;
}

interface ModuleResolver {
  language: string;
  resolve(specifier: string, fromFile: string, ctx: ResolveContext): {
    path?: string; external?: string; confidence: Confidence;
  };
}
```

`Range` must be additive to the line-based model and explicitly define start/end units, encoding, inclusivity, and conversion behavior. Every serialized confidence and `via` is required where a result asserts a relation.

### 6.2 Resolution rules

- `exact`: definite local scope, an import binding resolving to exactly one exported symbol through a module resolver, or LSP-confirmed resolution.
- `heuristic`: a single unconfirmed candidate, including a typed `this.field.method()` inference.
- `ambiguous`: multiple viable candidates; preserve candidates and scores.
- `unresolved`: no candidate; persist it in `unresolved`, never silently discard it.
- LSP may upgrade a result to `exact`, but unavailable/failed servers yield provider state `degraded` and warnings, never a crash.
- LSP is only requested around seeds/targets with timeouts and bounded concurrency.

### 6.3 Required adapters and resolvers

Adapters gain additive `extractReferences(ctx): Reference[]`. Begin with existing tree-sitter `tags`/`locals` conventions and an explicit walker. Required resolver targets are:

- TS/JS: `tsconfig` `paths`/`baseUrl`, Node resolution, package.json workspaces.
- Python: relative imports, packages, and `src` layouts.
- PHP: Composer PSR-4 autoload.

Config files are resolver inputs, not symbols. Existing adapter availability is not established by this specification; each adapter requires implementation and fixture evidence.

### 6.4 Provider policy

`HeuristicProvider` is the intended default provider, subject to implementation evidence. `LspProvider` is optional/on-demand and must have launch configuration, timeout, bounded concurrency, cancellation, process security, and degraded-state behavior. Any missing language server is a warning, not a fatal indexing error.

## 7. Graph and storage contract

### 7.1 Additive persistence

Add a new numbered migration only after inspecting active persistence. Do not alter ProjectIndex migrations or claim a SQLite backend until the migration has run. If SQLite is not the active/appropriate store, use a documented durable store under `ProjectPaths` artifact/data policy with equivalent semantics.

Required logical records:

```sql
refs(id PK, file_path, from_key, name, kind, start, end, qualifier)
edges(src_key, dst_key, kind, confidence, via, file_path)
unresolved(file_path, name, kind, start, end, reason)
file_deps(file_path, dep_path, kind)
symbol_fts(name, qualified_name, doc, path) -- FTS5 only if selected backend proves support
tests_map(test_file, target_key, confidence)
```

Keys, uniqueness, indexes, migration number, project identity, generation, retention, and transaction semantics must be documented. `refs` ranges use the canonical additive range contract. FTS5 is a `DEPENDENCY/TARGET`, not a repository fact.

### 7.2 Graph semantics

Edges are directed `src_key → dst_key`, carry `kind`, `confidence`, `via`, and source file where applicable. Ambiguous edges may preserve candidate relations only if their confidence remains explicit. Unresolved references are records, not edges to invented nodes. Query outputs include confidence and via.

### 7.3 File and test edges

`file_deps` supports dirty propagation. Test edges combine path/name heuristics (`*.test.ts`, `tests/`, `test_*.py`, `*Test.php`) with references from test files. Heuristics must be labeled and golden-tested.

## 8. Incremental indexing and equivalence

On file change, re-extract definitions/references for that file, then use `file_deps` to re-resolve dependents without re-parsing unchanged dependents. Invalidate ranking caches by dependency hash. Removed files must clean their refs, edges, unresolved records, deps, FTS rows, and test mappings.

**Required verification:** run a scripted edit sequence over fixtures and compare a fresh full reindex with incremental output after every step. Equality covers symbols, references, edges, unresolved records, file dependencies, and test edges, after deterministic normalization. Any mismatch fails the gate and marks incremental semantic indexing `EXPERIMENTAL`.

SymbolKey stability verification must show body/signature edits preserve keys; rename/move changes keys and emits a mapping. Existing stable IDs remain compatible; do not introduce a competing key model without an additive mapping.

## 9. Ranking and roles

Use deterministic personalized PageRank/random walk with restart from seeds. Defaults: damping `0.85`, fixed iteration/epsilon, stable key tie-break. These are starting contract values, not calibration results. Anchors are always included. Edge weights vary by kind/confidence; ambiguous/unresolved relations are low-weight. Configurable bonuses include direct caller/callee, same class, related tests, Git-changed files, and a penalty for unrelated same-name symbols.

Roles are presets over seeds and weights: `planner`, `implementer`, `reviewer`, `debugger`, and `custom`. Reviewer should boost changed files and tests only if the ablation supports it. Defaults must be selected by eval ablation and written to configuration with the winning evidence; hand-picked defaults are not sufficient.

Ranking output must be deterministic across runs, preserve confidence and reasons, and not claim semantic relevance solely from score.

## 10. `context_build` and `context_expand`

### 10.1 Input contract

```ts
interface ContextBuildInput {
  target?: string;
  goal: string;
  budget: { maxTokens: number; maxFiles?: number; maxSymbols?: number; expandDepth?: number };
  role?: 'planner'|'implementer'|'reviewer'|'debugger'|'custom';
  fold?: 'adaptive';
  include?: { tests?: boolean; callers?: boolean; callees?: boolean };
  minConfidence?: Confidence;
  sessionId?: string; force?: boolean; exclude?: string[];
}
```

`minConfidence` defaults to `heuristic`. Target accepts symbol key, name, or path. Goal-only seeds use BM25 over `symbol_fts` plus path matches; if FTS is unavailable, report degraded behavior and provenance rather than silently substituting an unmeasured algorithm.

### 10.2 Deterministic algorithm

1. Seed explicit target or ranked goal matches and store a reason per seed.
2. Bounded BFS over edges meeting `minConfidence` through `expandDepth`.
3. Score with calibrated PPR, configured bonuses, role, and stable tie-break.
4. Render L0 ranked repository map; seeds at L3, direct neighbors L2, other selected items L1.
5. Fit budget by binary-searching rendered ranked items with the configured `TokenCounter`; budget seeds first. If seeds alone exceed budget, emit truncated L3 handles and say so.
6. Return no more than `maxTokens`, plus `estimatedTokens` and `truncated`.

Output, in both text and structured JSON, includes target/goal, ranked repo map, relevant symbols with reasons, dependency paths and per-edge confidence, structural facts with evidence handles, folded context, implementation, related tests, omitted summary with expand handles, and diagnostics (provider degradation, nearby unresolved refs, parse errors).

Sessions have TTL and size caps. With `sessionId`, an already sent `(handle, contentHash)` becomes `[already provided: <handle>]`; changed content or `force` resends. Unknown session creates one unless strict-session mode returns `SESSION_NOT_FOUND`.

`context_expand({handles?, keys?, level: 2|3|4})` opens incremental detail, honors session dedup and per-call budget, validates handles against project/index generation, and reports stale/unknown handles explicitly.

### 10.3 Folding

Adaptive folding must reuse v1/v2 fold contracts. Two golden-tested examples are required: TypeScript decorators (Angular/Nest style) and Python class fields (dataclass/pydantic style). Plugin availability is `TARGET` until code and fixtures prove it.

## 11. Semantic query tools

All names are additive `snake_case` tools routed through `AiToolRegistry` and `SemanticEngineMcpServer`:

- `symbol_search`: BM25 plus filters, confidence/via per result.
- `symbol_references`, `symbol_callers`, `symbol_callees`: `minConfidence`, confidence/via per item, and explicit not-found wording.
- `dependency_query`: bounded A→B path search with confidence per edge/path.
- `impact_analyze`: input `symbolKey | path | changed:true`; reverse dependencies, confidence, depth, and related tests.
- `context_build`, `context_expand` as above.
- `edit_plan_rename` as below.

Inputs must include project scope through the established registry/Gateway route; a path argument cannot select an arbitrary root. Outputs preserve the existing envelope and add project/index generation, warnings, truncation, confidence, and diagnostics in additive metadata/structured content.

## 12. Graph constraints for structural search

Implement a graph-backed `ConstraintProvider` as a post-filter, without changing v2 structural match shape:

- `calls`
- `calledBy`
- `enclosingClass{nameRegex}`
- `dependsOn{symbol|nameRegex, depth}`
- `changedSince{ref}`
- `hasTest`

The required example is methods that call `getPrice`, are in classes ending in `Service`, and depend within depth ≤3 on `MarketProvider`. Results carry the confidence of every edge used. If graph data/provider is unavailable, return additive `NOT_SUPPORTED`/degraded diagnostics rather than empty success or a false assertion. Structural matching remains ast-grep (if selected and proven); graph constraints do not replace the existing scanner/parser.

## 13. Semantic rename

`edit_plan_rename({symbolKey, newName, includeHeuristic?: false})` collects exact references by default. With `includeHeuristic`, heuristic sites may be proposed but remain labeled. Ambiguous and unresolved sites are never silently edited; return `skipped[]` with reason/confidence. Detect scope collisions using outline data and return `RENAME_CONFLICT` plus `conflicts[]`.

The result is a v2-compatible `EditPlan` and reuses preconditions, overlap policy, diff, transactional apply, verification, trusted validators, journal, undo, and overlay rules. Add `expect.unresolvedNotIncreased`; after affected files reindex, unresolved counts near the symbol must not increase. Recommend configured validators such as `tsc`, but do not claim behavioral verification unless one ran successfully.

## 14. Git, tests, and security

Git features use only allowlisted bounded subprocess calls: `status --porcelain` and `diff --name-only <ref>`, no shell, bounded output/time, and project-root confinement. Missing Git yields warning/error `GIT_UNAVAILABLE`; changed-file boosts and constraints degrade explicitly.

LSP launchers and Git processes must use argument arrays, no shell, timeouts, output caps, cancellation, and path confinement. LSP is optional and must not turn an unavailable server into an indexing crash. Secrets and source content follow existing redaction and artifact policies.

Test-file heuristics and test references produce `tests` edges with confidence. Heuristic test association is not exact unless confirmed by references/provider evidence.

## 15. Configuration and errors

New configuration is namespaced under the existing Semantic Engine configuration schema and preserves strict unknown-key behavior:

```text
semanticEngine.semantic.providers
semanticEngine.semantic.weights
semanticEngine.semantic.roles
semanticEngine.semantic.resolution.minConfidenceDefault
semanticEngine.semantic.sessions.ttlMs
semanticEngine.semantic.sessions.maxEntries
semanticEngine.semantic.git.enabled
semanticEngine.semantic.experimental.<feature>
```

The exact persisted names must be decided and recorded in `docs/CONTRACTS.md`; if the project convention instead places these under another existing semantic namespace, document the mapping. Provider entries include per-language LSP launch config only from trusted server configuration.

Add error codes without removing v2 values:

`RESOLUTION_UNAVAILABLE`, `BUDGET_EXCEEDED`, `SESSION_NOT_FOUND`, `GIT_UNAVAILABLE`, `RENAME_CONFLICT`.

Existing error-envelope behavior remains compatible. Errors distinguish unavailable provider, unsupported feature, invalid input, budget exhaustion, stale session/handle, conflict, and internal failure.

## 16. Evaluation, calibration, and release gates

### 16.1 Gold tasks and baselines

The eval input is `{repo, task, goal, goldSymbols: string[], goldEdits?: ...}`. Implement or document the existing command mapping for:

- **B0:** read whole files matched by keyword.
- **B1:** aider-style file-level graph-ranked map without goal awareness.
- **B2:** `context_build`.

Report recall@budget (gold symbols at required level), precision, tokens, number of calls, latency, and failure/diagnostic counts together. A quality gain without cost reporting is insufficient.

### 16.2 Calibration and ablation

Calibrate exact/heuristic/ambiguous/unresolved against golden edges and report precision and coverage by class. Starting target: exact precision ≥ 0.95; any failing path is downgraded to heuristic and marked experimental. Run a small ranking-weight grid; write winning defaults to config and record fixture/task IDs.

Measure incremental/full equality, `context_build` p50/p95, resolution coverage (`% unresolved`), deterministic output, session dedup, changed-content resend, and force behavior.

### 16.3 Mandatory gates

The tool prints a gate verdict:

1. `context_build` recall@budget ≥ B1 and better than B0.
2. Exact precision ≥ 0.95.
3. Incremental equals full at 100%.

If any gate fails, the related feature is `EXPERIMENTAL` in config and tool descriptions. Do not convert an unmeasured result into a pass.

### 16.4 Existing command mapping

The adapted v2 inventory established package vocabulary around `validate` and `benchmark`, not `eval` and `bench`. An additive `eval`/`bench` alias may be introduced only if documented, present in package metadata, and executed. Reports must list every command, exact exit code, captured output, fixture/repository, and whether the command was absent.

## 17. Scale and benchmarking

Extend benchmarking end-to-end only where profiling justifies it: scan → parse → reference extraction → resolution → store → query → context build → serialization. Report p50/p95, peak RSS, worker count, parser creation/per-file overhead, tree traversal, and memory on fixtures, a user-supplied real repository, and a stress corpus when available.

`worker_threads`, streaming parse→extract→drop-tree, compact IDs, and interning are conditional optimizations, not requirements to implement without a profile. Any optimization must preserve deterministic output and incremental/full equivalence.

## 18. Test and verification matrix

| Area | Required evidence |
|---|---|
| Compatibility | v1/v2 suites and existing package commands, with exact exit codes; no changed meanings. |
| Resolution | Fixtures for exact, heuristic, ambiguous, unresolved; unresolved persistence; TS paths, Python packages/aliases, PHP PSR-4. |
| LSP | Real server when available, otherwise mock; degraded/missing-server path and bounded requests. |
| Storage | Numbered migration, schema checks, restart/recovery/retention behavior, FTS capability if selected. |
| Incremental | Scripted edit sequence, equality after every step, removed-file cleanup. |
| Symbol keys | Body/signature stability and rename/move mapping. |
| Ranking | Determinism, anchors, role presets, ablation-selected defaults. |
| Context | Budget never exceeded, deterministic ordering, fold levels, valid handles, dedup, changed resend, force, omitted summary. |
| Queries | Confidence/via, min-confidence filtering, path bounds, unavailable/degraded states. |
| Constraints | Required `getPrice`/`Service`/`MarketProvider` example and confidence propagation. |
| Rename | Exact-only default, skipped report, collision conflict, validator, unresolved expectation, apply/undo reuse. |
| Git/security | No-shell allowlisted calls, bounded output, root confinement, `GIT_UNAVAILABLE`. |
| Fold plugins | Two golden fixtures: decorators and Python class fields. |
| MCP/runtime | `tools/list`/`tools/call`, structured content, project scope, generation/reload, Gateway/worker lifecycle, cache invalidation. |
| Evaluation | B0/B1/B2, calibration, ablation, gate verdict, latency and coverage. |
| Scale | Profile-backed benchmark; no unsupported performance claims. |

## 19. Integration mapping

| v3 requirement | `ProjectIndex` | `AiToolRegistry` | MCP | Lifecycle | Evidence rule |
|---|---|---|---|---|---|
| Refs/edges/unresolved | Additive companion records; preserve schema 2.0.0 unless separately migrated | Reader/query services are registered tools | Add confidence/via in structured content | IndexPipeline/IncrementalEngine writes and invalidates records | Migration + fixture + restart + comparison; no schema claim from types alone. |
| Module/adapters | Existing files/symbols remain canonical; config files are inputs | Provider selection is validated server config | Warnings for unsupported language/provider | Scanner and adapter manager extraction phase | Per-language fixture and unresolved accounting. |
| LSP | Never whole-repo source of truth | Demand-driven provider with timeout | Degraded status/warnings | Bounded child process under trusted runtime | Mock/real server, timeout, degraded evidence. |
| Ranking | Uses files/symbols/edges and generation | Ranking service behind query/context tools | Deterministic ranked results | Cache invalidated by dependency hash | Determinism, ablation, anchor tests. |
| Context | Reads canonical symbols/files and graph companion data | `context_build/expand` handlers, session state | Text + structured output, budget diagnostics | Freshness tied to index generation/reload | Budget/session/gate evidence. |
| Constraints | Post-filter against index and graph | Existing structural tool extended via provider | Same match envelope plus confidence | Must see current graph generation | Required example and unavailable path. |
| Rename | Outline and refs produce edits; no replacement index | Producer of v2 `EditPlan` | Diff/skipped/conflicts/expectation | Existing transaction then incremental refresh | Collision, apply/verify/undo, unresolved count. |
| Git/tests/folds | Metadata/edges additive | Filters/roles/query/context consumers | Warnings and provenance | Git availability and fold plugins loaded under project policy | Golden/test/security evidence. |
| Eval/bench | Reads index generation and artifacts | Separate commands or services, no hidden claims | Optional report exposure | Runs against fixtures/real repo without corrupting index | Captured output, exit code, metrics, gate verdict. |

## 20. Staged implementation and verification plan

1. **Baseline and decisions:** inventory actual branch/package/dependencies/scripts; update `DECISIONS.md` and `CONTRACTS.md`; mark unavailable capabilities.
2. **Contracts and migration:** define ranges, types, errors, configuration, storage migration, provider lifecycle, and compatibility tests.
3. **Extraction/resolution:** adapters, module resolvers, heuristic provider, unresolved persistence, fixtures, and degraded LSP provider.
4. **Graph/incremental:** edges/file deps/tests map, dirty propagation, key mapping, full-vs-incremental comparison.
5. **Search/ranking:** FTS-backed search if proven, graph constraints, PPR, roles, calibration harness.
6. **Context:** budget counter, fold/render levels, sessions, dedup, handles, diagnostics, MCP registration.
7. **Rename/plugins:** semantic edit-plan producer, test/Git edges, two fold plugins, reuse v2 transaction path.
8. **Evaluation/release:** B0/B1/B2, ablation/calibration, gates, scale profile, compatibility matrix, limitations and rollback instructions.

Each stage is complete only when its implementation, focused tests, package validation, and evidence artifacts exist. A failed stage remains `EXPERIMENTAL` and must not be presented as working.

## 21. Definition of Done

The v3 deliverable is eligible for a verified release only when:

- v1/v2 compatibility tests and actual package commands pass without changed meanings;
- additive contracts, config, migration, adapters, providers, tools, and MCP mappings are documented;
- exact/heuristic/ambiguous/unresolved behavior is persisted and measured;
- incremental equals full at 100% over the required scripted sequence;
- symbol-key stability/mapping evidence exists;
- ranking is deterministic and defaults are ablation-selected;
- `context_build`/`expand` obey budget, session, fold, handle, and diagnostic contracts;
- semantic queries, graph constraints, and rename have fixtures and confidence evidence;
- LSP, FTS5, ast-grep, language adapters, Git, fold plugins, eval, and bench are each labeled implemented/degraded/experimental based on actual evidence;
- mandatory gates pass, or failing features are explicitly marked `EXPERIMENTAL` in config/tool descriptions;
- MCP and relevant Gateway/runtime paths are executed, not inferred from unit tests;
- scale claims are backed by end-to-end profile results;
- final report includes exact revision/branch, dependency/license data, changed files, schema/migration status, metrics, gate verdicts, known limits, deviations, and rollback instructions.

## 22. Final report template

```text
Repository/package:
Branch/revision:
Node/npm:
Lockfile hash:
Existing and added commands (exit codes):
Dependencies inspected/pinned (versions/licenses):
Changed files:
Contracts/config/error additions:
Migration number/backend/status:
Range and offset units:
Languages/adapters/resolvers:
Provider status and degraded paths:
Resolution precision/coverage by confidence:
Incremental == full result:
Ranking calibration/ablation:
Context recall/precision/tokens/calls/latency:
Budget/session/handle results:
Constraint and rename results:
Git/test/fold plugin results:
MCP/Gateway/runtime evidence:
Scale p50/p95/RSS/workers:
Known limitations and deviations:
Features marked EXPERIMENTAL:
Rollback instructions:
Overall verdict: VERIFIED | PARTIALLY VERIFIED | NOT VERIFIED
Evidence boundary:
```

The report must distinguish specified, implemented, typed/schema-represented, unit-tested, locally executed, CI-executed, MCP-verified, Gateway/runtime-verified, and real-consumer-verified. Source presence is not runtime proof.

## 23. Decision records required before implementation

At minimum, `docs/DECISIONS.md` and `docs/CONTRACTS.md` must record:

- canonical range encoding/units and line/offset conversion;
- selected storage backend, migration number, indexes, retention, and FTS5 support evidence;
- exact configuration key names and defaults;
- adapter/provider ownership and language support;
- LSP launch/security/timeout policy;
- confidence downgrade policy and calibration method;
- rank weights, role presets, token counter, session TTL/cap, and handle format;
- Git allowlist and unavailable behavior;
- compatibility mapping to ProjectIndex, AiToolRegistry, MCP, ProjectRegistry/Paths, and lifecycle;
- each dependency that is absent, optional, experimental, or verified;
- rollback plan for migration, provider, index, and tool registration changes.

Until these records and their corresponding evidence exist, this document remains a target contract and Semantic Engine v3 must not be represented as complete.
