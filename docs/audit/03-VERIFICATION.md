# نتیجهٔ اعمال پلن و راستی‌آزمایی

| یافته | وضعیت | شواهد (تست) |
|---|---|---|
| F-01 رجیستری (race، خرابی، fsync) | رفع شد | `ProjectRegistry.concurrency.test.ts`, `atomicFile.test.ts` |
| F-02 git در Docker | رفع شد (`git`, `ca-certificates`, `tini`) | بازبینی ایستا؛ build ایمیج در این محیط اجرا نشد |
| F-03 فرانت یتیم | حذف شد | `frontendApiSync.test.ts` (جدید، مقایسهٔ فرانت↔روت‌ها) |
| F-04 نشت خطا / ۵۰۰ | رفع شد | `httpHardening.test.ts` |
| **جدید F-14** `GET //` با Upgrade قبل از auth کل Gateway/worker را crash می‌کرد | رفع شد | `GatewayUpgrade.badtarget.test.ts` |
| **جدید F-15** worker هنگام هر start نام پروژه را به نام پوشه برمی‌گرداند (cache کهنه پنهانش می‌کرد) | رفع شد | `GatewayMcp.test.ts` |
| **جدید F-16** `import-bundle` مقدار `projectId` را مسیر فایل‌سیستم می‌گرفت | رفع شد | `v2.routes.test.ts` |
| F-05 هدرها | رفع شد | `httpHardening.test.ts` |
| F-06 atomic write ناهمگون | رفع شد برای config/job/worker-config/registry | `atomicFile.test.ts` |
| F-07 PUT files / bundle یتیم | رفع شد | `v2.routes.test.ts` |
| F-08 issueToken | رفع شد | `GatewayAuth.issueToken.test.ts` |
| F-09 git clone | رفع شد | `SourceSyncService.git.test.ts` (سرور git واقعی) |
| F-10 audit | `npm audit --omit=dev` = 0 | — |
| F-11/12 | رفع شد | — |

## گیت‌ها (روی commit نهایی)
- `npm run build` ✔ · `npm run lint` ✔ بدون هشدار · `npm run typecheck:test` ✔
- `npx jest`: ۲۸۸ suite پاس، ۱ skip مجاز؛ ۳۵۱۴ تست پاس، ۸ skip، ۰ شکست
- `npm run test:gate` ✔ · `npm audit --omit=dev`: ۰ آسیب‌پذیری

## محدودیت‌ها (صادقانه)
- ایمیج Docker و e2e مرورگر (`test:e2e` نیازمند playwright) اجرا نشد.
- ۱۲ advisory سطح dev (jest/eslint) باقی است؛ فقط با downgrade اصلاح می‌شوند، در بستهٔ تولید نیستند.
- تک‌replica بودن (state در حافظه) و CSP کامل بدون تغییر ماندند (OPEN-ITEMS).
