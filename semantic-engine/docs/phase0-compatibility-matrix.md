# Phase 0 — Compatibility Matrix (step 0.8)

Date: 2026-09-21 · Branch: `arena/01a0c3c9-semantic-engine-structured-ai`
Scope: every public surface a consumer can depend on, and what this branch
changed about it. "Additive" = old callers compile and behave identically;
"behavioral" = same API, intentionally different answer in cases that were
previously wrong or silent.

## Artifact set

| Surface | Change | Breaking? | Consumer action |
|---|---|---|---|
| `project-index.json` (schemaVersion 2.0.0) | none — byte format untouched | no | none |
| `project-artifacts.manifest.json` | none — writer unchanged | no | none |
| Pair coherence enforcement | **behavioral**: MCP server reload, MCP CLI entry, and HTTP reload all pass through one gate (`core/config/artifactManifest.assertIndexMatchesCommittedManifest`). HTTP already enforced; MCP/CLI are new. | no for coherent artifacts; **yes for byte-mismatched pairs** — before, MCP silently served them; now the last good snapshot stays active and reload retries | supply coherent pairs only — which the shipped `OutputWriter` always produces; if you hand-edit `project-index.json`, regenerate with `run index` |
| Legacy artifact without any manifest | none — still accepted by policy (D-0013) | no | none; regeneration recommended |
| `blueprint.json` beside index | none | no | none |

## MCP / CLI / Gateway

| Surface | Change | Breaking? | Consumer action |
|---|---|---|---|
| 14 MCP tools (names + JSON schemas) | none | no | none |
| `node dist/ai/mcp/cli.js <index>` startup | **behavioral**: refuses to start on a digest-mismatched pair (fail-closed) | only for mismatched pairs (see above) | regenerate the artifact |
| CLI flags (`index`, `--root`, `--data-dir`, `--artifact-location in-root|external`, `--project-id`) | none — a test that never passed the `in-root` flag now does | no | none |
| Gateway / worker protocol (`multiProject`, `protocolMatrix`, `WorkerSupervisor`, `ProjectLock` suites) | untouched on this branch; suites green | no | none |

## HTTP platform

| Surface | Change | Breaking? | Consumer action |
|---|---|---|---|
| Route surface (`/api/v1/...`) | none | no | none |
| `/visualization/architecture` & `…/dependencies` data | **behavioral fix**: the visualization `basis` vocabulary was a stale subset and silently dropped every real `import-resolved` edge; views now include them. `GraphEdge.metadata.basis` type widened to `EdgeBasis \| 'transitive' \| 'blueprint' \| 'index'` (D-0011) | additive for TS consumers of the union; JSON consumers may now see new basis strings (`ast`, `import-resolved`, `declared`, `unresolved`, `index`) | treat `basis` as an open string set |
| Single-module project architecture view | none — the SE-VIZ-01 file-level fallback is kept by decision (D-0012); the platform e2e fixture was degenerate and now has a module boundary | no | none |

## Public barrel (`src/index.ts`)

| Surface | Change | Breaking? | Consumer action |
|---|---|---|---|
| `GraphQueryEngine.path(from, to)` default depth | **behavioral fix**: a point-to-point path query no longer inherits the 2-hop neighborhood default; bounded by `maxNodes` + connected-component exhaustion instead (D-0010). Queries that passed explicit `depth` bit-for-bit identical | no — previously such queries returned `null`, which callers already had to handle | none |
| Contract exports (`LineIndex`, `makeHandle`, `makeSymbolKey`, `ok/fail`, `DEFAULT_CODEINTEL_CONFIG`, `canonicalJson`, envelope/error types, `deterministicPaths`, FileProvider types, `readCoherentArtifactSet`, `IncoherentArtifactSetError`, `InMemorySnapshotStore`, snapshot types) | **additive** | no | none |
| Everything else in the barrel | none | no | none |

## Cross-package

| Surface | Change | Breaking? | Consumer action |
|---|---|---|---|
| `structured-ai` consumer contract (`mcpIndexGeneration.test.ts`: index → MCP serve → generation bump) | none — suite green after all changes | no | none |
| Node/toolchain (Node 22, `tsc -p ./` strict, jest maxWorkers 1) | none | no | none |

## Verdict

No consumer action is required anywhere except: do not run the MCP/CLI serve
paths against a hand-mutated `project-index.json` whose manifest was not
regenerated. That case was undefined behavior before (silently served) and is
now a hard, named error — the definition of a fail-closed fix.
