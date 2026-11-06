# گزارش بازبینی پیش از پروداکشن — یافته‌ها

تاریخ: ۲۰۲۶-۱۱-۰۶ · شاخه: `fix/mixed-embeddings-and-console-merge` · مبنا: commit `a93bb8a`

## ۰. روش و دامنه

پروژه یک موتور code-intelligence محلی است. «دیتابیس» در اینجا یعنی **فایل‌های حالت‌دار روی دیسک**:
`project-index.json`، vector store (usearch)، `config.json`، `registry.json` + `manifest.json`، وضعیت JobManager،
و پیکربندی worker/gateway. زنجیرهٔ بررسی‌شده:

```text
فایل‌های دیسک (index/registry/config)  →  سرویس‌ها/pipeline  →  HTTP (server + gateway + MCP)  →  public/*.js (فرانت‌اند)
```

بخش‌های بررسی‌شده: (۱) لایهٔ ذخیره‌سازی و atomic write، (۲) registry و config، (۳) سرور پلتفرم و SecurityPipeline،
(۴) Gateway و auth، (۵) سرویس منبع/Git، (۶) فرانت‌اند و تطابق API، (۷) قرارداد OpenAPI، (۸) Docker/CI/وابستگی‌ها.

خط پایه (قبل از هر تغییر): `npm run build` ✔ · `npm run lint` ✔ بدون هشدار · `npm audit --omit=dev`: ۲ مورد moderate.
تطابق OpenAPI با روت‌ها: ۷۸ روت = ۷۸ مسیر قرارداد، بدون اختلاف (و با تست `openapiSync` نگه داشته می‌شود).
تطابق فراخوانی‌های فرانت‌اند با روت‌های بک‌اند: همهٔ فراخوانی‌های `gateway.js`/`open.js`/`visualizer.js`/`worker-console.js`
به روت واقعی می‌رسند؛ تنها استثنا کد یتیم F-03 است.

شدت: **P0** خطر از دست رفتن داده/دسترسی · **P1** خرابی عملیاتی در پروداکشن · **P2** استحکام/امنیت · **P3** کیفیت.

## ۱. یافته‌ها

### F-01 · P0 · `ProjectRegistry`: cache بی‌انقضا + نبود قفل بین‌پروسه‌ای → از دست رفتن ثبت پروژه‌ها
- **کجا:** `src/core/config/ProjectRegistry.ts` (`load()` با `this.cache`، `save()`، `writeJsonAtomic`).
- **چه می‌شود:** registry فقط یک بار از دیسک خوانده و برای همیشه cache می‌شود. `register/touch/update/remove` کل فهرستِ cache را
  روی فایل می‌نویسد. Gateway (`gateway-command`)، سرور standalone (`ProjectService`) و CLI می‌توانند همزمان روی یک data root کار کنند؛
  هر پروسه‌ای که دیرتر بنویسد ثبت‌های پروسهٔ دیگر را پاک می‌کند (lost update).
- **فایل خراب:** در `load()` فایل خراب قرنطینه می‌شود و فهرست **خالی** می‌شود؛ با اینکه `manifest.json` هر پروژه کنارش هست و
  می‌شد فهرست را از آن‌ها بازسازی کرد.
- **دوام:** tmp+rename بدون `fsync`؛ قطع برق می‌تواند فایل خالی بگذارد. rename روی ویندوز retry ندارد.
- **اصلاح:** قفل فایل (O_EXCL + stale takeover امن) و reload بر اساس mtime/size پیش از هر خواندن و در داخل قفل پیش از هر تغییر؛
  بازسازی از manifestها هنگام فایل خراب؛ `fsync` + rename با retry.

### F-02 · P1 · ایمیج Docker فاقد `git`
- **کجا:** `Dockerfile` (پایه `node:22-bookworm-slim` بدون git).
- **اثر:** `POST …/source/sync-git` و `GitHistoryMiner` (hotspots/co-churn/recent-changes) در کانتینر با ENOENT شکست می‌خورند.
  `ca-certificates` برای clone روی HTTPS هم باید تضمین شود.
- **اصلاح:** نصب `git` و `ca-certificates` در stage اجرا؛ `tini`/init برای reap شدن پروسه‌های فرزند (worker/LSP/git).

### F-03 · P1 · فرانت‌اند یتیم از محصول دیگر (`index.html`, `app.js`, `modal.js`, `workers/layout.worker.js`)
- **شواهد:** `app.js` (۳۰۰۷ خط) به `/api/sessions`, `/api/tasks`, `/api/state`, `/api/approvals`, `/api/events`, `/api/cancel`, `/api/clear`,
  `/api/approval-mode`, `/api/calls` وصل است؛ هیچ‌کدام در بک‌اند وجود ندارد (۱۱ فراخوانی بدون روت). `index.html` عنوان
  «structured-ai console» دارد ولی `StaticAssetServer` مسیر `/index.html` را به `open.html` بازنویسی می‌کند، پس هرگز نمایش داده نمی‌شود.
  `modal.js` فقط از `index.html` بارگذاری می‌شود و `layout.worker.js` هیچ `new Worker` ای ندارد.
- **اثر:** ~۳۴۰۰ خط کد مرده در بستهٔ منتشرشده، سطح حملهٔ اضافی (`/app.js` سرو می‌شود)، سردرگمی نگه‌دارنده.
- **اصلاح:** حذف چهار فایل. `app.css` می‌ماند (open/visualizer/GatewayUi استفاده می‌کنند).

