# Semantic Engine Code Intelligence — Execution Plan (Final)

**Target repository:** `legionir/semantic-engine-structured-ai`\
**Target package:** `semantic-engine/`\
**Execution order:** Phase 0 → Phase 1 → (Phase 2 ∥ Spike-S) → Phase 3 → Phase 4 (مشروط)\
**Status:** Living plan؛ specification و prompt شواهد پیاده‌سازی نیستند.\
**نسخه‌ی مرجع specها:** `codeintel-v1/v2/v3-spec.fa.md` و `codeintel-v1/v2/v3-prompt.en.md` (در متن: «specها»).

---

## 0. رابطه‌ی این پلن با specها

- specها و promptها **TARGET** هستند؛ این پلن ترتیب، gate و شواهد لازم برای رساندن آن‌ها به repo موجود را تعیین می‌کند.
- specها فرض کرده‌اند پروژه‌ی از صفر ساخته شود (کتابخانه + MCP + CLI مستقل). این repo از قبل `ProjectIndex`، `ProjectRegistry`، `IncrementalEngine`، `AiToolRegistry`، MCP و Gateway دارد. بنابراین:
  - **هیچ CodeIntel مستقل یا source of truth دوم ساخته نمی‌شود.**
  - قراردادهای specها (Range، SymbolKey، Handle، envelope و...) به‌صورت **additive** روی قراردادهای موجود می‌نشینند؛ اگر با موجود تعارض داشتند، نگاشت (mapping) ساخته می‌شود، نه جایگزینی.
  - پیش از هر اجرا، Preamble پیوست D به promptهای انگلیسی اضافه می‌شود.
- ستون «معادل موجود» در Appendix A فقط در گام 0.9 و با شواهد repo پر می‌شود؛ تا آن زمان `UNKNOWN` است.

---

## 1. سیاست شواهد

### 1.1 نردبان وضعیت

- `TARGET`: در spec لازم است، در repo اثبات نشده.
- `IMPLEMENTED`: کد نوشته شده؛ به‌تنهایی pass نیست.
- `TESTED`: تست اجرا و خروجی ثبت شده.
- `LOCALLY VERIFIED`: command واقعی با revision، environment، output و exit code ثبت شده.
- `MCP/GATEWAY VERIFIED`: مسیر واقعی transport/lifecycle اجرا و ثبت شده.
- `BLOCKED / UNKNOWN`: evidence یا dependency در دسترس نیست.

وجود type، schema، migration، test file، README یا prompt هیچ‌وقت «تکمیل» حساب نمی‌شود.

### 1.2 معنی دقیق نتیجه‌ی Gate

| نتیجه

 | شرط

 |
| --- | --- |
| 🟢 ACCEPTED

 | همه‌ی معیارهای **مسدودکننده** با وضعیت لازم (بند 1.4) پاس شده‌اند

 |
| 🟡 CONDITIONAL

 | همه‌ی معیارهای مسدودکننده پاس؛ فقط gapهای **غیرمسدودکننده** باز، هرکدام با صاحب، دلیل و تاریخ بازبینی

 |
| 🔴 BLOCKED

 | حتی یک معیار مسدودکننده شکست خورده یا evidence ندارد

 |

فاز بعد روی 🟢 یا 🟡 شروع می‌شود، هرگز روی 🔴. تقسیم یا تغییر نام فاز برای دور زدن 🔴 ممنوع است.

### 1.3 طبقه‌بندی gap

**مسدودکننده** (نمی‌توان «پذیرفت»؛ فقط با رفع، یا با حذف قابلیت از claim):

- هر تفاوت معنایی بین full و incremental در symbol، edge، range، diagnostic یا vector؛
- ماندن stale artifact بعد از حذف فایل؛
- خطای واحد در Range (UTF-16/byte)؛
- نوشتن خارج از root، خواندن فایل denylist، یا commit نیمه‌کاره‌ی قابل‌مشاهده؛
- ادعای MCP/Gateway بدون اجرای واقعی؛
- corruption در fuzz یا crash-injection.

**غیرمسدودکننده** (با ثبت قابل‌پذیرش):

- زبان `unavailable` که صریحاً همان‌طور اعلام شده؛
- عملکرد پایین‌تر از هدف با علت مستند و اندازه‌گیری‌شده؛
- adapter اختیاری بدون پوشش؛
- gap مستندات؛
- مسیر Gateway برای قابلیتی که پشت `experimental` خاموش است.

### 1.4 سطح شواهد لازم برای 🟢

معیار عملکردی/داده‌ای → `LOCALLY VERIFIED`. معیاری که به tool اشاره دارد → `MCP VERIFIED`. معیار lifecycle/worker → `GATEWAY VERIFIED`.

### 1.5 آستانه‌ها از پیش ثبت می‌شوند

همه‌ی آستانه‌ها (Appendix B) قبل از اولین اندازه‌گیری در `docs/GATES.md` ثبت می‌شوند. تغییر آستانه بعد از دیدن نتیجه فقط با ورودی تاریخ‌دار در `DECISIONS.md` (دلیل + مالک) مجاز است.

### 1.6 پذیرش gap

فقط مالک پروژه، با ورودی تاریخ‌دار در `DECISIONS.md` (دلیل، دامنه، تاریخ بازبینی). Gap مسدودکننده پذیرفتنی نیست.

### 1.7 هزینه‌ی evidence

یک اسکریپت `scripts/evidence-capture` (revision، env، command، exit code، hash artifactها، timestamp) خروجی را جمع می‌کند. یک **bundle در پایان هر فاز** کافی است؛ ثبت جداگانه‌ی هر گام لازم نیست مگر گام مسدودکننده.

### 1.8 محدودیت‌ها

فقط fixture، workspace و credential آزمایشی. production data، credential واقعی و migration مخرب ممنوع.

