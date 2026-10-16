/**
 * محاسبهٔ شمارهٔ خط (۱-based) برای یک index در محتوای متنی.
 *
 * SE-DATA-07 — نسخهٔ قبلی یک خط بود:
 *
 *     content.substring(0, index).split('\n').length
 *
 * که به‌ازای *هر فراخوانی* یک کپی از کل پیشوند می‌ساخت و آن را
 * می‌شکست. استخراج‌گرهای JSON و CSS و HTML این را داخل حلقه صدا
 * می‌زنند، پس رفتار روی یک فایل بزرگ O(n²) می‌شود.
 */

/**
 * جدول شمارهٔ خط برای یک متن.
 *
 * یک بار آفست ابتدای هر خط ساخته می‌شود و بعد هر جست‌وجو با جست‌وجوی
 * دودویی انجام می‌گیرد. برای فایلی با n کاراکتر و k فراخوانی:
 * از `O(n·k)` به `O(n + k·log n)`.
 */
export class LineIndex {
  /** آفست شروع هر خط. `lineStarts[0]` همیشه صفر است. */
  private readonly lineStarts: number[];

  constructor(content: string) {
    const starts = [0];
    for (let index = 0; index < content.length; index++) {
      if (content.charCodeAt(index) === 10 /* \n */) starts.push(index + 1);
    }
    this.lineStarts = starts;
  }

  /** شمارهٔ خط ۱-مبنا برای یک آفست. */
  lineAt(offset: number): number {
    if (offset <= 0) return 1;

    let low = 0;
    let high = this.lineStarts.length - 1;

    // بزرگ‌ترین شروع خطی که از offset بیشتر نیست
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }

    return low + 1;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}

/*
| کش کوچک برای همان متنی که پشت سر هم پرسیده می‌شود.
|
| مصرف‌کننده‌ها `getLineNumber(content, i)` را داخل حلقه روی *یک*
| رشته صدا می‌زنند، پس نگه داشتن آخرین جدول تقریباً همهٔ فراخوانی‌ها
| را پوشش می‌دهد بدون اینکه چیزی زنده نگه داشته شود.
*/
let cachedContent: string | null = null;
let cachedIndex: LineIndex | null = null;

export function getLineNumber(content: string, index: number): number {
  if (cachedContent !== content || cachedIndex === null) {
    cachedContent = content;
    cachedIndex = new LineIndex(content);
  }
  return cachedIndex.lineAt(index);
}
