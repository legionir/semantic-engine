# Semantic Engine — Handoff

**تاریخ:** ۲۰۲۶-۰۸-۲۲  
**Repository:** `legionir/structured-ai`  
**Branch:** `arena/01a02456-structured-ai`  
**Package:** `@aicoder/semantic-engine` نسخه `0.1.0`  
**Node requirement:** `>=20`  
**مسیر:** `semantic-engine/`

این سند handoff مخصوص Semantic Engine است و باید همراه با کد، تست‌ها و قراردادهای همین package خوانده شود.

---

## 1. مأموریت و مرز پروژه

Semantic Engine یک code-intelligence engine مستقل است که از یک workspace، project index تولید می‌کند و این قابلیت‌ها را ارائه می‌دهد:

- file/workspace scanning
- symbol extraction
- import/dependency resolution
- call/type/dependency graph
- LSP diagnostics (opt-in: `--lsp-diagnostics`) و enrichment
- امضای اعلانی برای class/interface/enum/… و `explain_symbol` سطح‌کلاس
  (`members` / `aggregateComplexity` / `referencedBy`)
- blueprint و architecture mapping
- keyword/vector/hybrid search
- context assembly برای AI
- کپی SQLite حذف شده؛ `project-index.json` تنها منبع حقیقت است
- REST/HTTP platform server
- MCP server روی stdio یا HTTP
- watch/incremental indexing

این package مستقیماً با پروژه‌های تستی دیگر repository ادغام نشده است. ورودی اصلی آن workspaceای است که کاربر با `--root` مشخص می‌کند.

---

## 2. Entry pointها و commandها

### CLI launcher

| مسیر | کاربرد |
|---|---|
| `semantic-engine/bin/semantic-engine.js` | launcher اجرایی package |
| `semantic-engine/src/cli/main.ts` | parse command، dispatch و خروجی text/JSON |
| `semantic-engine/src/cli/args.ts` | parsing flags و exit codes |
| `semantic-engine/src/cli/commands/index-command.ts` | full index |
| `semantic-engine/src/cli/commands/query-command.ts` | اجرای AI tool روی index موجود |
| `semantic-engine/src/cli/commands/serve-command.ts` | UI، REST platform، MCP HTTP/stdio و start یکپارچه |
| `semantic-engine/src/cli/commands/watch-command.ts` | indexing اولیه و watch تغییرات |
| `semantic-engine/src/cli/commands/doctor-command.ts` | بررسی محیط |

### Commandهای اصلی

```bash
cd semantic-engine
npm ci
npm run build

# ساخت index
# خروجی به‌صورت پیش‌فرض در data directory کاربر نوشته می‌شود
# ($XDG_DATA_HOME/semantic-engine/projects/<projectId>/)؛ برای نوشتن در root
# قدیمی، --artifact-location in-root یا --out بدهید.
node bin/semantic-engine.js index \
  --root /path/to/project

# اجرای UI و REST platform
node bin/semantic-engine.js ui \
  --root /path/to/project \
  --host 127.0.0.1 \
  --port 4000 \
  --token "$SEMANTIC_ENGINE_TOKEN"

# اجرای MCP روی stdio
node bin/semantic-engine.js serve \
  --stdio \
  --root /path/to/project

# اجرای MCP روی HTTP
node bin/semantic-engine.js serve \
  --http \
  --host 127.0.0.1 \
  --port 3000 \
  --token "$SEMANTIC_ENGINE_TOKEN" \
  --root /path/to/project

# راه‌اندازی هم‌زمان UI و MCP HTTP؛ اگر ایندکس نباشد ساخته می‌شود
node bin/semantic-engine.js start \
  --root /path/to/project \
  --ui-port 4000 \
  --mcp-port 3000 \
  --token "$SEMANTIC_ENGINE_TOKEN"

# watch — reindex incremental و به‌روزرسانی artifactها
node bin/semantic-engine.js watch \
  --root /path/to/project \
  --vectors \
  --lsp-diagnostics --diagnostics-budget 20000

# start — UI + MCP + watcher زیر نظر یک parent
node bin/semantic-engine.js start \
  --root /path/to/project \
  --ui-port 4000 \
  --mcp-port 3000 \
  --vectors \
  --token "$SEMANTIC_ENGINE_TOKEN"

# بررسی محیط
node bin/semantic-engine.js doctor

# ── معماری چندپروژه‌ای ────────────────────────────────────────────
# Gateway: یک پورت عمومی، چند worker تک‌پروژه‌ای
#   کنسول: http://127.0.0.1:4000/gateway
node bin/semantic-engine.js gateway --port 4000 --token "$SEMANTIC_ENGINE_GATEWAY_TOKEN"

# یک worker مستقل (بدون Gateway)؛ روی Unix socket یا loopback
node bin/semantic-engine.js worker \
  --project-id prj-app-12345678 \
  --root /path/to/app

# نگهداری از دادهٔ تولیدشده (فقط data directory، هرگز source tree)
node bin/semantic-engine.js cache list
node bin/semantic-engine.js cache clean --project prj-app-12345678
node bin/semantic-engine.js cache clean --older-than 30d          # dry-run
node bin/semantic-engine.js cache clean --older-than 30d --force
node bin/semantic-engine.js cache export --project prj-app-12345678 --to /backup
```