---

## 2. قواعد وابستگی، توقف و زمان‌بندی

1. Phase 1 بعد از Phase 0 (🟢/🟡)؛ Phase 2 بعد از Phase 1 (🟢/🟡).
2. **Spike-S** (بررسی v3) می‌تواند با Phase 2 موازی اجرا شود، ولی روی branch جدا، بدون migration در main؛ نتیجه‌اش gate نیست، ورودی تصمیم Phase 3 است.
3. Phase 3 فقط بعد از Gate v2 و نتیجه‌ی Spike-S.
4. Phase 4 فقط بعد از Gate Phase 3، و فقط برای قابلیت‌هایی که gate خودشان را داشته باشند.
5. هر فاز: implementation، focused tests، build/type validation، evidence bundle.
6. تغییرات additive، کوچک، قابل rollback و adapter-محور؛ rewrite ممنوع.
7. هر ادعای runtime/performance/security/crash-recovery/MCP/Gateway فقط با اجرای واقعی.
8. **Timebox** (پیشنهاد، مالک نهایی می‌کند): Phase 0 حداکثر ۵ روز کاری. اگر تمام نشد، به گام‌های مسدودکننده (0.1–0.3، 0.5، 0.6، 0.8) کاهش می‌یابد و بقیه به‌صورت gap ثبت می‌شوند.

### برآورد اندازه (تخمینی، پس از Phase 0 بازکالیبره شود)

| فاز

 | اندازه

 |
| --- | --- |
| Phase 0

 | M

 |
| Phase 1

 | L

 |
| Phase 2

 | L

 |
| Spike-S

 | S/M

 |
| Phase 3

 | M/L

 |
| Phase 4

 | هر قابلیت جدا؛ کل XL

 |

---

## Phase 0 — Baseline، قراردادها، Traceability

**هدف:** baseline قابل‌تکرار، قراردادهای قفل‌شده و نگاشت specها به repo، پیش از هر قابلیت.\
**وضعیت اولیه:** 🔴 NOT STARTED\
**وضعیت اجرا:** 🟡 PARTIAL؛ Gate فعلی: 🔴 BLOCKED به دلیل نبود checkout و dependency environment قابل اجرا.\
**وابستگی:** دسترسی به checkout، dependency tree و محیط اجرا.

### گام‌ها

0.1. ثبت branch، revision دقیق، نسخه‌ی package، Node/npm، OS، hash lockfile و manifest. **وضعیت: 🟡 ناقص/تأییدنشده** — branch/revision/package/manifest/lockfile ثبت شده؛ اجرای محیط repository هنوز ممکن نیست.

0.2. ثبت scriptهای واقعی و اجرای مستقل: build، typecheck، lint، test، `test:gate`، validate، snapshot، benchmark. برای هر کدام: command کامل، خروجی، exit code، timestamp. command ناموجود = `UNKNOWN`، نه pass.

0.3. ایجاد/به‌روزرسانی `docs/DECISIONS.md`، `docs/CONTRACTS.md` و `docs/GATES.md` (آستانه‌ها، Appendix B). **وضعیت: 🟡 ناقص/تأییدنشده** — نسخه‌ی اولیه در شواهد Phase 0 آماده است؛ commit repository و بازبینی مستقیم هنوز باقی است.

0.4. بازاعتبارسنجی مستقیم boundaryها: `ProjectIndex` schema/types، `ProjectPaths`/`ProjectRegistry`، scanner، parser/extractor، `IncrementalEngine`، `OutputWriter`، `ProjectIndexReader`، `AiToolRegistry`، MCP server، Gateway/worker lifecycle، filesystem port، تست‌ها.

0.5. **تثبیت قراردادها** (additive روی موجود، تصمیم‌ها در `CONTRACTS.md`):

- **Range:** offset مبنا = UTF-16 code unit روی متن decode‌شده (بدون BOM، EOL اصلی)؛ Position فقط از `LineIndex` و offset (ستون parser معتبر نیست)؛ end-exclusive؛ `\n`، `\r\n`، `\r`.
- **SymbolKey:** `<relPath>::<qualifiedName>::<kind>` و `#ordinal` برای تکراری؛ `signatureHash` فیلد جدا. اگر ID فعلی repo تفاوت دارد، `symbolKey` در کنار آن اضافه می‌شود نه جایگزین.
- **Handle:** `<relPath>:<start>-<end>#<hash8>`؛ mismatch → `STALE_HANDLE`.
- **Envelope:** `snapshotId`، `trust: 'untrusted-source-content'`، `stats`، `warnings`، `sessionId` اختیاری؛ نگاشت به `AiToolOutput` و MCP `content`/`structuredContent`.
- کدهای خطا، نام ابزارها `snake_case` (با aliasهای سازگار)، config schema، framework migration شماره‌دار، `FileProvider` port، `TokenCounter`، قوانین determinism.
- schema version، file/symbol ID، generation، freshness.

0.6. Fixtureها: add/modify/delete/rename، parse failure، skipped/truncated/generated/binary، stale artifact؛ **و** `unicode` (فارسی، emoji، CRLF، BOM، tab)، `broken` (خطای syntax)، `security` (symlink escape، `.env`، فایل بزرگ)، و پروژه‌ی کوچک TS/Python/PHP با symbolهای معلوم. اجرای full-vs-incremental و بررسی خروجی semantic، diagnostics، graph، vector و cache.

0.7. restart و artifact reload و consumer consistency برای ProjectIndexReader، registry، MCP و Gateway.

0.8. Compatibility matrix فعلی: schema، tool names/aliases، `AiToolOutput`، MCP `content`/`structuredContent`، `projectId`، `indexGeneration`.

