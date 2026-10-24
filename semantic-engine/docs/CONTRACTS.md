# Phase 0 Contract Inventory

**Status:** contracts as executed by the test suites; open work is in `docs/OPEN-ITEMS.md`.
Rows marked `TESTED` below have a test that runs under `npm test` and passed in the recorded
run at revision `6a67a7f`. Rows still marked `UNKNOWN` have no executed evidence.

## Source-of-truth rule

Existing `semantic-engine/` contracts remain authoritative until direct source/test inspection proves a mapping. New CodeIntel contracts are additive; conflicts require a recorded mapping in `DECISIONS.md`.

## Required contract inventory

| Contract | Required target | Current evidence | Status |
|---|---|---|---|
| Project identity/root/path confinement | Stable identity, canonical root, confined access | Package/README metadata only | UNKNOWN |
| Range/LineIndex | UTF-16 code units on decoded text, end-exclusive, `\n`/`\r\n`/`\r`, BOM-aware | `src/core/contracts/codeintel.ts` + `codeintel.test.ts` (92 tests, executed). Line base 0; `toProjectIndexLine()` is the documented bridge to the 1-based symbol lines. **Representability rule:** the `\n` of a `\r\n` has no `Position`; `offsetAt(positionAt(o)) === o` for every representable `o`, the collapse never moves past `o`, and `positionAt` is idempotent for every offset (`isRepresentableOffset()`). **SE-P0-COORD-01:** `file.lines` counts terminators while `LineIndex.lineCount` counts the empty line a trailing break opens — both intentional; `toProjectIndexLineCount()` is the executable bridge. | TESTED (contract) / mapping implemented |
| SymbolKey/signatureHash | Stable key with signature hash separate | `<relPath>::<qualifiedName>::<kind>[#ordinal]` in `codeintel.ts`, `parseSymbolKey` inverse; path must be relative POSIX and normalized (absolute, drive letters, `..`, `//`, trailing `/`, NUL, `::` inside a part are rejected). `signatureHash` stays a separate field. | TESTED (contract) |
| Handle/STALE_HANDLE | Hash-bound read handle and explicit stale error | `<relPath>:<start>-<end>#<hash8>` with `parseHandle()`; hash must be 8 lowercase hex characters; the error code is non-retryable. `src/core/contracts/snapshotStore.ts` provides an in-memory issuer/verifier reference; stale snapshot/handle paths return typed failures without source content. Production store and MCP wiring remain UNKNOWN (matrix row 13). | TESTED (contract) / runtime UNKNOWN |
| Envelope | snapshotId, trust, stats, warnings, optional sessionId | No direct source/test execution | UNKNOWN |
| Error taxonomy/config | Validated config and stable error codes | Closed code set in `CODEINTEL_ERROR_CODES` (11 codes, unique, stable strings); retryability is a property of the code (`TIMEOUT`, `IO_ERROR`, `STALE_SNAPSHOT` only); `DEFAULT_CODEINTEL_CONFIG` is frozen and safe (`enabled: false`, `readOnly: true`, 10 000 files, 2 000 000 bytes, 30 000 ms). | TESTED (contract) |
| Generation/freshness/publication | Atomic snapshot publication and ownership | Per-file atomicity is tested (temp + fsync + rename, orphan sweep, concurrent writers, reader never sees a torn index). **SE-P0-PUB-01 (partially mitigated):** the index/manifest pair is not atomically renamed; `readCoherentArtifactSet()` now verifies digest/bytes and fails closed on mismatch. A generation-directory/pointer migration is still required for true set atomicity. | PARTIAL |
| FileProvider/TokenCounter | Explicit ports for file reads and token accounting | `ports.ts` + reference implementation `fileProvider.ts` (`ConfinedFileProvider`): lexical **and** canonical-root confinement, escaping symlinks denied (omitted from listings), secret denylist, `.git` segment denied, `maxFiles`/`maxFileBytes` caps, deadline → `TIMEOUT`, `AbortSignal` → `CANCELLED`, binary sniff. `TokenCounter` is replaceable; `WhitespaceTokenCounter` is the reference. **Open:** not yet wired into the MCP/HTTP read paths; the sync boundary (`SourceSecurityGuard`) now shares the same confinement and denylist (`pathConfinement.ts`, D-0007). | TESTED (port) / wiring open |
| Determinism | Stable ordering independent of time/random/process order | Full-index runs over the same files produce the same canonical projection; file and symbol order do not depend on write order; scanner output equals sequential output. Ordering in the new contracts is by UTF-16 code unit, not `localeCompare` (collation is ICU-dependent). | TESTED |
| MCP content/structuredContent | Text/structured parity and project/generation scope | `mcpIndexGeneration.test.ts` (content unchanged, `structuredContent` extended, consumer cache invalidated) plus the new read-only/lifecycle suite: tools/list equals the registry, tool calls change nothing on disk (workspace **and** artifact digests), restart re-reads the generation from the manifest. | TESTED |
| Gateway/worker lifecycle | Cancellation/dispose and no post-shutdown work | Existing executed suites: worker supervisor (one worker per project, crash restart, crash limit → degraded, stops all and leaves no lock), worker CLI (Unix socket, ready only after an index, SIGTERM), project lock (dead owner, quiet heartbeat, half-written lock), protocol matrix (client disconnect, client timeout). | TESTED (existing) |