### دادهٔ تولیدشده کجا می‌نشیند

پیش‌فرض `external` است: `<dataRoot>/projects/<projectId>/` که `dataRoot` برابر
`$XDG_DATA_HOME/semantic-engine` (لینوکس)، `~/Library/Application Support/SemanticEngine`
(macOS) یا `%LOCALAPPDATA%\SemanticEngine` (ویندوز) است و با
`SEMANTIC_ENGINE_DATA_DIR` عوض می‌شود. `<dataRoot>/gateway/` هم socket، لاگ و
`registry.json` را نگه می‌دارد. برای رفتار قدیمی (نوشتن داخل checkout)
`--artifact-location in-root` یا `--out <dir>` بدهید؛ ایندکس قدیمیِ داخل
checkout در اولین اجرا **کپی** می‌شود و فایل اصلی پاک نمی‌شود.

### سنجه‌ها

کلیدهای سنجه یک قراردادند و در `src/gateway/metrics.ts` تعریف شده‌اند
(`GATEWAY_METRIC_KEYS` و `WORKER_METRIC_KEYS`)؛ تست‌ها مجموعهٔ **دقیق** کلیدها
را می‌سنجند، پس تغییر نام یک سنجه باید در تست بشکند نه در داشبورد.

### Exit codeها

تعریف اصلی در `semantic-engine/src/cli/args.ts` و مصرف در `src/cli/main.ts` است:

- `0`: success
- `1`: command failure
- `2`: usage/argument error
- `3`: doctor found a broken requirement

---

## 3. Package scripts

تعریف در `semantic-engine/package.json`:

```bash
npm ci
npm run build
npm run lint
npm run test:gate
npm run snapshot
npm run benchmark
npm audit --omit=dev
```

| Script | رفتار |
|---|---|
| `build` | `tsc -p ./` و تولید `dist/` |
| `lint` | ESLint روی `src` |
| `test` | Jest معمولی |
| `test:gate` | ابتدا fixture را تولید و سپس تمام suiteها را اجرا می‌کند |
| `snapshot` | pipeline را اجرا و golden output را مقایسه می‌کند |
| `snapshot:update` | golden output را بعد از review به‌روزرسانی می‌کند |
| `benchmark` | build، fixture و benchmark pipeline |
| `validate` | اعتبارسنجی یک project-index مشخص؛ نیازمند argument است |
| `check:audit` | کنترل coverage ممیزی |

---

## 4. Architecture و data flow

### Indexing flow