0.9. **ماتریس traceability:** برای هر آیتم Appendix A، معادل موجود در repo (با فایل/نماد) و وضعیت (`EXISTS / PARTIAL / MISSING / CONFLICT`) پر شود. `CONFLICT` تصمیم mapping می‌خواهد.

0.10. **بررسی adopt-vs-build** (timebox ۲ روز): همان fixtureها و ۱۵ تا ۲۰ سناریوی retrieval/edit را روی حداقل دو ابزار موجود (مثلاً یک MCP مبتنی بر LSP و یک MCP گراف‌محور) و روی semantic-engine فعلی اجرا کن؛ token، کیفیت، latency ثبت شود. خروجی: تصمیم ثبت‌شده که کدام آیتم Appendix A ساخته، یکپارچه یا حذف می‌شود.

0.11. **Security baseline:** تست‌های خواندن (confinement، denylist، size، symlink)، پیش‌فرض read-only برای هر مسیر نوشتن، سقف اندازه‌ی نتیجه و timeout ابزارها — وضعیت فعلی ثبت شود.

### معیارهای پذیرش

- revision، manifest و command baseline قابل بازتولید و ذخیره‌شده؛ وضعیت هر command با exit code؛
- قراردادها با source و test مرتبط؛
- full و incremental برای fixtureها معادل (تفاوت مسدودکننده = 🔴)؛
- حذف فایل stale symbol/edge/vector/diagnostic باقی نمی‌گذارد (یا gap مسدودکننده ثبت شده)؛
- restart/reload وضعیت واقعی دارد؛
- compatibility matrix، ماتریس traceability و risk register منتشر شده؛
- تصمیم adopt-vs-build ثبت شده.

**خروجی:** evidence bundle، decisions/contracts/gates، fixture matrix، traceability matrix، risk register.\
**Gate:** بدون این‌ها Phase 1 تا 4 `BLOCKED`.

---

## Phase 1 — v1: Index و Platform (Fold/Read/Eval)

**هدف:** بستن baseline موجود + افزودن قابلیت‌های v1 که تصمیم 0.10 «ساخت/یکپارچه‌سازی» تعیین کرده، بدون source of truth دوم.\
**وضعیت:** 🔴 NOT STARTED\
**وابستگی:** Phase 0 (🟢/🟡).

### گام‌ها

1.1. رفع mismatchهای **مستند در Phase 0** بین schema و TypeScript types با migration/version decision؛ حفظ compatibility additive.

1.2. **Adapter policy:** زبان‌های واقعاً پشتیبانی‌شده (هدف spec: TypeScript/TSX/JavaScript، Python، PHP) با وضعیت `ok | degraded | unavailable`؛ نسخه‌ی grammar/parser pinned؛ **conformance snapshot** هر adapter روی fixture و شکست تست با تغییر نسخه‌ی grammar.

1.3. **Parse خطادار:** `ParseDiagnostics` (ERROR/MISSING)؛ outline بهترین‌تلاش با `partial:true`؛ «syntax valid» یعنی نبود ERROR/MISSING.

1.4. **Range/LineIndex:** پیاده‌سازی و property test (offset↔position) روی Unicode/EOL مختلط.

1.5. **Outline/Symbol:** `OutlineNode` با `key`، `signatureHash`، range فیلدها؛ تست پایداری key (تغییر بدنه/امضا → key ثابت؛ rename/move → تغییر با mapping).

1.6. **Deterministic ordering** برای files، symbols، diagnostics، edges و نتایج ابزار؛ حذف timestamp/random/process-order از خروجی معنایی.

1.7. **Atomic publication + generation + مالکیت نوشتن:** manifest/generation؛ consumer snapshot نیمه‌نوشته نمی‌بیند؛ نوشتن index توسط یک مالک (قفل یا compare-and-swap روی generation) تا worker/Gateway همزمان یک پروژه را خراب نکنند؛ `snapshotId` از مجموعه‌ی `(path, contentHash)`.

1.8. **Fold L0–L4** با elision marker و handle، `items[]` ساختاریافته، policy کامنت (`strip|doc-only|keep`)، `maxTokens` با کاهش تدریجی و `truncated`، `FoldRule` API (فقط rule عمومی group imports/consts در v1).

1.9. **ابزارهای خواندن** روی `AiToolRegistry` (additive): `code_outline`، `code_fold`، `code_read` (handle/range/symbolKey، `STALE_HANDLE`)، `symbol_find`، `symbol_inspect`، `search_text` (با enclosing symbol)، `diagnostics_get`، `project_info` (وضعیت adapterها، `snapshotId`)، `project_list_files`، `gains_report`. ورودی همه با schema عمیق (zod) اعتبارسنجی می‌شود.

1.10. **Telemetry:** `returnedTokens` و `avoidedTokensEstimate` در هر پاسخ.

1.11. **امنیت خواندن:** root confinement با realpath، symlink بیرونی دنبال نشود، denylist اسرار (`.env*`، `*.pem`، `*.key`، `id_rsa*`، `credentials*`)، سقف اندازه‌ی فایل، تشخیص باینری/generated، UTF-16 skip، `maxResultBytes` و `toolMs`، فیلد `trust`.

1.12. **Registry/cache:** cache key و invalidation بر اساس project/index identity + `(size, mtime) → hash → adapter/grammar version`؛ bypass نشدن project/file policy.

1.13. **MCP:** `tools/list` و `tools/call` با SDK نصب‌شده؛ parity text/structured؛ project scope؛ generation freshness. Gateway/worker فقط با fixture ایزوله. tool names با aliasهای سازگار.

1.14. **Eval و Bench** (بدون LLM، قطعی): compression ratio هر سطح، صحت unfold برای همه‌ی symbolها، determinism، سناریوی retrieval (baseline = خواندن کل فایل)، cold/warm، **peak RSS**؛ گزارش JSON+Markdown و «حکم gate» بر اساس `GATES.md`.

