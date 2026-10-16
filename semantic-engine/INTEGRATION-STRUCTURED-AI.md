# یکپارچه‌سازی Semantic Engine در structured-ai

**تاریخ:** ۱۸ اوت ۲۰۲۶
**پیش‌نیاز:** تکمیل `MIGRATION-STANDALONE.md` (استقلال از VS Code) و `LSP-ARCHITECTURE.md`
**اسناد مرتبط:** `AUDIT-2026-08.md`
**هدف:** عامل‌های `structured-ai` به‌جای `grep` و `fs_read`، از درک معنایی کد استفاده کنند.

---

## ۰. یافتهٔ تعیین‌کننده: دو پروژه فلسفهٔ متضاد دارند

قبل از هر طراحی، این را اندازه گرفتم:

| معیار | `structured-ai` | `semantic-engine` |
|---|---|---|
| وابستگی runtime | **صفر** | ۸ (شامل ۲ ماژول native) |
| `node_modules` | **اصلاً وجود ندارد** | الزامی |
| زبان / build | JS خالص، بدون build | TypeScript، نیازمند `tsc` |
| اجرای تست | `node test/*.js` | `jest` |
| نصب | `git clone` و تمام | `npm install` + کامپایل native |

`structured-ai` عمداً **هیچ وابستگی‌ای ندارد** — همهٔ `require`ها builtin نودند (`fs`, `path`, `http`, `crypto`, `child_process`, `dns`, `net`, `events`, `readline`). این یک ویژگی طراحی است، نه اتفاق: مخزن را می‌شود clone کرد و بلافاصله اجرا کرد.

**نتیجهٔ مستقیم:** وارد کردن `semantic-engine` به‌عنوان یک `require` معمولی، این ویژگی را نابود می‌کند. `npm test` که امروز بدون نصب کار می‌کند، به نصب ۵۰۰+ پکیج و کامپایل ماژول native وابسته می‌شود.

پس معماری یکپارچه‌سازی از همین‌جا تعیین می‌شود: **جداسازی در سطح پروسه، نه در سطح ماژول.**

---

## ۱. سه گزینه و انتخاب

| گزینه | توضیح | حکم |
|---|---|---|
| **الف) import مستقیم** | `require('@aicoder/semantic-engine')` در `agent/tools/` | ❌ ویژگی صفر-وابستگی از بین می‌رود؛ build و ماژول native وارد CI می‌شود |
| **ب) فراخوانی CLI به‌ازای هر ابزار** | `spawn('semantic-engine', ['query', ...])` در هر تماس | ⚠ صفر-وابستگی حفظ می‌شود، اما هر تماس یک پروسهٔ جدید + بارگذاری مجدد ایندکس چندمگابایتی → صدها میلی‌ثانیه تأخیر |
| **ج) سایدکار پایدار + JSON-RPC روی stdio** | یک پروسهٔ `semantic-engine serve --stdio` که زنده می‌ماند | ✅ **انتخاب‌شده** |

### چرا گزینهٔ ج

1. **صفر-وابستگی حفظ می‌شود.** پروتکل MCP روی stdio چیزی جز JSON با هدر `Content-Length` نیست. یک کلاینت کامل در **~۱۵۰ خط جاوااسکریپت خالص** با `child_process` نوشته می‌شود. هیچ پکیجی لازم نیست.
2. **snapshot ایندکس در حافظه می‌ماند و با artifact watcher تازه می‌شود.** تماس دوم به بعد میلی‌ثانیه‌ای است؛ پس از تغییر فایل، snapshot جدید بدون قطع transport load می‌شود.
3. **با معماری موجود جور است.** `agent/tools/process.js` از قبل دقیقاً همین کار را می‌کند: پروسهٔ بلندعمر با session و خاموشی مدیریت‌شده.
4. **`semantic-engine` از قبل سرور MCP دارد.** فقط باید مصرف‌کننده‌اش را بنویسیم.
5. **اختیاری بودن رایگان است.** اگر باینری نصب نباشد، ابزارها با پیام راهنما تنزل می‌کنند و بقیهٔ سیستم دست‌نخورده کار می‌کند.

```
┌────────────────── structured-ai (صفر وابستگی) ───────────────────┐
│                                                                   │
│  agent/tools/code.js  ─────►  agent/lib/semantic.js               │
│  (۱۰ ابزار جدید)              (کلاینت JSON-RPC، ~۱۵۰ خط)         │
│                                        │                          │
└────────────────────────────────────────┼──────────────────────────┘
                                         │ stdio، Content-Length
                              ┌──────────▼───────────┐
                              │  semantic-engine     │
                              │  serve --stdio       │
                              │  (پروسهٔ جدا)        │
                              └──────────┬───────────┘
                                         │
                              .semantic-engine/project-index.json
```

---

## ۲. قراردادهایی که باید رعایت شوند

از مطالعهٔ کد `structured-ai` استخراج شد. نقض هرکدام یعنی شکست در startup یا تست.

### ۲.۱ اعتبارسنجی دوطرفهٔ رجیستری

`agent/agent.js` در راه‌اندازی بررسی می‌کند:

```
هر ابزار در tools.json  →  باید پیاده‌سازی داشته باشد
هر پیاده‌سازی           →  باید در tools.json اعلام شده باشد
هر ابزار در tool_groups →  باید در tools.json باشد
هر ابزار در policy      →  باید در tools.json باشد
```