```text
CLI / REST / watch
        │
        ▼
WorkspaceScanner
        │
        ▼
FileProcessor
        │
        ├── SymbolExtractorManager
        │      ├── heuristic
        │      ├── tree-sitter
        │      └── LSP
        │
        ├── DependencyExtractorManager
        │      ├── heuristic
        │      └── TypeScript resolver
        │
        ├── GitInfoCollector
        ├── CallGraphBuilder
        ├── TypeGraphBuilder
        ├── DependencyGraphBuilder
        ├── VectorIndexer (optional)
        └── enrichment/rescoring
                │
                ▼
          OutputWriter
                │
                ├── project-index.json
                ├── blueprint.json
                └── project-artifacts.manifest.json
```

### رفتار watch و reload

`WatchPipeline` یک batch ترتیبی از رویدادهای create/modify/delete/rename را
پس از debounce اجرا می‌کند. `IncrementalEngine` فقط فایل‌های affected و
وابسته‌های لازم را دوباره parse می‌کند، اما graphهای dependency و type را از
index جاری بازسازی و reverse dependency را دوباره مشتق می‌کند. اگر
`VectorIndexer` فعال باشد، chunkهای فایل‌های affected دوباره ساخته و
embeddingهای هم‌محتوا از batch قبلی reuse می‌شوند.

در CLI، `watch` با `--vectors` این artifactها را نیز تازه نگه می‌دارد؛ اگر
ایندکس قبلی vector داشته باشد، آن حالت به‌طور پیش‌فرض حفظ می‌شود. حالت blueprint در CLI پیش‌فرض `always` است و با
`--blueprint-mode threshold` قابل تغییر است. `start` watcher را زیر نظر
خودش اجرا می‌کند؛ `--no-watch` آن را خاموش می‌کند.

MCP stdio و هر دو HTTP entry point هنگام تغییر `project-index.json` و
`blueprint.json` snapshot جدید را load می‌کنند. `ProjectService` نیز cache
داشبورد را با همان artifactها reload می‌کند.

### Layerها

| لایه | مسیرهای اصلی |
|---|---|
| Core types/config/utils | `src/core/` |
| Scanner | `src/scanner/` |
| Language registry | `src/language/` |
| Symbols | `src/symbols/` |
| Dependencies | `src/dependencies/` |
| Graphs | `src/graphs/` |
| Pipeline | `src/pipeline/` |
| Incremental/watch | `src/incremental/`, `src/pipeline/WatchPipeline.ts` |
| LSP | `src/lsp/` |
| AI tools | `src/ai/` |
| Blueprint | `src/blueprint/` |
| Vector | `src/vector/` |
| Export | `src/export/` |
| Jobs | `src/runtime/` |
| HTTP/MCP server | `src/server/`, `src/ai/mcp/` |
| Security/RBAC | `src/security/`, `src/cli/HttpGuard.ts` |
| Observability | `src/observability/` |
| Host abstraction | `src/host/` |

---

## 5. Output contract

### `project-index.json`

ساختار اصلی توسط typeها و schema کنترل می‌شود:

- `semantic-engine/src/core/types/project-index.types.ts`
- `semantic-engine/contracts/project-index.schema.json`
- `semantic-engine/src/export/schemaValidation.ts`

اطلاعات کلیدی:

- files
- symbols
- imports/exports
- call graph
- type graph
- dependency graph
- reverse dependency graph
- diagnostics (scanner + extraction always; language-server ones only when
  the index was built with `--lsp-diagnostics`, and then the index also
  carries a `diagnosticsRun` record — its absence means "not checked")
- metrics
- git metadata
- optional vector chunks
- AI metadata

### `blueprint.json`

ساخت توسط:

- `semantic-engine/src/blueprint/BlueprintGenerator.ts`
- `semantic-engine/src/export/BlueprintExporter.ts`

شامل module/file/symbol/API/entity maps و responsibility metadata است.

### Artifact manifest

`project-artifacts.manifest.json` توسط `src/pipeline/OutputWriter.ts` تولید می‌شود و شامل موارد زیر است:

- `generation`
- `committedAt`
- SHA-256 و اندازه‌ی index
- SHA-256 و اندازه‌ی blueprint

`ProjectService` در زمان load hashها را validate می‌کند. اگر manifest و artifact هماهنگ نباشند، project به‌عنوان معتبر load نمی‌شود.

---

## 6. REST platform server

Entry point: `src/server/HttpServer.ts`

### Security chain

در هر request:

1. security headers و Origin check
2. connection check برای loopback/remote mode
3. route match
4. token/API-key authentication
5. permission check با `PermissionChecker`
6. body-size و schema validation
7. handler
8. secret masking در response

### Public endpoints

تعریف در `src/server/routes/systemRoutes.ts`:

- `GET /health`
- `GET /ready`
- `GET /metrics`
- `GET /api/v1/system`
- role listing و auth verification طبق `authRoutes.ts`

`/health` فقط liveness است. `/ready` وضعیت internal server dependencies مانند project root، job queue، registry و SSE manager را بررسی می‌کند.

### Project/index endpoints

Routeها در `src/server/routes/` قرار دارند:

- project registration/status: `projectRoutes.ts`
- indexing jobs/events: `jobRoutes.ts`
- search: `searchRoutes.ts`
- symbols/impact/diagnostics/context: `codeRoutes.ts`
- visualization/LoD: `visualizationRoutes.ts`
- architecture/impact/mutation: `analysisRoutes.ts`
- Git history: `historyRoutes.ts`
- source upload/Git sync: `sourceRoutes.ts`
- provider discovery: `providerRoutes.ts`
- project chat: `chatRoutes.ts`
- config: `configRoutes.ts`
- filesystem browse: `fsRoutes.ts`

### Authentication/RBAC

- `src/security/rbac/ApiKeyStore.ts`: API key hash/expiry/revoke
- `src/security/rbac/PermissionChecker.ts`: permission و project resource scope
- `src/server/SecurityPipeline.ts`: token extraction و masking
- route metadata: `RouteDefinition.permission`

API key store فعلاً in-memory است. برای multi-replica deployment باید به store مشترک منتقل شود.

---

## 7. MCP server

### stdio

- implementation: `src/ai/mcp/SemanticEngineMcpServer.ts`
- entry: `src/ai/mcp/cli.ts`
- input/output از stdin/stdout طبق MCP SDK

### HTTP

- `src/cli/commands/serve-command.ts`
- `src/cli/HttpGuard.ts`
- token اجباری است.
- default host برای HTTP MCP loopback است.
- remote bind بدون token صریح رد می‌شود.
- body size محدود است.
- Origin برای browser request بررسی می‌شود.
- token با timing-safe compare بررسی می‌شود.
- برای هر request transport مستقل ساخته می‌شود.

### ابزارها

Registry و handlerهای AI در `src/ai/` قرار دارند. MCP server پروژه را از طریق `AiToolRegistry` expose می‌کند؛ مدل به filesystem/database مستقیم دسترسی ندارد و از index tools استفاده می‌کند.

---

## 8. Security decisions

### Outbound URL

`EmbeddingProviderService.ts` و `ProjectChatService.ts`:

- فقط `http`/`https`
- metadata hostها reject می‌شوند.
- hostname resolve می‌شود.
- private/link-local/unique-local addressها reject می‌شوند؛ localhost برای providerهای local مجاز است.
- redirect در chat با `redirect: 'error'` مسدود شده است.
- network tool root به IP بررسی‌شده pin می‌شود.

### Source import

`SourceSecurityGuard.ts` و `SourceSyncService.ts`:

- lexical traversal check
- canonical realpath check
- symlink component rejection برای mutation
- file و total bundle size limits
- staging directory
- rollback در failure

### Local embedding

`@xenova/transformers` و زنجیره‌ی vulnerable آن از production dependency graph حذف شده‌اند. مسیر production-safe local embedding از `HashingEmbeddingGenerator` استفاده می‌کند.

