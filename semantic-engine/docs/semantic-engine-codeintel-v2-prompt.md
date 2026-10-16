# PROMPT — Semantic Engine Code Intelligence v2: Structural Search and Safe Transactional Edits

## 0. Purpose, target, and status

This document adapts the CodeIntel v2 specification to the existing `semantic-engine` package in the `legionir/semantic-engine-structured-ai` repository, branch `docs/audit-file-status`.

It is an **implementation specification and verification contract**, not evidence that the current repository already implements v2. The current source tree, package metadata, installed dependencies, lockfile, schemas, tests, and executed commands are authoritative. Do not infer completion from this document, README claims, type declarations, or the existence of a test file.

Target document path:

```text
semantic-engine/docs/semantic-engine-codeintel-v2-prompt.md
```

Target package:

```text
semantic-engine/
```

Semantic Engine v1 is the compatibility baseline. The adapted v1 specification is:

```text
semantic-engine/docs/semantic-engine-codeintel-v1-prompt.md
```

The v2 target adds:

1. structural search based on ast-grep;
2. YAML rule packs and rule testing;
3. syntax-tree dumping for pattern development;
4. a read-only-by-default transactional edit engine;
5. edit planning, diff preview, approval, apply, verification, rollback, undo, and crash recovery;
6. overlay support for unsaved buffers;
7. allowlisted validators and isolated apply mode;
8. fuzz, golden-diff, and MCP end-to-end verification;
9. extension points for v3 semantic constraints, context building, and rename.

The target is not a second standalone `codeintel` product. New behavior must integrate with Semantic Engine's existing `ProjectIndex` v2, source/artifact boundary, AI tool registry, MCP server, project registry, Gateway/runtime lifecycle, and evidence rules.

---

## 1. What v2 adds versus the adapted v1 specification

The adapted v1 specification concentrates on correctness and evidence for the existing Semantic Engine platform:

- project identity and lifecycle;
- scanning and parser/extractor behavior;
- `ProjectIndex` schema `2.0.0`;
- files, symbols, imports/exports, diagnostics, metrics, and graphs;
- provenance and confidence;
- full and incremental indexing;
- JSON, blueprint, vector, and other derived artifacts;
- AI tools and `AiToolRegistry`;
- MCP stdio and HTTP integration;
- Gateway, workers, project persistence, and artifact reload;
- deterministic evaluation and benchmark evidence.

V2 must preserve all of those concerns and add the following capabilities without making them a second source of truth:

| V2 addition | Semantic Engine integration |
|---|---|
| Structural search | New AI tools registered through `AiToolRegistry`, exposed through the existing MCP `tools/list` and `tools/call` path |
| ast-grep patterns | A new search adapter; do not replace the existing tree-sitter scanner/extractor pipeline |
| YAML rules | Project-scoped rule packs loaded from a validated, explicitly configured rules directory |
| Outline post-filters | Filters resolved against `ProjectIndex.files` and `ProjectIndex.symbols` |
| Syntax-tree dump | A debugging tool using the installed ast-grep parser and explicit language selection |
| Edit plans | New source-independent edit model that can consume structural matches or future v3 producers |
| Diff preview | A dry-run tool returning unified diff without writing source files |
| Apply | A transaction layer under the existing workspace/artifact/project path policy |
| Verification | Existing parsers, extractors, diagnostics, symbols, and structural-search machinery |
| Journal and undo | New durable transaction records under the project data/artifact boundary, independent from `ProjectIndex` source data |
| Overlay files | A host-provided file-provider adapter above the existing scanner/file-system boundary |
| Validators | Trusted server configuration only; never commands supplied by an AI tool or client |
| Isolated mode | Per-edit transaction execution with validator-controlled keep/rollback decisions |
| v3 extension points | `ConstraintProvider`, reusable outline-diff logic, source-independent `EditPlan`, and overlay integration |

No v2 feature may silently mutate an existing v1 field, change the meaning of `root`, replace the `AiToolOutput` envelope, remove an existing AI tool, or make a derived artifact authoritative over `ProjectIndex`.

---

## 2. Repository facts and source-of-truth map

The target branch currently contains the following relevant package structure:

```text
semantic-engine/
  package.json
  package-lock.json
  contracts/
    config.schema.json
    platform-v1.openapi.json
    project-index.schema.json
    blueprint.schema.json
  docs/
    semantic-engine-codeintel-v1-prompt.md
    architecture/
  src/
    ai/
      AiToolRegistry.ts
      AiToolCommandHandler.ts
      ProjectIndexReader.ts
      tools/
      schemas/
      mcp/
        SemanticEngineMcpServer.ts
        cli.ts
    core/
      config/
        ProjectIdentity.ts
        ProjectPaths.ts
        ProjectRegistry.ts
        DataRootResolver.ts
        indexGeneration.ts
      types/
        project-index.types.ts
    host/
      FileSystem.ts
      Config.ts
      Cancellation.ts
      FileWatcher.ts
    incremental/
      IncrementalEngine.ts
      ProjectIndexStore.ts
    pipeline/
      IndexPipeline.ts
      OutputWriter.ts
      WatchPipeline.ts
    runtime/
      JobManager.ts
      workers/
        IndexingWorker.ts
    scanner/
      WorkspaceScanner.ts
    server/
      SecurityPipeline.ts
      routes/
      HttpServer.ts
    gateway/
      GatewayServer.ts
      WorkerSupervisor.ts
      ProjectLock.ts
    symbols/
    dependencies/
    graphs/
    vector/
  test/
    golden/
  scripts/
    gen-fixture.js
    validate-project-index.js
    snapshot.js
    benchmark.js
```

The package metadata currently declares:

```json
{
  "name": "@aicoder/semantic-engine",
  "version": "0.1.0",
  "engines": {
    "node": ">=20"
  }
}
```

The currently declared core dependencies include:

- `@modelcontextprotocol/sdk`;
- `ajv`;
- `ajv-formats`;
- `chokidar`;
- `minimatch`;
- `typescript`;
- `vscode-jsonrpc`;
- `web-tree-sitter`.

Optional dependencies include tree-sitter JavaScript/TypeScript grammars and `usearch`. The current package metadata does **not** establish that `@ast-grep/napi`, `yaml`, `diff`, `fast-check`, or `zod` are installed. Before implementing v2, resolve and inspect pinned versions and their type definitions. Do not guess their APIs.

The current package scripts are:

```text
build
compile
watch
lint
pretest
test
test:gate
fixture
validate
snapshot
snapshot:update
check:audit
benchmark
```

There is no current package script named `eval` or `bench` in the inspected package metadata. V2 evaluation must use the existing script vocabulary or add clearly documented, additive aliases. Do not claim that `npm run eval` or `npm run bench` exists until it is added and executed.

At the time of this repository inventory, `semantic-engine/docs/` contains the adapted v1 prompt and an `architecture/` directory; `DECISIONS.md` and `CONTRACTS.md` must be created or updated as part of the v2 baseline stage if they are not present in the working tree.

### 2.1 Project index

The canonical source model is:

```text
semantic-engine/contracts/project-index.schema.json
semantic-engine/src/core/types/project-index.types.ts
```

The schema version is currently `2.0.0`.

`ProjectIndex` contains, among other fields:

- `schemaVersion`;
- short display `root`;
- optional real `rootPath`;
- `generatedAt`;
- optional `generatorVersion`;
- `languages`;
- optional `languageSupport`;
- optional incremental metadata;
- optional diagnostics-run metadata;
- optional Git metadata;
- `files`;
- `symbols`;
- `graphs`;
- `diagnostics`;
- `metrics`;
- optional `vectorChunks`.

The existing model is line-based for symbols:

```ts
interface SymbolEntry {
  id: string;
  fileId: string;
  parentId: string | null;
  kind: SymbolKind;
  name: string;
  fullyQualifiedName?: string;
  signature?: string;
  line: number;
  endLine: number;
  source: ExtractionSource;
  confidence: Confidence;
}
```

The existing model is not permission to introduce a second, incompatible outline model. New offset/range contracts must be additive and must state units explicitly.