## Required follow-up

Directly inspect each boundary and link it to source symbols, tests, fixture IDs, command output, and exit code before changing any contract. Static file presence is not acceptance evidence.

Still open after this stage (updated 2026-09-21, continuation):

1. ~~SE-P0-PUB-01 (consumption half)~~ **CLOSED at the consumption layer:** every serve path
   (HTTP `ProjectService`, MCP `reloadFromDisk`, MCP `cli.ts`) is fail-closed through
   `core/config/artifactManifest.ts` (D-0013). The layout half stays open: true set atomicity
   needs the generation-directory + pointer migration (D-0014, deferred, owner sign-off).
2. **SE-P0-COORD-01** — mapping recorded and executed: `file.lines` = terminator count,
   `LineIndex.lineCount` = logical lines; `toProjectIndexLine()`/`toProjectIndexLineCount()`
   are the only bridges (`codeintel.test.ts` line-count bridge). Keeping the two numbers
   different is now a documented contract, not a divergence.
3. Wire `ConfinedFileProvider` (or a single shared confinement helper) into the MCP/HTTP read
   paths, and the guard now shares its confinement (D-0007, done). Wiring still open.
4. A handle issuer and a snapshot store: the reference `InMemorySnapshotStore` exists and is
   LOCALLY tested; wiring to the permanent store and exposing `STALE_HANDLE`/`STALE_SNAPSHOT`
   on the MCP runtime path remains open (matrix row 13).
5. ~~Compatibility/traceability/adopt-vs-build~~ **DELIVERED:**
   (removed phase 0 matrices; see git history at `0d8d4cf`).

## Phase 2 ast-grep engine contract (D-0016, executed 2026-09-22)

Implemented in `src/core/codeintel/Phase2AstGrep.ts` (engine) behind the
unchanged `StructuralSearchRequest`/`StructuralSearchResult` contract in
`Phase2Structural.ts`. Executed by `src/core/codeintel/Phase2AstGrep.test.ts`
(23 tests) plus unchanged parity in `Phase2Structural.test.ts`.

- **Pin:** `@ast-grep/napi` exactly `0.45.3` in `dependencies` (mandatory: the
  default engine has no honest degradation). A test asserts
  `package.json` == installed `node_modules` == `AST_GREP_VERSION` and fails
  on any drift. The `.node` binary ships inside the platform tarball (no
  install/postinstall network); the module is lazy-loaded so platforms
  without a prebuilt binding fail closed with `AST_GREP_UNAVAILABLE` instead
  of breaking the import graph.
- **Languages:** `typescript`→`TypeScript`, `javascript`→`JavaScript`,
  `tsx`→`Tsx`. Every other language (including `python`, `php`, `unknown`)
  throws `UNSUPPORTED_LANGUAGE` naming the supported set. Python/PHP structural
  search needs dynamic-language dylibs or a CLI fallback (recorded follow-up,
  explicitly unavailable per plan §1.3).
- **Range unit (plan 2.3, verified empirically):** `node.range().*.index` is a
  UTF-16 code-unit offset on 0.45.3 (the shipped `.d.ts` comment claims bytes;
  Persian/emoji/CRLF probes prove UTF-16: `text.slice(start, end) ===
  node.text()`). `start`/`end` are used directly after bounds validation
  (violation → `AST_GREP_RANGE_ERROR`, never a corrupt offset). `line`
  (1-based) and `column` (0-based UTF-16) are ALWAYS derived from our own
  `LineIndex`, never from the engine — ast-grep does not count a lone `\r`
  as a line break while this contract does.
- **Captures:** `$NAME` → `getMatch(name)?.text() ?? ''`; `$$$NAME` → source
  span from the first bound node's start to the last bound node's end
  (anonymous nodes such as commas are included in the span), `''` when empty.
  Repeated `$NAME` must match identical text (enforced natively).
- **Matcher honesty:** empty patterns and non-positive bounds are rejected
  before touching the engine; engine matcher errors surface as
  `INVALID_PATTERN`; unparseable patterns match nothing (upstream napi
  behavior, pinned by test — never a crash, never a silent pass).
- **Ordering/bounds:** matches sorted by `(start, end, id)`; output sliced to
  `maxResults` with an honest `truncated` flag.
- **Legacy seam:** `engine: 'legacy-seam'` is an explicitly experimental,
  library-level-only fallback (line patterns, no parser). Tools and MCP never
  select it. It must not be described as ast-grep-compatible; a committed
  test proves the divergence (multiline pattern: engine finds 1, seam 0).
