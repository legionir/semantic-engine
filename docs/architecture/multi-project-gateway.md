# ADR — Multi-Project Gateway, per-project Workers, external data directory

**Status:** accepted (فاز ۱–۴ of `MULTI_PROJECT_GATEWAY_EXECUTION_PLAN.md`)
**Date:** 2026-08-26
**Source of requirements:** [`MULTI_PROJECT_GATEWAY_PLAN.md`](../../../MULTI_PROJECT_GATEWAY_PLAN.md)
**Executable plan (order, contracts, acceptance):** [`MULTI_PROJECT_GATEWAY_EXECUTION_PLAN.md`](../../../MULTI_PROJECT_GATEWAY_EXECUTION_PLAN.md)

This record exists so the next implementer does not re-derive the decisions
from scratch, and so a decision that changes later changes *here* first.

---

## 1. The target shape

```text
Browser / AI client
        │
        ▼
Semantic Gateway :4000          ← the only public port
        │
        ├── Worker project A    ← one process, one workspace, one index
        ├── Worker project B
        └── Worker project C
```

A Worker stays single-project: one `workspaceRoot`, one project index, one
blueprint, one vector index, one watcher, one MCP/REST
runtime. The Gateway orchestrates; it does not analyse code.

---

## 2. Decisions

### D1 — one platform-aware data root, no doubled directory

| platform | default data root |
|---|---|
| Linux / other POSIX | `$XDG_DATA_HOME/semantic-engine`, else `~/.local/share/semantic-engine` |
| macOS | `~/Library/Application Support/SemanticEngine` |
| Windows | `%LOCALAPPDATA%\SemanticEngine` |

Override: `SEMANTIC_ENGINE_DATA_DIR` (or config `semanticEngine.dataDir`).
Created with mode `0700`.

The reference plan wrote `{{USER_DATA}}/.semantic-engine/` in one section and
`$XDG_DATA_HOME/semantic-engine` in another; composed literally that yields
`~/.local/share/semantic-engine/.semantic-engine/…`. **The platform directory
name is the only nesting**; there is no `.semantic-engine` under it.
Implemented in `src/core/config/DataRootResolver.ts`.

A relative `XDG_DATA_HOME` is ignored (the spec calls it invalid) rather than
joined onto the cwd.

### D2 — configuration arrives through the existing schema

`semanticEngine.dataDir` and `semanticEngine.artifactLocation`
(`in-root` | `external`, default `in-root` until فاز ۴) are declared in
`contracts/config.schema.json`. Because `envVarNameFor`
(`src/host/Config.ts:105-110`) maps `semanticEngine.dataDir` to
`SEMANTIC_ENGINE_DATA_DIR`, no second hand-rolled environment variable exists.
`src/host/configSchemaSync.test.ts` keeps schema and code in sync.

Note: the schema uses `["string","null"]` with `default: null` for `dataDir`,
matching `semanticEngine.treeSitter.grammarDir`, instead of the empty string
the plan text mentioned.

### D3 — project id: `prj-<slug(name)>-<sha256(canonicalRoot)[0:8]>`

Identical to the algorithm already shipped by the consumer
(`structured-ai/agent/projects/ProjectRegistry.js:61`, e.g.
`prj-engine-core-3fa9c1d2`), so engine and consumer agree without a
translation table. The reference plan's `prj-<uuid>` is **replaced**, not
supplemented. Implemented in `src/core/config/ProjectIdentity.ts`.

Why not `basename`: `ProjectService.registerProject` used
`prj-${basename(root)}`, so `/tmp/client-a/app` and `/tmp/client-b/app` both
became `prj-app` and the second registration silently replaced the first
(measured: `listProjects().length === 1`).

An id is computed once at registration and persisted. Renaming changes the
display name only; moving is an explicit `relocate` (فاز ۲).

### D4 — the registry owns identity; the canonical root is the unique key

`<dataRoot>/registry.json` is authoritative for Worker/Gateway routing.
Registering a root that is already registered returns the existing record
instead of creating a second one. An externally supplied id is adopted
verbatim so structured-ai can keep the ids it already stored.

Implemented in `src/core/config/ProjectRegistry.ts`
(atomic `registry.json`, corrupt files quarantined as
`registry.json.corrupt-<ts>` instead of crashing, per-project
`<dataRoot>/projects/<id>/manifest.json`).

