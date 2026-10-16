/**
 * ییلد کردن به event loop — SE-PERF-01.
 *
 * ── چه چیزی خراب بود ──────────────────────────────────────────────
 *
 * ایندکس‌کردن یک job ناهمگام است و بلافاصله `202` برمی‌گرداند، پس
 * روی کاغذ چیزی را بلاک نمی‌کرد. ولی حلقه‌های استخراج CPU-bound
 * هستند و `await`هایشان روی promiseهایی است که همان لحظه resolve
 * شده‌اند — یعنی فقط microtask تولید می‌کنند.
 *
 * صفِ microtask تا خالی نشود، نوبت به macrotask نمی‌رسد؛ و I/O
 * شبکه در صف macrotask است. نتیجه: کل سرور تا پایان ایندکس کر و لال
 * می‌شود.
 *
 * اندازه‌گیری‌شده روی ۴۰۰ فایل، حین ایندکس، با poll هر ۲۰۰ms روی
 * `/health`:
 *
 *     health probes: 111  failures: 1  worst latency: 10026ms
 *
 * یعنی یک درخواست سلامت کامل timeout شد و بدترین پاسخ ۱۰ ثانیه طول
 * کشید. برای هر load balancer ای این یعنی «سرویس مرده است».
 *
 * ── چرا `setImmediate` و نه `await Promise.resolve()` ─────────────
 *
 * `await Promise.resolve()` یک microtask دیگر است و دقیقاً همان
 * مشکل را دارد. `setImmediate` یک macrotask زمان‌بندی می‌کند، پس
 * صف I/O پیش از ادامهٔ کار فرصت اجرا پیدا می‌کند — که تمام چیزی
 * است که برای زنده ماندن سرور لازم است.
 */

/** یک بار برگشتن به event loop تا کارهای در انتظار اجرا شوند. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * پیش‌فرضِ «هر چند آیتم یک بار ییلد کن».
 *
 * کوچک‌تر یعنی سرور پاسخگوتر و ایندکس کمی کندتر. ۲۵ از روی همان
 * اندازه‌گیری انتخاب شد: بدترین تأخیر `/health` را از ۱۰ ثانیه به
 * زیر ۵۰ms آورد و زمان کل ایندکس را کمتر از ۵٪ بیشتر کرد.
 */
export const DEFAULT_YIELD_EVERY = 25;

/**
 * شمارنده‌ای که هر `every` بار یک ییلد انجام می‌دهد.
 *
 * داخل حلقه‌های داغ استفاده می‌شود، جایی که ییلد کردن در هر تکرار
 * خودش هزینهٔ محسوسی دارد.
 *
 *     const tick = createYielder();
 *     for (const item of items) {
 *       doWork(item);
 *       await tick();
 *     }
 */
export function createYielder(every: number = DEFAULT_YIELD_EVERY): () => Promise<void> {
  let seen = 0;

  return async () => {
    seen += 1;

    if (seen % every === 0) {
      await yieldToEventLoop();
    }
  };
}