- **Tool error propagation (F-11):** `structural_search` surfaces adapter
  errors verbatim (never wrapped/mislabelled) and reports read failures as
  `IO_ERROR`; `structural_rule_test` propagates a failing rule's error
  instead of reporting `passed: true`.

## Truncation-honesty output contract (SE-AI-HONESTY, P-03/P-06, executed 2026-10-07)

Any AI-facing tool that caps or slices its result set MUST make the cap
machine-readable so a partial page never reads as a complete answer (§16:
"no result exists" ≠ "no result was found"). This is the central
correctness rule of the semantic layer; it is not satisfied by the tool
"executing successfully" (§13).

- **Flag + count together.** A capped result carries `metadata.truncated`
  AND an honest total. Exact total (the scan counted everything before
  slicing): `matchCount` / `totalMatches` / `publicSymbolCount` /
  `candidateCount` / `callsCount` / `calledByCount` / `totalReferenceCount`.
  When the scan itself stops at the cap so the total is unknown, the tool
  emits `matchCountAtLeast` (or `examinedCommits` + `countNote`) rather
  than a fabricated exact count — never silence.
- **Slice ≠ filter.** Two different reasons a result is smaller than the
  universe must not collapse into one flag. `symbol_references` reports
  `truncated` for the `limit` slice and `droppedByConfidence` for the
  `minConfidence` filter separately, so an AI knows whether to raise the
  limit or lower the confidence bar. `impact_analysis` likewise separates
  the traversal node-cap (`traversalExhausted`) from the output
  `limit` slice (`droppedByLimit`, `candidateCount`).
- **Empty scope honesty.** Zero matches still sets `truncated: false` and
  the count to `0`, distinguishing "searched, none found" from a silent
  empty list. `get_recent_changes` additionally distinguishes "path is not
  a git repository" from "no commits" via `isGitRepository`/`emptyNote`.
- **`explain_symbol`** puts its per-section slice state in
  `truncated.{calls,calledBy,members,any,limit}` plus the pre-slice
  `callsCount`/`calledByCount`, because `limit` caps three independent
  lists at once and a single top-level flag would hide which one was cut.
- **Contract lock.** `src/ai/tools/ToolTruncationHonesty.test.ts` (AI-03,
  six tools) and `ToolTruncationHonesty.p06.test.ts` (P-06 rollout + a
  registry-driven "truncated is never count-less" guard) fail the build if
  a tool slices without declaring it, preventing silent regression.
- **Transport.** These signals reach the consuming AI through MCP
  `structuredContent` (`SemanticEngineMcpServer`), unpacked unchanged on the
  structured-ai side (`JsonRpcCodec`), so the honesty survives the
  integration boundary (§28).
## Gateway per-project worker config (SE-F-057, executed 2026-10-08)

The Gateway dashboard edits a project's **whole** worker config, so the
`/api/v1/gateway/projects` surface carries explicit create/update semantics
and truthful persistence — a save that silently dropped fields or "succeeded"
without the config landing is exactly the misleading success §2 forbids.

- **Identity is registry-owned.** `POST /projects` creates (or returns the
  existing record for a repeated canonical root); `PATCH /projects/:id` updates
  name/enabled/autoStart **and** the worker config. A PATCH body that tries to
  move the project (`path`/`rootPath`/`id`) is rejected `400` with a named
  error — never silently ignored. `projectId`/`rootPath` in the stored config
  always come from the registry, never the payload.
- **All-or-nothing config writes.** Both POST and PATCH validate the incoming
  config (the full `WORKER_CONFIG_JSON_SCHEMA` rules) BEFORE any write: a
  rejected edit leaves the stored config and the registry byte-unchanged, and a
  rejected *create* rolls back its own registration. A secret in the body
  (`token`/`apiKey`) is refused, never stored.
- **Merge semantics (documented for API consumers).** A PATCH payload's object
  fields merge per leaf; an explicit `null` clears a field back to its default;
  a payload with no config keys changes no config. A config key the dashboard
  form did not render is therefore never silently reset.
- **Truthful effect.** `GET /projects/:id` discloses the **effective** config,
  which is what a worker starts with (hydration, lifecycle start, CLI) and what
  the form rehydrates from — not what was last "requested". Updating a RUNNING
  worker restarts it so the config is live; if that restart fails, the answer is
  `500` and says exactly what happened (config stored, worker not restarted)
  rather than implying a complete success.
- **Durability.** The config lives at `<dataRoot>/projects/<id>/worker-config.json`
  (outside the source root — D-rule on artifacts), written atomically
  (temp+rename). A corrupted or no-longer-valid stored file falls back to the
  default config rather than half-applying, and never crashes the Gateway.
- **Contract lock.** `gatewayUi.test.ts` pins the request contract and that the
  new-worker form's initial values equal the schema defaults (mechanically, so
  UI and schema cannot drift); `GatewayServer.test.ts` pins storage, re-read,
  unrelated-field preservation, durability across a fresh server instance,
  rollback of invalid creates, refusal of identity edits and secrets.
