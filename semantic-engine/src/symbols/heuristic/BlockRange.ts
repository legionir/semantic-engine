/**
 * تشخیص خط پایان یک symbol — SE-DATA-01.
 *
 * استخراج‌گرهای heuristic هیچ‌وقت پایان بلوک را حساب نمی‌کردند و
 * `endLine` را برابر `line` می‌گذاشتند. نتیجه‌اش یک زنجیرهٔ خرابی بود:
 * `findSymbolAtLine` بر پایهٔ بازه کار می‌کند، پس هیچ callerی پیدا
 * نمی‌شد؛ chunkهای بردار تک‌خطی می‌شدند؛ و برش بدنهٔ تابع صفر خط
 * می‌داد.
 *
 * سه سبک بلوک در زبان‌های پشتیبانی‌شده وجود دارد و هر سه اینجا
 * پیاده شده‌اند. مشترکاً یک اصل رعایت می‌شود: **پیش از شمردن هر
 * نشانه‌ای، رشته و کامنت باید کنار بروند.** یک `{` داخل یک رشته یا یک
 * `end` داخل یک کامنت کافی است تا از آن نقطه به بعد همهٔ بازه‌ها
 * جابه‌جا شوند.
 */

export type BlockStyle = 'brace' | 'indent' | 'ruby';

const INDENT_LANGUAGES = new Set(['python']);
const RUBY_LANGUAGES = new Set(['ruby']);

export function blockStyleFor(languageId: string): BlockStyle {
  const normalized = languageId.toLowerCase();
  if (INDENT_LANGUAGES.has(normalized)) return 'indent';
  if (RUBY_LANGUAGES.has(normalized)) return 'ruby';
  /*
  | پیش‌فرض آکولاد است: اکثریت زبان‌های پشتیبانی‌شده brace-محورند و
  | برای زبان ناشناخته هم محتمل‌ترین حدس همین است. بدترین حالتِ حدسِ
  | غلط، برگشتن به همان تک‌خطی قبلی است — نه چیزی بدتر.
  */
  return 'brace';
}

/**
 * چند خط جلوتر دنبال آکولاد باز بگردیم پیش از اینکه نتیجه بگیریم
 * این تعریف اصلاً بدنه ندارد.
 *
 * امضاهای چندخطی واقعی به‌ندرت از چند خط بیشترند؛ سقف، مانع آن است
 * که یک اعلانِ بدون بدنه بدنهٔ تابع بعدی را به خودش نسبت دهد.
 */
const MAX_LINES_TO_FIND_OPENING = 30;

export function findBlockEnd(
  lines: readonly string[],
  startLine: number,
  style: BlockStyle
): number {
  if (startLine < 1 || startLine > lines.length) return startLine;

  switch (style) {
    case 'indent':
      return findIndentBlockEnd(lines, startLine);
    case 'ruby':
      return findRubyBlockEnd(lines, startLine);
    default:
      return findBraceBlockEnd(lines, startLine);
  }
}

// ── سبک آکولاد ────────────────────────────────────────────────────────────

interface ScanState {
  inLineComment: boolean;
  inBlockComment: boolean;
  quote: string | null;
}

/**
 * یک خط را با در نظر گرفتن وضعیت رشته/کامنتِ منتقل‌شده از خط قبل
 * پیمایش می‌کند و برای هر کاراکترِ «واقعی» callback را صدا می‌زند.
 *
 * برگرداندن `true` از callback پیمایش را متوقف می‌کند.
 */
function scanLine(
  line: string,
  state: ScanState,
  onChar: (char: string, index: number) => boolean | void
): void {
  state.inLineComment = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];

    if (state.inBlockComment) {
      if (char === '*' && next === '/') {
        state.inBlockComment = false;
        index++;
      }
      continue;
    }

    if (state.quote) {
      if (char === '\\') {
        index++;             // کاراکتر بعدی escape شده است
        continue;
      }
      if (char === state.quote) state.quote = null;
      continue;
    }

    if (char === '/' && next === '/') return;         // تا انتهای خط، کامنت
    /*
    | `#` تنها وقتی کل خط را بی‌اثر می‌کند که *اولین* کاراکتر غیرفاصلهٔ
    | خط باشد. این یک قاعده پوشش می‌دهد: کامنت Python و شل و PHP، و
    | دستور پیش‌پردازندهٔ C.
    |
    | دستور پیش‌پردازنده هم باید کنار برود، نه فقط کامنت: یک
    | `#define BEGIN_SCOPE {` آکولاد بازِ بدون جفت دارد و بدون این
    | قاعده، تابع بعدی هم به این symbol چسبانده می‌شود — که در آزمایش
    | دقیقاً همین اتفاق افتاد.
    |
    | `#` وسط خط عمداً کاراکتر عادی است: `this.#count` در JavaScript
    | نحو است، نه کامنت.
    */
    if (char === '#' && line.slice(0, index).trim() === '') return;
    if (char === '/' && next === '*') {
      state.inBlockComment = true;
      index++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      state.quote = char;
      continue;
    }

    if (onChar(char, index) === true) return;
  }
}