### 2.2 Project and artifact paths

`ProjectPaths.ts`, `ProjectIdentity.ts`, `DataRootResolver.ts`, and `ProjectRegistry.ts` define the project boundary.

The important distinction is:

- `workspaceRoot`: source project root;
- `artifactRoot`: generated-data location;
- `root`: a short display name in `ProjectIndex`;
- `rootPath`: the actual persisted or discovered filesystem root.

Artifacts may be stored in-root or under the external data directory, depending on configuration. `ProjectPaths` centralizes paths for:

- `project-index.json`;
- `blueprint.json`;
- `project-index.sqlite` compatibility location;
- `project-artifacts.manifest.json`;
- locks;
- logs;
- other project data.

New search and edit code must resolve paths through this boundary. It must not rebuild `.semantic-engine`, `projects/<projectId>`, or registry paths independently.

`ProjectRegistry` persists registry state in the data root, writes project manifests beside per-project data, canonicalizes roots, and enforces safe project IDs. Project registration and Gateway routing must remain the authority for project selection. A client must not be able to select an arbitrary source root by placing a path in an AI-tool argument.

### 2.3 Existing output and file-system behavior

`OutputWriter` validates `ProjectIndex` against the JSON schema before writing in its normal non-production path and writes the index, blueprint, and manifest atomically through the existing file-system abstraction.

`FileSystem.ts` contains:

- `FileSystemPort`;
- `NodeFileSystem`;
- atomic file and JSON writes;
- temporary-file handling;
- `fsync` before rename;
- stale temporary cleanup;
- streaming JSON serialization.

These guarantees apply to derived artifacts. They do not automatically provide the edit engine's multi-file transaction, journal, rollback, or undo guarantees. V2 must add the missing transaction behavior without weakening artifact publication.

### 2.4 Existing AI tool and MCP contracts

`AiToolRegistry.ts` is the single execution path for the current built-in tools. It currently:

- registers built-in tools;
- validates input with `ToolInputValidator`;
- uses the existing `AiToolOutput` shape;
- optionally caches successful results;
- invalidates cache on project/index identity changes;
- retains `executeWithValidation` as a compatibility alias for `execute`.

The current tool output shape is:

```ts
interface AiToolOutput {
  success: boolean;
  error?: string;
  items: readonly AiToolResultItem[];
  context?: string;
  metadata?: Record<string, unknown>;
}
```

The current MCP server is `src/ai/mcp/SemanticEngineMcpServer.ts`. It supports:

- `tools/list`;
- `tools/call`;
- text `content`;
- additive `structuredContent`;
- `projectId` when supplied;
- `indexGeneration`;
- index watching and reload;
- blueprint loading beside the index.

V2 tools must use this registry and MCP path. Do not create an independent MCP server or a second tool invocation path.

### 2.5 Existing indexing and runtime lifecycle

The current indexing path includes:

```text
ProjectRegistry / CLI / Gateway
  → workspaceRoot and ProjectPaths
  → WorkspaceScanner
  → parser/extractor managers
  → IndexPipeline / IncrementalEngine
  → ProjectIndex
  → OutputWriter and artifact manifest
  → ProjectIndexReader / AiToolRegistry
  → MCP, HTTP, Gateway, CLI consumers
```

`IncrementalEngine` and `ProjectIndexStore` already maintain files, symbols, graphs, removed-file cleanup, incremental metadata, and vector-chunk cleanup. V2 edit application must not bypass those components after a successful source change. An applied edit must either:

1. trigger the existing incremental/index publication lifecycle; or
2. explicitly report that reindexing has not run and avoid claiming a fresh `ProjectIndex`.

The lifecycle components include `JobManager`, `IndexingWorker`, `GatewayServer`, `WorkerSupervisor`, `ProjectLock`, HTTP routes, and MCP reload/watch behavior. Transaction recovery must be reachable during the relevant startup path, not only from an isolated library test.

### 2.6 Existing security boundary

The existing repository includes:

- project-root canonicalization;
- safe project-ID validation;
- data-root separation;
- workspace scanning ignore rules;
- symlink-cycle handling;
- HTTP loopback and remote-access controls;
- authentication and origin checks;
- request schema validation;
- secret redaction;
- route and project-scope tests.

V2 must extend, not weaken, those protections.

---

## 3. Non-negotiable working method

1. Establish the exact baseline before implementation:
   - Git revision and branch;
   - Node and npm versions;
   - lockfile hash;
   - package scripts;
   - resolved dependency versions;
   - source/artifact configuration;
   - current tests, build, lint, validation, gate, and benchmark results;
   - exit codes and captured output paths.

2. Read the existing adapted v1 document, package metadata, `project-index.schema.json`, `project-index.types.ts`, AI tool types, tool registry, MCP server, ProjectPaths, ProjectIdentity, ProjectRegistry, FileSystem, OutputWriter, IncrementalEngine, and relevant tests before designing v2.

3. Read installed type definitions and official documentation for every new third-party dependency. Candidate dependencies include:
   - `@ast-grep/napi`;
   - `yaml`;
   - a unified-diff library;
   - `fast-check`;
   - `zod`, if selected instead of the repository's existing Ajv validation path.

4. Record dependency and architecture decisions in:

```text
semantic-engine/docs/DECISIONS.md
semantic-engine/docs/CONTRACTS.md
```

If the project chooses an existing repository facility over an original CodeIntel assumption, record the mapping and the reason.

5. Preserve all v1 contracts. Add fields, tools, error codes, configuration, migrations, and tables only when they are additive and documented.

6. Never silently replace:
   - `ProjectIndex`;
   - the current AI tool output shape;
   - the current MCP text/structured-content behavior;
   - `ProjectRegistry`;
   - `ProjectPaths`;
   - the source/artifact distinction;
   - existing scripts;
   - existing tool names;
   - existing project or Gateway lifecycle behavior.

7. Do not claim that ast-grep, YAML rule packs, edit transactions, validators, undo, overlay support, fuzzing, or MCP e2e are implemented until the corresponding code path has been executed and evidence captured.

8. Keep the default operational mode read-only. A client must explicitly request and confirm a write operation, and server configuration must allow writes.

9. All new behavior must be staged, testable, reversible, and independently diagnosable.

---

## 4. Scope

### 4.1 In scope

- Structural search over project files using ast-grep.
- Pattern search with explicit target language.
- Single-node and variadic metavariable captures.
- YAML rule packs under a project-scoped rules directory.
- Rule loading, validation, listing, invalid-rule warnings, and test execution.
- Outline-based post-filters using Semantic Engine index symbols and files.
- A `ConstraintProvider` extension point.
- Named-node syntax-tree dump for a snippet or file.
- Overlay file content supplied by a host integration.
- `Edit`, `EditPlan`, `EditBuilder`, and plan persistence.
- Explicit edit overlap and nested-match handling.
- Unified diff preview.
- Read-only-by-default apply safety.
- Preconditions based on content hashes.
- Transactional multi-file apply.
- Temporary files, fsync, journal records, atomic rename, and rollback.
- Syntax, structural, and behavior verification labels.
- Trusted, allowlisted validators executed without a shell.
- Isolated per-edit apply mode.
- Undo based on journal after-hash checks.
- Startup crash recovery.
- Source path, symlink, denylist, project-scope, file-count, and byte-count safety limits.
- Evaluation and benchmarks for search and edits.
- At least 1,000 edit apply/undo fuzz round trips with zero byte differences.
- MCP e2e coverage through the existing Semantic Engine server.
- Forward-compatible interfaces for v3 semantic constraints, context building, and rename.

### 4.2 Explicit non-goals