پس افزودن ابزار یعنی **همزمان** ویرایش ۴ فایل. یکی جا بماند، runtime بالا نمی‌آید.

### ۲.۲ سقف حجم خروجی

```
MAX_TOOL_RESULT_CHARS       = 20,000   (هر رشته)
MAX_TOOL_RESULT_TOTAL_CHARS = 40,000   (کل نتیجه؛ آرایه‌ها کوتاه می‌شوند)
```

`project-index.json` چند مگابایت است. **هیچ ابزاری نباید ایندکس خام برگرداند.** همه باید صفحه‌بندی و خلاصه‌سازی کنند. `capResult` در غیر این صورت آرایه‌ها را بی‌صدا می‌بُرد و مدل نمی‌فهمد داده ناقص است.

### ۲.۳ قرارداد نام‌گذاری

ابزارها با پیشوند دامنه گروه می‌شوند: `fs_`, `git_`, `search_`, `process_`, `net_`, `memory_`, `plan_`, `skill_`, `archive_`.
→ ابزارهای جدید با **`code_`**.

### ۲.۴ الگوی session برای کارهای طولانی

`search_start` → `search_get` → `search_stop` الگوی موجود برای کاری است که ممکن است طول بکشد. ایندکس‌سازی کامل (که روی پروژهٔ بزرگ دقایقی طول می‌کشد) **باید** همین الگو را دنبال کند، نه یک تماس مسدودکننده که تایم‌اوت مدل را می‌سوزاند.

### ۲.۵ سبک کد

۴ فاصله، بنر کامنت با `|`، تابع داخلی camelCase و export با نام snake_case:

```js
module.exports = {
    code_find_symbol: codeFindSymbol
};
```

### ۲.۶ قرارداد مسیر خروجی

**تغییر قرارداد (نسخهٔ چندپروژه‌ای، ۲۰۲۶-۰۸-۲۶):** خروجی دیگر داخل workspace
نوشته نمی‌شود. مسیر canonical ایندکس حالا

```text
<dataRoot>/projects/<projectId>/project-index.json
```

است که `<dataRoot>` برابر `$XDG_DATA_HOME/semantic-engine` در لینوکس،
`~/Library/Application Support/SemanticEngine` در macOS و
`%LOCALAPPDATA%\SemanticEngine` در ویندوز است (با override از
`SEMANTIC_ENGINE_DATA_DIR`)، و `<projectId>` برابر
`prj-<slug(نام)>-<sha256(مسیر canonical)[0:8]>`.

سمت structured-ai این قرارداد در `agent/mcp/enginePaths.js` پیاده شده و
`agent/mcp/semantic.js` همان `projectId` را می‌سازد؛ تست دوطرفه
(`structured-ai/test/mcp/engine-paths.test.js` و
`semantic-engine/src/core/config/structuredAiContract.test.ts`) هم‌خوانی دو طرف
را نگه می‌دارد.

مسیرهای قدیمی `<workspace>/.semantic-engine/`، `<workspace>/.agent/semantic/` و
`<workspace>/semantic/` فقط برای خواندن ایندکس‌های موجود به‌عنوان fallback
پشتیبانی می‌شوند و هیچ اجرای جدیدی در آن‌ها خروجی نمی‌نویسد؛ در اولین اجرا به
data directory **کپی** می‌شوند و اصل فایل دست‌نخورده می‌ماند. برای رفتار قدیمی،
`--artifact-location in-root` یا `--out <dir>` همچنان کار می‌کند.

`--root` باید ریشهٔ واقعی پروژه باشد. اگر یک integration به‌اشتباه خودِ `.agent`
یا `.semantic-engine` را فرستاد، CLI آن را به workspace واقعی نرمال می‌کند تا
مسیرهایی مثل `.agent/.semantic-engine/` ساخته نشوند.

---

## ۳. سطح ابزار پیشنهادی

سطح ابزار **دو خانواده** دارد که منشأ متفاوتی دارند:

- **`code_*` پرس‌وجوی ایندکس** — از `project-index.json`؛ سریع و آفلاین. ورودی‌های MCP با watcher پیش‌فرض artifactها را reload می‌کنند؛ در اجرای `--no-watch` یا indexer متوقف، ممکن است کهنه باشد.
- **`code_*` زندهٔ LSP** — مستقیم از زبان‌سرور؛ **هرگز کهنه نیست**، نیازمند سرور گرم.

تفکیک این دو مهم است چون خصلت اعتمادپذیری‌شان فرق دارد و باید در توضیح ابزار به مدل گفته شود.

### ۳.۱ خانوادهٔ اول: پرس‌وجوی ایندکس

از ۱۲ ابزار `semantic-engine`، **۹ تا** وارد می‌شوند. دو تا عمداً حذف می‌شوند:

| ابزار semantic-engine | نام در structured-ai | تصمیم |
|---|---|---|
| `find_symbol` | `code_find_symbol` | ✅ |
| `semantic_search` | `code_search` | ✅ |
| `get_file_summary` | `code_file_summary` | ✅ |
| `get_dependencies` | `code_dependencies` | ✅ |
| `impact_analysis` | `code_impact` | ✅ |
| `find_tests` | `code_find_tests` | ✅ |
| `get_config_usage` | `code_config_usage` | ✅ |
| `assemble_context` | `code_context` | ✅ |
| — | `code_index_start` | ✅ جدید (چرخهٔ عمر) |
| — | `code_index_get` | ✅ جدید |
| — | `code_index_status` | ✅ جدید |
| `get_recent_changes` | — | ❌ **حذف** |
| `query_index` | — | ❌ **حذف** |