### F-04 · P1 · نشت پیام خطای داخلی و ۵۰۰ به‌جای ۴۰۰ برای ورودی نامعتبر
- **کجا:** `HttpServer.start()` و `GatewayServer.listen()` (catch سراسری: `error.message` به کلاینت می‌رود)،
  `GatewayServer.handle` (`decodeURIComponent` روی `%` ناقص → `URIError` → ۵۰۰)، `new URL(req.url)`.
- **اثر:** مسیر فایل‌سیستم/متن خطای داخلی در پاسخ؛ ورودی بد = «سرور خراب شد».
- **اصلاح:** پاسخ عمومی `internal error` + شناسهٔ درخواست و لاگ سمت سرور؛ `URIError` و URL نامعتبر → ۴۰۰.

### F-05 · P2 · هدرهای امنیتی ناقص
- **کجا:** `SecurityPipeline.applySecurityHeaders`، `StaticAssetServer`، `GatewayUi`.
- **اثر:** `?token=` مجاز است (بنرهای CLI) و بدون `Referrer-Policy` توکن می‌تواند در `Referer` به origin دیگر برود.
  `X-XSS-Protection` منسوخ است؛ پاسخ‌های API بدون `Cache-Control: no-store`.
- **اصلاح:** `Referrer-Policy: no-referrer`، `Cache-Control: no-store` برای JSON، حذف هدر منسوخ، `X-Content-Type-Options` روی assetها.
  (CSP کامل عمداً اضافه نمی‌شود: صفحات `style=` درون‌خطی دارند و iframe preview آزاد است — تصمیم SE-UI-02.)

### F-06 · P2 · نوشتن atomic ناهمگون
- **کجا:** `GlobalConfig.writeConfigFile`، `JobManager.persist`، `WorkerConfigStore`، `ProjectLock`، `ExtractionCache`، `ProjectRegistry`
  همه `writeFileSync + renameSync` خام دارند؛ فقط `FileSystem.writeJsonAtomic` retry ویندوز و `fsync` دارد.
- **قفل `GlobalConfig.withFileLock`:** پس از ۳ ثانیه قفلِ زندهٔ دیگران را حذف می‌کند و `finally` قفل نفر بعدی را پاک می‌کند.
- **اصلاح:** یک helper مشترک `atomicWriteFileSync` (fsync + retry ویندوز) و یک `withFileLockSync` مشترک با مالک‌شناسی (pid/token).

### F-07 · P2 · اعتبارسنجی ناقص در routeهای منبع
- `PUT /api/v1/projects/:id/files/:filePath`: بدنهٔ بدون `content` فایل را **خالی** می‌کند (`body.content || ''`).
- `POST /api/v{1,2}/projects/import-bundle`: پروژه ثبت می‌شود و اگر import شکست بخورد پروژهٔ یتیم باقی می‌ماند.
- **اصلاح:** `content` باید string باشد (۴۰۰)؛ در شکست import ثبت پروژه برگردانده می‌شود.

### F-08 · P2 · `GatewayAuth.issueToken`: لیست خالی پروژه‌ها = دسترسی به همه
- `projects.length === 0` → `resourceScope='*'` بدون `allowedProjects` → `canAccessProject` برای همهٔ پروژه‌ها true.
  فعلاً هیچ روتی صدایش نمی‌زند (کد مرده)، ولی تله‌ای برای اولین استفاده‌کننده است.
- **اصلاح:** لیست خالی رد شود؛ `'*'` فقط صریح.

### F-09 · P2 · `git clone` در `SourceSyncService`
- بدون `GIT_TERMINAL_PROMPT=0`: مخزن خصوصی/ریدایرکت‌شده تا ۱۲۰ ثانیه روی prompt اعتبارنامه آویزان می‌ماند (و یک slot عملیات را می‌گیرد).
- URL بدون `--` پیش از آرگومان موقعیتی؛ `credential.helper`/`protocol.file.allow` در برابر config کاربر سخت نشده.
- بررسی SSRF فقط روی hostِ اولیه است؛ ریدایرکت HTTP توسط git دنبال می‌شود (`http.followRedirects`). → `-c http.followRedirects=false`.

### F-10 · P3 · وابستگی‌ها
- `minimatch` (مستقیم) و `@hono/node-server` (از طریق MCP SDK): دو advisory متوسط. بررسی `npm audit fix` غیرشکننده.

### F-11 · P3 · `escape()` در `gateway.js`/`worker-console.js`/`modal.js` کوتیشن تکی را escape نمی‌کند
- فعلاً همهٔ attributeها با `"` هستند، پس قابل سوءاستفاده نیست؛ دفاع در عمق.

### F-12 · P3 · `SecurityPipeline.validateSchema` به‌ازای هر درخواست `ajv.compile` می‌زند (و memory-leak ملایم در cache داخلی Ajv).
- **اصلاح:** WeakMap برای cache validatorها.

### F-13 · پذیرفته/مستند (بدون تغییر کد)
- `fs/browse` در حالت standalone کل فایل‌سیستم را (فقط نام پوشه‌ها، پشت token) نشان می‌دهد — تصمیم موجود SE-UI-04.
- رویدادهای SSE گیت‌وی برای همهٔ توکن‌های معتبر پروژه‌های دیگر را هم نشان می‌دهد؛ تا وقتی توکن محدود به پروژه صادر نمی‌شود (F-08) قابل بهره‌برداری نیست.
- Rate limit / job state / API-key store در حافظهٔ پروسه‌اند (OPEN-ITEMS §5): فقط یک replica پشتیبانی می‌شود.

## ۲. وضعیت تست پایه
نتیجهٔ کامل `jest` در `03-VERIFICATION.md` ثبت می‌شود.
