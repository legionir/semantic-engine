# پلن اجرایی به ترتیب اولویت

هر مرحله: تغییر کد → تست هدفمند → commit جدا. پس از آخرین مرحله: `build`, `lint`, کل `jest`, `npm audit`.

| # | مرحله | یافته | شدت | فایل‌های اصلی | تأیید |
|---|---|---|---|---|---|
| 1 | helperهای مشترک `atomicWriteFileSync` و `withFileLockSync` | F-06 | P2 | `src/core/utils/atomicFile.ts` (جدید) | تست واحد جدید |
| 2 | `ProjectRegistry`: قفل، reload، بازسازی از manifest، fsync | F-01 | **P0** | `ProjectRegistry.ts` | تست دو-instance + فایل خراب |
| 3 | استفاده از helper در `GlobalConfig`, `JobManager`, `WorkerConfigStore`, `ProjectLock`, `ExtractionCache` | F-06 | P2 | همان‌ها | تست‌های موجود |
| 4 | Dockerfile: git + ca-certificates + init | F-02 | P1 | `Dockerfile` | بازبینی ایستا |
| 5 | حذف فرانت‌اند یتیم | F-03 | P1 | `public/{index.html,app.js,modal.js,workers}` | جست‌وجوی ارجاع + تست استاتیک |
| 6 | خطای عمومی ۵۰۰ و ۴۰۰ برای URL/URI نامعتبر | F-04 | P1 | `HttpServer.ts`, `GatewayServer.ts` | تست جدید |
| 7 | هدرهای امنیتی | F-05 | P2 | `SecurityPipeline.ts`, `StaticAssetServer.ts`, `GatewayUi.ts` | تست جدید |
| 8 | اعتبارسنجی routeهای منبع + rollback ثبت پروژه | F-07 | P2 | `sourceRoutes.ts` | تست جدید |
| 9 | `issueToken` لیست خالی را رد کند | F-08 | P2 | `GatewayAuth.ts` | تست جدید |
| 10 | سخت‌سازی `git clone` | F-09 | P2 | `SourceSyncService.ts` | تست موجود + بازبینی |
| 11 | `npm audit fix` غیرشکننده، escape تک‌کوتیشن، cache ajv | F-10..12 | P3 | `package-lock.json`, `public/*.js`, `SecurityPipeline.ts` | audit + تست |
| 12 | اجرای کامل گیت‌ها و گزارش | — | — | `03-VERIFICATION.md` | خروجی واقعی |

شرط توقف: هر مرحله‌ای که تست موجود را بشکند همان‌جا اصلاح می‌شود، نه عبور.