### چرا این دو حذف می‌شوند

**`get_recent_changes`** — دقیقاً همان کار `git_log` موجود را می‌کند (تکرار سطح ابزار، مدل را سردرگم می‌کند) و در ضمن همان مسیری است که آسیب‌پذیری تزریق فرمان `SE-SEC-01` از آن قابل بهره‌برداری بود.

**`query_index`** — اجرای SQL دلخواه روی یک مسیر فایل دلخواه. موتور سیاست `structured-ai` روی نام ابزار و آرگومان‌ها تصمیم می‌گیرد؛ **نمی‌تواند دربارهٔ محتوای یک رشتهٔ SQL استدلال کند**. این عملاً یک راه فرار از سیاست است (`SE-SEC-02` نشان داد فیلترش هم قابل دور زدن است). اگر روزی لازم شد، باید به‌صورت چند ابزار با پارامتر ساختاریافته درآید، نه SQL خام.

### ۳.۲ خانوادهٔ دوم: عملیات زندهٔ LSP

این خانواده در نسخهٔ اول این سند نبود و **مهم‌ترین افزودهٔ آن است**. مبنای فنی و اعداد در `LSP-ARCHITECTURE.md` بخش ۲.۶ آمده و همگی عملاً آزمایش شده‌اند.

| ابزار | منبع LSP | چرا برای عامل حیاتی است |
|---|---|---|
| `code_diagnostics` | `textDocument/diagnostic` | **۶ خطای نوع در ۳ میلی‌ثانیه، بدون اجرای `tsc`.** عامل بلافاصله بعد از ویرایش می‌فهمد چیزی را شکسته یا نه |
| `code_callers` | `callHierarchy/incomingCalls` | پاسخ **دقیق** به «چه کسی این تابع را صدا می‌زند» — از خود کامپایلر، نه از گراف حدسی |
| `code_rename` | `textDocument/rename` | تغییر نام امن در سطح workspace با `WorkspaceEdit`؛ جایگزین `fs_edit` که کورکورانه متن جایگزین می‌کند |
| `code_definition` | `textDocument/definition` | پرش به تعریف، همیشه به‌روز |
| `code_organize_imports` | `textDocument/codeAction` | تنها code action که در عمل کار می‌کند (بخش ۲.۷ سند LSP) |

**`code_diagnostics` بیشترین ارزش را دارد.** امروز تنها راه فهمیدن اینکه یک ویرایش کد را شکسته، `terminal_exec` با `tsc --noEmit` است — که هم کند است، هم در گروه `process` قرار دارد که `require_approval` می‌خواهد، هم خروجی خامش حجیم است. یک ابزار سه‌میلی‌ثانیه‌ای و بی‌خطر جایش را می‌گیرد.

**⚠ `code_rename` نوشتنی است.** بقیه فقط می‌خوانند. این یکی باید:
- در گروه جداگانهٔ `code.write` با `default_policy: require_approval` باشد،
- به‌صورت پیش‌فرض `dry_run: true` داشته باشد و فقط `WorkspaceEdit` را برگرداند تا مدل تغییرات را ببیند،
- اعمال واقعی با `apply: true` و از مسیر معمول تأیید انجام شود،
- ویرایش‌ها را از طریق همان لایه‌ای بنویسد که `fs_edit` می‌نویسد تا محدودسازی به workspace و انتساب تغییرات حفظ شود.

**نکتهٔ اعلام قابلیت:** طبق بخش ۲.۷ سند LSP، سرور ممکن است قابلیتی را اعلام کند که پیاده نکرده. لایهٔ کلاینت باید در شروع، قابلیت‌ها را واقعاً کاوش کند و **ابزارهای بی‌اثر را اصلاً به مدل اعلام نکند**. ابزاری که همیشه آرایهٔ خالی برمی‌گرداند، از نبودش بدتر است.

---

## ۴. مراحل اجرا

### فاز ۰ — پیش‌نیازها

| # | کار | جزئیات |
|---|---|---|
| INT-00 | استقلال کامل از VS Code | طبق `MIGRATION-STANDALONE.md`. تا وقتی `require('vscode')` وجود دارد، هیچ اجرایی بیرون از ادیتور ممکن نیست |
| INT-01 | CLI پایدار | `semantic-engine index` و `semantic-engine serve --stdio` کار کنند |
| INT-02 | قرارداد مسیر خروجی پیش‌فرض | **v2 (۲۰۲۶-۰۸-۲۶):** canonical: `<dataRoot>/projects/<projectId>/` با fallback خواندنی برای `<workspace>/.semantic-engine/` و `.agent/semantic/` (بخش ۲.۶)؛ `--artifact-location in-root` برای رفتار قدیمی |
| INT-03 | رفع مسدودکننده‌های امنیتی | `SE-SEC-01` و `SE-SEC-02` قبل از هر اتصالی بسته شوند |
| INT-04 | تصمیم دربارهٔ محل نصب | پیشنهاد بخش ۸ |
| INT-05 | اندپوینت Gateway به ازای هر پروژه | **جدید (۲۰۲۶-۰۸-۲۶):** `POST /mcp/<projectId>` روی یک Gateway مرکزی (پیش‌فرض پورت ۴۰۰۰). این URL در registry به‌عنوان `semanticEndpoint` همان پروژه ثبت می‌شود. پاسخ `tools/call` علاوه بر `content`، یک `structuredContent` با `projectId` و `indexGeneration` دارد و کلاینت با تغییر `indexGeneration` کش خود را دور می‌ریزد. |