function findBraceBlockEnd(lines: readonly string[], startLine: number): number {
  const state: ScanState = { inLineComment: false, inBlockComment: false, quote: null };
  let depth = 0;
  let opened = false;
  let endLine = startLine;

  const limit = Math.min(lines.length, startLine + MAX_LINES_TO_FIND_OPENING);

  for (let index = startLine - 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    let finished = false;
    let declaration = false;

    scanLine(line, state, char => {
      if (char === '{') {
        depth++;
        opened = true;
        return;
      }
      if (char === '}') {
        depth--;
        if (opened && depth <= 0) {
          endLine = index + 1;
          finished = true;
          return true;
        }
        return;
      }
      /*
      | `;` در عمق صفر و پیش از هر آکولادی یعنی این تعریف بدنه ندارد:
      | اعلان C، متد interface، متد abstract، یا یک arrow با بدنهٔ
      | عبارتی. بدون این بررسی، تابع تا آکولاد تعریف *بعدی* جلو
      | می‌رفت و آن را به این symbol نسبت می‌داد.
      */
      if (char === ';' && !opened && depth === 0) {
        declaration = true;
        return true;
      }
    });

    if (finished) return endLine;
    if (declaration) return startLine;

    // هنوز آکولادی باز نشده و از سقف جست‌وجو گذشتیم
    if (!opened && index + 1 >= limit) return startLine;
  }

  /*
  | بلوکی باز شد و هرگز بسته نشد: فایل بریده یا کد ناقص. پایان فایل
  | بهترین حدس موجود است و از تک‌خطی گزارش کردن مفیدتر.
  */
  return opened ? lines.length : startLine;
}

// ── سبک تورفتگی (Python) ──────────────────────────────────────────────────

/**
 * عرض بصری تورفتگی.
 *
 * مقایسهٔ طول خام رشته یک tab را با یک space برابر می‌گیرد، و آن‌وقت
 * بدنه‌ای که با tab تورفته، «هم‌سطح» با تعریف دیده می‌شود و بلافاصله
 * بریده می‌شود.
 */
export function indentWidth(line: string, tabSize = 4): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width += tabSize - (width % tabSize);
    else break;
  }
  return width;
}

function isBlank(line: string | undefined): boolean {
  return (line ?? '').trim() === '';
}

function findIndentBlockEnd(lines: readonly string[], startLine: number): number {
  const headerIndent = indentWidth(lines[startLine - 1] ?? '');

  // ۱. پایان امضا: خطی که با `:` تمام می‌شود (امضا می‌تواند چندخطی باشد)
  let headerEnd = startLine;
  let parenDepth = 0;
  const state: ScanState = { inLineComment: false, inBlockComment: false, quote: null };

  for (let index = startLine - 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    let lastRealChar = '';
    let colonAtDepthZero = -1;

    scanLine(line, state, (char, position) => {
      if (char === '(' || char === '[' || char === '{') parenDepth++;
      else if (char === ')' || char === ']' || char === '}') parenDepth--;
      else if (char === ':' && parenDepth === 0) colonAtDepthZero = position;
      if (!/\s/.test(char)) lastRealChar = char;
    });

    if (colonAtDepthZero !== -1) {
      headerEnd = index + 1;

      // چیزی بعد از `:` روی همان خط → بدنهٔ تک‌خطی
      const after = line.slice(colonAtDepthZero + 1).trim();
      if (after !== '' && !after.startsWith('#')) return headerEnd;
      break;
    }

    if (lastRealChar === '' && parenDepth === 0 && index + 1 > startLine) break;
    if (index + 1 >= startLine + MAX_LINES_TO_FIND_OPENING) return startLine;
  }

  // ۲. بدنه: هر خطی که از تعریف تورفته‌تر باشد
  let endLine = headerEnd;
  for (let index = headerEnd; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (isBlank(line)) continue;                    // خط خالی بلوک را نمی‌بندد
    if (indentWidth(line) <= headerIndent) break;
    endLine = index + 1;
  }

  return endLine;
}

