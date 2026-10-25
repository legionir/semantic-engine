/**
 * پوشاندن رشته‌ها و کامنت‌ها پیش از اجرای regexهای استخراج — SE-SYM-20.
 *
 * استخراج‌گرهای heuristic الگوهایشان را روی متن خام اجرا می‌کردند، پس
 * یک نمونهٔ کد داخل کامنت یا یک قطعه داخل رشته، تعریف تابع شمرده
 * می‌شد.
 *
 * قید طراحی: خروجی **دقیقاً هم‌طول** ورودی است و همهٔ `\n`ها سر جای
 * خودشان می‌مانند. هر استخراج‌گر از `match.index` برای محاسبهٔ شماره
 * خط استفاده می‌کند؛ اگر پوشاندن طول را عوض کند، هر شماره خطی پس از
 * آن غلط می‌شود — یعنی یک باگ را با باگ بدتری عوض کرده‌ایم.
 */

/*
| SE-SCAN-16 / SE-SYM-33: این فایل مجموعهٔ خودش را از «کجا `#` کامنت
| است» داشت، و `//` را بی‌قید در *هر* زبانی کامنت می‌گرفت. در Python
| `//` تقسیم صحیح است، پس `a // b or c` به `a` تبدیل می‌شد و هر چیزی
| که بعدش می‌آمد از دید الگوها می‌افتاد.
|
| حالا نشانه‌ها از جدول زبان‌ها می‌آیند — همان جدولی که `FileProcessor`
| هم برای شمردن خطوط کامنت از آن می‌خواند.
*/
import { commentSyntaxFor } from '../../language/languageMap';

const BLANK = ' ';

/**
 * همان متن، با محتوای رشته‌ها و کامنت‌ها تبدیل‌شده به فاصله.
 *
 * علامت‌های محصورکننده (`"`، `'`، `` ` ``) عمداً باقی می‌مانند: الگوها
 * گاهی به آن‌ها تکیه می‌کنند و حذفشان شکل خط را عوض می‌کند.
 */
export function maskLiteralsAndComments(content: string, languageId: string): string {
  const syntax = commentSyntaxFor(languageId);
  const lineMarkers = syntax.line;
  const blockOpen = syntax.block?.[0];
  const blockClose = syntax.block?.[1];
  const tripleQuotes = syntax.tripleQuoted === true;
  const out = content.split('');

  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let position = from; position < to && position < out.length; position++) {
      if (out[position] !== '\n') out[position] = BLANK;
    }
  };

  while (index < content.length) {
    const char = content[index];

    // ── کامنت خطی ──────────────────────────────────────────────────
    if (lineMarkers.some(marker => content.startsWith(marker, index))) {
      const end = content.indexOf('\n', index);
      blank(index, end === -1 ? content.length : end);
      index = end === -1 ? content.length : end;
      continue;
    }

    // ── کامنت بلوکی ────────────────────────────────────────────────
    if (blockOpen && blockClose && content.startsWith(blockOpen, index)) {
      const end = content.indexOf(blockClose, index + blockOpen.length);
      const stop = end === -1 ? content.length : end + blockClose.length;
      blank(index, stop);
      index = stop;
      continue;
    }

    // ── رشتهٔ سه‌نقل‌قولی (docstring) ───────────────────────────────
    if (tripleQuotes && (char === '"' || char === "'")) {
      const triple = content.slice(index, index + 3);
      if (triple === '"""' || triple === "'''") {
        const end = content.indexOf(triple, index + 3);
        const stop = end === -1 ? content.length : end + 3;
        blank(index + 3, stop - 3);
        index = stop;
        continue;
      }
    }

    // ── رشتهٔ معمولی ────────────────────────────────────────────────
    if (char === '"' || char === "'" || char === '`') {
      let cursor = index + 1;
      while (cursor < content.length) {
        if (content[cursor] === '\\') { cursor += 2; continue; }
        if (content[cursor] === char) break;
        /*
        | یک رشتهٔ تک‌نقل‌قولی که تا انتهای خط بسته نشود، تقریباً همیشه
        | یک آپاستروف در متن است، نه شروع رشته. بدون این مهار، یک
        | `don't` بقیهٔ فایل را می‌بلعد.
        */
        if (content[cursor] === '\n' && char !== '`') break;
        cursor++;
      }
      const closed = content[cursor] === char;
      blank(index + 1, cursor);
      index = closed ? cursor + 1 : cursor;
      continue;
    }

    index++;
  }

  return out.join('');
}

/**
 * کلمات کلیدی کنترلی که پیش از یک `(` می‌آیند ولی تعریف تابع نیستند.
 *
 * پوشاندن رشته و کامنت، `return foo(x);` را پنهان نمی‌کند — آن کد
 * واقعی است. چیزی که لو می‌دهد، کلمهٔ درست پیش از نام است.
 */
const CONTROL_KEYWORDS = new Set([
  'return', 'if', 'else', 'while', 'for', 'switch', 'case', 'do', 'goto',
  'sizeof', 'catch', 'foreach', 'synchronized', 'await', 'yield', 'throw',
  'new', 'delete', 'typeof', 'in', 'of', 'and', 'or', 'not',
]);

/**
 * آیا این خط، *فراخوانی* است و نه تعریف؟
 *
 * SE-SYM-20 دقیقاً این مورد را نام می‌برد: الگوی C روی
 * `return foo(x);` می‌افتد و `foo` را تعریف تابع ثبت می‌کند.
 * SE-SYM-28 حالت خویشاوندش است: خود `for` و `if` به‌عنوان تابع ثبت
 * می‌شوند، چون پیکربندی C — برخلاف C++ — هیچ فیلتری نداشت.
 */
export function isKeywordCallSite(line: string, name: string): boolean {
  if (CONTROL_KEYWORDS.has(name)) return true;

  const nameIndex = line.indexOf(name);
  if (nameIndex === -1) return false;

  /*
  | فقط جایی که نام بلافاصله با `(` دنبال شده، اصلاً فراخوانی است.
  |
  | بدون این قید، `impl Handler for Echo {` در Rust رد می‌شد چون کلمهٔ
  | پیش از `Echo` همان `for` است — که آنجا نحو است، نه کنترل جریان.
  | این را روی fixture گرفتیم: نوع `Echo` از ایندکس ناپدید شده بود.
  */
  const after = line.slice(nameIndex + name.length);
  if (!/^\s*\(/.test(after)) return false;

  const before = line.slice(0, nameIndex).trim();
  const lastWord = before.split(/[^\w$]+/).filter(Boolean).pop();

  return lastWord !== undefined && CONTROL_KEYWORDS.has(lastWord);
}

export { CONTROL_KEYWORDS };