**Which ids are acceptable (refined in فاز ۲).** The generated form is
`prj-…`, but ids already in the wild are freer: `serve` registers the
workspace as `current` and `<basename>` (`serve-command.ts:171-173`) and
`HttpServer.test.ts:173` expects `sample-app` to survive. Three validators
therefore exist in `ProjectIdentity.ts`:

| validator | charset | used for |
|---|---|---|
| `isValidProjectId` | `^prj-[a-z0-9][a-z0-9-]{0,63}$` | ids the engine generates |
| `isSafeProjectId` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, no `..` | lookup keys / aliases |
| `isPathSafeProjectId` | same, lowercase only | ids that become a **directory name** |

Lowercase is required for directory names because macOS and Windows are
case-insensitive: two ids differing only in case would collide on disk.

**Aliases.** Every id a project has ever been registered under resolves
through `ProjectService.getProject`, but `listProjects()` (and therefore
`GET /api/v1/projects`) returns each project **once**. That is an intentional
behaviour change: `serve` used to produce three rows for one workspace.

**Not yet done:** `ProjectService` does not hydrate itself from the registry
at startup; a fresh process starts empty and the Gateway loads projects in
فاز ۹. Re-registering a known root still yields the persisted id.

### D5 — Worker transport

Loopback TCP on a Gateway-allocated ephemeral port plus an internal worker
token is the default. A Unix domain socket is supported only after
`SecurityPipeline` understands it (فاز ۶). `SO_REUSEPORT` across workers is
forbidden: routing must stay deterministic.

### D6 — Origin policy behind the Gateway

Today `SecurityPipeline.checkOrigin` (`src/server/SecurityPipeline.ts:165-193`)
and `HttpGuard` (`src/cli/HttpGuard.ts:120-124`) reject any non-loopback
`Origin` with 403, and `checkConnection` (`:89-105`) rejects a Unix-socket
request outright because `req.socket.remoteAddress` is `undefined`. Both are
correct for a standalone local server and both break a proxied one, so:

- the Gateway strips the inbound `Origin` and sets `X-Forwarded-For/Proto/Host`;
- a Worker in `--gateway-managed` mode trusts the Gateway **only** when the
  internal worker token is valid;
- standalone behaviour (loopback + Origin check) is unchanged.

### D7 — API namespace

Workers keep `/api/v1/projects/:id/…` unchanged. Gateway administration lives
under `/api/v1/gateway/*`. `/api/v1/projects/:projectId/…` is proxied to the
owning worker **without path rewriting**. The Gateway itself answers
`GET/POST /api/v1/projects` with the same response shape as
`src/server/routes/projectRoutes.ts:12-52` so `public/open.js:195` keeps
working untouched.

### D8 — `indexGeneration`

A monotonic counter persisted in `<artifactRoot>/project-artifacts.manifest.json`,
incremented on every successful index/blueprint write, published
additively as `structuredContent: { projectId, indexGeneration }` on MCP
results. The consumer already reads it
(`structured-ai/agent/mcp/SemanticClient.js:251-262`) and invalidates its
cache when it changes; the engine emits nothing today.

### D9 — WebSocket is implemented (owner decision, 2026-08-26)

There is no WebSocket in the codebase now: no `upgrade` listener, no `/ws`
route, no `ws` dependency, and `WebSocketManager`
(`src/server/WebSocketManager.ts:20-43`) writes SSE frames into an
`http.ServerResponse`. فاز ۱۱ adds a minimal RFC 6455 server (handshake with
`Sec-WebSocket-Accept`, text/ping/pong/close frames) without a new dependency,
plus a Gateway upgrade proxy that resolves the project *before* upgrading.

### D10 — backward compatibility

`--out` (absolute or relative) and `SEMANTIC_ENGINE_ARTIFACT_LOCATION=in-root`
remain supported for the whole project. The default flips in فاز ۴ together
with every consumer that guesses the artifact path. Removing either is a
separate decision.

### D11 — a managed Worker is genuinely single-project

In `--gateway-managed` mode the worker's own registry routes
(`POST /api/v1/projects`) are closed, any `rootPath`/`path` arriving in a
request that differs from the registered workspace is rejected, and
`/api/v1/fs/browse` (`src/server/routes/fsRoutes.ts:61-122`, which today lists
any path) is confined to the workspace subtree.