- Do not build a custom pattern language. Structural patterns must use ast-grep and the target language's syntax.
- Do not replace the existing tree-sitter scanner/parser/extractor pipeline with ast-grep.
- Do not build semantic multi-file rename or refactoring in v2. Rename is a v3 producer of `Edit[]`.
- Do not implement semantic or dependency constraints in v2. The `ConstraintProvider` must exist, but the default implementation returns `NOT_SUPPORTED`.
- Do not implement query-by-example, similar-code search, or embedding-based code similarity.
- Do not allow arbitrary shell commands from an AI tool, MCP client, HTTP client, or edit plan.
- Do not allow writes outside the selected project's `workspaceRoot`, except trusted internal journal/artifact locations explicitly governed by `ProjectPaths`.
- Do not follow escaping symlinks.
- Do not turn `ProjectIndex`, blueprint, vector data, or an edit journal into an undocumented second source of truth.
- Do not change existing line-number semantics.
- Do not claim behavioral verification without a configured and successfully executed validator.
- Do not expose unsaved overlay content to disk unless the configured overlay policy allows it.
- Do not make `allowWrite` true by default.
- Do not remove or rename existing tools, routes, scripts, schema fields, or compatibility aliases.
- Do not claim v3 semantic graph constraints or rename behavior because v2 structural filters exist.

---

## 5. Additive contracts and migration rules

### 5.1 General contract rules

Contracts are additive-only.

Any new contract must:

- have a documented owner;
- have a schema or TypeScript type where appropriate;
- define units, ordering, nullability, and error behavior;
- be tested through the registry and MCP where it is user-facing;
- preserve unknown/partial/unavailable/not-run states;
- include project and index identity when derived from an index;
- avoid timestamps and random values in semantic output;
- specify migration and rollback behavior.

Existing `ProjectIndex` schema version `2.0.0` remains the canonical index schema unless a separately approved migration changes it. Structural matches, edit plans, journals, and overlays are not additions to `ProjectIndex` unless there is a specific additive schema decision.

### 5.2 New error codes

The existing project error model must be inspected before adding values. The following v2 semantic error codes are required as additive values, mapped into the existing tool/MCP error representation:

```text
WRITE_DISABLED
PRECONDITION_FAILED
EDIT_OVERLAP
PLAN_NOT_FOUND
VERIFY_FAILED
VALIDATOR_FAILED
UNDO_CONFLICT
NOT_SUPPORTED
```

Existing error strings, `success` behavior, and MCP `isError` behavior must remain compatible. New tools may expose a structured error code in additive metadata, but existing consumers must still receive the established `AiToolOutput` shape.

### 5.3 New configuration

The current configuration schema uses namespaced keys such as `semanticEngine.dataDir` and `semanticEngine.artifactLocation`. V2 configuration must follow that convention.

The edit engine's internal option names may remain:

```ts
allowWrite
validators
requireApprovalToken
maxEditFiles
maxEditBytes
rulesDir
overlayPolicy
```

The persisted/configuration keys should be namespaced, for example:

```text
semanticEngine.edit.allowWrite
semanticEngine.edit.requireApprovalToken
semanticEngine.edit.maxEditFiles
semanticEngine.edit.maxEditBytes
semanticEngine.edit.overlayPolicy
semanticEngine.edit.validators
semanticEngine.structural.rulesDir
```

The exact names must be recorded in `CONTRACTS.md` and added to `contracts/config.schema.json`. Existing `additionalProperties: false` behavior must be preserved.

Required semantics:

- `allowWrite`: default `false`;
- `requireApprovalToken`: default `false` unless the deployment profile requires it;
- `maxEditFiles`: finite positive limit;
- `maxEditBytes`: finite positive limit;
- `rulesDir`: project-scoped, safe, and not allowed to escape the workspace;
- `overlayPolicy`: `abort` by default, or `disk-wins`;
- `validators`: trusted server configuration only.

### 5.4 Persistence and migration

The original CodeIntel v2 model names:

```text
edit_plans
journal
```

These records must be persisted independently of `ProjectIndex` and independently of project registry identity. They must not be embedded into `project-index.json`.

The repository currently has JSON project registry and artifact paths, plus a compatibility `sqlitePath` in `ProjectPaths`; the inspected source does not establish that edit-plan or journal tables already exist. Therefore:

1. inspect the active persistence implementation before choosing the storage mechanism;
2. if the existing SQLite path is active and appropriate, add versioned tables there;
3. otherwise add an explicitly documented durable store under the project data/artifact boundary;
4. do not claim that SQLite tables exist until the migration has run and been tested.

If SQLite is selected, the additive migration must define at least:

```sql
edit_plans(
  plan_id       TEXT PRIMARY KEY,
  json          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  ttl           INTEGER NOT NULL
);

journal(
  tx_id         TEXT NOT NULL,
  path          TEXT NOT NULL,
  before_hash   TEXT NOT NULL,
  after_hash    TEXT NOT NULL,
  before_blob   BLOB,
  created_at    INTEGER NOT NULL,
  state         TEXT NOT NULL,
  PRIMARY KEY (tx_id, path)
);
```

The implementation may add fields such as project ID, workspace root identity, transaction phase, blob size, and validator status, but must not remove the required fields.

Migration requirements:

- use a new migration number;
- do not alter existing `ProjectIndex` data migrations;
- do not alter registry schema version without a separate decision;
- make journal recovery idempotent;
- retain rollback or quarantine behavior for incompatible records;
- enforce TTL and before-blob size caps;
- test startup recovery with incomplete transactions.

---

## 6. Architecture mapping

The target v2 architecture is:

```text
ProjectRegistry / CLI / Gateway / MCP
  → resolve projectId and canonical workspaceRoot
  → ProjectPaths and source/artifact policy
  → OverlayFileProvider or disk FileProvider
  → structural search adapter (ast-grep)
  → ProjectIndexReader / symbol and file post-filters
  → Match[]
  → EditBuilder / EditPlan store
  → unified diff
  → approval and write policy
  → transactional edit engine
  → in-memory parse and verification
  → journal + atomic rename
  → allowlisted validators
  → rollback or committed transaction
  → incremental index/artifact lifecycle
  → MCP/AI result with generation and verification state
```

Rules:

1. ast-grep only finds nodes and captures. It must never write files.
2. Structural search may inspect overlay content, disk content, or a declared snapshot, but must report which source was used.
3. Edit plans are source-independent. They may be generated from explicit edits, structural matches, future rename tools, or another trusted producer.
4. The edit engine must use the project's path and security policy.
5. A successful disk transaction does not automatically mean the index is current. Reindexing and artifact publication must be explicit and reported.
6. The MCP server must not serve stale edit status or index metadata after reload.
7. Every result must retain project identity and, when index-derived, `indexGeneration` or an explicit unavailable state.
8. The existing `AiToolRegistry` remains the only AI-tool execution path.
9. The existing `SemanticEngineMcpServer` remains the MCP transport and envelope path.
10. Gateway and worker requests must resolve project ID through `ProjectRegistry`; clients may not select an arbitrary root.

---

## 7. Structural search

### 7.1 Engine selection

The structural search engine must be ast-grep, using the pinned and inspected package version.

Before implementation:

- install or resolve the selected ast-grep package;
- inspect its declarations and documentation;
- verify supported language bindings;
- verify single-node and variadic metavariable behavior;
- verify named-node and strictness options;
- verify range units;
- verify parser failure and timeout behavior;
- record the ast-grep version and limitations in `DECISIONS.md`.

The existing Semantic Engine tree-sitter adapters remain responsible for indexing and verification unless a separately documented adapter decision says otherwise.

### 7.2 Pattern language and capture semantics

Patterns are written in the target language's own syntax.

The implementation must document and test:

- single-node metavariables, conventionally `$X`;
- variadic or multi-node metavariables, conventionally `$$$X`;
- whether captures may repeat;
- whether a capture is represented by one node or a sequence;
- behavior for empty variadic captures;
- behavior for nested matches;
- behavior for comments, whitespace, and anonymous nodes;
- language-specific parser limitations.

The tool description must explicitly state the distinction between:

```text
$X     one captured AST node
$$$X   zero or more captured nodes, where supported by the installed version
```

Do not emulate ast-grep with a custom regular expression or template matcher.

If the installed version supports strictness or named-node matching, expose the supported option through the structural search input schema. If it does not, record the limitation and do not silently invent an equivalent.

### 7.3 Range units and conversion

The existing project contract uses 1-based symbol lines and line ranges. V2 must add a documented canonical range for structural matches without changing existing `line` and `endLine` meaning.