1.15. ثبت وضعیت هر قابلیت: specified / implemented / tested / locally verified / MCP verified / Gateway verified.

### معیارهای پذیرش (مسدودکننده مگر ذکر شده)

- `ProjectIndex` و schema/type همگام و versioned؛
- full/incremental، حذف فایل، حالت‌های partial و atomic publication با evidence؛
- خروجی deterministic (۱۰۰٪)؛
- unfold ۱۰۰٪ درست؛ fold L2 به آستانه‌ی `GATES.md` می‌رسد؛
- `broken` fixture بدون crash، outline partial؛
- تست‌های امنیتی خواندن ۱۰۰٪ پاس؛
- registry، MCP و lifecycle با project identity و generation صحیح (`MCP VERIFIED`)؛
- performance زیر آستانه = **غیرمسدودکننده** اگر علت اندازه‌گیری و مستند شده باشد؛
- هیچ ادعای completion بدون command/test evidence.

**Gate v1:** 🟢/🟡/🔴 طبق بند 1.2.

---

## Phase 2 — v2: Structural Search و Safe Mutation

**هدف:** structural search و edit safety به‌صورت extension روی v1.\
**وضعیت:** 🔴 NOT STARTED\
**وابستگی:** Gate v1 (🟢/🟡).

### گام‌ها

2.1. pin و بررسی نسخه/API واقعی ast-grep (`@ast-grep/napi` یا CLI fallback)، YAML و diff tooling؛ نبود dependency = `BLOCKED`.

2.2. adapter **read-only** برای `structural_search`، `structural_rule_search`، `structural_dump`، `structural_test_rule`، `rules_list` و rule packs (`.codeintel/rules/*.yml` با اعتبارسنجی schema)؛ pipeline موجود جایگزین نمی‌شود. semantics capture تکی/چندتایی طبق نسخه‌ی نصب‌شده در `CONTRACTS.md`.

2.3. **تأیید واحد Range خروجی ast-grep** (بایت یا UTF-16) با تست فارسی/emoji/CRLF/BOM/tab؛ همه‌ی نتایج از ماژول Range قرارداد تبدیل شوند.

2.4. post-filter بر پایه‌ی outline (`enclosingKind`، `enclosingNameRegex`، `fileGlob`، `inSymbolKey`) با project scope و ordering قطعی؛ `ConstraintProvider` **hook** (پیش‌فرض `NOT_SUPPORTED`) برای v3.

2.5. `EditPlan` مستقل از منبع + `EditBuilder` (`replaceRange`، `insertBefore/After`، `delete`، `replaceWithTemplate` با متن captureها، `reindent`)؛ `planId` = hash از JSON canonical؛ apply فقط با `planId`؛ ذخیره‌ی plan با TTL. **ast-grep هرگز مستقیم فایل نمی‌نویسد.**

2.6. **Conflict:** overlap → `EDIT_OVERLAP`؛ تودرتو با `nested: error|outermost|innermost` (پیش‌فرض `error`).

2.7. مسیر اجباری: `plan → diff → approval → apply → verify → undo/recover`.

- **تعریف approval:** `edit_diff` توکن یک‌بارمصرف وابسته به `planId` برمی‌گرداند؛ `edit_apply` بدون آن رد می‌شود. مصرف‌کننده‌ی MCP (host) مسئول گرفتن تأیید انسانی است.
- پیش‌فرض read-only؛ نوشتن فقط با `allowWrite:true` در config **و** `confirm:true` در ورودی.

2.8. **Transaction:** بررسی hash فعلی از `FileProvider` (mismatch → `PRECONDITION_FAILED`، هیچ نوشتنی)؛ اعمال ویرایش‌ها از offset بزرگ به کوچک؛ حفظ BOM/EOL و mode؛ نوشتن temp هم‌پوشه + fsync؛ verify سطح ۱ و ۲ پیش از commit؛ journal؛ rename همه؛ شکست وسط rename → rollback؛ `recoverJournal()` هنگام استارت؛ سقف فایل/بایت در هر تراکنش؛ root/symlink/denylist برای نوشتن.

2.9. **Verify با سه برچسب صادقانه:** `syntax` (خطای جدید نسبت به قبل؛ خطای قبلی fail نمی‌کند)، `structural` (متن خارج rangeها بدون تغییر؛ `patternCountDelta`؛ `symbolsUnchanged` با outline diff)، `behavior` (`not_run` مگر validator اجرا شود). هرگز ادعای semantic/behavior بدون validator.

2.10. **Validators:** فقط از allowlist سمت سرور (`name → {cmd, args, cwd, timeoutMs}`)؛ Agent فقط نام می‌دهد؛ `spawn` با argv بدون shell؛ خروجی bounded؛ `onValidatorFail: rollback|keep`. حالت `isolated` برای ویرایش‌های مستقل.

2.11. `edit_undo(txId)` فقط اگر hash فایل‌ها برابر `after_hash` (وگرنه `UNDO_CONFLICT`)؛ `edit_status`.

2.12. **Overlay provider** و `overlayPolicy` (`abort` پیش‌فرض) برای buffer ذخیره‌نشده؛ provenance دیسک/overlay جدا.

2.13. تست‌ها: golden diff؛ Unicode/فارسی/emoji؛ CRLF/BOM؛ overlap؛ crash injection بین rename؛ undo conflict؛ **fuzz حداقل ۱۰۰۰ چرخه apply→undo (بایت‌به‌بایت)**؛ MCP e2e (`structural_search → edit_plan → edit_diff → edit_apply → edit_undo`)؛ regression کامل v1.

### معیارهای پذیرش (مسدودکننده)