`LocalEmbeddingGenerator.ts` هنوز به‌عنوان legacy optional code وجود دارد، اما package آن را bundle نمی‌کند و default production route از آن استفاده نمی‌کند.

---

## 9. Jobs و concurrency

`src/runtime/JobManager.ts`:

- حداکثر ۴ job فعال
- یک job active برای هر project
- 409 برای duplicate project job
- 429 برای ظرفیت پر
- cancellation token
- persisted state در `.agent/jobs.json`
- persisted indexing request data
- interrupted job detection
- registered recovery runner برای resume پس از restart

در `src/server/routes/jobRoutes.ts`، index job با data قابل بازیابی ساخته می‌شود و `serve-command.ts` بعد از register کردن root project، recovery را اجرا می‌کند.

برای چند instance هنوز Redis/PostgreSQL/queue مشترک و distributed lock لازم است.

---

## 10. Docker و operational deployment

فایل‌ها:

- `semantic-engine/Dockerfile`
- `semantic-engine/.dockerignore`
- repository root `Dockerfile`
- repository root `.dockerignore`
- `docker-compose.yml`

Semantic Compose:

```bash
export SEMANTIC_ENGINE_TOKEN='long-random-token'
export SEMANTIC_WORKSPACE=/absolute/path/to/workspace
docker compose up --build
```

ویژگی‌های container:

- Node 22 runtime
- build stage جدا
- production `npm ci --omit=dev`
- non-root user
- read-only filesystem در compose
- `no-new-privileges`
- drop همه‌ی Linux capabilities در compose
- healthcheck
- required token
- workspace volume

برای deployment واقعی باید image digest، SBOM، secret manager و rollback process سازمانی به این baseline اضافه شود.

---

## 11. Validation فعلی

آخرین validation ثبت‌شده روی branch:

```bash
cd semantic-engine
npm ci
npm run build
npm run lint
npm run test:gate
npm run snapshot
SEMANTIC_BENCHMARK_ROOT=. SEMANTIC_BENCHMARK_MAX_MS=120000 node scripts/benchmark.js
npm audit --omit=dev
```

نتایج:

- build: **PASS**
- lint: **PASS — ۰ warning / ۰ error**
- test gate: **169/169 suites، 2478/2478 tests passed**
- snapshot: **PASS**
- dependency audit: **۰ vulnerability**
- workspace benchmark: **457 files، 26912 symbols، 1885 dependency edges، حدود 14.6s زیر سقف 120s**

Root runtime نیز با `npm test` پاس می‌شود؛ Semantic Engine فقط به‌صورت مستقل در CI خودش gate می‌شود.

---

## 12. Test map

| حوزه | تست‌ها |
|---|---|
| CLI/arguments | `src/cli/cli.test.ts`, `src/cli/HttpGuard.test.ts` |
| Scanner | `src/scanner/WorkspaceScanner*.test.ts` |
| Symbols | `src/symbols/**/*.test.ts` |
| Dependencies | `src/dependencies/**/*.test.ts` |
| Graphs | `src/graphs/**/*.test.ts` |
| LSP | `src/lsp/**/*.test.ts` و integration tests |
| Pipeline | `src/pipeline/**/*.test.ts` |
| Incremental | `src/incremental/**/*.test.ts` |
| Vector | `src/vector/**/*.test.ts` |
| Export | `src/export/**/*.test.ts` |
| HTTP/security | `src/server/**/*.test.ts`, `src/security/**/*.test.ts` |
| Chat | `src/services/chat/ProjectChatService.test.ts` |
| Source security | `src/services/source/SourceSyncService.test.ts` |
| Jobs | `src/runtime/JobManager.test.ts` |
| Contracts | `src/core/types/*Sync.test.ts`, `src/host/configSchemaSync.test.ts` |

Testهای project-index و golden را فقط بعد از review تغییر دهید. `snapshot:update` نباید جایگزین بررسی علت output drift شود.