The canonical v2 range must specify:

- line base;
- character base;
- character encoding;
- offset encoding;
- treatment of BOM;
- treatment of CRLF;
- treatment of tabs;
- treatment of astral Unicode characters and emoji;
- whether a range includes or excludes the end position.

A recommended additive contract is:

```ts
interface Position {
  line: number;       // 1-based
  character: number;  // UTF-16 code units, 0-based within the line
}

interface Range {
  start: Position;
  end: Position;
}
```

If the implementation selects another representation, it must document the reason and update the contract.

The installed ast-grep range must be measured and converted through a reusable line-index adapter. The adapter must not assume that ast-grep returns UTF-16 indices. Tests must cover:

- Persian text;
- emoji and other astral characters;
- CRLF;
- BOM;
- tabs;
- mixed line endings;
- a match beginning or ending beside a multibyte character.

The conversion gate is 100% correct expected ranges on the fixture set. Any range ambiguity blocks the v3 gate.

### 7.4 Search levels

V2 provides three structural-search levels:

1. **Pattern search**
   - pattern;
   - language;
   - project-scoped paths or globs;
   - optional strictness;
   - optional limits and timeout.

2. **Rule search**
   - rule ID from a validated project rule pack; or
   - inline rule object;
   - optional replacement template for plan generation, but search itself remains read-only.

3. **Outline-filtered search**
   - pattern or rule result;
   - `ProjectIndex` symbol/file post-filter;
   - no semantic dependency resolution in v2.

The outline filter contract is:

```ts
export interface OutlineWhere {
  enclosingKind?: GenericKind[];
  enclosingNameRegex?: string;
  fileGlob?: string;
  inSymbolKey?: string;
}
```

`GenericKind` must map to the project's existing `SymbolKind` values or an additive documented union. Regex compilation must be bounded and safe.

The `inSymbolKey` value must be resolved against Semantic Engine's existing symbol identity. It must not assume the original CodeIntel `SymbolKey` implementation exists.

### 7.5 Constraint provider extension point

The structural search API must expose:

```ts
export interface ConstraintProvider {
  name: string;
  supports(c: unknown): boolean;
  filter(matches: Match[], c: unknown): Promise<Match[]>;
}
```

The default provider must reject unsupported semantic/dependency constraints with `NOT_SUPPORTED`.

V2 must not implement graph-aware semantic constraints. The interface exists so v3 can add them without changing structural-search result or tool contracts.

### 7.6 Match shape

The additive structural match shape is:

```ts
export interface Capture {
  text: string;
  range: Range;
  kind: string;
}

export interface Match {
  path: string;
  range: Range;
  text: string; // truncated to maxMatchChars
  captures: Record<string, Capture>;
  multiCaptures: Record<string, Capture[]>;
  enclosingSymbolKey?: string;
  handle: string;
}
```

Mappings:

- `path` is normalized relative to `workspaceRoot`;
- `range` is the canonical v2 range;
- `text` is bounded and must state truncation;
- captures are converted from ast-grep ranges through the same adapter;
- `enclosingSymbolKey` is populated from the existing project symbol index when available;
- `handle` is a versioned, opaque match handle that can be safely passed to `EditBuilder`.

A handle must not rely on unstable array positions alone. It should include enough project/snapshot/path/range identity to reject stale or cross-project use. Its exact encoding must be documented in `CONTRACTS.md`.

Results must be sorted by:

```text
normalized relative path
then range.start.line
then range.start.character
then range.end.line
then range.end.character
then stable capture/handle tie-breakers
```

The engine must enforce:

- result `limit`;
- `maxResultBytes`;
- maximum match text size;
- timeout;
- maximum file count;
- project path boundary;
- cancellation where the host provides a cancellation token.

A timeout is not an empty successful result. It must be reported as a bounded, explicit failure or partial result according to the tool contract.

### 7.7 Rule packs

The default project rule location is:

```text
<workspaceRoot>/.codeintel/rules/*.yml
```

The effective path must be configurable through the namespaced `rulesDir` setting, while remaining inside the selected project unless a trusted deployment explicitly permits another location.

A rule has the shape:

```yaml
id: example-rule
language: typescript
rule: |
  function $F($$$ARGS) {
    $$$BODY
  }
message: Optional diagnostic text
severity: warning
fix:
  replacement: Optional template
tags:
  - optional-tag
```

Requirements:

- validate rule packs at load;
- report invalid rules as warnings;
- do not crash the server because one rule is invalid;
- preserve valid rules;
- reject duplicate IDs deterministically;
- ensure language is supported by the installed ast-grep adapter;
- bound YAML size and nesting;
- reject unsafe YAML features if the selected parser supports them;
- never execute rule-pack content as code;
- validate replacement templates separately from search rules;
- include source path and validation details in `rules_list`.

The original prompt names zod. The repository currently uses Ajv for JSON schema validation. The implementation must either:

1. add and pin zod after inspecting its API and use it consistently for rule objects; or
2. use the existing Ajv validation path with an explicit recorded decision that the equivalent repository-native validator is preferred.

Either choice must be tested and documented; neither may be assumed from package names alone.

### 7.8 Structural tools

Add the following tool names through `AiToolRegistry`:

```text
structural_search
structural_rule_search
structural_dump
structural_test_rule
rules_list
```

Required behavior:

#### `structural_search`

Accept a pattern, language, optional paths/globs, optional outline filter, strictness where supported, limits, and timeout. Return structural matches with project/index metadata.

#### `structural_rule_search`

Accept either `ruleId` or `inlineRule`, but not neither. Run the validated rule against the selected project snapshot. Inline rules are still validated and bounded; they do not bypass policy.

#### `structural_dump`

Accept a snippet or a project-relative file path plus language. Return a named-node tree suitable for debugging patterns. Do not expose arbitrary paths or read outside the selected project.

#### `structural_test_rule`

Run one rule against a supplied bounded snippet. It must not write files and must not load arbitrary files unless explicitly requested through a project-scoped path.

#### `rules_list`

List valid and invalid rules, source paths, IDs, languages, messages, severity, tags, and validation warnings. Invalid rules must be visible but must not be executable.

All new tools must have JSON schemas under the existing AI schema boundary or an explicitly documented equivalent. They must be validated by `ToolInputValidator` through the single registry execution path.

---

## 8. Overlay file provider

The existing `FileSystemPort` and scanner operate on disk. V2 must add an overlay adapter without changing disk semantics:

```ts
export interface FileProvider {
  read(path: string): Promise<string>;
  hash(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface OverlayFileProvider extends FileProvider {
  setOverlay(path: string, text: string | null): void;
  isDirty(path: string): boolean;
}
```

The implementation may use a different additive interface if it preserves these semantics.

Rules:

- paths are normalized relative to `workspaceRoot`;
- overlay text is host-supplied and is never treated as trusted executable code;
- searches and plans must identify whether content came from overlay or disk;
- plans built from overlay content carry the overlay content hash;
- a dirty overlay must not be overwritten on disk under the default policy;
- `overlayPolicy: 'abort'` rejects a disk write when the target overlay is dirty;
- `overlayPolicy: 'disk-wins'` explicitly permits the disk transaction and must report that the overlay was superseded;
- overlay state is not silently persisted into `ProjectIndex`;
- the VS Code or future host integration uses this provider as the extension point.

---

## 9. Edit model and builder

### 9.1 Edit and plan contracts

The additive edit model is:

```ts
export interface Edit {
  path: string;
  start: number;
  end: number;
  newText: string;
  label?: string;
  expectedNodeHash?: string;
}

export interface EditPlan {
  planId: string;
  edits: Edit[];
  files: {
    path: string;
    expectedContentHash: string;
  }[];
  options: {
    nested: 'error' | 'outermost' | 'innermost';
    reindent: boolean;
    eol: 'preserve';
  };
  expect?: {
    patternCountDelta?: {
      pattern: string;
      language: string;
      before?: number;
      after?: number;
    }[];
    symbolsUnchanged?: boolean;
  };
  validators?: string[];
  onValidatorFail?: 'rollback' | 'keep';
  createdAt: number;
}
```