- search بدون mutation و با scope/provenance روشن؛
- diff preview هیچ فایلی را تغییر نمی‌دهد؛
- apply فقط پس از approval و precondition معتبر؛
- failure/crash → صفر corruption و صفر commit نیمه‌کاره‌ی غیرقابل‌بازیابی؛
- rollback/undo conflict صریح؛
- Range ast-grep ۱۰۰٪؛ validator allowlist ۱۰۰٪؛
- overlay، validator و MCP contract با evidence؛
- regression v1 سبز.

**Gate v2:** حتی یک corruption در fuzz = 🔴 و v3 ممنوع.

---

## Spike-S — بررسی v3 (موازی با Phase 2)

**هدف:** پیش از سرمایه‌گذاری، ریسک دقت resolution را بسنج.\
**قید:** branch جدا، بدون migration در main، خروجی gate نیست. timebox: ۱ تا ۲ هفته.

- انتخاب یک زبان و یک resolver (پیش‌فرض TypeScript مگر Phase 0 چیز دیگری نشان دهد).
- ساخت gold fixture کوچک با یال‌های طلایی (call/import/extends) و ۲۰ تسک goal→symbols.
- اجرای resolver heuristic خام؛ اندازه‌گیری precision/recall به تفکیک کلاس؛ مقایسه با ابزار adopt‌شده‌ی 0.10 روی همان fixture.
- خروجی: گزارش go / no-go / go-with-LSP برای Phase 3 و برآورد اندازه‌ی واقعی.

---

## Phase 3 — v3: Semantic Graph Pilot

**هدف:** یک vertical slice کم‌ریسک، نه rollout چندزبانه.\
**وضعیت:** 🔴 NOT STARTED\
**وابستگی:** Gate v2 + تصمیم Spike-S.

### دامنه‌ی pilot

یک زبان، یک resolver، یک query (`symbol_references`)، یک مسیر MCP، یک fixture incremental. LSP اختیاری و degraded؛ اجباری نمی‌شود.

### گام‌ها

3.1. **مدل اطمینان:** `exact | heuristic | ambiguous | unresolved` با candidates، `via` (`lsp | import-graph | scope | name-only`) و provenance. name-only هرگز `exact` نیست. `exact` فقط با scope قطعی، import→دقیقاً یک export، یا تأیید LSP.

3.2. **Migration additive** برای `refs`، `edges`، `unresolved`، `file_deps` — فقط بعد از backup، fixture و طراحی recovery؛ اجرای ایزوله‌ی migration و rollback.

3.3. استخراج reference/import (adapter) و `ModuleResolver` همان زبان (مثلاً tsconfig paths، node resolution، package.json workspaces). **unresolved در جدول ثبت می‌شود؛ هیچ ارجاعی بی‌صدا حذف نمی‌شود.** ادعای غیاب با عبارت «در گراف ایندکس‌شده یافت نشد (اطمینان: …)».

3.4. `SemanticProvider` **port:** `HeuristicProvider` پیش‌فرض؛ `LspProvider` اختیاری، فقط on-demand روی همسایگی seedها، با timeout و concurrency محدود؛ نبود server → `degraded` نه crash.

3.5. یک query روی همان registry/MCP: `symbol_references` با `minConfidence`؛ خروجی با confidence/via؛ project/generation scope.

3.6. **Incremental:** dirty propagation با `file_deps` (وابسته‌ها فقط دوباره resolve، نه re-parse)؛ `incremental == full` برای خروجی semantic؛ cleanup برای unresolved و فایل حذف‌شده؛ تست پایداری SymbolKey.

3.7. **Eval روی gold fixture:** baselineها B0 (خواندن کل فایل‌های keyword) و B1 (نقشه‌ی گرافی سطح-فایل بدون هدف)؛ precision/recall و calibration هر کلاس؛ مقایسه با ابزار adopt‌شده‌ی 0.10.

3.8. **مکانیزم** `experimental`**:** کلید `experimental.<feature>` در config؛ ثبت مشروط ابزار در registry؛ نشانه در توضیح ابزار؛ قابلیت ناموفق واقعاً خاموش می‌ماند.

3.9. تصمیم ثبت‌شده adopt-vs-build: اگر pilot به ابزار موجود نرسید یا تمایز روشنی نداشت، توسعه‌ی Phase 4 متوقف/بازتعریف می‌شود.

### معیارهای پذیرش (مسدودکننده)

- state و provenance resolver در persistence و خروجی قابل مشاهده؛
- ambiguity/unresolved حذف یا پنهان نمی‌شود؛
- precision کلاس `exact` ≥ آستانه‌ی `GATES.md` (شروع: ۰٫۹۵)، وگرنه آن مسیر به `heuristic` تنزل می‌کند؛
- `incremental == full` ۱۰۰٪؛
- migration rollback/recovery روی fixture اجرا شده؛
- MCP e2e؛ metric baseline با آستانه‌ی مصوب.

**Gate v3 pilot:** عدم عبور = قابلیت `EXPERIMENTAL` و توقف گسترش زبان/provider.

---

## Phase 4 — گسترش کنترل‌شده (مشروط)

**وضعیت:** 🔴 BLOCKED UNTIL PHASE 3 GATE\
**قاعده:** هر قابلیت قبل از implementation باید contract، fixture، failure state، security boundary، metric و rollback plan داشته باشد و gate جدا.