---

## 3. Contracts introduced in فاز ۱

```ts
// src/core/config/DataRootResolver.ts
resolveDataRoot(options?: DataRootOptions): string;   // pure
platformDataRoot(options?: DataRootOptions): string;
ensureDataRoot(options?: DataRootOptions): string;    // creates 0700, verifies writable

// src/core/config/ProjectIdentity.ts
canonicalizeRoot(rootPath: string): string;           // realpath, textual fallback
assertProjectRoot(rootPath: string): string;          // throws: missing / not a directory
projectIdFor(name: string, canonicalRoot: string): string;
isValidProjectId(id: unknown): boolean;
assertProjectId(id: string): string;                  // id is a directory name — validated first

// src/core/config/ProjectPaths.ts
resolveProjectPaths(options: ResolveProjectPathsOptions): ProjectPaths;
artifactRootFor(options: ResolveProjectPathsOptions): string;

// src/core/config/migrateLegacyArtifacts.ts (فاز ۳)
migrateLegacyArtifacts(options): MigrationResult;   // copy, never delete

// src/cli/projectPathsFromArgs.ts (فاز ۳)
projectPathsFromArgs(args, workspaceRoot, env?): ProjectPaths;
indexLookupFromArgs(args, workspaceRoot, env?): IndexLookupOptions;
artifactLocationFromArgs(args, env?): ArtifactLocation;

// src/core/config/ProjectRegistry.ts (فاز ۲)
class ProjectRegistry {
  register(input: RegisterProjectInput): ProjectRecord;   // duplicate root → existing record
  get(idOrAlias: string): ProjectRecord | undefined;
  getByRoot(rootPath: string): ProjectRecord | undefined;
  list(): ProjectRecord[];
  rename(id, name): ProjectRecord;                        // id never changes
  relocate(id, newRoot): ProjectRecord;                   // explicit only; refuses a claimed root
  remove(id): boolean;
  touch(id): ProjectRecord | undefined;
  writeManifest(record): string;                          // data root only
}
```

`ProjectPaths` separates the two kinds of path on purpose:

| field | meaning |
|---|---|
| `workspaceRoot` | source; read-only for the engine |
| `artifactRoot` | everything generated: index, blueprint, manifest |
| `lockDir`, `logDir` | `locks/`, `logs/` under `artifactRoot` |

Rules that follow from this and are enforced by tests:

1. No caller re-derives an artifact path; `resolveProjectPaths` is the only
   source. A hand-written `path.join(root, '.semantic-engine')` is a bug.
2. `projectId` is validated before it is ever joined into a path, so
   `prj-../evil` is an error rather than an escape.
3. While `in-root` is the default, `resolveProjectPaths(...).indexPath ===
   canonicalIndexPath(root)` — the new API is a superset, not a change.

---

## 4. Endpoint map (targets; implemented in later phases)

| surface | route | phase |
|---|---|---|
| Worker internal | `GET /internal/health`, `/internal/ready`, `/internal/metrics`, `/internal/status`, `POST /internal/reindex`, `/internal/reload`, `/internal/shutdown` | ۷ |
| Worker public (unchanged) | `GET /health`, `/ready`, `/metrics`; `/api/v1/projects/:id/…` | — |
| Worker MCP | `POST /mcp` (guarded by `HttpGuard`) | — |
| Gateway admin | `GET/POST /api/v1/gateway/projects`, `GET/PATCH/DELETE /api/v1/gateway/projects/:projectId`, `POST …/start|stop|restart|reindex`, `GET /api/v1/gateway/health|ready|metrics|events` | ۹ |
| Gateway proxy | `/api/v1/projects/:projectId/…`, `GET /api/v1/projects/:projectId/events` (SSE) | ۹ |
| Gateway MCP | `POST /mcp/:projectId` → worker `/mcp` | ۱۰ |
| Gateway WebSocket | `/ws/projects/:projectId` (resolved before upgrade) | ۱۱ |

---

### Worker profiles (فاز ۶)

Two profiles, one codebase. `PlatformConfig.gatewayManaged` switches between
them; nothing else in the request pipeline changes.