The offset unit must be documented. In a JavaScript/TypeScript implementation, UTF-16 code-unit offsets are a practical canonical choice, but the implementation must not assume that without recording it. If byte offsets are selected, all conversion boundaries must be explicit.

`planId` is the hash of canonical JSON for:

```text
{ edits, files, options, expect }
```

The canonicalization must define:

- object key ordering;
- array ordering;
- normalized path format;
- line-ending normalization policy;
- treatment of omitted versus null fields;
- hash algorithm.

`createdAt` must not affect `planId` if the required hash input excludes it.

### 9.2 EditBuilder API

Provide an additive `EditBuilder` API:

```ts
replaceRange(path, start, end, newText, label?)
insertBefore(path, position, newText, label?)
insertAfter(path, position, newText, label?)
delete(path, start, end, label?)
replaceWithTemplate(match, template, label?)
```

Template replacement must support exact source text splicing for captures:

```text
$NAME
$$$ARGS
```

Requirements:

- use exact captured source text, not reconstructed pretty-printed AST nodes;
- reject unknown captures;
- distinguish single and variadic captures;
- preserve the target file's EOL;
- support multiline replacements;
- when `reindent` is true, indent replacement lines relative to the replaced node's first-line indentation;
- never write directly from ast-grep;
- produce an `EditPlan`, not an immediate mutation.

### 9.3 Plan sources

Plans may be created from:

- explicit edit ranges;
- structural pattern matches;
- structural rule matches;
- future v3 rename or graph tools;
- trusted internal producers.

The apply tool accepts only a stored `planId`. It must not accept raw arbitrary `Edit[]` as a bypass around planning, diff, approval, and precondition checks.

### 9.4 Overlap and nested policy

For edits within one normalized file:

- overlapping non-identical edits produce `EDIT_OVERLAP`;
- byte-identical duplicate edits are deduplicated;
- nested edits follow `options.nested`;
- default `nested` is `error`;
- `outermost` retains the outer edit and rejects or suppresses nested edits deterministically;
- `innermost` retains the inner edit and rejects or suppresses the outer edit deterministically;
- same-start and same-end ties are covered by tests;
- edits across files are independently validated.

The conflict result must identify paths and ranges without leaking arbitrary source content beyond configured limits.

---

## 10. Diff and transactional apply

### 10.1 Read-only safety model

The default mode is read-only.

`edit_plan` and `edit_diff` must not write source files. `edit_apply` must fail with:

```text
WRITE_DISABLED
```

unless both conditions are true:

```text
config.allowWrite === true
input.confirm === true
```

If `requireApprovalToken` is enabled:

1. `edit_diff` returns a single-use approval token bound to:
   - project identity;
   - plan ID;
   - expected file hashes;
   - diff hash;
   - expiry;
2. `edit_apply` must present the token;
3. a token cannot be reused;
4. a token for another project, plan, or changed diff is rejected.

Approval tokens must not be treated as authentication tokens and must not be logged in clear text.

### 10.2 Preconditions

Before any write:

1. resolve project ID through `ProjectRegistry`;
2. resolve `workspaceRoot` and `ProjectPaths`;
3. normalize every plan path;
4. verify every path is inside the selected workspace root;
5. reject denylisted paths;
6. reject escaping symlinks;
7. read all target files through the configured `FileProvider`;
8. compare every current hash with the plan's expected hash;
9. compare overlay state according to `overlayPolicy`;
10. enforce file and byte caps.

If any precondition fails, return `PRECONDITION_FAILED` and write nothing.

### 10.3 New-content construction

For each file:

1. preserve a leading BOM;
2. detect and preserve the file's EOL style;
3. normalize `newText` line endings to the target file's EOL;
4. apply edits from highest offset to lowest;
5. preserve file mode;
6. compute before and after hashes;
7. retain bounded before content for the journal;
8. do not mutate the in-memory source until every file's new content is constructed successfully.

The implementation must define behavior for:

- empty files;
- no-final-newline files;
- mixed EOL files;
- BOM-only files;
- offsets beside surrogate pairs;
- offsets beside CRLF;
- tabs and reindentation;
- edits at end-of-file;
- zero-length inserts;
- duplicate edits.

### 10.4 In-memory verification before disk writes

Before any rename:

1. parse new content through the project's supported parser path;
2. run syntax verification;
3. run structural verification;
4. evaluate requested `expect` constraints;
5. ensure all files pass;
6. write no source file if any file fails.

This is a transaction-wide pre-rename gate.

### 10.5 Journal and rename sequence

The transaction must:

1. create unique temporary files in the same directory as their targets;
2. write complete new content;
3. fsync each temporary file;
4. preserve modes;
5. record a journal entry with:
   - transaction ID;
   - project identity;
   - relative path;
   - before hash;
   - after hash;
   - bounded before blob or recoverable before-content location;
   - creation time;
   - transaction state;
6. fsync the journal;
7. rename all temporary files into place;
8. update journal state after each phase;
9. mark the transaction committed only after all target renames succeed.

If a rename fails:

- restore already-renamed files from journal content or safe temporary copies;
- leave no partially applied transaction;
- record rollback status;
- return a bounded error;
- never report success.

Recovery must tolerate process termination at any point between journal creation and final commit.

### 10.6 Path and filesystem safety

The edit engine must enforce:

- source paths inside canonical `workspaceRoot`;
- no `..` escape after normalization;
- no absolute paths unless they resolve inside the workspace;
- no symlink path that resolves outside the workspace;
- denylisted file and directory patterns;
- no edits to generated artifacts unless explicitly and safely supported;
- no edits to the data root or registry unless a separate trusted internal operation exists;
- per-transaction file count cap;
- per-transaction input/output byte cap;
- maximum before-blob journal size;
- maximum plan age;
- maximum transaction time;
- permission and mode preservation.

Use `ProjectIdentity.assertProjectRoot`, `ProjectPaths`, and the existing security policy rather than duplicating root logic.

---

## 11. Verification

All edit results must use the following labels exactly:

```ts
export interface VerifyResult {
  syntax: 'passed' | 'failed';
  structural: 'passed' | 'failed' | 'skipped';
  behavior: 'passed' | 'failed' | 'not_run';
  details: {
    newErrors: unknown[];
    patternCounts?: unknown[];
    changedSymbols?: string[];
    validatorRuns?: unknown[];
  };
}
```

### 11.1 Syntax verification

Syntax verification must compare the diagnostic/error set before and after the proposed edit.

Requirements:

- identify existing parser or language diagnostics before the edit;
- identify diagnostics after the edit;
- match errors by kind and position adjusted for edits;
- fail only on newly introduced errors;
- preserve pre-existing errors as non-failing baseline state;
- report parser/language support limitations;
- distinguish “not parsed” from “no errors.”

The current `ProjectIndex.diagnostics` is line-based and may not contain every parser error node. If internal parser errors are needed for this check, add a reusable internal representation without changing the public `ProjectIndex` meaning.

### 11.2 Structural verification

Structural verification must include:

1. bytes outside edited ranges remain identical;
2. any formatter step explicitly waives the outside-range check and records that waiver;
3. each requested `patternCountDelta` is evaluated with the same structural-search engine and language;
4. `symbolsUnchanged` is evaluated using reusable outline-diff logic.

For `symbolsUnchanged`:

- every symbol whose range does not intersect an edit must retain its identity/key and signature hash;
- symbol ranges must be shifted or remapped deterministically;
- changed symbols must be listed;
- pre-existing index limitations must be reported;
- the algorithm must be reusable by v3 rename verification.

The existing `SymbolEntry` does not establish a public `signatureHash` field. V2 must define an additive signature-hash derivation or field and document the exact inputs. It must not silently change existing symbol IDs.

Structural verification may be `skipped` only when the request explicitly does not require it or the relevant parser/index capability is unavailable and the tool reports why.

### 11.3 Behavior verification

Behavior is:

```text
not_run
```

unless a configured allowlisted validator actually ran and passed.