4.1. resolver/provider زبان دوم با همان contract و benchmark.\
4.2. `symbol_search` با FTS5/BM25 و ادامه‌ی `symbol_callers/callees/dependency_query` — فقط پس از اثبات نیاز و ثبت dependency.\
4.3. **Graph** `ConstraintProvider` (`calls`، `calledBy`، `enclosingClass`، `dependsOn`، `changedSince`، `hasTest`) روی hook فاز 2.\
4.4. **رتبه‌بندی** (Personalized PageRank از seedها، حالت focus/anchor، نقش‌ها) و `context_build`**/**`context_expand` با budget (binary search روی تعداد آیتم‌های رتبه‌بندی‌شده)، session dedup، handleهای expand، **omitted summary**، truncation metadata. باید روی gold tasks از B0 و B1 (و ablation ضرایب) بهتر یا برابر باشد؛ ضرایب پیش‌فرض با ablation تعیین شوند؛ کیفیت و token **با هم** گزارش شود.\
4.5. `impact_analyze`، test edges (heuristic مسیر/نام + ارجاع)، Git allowlisted (`status --porcelain`، `diff --name-only`؛ بدون shell؛ نبود git → degrade).\
4.6. **Semantic rename** به‌عنوان producer همان `EditPlan` v2 (engine جدید ساخته نمی‌شود): پیش‌فرض فقط `exact`، `includeHeuristic` صریح، `skipped[]`، `conflicts[]`، `expect.unresolvedNotIncreased`.\
4.7. Fold pluginهای framework-aware (TS decorators، Python class fields) با golden test.\
4.8. LSP demand-driven (TypeScript اول؛ Python بعد).\
4.9. **Scale** فقط با profile: `worker_threads`، pipeline parse→extract→drop، سقف حافظه؛ benchmark سرتاسری scan→…→`context_build`→serialize با RSS و worker count. NodeStore/arena non-goal مگر profile اثبات کند.

**Backlog (خارج از دامنه):** injection چندزبانه (HTML+JS/CSS، PHP+HTML، Vue/Svelte)، query-by-example، artifact گراف مشترک تیمی، جستجوی برداری/hybrid (فقط با شواهد eval)، adapterهای Rust/Go/HTML/CSS، community detection.

---

## 3. قیدهای یکپارچه‌سازی (مشروط)

اگر semantic-engine توسط `ai-coder` (افزونه‌ی VS Code) مصرف می‌شود — این را قبل از اتکا تأیید کن — این قیدها با یافته‌های audit همان پروژه هم‌راستاست:

- خروجی ابزارها **داده‌ی غیرقابل‌اعتماد** است؛ فیلد `trust` و حذف کامنت‌ها در fold پیش‌فرض (سطح prompt-injection).
- ابزارهای نوشتن (`edit_*`) پیش‌فرض خاموش؛ فعال‌سازی فقط با تصمیم صریح host و approval توکن‌دار؛ validatorها سمت سرور.
- سرور MCP هیچ درخواست server-initiated نمی‌سازد؛ قابلیتی که به آن نیاز دارد افزوده نمی‌شود.
- اعتبارسنجی عمیق ورودی همه‌ی ابزارها (نه فقط شکل بیرونی) + سقف اندازه و timeout (هم‌راستا با مرز IPC/bridge).
- publish اتمیک index و مالکیت نوشتن (گام 1.7) هم‌راستا با نگرانی‌های اتمیک‌بودن persistence.
- lifecycle: worker/Gateway با cancellation و dispose صریح؛ هیچ کاری بعد از shutdown ادامه نیابد (تست در 1.13).

---

## 4. گزارش‌دهی هر فاز

- revision و فهرست فایل‌های diff؛
- command کامل و environment؛ output و exit code؛
- identity تست/fixture؛ مسیر و hash artifactها؛
- فایل‌های پیاده‌سازی و تغییرات قرارداد؛
- gapهای static-only (مسدودکننده/غیرمسدودکننده)؛
- وضعیت runtime/MCP/Gateway؛
- یافته‌ها با شدت `Low/Medium/High` فقط با evidence؛
- نتیجه‌ی rollback/recovery؛
- تصمیم: `🟢 ACCEPTED` / `🟡 CONDITIONAL` / `🔴 BLOCKED` با نام تصمیم‌گیرنده و تاریخ.

---

## 5. Risk register اولیه

| ID

 | ریسک

 | کاهش

 |
| --- | --- | --- |
| R-01

 | واگرایی specها و repo موجود (source of truth دوم)

 | Preamble پیوست D، ماتریس 0.9، mapping additive

 |
| R-02

 | Phase 0 بی‌پایان شود

 | timebox و کاهش به گام‌های مسدودکننده

 |
| R-03

 | دقت resolution پایین

 | Spike-S، gate `exact`، `experimental`، LSP اختیاری

 |
| R-04

 | corruption در edit

 | fuzz، crash injection، journal، read-only پیش‌فرض

 |
| R-05

 | خطای واحد Range (ast-grep/parser)

 | LineIndex واحد، تست Unicode در 1.4 و 2.3

 |
| R-06

 | ساخت چیزی که ابزار موجود دارد

 | 0.10 و 3.9

 |
| R-07

 | هزینه‌ی evidence آهسته‌کننده

 | `evidence-capture`، bundle هر فاز

 |
| R-08

 | تغییر آستانه پس از دیدن نتیجه

 | ثبت پیش از اندازه‌گیری (1.5)

 |

---

## 6. جمع‌بندی تصمیم

```text
Phase 0 baseline + قراردادها + traceability + adopt-vs-build
  → Phase 1 v1: index/fold/read/MCP/eval
  → Phase 2 v2: structural + safe edit        ∥  Spike-S (بررسی v3)
  → Phase 3 v3 pilot (یک زبان، یک query)
  → Phase 4 گسترش مشروط
```

تا وقتی baseline، قراردادها، full/incremental، artifact freshness، compatibility و ماتریس traceability با شواهد واقعی ثبت نشده‌اند، توسعه‌ی v2/v3 نباید به‌عنوان پیشرفت یا release readiness گزارش شود.

---

## Appendix A — ماتریس Traceability (specها → فاز)

ستون «معادل موجود در repo» در گام 0.9 پر می‌شود (`EXISTS / PARTIAL / MISSING / CONFLICT` + فایل/نماد).

| ID

 | آیتم

 | منبع

 | فاز

 |
| --- | --- | --- | --- |
| T-01

 | Range UTF-16 + LineIndex

 | v1 §5.1

 | 0 (قرارداد)، 1.4

 |
| T-02

 | SymbolKey پایدار + signatureHash جدا

 | v1 §5.2

 | 0، 1.5

 |
| T-03

 | Handle + `STALE_HANDLE`

 | v1 §5.3

 | 1.9

 |
| T-04

 | Envelope: snapshotId، trust، stats، sessionId

 | v1 §5.4

 | 0، 1.9

 |
| T-05

 | taxonomy کد خطا

 | v1 §5.5

 | 1.9

 |
| T-06

 | Config schema اعتبارسنجی‌شده

 | v1 §5.6

 | 1.9

 |
| T-07

 | Migration شماره‌دار + invalidation cache

 | v1 §5.7، §11

 | 0، 1.12

 |
| T-08

 | `FileProvider` (Disk؛ Overlay در v2)

 | v1 §5.8

 | 0، 1.11

 |
| T-09

 | `TokenCounter`

 | v1 prompt §4.8

 | 1.8

 |
| T-10

 | Language adapter + conformance + grammar pin + status

 | v1 §6

 | 1.2

 |
| T-11

 | ParseDiagnostics و partial

 | v1 §7

 | 1.3

 |
| T-12

 | Outline/OutlineNode

 | v1 §8

 | 1.5

 |
| T-13

 | Fold L0–L4، marker، items، policy کامنت، FoldRule

 | v1 §9

 | 1.8

 |
| T-14

 | ابزارهای read/find/search/diagnostics/project

 | v1 §12

 | 1.9

 |
| T-15

 | Telemetry (gains)

 | v1 §13

 | 1.10

 |
| T-16

 | امنیت خواندن

 | v1 §10

 | 0.11، 1.11

 |
| T-17

 | Eval harness + bench + RSS

 | v1 §14

 | 1.14

 |
| T-18

 | نام‌های snake_case + alias

 | v1 §3

 | 0.8، 1.13

 |
| T-19

 | Structural search روی ast-grep

 | v2 §4

 | 2.2

 |
| T-20

 | Rule packs

 | v2 §4.4

 | 2.2

 |
| T-21

 | Outline post-filter + `ConstraintProvider` hook

 | v2 §4.1

 | 2.4

 |
| T-22

 | EditPlan/EditBuilder/planId

 | v2 §5.1

 | 2.5

 |
| T-23

 | Conflict detection

 | v2 §5.2

 | 2.6

 |
| T-24

 | Apply تراکنشی + journal + recovery

 | v2 §5.3

 | 2.8

 |
| T-25

 | Verify سه‌سطحی صادقانه

 | v2 §5.4

 | 2.9

 |
| T-26

 | Validator allowlist + isolated mode

 | v2 §5.5–5.6

 | 2.10

 |
| T-27

 | Undo

 | v2 §5.7

 | 2.11

 |
| T-28

 | Overlay provider

 | v2 §5.8

 | 2.12

 |
| T-29

 | Read-only پیش‌فرض + approval توکن

 | v2 §8

 | 2.7

 |
| T-30

 | Ref/import extraction + module resolver

 | v3 §4

 | 3.3، 4.1

 |
| T-31

 | Confidence model + unresolved

 | v3 §5

 | 3.1، 3.3

 |
| T-32

 | `SemanticProvider` (heuristic، LSP اختیاری)

 | v3 §3

 | 3.4، 4.8

 |
| T-33

 | Graph store، `file_deps`، `incremental==full`، ثبات key

 | v3 §6–7

 | 3.2، 3.6

 |
| T-34

 | `symbol_references/callers/callees/dependency_query`

 | v3 §10

 | 3.5، 4.2

 |
| T-35

 | `symbol_search` FTS5/BM25

 | v3 §6

 | 4.2

 |
| T-36

 | PPR + نقش‌ها + focus

 | v3 §8

 | 4.4

 |
| T-37

 | `context_build/expand` + session dedup + budget

 | v3 §9

 | 4.4

 |
| T-38

 | Graph `ConstraintProvider`

 | v3 §11

 | 4.3

 |
| T-39

 | `impact_analyze`، test edges، Git

 | v3 §12–13

 | 4.5

 |
| T-40

 | `edit_plan_rename` + `expect.unresolvedNotIncreased`

 | v3 §12

 | 4.6

 |
| T-41

 | Fold pluginهای framework-aware

 | v3 §14

 | 4.7

 |
| T-42

 | Gold-task eval، baseline، ablation، calibration

 | v3 §16

 | 3.7، 4.4

 |
| T-43

 | Scale (فقط با profile)

 | v3 §15

 | 4.9

 |
| T-44

 | مکانیزم `experimental`

 | v3 prompt §10

 | 3.8

 |

---

## Appendix B — آستانه‌های پیش‌ثبت (مقدار شروع؛ قبل از اندازه‌گیری در `GATES.md` قفل شود)

| فاز

 | معیار

 | مقدار شروع

 | نوع

 |
| --- | --- | --- | --- |
| 1

 | کاهش token با fold L2 (میانه، فایل‌های &gt;۲۰۰ خط)

 | ≥ ۶۰٪

 | مسدودکننده

 |
| 1

 | صحت unfold (همه‌ی symbolها)

 | ۱۰۰٪

 | مسدودکننده

 |
| 1

 | determinism (به‌جز `stats`)

 | ۱۰۰٪

 | مسدودکننده

 |
| 1

 | تست‌های امنیتی خواندن

 | ۱۰۰٪

 | مسدودکننده

 |
| 1

 | parity text/structured در MCP

 | ۱۰۰٪

 | مسدودکننده

 |
| 1

 | warm نسبت به cold (outline)

 | ≥ ۵×

 | غیرمسدودکننده

 |
| 2

 | fuzz apply→undo

 | ≥ ۱۰۰۰ چرخه، ۱۰۰٪ بایت‌به‌بایت

 | مسدودکننده

 |
| 2

 | crash-injection recovery

 | ۱۰۰٪

 | مسدودکننده

 |
| 2

 | تبدیل Range ast-grep

 | ۱۰۰٪

 | مسدودکننده

 |
| 2

 | رد validator خارج از allowlist

 | ۱۰۰٪

 | مسدودکننده

 |
| 3

 | precision کلاس `exact` (gold fixture)

 | ≥ ۰٫۹۵

 | مسدودکننده

 |
| 3

 | `incremental == full`

 | ۱۰۰٪

 | مسدودکننده

 |
| 3

 | ثبت unresolved (بدون حذف بی‌صدا)

 | ۱۰۰٪

 | مسدودکننده

 |
| 3

 | recall نسبت به baseline

 | ≥ B1 و &gt; B0

 | مسدودکننده

 |
| 4

 | `context_build` recall@budget

 | ≥ B1 و &gt; B0

 | مسدودکننده

 |
| 4

 | عدم تجاوز از budget

 | ۱۰۰٪

 | مسدودکننده

 |

اعداد مقدار شروع‌اند، نه ادعای اثبات‌شده.

---

## Appendix C — نواقص پلن قبلی و راه رفع (change log)

| نقص در نسخه‌ی قبلی

 | رفع در این نسخه

 |
| --- | --- |
| gate با «equivalence یا discrepancy مستند» و «gap پذیرفته‌شده» قابل دور زدن بود

 | بند 1.2، 1.3: طبقه‌بندی مسدودکننده/غیرمسدودکننده؛ gap مسدودکننده پذیرفتنی نیست

 |
| 🟡 تعریف نشده و متناقض بود

 | بند 1.2 و قاعده‌ی شروع فاز بعد

 |
| «چه کسی gap را می‌پذیرد» معلوم نبود

 | بند 1.6

 |
| ارتباط با specهای v1/v2/v3 مشخص نبود

 | Appendix A و گام 0.9

 |
| Range/encoding در فاز v3 تعریف می‌شد، پس از استفاده در v2

 | گام 0.5 (قرارداد) و 1.4 (تست)؛ 2.3 تأیید ast-grep

 |
| چارچوب migration فقط پراکنده

 | T-07 در Phase 0/1

 |
| آستانه‌ها تعریف نشده بود

 | Appendix B و بند 1.5

 |
| مالکیت نوشتن index / concurrency

 | گام 1.7

 |
| «approval» معنای مشخص نداشت

 | گام 2.7 (توکن یک‌بارمصرف)

 |
| denylist اسرار فقط برای نوشتن

 | گام 1.11 برای خواندن + 0.11

 |
| نبود hook برای قیدهای گرافی در v2

 | گام 2.4

 |
| ریسک v3 آخر پلن می‌ماند

 | Spike-S موازی

 |
| «بسازم یا از ابزار موجود» پرسیده نشده

 | گام 0.10 و 3.9

 |
| `EXPERIMENTAL` فقط برچسب بود

 | گام 3.8

 |
| هزینه‌ی evidence سنگین

 | بند 1.7

 |
| Phase 0 بی‌سقف

 | timebox بند 2

 |
| تعریف نشدن «conditional» / شرط

 | بند 1.2

 |
| specها فرض greenfield داشتند

 | بخش 0 و Appendix D

 |

### تغییرات نسبت به specهای اولیه (اعمال‌شده در این پلن)

- `SymbolKey` بدون hash امضا (hash امضا فیلد جدا)، برای پایداری در برابر ویرایش امضا.
- offset مبنا UTF-16؛ Position فقط از LineIndex.
- نام ابزارها snake_case بدون نقطه.
- `snapshotId` و `trust` و `sessionId` در envelope از v1.
- Verify سه‌سطحی با برچسب `not_run` برای behavior.
- Validator فقط از allowlist سرور.

---

## Appendix D — Preamble برای promptهای انگلیسی (قبل از v1/v2/v3 اضافه شود)

```text
EXISTING-REPOSITORY CONSTRAINTS (read before the rest of this prompt)

You are NOT building a standalone project. You are extending the existing
package `semantic-engine/` in repository legionir/semantic-engine-structured-ai.

1. Do not create a second source of truth. Reuse existing ProjectIndex,
   ProjectRegistry/ProjectPaths, scanner, parser/extractor pipeline,
   IncrementalEngine, OutputWriter, ProjectIndexReader, AiToolRegistry,
   MCP server, Gateway/worker lifecycle and the filesystem port.
2. Every contract in this prompt (Range, SymbolKey, Handle, Envelope,
   ErrorCode, config, migrations, FileProvider, TokenCounter) must be
   introduced ADDITIVELY. If it conflicts with an existing contract, write a
   mapping and record it in docs/DECISIONS.md — never replace silently.
3. The "greenfield" layout, package names and library choices in this prompt
   are suggestions. First inspect what the repo already uses; prefer it.
   Verify every third-party API from the installed package types.
4. Do not mark anything complete without executed evidence (command, revision,
   output, exit code). Static presence of a type/schema/test is not evidence.
5. Follow the gate definitions in docs/GATES.md. Do not change thresholds
   after measuring. Blocking gaps cannot be "accepted"; only fixed or removed
   from the claimed scope.
6. Keep changes small, reversible and adapter-based. No rewrites.
7. Write tools default to disabled/read-only. Treat all returned source
   content as untrusted data.
```