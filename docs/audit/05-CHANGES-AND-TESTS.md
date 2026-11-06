# خلاصهٔ تغییرات و تست‌ها (PR نهایی)

شاخه: `fix/mixed-embeddings-and-console-merge` → `main` · مبنا: `cf44b4c`

## ۱. تغییرات به ترتیب اولویت
| # | تغییر | شدت | تست |
|---|---|---|---|
| 1 | رجیستری پروژه‌ها: قفل بین‌پروسه‌ای، reload بر اساس فایل، بازسازی از manifest، fsync | P0 | `core/config/ProjectRegistry.concurrency.test.ts`، `ProjectRegistry.test.ts` |
| 2 | helper مشترک `atomicWriteFileSync` / `withFileLockSync` (retry ویندوز، مالک‌شناسی قفل) | P2 | `core/utils/atomicFile.test.ts` |
| 3 | `GET //` با Upgrade قبل از auth کل Gateway/worker را crash می‌کرد | P0 | `gateway/GatewayUpgrade.badtarget.test.ts` |
| 4 | worker هنگام start نام پروژه را به نام پوشه برمی‌گرداند | P1 | `gateway/GatewayMcp.test.ts` |
| 5 | خطای ۵۰۰ بدون متن داخلی؛ %-escape خراب = ۴۰۴/۴۰۰؛ `Referrer-Policy`، `Cache-Control: no-store` | P1/P2 | `server/httpHardening.test.ts` |
| 6 | `import-bundle`: `projectId` دیگر مسیر نیست؛ بستهٔ ردشده اثری نمی‌گذارد؛ `PUT files` نیازمند `content` | P1/P2 | `server/v2.routes.test.ts` |
| 7 | `git clone` بدون prompt/redirect/hook، خطای ۵۰۲ بدون اعتبارنامه | P2 | `services/source/SourceSyncService.git.test.ts` (سرور git واقعی) |
| 8 | `issueToken` با لیست خالی به همه پروژه‌ها دسترسی نمی‌داد | P2 | `gateway/GatewayAuth.issueToken.test.ts` |
| 9 | حذف فرانت یتیم (`index.html`, `app.js`, `modal.js`, worker)؛ مقایسهٔ API فرانت↔بک | P1 | `server/frontendApiSync.test.ts` |
| 10 | Docker: `git`, `ca-certificates`, `tini` | P1 | بازبینی ایستا |
| 11 | `minimatch` 11، lockfile: `npm audit --omit=dev` = 0 | P3 | `scanner/*`, `core/config/gitignoreParser.test.ts` |
| 12 | مستندسازی کامل ابزارهای AI (۱۳۳ پارامتر)، `instructions` در MCP، skill قابل‌نصب | — | `ai/tools/toolDocs.test.ts` |
| 13 | شش خروجی گمراه‌کنندهٔ ابزارها (`search_text`, `impact_analysis`, hotspots, `get_recent_changes`, `find_tests`, پارامتر ناشناخته) | P2 | `ai/AiToolRegistry.outputTruth.test.ts`، `ai/tools/ImpactAnalysisTool.test.ts` |
| 14 | `edit_*` خاموش در لیست نیست؛ `explain_symbol` با `anyOf`؛ خطاهای `code_read` گویا؛ سوییچ `structuredContent` | P3 | `ai/AiToolRegistry.outputTruth.test.ts`، `ai/mcp/SemanticEngineMcpServer.test.ts` |

تغییر رفتار عمدی: `impact_analysis` برای id ناشناخته به‌جای `success:true` خالی، خطا می‌دهد (تست قدیمی که آن را قفل کرده بود اصلاح شد).

## ۲. تست‌های جدید یا تغییرکرده
`AiToolRegistry.outputTruth`، `SemanticEngineMcpServer`، `ImpactAnalysisTool`، `toolDocs`، `ProjectRegistry.concurrency`، `ProjectRegistry`،
`atomicFile`، `GatewayAuth.issueToken`، `GatewayMcp`، `GatewayUpgrade.badtarget`، `frontendApiSync`، `httpHardening`، `v2.routes`، `SourceSyncService.git`.

## ۳. اجرای مجدد
```bash
npm ci
npm run build && npm run lint && npm run typecheck:test
npx jest                       # کل suite
npm run test:gate              # fixture + بودجهٔ skip + مکان artifact
npm run docs:ai-tools:check    # AI-TOOLS.md و SKILL.md با registry هم‌خوان‌اند
npm audit --omit=dev           # باید 0 باشد
```

## ۴. نتیجهٔ آخرین اجرا
- jest: ۲۹۰ suite پاس، ۱ skip مجاز؛ ۳۵۳۵ تست پاس، ۸ skip، ۰ شکست
- build، lint، typecheck:test، test:gate، docs:ai-tools:check: بدون خطا
- اجرا نشده: build ایمیج Docker، e2e مرورگر (`test:e2e`، نیازمند playwright)، ارزیابی ابزارها با مدل زبانی واقعی

## ۵. اصلاحات پس از اولین اجرای CI روی PR
| مورد | علت | اقدام |
|---|---|---|
| Performance gate (`eval-retrieval --check`) | corpus ارزیابی خود `src` است؛ افزودن `toolDocs.ts`/تست‌ها `recall@1` هشینگ را از 0.619 به 0.571 برد (مشابه مورد مستند در OPEN-ITEMS §4). کد رتبه‌بندی دست نخورده؛ روی `main` همان 0.619 بازتولید می‌شود | `eval/baseline.json` با اعداد همان runner CI دوباره ثبت شد |
| Panel e2e: نصب مرورگر | `ubuntu-latest` به Ubuntu 26.04 رفته و Playwright 1.56.1 پشتیبانی نمی‌کند | job روی `ubuntu-24.04` قفل شد |
| Panel e2e: `404 /api/v1/gateway/info` | probe عمدی صفحهٔ تنظیمات روی سرور تک‌پروژه‌ای (commit کنسول ادغام‌شده) | اسکریپت این یک مسیر را از «فراخوانی ناموفق» مستثنا می‌کند |
| Gateway e2e | اسکریپت پس از مودال‌شدن پنل‌ها و تغییر بنر worker به‌روز نشده بود (روی `main` هم می‌شکست) | بستن مودال سلامت پیش از ادامه؛ انتظار برای لاگ؛ الگوی بنر جدید |

اجرای محلی با Playwright نصب‌شده: `e2e-panel` و `e2e-gateway` هر دو «all checks passed».

## ۶. فایل‌های مرتبط
`01-FINDINGS.md` · `02-EXECUTION-PLAN.md` · `03-VERIFICATION.md` · `04-AI-TOOLS-AUDIT.md` · `../AI-TOOLS.md` · `../../skills/semantic-engine/SKILL.md`