The edit engine must never report semantic or behavioral success merely because:

- parsing succeeded;
- the structural pattern count changed as expected;
- a diff was generated;
- files were written;
- no new syntax errors appeared.

A validator failure returns `VALIDATOR_FAILED` and sets:

```text
behavior: 'failed'
```

A successful validator run may set:

```text
behavior: 'passed'
```

only for the scope and validator that actually ran.

---

## 12. Validators

### 12.1 Allowlist policy

Validators are configured by trusted server configuration:

```ts
validators: {
  [name: string]: {
    cmd: string;
    args: string[];
    cwd?: string;
    timeoutMs: number;
  };
}
```

Examples may include:

```text
tsc --noEmit
eslint
pytest -x
```

The examples are not automatically enabled.

Tools accept validator names only. They must never accept:

- arbitrary command strings;
- shell fragments;
- shell operators;
- environment assignments;
- command paths from untrusted tool input;
- arbitrary working directories;
- arbitrary environment overrides.

### 12.2 Process execution

Run validators with `spawn` and an argument vector, without a shell.

Requirements:

- enforce timeout;
- terminate the process group safely where supported;
- bound stdout and stderr;
- capture exit status and signal;
- redact secrets before returning output;
- constrain working directory to the project or a trusted configured descendant;
- record command name and args according to the configured disclosure policy;
- do not log approval tokens or secret environment values;
- distinguish timeout, nonzero exit, signal, and infrastructure failure.

Unknown validator names are rejected before any source write.

### 12.3 Validator failure policy

Plans may request:

```text
onValidatorFail: 'rollback' | 'keep'
```

Default policy should be `rollback` for write-enabled automated operation unless a deployment explicitly chooses otherwise.

If `rollback`:

- restore all changed files;
- verify restored hashes;
- update journal state;
- report validator output;
- report `behavior: 'failed'`.

If `keep`:

- leave changes in place;
- report that behavior failed;
- retain journal and transaction status;
- do not claim a successful verification.

---

## 13. Isolated apply mode

For a batch of independent edits, support:

```text
mode: 'isolated'
```

The engine must:

1. validate and apply each edit independently;
2. run requested validators after each edit or according to an explicitly documented batching policy;
3. retain passing edits;
4. roll back failing edits;
5. enforce maximum edit count;
6. enforce total time and byte limits;
7. report per-edit status, transaction ID, verification labels, and rollback result.

An isolated batch must not silently become one all-or-nothing transaction. Conversely, a normal transaction must not silently become isolated.

---

## 14. Undo and crash recovery

### 14.1 Undo

Add:

```text
edit_undo(txId)
```

Undo must:

1. load journal entries for `txId`;
2. read current target files;
3. compare each current hash to the recorded `after_hash`;
4. restore only if all current hashes match;
5. preserve modes and EOL/BOM bytes;
6. verify restored hashes;
7. mark the transaction undone.

If any current hash differs, return:

```text
UNDO_CONFLICT
```

and write nothing.

Undo must not overwrite a user's later edit.

### 14.2 Startup recovery

Expose a reusable:

```ts
recoverJournal()
```

The recovery path must run during the relevant Semantic Engine startup lifecycle, including the project/Gateway/runtime path where edit transactions are enabled.

Recovery must detect:

- prepared journal with no renames;
- partially renamed transaction;
- committed transaction with stale temporary files;
- rollback in progress;
- validator failure awaiting rollback;
- corrupted or oversized before blobs;
- expired plans or incomplete records.

Recovery must be idempotent and bounded. It must preserve a valid committed transaction, restore a demonstrably incomplete transaction, quarantine an unrecoverable record, and emit evidence. It must never silently discard a journal.

---

## 15. New AI tools and MCP mapping

Add the following tools through `AiToolRegistry`:

```text
structural_search
structural_rule_search
structural_dump
structural_test_rule
rules_list
edit_plan
edit_diff
edit_apply
edit_undo
edit_status
```

The tools must preserve the current `AiToolOutput` envelope:

```ts
{
  success,
  error?,
  items,
  context?,
  metadata?
}
```

New structured information may be carried in additive metadata or additive typed fields, but existing consumers reading `items` and MCP `content` must continue to work.

### 15.1 `edit_plan`

Accept:

- explicit edits; or
- structural pattern/rule plus replacement template;
- project identity;
- overlay selection;
- conflict/nested options;
- expectations;
- validators by name;
- validator-failure policy.

Return:

- `planId`;
- normalized edits;
- affected files;
- expected hashes;
- conflict results;
- overlay source state;
- expiration;
- project/index identity;
- no disk mutation.

### 15.2 `edit_diff`

Accept only a `planId`.

Return:

- unified diff;
- diff hash;
- affected files;
- expected and resulting hashes;
- verification preview;
- approval token when configured;
- warnings;
- no disk mutation.

The diff must be deterministic and bounded.

### 15.3 `edit_apply`

Accept only:

- `planId`;
- `confirm: true`;
- approval token if required;
- optional isolated mode.

Return:

- transaction ID;
- per-file result;
- verification result;
- validator runs;
- rollback status;
- index refresh status;
- project ID;
- index generation before and after, or explicit not-updated state.

### 15.4 `edit_undo`

Accept only a transaction ID and optional explicit confirmation according to the final tool schema.

Return:

- restored files;
- restored hashes;
- conflict state;
- journal status.

### 15.5 `edit_status`

Return bounded status for:

- plan existence and expiry;
- transaction state;
- journal state;
- validator status;
- recovery status;
- current file hashes;
- index refresh state.

Do not return unbounded before-content blobs through status.

### 15.6 MCP requirements

Test each new tool through:

1. `AiToolRegistry.execute`;
2. `AiToolRegistry.executeWithValidation`;
3. `SemanticEngineMcpServer.callTool`;
4. stdio transport where practical;
5. Gateway/HTTP route if that route is part of the selected acceptance path.

`tools/list` must expose all new schemas and descriptions. `content` and `structuredContent` must represent the same semantic result. Include:

- `projectId`;
- `indexGeneration`;
- plan/transaction identifiers;
- read-only/write state;
- verification labels;
- partial/degraded/not-run state.

The MCP server must not write because a client merely calls `edit_plan` or `edit_diff`. `edit_apply` remains subject to configuration, confirmation, approval, project policy, and preconditions.

---

## 16. Security and validator restrictions

### 16.1 Project scope

Every search and edit request must be scoped to a registered project.

- Resolve `projectId` through `ProjectRegistry`.
- Use its canonical `rootPath`.
- Do not trust a client-provided root when a project ID is available.
- If an explicit root is supported by a standalone CLI, canonicalize it and apply the same project/path policy.
- Include project identity in plan hashes, handles, approval tokens, journals, and status.

### 16.2 Path confinement

Reject:

- `..` traversal;
- normalized paths outside `workspaceRoot`;
- absolute paths outside the workspace;
- escaping symlinks;
- denylisted directories;
- generated artifacts unless explicitly allowed;
- data-root and registry paths;
- paths resolving through a replaced symlink between precondition and rename.

Where possible, re-check real paths immediately before rename.

### 16.3 Network and MCP boundary

Preserve existing loopback, token, origin, body-size, and Gateway-managed security behavior. New tools must not bypass `SecurityPipeline`, `HttpGuard`, or Gateway project routing.

Validators run locally under trusted configuration. They are not a general-purpose command execution facility.

### 16.4 Content and secret handling

Source text, captures, diffs, validator output, and overlay content are untrusted data.

- Apply output bounds.
- Redact configured secret values.
- Do not evaluate source text.
- Do not interpolate source text into shell commands.
- Do not log full source or before blobs by default.
- Do not include approval tokens in ordinary logs.
- Preserve explicit content truncation metadata.

---

## 17. Evaluation and benchmark requirements

V2 evaluation must measure, not assume, the following.

### 17.1 Structural search

