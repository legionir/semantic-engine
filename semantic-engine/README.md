# پلتفرم هوش کد و موتور معنایی (Semantic Engine Platform)
## Code Intelligence Platform Core, Universal API & Interactive LoD Visualizer

پروژهٔ **`semantic-engine`** یک پلتفرم جامع، مستقل (Standalone) و سرویس‌محور برای تحلیل عمیق معنایی سورس‌کد، استخراج گراف دانش (Knowledge Graph)، تحلیل وابستگی‌ها، سلسله‌مراتب فراخوانی‌ها، ارزیابی شعاع اثر تغییرات، کشف نقض‌های معماری و مصورسازی تعاملی چندلایه‌ای (Semantic LoD) برای عامل‌های هوش مصنوعی (AI Agents)، ابزارهای CLI و برنامه‌نویسان است.

---

## فهرست مطالب
1. [منشور معماری و اصول کلیدی](#۱-منشور-معماری-و-اصول-کلیدی)
2. [معماری کلان و ساختار لایه‌ای](#۲-معماری-کلان-و-ساختار-لایه‌ای)
3. [پشتیبانی چندزبانه (Multi-Language Support)](#۳-پشتیبانی-چندزبانه-multi-language-support)
4. [پیش‌نیازها و راه‌اندازی سریع](#۴-پیش‌نیازها-و-راه‌اندازی-سریع)
5. [دستورات خط فرمان (CLI Commands)](#۵-دستورات-خط-فرمان-cli-commands)
6. [تنظیمات و پیکربندی (Configuration)](#۶-تنظیمات-و-پیکربندی-configuration)
7. [مستندات کامل اندپوینت‌های ۱۴گانهٔ API](#۷-مستندات-کامل-اندپوینتهای-۱۴گانه-api)
8. [خط‌لولهٔ امنیتی و گاردهای تخصصی (Security & Guards)](#۸-خط‌لوله-امنیتی-و-گاردهای-تخصصی-security--guards)
9. [مشاهده‌پذیری و لاگ ممیزی (Observability & Audit Trail)](#۹-مشاهده‌پذیری-و-لاگ-ممیزی-observability--audit-trail)
10. [ماتریس پروتکل‌ها و آداپتورها (Protocols & Adapters)](#۱۰-ماتریس-پروتکلها-و-آداپتورها-protocols--adapters)
11. [اتصال به Structured AI و کلاینت‌های خارجی MCP](#۱۱-اتصال-به-structured-ai-و-کلاینت‌های-خارجی-mcp)

---

## ۱. منشور معماری و اصول کلیدی

### ۱.۱ اصل انزوای کامل ذخیره‌سازی (Zero Direct Storage Access)
> **هیچ مصرف‌کننده‌ای (شامل Agent، Web Dashboard، CLI، IDE یا ابزارهای خارجی) حق اتصال مستقیم به ذخیره‌سازی‌های زیرین (Vector DB، File System یا حافظهٔ خام گراف) را ندارد.**  
> تمامی وضعیت‌ها، قابلیت‌ها، نودها و یال‌ها منحصراً از طریق **API Contract** رسمی مصرف می‌شوند. حتی خود وب‌داشبورد و Agent نیز صرفاً یک «کلاینت» محسوب می‌شوند.

### ۱.۲ اصل تجرید سطوح جزئیات (Semantic Level of Detail - LoD)
برای جلوگیری از سردرگمی بصری در پروژه‌های بزرگ (+10K نماد)، داده‌های گراف در ۴ سطح پیوسته ارائه می‌شوند:
1. **سطح ۱ (Architecture):** لایه‌ها، ماژول‌ها و وب‌سرویس‌های سطح‌بالا (< ۳۰ نود).
2. **سطح ۲ (Module View):** فایل‌ها و وابستگی‌های درون هر ماژول (< ۸۰ نود).
3. **سطح ۳ (File & Symbol Explorer):** کلاس‌ها، توابع، متدها و اینترفیس‌های هر فایل.
4. **سطح ۴ (Neighborhood / Call Hierarchy):** درخت فراخوانی، ارجاعات متصل و تحلیل شعاع اثر.

### ۱.۳ معماری Standalone با وب‌سرور داخلی
موتور معنایی بدون نیاز به هیچ ابزار کمکی یا وب‌سرور خارجی، دارایی‌های وب‌داشبورد (`public/`) و کلیهٔ APIها را روی یک پورت واحد میزبانی می‌کند.

> **نکته (SE-UI-01):** دستور `semantic-engine ui` **بدون نیاز به ایندکس قبلی** بالا می‌آید. اگر `project-index.json` وجود نداشته باشد، سرور همچنان استارت می‌شود و کاربر از داخل خودِ UI (صفحهٔ **Open / Configure**) پروژه را باز، نحوهٔ اسکن و مدل embedding را انتخاب و ایندکس‌سازی را شروع می‌کند. (پیش از این، UI با پیام `run "semantic-engine index" first` قبل از بالا آمدن سرور خارج می‌شد.)

---

## ۲. معماری کلان و ساختار لایه‌ای

```text
┌────────────────────────────────────────────────────────────────────────┐
│                                CLIENTS                                 │
│      AI Agents (MCP)   │   Web Visualizer (REST/SSE)   │   CLI / IDE   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        API GATEWAY / SECURITY                          │
│   • Loopback / Bearer Token Guard    • Scoped RBAC Authorization       │
│   • Request Validation (Ajv Schema)  • Secret Masking & Rate Limits    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       SEMANTIC PLATFORM CORE API                       │
├────────────────────────────────────────────────────────────────────────┤
│ 01. System & Capabilities API    │ 08. Code Intelligence API           │
│ 02. Dynamic Configuration API    │ 09. Knowledge Graph LoD API         │
│ 03. Identity & Scoped Access API │ 10. Context & Token Budget Engine   │
│ 04. Projects Management API      │ 11. Deep Impact & Architecture API  │
│ 05. Source & Multi-Repo Sync API │ 12. History & Git Hotspots API      │
│ 06. Async Indexing & Jobs API    │ 13. Dashboard Visualization API     │
│ 07. Hybrid & Semantic Search API │ 14. Realtime Events & WebSocket API │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                           INTELLIGENCE CORE                            │
│   • Tree-Sitter AST (WASM Multi) │ • LayeredGraph & AnalysisGraph      │
│   • Compiler LSP Client Subsystem │ • FactStore & Edge Normalizer       │
│   • Hybrid Lexical + Vector Store │ • Blueprint & Architecture Mapper   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    INTERNAL STORAGE (NO DIRECT ACCESS)                 │
│ project-index.json        │     Vector DB     │    Meta JSON Cache     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ۳. پشتیبانی چندزبانه (Multi-Language Support)

موتور معنایی از دو لایه اکسترکتور برای استخراج گرامری دقیق نمادها استفاده می‌کند:

```
┌──────────────────────────────────────┬──────────────────────────────────────────┐
│              لایه زبانی              │              زبان‌های تحت پوشش            │
├──────────────────────────────────────┼──────────────────────────────────────────┤
│ **Tier 1: Tree-sitter WASM AST**     │ TypeScript, JavaScript, Python, Go,      │
│ (تحلیل گرامری عمیق و بدون خطا)       │ Rust, Java, TSX                          │
├──────────────────────────────────────┼──────────────────────────────────────────┤
│ **Tier 2: Heuristic + LiteralMask**  │ C++, C#, PHP, Ruby, Kotlin, Swift,       │
│ (استخراج سریع الگوها و پوشش کامنت)   │ Shell, CSS, SCSS, HTML, JSON, SQL, YAML  │
└──────────────────────────────────────┴──────────────────────────────────────────┘
```

---

## ۴. پیش‌نیازها و راه‌اندازی سریع

### پیش‌نیازها
* **Node.js:** نسخهٔ `>= 20.0.0`
* **Git:** نسخهٔ `>= 2.30` (اختیاری جهت استخراج تاریخچه گیت)

### نصب و بیلد پروژه
```bash
# رفتن به دایرکتوری موتور معنایی
cd semantic-engine

# نصب وابستگی‌ها
npm install

# کامپایل کدهای تایپ‌اسکریپت
npm run build

# اجرای آزمون‌های سلامت و گیت‌های کیفی
npm test
```

### بررسی وضعیت سلامت محیط (Doctor)
```bash
node bin/semantic-engine.js doctor
```
خروجی سلامت نسخه نود، وضعیت گرامرهای WASM، ماژول‌های اختیاری و سرورهای LSP را بررسی و گزارش می‌کند.

---

## ۵. دستورات خط فرمان (CLI Commands)

| فرمان | عملکرد |
|---|---|
| `semantic-engine ui` | **راه‌اندازی وب‌سرور یکپارچه و داشبورد بصری گراف (پیش‌فرض: پورت ۴۰۰۰). حتی بدون ایندکس قبلی هم بالا می‌آید و صفحهٔ Open/Configure را نشان می‌دهد.** |
| `semantic-engine start` | **ساخت ایندکس در صورت نیاز، راه‌اندازی هم‌زمان UI و MCP HTTP و فعال‌کردن watcher برای به‌روزرسانی خودکار artifactها (پورت‌های پیش‌فرض ۴۰۰۰ و ۳۰۰۰).** |
| `semantic-engine index` | اسکن کامل پروژه و ساخت `project-index.json` و `blueprint.json` |
| `semantic-engine watch` | ایندکس اولیه و پایش بلادرنگ تغییرات فایل‌ها؛ symbol، graph، blueprint و vectorهای فعال را به‌روز می‌کند |
| `semantic-engine serve` | ارائهٔ سرویس‌های ایندکس بر بستر پروتکل MCP (پیش‌فرض Stdio یا HTTP) |
| `semantic-engine query <tool>` | اجرای مستقیم ابزارهای تحلیلی هوش مصنوعی از خط فرمان |
| `semantic-engine doctor` | تست و ارزیابی پیش‌نیازهای محیط اجرا |

### مسیر یکنواخت پروژه و ایندکس

ریشهٔ پروژه همیشه همان مسیر `--root` است و فقط **خوانده** می‌شود؛ خروجی از
نسخهٔ چندپروژه‌ای به بعد در data directory کاربر نوشته می‌شود تا هیچ checkout
به‌خاطر ایندکس dirty نشود:

```text
Linux     $XDG_DATA_HOME/semantic-engine        (وگرنه ~/.local/share/semantic-engine)
macOS     ~/Library/Application Support/SemanticEngine
Windows   %LOCALAPPDATA%\SemanticEngine

<dataRoot>/projects/<projectId>/project-index.json
                             /blueprint.json
                             /project-artifacts.manifest.json
```

`<projectId>` برابر `prj-<slug(نام)>-<sha256(مسیر canonical)[0:8]>` است، پس دو
پروژهٔ هم‌نام در دو مسیر مختلف هرگز به هم نمی‌خورند؛ با `--project-id` هم
قابل تعیین است. مسیر data root با `SEMANTIC_ENGINE_DATA_DIR` یا `--data-dir`
عوض می‌شود.

دو راه فرار برای سازگاری با گذشته وجود دارد: `--out <dir>` مثل قبل بر همه‌چیز
مقدم است، و `--artifact-location in-root` (یا
`SEMANTIC_ENGINE_ARTIFACT_LOCATION=in-root`) همان رفتار قدیمی
`<root>/.semantic-engine/` را برمی‌گرداند.

اگر ایندکس قدیمی در `<root>/.semantic-engine/`، `<root>/.agent/semantic/` یا
`<root>/semantic/` وجود داشته باشد، در اولین اجرا به data directory **کپی**
می‌شود (نه جابه‌جا) و `<artifactRoot>/migration.json` ثبت می‌کند که از کجا آمده؛
فایل‌های قدیمی هرگز پاک نمی‌شوند. دستورهای `serve`، `query`، `watch`، UI و MCP
همین قرارداد را استفاده می‌کنند و `semantic-engine doctor` مسیر data root و
وضعیت migration را گزارش می‌دهد. دادن خودِ `.agent` یا `.semantic-engine`
به‌عنوان `--root` نیز به ریشهٔ واقعی پروژه نرمال می‌شود.

### کش استخراج هر فایل (ایندکس مجدد سریع‌تر)

`index` و ایندکس اولیهٔ `watch`/`start` خروجی خام استخراج هر فایل را (symbol،
import/export، configUsage) براساس هش محتوا در `<artifactRoot>/cache/extraction.json`
نگه می‌دارند. اجرای بعدی فایل‌های دست‌نخورده را دوباره parse نمی‌کند، ولی همهٔ مراحل
بعدی (resolve کردن importها، گراف‌ها، git، diagnostics، بردار) هر بار اجرا می‌شوند؛
پس خروجی با ایندکس کامل یکی است (تست برابری دارد). روی همین مخزن، `index` مجدد از
حدود ۸٫۱ به ۵٫۳ ثانیه رسید.

کش با هر یک از این‌ها باطل می‌شود: تغییر نسخهٔ پکیج یا کد استخراج‌گرها/گرامرها،
تغییر هش/زبان/شناسهٔ فایل، حذف فایل، فایل کش خراب. با استخراج symbol از زبان‌سرور
(`lsp`) کش استفاده نمی‌شود چون خروجی قطعی نیست. `--full` کش را نادیده می‌گیرد و
از نو می‌سازد؛ `--no-cache` نه می‌خواند و نه می‌نویسد. کش قابل بازسازی است و حذفش
فقط اجرای بعدی را کند می‌کند.

### به‌روزرسانی خودکار artifactها

`semantic-engine watch` تغییرات create/modify/delete/rename را پس از یک
بازهٔ کوتاه debounce به‌صورت incremental پردازش می‌کند. در هر batch موفق،
فایل تغییرکرده و وابسته‌های لازم دوباره parse می‌شوند و این داده‌ها در
`project-index.json` به‌روز می‌شوند:

- فایل‌ها، symbols، imports/exports و metrics
- dependency graph، type graph، call graph و reverse dependency graph
- config usages، Git metrics و test mappings
- vector chunk و embedding فایل‌های affected، در صورتی که vector mode فعال باشد
- diagnostics فایل دست‌خورده **پاک** می‌شود (SE-INC-11): زبان‌سرور در batch
  افزایشی اجرا نمی‌شود، و نگه‌داشتن هشدارِ محتوای قبلی بدتر از نداشتنش است.
  در full index بعدی دوباره گرفته می‌شوند.

`blueprint.json` در watcher با حالت `always` (پیش‌فرض CLI) بازسازی می‌شود؛
با `--blueprint-mode threshold` می‌توان رفتار قدیمیِ مبتنی بر drift را فعال
کرد. `project-index.json` تنها منبع حقیقت است؛ برای پرس‌وجوی ساختاریافته از
ابزارهای `query_*`/`find_*` روی همان ایندکس استفاده می‌شود.

فرمان `start` همین watcher را هم به‌صورت پیش‌فرض زیر نظر می‌گیرد. علاوه بر
این، UI/Platform cache و MCP snapshot هنگام تغییر artifactها reload می‌شوند.
برای اجرای فقط UI و MCP بدون watcher از `--no-watch` استفاده کن.

### diagnostics از زبان‌سرور (اختیاری)

دو نوع diagnostic در ایندکس وجود دارد و منشأشان فرق می‌کند:

- **خودکار** — هشدارهای اسکنر و استخراج (فایل ناخوانا، symlink معلق، تجزیهٔ
  ناموفق). این‌ها همیشه گرفته می‌شوند و در `FileEntry.diagnostics` و
  `project-index.json.diagnostics` می‌نشینند.
- **زبان‌سرور** — خطاهای واقعی کامپایلور. با `--lsp-diagnostics` روشن می‌شود،
  چون هزینه دارد (۱۶۴ فایل همین مخزن ~۷٫۷s؛ روی `test-projects/unreal-engine`
  با ۳۰۱ فایل: ۴٫۴s بدون این مرحله در برابر ۱۳٫۲s با آن) و
  `--diagnostics-budget <ms>` سقفش است. فایل‌هایی که پشتِ سقف می‌مانند
  «بررسی‌نشده» می‌مانند، نه «تمیز».

  کیفیت این مرحله به همان چیزی وابسته است که tsserver در ویرایشگر به آن
  وابسته است: به نصب‌بودنِ dependencies. بدون `npm install`، نیمی از
  یافته‌ها «Cannot find module»های کاذب‌اند — روی همان پروژه، ۶۷۲ diagnostic با
  `node_modules` حذف‌شده در برابر ۹۰ فایل دارای یافته پس از نصب.

وقتی این مرحله اجرا شود، ایندکس یک رکورد هم‌وضعیت می‌نویسد:

```json
"diagnosticsRun": { "filesWithFindings": 12, "filesSkippedByBudget": 0, "budgetMs": 60000, "completedAt": "…" }
```

نبودِ این کلید معنا دارد: `explain_symbol` در آن حالت `diagnosticsNote`
می‌فرستد و صریح می‌گوید فهرست خالی یعنی «بررسی نشده»، نه «تمیز است».

### امضای سمبل و توضیح سطح کلاس (SE-SYM-19)

`signature` دو قاعده دارد و kind مشخصش می‌کند: برای سمبل فراخوانی‌شدنی
`name(params): return`، و برای سمبل اعلانی (class / interface / enum / struct /
trait / type-alias / namespace / module) خودِ **اعلان فشرده** — مثل
`class Repository implements Storage` یا `type Level = 'debug' | 'info'`.
`Name()` برای یک کلاس هم بی‌معنا بود هم گمراه‌کننده: ادعای فراخوانی‌شدنی
داشت؛ و چون خطِ سورس برتر است، شکل‌های زبان‌های دیگر هم خراب نمی‌شوند
(`pub struct Point` در Rust، `data class User(...)` در Kotlin).

`explain_symbol` روی یک سمبل اعلانی علاوه بر این‌ها را هم می‌دهد:

| فیلد | معنا |
|---|---|
| `members` / `memberCount` | اعضا، با امضا و پیچیدگی هرکدام (فهرست تا `limit` کوتاه می‌شود، شمارش کامل می‌ماند) |
| `aggregateComplexity` | جمع پیچیدگی اعضا — «این کلاس چقدر پیچیده است» همان‌جاست، نه روی اعلان خالی |
| `referencedBy` | چند گره و چند فایلِ متمایز به سمبل یا اعضایش وصل‌اند |
| `aggregation` | اینکه calls/calledBy از اعضا جمع شده‌اند (و چندتا از اعضا آمده) |

یال‌های داخلی (متدی از همان کلاس که متد دیگرش را صدا می‌زند) در `calls`
نمی‌آیند؛ جایشان `members` است.

### نمونه‌های کاربردی CLI:
```bash
# ۱. اسکن و ایندکس‌سازی پروژه فعلی
semantic-engine index --root . --vectors --lsp-diagnostics --diagnostics-budget 20000

# ۲. راه‌اندازی داشبورد بصری و وب‌سرور Standalone
#    (بدون ایندکس قبلی هم بالا می‌آید؛ ایندکس‌سازی را از داخل UI انجام بده)
semantic-engine ui --port 4000 --root . --token my-secret-token

# برای دیده‌شدن UI در محیط‌های پیش‌نمایش/شبکه، روی همهٔ رابط‌ها Bind کن:
semantic-engine ui --port 4000 --root . --host 0.0.0.0 --allow-remote --token my-secret-token

# ۳. راه‌اندازی هم‌زمان UI و MCP HTTP + watcher خودکار
#    start به‌صورت پیش‌فرض artifactهای index/blueprint/vector را
#    پس از تغییر فایل‌ها تازه می‌کند؛ برای خاموش‌کردن watcher: --no-watch
semantic-engine start --root . --ui-port 4000 --mcp-port 3000 \
  --vectors --token my-secret-token

# ۴. پایش زنده تغییرات کد به‌صورت مستقل
semantic-engine watch --root . --vectors
#    --blueprint-mode always (پیش‌فرض) یا threshold

# ۵. اجرای کوئری تحلیلی نماد
semantic-engine query find_symbol --name "AuthService" --json
```

### ۵.۱ صفحهٔ Open / Configure (باز کردن و پیکربندی پروژه)

پس از اجرای `semantic-engine ui`، مرورگر را روی آدرس ریشه (`/`) باز کن. این صفحه یک ویزارد چندمرحله‌ای است و به ایندکسِ از پیش‌ساخته‌شده نیازی ندارد:

1. **انتخاب مسیر پروژه** — تایپ دستی مسیر یا مرور فایل‌سیستم (با نشانگر «پروژه»/«ایندکس‌شده»).
2. **نحوهٔ اسکن** — موتور تجزیه (`tree-sitter` دقیق / `heuristic` سبک)، رعایت `.gitignore`، رد کردن پوشه‌های مخفی، حداکثر عمق و اندازهٔ فایل، الگوهای ignore اضافی، و خروجی `blueprint.json`.
3. **مدل Embedding و اتصال Provider** — انتخاب provider و **دریافت خودکار مدل‌ها**:
   * **Local (Xenova / transformers.js):** آفلاین و بدون کلید؛ مدل پیش‌فرض `Xenova/all-MiniLM-L6-v2`.
   * **Ollama:** مدل‌ها از `‎<baseUrl>/api/tags` خوانده می‌شوند (پیش‌فرض `http://localhost:11434`).
   * **OpenAI-compatible (vLLM / LMStudio / OpenAI / OpenRouter):** مدل‌ها از `‎<baseUrl>/v1/models`؛ کلید API اختیاری.
   * گزینهٔ **استفاده از مدل پیش‌فرض** یا انتخاب دستی مدل embedding.
4. **شروع ایندکس‌سازی** — با نمایش زندهٔ پیشرفت (SSE) و سپس لینک مستقیم به **Visualizer**.

> **توکن:** UI به توکنِ `--token` نیاز دارد؛ آن را در بالای صفحه وارد و ذخیره کن (در `localStorage` می‌ماند) یا با پارامتر `?token=…` در URL بده. صفحهٔ Visualizer با `/visualizer` و پارامتر `?project=<id>` در دسترس است.

---

## ۵.۱ معماری چندپروژه‌ای: Gateway و Workerها

یک Gateway روی یک پورت عمومی می‌نشیند و چند Worker تک‌پروژه‌ای را مدیریت می‌کند. هر Worker یک پروسهٔ مستقل است با یک workspace، یک ایندکس، یک watcher و یک کانال MCP؛ Gateway فقط ثبت، مسیریابی، نظارت و بازیابی انجام می‌دهد و هیچ تحلیلی روی کد نمی‌کند.

```text
Browser / AI Client
        │
        ▼
Semantic Gateway :4000        ← تنها پورت عمومی
        ├── Worker prj-a      (Unix socket یا loopback)
        ├── Worker prj-b
        └── Worker prj-c
```

```bash
# بالا آوردن Gateway (پروژه‌ها از کنسول یا API ثبت می‌شوند)
semantic-engine gateway --port 4000 --token <secret>

# یک Worker مستقل، بدون Gateway
semantic-engine worker --project-id prj-app-12345678 --root /path/to/app

# کنسول Gateway
#   http://127.0.0.1:4000/gateway
```

### کنسول Gateway (`/gateway`)

کنسول مرکزی همهٔ instanceها (workerها) را نشان می‌دهد: جدول با پروژه، شناسه، مسیر،
PID، وضعیت worker و وضعیت ایندکس، کارت‌های جمع، و برای هر ردیف اکشن‌های Open dashboard
(Visualizer همان پروژه)، Start/Stop/Restart/Reindex، Edit configuration، Health detail،
Open MCP endpoint و Remove. دکمهٔ **New worker** فرمی دارد که گزینه‌های `worker` را پوشش
می‌دهد و دستور نهایی را پیش‌نمایش می‌کند:

| بخش فرم | گزینه‌ها (پرچم CLI) |
|---|---|
| project | `--project-id`، نام، `--root`، `--data-dir`، شروع خودکار |
| scan | `--max-depth`، `--max-file-size-mb`، `--ignore`، `--no-gitignore`، `--no-skip-hidden` |
| diagnostics | `--lsp-diagnostics`، `--diagnostics-budget` |
| cache | `--full` / `--no-cache` (کش استخراج)، `--artifact-location` |
| indexing / watch | `--vectors`، `--no-blueprint`، `--no-git`، `--no-tree-sitter`، `--debounce`، `--blueprint-mode`، `--skip-initial-index` |
| service / security | پورت‌ها و transport، `--http`، `--stdio`، `--web`، `--gateway-managed`، `--allow-remote`، متغیر توکن |
| embedding | provider، مدل، base URL، متغیر کلید API، normalize |

پرچم‌های scan فقط وقتی به worker می‌رسند که با پیش‌فرض فرق کنند، تا مقدارِ `config.json`
دایرکتوری داده با یک فرم دست‌نخورده بازنویسی نشود. همهٔ گزینه‌های ایندکس به پروسهٔ watch
همان worker هم منتقل می‌شوند. `npm run test:e2e` این کنسول را با مرورگر واقعی تست می‌کند.

### داده‌های تولیدشده کجا می‌نشینند

از این نسخه، خروجی‌ها **بیرون از checkout** نوشته می‌شوند تا مخزن به‌خاطر ایندکس dirty نشود:

```text
Linux     $XDG_DATA_HOME/semantic-engine      (وگرنه ~/.local/share/semantic-engine)
macOS     ~/Library/Application Support/SemanticEngine
Windows   %LOCALAPPDATA%\SemanticEngine

<dataRoot>/projects/<projectId>/project-index.json
                             /blueprint.json
                             /project-artifacts.manifest.json
                             /migration.json
<dataRoot>/gateway/sockets/<projectId>.sock
<dataRoot>/gateway/logs/<projectId>.log
<dataRoot>/registry.json
```

`<projectId>` برابر `prj-<slug(نام)>-<sha256(مسیر canonical)[0:8]>` است، پس دو checkout با نام یکسان هرگز به هم نمی‌خورند.

| متغیر/پرچم | کار |
|---|---|
| `SEMANTIC_ENGINE_DATA_DIR` / `--data-dir` | جای data root |
| `SEMANTIC_ENGINE_ARTIFACT_LOCATION` / `--artifact-location` | `external` (پیش‌فرض) یا `in-root` (رفتار قدیمی) |
| `--out <dir>` | نوشتن در مسیر دلخواه؛ بر هر دو مقدم است |
| `SEMANTIC_ENGINE_GATEWAY_TOKEN` | توکن Gateway |

### migration از خروجی‌های قدیمی

ایندکس‌های قدیمی داخل checkout (`.semantic-engine/`، `.agent/semantic/`، `semantic/`) در اولین اجرا به data directory **کپی** می‌شوند — نه جابه‌جا. فایل اصلی هرگز پاک نمی‌شود و `migration.json` ثبت می‌کند از کجا آمده:

```json
{ "migratedFrom": "/repo/app/.agent/semantic", "migrationMode": "copy-readonly-legacy" }
```

### نگهداری از کش

```bash
semantic-engine cache list                          # چه چیزی کش شده و چقدر جا گرفته
semantic-engine cache clean --project prj-a-…       # فقط همان پروژه (هرگز source tree)
semantic-engine cache clean --older-than 30d        # پیش‌فرض dry-run
semantic-engine cache clean --older-than 30d --force
semantic-engine cache export --project prj-a-… --to /backup
semantic-engine cache import --project prj-a-… --from /backup/prj-a-…
```

`cache` فقط دادهٔ تولیدشده را پاک می‌کند و دو گارد دارد: مقصد باید داخل `<dataRoot>/projects/` باشد و با هیچ workspace ثبت‌شده‌ای هم‌پوشانی نداشته باشد.

### اندپوینت‌های چندپروژه‌ای

```text
GET    /health  /ready  /metrics                    سلامت خود Gateway
GET    /api/v1/gateway/projects                     فهرست پروژه‌ها
POST   /api/v1/gateway/projects                     ثبت پروژه (+ autoStart)
GET    /api/v1/gateway/projects/:id/health          جزئیات سلامت یک پروژه
POST   /api/v1/gateway/projects/:id/start|stop|restart|reindex
GET    /api/v1/gateway/events                       رویدادها (SSE)
ANY    /api/v1/projects/:id/...                     proxy به worker همان پروژه
POST   /mcp/:id                                     MCP همان پروژه
GET    /ws/projects/:id                             WebSocket همان پروژه
GET    /projects/:id                                deep link به داشبورد پروژه
```

هر پاسخ proxy‌شده هدر `X-Semantic-Project-Id` دارد تا مشخص باشد پاسخ مال کدام پروژه است.

## ۶. تنظیمات و پیکربندی (Configuration)

تنظیمات پلتفرم از طریق فلگ‌های CLI، متغیرهای محیطی یا فراخوانی داینامیک API مدیریت می‌شوند:

| متغیر محیطی | فلگ CLI | مقدار پیش‌فرض | شرح |
|---|---|:---:|---|
| `SEMANTIC_ENGINE_TOKEN` | `--token <str>` | *(تولید خودکار)* | توکن امنیتی Bearer جهت احراز هویت درخواست‌ها |
| `SEMANTIC_ENGINE_PORT` | `--port <n>` | `4000` (UI) / `3000` | پورت گوش‌دادن سرور HTTP |
| `SEMANTIC_ENGINE_HOST` | `--host <addr>` | `127.0.0.1` | آدرس Bind سرور (تنها لوپ‌بک مگر با `--allow-remote`) |
| `SEMANTIC_ALLOW_REMOTE`| `--allow-remote`| `false` | اجازهٔ دسترسی و اتصال به سرور از خارج شبکه محلی |
| `SEMANTIC_MAX_ITEMS` | `--max-items <n>`| `50` | حداکثر اقلام خروجی در هر فراخوانی ابزار |
| `SEMANTIC_EXCERPT_CHARS`| `--excerpt <n>`| `200` | حداکثر طول کاراکتر برای خلاصه‌کدها جهت حفظ توکن |

---

## ۷. مستندات کامل اندپوینت‌های ۱۴گانهٔ API

تمامی پاسخ‌ها با هدر استاندارد `Content-Type: application/json` و فیلتر خودکار اسرار (`maskSecrets`) بازگردانده می‌شوند.

---

### ۰۱. System & Status API
وضعیت عملیاتی، قابلیت‌های فعال و سازگاری انجین را برمی‌گرداند.

* **مسیر:** `GET /api/v1/system`
* **سطح دسترسی:** عمومی (Public)
* **نمونه پاسخ:**
```json
{
  "name": "@aicoder/semantic-engine",
  "version": "2.0.0",
  "apiVersion": "v1",
  "status": "operational",
  "capabilities": {
    "semanticSearch": true,
    "graphQuery": true,
    "lspLiveDiagnostics": true,
    "multiLanguageWasm": true,
    "layeredGraph": true,
    "contextAssembly": true,
    "sseEvents": true
  },
  "supportedLanguages": ["typescript", "javascript", "python", "go", "java", "rust", "cpp", "csharp", "php", "ruby"]
}
```

---

### ۰۲. Configuration API
مشاهده و به‌روزرسانی پیکربندی ران‌تایم پلتفرم بدون نیاز به ری‌استارت.

* **مسیرها:** `GET /api/v1/config` · `PATCH /api/v1/config`
* **سطح دسترسی:** `Admin` (نیاز به توکن)
* **پارامترهای ورودی (PATCH):** `{ "maxBodyBytes": 10485760 }`
* **نمونه پاسخ:**
```json
{
  "port": 4000,
  "host": "127.0.0.1",
  "allowRemote": false,
  "maxBodyBytes": 10485760,
  "tokenConfigured": true,
  "embedding": { "model": "Qwen3-Embedding-0.6B" },
  "database": { "password": "***" }
}
```

---

### ۰۳. Identity & Scoped Access API (IAM / RBAC)
مدیریت نقش‌ها، کاربران و صدور کلیدهای دامنه‌دار API (Resource Scopes).

* **مسیرها:**
  - `GET /api/v1/roles` (مشاهده نقش‌های ۵گانه: `Admin`, `Architect`, `Developer`, `Agent`, `ReadOnly`)
  - `GET /api/v1/auth/api-keys` (فهرست کلیدهای فعال با ماسک هش)
  - `POST /api/v1/auth/api-keys` (ایجاد کلید دامنه‌دار جدید)
  - `POST /api/v1/auth/verify` (اعتبارسنجی توکن و بررسی دامنه‌ها)
  - `DELETE /api/v1/auth/api-keys/:keyId` (ابطال آنی کلید)
* **نمونه ورودی ایجاد کلید:**
```json
{
  "name": "Agent Subsystem Alpha",
  "role": "Agent",
  "resourceScope": "project:prj-python-service",
  "expiresInMs": 86400000
}
```
* **نمونه پاسخ:**
```json
{
  "rawToken": "sk_plat_7f9a2b...",
  "key": {
    "id": "key_1829af4",
    "name": "Agent Subsystem Alpha",
    "role": "Agent",
    "resourceScope": "project:prj-python-service",
    "createdAt": 1724155200000
  }
}
```

---

### ۰۴. Projects Management API
ثبت، بازخوانی، ویرایش و مدیریت پروژه‌ها.

* **مسیرها:**
  - `GET /api/v1/projects` (لیست پروژه‌های ثبت‌شده)
  - `POST /api/v1/projects` (ثبت و اسکن اولیه پروژه بر پایه مسیر)
  - `GET /api/v1/projects/:id` (دریافت آمار کامل فایل‌ها، نمادها، وابستگی‌ها و وضعیت ایندکس)
  - `DELETE /api/v1/projects/:id`
* **نمونه پاسخ:**
```json
{
  "id": "prj-python-service",
  "name": "python-service",
  "status": "ready",
  "files": 3,
  "symbols": 11,
  "dependencies": 8,
  "languages": ["python"],
  "stats": { "lastIndexedAt": "2026-08-20T11:20:55.820Z" }
}
```

---

### ۰۵. Source & Remote Sync API
همگام‌سازی سورس از گیت ریموت، آپلود فایل و واردسازی پکیج‌های چندفایلی.

* **مسیرها:**
  - `POST /api/v1/projects/:id/source/sync` (دریافت تغییرات با Git URL / Webhook)
  - `PUT /api/v1/projects/:id/files/:filePath` (به‌روزرسانی امن یک فایل با گارد ضد Path Traversal)
  - `POST /api/v1/projects/import-bundle` (آپلود پکیج فایل‌ها به صورت مستقیم)
* **نمونه ورودی Import Bundle:**
```json
{
  "projectId": "virtual-service",
  "name": "Virtual Service",
  "files": {
    "src/app.ts": "export const app = 'online';",
    "src/helper.ts": "export function help() { return true; }"
  }
}
```

---

### ۰۶. Indexing & Async Jobs API
مدیریت وظایف سنگین پردازش و ایندکس‌سازی به صورت Background Job با استریم پیشرفت.

* **مسیرها:**
  - `POST /api/v1/projects/:id/index` (آغاز ایندکس و برگرداندن فوری `jobId`)
  - `GET /api/v1/projects/:id/jobs/:jobId` (گزارش وضعیت فازها و درصد پیشرفت)
  - `POST /api/v1/projects/:id/jobs/:jobId/cancel` (لغو اتمیک پردازش)
  - `GET /api/v1/projects/:id/events` (استریم SSE رویدادهای `job.*`)
* **نمونه ورودی با گزینه‌های اسکن و embedding (SE-UI-06):** همهٔ فیلدها اختیاری‌اند؛ بدنهٔ خالی رفتار پیش‌فرض را اجرا می‌کند.
```json
{
  "scan": {
    "treeSitter": true,
    "useGitignore": true,
    "skipHiddenDirectories": true,
    "maxDepth": 0,
    "maxFileSizeMb": 5,
    "additionalIgnorePatterns": ["**/*.snap", "vendor/**"]
  },
  "output": { "blueprint": true },
  "embedding": {
    "enabled": true,
    "provider": "local",
    "useDefaultModel": true,
    "model": "",
    "normalize": true
  }
}
```
* **نمونه پاسخ استارت ایندکس:**
```json
{
  "jobId": "job-1724155200-ab89",
  "projectId": "prj-python-service",
  "status": "running",
  "phase": "init",
  "progress": 0,
  "options": { "treeSitter": true, "useGitignore": true, "blueprint": true, "embedding": { "provider": "local", "model": "Xenova/all-MiniLM-L6-v2" } }
}
```

---

### ۰۶.۱ Embedding Providers & Filesystem API
اندپوینت‌هایی که صفحهٔ Open/Configure برای اتصال provider، دریافت خودکار مدل‌ها و انتخاب مسیر پروژه استفاده می‌کند (SE-UI-03، SE-UI-04).

* **مسیرها:**
  - `GET /api/v1/providers` (فهرست providerهای پشتیبانی‌شده + مدل‌های لوکال پیش‌فرض)
  - `POST /api/v1/providers/models` (اتصال و دریافت خودکار مدل‌های embedding)
  - `GET /api/v1/fs/browse?path=<dir>` (مرور فقط‌خواندنی فایل‌سیستم برای انتخاب مسیر پروژه)
* **نمونه ورودی دریافت مدل‌ها (Ollama):**
```json
{ "provider": "ollama", "baseUrl": "http://localhost:11434" }
```
* **نمونه پاسخ:**
```json
{
  "provider": "ollama",
  "connected": true,
  "defaultModel": "nomic-embed-text",
  "models": [
    { "id": "nomic-embed-text", "name": "nomic-embed-text" },
    { "id": "mxbai-embed-large", "name": "mxbai-embed-large" }
  ]
}
```

---

### ۰۷. Search API
جستجوی هیبریدی، متنی BM25 و برداری به همراه بازرتبه‌بندی مفهومی (Reranker).

* **مسیر:** `POST /api/v1/projects/:id/search`
* **نمونه ورودی:**
```json
{
  "query": "jwt authentication token generator",
  "mode": "hybrid",
  "limit": 5
}
```
* **نمونه پاسخ:**
```json
{
  "query": "jwt authentication token generator",
  "total": 3,
  "items": [
    {
      "id": "667a8e24bc15e8c6",
      "name": "JwtHandler",
      "kind": "class",
      "path": "auth/jwt_handler.py",
      "score": 0.94,
      "source": "tree-sitter",
      "excerpt": "class JwtHandler: def generate_token(...) -> str"
    }
  ]
}
```

---

### ۰۸. Code Intelligence API
استخراج نمای ۳۶۰ درجه نمادها، سلسله‌مراتب فراخوانی‌ها، ارجاعات و خطاهای زندهٔ کامپایلر.

* **مسیرها:**
  - `GET /api/v1/projects/:id/symbols/:symbolId`
  - `GET /api/v1/projects/:id/callers?symbol=...`
  - `GET /api/v1/projects/:id/dependencies?path=...`
* **نمونه پاسخ:**
```json
{
  "symbol": { "id": "s1", "name": "AuthService.login", "kind": "method" },
  "location": { "path": "src/auth.service.ts", "line": 42, "endLine": 78 },
  "callers": [{ "fromSymbol": "AuthController.login", "path": "src/auth.controller.ts" }],
  "references": [{ "name": "User", "kind": "class" }],
  "tests": ["test/auth.test.ts"],
  "diagnostics": { "errors": 0, "warnings": 0 }
}
```

---

### ۰۹. Knowledge Graph LoD API
پیمایش هوشمند گراف با سقف عمق و استخراج زیرگراف‌ها.

* **مسیرها:**
  - `POST /api/v1/projects/:id/visualization/neighborhood`
  - `POST /api/v1/projects/:id/visualization/path`
* **نمونه ورودی Neighborhood:**
```json
{
  "seedId": "class-auth-service",
  "depth": 2,
  "minConfidence": 70
}
```
* **نمونه پاسخ:**
```json
{
  "level": "neighborhood",
  "nodes": [
    { "id": "class-auth-service", "type": "class", "label": "AuthService" },
    { "id": "fn-login", "type": "function", "label": "login()" }
  ],
  "edges": [
    { "id": "edge-0", "source": "class-auth-service", "target": "fn-login", "relation": "contains", "metadata": { "confidence": 100, "basis": "resolved" } }
  ],
  "summary": { "totalNodes": 2, "totalEdges": 1, "confidentRatio": 1.0 }
}
```

---

### ۱۰. Context & Token Budget Engine API
تولید بسته کانتکست بهینه با فشرده‌سازی هوشمند بدنه توابع جهت مصرف مدل‌های هوش مصنوعی.

* **مسیر:** `POST /api/v1/projects/:id/context`
* **نمونه ورودی:**
```json
{
  "task": "refactor payment webhook handler",
  "maxTokens": 4000
}
```
* **نمونه پاسخ:**
```json
{
  "task": "refactor payment webhook handler",
  "tokenEstimate": 2480,
  "files": [
    { "path": "src/payment.service.ts", "role": "service", "key_symbols": ["PaymentProcessor", "charge_user"] }
  ],
  "summary": "Context assembled within budget (saved 38% tokens via ContextCompressor)."
}
```

---

### ۱۱. Deep Analysis API (Impact, Architecture & Simulation)
محاسبه شعاع اثر، بررسی خطاهای لایه‌بندی معماری، کشف چرخه‌ها و شبیه‌سازی ریفکتورینگ در حافظه.

* **مسیرها:**
  - `POST /api/v1/projects/:id/analysis/impact` (محاسبه شعاع اثر ۳-سطحی و RiskScore)
  - `GET /api/v1/projects/:id/analysis/architecture-violations` (نقض لایه‌بندی)
  - `GET /api/v1/projects/:id/analysis/dependency-cycles` (چرخه‌های وابستگی با الگوریتم Tarjan)
  - `POST /api/v1/projects/:id/analysis/simulate-mutation` (شبیه‌سازی حذف/تغییر نام در حافظه)
* **نمونه پاسخ تحلیل شعاع اثر:**
```json
{
  "rootSymbolId": "UserRepo",
  "riskScore": 48,
  "blastRadius": {
    "directDependentsCount": 1,
    "transitiveDependentsCount": 2,
    "affectedFilesCount": 3,
    "affectedApisCount": 1,
    "affectedTestsCount": 1
  },
  "affectedEntities": [
    { "id": "AuthService", "type": "symbol", "severity": "high", "propagationPath": ["UserRepo", "AuthService"] }
  ]
}
```

---

### ۱۲. History & Git Hotspots API
تحلیل داده‌های گیت، ماتریس نقاط پرخطر و فایل‌های هم‌تغییر.

* **مسیرها:**
  - `GET /api/v1/projects/:id/history/hotspots` (رتبه‌بندی فایل‌ها بر پایه `Churn × Complexity`)
  - `GET /api/v1/projects/:id/history/co-churn/:filePath` (فایل‌هایی که همواره با هم کامیت می‌شوند)
  - `POST /api/v1/projects/:id/history/record-commit`
* **نمونه پاسخ Hotspots:**
```json
{
  "projectId": "prj-python-service",
  "hotspots": [
    { "filePath": "auth/jwt_handler.py", "commitsCount": 12, "churnScore": 84, "complexity": 4, "hotspotScore": 336 }
  ]
}
```

---

### ۱۳. Dashboard Visualization API
تأمین داده‌های چندلایه‌ای برای بوم گراف وب‌داشبورد (LoD Views).

* **مسیرها:**
  - `GET /api/v1/projects/:id/dashboard/overview` (خلاصه وضعیت، آمار و سلامت پروژه)
  - `GET /api/v1/projects/:id/visualization/architecture` (نمای معماری سطح ۱)
  - `GET /api/v1/projects/:id/visualization/module/:moduleId` (نمای ماژول سطح ۲)
  - `GET /api/v1/projects/:id/visualization/workflow/:workflowId` (جریان اجرای فرایندها)
  - `GET /api/v1/projects/:id/visualization/business-mapping` (نگاشت موجودیت کسب‌وکار به کد)
  - `GET /api/v1/projects/:id/visualization/test-map` (ماتریس هوش تست‌ها)

---

### ۱۴. Events & Realtime WebSocket API
استریم زنده رویدادهای پیشرفت پردازش و کانال ارتباطی دوطرفه با ایجنت.

* **استریم SSE:** `GET /api/v1/projects/:id/events`
  - رویدادها: `job.started`، `job.progress`، `job.completed`، `file.updated`
* **کانال زنده فرامین:** `WebSocketManager`
  - هدایت دوربین و هایلایت مسیر توسط مدل: `agent.graph.command` (`focus`, `highlight_path`, `annotate`)

---

## ۸. خط‌لولهٔ امنیتی و گاردهای تخصصی (Security & Guards)

### خط‌لوله پایپ‌لاین امنیتی (`SecurityPipeline.ts`)
هر درخواست ورودی از مراحل زیر عبور داده می‌شود:
1. **Loopback Guard:** مسدودسازی درخواست‌های خارج از لوپ‌بک (`127.0.0.1`) مگر با فلگ صریح `--allow-remote`.
2. **Bearer Token & API Key Authentication:** ارزیابی صحت توکن یا کلید هدر `Authorization` یا `X-API-Key`.
3. **Scoped RBAC Authorization:** تطابق نقش و دامنهٔ کلید با منبع درخواستی (`project:<id>` یا `*`).
4. **Schema Validation:** اعتبارسنجی تمامی Payloadهای JSON با کتابخانهٔ **Ajv**.
5. **Secret Masking:** پنهان‌سازی خودکار کلمات عبور، کلیدهای محرمانه و توکن‌ها در خروجی پاسخ‌ها با مقدار `******`.

### گاردهای تخصصی هوش کد (Semantic Guards)
* **Query Guard:** سقف ۵۰ قلم برای خروجی‌ها و برش خطوط طولانی.
* **Source Guard:** سقف حجم فایل ۱۰ مگابایت، رد لینک‌های چرخشی (Symlink Loop) و مسدودسازی دستکاری خارج از ریشه (Path Traversal).
* **Graph Guard:** سقف عمق پیمایش، سقف ۵۰ نود در هر پاسخ و تایم‌اوت محاسبات الگوریتم Tarjan و BFS.
* **Job Guard:** لغو اتمیک وظایف، بازایندکس با دیتابیس سایه (**Stale-While-Reindex**) جهت جلوگیری از قفل شدن ریدها.

---

## ۹. مشاهده‌پذیری و لاگ ممیزی (Observability & Audit Trail)

### ممیزی تغییرناپذیر (`AuditLogger.ts`)
تمامی اقدامات حساس با ثبت شناسه بازیگر، وضعیت و **زنجیره هش پیوستهٔ SHA-256 (`previousHash -> hash`)** ذخیره می‌شوند و با تابع `verifyIntegrity()` اصالت کل زنجیره تایید می‌گردد.

### متریک‌های پرومتئوس و تله‌متری W3C
* **اندپوینت متریک‌ها:** `GET /metrics` با فرمت استاندارد پرومتئوس:
  - `semantic_engine_requests_total`
  - `semantic_engine_index_duration_sum_ms`
* **استاندارد TraceContext:** پشتیبانی از هدر `traceparent` جهت ردیابی درخواست‌ها در OpenTelemetry.

---

## ۱۰. ماتریس پروتکل‌ها و آداپتورها (Protocols & Adapters)

| بخش سرویس | REST | MCP | SSE | WebSocket |
|---|:---:|:---:|:---:|:---:|
| **System & Health** | ✅ | ✅ | — | — |
| **Configuration** | ✅ | — | ✅ | — |
| **Identity & Access** | ✅ | — | — | — |
| **Projects** | ✅ | — | ✅ | — |
| **Source Sync** | ✅ | — | — | — |
| **Indexing & Jobs** | ✅ | — | ✅ | ✅ |
| **Search** | ✅ | ✅ | — | — |
| **Code Intelligence** | ✅ | ✅ | — | — |
| **Graph & LoD** | ✅ | ✅ | ✅ | ✅ |
| **Context Assembly** | ✅ | ✅ | — | — |
| **Deep Analysis** | ✅ | ✅ | — | — |
| **Git History** | ✅ | ✅ | — | — |
| **Dashboard Views** | ✅ | — | ✅ | ✅ |
| **Realtime Events** | — | — | ✅ | ✅ |

---

## ۱۱. اتصال به Structured AI و کلاینت‌های خارجی MCP

### اتصال ایجنت‌های Structured AI
ایجنت‌ها از طریق کلاینت سبک `agent/lib/semantic.js` به صورت پیش‌فرض با کانال Stdio پروسه را در پس‌زمینه اجرا می‌کنند. ابزارهای زیر مستقیماً در دسترس مدل هستند:
`code_find_symbol` · `code_search` · `code_file_summary` · `code_dependencies` · `code_impact` · `code_find_tests` · `code_config_usage` · `code_context` · `code_diagnostics` · `code_callers` · `code_definition` · `code_rename` · `code_simulate_mutation` · `code_architecture_violations` · `code_git_hotspots`.

### اتصال کلاینت‌های خارجی (Claude Desktop / Cursor / VSCode Cline)
باینری MCP را در فایل پیکربندی کلاینت خود قرار دهید:
```json
{
  "mcpServers": {
    "semantic-engine": {
      "command": "node",
      "args": [
        "/path/to/semantic-engine/dist/ai/mcp/cli.js",
        "--root",
        "/path/to/project"
      ]
    }
  }
}
```

---

## محدودیت‌ها و وابستگی‌های اختیاری (Limitations & Optional Dependencies)

این بخش عمداً چیزهایی را می‌گوید که کار **نمی‌کنند** یا شرط دارند؛ غافلگیر شدن در اولین برخورد بدتر از خواندن یک فهرست است.

### وابستگی‌های اختیاری (optional dependencies)

چهار بسته `optional` هستند: اگر نصب نشوند نصب کل پکیج شکست نمی‌خورد، ولی قابلیت مربوطه خاموش می‌شود.

| بسته | چه چیزی را روشن می‌کند | نبودش یعنی |
|---|---|---|
| `@xenova/transformers` | embedding محلی برای جست‌وجوی معنایی | جست‌وجو به حالت کلیدواژه‌ای برمی‌گردد |
| `usearch` | ایندکس برداری سریع | جست‌وجوی برداری خطی و کندتر |
| `tree-sitter-typescript` | استخراج دقیق سمبل‌ها | برگشت به استخراج‌گر heuristic با دقت کمتر |
| `tree-sitter-javascript` | همان، برای جاوااسکریپت | همان |

این بسته‌ها باینری نیتیو دارند و روی معماری‌هایی که build از پیش آماده ندارند، به کامپایلر نیاز پیدا می‌کنند.

### اجرا بدون شبکه (offline / no network)

هستهٔ موتور کاملاً آفلاین کار می‌کند: اسکن، ایندکس، گراف وابستگی، جست‌وجوی کلیدواژه‌ای و همهٔ ابزارهای MCP.

آنچه شبکه می‌خواهد و بدون آن خاموش می‌شود:

* **دانلود اولیهٔ مدل embedding** — پس از یک‌بار دانلود، از کش محلی خوانده می‌شود.
* **provider های LLM** (`ollama`, `openai-compatible`) — سرویس باید در دسترس باشد؛ در حالت `local` هیچ درخواست شبکه‌ای زده نمی‌شود.
* **غنی‌سازی با LSP** — به زبان‌سرور نصب‌شدهٔ همان زبان نیاز دارد.

`serve` و ورودی MCP standalone نیز وقتی index موجود باشد watcher را
به‌صورت پیش‌فرض اجرا می‌کنند؛ برای اتصال صرفاً به snapshot فعلی از
`--no-watch` استفاده کن. در نتیجه ابزارهای MCP و cache داشبورد پس از نوشتن
artifactهای جدید، snapshot تازه را دریافت می‌کنند.

### محدودیت‌های شناخته‌شده (known limitations)

* **زبان‌ها**: استخراج کامل سمبل فقط برای TypeScript و JavaScript است. بقیه (Python, Go, Java, Rust, …) با استخراج‌گر heuristic کار می‌کنند: فایل و وابستگی دیده می‌شود، ولی دقت سمبل کمتر است.
* **مقیاس**: ایندکس در حافظه ساخته می‌شود؛ برای مخازن خیلی بزرگ حافظه به‌تدریج سقف پیدا می‌کند.
* **تازگی ایندکس**: `index` یک عکس لحظه‌ای است؛ برای به‌روزرسانی پیوسته از `watch` یا `start` (که watcher را پیش‌فرض فعال می‌کند) استفاده کنید.
* **گراف فراخوانی**: فراخوانی‌های داینامیک (reflection، `eval`، ارسال با رشته) قابل ردیابی نیستند.
* **قفل `config.json` روی NFS**: ذخیرهٔ تنظیمات با فایل قفل exclusive-create انجام می‌شود (و بعد از ۱۰ ثانیه takeover دارد). روی NFS قدیمی یا برخی فایل‌سیستم‌های شبکه‌ای، `O_EXCL` اتمی نیست؛ اگر چند فرایند هم‌زمان از یک data directory روی NFS تنظیمات بنویسند، ممکن است آخرین نوشتن برنده شود. data directory را روی دیسک محلی نگه دارید (`--data-dir`).

---

## امنیت سرور HTTP (HTTP Server Security)

هر دو سرور HTTP — پلتفرم (`serve --ui`) و MCP (`semantic-engine-mcp --http`) — پیش‌فرض **فقط روی `127.0.0.1`** گوش می‌دهند و **توکن لازم دارند**.

```bash
# توکن مشخص؛ اگر ندهید یکی ساخته و چاپ می‌شود
semantic-engine serve --ui --token "$(openssl rand -base64 24)"

# باز کردن روی شبکه یک تصمیم صریح است، نه پیش‌فرض
semantic-engine serve --ui --host 0.0.0.0 --allow-remote --token "..."
```

مهارهای فعال:

* **توکن اجباری** روی همهٔ مسیرها، جز `/health`، `/ready`، `/metrics` و `/api/v1/system`. مسیری که فراموش کند اعلام کند، **بسته** است نه باز.
* **بررسی `Origin`** روی هر دو سرور، برای جلوگیری از DNS-rebinding؛ `Access-Control-Allow-Origin` فقط همان origin محلیِ پذیرفته‌شده را بازتاب می‌دهد.
* **سقف اندازهٔ بدنه** (پیش‌فرض ۴MB) با پاسخ `413`.
* **مسدودسازی آدرس‌های متادیتای ابر و link-local** در اندپوینت کشف مدل، تا `baseUrl` دلخواه به SSRF تبدیل نشود.

---

## مجوز (License)
این پروژه تحت مجوز **MIT** منتشر شده است.
