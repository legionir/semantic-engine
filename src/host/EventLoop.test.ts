/**
 * ییلد کردن به event loop — SE-PERF-01.
 *
 * ── چه چیزی بازتولید شد ───────────────────────────────────────────
 *
 * روی یک پروژهٔ ۴۰۰ فایلی، حین ایندکس، با poll هر ۲۰۰ms روی `/health`:
 *
 *     health probes: 111  failures: 1  worst latency: 10026ms
 *
 * یعنی سرور در طول ایندکس عملاً مرده بود. ریشه‌اش این است که
 * `await` روی یک promiseِ از قبل resolve شده فقط microtask تولید
 * می‌کند، و تا صف microtask خالی نشود نوبت به I/O نمی‌رسد.
 *
 * این تست‌ها همان تفاوت را مستقیم می‌سنجند، بدون اینکه به یک سرور
 * واقعی نیاز داشته باشند.
 */

import { yieldToEventLoop, createYielder, DEFAULT_YIELD_EVERY } from './EventLoop';

/**
 * آیا کارهای صفِ macrotask در طول یک حلقه فرصت اجرا پیدا می‌کنند؟
 *
 * ── چرا `setImmediate` و نه `setTimeout(0)` ───────────────────────
 *
 * نسخهٔ اول این کمکی از `setTimeout(0)` استفاده می‌کرد و زیر بار
 * کامل تست‌ها قرمز می‌شد: تایمرها و `setImmediate` در دو فاز
 * متفاوتِ event loop اجرا می‌شوند، و وقتی ماشین شلوغ است هیچ
 * تضمینی نیست که یک تایمر ۰ms داخل ۲۰۰ تکرار برسد.
 *
 * چیزی که واقعاً باید اثبات شود این است که «کنترل به event loop
 * برمی‌گردد یا نه»، و `setImmediate` دقیقاً همان را قطعی می‌سنجد.
 */
async function ranDuringLoop(
  body: (index: number) => Promise<void>,
  iterations = 200
): Promise<boolean> {
  let ioRan = false;
  const handle = setImmediate(() => {
    ioRan = true;
  });

  for (let index = 0; index < iterations; index += 1) {
    await body(index);
  }

  clearImmediate(handle);
  return ioRan;
}

describe('yieldToEventLoop', () => {
  it('lets a pending macrotask run, which an awaited promise does not', async () => {
    /*
    | خط پایه: `await Promise.resolve()` دقیقاً همان چیزی است که در
    | حلقه‌های استخراج بود. باید نشان دهد که I/O اجرا **نمی‌شود**.
    */
    const withMicrotaskOnly = await ranDuringLoop(() => Promise.resolve());
    expect(withMicrotaskOnly).toBe(false);

    const withRealYield = await ranDuringLoop(() => yieldToEventLoop());
    expect(withRealYield).toBe(true);
  });

  it('resolves without a value and can be awaited repeatedly', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});

describe('createYielder', () => {
  it('yields once every N calls, not on every call', async () => {
    let yields = 0;

    /*
    | شمارش ییلدهای واقعی: هر بار که کنترل به event loop برمی‌گردد،
    | یک `setImmediate` که پیش‌تر زمان‌بندی شده فرصت اجرا پیدا می‌کند.
    */
    const tick = createYielder(10);

    for (let index = 0; index < 100; index += 1) {
      let resumed = false;
      setImmediate(() => {
        resumed = true;
      });

      await tick();

      if (resumed) yields += 1;
    }

    expect(yields).toBe(10);
  });

  it('still lets I/O through inside a tight loop', async () => {
    const tick = createYielder(25);

    const ioRan = await ranDuringLoop(() => tick());

    expect(ioRan).toBe(true);
  });

  it('never yields when the interval is larger than the loop', async () => {
    const tick = createYielder(1000);

    const ioRan = await ranDuringLoop(() => tick());

    expect(ioRan).toBe(false);
  });

  it('defaults to a sensible interval', () => {
    expect(DEFAULT_YIELD_EVERY).toBe(25);
  });
});