| | standalone (`ui`, `serve`) | `--gateway-managed` |
|---|---|---|
| transport | TCP on `--host`/`--port` | Unix socket (`socketPath`) or loopback TCP |
| auth | `requireAuth: false` routes are open | **every** route needs the internal token |
| `Origin` | judged (loopback only) | not judged, but `X-Forwarded-*` must be present |
| `POST /api/v1/projects`, `PATCH`/`DELETE /api/v1/projects/:id`, `import-bundle`, `source/upload` | available | **403** |
| `path`/`rootPath`/`root`/`workspaceRoot` in a body | accepted | 403 unless inside the workspace root |
| `/api/v1/fs/browse` | may roam (the UI's project picker needs it) | confined to the workspace subtree, checked after `realpath` |

Two measurements drove this:

```text
checkConnection({ socket.remoteAddress: undefined }) → 403   (before فاز ۶)
checkOrigin({ origin: 'https://gateway.example' })   → 403   (before فاز ۶)
```

The first is why the Unix-socket transport could not carry a request at all —
a socket has no peer address — and the second is why a correctly proxied
request was refused. A socket connection now counts as local **only** when the
server really listens on a socket path, and in managed mode it still needs the
internal token; a proxied request is recognized by the `X-Forwarded-*` headers
the Gateway sets, so a direct request from a browser page is still rejected.

The Gateway's side of the contract: strip the inbound `Origin`, set
`X-Forwarded-For/Proto/Host`, send the worker token, and never forward a
`rootPath`.

## 5. Artifact resolution and migration (فاز ۳)

**Resolution order** — identical for `index`, `watch`, `serve`, `ui`, `start`,
`query` and the standalone MCP entry point, all through
`src/cli/projectPathsFromArgs.ts`:

```text
--out (explicit, absolute or relative to the root)
  > --data-dir / SEMANTIC_ENGINE_DATA_DIR
  > platform default (D1)
```

The *location* comes from `--artifact-location` or
`SEMANTIC_ENGINE_ARTIFACT_LOCATION`; the default is still `in-root`, so nothing
changes until فاز ۴ flips it. A project id is `--project-id` when given and
path-safe, otherwise `projectIdFor(basename, canonicalRoot)` — deterministic,
so repeated runs land in the same directory.

**Read order** in `external` mode: the data directory first, then the three
in-root legacy locations as readable fallbacks
(`indexPathCandidates(workspaceRoot, lookup)`).

**Migration** (`migrateLegacyArtifacts`) copies `project-index.json`,
`blueprint.json` and `project-artifacts.manifest.json`
from the first existing legacy directory into the artifact root and writes
`migration.json`:

```json
{
  "schemaVersion": 1,
  "migratedFrom": "/repo/app/.agent/semantic",
  "migratedAt": "2026-08-26T12:00:00.000Z",
  "migrationMode": "copy-readonly-legacy",
  "files": ["project-index.json", "blueprint.json"]
}
```

Legacy files are **never deleted**. A legacy index that fails to parse returns
`corrupt-legacy` instead of throwing, so one broken checkout cannot stop the
server; the project simply stays `stale`/`missing`.

**Process state** — job queue state and telemetry spans used to be written to
`<projectsRoot>/.agent/` (two such files are committed in this repository).
They now live in `<dataRoot>/runtime/` (`jobs.json`, `telemetry/spans.json`),
and when no `dataRoot` is configured nothing is persisted at all. Per-project
`locks/`, `logs/`, `events/` and `snapshots/` live under the artifact root.

**Gate** — `scripts/check-artifact-location.js` (wired into `npm run
test:gate`) fails when any non-test source file builds a path from the literal
`'.semantic-engine'` outside the allowlist
(`core/config/ProjectPaths.ts`, `core/config/defaultIgnorePatterns.ts`,
`services/source/SourceSyncService.ts`). Only the exact directory name counts,
so `doctor`'s temporary `.semantic-engine-doctor-<pid>` write probe is not
flagged.

## 6. The default flipped in فاز ۴

`semanticEngine.artifactLocation` now defaults to **`external`**: a fresh
`semantic-engine index --root <repo>` writes nothing into `<repo>`. `in-root`
remains a supported mode (`--artifact-location in-root` /
`SEMANTIC_ENGINE_ARTIFACT_LOCATION=in-root`) and `--out` overrides both.

The consumer side of the contract lives in
`structured-ai/agent/mcp/enginePaths.js` (data home + `projectIdFor` mirror),
used by `agent/mcp/semantic.js`; `SEMANTIC_ENGINE_DATA_DIR` is a declared
setting there. Three tests hold the two packages together:

| test | what it pins |
|---|---|
| `structured-ai/test/mcp/engine-paths.test.js` | data home per platform, id derivation, read order, `checkStaleness` on both locations |
| `src/core/config/structuredAiContract.test.ts` | the engine and the consumer compute identical data homes, slugs and ids |
| `src/cli/commands/artifactLocationExternal.test.ts` | the real CLI writes only under the data root |

Container: `SEMANTIC_ENGINE_DATA_DIR=/data` in
`Dockerfile` and `structured-ai/docker-compose.yml`, with a
named volume mounted at `/data` — the compose service runs `read_only: true`,
so without the volume the default data directory would not be writable.

**Test hygiene.** Tests must not write into a developer's home. Two jest hooks
are required, because `process.env` inside a jest sandbox is a *copy* and never
reaches `child_process`: `globalSetup`
(`src/test/globalSetupDataDir.ts`) sets the temporary data root in the real
process environment so spawned CLI children inherit it, and `setupFiles`
(`src/test/setupDataDir.ts`) covers in-sandbox resolution.

## 7. Worker configuration and embedding providers (فاز ۵)

`src/gateway/types.ts` defines `ProjectWorkerConfig`: project identity,
`indexing`, `watchOptions`, `service`, `security` and `embedding`.
`WorkerConfigSchema.ts` supplies the defaults, the equivalent JSON Schema (used
for server-side validation and, in فاز ۱۲, to generate the UI form) and
`validateWorkerConfig`, which returns **every** problem at once.

Rules worth knowing:

- a `projectId` must be usable as a directory name;
- `dataDir` and `socketPath` must not live inside the checkout;
- `debounceMs` must be an integer in `[25, 60000]`;
- a gateway-managed worker must not allow remote connections and must name the
  environment variable holding its internal token;
- **a secret is not a field**: passing `token` or `apiKey` in a config is a
  validation error, and `redactWorkerConfig` projects onto known fields so a
  future field cannot leak into a log or a manifest by accident.

`workerArgv(config)` is the only place that turns a config into process
arguments. It is deterministic, whitelisted, contains no shell
metacharacters in its flags, and carries no secret — not even the token's
variable name, which the supervisor sets in the child's environment instead
(فاز ۶). `commandPreview` renders the same vector for display only.

**Embedding** now has one decision point, `vector/createEmbeddingGenerator`,
shared by `server/routes/jobRoutes.ts` and the CLI flags
(`--embedding-provider|-model|-base-url|-api-key-env|-normalize`). `local` is
deterministic hashing with no native dependency; `ollama` and
`openai-compatible` require a base URL and a model and fail loudly otherwise.
An API key is read from the environment variable *named* by
`--embedding-api-key-env`, at the last moment, and never appears on a command
line, in `--json` output, or in a log. Asking for a provider implies
`--vectors`.

## 8. The worker process and `indexGeneration` (فاز ۷)

`semantic-engine worker` serves exactly one project until it is told to stop.
It is the unit the Gateway supervises, and it also runs standalone.

```text
semantic-engine worker --root <repo> [--project-id <id>] [--data-dir <dir>]
                       [--socket <path> | --port <n>] [--token <secret>]
                       [--gateway-managed] [--no-watch] [--skip-initial-index]
```

Internal surface (every route needs the token, in both profiles):

| route | behaviour |
|---|---|
| `GET /internal/health`, `GET /internal/status` | 200 when the index is loaded, otherwise 503, with `projectId, pid, state, indexState, watcher, files, symbols, dependencies, vectorChunks, blueprint, memoryMb, queueSize, lastIndexedAt` |
| `GET /internal/ready` | 200 only once an index is loaded — this is what the Gateway waits for instead of guessing |
| `GET /internal/metrics` | `worker_*` counters |
| `POST /internal/reindex` | 202, one run at a time (409 while busy) |
| `POST /internal/reload` | re-read the artifacts from disk |
| `POST /internal/shutdown` | answers 200 first, then stops the watcher, closes the server, removes the socket file and exits 0 |

`SIGINT`/`SIGTERM` take the same graceful path.

These sit *beside* the pre-existing `/health`, `/ready` and `/metrics`, which
keep their old meaning for standalone use; `/internal/*` is the
worker-as-supervised-process view.

**`indexGeneration`** (D8) is a monotonic counter in
`project-artifacts.manifest.json`, bumped by `OutputWriter` on every successful
write and republished whenever the MCP server reloads. `tools/call` answers
with `content` exactly as before plus

```json
{ "structuredContent": { "…tool output…": null, "projectId": "prj-…", "indexGeneration": 3 } }
```

The consumer needs no change: `structured-ai`'s `unpackToolResult` prefers
`structuredContent`, and its `trackGeneration` already drops the whole result
cache when that number moves. An index written before this phase has no counter
and reports `0`, which keeps the consumer in its old cache-off behaviour.

## 9. Supervision, locks and capacity (فاز ۸)

```text
WorkerSupervisor
 ├── WorkerProcess      one child process, one socket, one log file
 ├── WorkerHealthMonitor  crash detection + restart policy
 └── ProjectLock        <dataRoot>/projects/<id>/locks/{worker,index}.lock
```

**Layout under the data root**

```text
<dataRoot>/gateway/sockets/<projectId>.sock
<dataRoot>/gateway/logs/<projectId>.log
<dataRoot>/projects/<projectId>/locks/worker.lock
```

**Spawning** uses `spawn(..., { shell: false })` with the argument vector from
`workerArgv`; the token travels in `SEMANTIC_ENGINE_WORKER_TOKEN`, never on the
command line. `start()` resolves only after `/internal/ready` answers 200.

**Locks** are files created with `O_EXCL` (`flag: 'wx'`), so the race is decided
by the filesystem. The file carries `{projectId, pid, kind, acquiredAt,
heartbeatAt}`; a lock is taken over when its owner is dead (`kill(pid, 0)`) or
its heartbeat is older than 30s. `worker.lock` allows one worker per project,
`index.lock` one index run per project — different projects still index in
parallel.

**Restart policy** is `1s → 3s → 10s`, and after five crashes in a row the
worker is marked `degraded` and the supervisor stops trying. Two details that
only measurement revealed:

- the crash counter must **survive a restart**. Resetting it in `spawn()` made
  the limit unreachable: every restart zeroed the counter, so a worker could
  crash forever (`restart, restart, restart, …` and never `degraded`).
- a stale `*.sock` left by a SIGKILLed worker means `EADDRINUSE`, so the
  supervisor removes the socket file before spawning.

**Capacity** is refused loudly: `CapacityError` (→ 503/429 in فاز ۹) when
`maxWorkers` or `maxConcurrentIndexJobs` is reached, and `LockHeldError` when
another live process already serves the project.

## 10. The Gateway HTTP surface (فاز ۹)

```text
GET    /health, /ready, /metrics            open (no project data in them)
GET    /api/v1/gateway/health|ready|metrics
GET    /api/v1/gateway/events               SSE: worker + registry events
GET    /api/v1/gateway/projects             list
POST   /api/v1/gateway/projects             register (+ autoStart)
GET    /api/v1/gateway/projects/:id
PATCH  /api/v1/gateway/projects/:id         rename
DELETE /api/v1/gateway/projects/:id         stop + unregister
POST   /api/v1/gateway/projects/:id/start|stop|restart|reindex

GET    /api/v1/projects                     the shape public/open.js renders
POST   /api/v1/projects                     the call public/open.js makes
ANY    /api/v1/projects/:id/...             proxied to that worker, unrewritten
```

**Proxy rules.** Body and response are piped, never buffered, so uploads,
long tool calls and SSE behave as they would against the worker. The inbound
`Origin` is dropped, `X-Forwarded-For/Proto/Host` are added (which is how the
worker recognizes a proxied request), `Authorization` is replaced with the
worker's internal token, and hop-by-hop headers are not forwarded. Every
proxied response carries `X-Semantic-Project-Id`, so a client can tell whose
answer it is reading without buffering the body. A dead worker is a clean
`502`; its neighbours keep serving.

**Authorization** reuses the platform vocabulary instead of inventing one:
`ApiKeyStore` keeps tokens as SHA-256 hashes with `PermissionScope`
permissions, and `ApiKeyRecord` gained an optional `allowedProjects` list
(absent means the old `resourceScope` still applies, so existing keys keep
working). `'*'` means every project. Errors are `401` without a token, `403`
for a project the token cannot reach, `404` for an unknown project, `503` when
`maxWorkers` is full and `409` when another live process holds the project
lock.

**The Gateway token is not a worker token.** The internal token is fetched
from the supervisor per request and never returned to a client — covered by a
test that asserts it appears in no response body.

## 11. MCP through the Gateway (فاز ۱۰)

The worker serves MCP on the same socket as everything else:

```text
POST /mcp            (worker; one StreamableHTTPServerTransport per request)
POST /mcp/:projectId (gateway; proxied to /mcp, path rewritten to the worker's own)
```

One transport per request is the rule `ai/mcp/cli.ts` already followed —
sharing one between requests is a race on a single object. The MCP server is
constructed with `projectId` and `indexPath`, so every answer carries
`structuredContent.projectId` and `structuredContent.indexGeneration` (فاز ۷).

Session binding is structural rather than tracked: each project has its own
socket, so a session cannot drift to another project, and the path is never
rewritten beyond `/mcp/:id` → `/mcp`.

`semantic-engine gateway --port 4000 --token …` is the public entry point; it
prints `gateway url=… token=…` on stderr so a harness can pick it up, and it
stops every worker on `SIGINT`/`SIGTERM`.

**Cross-package proof.** `structured-ai/test/mcp/gateway.integration.test.js`
starts the real gateway, registers two projects whose directories share a name,
and drives them through the shipped `SemanticClient` + `HttpTransport`
(`semanticEndpoint = http://127.0.0.1:<port>/mcp/<id>?token=<token>`). It
asserts per-project answers, a numeric `indexGeneration` on the consumer side,
and that reindexing A moves **only** A's generation. The stub
(`test/helpers/stubSemanticGateway.js`) stays for the fast unit tests; this
file is the integration half and skips itself when the engine is not built.

## 12. WebSocket (فاز ۱۱)

Until this phase "WebSocket" was a name without a protocol: `WebSocketManager`
writes SSE frames into an `http.ServerResponse`, nothing performs a handshake,
and there is no `ws` dependency. That manager is still there (the visualizer
uses it over SSE); the real channel is new and dependency-free.

```text
client  ──GET /ws/projects/:id──▶  Gateway
                                    │ projectId, token and project access are
                                    │ checked BEFORE the upgrade
                                    ▼
                                 worker /ws   (one channel, one project)
```

`gateway/wsProtocol.ts` holds the RFC 6455 pieces — accept key, frame
encoding, and an incremental decoder that reassembles a frame split across TCP
segments. Text, ping, pong and close are supported; binary and continuation
frames are rejected with `1003`, and a frame claiming more than 4 MiB is
refused rather than allocated.

Two rules worth recording:

- `projectId` is resolved **before** the upgrade, so an unknown project (404),
  a missing token (401) or a token without the project (403) never reaches a
  worker; after the upgrade the socket is bound to that project's socket and
  cannot drift.
- every frame carries the channel's `projectId`, taken from the channel and
  not from the message, so a client cannot address another project by writing
  `projectId` into its payload.

**Measured bug, fixed:** the proxy dropped `Connection` as a hop-by-hop
header. Node then never fired the `upgrade` event on the worker and the
request fell through to the route table — the worker answered `101` when
contacted directly and `404` through the Gateway. `Upgrade: websocket` and
`Connection: Upgrade` are now written explicitly.

**Second measured bug, fixed:** the supervisor did not tell the worker which
data root to use, so a Gateway-managed worker wrote its artifacts to the
platform default data directory while its socket, lock and log lived under the
Gateway's data root. The supervisor now sets `SEMANTIC_ENGINE_DATA_DIR` in the
child environment, and a regression test asserts the index lands under
`<dataRoot>/projects/<id>/`.

## 13. The Gateway console (فاز ۱۲)

```text
/gateway            console page (public/gateway.html)
/gateway.js|css     its logic and style
/projects/:id       302 → /visualizer?project=:id   (deep link)
/visualizer…        the existing project dashboard, unchanged
```

Assets are served without a token — the page contains no project data, and
every value it renders comes from the token-protected `/api/v1/gateway/*`
routes. Serving is alias-based (a fixed map of names to files under `public/`)
plus a `realpath` prefix check, so no request can read outside the asset
directory.

The deep link is a redirect rather than a page of its own: the project stays in
the URL, so a refresh keeps the same context and the existing visualizer (which
already reads `?project=`) needs no change.

**One rule shaped `gateway.js`:** the form is data, not scattered assignments.
`WORKER_FORM_FIELDS` maps every field to exactly one dotted
`ProjectWorkerConfig` key, and a test asserts both directions — no field maps
to a key that is not in the schema, and no schema key is unreachable from the
form. Validation in the browser mirrors `validateWorkerConfig`, so an operator
sees the same errors before the Gateway does.

The command preview is built from the same argv rules `workerArgv` uses and is
display-only; it never contains a secret value, only the environment variable
name. Live updates come from `GET /api/v1/gateway/events` (SSE) with a 30s poll
as the fallback, so a busy Gateway is not re-read every few seconds.

The pure half of `gateway.js` never touches the DOM at load time, which is what
lets Node require it and test the mapping, validation, rendering and URL
building directly.

## 14. Metrics, cache and deployment (فاز ۱۳)

**The metric key sets are a contract**, declared once in `gateway/metrics.ts`
(`GATEWAY_METRIC_KEYS`, `WORKER_METRIC_KEYS`) and asserted in tests as an exact
key set — not "has these keys". A renamed metric breaks a test instead of
silently emptying a dashboard column.

`gateway_request_duration_ms` is a bounded sample window (`count/sumMs/avgMs/
maxMs/p95Ms`), deliberately not a full histogram: a Gateway that stays up for
weeks must not grow per request. `worker_cpu_percent` is
`(user+system)/wall*100`, so more than 100 means more than one core.
`worker_restart_count` is passed to the child in
`SEMANTIC_ENGINE_WORKER_RESTART_COUNT`, because only the supervisor knows how
often a worker came back.

**Health detail** (`GET /api/v1/gateway/projects/:id/health`) merges what only
the worker knows (`/internal/health`) with what only the Gateway knows (restart
history, last error, degraded). One worker's failure is recorded against that
project alone; the Gateway's own `/health` and the neighbours stay green.

**`semantic-engine cache`** is the housekeeping for data that now lives outside
the checkout: `list`, `clean --project`, `clean --older-than <n[s|m|h|d]>`,
`export`, `import`. Its one rule is that it deletes generated data and nothing
else, enforced twice: the target must be strictly inside `<dataRoot>/projects/`,
and it must not overlap any workspace registered in `registry.json`.
`clean --older-than` is a dry run unless `--force` is passed.

**Deployment:** `structured-ai/docker-compose.yml` gains a `semantic-gateway`
service — only the Gateway publishes a port, workers are child processes, the
workspace volume is shared so workers see the registered sources, and `/data`
is where artifacts land because the rootfs is read-only.

## 15. Verified baseline (2026-08-26)

Final state after فاز ۱۴: `npm run build` exits 0, `npm run lint` is silent,
and `npm run test:gate` reports **203 suites / 2747 tests passed**, "all
suites ran", artifact gate ok, with no worker process surviving the run and
nothing written to the real data directory. `structured-ai` reports `npm run
check` exit 0 and `npm test` exit 0, including its own ten-step end-to-end
scenario and MCP isolation tests.

The one acceptance criterion still 🟡 is LSP isolation: it is guaranteed
structurally (one process per worker) but has no dedicated test, because
exercising it needs language servers installed in CI.

`npm run build && npm run lint && npm test` (from the package directory; now the repository root) →
`tsc -p ./` exit 0, `eslint src` silent, `Test Suites: 170 passed / 170 total`,
`Tests: 2483 passed / 2483 total`.

Running `npx jest` without `npm run build` fails only
`src/host/packaging.test.ts`, which asserts that every entry in
`package.json:files` exists — `dist/` is a gitignored build output. The
supported command is `npm test` (its `pretest` regenerates the fixture);
`npx jest` alone also breaks the scanner suites for the same reason.