// ── سبک کلیدواژه (Ruby) ───────────────────────────────────────────────────

const RUBY_OPENERS = /^(?:def|class|module|begin|case|if|unless|while|until|for)\b/;
const RUBY_DO = /\bdo\s*(?:\|[^|]*\|)?\s*$/;
const RUBY_END = /^end\b|\bend$/;

/** حذف رشته و کامنت پیش از شمارش کلیدواژه. */
function stripRuby(line: string): string {
  let out = '';
  let quote: string | null = null;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (quote) {
      if (char === '\\') { index++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') break;
    out += char;
  }

  return out.trim();
}

function findRubyBlockEnd(lines: readonly string[], startLine: number): number {
  const first = stripRuby(lines[startLine - 1] ?? '');

  /*
  | متد بدون `end` در Ruby 3: `def square(x) = x * x`. اگر شمرده شود،
  | اولین `end` بعدی — که مال بلوک والد است — به این متد نسبت داده
  | می‌شود.
  */
  if (/^def\s+[^=]*=(?!=)/.test(first)) return startLine;

  let depth = 0;

  for (let index = startLine - 1; index < lines.length; index++) {
    const line = stripRuby(lines[index] ?? '');
    if (line === '') continue;

    if (RUBY_OPENERS.test(line)) depth++;
    else if (RUBY_DO.test(line)) depth++;

    if (RUBY_END.test(line)) {
      depth--;
      if (depth <= 0) return index + 1;
    }
  }

  return lines.length;
}

// ── بازهٔ جفت‌شونده روی متن خام ────────────────────────────────────────────

const PAIRS: Readonly<Record<string, string>> = { '{': '}', '[': ']', '(': ')' };

/**
 * ایندکس بستهٔ متناظر با یک بازکنندهٔ مشخص، یا `-1`.
 *
 * برای JSON و CSS لازم است، جایی که بازهٔ symbol روی *متن خام* تعریف
 * می‌شود نه روی خطوط. رشته‌ها رد می‌شوند، چون یک `}` داخل مقدار رشته‌ای
 * (مثلاً یک قالب یا یک URL) وگرنه بازه را زودتر می‌بندد.
 */
export function findMatchingDelimiter(content: string, openIndex: number): number {
  const open = content[openIndex];
  const close = PAIRS[open];
  if (!close) return -1;

  let depth = 0;
  let quote: string | null = null;

  for (let index = openIndex; index < content.length; index++) {
    const char = content[index];

    if (quote) {
      if (char === '\\') { index++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }

    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/**
 * ایندکس پایانِ بستهٔ تگ متناظر در HTML.
 *
 * تگ‌های تودرتوی هم‌نام شمرده می‌شوند تا `<div><div></div></div>` بازهٔ
 * درست بدهد. تگ خودبسته (`<br/>`) بازه‌ای ندارد.
 */
export function findMatchingTagEnd(
  content: string,
  tagName: string,
  openIndex: number
): number {
  const openTag = new RegExp(`<${tagName}\\b`, 'gi');
  const closeTag = new RegExp(`</${tagName}\\s*>`, 'gi');

  const selfClosing = /^<[^>]*\/>/.exec(content.slice(openIndex));
  if (selfClosing) return openIndex + selfClosing[0].length - 1;

  let depth = 0;
  let cursor = openIndex;

  for (;;) {
    openTag.lastIndex = cursor;
    closeTag.lastIndex = cursor;
    const next = openTag.exec(content);
    const end = closeTag.exec(content);

    if (!end) return -1;

    if (next && next.index < end.index) {
      depth++;
      cursor = next.index + next[0].length;
      continue;
    }

    depth--;
    if (depth <= 0) return end.index + end[0].length - 1;
    cursor = end.index + end[0].length;
  }
}
