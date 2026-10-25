/**
 * محدودهٔ خطی دستورهای import — SE-LSP-02.
 *
 * `documentSymbol` نام‌های import شده را symbol سطح‌بالا گزارش می‌کند و
 * راهی در خودِ پاسخ نیست که تعریف را از ارجاع جدا کند: نه `detail`
 * می‌آید، نه tag، و شکل `range`/`selectionRange` هم — که اولین حدس
 * بود — با `import * as X` و `import { A as B }` نقض می‌شود.
 *
 * پس به متن نگاه می‌کنیم. کاری که اینجا می‌شود عمداً کوچک است: فقط
 * «کدام خط‌ها دستور import‌اند»، نه تجزیهٔ import (که کار
 * `TSDependencyExtractor` است و کامپایلر واقعی را دارد). هر symbolای
 * که کاملاً داخل این خط‌ها بیفتد، اتصال import است نه تعریف.
 *
 * متن پیش از اسکن ماسک می‌شود (`maskLiteralsAndComments`) تا کلمهٔ
 * `import` داخل رشته و کامنت شمرده نشود — همان SE-SYM-20 که فاز ۱۶
 * برای استخراج‌گرهای heuristic حل کرد.
 */

import { maskLiteralsAndComments } from '../heuristic/LiteralMask';

/** بازهٔ خطی صفرمبنا و شامل هر دو سر. */
export interface LineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/** حداکثر چند خط یک دستور import می‌تواند ادامه پیدا کند. */
const MAX_IMPORT_STATEMENT_LINES = 200;

/*
| شروع یک دستور import در زبان‌های خانوادهٔ C/JS.
|
| `import(` عمداً بیرون است: آن یک عبارت است و متغیری که نتیجه‌اش را
| می‌گیرد symbol واقعی است.
*/
const JS_IMPORT_START = /^\s*(?:import|export)\s*(?![(=])(?:[\s{*'"]|type\b|default\b)/;
const JS_REQUIRE = /\brequire\s*\(/;
const PY_IMPORT_START = /^\s*(?:import\s+\S|from\s+\S+\s+import\b)/;

/** آیا این خط، دستور را تمام می‌کند؟ */
function terminatesStatement(line: string): boolean {
  // `} from './a';` یا `import { A } from './a'` یا `import './a';`
  return /\bfrom\s*['"][^'"]*['"]/.test(line) || /^\s*import\s*['"][^'"]*['"]/.test(line);
}

/**
 * خط‌هایی که دستور import‌اند.
 *
 * برای زبان‌هایی که نمی‌شناسیم، فهرست خالی برمی‌گردد — یعنی هیچ
 * symbolای فیلتر نمی‌شود. حذف نکردن، از حذف اشتباه بهتر است.
 */
export function findImportLineSpans(content: string, languageId: string): LineSpan[] {
  const normalized = languageId.toLowerCase();
  const masked = maskLiteralsAndComments(content, languageId);
  const lines = masked.split('\n');

  if (normalized === 'python') return pythonSpans(lines);
  if (!isCFamily(normalized)) return [];

  const spans: LineSpan[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (JS_REQUIRE.test(line)) {
      spans.push({ startLine: index, endLine: index });
      continue;
    }
    if (!JS_IMPORT_START.test(line)) continue;

    /*
    | یک `export const x = 1` هم با `export` شروع می‌شود ولی import
    | نیست. تنها چیزی که آن را import می‌کند، وجود `from` است — و
    | بدون آن، دستور را رها می‌کنیم.
    */
    let end = index;
    while (end < lines.length && end - index < MAX_IMPORT_STATEMENT_LINES) {
      if (terminatesStatement(lines[end])) {
        spans.push({ startLine: index, endLine: end });
        index = end;
        break;
      }
      /*
      | خط خالی یا خطی که آشکارا شروع چیز دیگری است، یعنی دستور
      | ناتمام مانده (فایل نیمه‌تایپ‌شده در watch). ادامه دادن تا
      | انتهای فایل، همهٔ symbolها را import می‌کند.
      */
      if (end > index && (lines[end].trim() === '' || /^\s*(?:export|class|function|const|let|var)\b/.test(lines[end]))) {
        break;
      }
      end++;
    }
  }
  return spans;
}

function pythonSpans(lines: string[]): LineSpan[] {
  const spans: LineSpan[] = [];
  lines.forEach((line, index) => {
    if (PY_IMPORT_START.test(line)) spans.push({ startLine: index, endLine: index });
  });
  return spans;
}

function isCFamily(languageId: string): boolean {
  return (
    languageId === 'typescript' ||
    languageId === 'typescriptreact' ||
    languageId === 'javascript' ||
    languageId === 'javascriptreact' ||
    languageId === 'tsx' ||
    languageId === 'jsx'
  );
}

/** آیا این خط داخل یکی از بازه‌هاست (شامل مرزها)؟ */
export function isInsideSpans(line: number, spans: readonly LineSpan[]): boolean {
  return spans.some(span => line >= span.startLine && line <= span.endLine);
}