---

## 13. Known limitations

1. **Distributed state:** API-key store، job state و بعضی caches process-local هستند.
2. **Resume semantics:** recovery در یک instance با recovery runner کار می‌کند؛ برای چند replica distributed queue لازم است.
3. **Legacy transformer:** `LocalEmbeddingGenerator` bundled نیست؛ برای production از hashing یا remote generator استفاده شود.
4. **Performance SLO:** benchmark فعلی روی corpus موجود اجرا شده، نه corpus همه‌ی مشتریان.
5. **Optional native modules:** `usearch` و `@xenova/transformers` باینری دانلودی دارند؛ معماری Node/OS image باید با dependency native همان environment تست شود (قاعدهٔ SE-BUILD-10: هیچ‌کدام نباید به `dependencies` اجباری منتقل شوند).
6. **Audit persistence:** persistence failure در برخی مسیرهای audit عمدی swallow می‌شود تا indexing متوقف نشود؛ disk monitoring لازم است.
7. **Project path trust:** route ثبت project باید پشت authn/authz و policy صحیح بماند؛ token به‌تنهایی tenant isolation نیست.
8. **Raw config secrets:** API keys فقط از secret manager/environment inject شوند و در config file commit نشوند.
9. **LSP availability:** LSP integration بر اساس language serverهای نصب‌شده optional است؛ tree-sitter/heuristic fallback باید در deployment مشخص باشد.

---

## 14. Handoff checklist

قبل از هر release:

- [ ] Node version image با `engines.node >=20` سازگار است.
- [ ] `npm ci` از lockfile موفق است.
- [ ] `npm run build` موفق است.
- [ ] `npm run lint` بدون warning است.
- [ ] `npm run test:gate` تمام suiteها را اجرا می‌کند.
- [ ] `npm run snapshot` بدون drift است.
- [ ] benchmark روی corpus و hardware شبیه production اجرا شده است.
- [ ] `npm audit --omit=dev` پاک است.
- [ ] `SEMANTIC_ENGINE_TOKEN` از secret manager می‌آید.
- [ ] remote bind بدون token انجام نمی‌شود.
- [ ] `MCP_AUTO_DISCOVER` root runtime برای workspaceهای untrusted خاموش می‌ماند.
- [ ] process execution root در `deny` یا sandbox واقعی است.
- [ ] برای multi-replica job queue و API-key store مشترک تهیه شده است.
- [ ] backup/retention برای `.agent/jobs.json` و artifact outputs تعریف شده است.
- [ ] Docker image digest/SBOM و rollback procedure ثبت شده است.

---

## 15. ترتیب پیشنهادی مطالعه برای نفر بعد

1. `semantic-engine/package.json`
2. `semantic-engine/tsconfig.json`
3. `semantic-engine/src/cli/main.ts`
4. `semantic-engine/src/cli/commands/serve-command.ts`
5. `semantic-engine/src/server/HttpServer.ts`
6. `semantic-engine/src/server/SecurityPipeline.ts`
7. `semantic-engine/src/runtime/JobManager.ts`
8. `semantic-engine/src/server/routes/jobRoutes.ts`
9. `semantic-engine/src/pipeline/IndexPipeline.ts`
10. `semantic-engine/src/pipeline/OutputWriter.ts`
11. `semantic-engine/src/services/ProjectService.ts`
12. `semantic-engine/src/services/source/SourceSyncService.ts`
13. `semantic-engine/src/services/providers/EmbeddingProviderService.ts`
14. تست‌های `src/server`, `src/runtime`, `src/pipeline` و `src/services/source`
15. `semantic-engine/contracts/*.json`
16. `ci/github-actions-semantic-engine.yml`

برای تغییرات جدید از همین branch استفاده کنید:

```bash
git status --short
git diff --check
cd semantic-engine && npm run build && npm run lint && npm run test:gate && npm run snapshot
```