- precision and recall on annotated fixtures;
- single-node capture correctness;
- variadic capture correctness;
- range conversion correctness;
- Persian, emoji, BOM, CRLF, and tab fixture results;
- enclosing symbol mapping;
- rule-pack valid/invalid behavior;
- invalid-rule warning behavior;
- rule test and dump output determinism;
- result ordering;
- limit enforcement;
- maximum-result-byte enforcement;
- timeout and cancellation behavior;
- unsupported language behavior;
- unsupported constraint behavior with `NOT_SUPPORTED`.

### 17.2 Edit planning

- plan hash determinism;
- duplicate edit deduplication;
- overlap rejection;
- nested policies;
- stale content rejection;
- overlay hash behavior;
- replacement-template capture behavior;
- reindent behavior;
- BOM and EOL preservation;
- outside-root and symlink rejection;
- denylist rejection;
- per-transaction caps.

### 17.3 Transaction and verification

- dry-run diff equals golden diff;
- no write when any precondition fails;
- no write when syntax or structural verification fails;
- no write during pre-rename validation failure;
- crash injection between renames;
- journal recovery;
- validator timeout;
- validator output bounds;
- automatic rollback;
- keep-on-failure behavior;
- isolated mode outcomes;
- undo success;
- undo conflict;
- mode preservation;
- byte-identical restoration.

### 17.4 Index and runtime integration

- successful edits trigger the documented incremental/index lifecycle;
- removed or changed symbols do not remain stale;
- artifact publication remains atomic;
- MCP reload observes the new generation;
- caches are invalidated at the right project/index boundary;
- project scope survives Gateway and worker lifecycle;
- a failed edit does not publish a new index generation;
- a committed edit does not claim a fresh index until reindexing actually completes.

### 17.5 Fuzz requirement

Use `fast-check` or an equivalent inspected property-testing library.

Generate at least 1,000 valid, non-overlapping edit sets over fixtures and verify:

```text
apply → undo → bytes exactly equal original
```

Required result:

```text
zero byte differences
zero unexplained transaction leaks
zero unhandled corruption cases
```

Any corruption blocks the v3 gate.

### 17.6 Existing package commands

At minimum, run and capture:

```bash
npm run build
npm test
npm run test:gate
npm run validate
npm run benchmark
```

Also run:

```bash
npm run lint
npm run snapshot
npm run check:audit
```

where applicable to the selected acceptance path.

If v2 adds `eval` or `bench` aliases, document them in `package.json`, execute them, and record their exact commands. Do not describe the existing `benchmark` script as `bench` without an explicit compatibility decision.

---

## 18. Required fixtures and tests

Use existing fixtures first, including `test/golden/` and generated fixture workflows. Add the smallest isolated fixtures needed for missing contracts.

### 18.1 Structural-search tests

Cover:

- JavaScript and TypeScript patterns;
- every language supported by the installed ast-grep adapter;
- unsupported-language handling;
- single captures;
- variadic captures;
- empty variadic captures where supported;
- comments and whitespace;
- nested matches;
- named-node/strictness option;
- enclosing `SymbolEntry`;
- file globs;
- symbol-kind filters;
- name regex filters;
- `inSymbolKey`;
- invalid regex;
- invalid inline rule;
- invalid YAML rule;
- duplicate rule IDs;
- rule warnings;
- dump output;
- test-rule output;
- deterministic ordering;
- limits and timeouts;
- Unicode and newline range conversion.

### 18.2 Edit tests

Cover:

- explicit edit plan;
- pattern-to-template plan;
- duplicate edit deduplication;
- overlap;
- nested `error`;
- nested `outermost`;
- nested `innermost`;
- stale content hash;
- overlay dirty buffer;
- `disk-wins`;
- `abort`;
- BOM;
- LF;
- CRLF;
- mixed EOL;
- no-final-newline;
- tabs;
- reindent;
- outside-root;
- `..` traversal;
- escaping symlink;
- denylist;
- read-only refusal;
- approval token;
- file cap;
- byte cap;
- plan expiration.

### 18.3 Verification tests

Cover:

- new syntax error fails;
- pre-existing syntax error passes;
- structural outside-range byte equality;
- formatter-waiver behavior;
- pattern count delta;
- symbols unchanged;
- changed symbol reporting;
- behavior `not_run` without validators;
- behavior `passed` only after a passing validator;
- behavior `failed` after validator failure.

### 18.4 Transaction tests

Cover:

- successful multi-file apply;
- temporary-file cleanup;
- fsync and rename failure injection;
- rollback after a partial rename;
- recovery after process/crash injection;
- journal size cap;
- mode preservation;
- undo success;
- undo conflict;
- repeated recovery idempotence.

### 18.5 Validator tests

Cover:

- unknown validator rejected;
- no shell execution;
- timeout;
- bounded stdout/stderr;
- nonzero exit;
- signal termination;
- automatic rollback;
- keep-on-failure;
- validator working-directory confinement;
- secret redaction.

### 18.6 Overlay tests

Cover:

- overlay search;
- overlay hash in plan;
- dirty overlay apply refusal;
- disk-wins;
- overlay cleanup;
- overlay path confinement;
- disk fallback when overlay is absent.

### 18.7 Integration tests

Add an MCP end-to-end path:

```text
structural_search
  → edit_plan
  → edit_diff
  → edit_apply
  → verify
  → edit_undo
```

The test must assert:

- tool discovery;
- input validation;
- project identity;
- index generation metadata;
- deterministic diff;
- read-only behavior before apply;
- successful apply only with configuration and confirmation;
- verification labels;
- undo restoration;
- byte equality after undo.

---

## 19. Staged Definition of Done

A stage is complete only when implementation, focused tests, package validation, and evidence for that stage are complete.

### Stage 1 — Baseline, decisions, and contracts

- capture revision, branch, Node/npm, lockfile, and scripts;
- inspect installed dependency APIs;
- inventory tools, MCP, project paths, runtime, persistence, and tests;
- create/update `DECISIONS.md`;
- create/update `CONTRACTS.md`;
- define range units;
- define edit offset units;
- define configuration names;
- define persistence migration;
- define error mapping;
- record absent or unverified capabilities.

### Stage 2 — Structural-search adapter

- integrate pinned ast-grep;
- support language selection;
- implement capture conversion;
- implement range conversion;
- implement limits and timeout;
- implement deterministic ordering;
- connect enclosing symbol lookup to `ProjectIndex`;
- add `ConstraintProvider` returning `NOT_SUPPORTED`;
- pass Unicode/range tests.

### Stage 3 — Rules and debugging tools

- load `.codeintel/rules/*.yml` or the documented configured path;
- validate rules;
- report invalid rules without crashing;
- implement `rules_list`;
- implement `structural_rule_search`;
- implement `structural_dump`;
- implement `structural_test_rule`;
- add golden and annotated fixtures.

### Stage 4 — Edit planning and diff

- implement `Edit`, `EditPlan`, and `EditBuilder`;
- implement structural-template replacements;
- implement overlap and nested policies;
- implement plan storage and TTL;
- implement `edit_plan`;
- implement `edit_diff`;
- implement diff hashing and approval tokens;
- keep all operations read-only.

### Stage 5 — Transactional apply and verification

- implement preconditions;
- implement path and symlink safety;
- implement EOL/BOM/mode preservation;
- implement in-memory parsing;
- implement syntax and structural verification;
- implement validator allowlist;
- implement transactional journal and rollback;
- implement `edit_apply`;
- maintain `WRITE_DISABLED` default.

### Stage 6 — Undo, recovery, overlay, and isolated mode

- implement overlay provider;
- implement dirty-overlay policy;
- implement isolated mode;
- implement `edit_undo`;
- implement `edit_status`;
- implement startup journal recovery;
- inject crashes between rename phases;
- verify byte-safe recovery and undo.

### Stage 7 — Runtime, index, and MCP integration

- route tools through `AiToolRegistry`;
- preserve `AiToolOutput`;
- expose tools through `SemanticEngineMcpServer`;
- attach project and index generation metadata;
- integrate with ProjectRegistry and ProjectPaths;
- trigger or explicitly report incremental index refresh;
- verify cache invalidation;
- verify Gateway/worker/project scope;
- run MCP e2e.

### Stage 8 — Evaluation, fuzz, and release evidence