### فاز ۱ — کلاینت صفر-وابستگی

**فایل جدید: `agent/lib/semantic.js`** (~۲۵۰ خط)

```js
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const settings = require("../lib/storage");
const { WORKSPACE_ROOT } = require("../lib/workspace");


/*
|--------------------------------------------------------------------------
| Semantic Engine Sidecar
|--------------------------------------------------------------------------
|
| The semantic index lives in a separate process so this runtime keeps its
| zero-dependency property. Communication is JSON-RPC over stdio, framed
| with Content-Length headers, which needs no library to speak.
|
| The sidecar is started lazily on the first code_* call and reused for the
| rest of the run. If the binary is missing the tools degrade to a hint
| instead of failing the run.
|--------------------------------------------------------------------------
*/


let sidecar = null;


function binaryPath() {

    const configured = settings.get("SEMANTIC_ENGINE_BIN");

    if (configured) {
        return configured;
    }

    /* نصب محلی در کنار مخزن، سپس PATH */

    const local = path.join(
        __dirname, "..", "..", "semantic-engine", "bin", "semantic-engine.js"
    );

    return fs.existsSync(local) ? local : "semantic-engine";
}


function isAvailable() { /* … بررسی بدون spawn */ }


async function start() {

    const child = spawn(
        process.execPath,
        [binaryPath(), "serve", "--stdio", "--root", WORKSPACE_ROOT],
        { stdio: ["pipe", "pipe", "pipe"] }
    );

    /*
    | stderr سایدکار هرگز نباید با stdout قاطی شود: جریان stdout
    | پروتکل است و یک بایت اضافه آن را خراب می‌کند.
    */

    child.stderr.on("data", data => recordDiagnostic(data));

    // …
}


/* فریم‌بندی Content-Length — کل پروتکل همین است */

function encode(message) {

    const body = JSON.stringify(message);

    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}


async function call(toolName, args, timeoutMs) { /* … */ }


function shutdown() { /* shutdown → exit → SIGKILL بعد از ۵ ثانیه */ }


module.exports = {
    call,
    isAvailable,
    shutdown,
    status
};
```

نکات پیاده‌سازی:
- **timeout روی هر تماس** (پیش‌فرض ۱۵ ثانیه) و kill سایدکار در صورت گیر کردن.
- **بافر ورودی** باید هدرها را درست جدا کند؛ یک پیام ممکن است در چند chunk برسد.
- **`shutdown()` باید به `agent/tools/index.js → shutdown()` وصل شود** (همان‌جا که `processTools.shutdownAll()` صدا زده می‌شود) وگرنه پروسه پس از پایان run زنده می‌ماند.
- **`startRunScope()`** باید وضعیت سایدکار را ریست کند تا ایندکس بین دو run نشتی نکند.

### فاز ۲ — پیاده‌سازی ابزارها

**فایل جدید: `agent/tools/code.js`**

هر ابزار سه مسئولیت دارد: بررسی در دسترس بودن، فراخوانی سایدکار، **فشرده‌سازی خروجی برای سقف ۴۰K**.

```js
async function codeFindSymbol(args) {

    const ready = await ensureIndex();

    if (!ready.ok) {
        return ready;              /* راهنمای عملی، نه throw */
    }

    const result = await semantic.call("find_symbol", {
        name: args.name,
        kind: args.kind,
        limit: Math.min(args.limit || 20, 50)
    });

    /*
    | خروجی خام موتور شامل excerpt و متادیتاست. فقط چیزی که مدل
    | برای تصمیم بعدی لازم دارد برمی‌گردد.
    */

    return {
        query: args.name,
        total: result.items.length,
        symbols: result.items.map(item => ({
            name: item.name,
            kind: item.kind,
            path: item.path,
            line: item.line,
            signature: truncate(item.excerpt, 200)
        }))
    };
}
```

قاعدهٔ سختگیرانه: **هیچ ابزاری نباید بیش از ۵۰ آیتم یا ۲۰۰ کاراکتر به‌ازای هر آیتم برگرداند.** اگر بیشتر بود، `total` را گزارش کند و بگوید چطور محدودتر بپرسند.

### فاز ۳ — ثبت در رجیستری (۴ فایل، همزمان)

**۳.۱ `agent/registry/tools.json`** — ۱۱ ورودی جدید با فرمت OpenAI function:

```jsonc
{
  "type": "function",
  "function": {
    "name": "code_find_symbol",
    "description": "Find a symbol (class, function, method, interface) by name across the indexed project. Returns declaration location and signature. Prefer this over search_start when looking for a definition.",
    "parameters": {
      "type": "object",
      "properties": {
        "name":  { "type": "string",  "description": "Symbol name; partial match supported." },
        "kind":  { "type": "string",  "description": "Optional filter: class, function, method, interface." },
        "limit": { "type": "integer", "description": "Maximum results. Defaults to 20, capped at 50." }
      },
      "required": ["name"],
      "additionalProperties": false
    }
  }
}
```

> در توضیح هر ابزار صریح بنویسید **کِی به‌جای ابزار موجود استفاده شود**. بدون این، مدل به عادت قبلی `search_start` می‌ماند و ابزارهای جدید بلااستفاده می‌مانند.

**۳.۲ `agent/registry/tool_groups.json`** — دو گروه جدید:

```jsonc
"code.query": {
  "description": "Query the semantic index of the project: symbols, dependencies, impact, tests.",
  "sensitive": false,
  "default_policy": "allow",
  "tools": ["code_find_symbol", "code_search", "code_file_summary",
            "code_dependencies", "code_impact", "code_find_tests",
            "code_config_usage", "code_context", "code_index_status"]
},
"code.index": {
  "description": "Build or refresh the semantic index. Reads the whole workspace and writes under .semantic-engine/.",
  "sensitive": false,
  "default_policy": "allow",
  "note": "Expensive: a full index reads every source file.",
  "tools": ["code_index_start", "code_index_get"]
},
"code.live": {
  "description": "Ask the language server directly. Always reflects the current file content, never a stale index.",
  "sensitive": false,
  "default_policy": "allow",
  "note": "Requires a running language server; falls back with a hint when unavailable.",
  "tools": ["code_diagnostics", "code_callers", "code_definition", "code_organize_imports"]
},
"code.write": {
  "description": "Semantic refactoring that modifies files.",
  "destructive": true,
  "sensitive": true,
  "default_policy": "require_approval",
  "tools": ["code_rename"]
}
```

**۳.۳ `agent/registry/policy.json`** — افزودن `code.query` به قانون موجود «بازرسی آزاد است»:

```jsonc
{
  "id": "read_only_filesystem_is_free",
  "groups": ["filesystem.read", "search", "introspection", "code.query", "code.live"],
  "action": "allow",
  "reason": "inspection only"
}
```

و یک قانون جدید برای بازآرایی نوشتنی:

```jsonc
{
  "id": "semantic_refactor",
  "groups": ["code.write"],
  "action": "require_approval",
  "reason": "rewrites source files across the workspace"
}
```

`code.index` نوشتن دارد ولی فقط داخل `.semantic-engine/` — `allow` قابل دفاع است، اما اگر می‌خواهید محافظه‌کار باشید `require_approval` بگذارید.

**۳.۴ `agent/tools/index.js`** — ثبت پیاده‌سازی‌ها:

```js
const code = require("./code");
// …
const IMPLEMENTATIONS = {
    // …
    ...publicTools(code),
};
```

و در `shutdown()`:

```js
function shutdown() {
    processTools.shutdownAll();
    semantic.shutdown();          /* ← اضافه شود */
}
```

### فاز ۴ — اتصال به عامل‌ها و مهارت‌ها

**۴.۱ `agent/registry/agents.json` — عامل `code_analysis`**

این عامل امروز فقط ابزار متنی دارد (`fs_read`, `search_start`, `terminal_exec`). ابزارهای معنایی دقیقاً برای اوست:

```jsonc
"tools": [
  "fs_list", "fs_tree", "fs_read", "fs_read_many", "fs_stat", "fs_info",
  "search_start", "search_get", "search_stop", "terminal_exec",
  "code_find_symbol", "code_search", "code_file_summary",
  "code_dependencies", "code_impact", "code_find_tests",
  "code_context", "code_index_status",
  "memory_get", "archive_search", "archive_get", "skill_get", "skill_read"
]
```

و در `output_contract` اضافه شود:

```
"Prefer code_* tools over text search when the question is about symbols,
 dependencies, or the impact of a change; fall back to search_start only
 when the index is unavailable or the target is not code."
```

`main_agent` که `"tools": "*"` دارد، خودکار همه را می‌گیرد.

**۴.۲ `agent/registry/skills.json` — مهارت `codebase_analysis`**

دستورالعمل فعلی می‌گوید «از `fs_tree` برای ساختار و `search_start` برای یافتن symbol استفاده کن». باید به‌روز شود:

```jsonc
"instructions": [
  "Check code_index_status first; if the index is missing or stale, start it with code_index_start.",
  "Use code_find_symbol to locate a definition, not text search.",
  "Use code_impact before changing a shared symbol, to see what breaks.",
  "Use code_find_tests to locate the tests that cover what you are changing.",
  "Fall back to search_start for text that is not a code symbol (comments, config values, strings).",
  "Inspect project structure before making significant changes.",
  "Minimize unrelated changes."
]
```

و لیست `tools` همان مهارت هم به‌روز شود.

### فاز ۵ — چرخهٔ عمر ایندکس

سه سؤال باید پاسخ داشته باشند: کِی ساخته شود؟ چطور بفهمیم کهنه است؟ چه کسی تازه‌اش می‌کند؟

**۵.۱ تشخیص کهنگی** — بدون خواندن کل ایندکس:

```js
function indexStaleness() {

    const meta = readIndexHeader();          /* فقط چند فیلد اول */

    if (!meta) {
        return { state: "missing" };
    }

    const head = currentGitCommit();

    if (meta.git && meta.git.commit !== head) {
        return { state: "stale", reason: "commit changed" };
    }

    if (repositoryIsDirty()) {
        return { state: "partial", reason: "uncommitted changes" };
    }

    return { state: "fresh" };
}
```

`code_index_status` دقیقاً همین را برمی‌گرداند، به‌علاوهٔ تعداد فایل و symbol و زمان ساخت.

**۵.۲ سیاست ساخت** — سه حالت با تنظیم `SEMANTIC_INDEX_MODE`:

| حالت | رفتار | مناسب برای |
|---|---|---|
| `off` | هیچ ابزار `code_*` فعال نیست | پروژه‌های غیرکدی |
| `lazy` *(پیش‌فرض)* | اولین تماس `code_*`، اگر ایندکس نبود، پیام راهنما با دستور ساخت می‌دهد | اکثر موارد |
| `auto` | اولین تماس، ایندکس را در پس‌زمینه شروع می‌کند و `status: "indexing"` برمی‌گرداند | استفادهٔ مکرر |

**عمداً «ساخت خودکار مسدودکننده» را پیشنهاد نمی‌کنم.** یک ایندکس کامل روی مخزن بزرگ دقایقی طول می‌کشد؛ اگر پشت اولین تماس ابزار مخفی شود، مدل تایم‌اوت می‌خورد و علتش را نمی‌فهمد. الگوی session (`code_index_start` → `code_index_get`) شفاف است و با `search_*` هم‌خانواده.

**۵.۳ تازه‌سازی خودکار با hook** — در `.agent/project.json` پروژه:

```jsonc
{
  "settings": { "HOOKS_ENABLED": true },
  "hooks": {
    "after_task": [
      {
        "id": "reindex",
        "type": "tool",
        "tool": "code_index_start",
        "when": "files_changed",
        "arguments": { "incremental": true },
        "on_failure": "report"
      }
    ]
  }
}
```

نوع `tool` از قبل پشتیبانی می‌شود؛ چیزی در موتور hook لازم نیست.

**۵.۴ برندهٔ بزرگ: hook تأیید مبتنی بر diagnostics**

این بهترین کاربرد کل یکپارچه‌سازی است. امروز الگوی توصیه‌شدهٔ README برای تأیید بعد از کار، یک hook از نوع `agent` است که عامل `testing` را صدا می‌زند تا تست و type-check اجرا کند — یعنی یک فراخوانی کامل مدل به‌علاوهٔ `terminal_exec`.

با `code_diagnostics` این کار **بدون هیچ فراخوانی مدل و در چند میلی‌ثانیه** انجام می‌شود:

```jsonc
{
  "settings": { "HOOKS_ENABLED": true },
  "hooks": {
    "after_task": [
      {
        "id": "typecheck",
        "type": "tool",
        "tool": "code_diagnostics",
        "when": "files_changed",
        "arguments": { "paths": "${files_changed}", "severity": "error" },
        "on_failure": "stop"
      },
      {
        "id": "verify",
        "type": "agent",
        "agent": "testing",
        "when": "hooks.typecheck.ok",
        "task": "Run tests for ${files_changed}.",
        "on_failure": "stop"
      },
      {
        "id": "record",
        "type": "git_commit",
        "when": "hooks.typecheck.ok && hooks.verify.ok",
        "message": "${task}",
        "paths": "${files_changed}"
      }
    ]
  }
}
```

سه برتری نسبت به وضع فعلی:

1. **دروازهٔ ارزان قبل از دروازهٔ گران.** اگر کد اصلاً کامپایل نمی‌شود، اجرای تست بی‌معنی است. `typecheck` در میلی‌ثانیه جلوی آن را می‌گیرد و یک فراخوانی مدل صرفه‌جویی می‌شود.
2. **بدون نیاز به تأیید.** `code_diagnostics` فقط می‌خواند و در گروه `code.live` با سیاست `allow` است؛ در حالی که `terminal_exec` در گروه `process` با `require_approval` قرار دارد.
3. **خروجی ساختاریافته.** به‌جای خروجی خام `tsc` که باید تجزیه شود، آرایه‌ای از `{severity, code, path, line, message}` می‌آید که مستقیم در `${hooks.typecheck.summary}` قابل استفاده است.

`code_diagnostics` باید آرگومان `paths` را بپذیرد تا فقط فایل‌های تغییرکرده بررسی شوند — نه کل پروژه.

### فاز ۶ — تست

`structured-ai` تست بدون فریم‌ورک می‌نویسد (`node test/x.test.js` با `assert`). همان سبک را نگه دارید.

**فایل جدید: `test/semantic.test.js`**

```js
/*
| سایدکار ساختگی: یک اسکریپت نود که پروتکل را می‌فهمد و پاسخ ثابت
| می‌دهد. اینطور تست‌ها بدون نصب semantic-engine اجرا می‌شوند و
| ویژگی «تست بدون npm install» حفظ می‌شود.
*/
```

موارد آزمون:

| # | آزمون |
|---|---|
| ۱ | نبود باینری → ابزار پیام راهنما می‌دهد، run را نمی‌شکند |
| ۲ | فریم‌بندی `Content-Length` در پیام‌های چندتکه درست کار کند |
| ۳ | timeout سایدکار → خطای تمیز + kill پروسه |
| ۴ | کرش سایدکار وسط تماس → خطای تمیز، بدون promise معلق |
| ۵ | خروجی بزرگ → قبل از `capResult` توسط خود ابزار محدود شود |
| ۶ | `shutdown()` هیچ پروسه‌ای زنده نگذارد |
| ۷ | `code_index_status` روی ایندکس ناموجود → `state: "missing"` |
| ۸ | stderr سایدکار به stdout نشت نکند |

**به‌روزرسانی `test/tools.test.js`:** آزمون سازگاری رجیستری (هر ابزار اعلام‌شده پیاده‌سازی دارد و برعکس) باید ابزارهای جدید را هم پوشش دهد — این تست خودکار همان چیزی است که از خطای فاز ۳ جلوگیری می‌کند.

**به‌روزرسانی `package.json`:**

```json
"test": "… && node test/semantic.test.js && …",
"test:semantic": "node test/semantic.test.js"
```

