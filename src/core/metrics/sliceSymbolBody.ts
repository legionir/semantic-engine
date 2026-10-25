/**
 * برش بدنهٔ یک symbol از متن فایل — SE-METRIC-01.
 *
 * محاسبه‌گرهای الگومحور یک رشته می‌گیرند و نقاط تصمیم را می‌شمارند.
 * تا فاز ۲۳ آن رشته *کل فایل* بود، پس هر symbol در یک فایل، عدد یکسانی
 * می‌گرفت. چیزی که لازم است، فقط خطوط خودِ symbol است.
 *
 * دو قید:
 *
 *   ۱. **بدنهٔ توابع تودرتو پاک می‌شود.** مسیر TS/JS از اول این کار را
 *      می‌کرد (`calculateComplexity` وارد تابع تودرتو نمی‌شود)؛ بدون
 *      این، الگومحورها معنای متفاوتی از همان متریک می‌دادند.
 *
 *   ۲. **پاک کردن، خط را حذف نمی‌کند بلکه خالی می‌کند.** شمارش خط در
 *      این تابع اهمیتی ندارد ولی هم‌راستا ماندن با
 *      `maskLiteralsAndComments` — که صریحاً هم‌طول می‌ماند — یعنی
 *      این دو را می‌شود پشت سر هم زد بدون اینکه موقعیت‌ها بلغزند.
 */

import { SymbolEntry } from '../types/project-index.types';

/** آیا این symbol خودش یک واحد اجرایی است که پیچیدگی جدا می‌گیرد؟ */
function isExecutable(symbol: SymbolEntry): boolean {
  return symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'property';
}

/**
 * خطوط `[symbol.line, symbol.endLine]`، منهای بدنهٔ symbolهای تودرتو.
 *
 * @param siblings همهٔ symbolهای همان فایل. فقط آن‌هایی که *کاملاً*
 * داخل بازهٔ این symbol هستند و خودشان اجرایی‌اند، پاک می‌شوند.
 */
export function sliceSymbolBody(
  content: string,
  symbol: SymbolEntry,
  siblings: readonly SymbolEntry[]
): string {
  const lines = content.split('\n');

  const start = Math.max(1, symbol.line);
  /*
  | `endLine` گاهی برابر `line` است — یعنی استخراج‌گر پایان بلوک را
  | پیدا نکرده. در آن حالت فقط همان یک خط برداشته می‌شود. برگشت به کل
  | فایل وسوسه‌انگیز است ولی دقیقاً همان باگی است که این تابع برای
  | رفعش نوشته شده.
  */
  const end = Math.min(lines.length, Math.max(start, symbol.endLine || start));

  const body = lines.slice(start - 1, end);

  for (const other of siblings) {
    if (other.id === symbol.id) continue;
    if (!isExecutable(other)) continue;

    const otherEnd = other.endLine || other.line;
    const nested = other.line > start && otherEnd <= end;
    if (!nested) continue;

    for (let line = other.line; line <= otherEnd; line++) {
      const index = line - start;
      if (index >= 0 && index < body.length) body[index] = '';
    }
  }

  return body.join('\n');
}