- run structural precision/recall evaluation;
- run golden-diff evaluation;
- run at least 1,000 apply/undo fuzz cases;
- run build, lint, test, test gate, validation, snapshot, audit check, benchmark, and any added eval/bench commands;
- capture exit codes and artifacts;
- publish limitations and deviations;
- issue a v2 verdict only from executed evidence.

---

## 20. Final report requirements

The final implementation report must include:

- exact repository revision and branch;
- Node/npm versions;
- dependency lockfile hash;
- resolved ast-grep version;
- new dependencies and their licenses;
- changed files;
- new tools and schemas;
- configuration changes;
- migration number and status;
- persistence backend and recovery behavior;
- range and offset units;
- structural-search language support;
- ast-grep limitations;
- rule-pack validation behavior;
- match precision/recall;
- range conversion result, including all Unicode fixtures;
- edit-plan success rate;
- diff-golden result;
- transaction and rollback results;
- validator matrix;
- isolated-mode results;
- overlay results;
- undo and crash-recovery results;
- fuzz count and exact corruption result;
- MCP e2e result;
- package command results and exit codes;
- index refresh and generation behavior;
- known limitations;
- deviations from this document;
- rollback instructions;
- recommended v3 adjustments;
- verdict:

```text
VERIFIED
PARTIALLY VERIFIED
NOT VERIFIED
```

The verdict must state its evidence boundary. Source code presence is not runtime verification. Passing unit tests is not proof of Gateway, MCP, crash recovery, validator, or production behavior unless those paths were actually executed.

---

## 21. V3 extension points

V2 must leave the following stable extension points.

### 21.1 Semantic graph constraints

`ConstraintProvider` is wired into structural search. The default provider returns `NOT_SUPPORTED`. V3 may add graph-aware constraints without changing the basic `Match` shape or tool envelope.

### 21.2 Rename

V3's `edit_plan_rename` must generate only:

```ts
Edit[]
```

and reuse:

- plan hashing;
- overlap detection;
- preconditions;
- diff;
- transactional apply;
- verification;
- validators;
- journal;
- undo.

V2 must not embed rename-specific assumptions into the transaction engine.

### 21.3 Context building

V3 context-building tools may consume structural matches and edit verification details. V2 must preserve:

- project identity;
- index generation;
- source provenance;
- overlay/disk source state;
- truncation metadata;
- partial and unavailable states.

### 21.4 Outline diff and unresolved references

`symbolsUnchanged` must use reusable outline-diff logic. V3 may extend it with:

```text
unresolved reference count must not increase
```

without replacing the v2 structural verification contract.

### 21.5 Overlay host integration

The overlay provider is the integration boundary for VS Code or another host. The edit engine must not assume that all source content is on disk.

### 21.6 Independent transaction persistence

`edit_plans` and `journal` remain independent of future semantic-graph tables, rename tables, vector data, and `ProjectIndex` schema migrations.

---

## 22. Differences from the original CodeIntel v2 prompt

| Area | Original CodeIntel v2 assumption | Semantic Engine adaptation |
|---|---|---|
| Product | Standalone CodeIntel library | Existing `@aicoder/semantic-engine` package nested in a monorepo |
| Baseline | v1 parse/outline/fold/read/MCP/eval system | Existing ProjectIndex v2, scanner, extractors, graphs, AI tools, MCP, Gateway, artifacts, and runtime lifecycle |
| Source model | Outline-oriented standalone model | `ProjectIndex` schema `2.0.0` with files, symbols, diagnostics, metrics, graphs, provenance, vectors, Git, and AI metadata |
| Existing parser | New parser port/pool | Existing `web-tree-sitter` and repository parser/extractor managers; ast-grep is an additive search adapter |
| Symbol model | `SymbolKey` and outline helper | Existing stable file/symbol IDs and line-based `SymbolEntry`; new range and handle contracts are additive |
| Range model | Existing v1 canonical `Range` | Existing public model is line-based; v2 adds an explicit range/offset contract without changing line semantics |
| Search engine | ast-grep | ast-grep remains mandatory for structural matching; existing tree-sitter remains part of indexing and verification |
| Search tools | New standalone CodeIntel tools | New tools registered through `AiToolRegistry` and exposed through `SemanticEngineMcpServer` |
| Rule location | `.codeintel/rules/*.yml` | Retained as the default project-scoped location, subject to Semantic Engine path/configuration policy |
| Rule validation | zod assumed | Existing repository uses Ajv; zod or Ajv-equivalent must be selected and documented after API inspection |
| Tool envelope | New CodeIntel envelope | Preserve `AiToolOutput` with `success`, `error`, `items`, `context`, and `metadata` |
| MCP | Standalone MCP server | Existing SDK-pinned `SemanticEngineMcpServer`, stdio/HTTP entry points, `structuredContent`, project ID, and index generation |
| Project identity | A single root parameter | `ProjectRegistry`, canonical root, persistent project ID, aliases, `ProjectPaths`, and Gateway project scope |
| Artifact path | Disk root and SQLite cache | Separate `workspaceRoot`, `artifactRoot`, data root, registry, manifests, JSON index, and compatibility SQLite path |
| File provider | New CodeIntel `FileProvider` | Add an adapter above Semantic Engine's `FileSystemPort`, scanner, and overlay host boundary |
| Edit storage | SQLite `edit_plans` and `journal` assumed | Additive migration only after inspecting active persistence; retain JSON registry and `ProjectIndex` source-of-truth rules |
| Apply path | Direct standalone filesystem transaction | Transaction through project path/security policy, with index/artifact lifecycle integration |
| Verification | Parser/CST and outline model | Existing parser/extractor diagnostics, `ProjectIndex` symbols, structural search, and reusable outline diff |
| Validators | Configured command allowlist | Trusted Semantic Engine configuration, no-shell spawn, SecurityPipeline/HTTP/Gateway boundary, bounded output |
| Runtime | No project registry or Gateway requirement | ProjectRegistry, JobManager, IndexingWorker, GatewayServer, WorkerSupervisor, locks, and artifact reload |
| Overlay | New host integration | Additive `OverlayFileProvider`, compatible with future VS Code host and existing scanner/file-system boundaries |
| Eval command | `npm run eval` and `npm run bench` | Existing package has `validate` and `benchmark`; add aliases only if documented and executed |
| Benchmark | CodeIntel eval/bench | Existing fixture generation, snapshots, schema validation, Jest tests, audit checks, and `benchmark` script |
| Fuzz | `fast-check` assumed candidate | Current package does not declare it; resolve, inspect, pin, and run at least 1,000 round trips |
| Persistence recovery | Standalone startup recovery | Recovery must be attached to relevant Semantic Engine project/Gateway/runtime startup |
| Read/write policy | New CodeIntel config | Namespaced `semanticEngine.edit.*` configuration, `allowWrite` false by default, existing config schema remains strict |
| Security | Root and denylist | Existing root canonicalization, safe IDs, data-root separation, symlink policy, HTTP auth/origin controls, and validator restrictions |
| v3 | Semantic graph and rename are future features | Existing engine already has graphs and context tools; v2 must preserve compatibility and leave source-independent edit plans and constraint interfaces |
| Release gate | Build, test, eval, bench | Actual package command matrix plus executed structural, transaction, validator, recovery, fuzz, and MCP evidence |

---

## 23. Evidence boundary

This document is a target implementation and verification specification.

At the time of writing, the repository inventory establishes the existence of the current Semantic Engine package, schemas, source paths, tests, scripts, and lifecycle components. It does not establish that v2 structural search, YAML rules, edit transactions, validators, overlays, undo, recovery, fuzzing, or MCP e2e are complete.

Future status reports must distinguish:

- specified in this document;
- implemented in source;
- represented by a type or schema;
- covered by a test;
- executed locally;
- executed in CI;
- verified through MCP;
- verified through Gateway/runtime;
- verified against a real consumer.

Unknown or unexecuted behavior is:

```text
UNKNOWN / REQUIRES VERIFICATION
```

It is neither a pass nor a defect until the relevant evidence is collected.