و `ci/github-actions-test.yml` یک step جدید.

### فاز ۷ — تنظیمات و مستندات

**۷.۱ کلیدهای جدید در `agent/lib/storage.js`:**

| کلید | پیش‌فرض | توضیح |
|---|---|---|
| `SEMANTIC_ENABLED` | `true` | کلید اصلی خاموش/روشن |
| `SEMANTIC_ENGINE_BIN` | `""` | مسیر باینری؛ خالی = تشخیص خودکار |
| `SEMANTIC_INDEX_MODE` | `"lazy"` | `off` \| `lazy` \| `auto` |
| `SEMANTIC_CALL_TIMEOUT_MS` | `15000` | سقف هر تماس |
| `SEMANTIC_INDEX_TIMEOUT_MS` | `600000` | سقف ساخت کامل |
| `SEMANTIC_MAX_ITEMS` | `50` | سقف آیتم در خروجی ابزار |

**۷.۲ README:** یک بخش «Semantic code index» زیر `## Tool catalog` — چه ابزارهایی، چه زمانی به‌جای `search_*`، و اینکه اختیاری است.

---

## ۵. ترتیب و تخمین

```
INT-00..04 (پیش‌نیاز)
    │
    ├─► فاز ۱: کلاینت سایدکار ────► فاز ۲: ابزارها ──┐
    │                                                  ├─► فاز ۵: چرخهٔ عمر
    └─► فاز ۳: رجیستری ───────────► فاز ۴: عامل‌ها ──┘
                                                       │
                                            فاز ۶: تست ─┴─► فاز ۷: تنظیمات
```

| فاز | کار | تخمین |
|---|---|---|
| ۱ | کلاینت JSON-RPC صفر-وابستگی | ۲ روز |
| ۲ | ۱۱ ابزار پرس‌وجوی ایندکس + فشرده‌سازی خروجی | ۲ روز |
| ۲ب | **۵ ابزار زندهٔ LSP** (نیازمند LSP-14..16) | **۱٫۵ روز** |
| ۳ | رجیستری (۴ فایل هماهنگ) | ۴ ساعت |
| ۴ | عامل‌ها و مهارت‌ها | ۳ ساعت |
| ۵ | چرخهٔ عمر ایندکس + کهنگی | ۱ روز |
| ۶ | تست با سایدکار ساختگی | ۱٫۵ روز |
| ۷ | تنظیمات و README | ۴ ساعت |
| | **جمع (بدون پیش‌نیازها)** | **~۹٫۵ روز** |

پیش‌نیازها (`INT-00`) خودشان ۹ تا ۲۲ روزند — نگاه کنید به `MIGRATION-STANDALONE.md`.

### مسیر تحویل تدریجی

| گام | محتوا | ارزش قابل مشاهده |
|---|---|---|
| **A** | فاز ۱ + ۳ ابزار (`code_find_symbol`, `code_file_summary`, `code_index_status`) + رجیستری | عامل می‌تواند تعریف یک symbol را بدون grep پیدا کند |
| **B** | `code_diagnostics` + `code_callers` + hook تأیید (بخش ۵.۴) | **بیشترین اثر عملی:** عامل بلافاصله می‌فهمد ویرایشش کد را شکسته، بدون اجرای `tsc` و بدون تأیید |
| **C** | بقیهٔ ابزارها + فاز ۴ | `code_analysis` واقعاً معنایی می‌شود |
| **D** | `code_rename` + فاز ۵ + ۶ + ۷ | آمادهٔ استفادهٔ روزمره |

---

## ۶. ریسک‌ها

| ریسک | اثر | کاهش |
|---|---|---|
| **از دست رفتن صفر-وابستگی** | نصب و CI پیچیده می‌شود | جداسازی پروسه‌ای؛ کلاینت دست‌ساز؛ `semantic-engine` هرگز در `dependencies` نیاید |
| **ایندکس کهنه = پاسخ غلط با اطمینان بالا** | بدترین حالت: مدل با اعتماد اشتباه می‌گوید | هر خروجی ابزار فیلد `index_age` و `index_state` داشته باشد؛ روی `stale` هشدار در متن نتیجه |
| **پروسهٔ یتیم** | سایدکار بعد از run زنده می‌ماند | اتصال به `shutdown()` موجود + تست شمارهٔ ۶ |
| **انفجار حجم خروجی** | `capResult` بی‌صدا می‌بُرد | سقف در خود ابزار + گزارش `total` در برابر `returned` |
| **مدل ابزار جدید را نادیده می‌گیرد** | سرمایه‌گذاری بی‌نتیجه | `description` صریح «به‌جای X استفاده کن» + به‌روزرسانی مهارت + `output_contract` |
| **ایندکس‌سازی، run را کند کند** | تجربهٔ بد | پیش‌فرض `lazy`؛ الگوی session؛ هرگز ساخت مسدودکنندهٔ خودکار |
| **مسیر artifact اشتباه شود** | MCP به ایندکس دیگری نگاه می‌کند یا `.agent/.semantic-engine/` ساخته می‌شود | helper مرکزی مسیرها، fallback legacy و تست نرمال‌سازی root |
| **دو منبع حقیقت برای «تغییرات اخیر»** | مدل سردرگم | `get_recent_changes` وارد نشود؛ `git_log` تنها منبع بماند |
| **اختلاف ایندکس و LSP** | دو ابزار دو جواب متفاوت می‌دهند و مدل نمی‌داند کدام درست است | در توضیح هر ابزار صریح گفته شود: `code_*` ایندکسی «ممکن است کهنه باشد»، `code_*` زنده «همیشه به‌روز». روی اختلاف، LSP معتبر است |
| **ابزاری که همیشه خالی برمی‌گرداند** | مدل اعتمادش را به کل خانواده از دست می‌دهد | کاوش واقعی قابلیت در startup (LSP-15)؛ ابزار بی‌اثر اصلاً اعلام نشود |

---

## ۷. چک‌لیست پذیرش

- [ ] `npm test` در `structured-ai` **بدون `npm install`** همچنان سبز باشد
- [ ] `node -e "require('./agent/tools')"` هیچ پکیج خارجی نخواهد
- [ ] با نبود `semantic-engine`، همهٔ ابزارهای `code_*` پیام راهنما بدهند و هیچ run شکست نخورد
- [ ] راه‌اندازی runtime با رجیستری جدید بدون خطای اعتبارسنجی بالا بیاید
- [ ] هیچ خروجی ابزاری از ۴۰٬۰۰۰ کاراکتر رد نشود (تست با پروژهٔ بزرگ)
- [ ] بعد از پایان run، `ps` هیچ پروسهٔ `semantic-engine` نشان ندهد
- [ ] بازسازی ایندکس در `git status` ظاهر نشود
- [ ] `code_analysis` در یک اجرای واقعی حداقل یک ابزار `code_*` استفاده کند
- [ ] `SEMANTIC_ENABLED=false` هیچ پروسه‌ای spawn نکند
- [ ] `code_diagnostics` روی فایلی با خطای نوع، همان خطاها را با شماره خط درست برگرداند
- [ ] `code_rename` با `dry_run` پیش‌فرض هیچ فایلی را تغییر ندهد
- [ ] ابزاری که سرور پیاده‌اش نکرده، در `tools/list` ظاهر نشود

---

## ۸. تصمیمی که باید بگیرید: `semantic-engine` کجا زندگی کند؟

سه گزینه، هیچ‌کدام بد نیست ولی باید یکی انتخاب شود:

| گزینه | مزیت | هزینه |
|---|---|---|
| **الف) همین مخزن، پکیج جدا** *(وضع فعلی)* | تغییرات اتمیک؛ نسخه‌ها همیشه سازگار | مخزن دو فرهنگ متفاوت دارد؛ CI باید دو مسیر داشته باشد |
| **ب) مخزن جدا + npm** | مرز تمیز؛ چرخهٔ انتشار مستقل | هماهنگی نسخه؛ برای توسعه `npm link` لازم |
| **ج) همین مخزن + `npm workspaces`** | ابزار استاندارد | ریشه صاحب `node_modules` می‌شود ← **صفر-وابستگی ظاهراً نقض می‌شود** |

**پیشنهاد: الف در کوتاه‌مدت، ب وقتی پایدار شد.**
با گزینهٔ الف، ریشه دست‌نخورده می‌ماند (`node_modules` فقط داخل `semantic-engine/`)، و کلاینت سایدکار با تشخیص خودکار مسیر محلی کار می‌کند. گزینهٔ ج را توصیه نمی‌کنم چون workspaces، `node_modules` را به ریشه می‌آورد و ویژگی‌ای که کل این طراحی برای حفظش شکل گرفته را از بین می‌برد.

---

## ۹. جمع‌بندی

یکپارچه‌سازی از نظر فنی ساده است — سخت‌ترین بخشش یک کلاینت JSON-RPC ۱۵۰ خطی است. چیزی که این کار را ظریف می‌کند، **حفظ چیزی است که `structured-ai` را خاص می‌کند**: مخزنی که clone می‌شود و بدون نصب اجرا می‌شود.

سه اصل که اگر رعایت شوند بقیه‌اش مکانیکی است:

1. **مرز پروسه، نه مرز ماژول.** `semantic-engine` هرگز نباید در `dependencies` ریشه بیاید. جداسازی پروسه‌ای هم صفر-وابستگی را حفظ می‌کند، هم ماژول‌های native و build را از CI اصلی دور نگه می‌دارد، هم کرش سایدکار را از کرش runtime جدا می‌کند.

2. **ایندکس یک منبع حقیقت است که می‌تواند دروغ بگوید.** یک ایندکس کهنه بدتر از نداشتن ایندکس است، چون مدل با اطمینان کامل جواب اشتباه می‌دهد. کهنگی باید در **هر** خروجی ابزار قابل مشاهده باشد، نه در یک ابزار جداگانه که مدل ممکن است صدا نزند.

3. **ابزار جدید بدون تغییر دستورالعمل، بلااستفاده می‌ماند.** ثبت ابزار در رجیستری کار را تمام نمی‌کند. تا وقتی `codebase_analysis` می‌گوید «از `search_start` برای یافتن symbol استفاده کن»، مدل همان کار را می‌کند. فاز ۴ کوچک‌ترین فاز است و بیشترین اثر را دارد.

4. **بازخورد زنده از ایندکس ایستا ارزشمندتر است.** ایندکس به سؤال «این پروژه چه شکلی است» جواب می‌دهد؛ LSP به سؤال «کاری که همین الان کردم درست بود» — و برای یک عامل که کد می‌نویسد، سؤال دوم مهم‌تر است. `code_diagnostics` با سه میلی‌ثانیه پاسخ، ارزان‌ترین و مؤثرترین قطعهٔ کل این یکپارچه‌سازی است.
