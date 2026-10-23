/**
 * Pure hashing, classification and metrics helpers of the file processor
 * (split from FileProcessor.ts, behavior unchanged).
 */

import * as fs from 'fs';
import { FileMetrics } from '../core/types/project-index.types';

import { commentSyntaxFor } from '../language/languageMap';

import { createHash } from 'crypto';

export async function hashAndCountWholeFile(
  absolutePath: string,
  encoding: string
): Promise<{ hash: string; lines: number }> {
  const hasher = createHash('sha256');
  let newlines = 0;
  let lastByte: number | undefined;

  /*
  | شمارش `\n` روی بایت خام برای UTF-8 و مشتقاتش درست است. برای
  | UTF-16 هر کاراکتر دو بایت است و بایت `0x0A` تنها با یک `0x00`
  | همراه می‌آید؛ چون این‌ها استثنا هستند و بریده شدنشان هم نادر
  | است، همان شمارش بایتی کافی است و `truncated` هشدارش را می‌دهد.
  */
  const wantsUtf16 = encoding === 'utf16le' || encoding === 'utf16be';

  /*
  | SE-PORT-01 / F-0029 — برای فایل‌های بزرگِ استریم‌شده هم باید hash روی
  | محتوای نرمال‌شده (LF) باشد تا با نسخهٔ کاملِ حافظه‌ای و بین OSها یکسان
  | بماند. CRLF→LF و CR تنها→LF، دقیقاً مثل `normalizeLineEndings`. یک CR
  | روی مرز chunk با `pendingCR` نگه داشته می‌شود تا با chunk بعدی درست
  | ترکیب شود، و در `end` فلاش می‌گردد. برای UTF-16 (استثنای نادر)
  | نرمال‌سازی رد می‌شود و همان بایت خام می‌ماند.
  */
  const crState = { pendingCR: false };
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absolutePath);
    const consume = (buffer: Buffer): void => {
      hasher.update(buffer);
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] === 0x0a) newlines++;
      }
      if (buffer.length > 0) lastByte = buffer[buffer.length - 1];
    };
    stream.on('data', (chunk: string | Buffer) => {
      const raw = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      consume(wantsUtf16 ? raw : normalizeLineEndingsChunk(raw, crState));
    });
    stream.on('error', reject);
    stream.on('end', () => {
      // فلاش CR نگه‌داشتهٔ انتهایی: CR تنها در انتهای فایل → LF.
      if (!wantsUtf16 && crState.pendingCR) consume(Buffer.from([0x0a]));
      resolve();
    });
  });

  if (wantsUtf16) newlines = Math.round(newlines);

  return {
    // مطابق countLines: اگر فایل با newline تمام نشده، یک خط اضافه
    hash: hasher.digest('hex'),
    lines: lastByte === 0x0a ? newlines : newlines + 1,
  };
}

/**
 * hash کل یک فایل باینری، بدون بارگذاری‌اش در حافظه.
 *
 * ── چه چیزی خراب بود ──────────────────────────────────────────────
 *
 * `createBinaryFileEntry` از همان بافر ۸KB ای که برای تشخیص باینری
 * خوانده شده بود hash می‌گرفت. یعنی همان SE-SCAN-01 که برای فایل
 * متنی رفع شد، در مسیر باینری دست‌نخورده مانده بود: هر تغییری بعد
 * از بایت ۸۱۹۲ روی hash اثری نداشت.
 *
 * بازتولید شد — دو فایل ۶MB که فقط بایت آخرشان فرق داشت:
 *
 *   hash of first 8KB only:  9f1dcbc35c350d6027f98be0  (هر دو یکسان)
 *   hash of whole file:      متفاوت
 *
 * یعنی برای هر باینریِ بزرگ‌تر از سقف، تشخیص کهنگی کور بود و ایندکس
 * هرگز به‌روز نمی‌شد.
 *
 * برخلاف مسیر متنی، این‌جا نه CR حذف می‌شود و نه خط شمرده می‌شود:
 * بایت‌های یک باینری همان چیزی هستند که هستند.
 */
export async function hashWholeBinary(absolutePath: string): Promise<string> {
  const hasher = createHash('sha256');

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absolutePath);
    stream.on('data', (chunk: string | Buffer) => {
      hasher.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });

  return hasher.digest('hex');
}

/**
 * تشخیص فایل تست بر اساس نام و مسیر.
 */
export function isTestFile(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  // الگوهای رایج تست
  const testPatterns = [
    /\.test\.[^.]+$/,        // file.test.ts
    /\.spec\.[^.]+$/,        // file.spec.ts
    /_test\.[^.]+$/,         // file_test.go
    /\/test\//,              // test/ directory
    /\/tests\//,             // tests/ directory
    /\/__tests__\//,         // **tests**/ directory
    /\/spec\//,              // spec/ directory
    /\/specs\//,             // specs/ directory
    /\.stories\.[^.]+$/,     // Storybook
    /\.e2e\.[^.]+$/,         // e2e tests
  ];
  return testPatterns.some(pattern => pattern.test(normalized));
}

/**
 * تشخیص فایل auto-generated.
 */
export function isGenerated(relativePath: string, content: string): boolean {
  const normalized = relativePath.toLowerCase();

  /*
  | SE-SCAN-11 — `.d.ts` به‌تنهایی نشانهٔ تولیدشدن نیست. فایل‌های
  | تعریف تایپِ دست‌نویس بسیار رایج‌اند و علامت خوردنشان یعنی از
  | هر نمای «کد دست‌نویس پروژه» بیرون می‌افتند. اگر واقعاً
  | تولیدشده باشند، بنر بالای فایل می‌گویدش — که پایین‌تر بررسی
  | می‌شود.
  */
  if (normalized.includes('/generated/')) return true;
  if (normalized.includes('/__generated__/')) return true;

  // بررسی محتوا: comment های auto-generated رایج
  const firstFewLines = content.substring(0, 500);
  const generatedPatterns = [
    /auto[-\s]?generated/i,
    /do not edit/i,
    /generated by/i,
    /this file is generated/i,
    /@generated/i,
  ];
  return generatedPatterns.some(pattern => pattern.test(firstFewLines));
}

/**
 * متریک‌های متنی پایه — بدون AST.
 *
 * SE-SCAN-10 — نسخهٔ قبلی سه اشتباه داشت: `#` را در *همهٔ* زبان‌ها
 * کامنت می‌گرفت (پس هر `#include` و `#define` در C کامنت شمرده
 * می‌شد و `loc` به‌شدت کم گزارش می‌شد)، `TODO` را داخل رشته و کد
 * هم می‌شمرد، و نشانهٔ کامنت بلوکی را زبان‌آگاه انتخاب نمی‌کرد.
 */
export function computeBasicMetrics(content: string, languageId: string | null): FileMetrics {
  const lines = content.split('\n');
  const style = commentSyntaxFor(languageId);

  let loc = 0;
  let blankLines = 0;
  let commentLines = 0;
  let todoCount = 0;
  let fixmeCount = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    let isComment = false;

    if (inBlockComment) {
      isComment = true;
      commentLines++;
      if (style.block && trimmed.includes(style.block[1])) inBlockComment = false;
    } else if (trimmed === '') {
      blankLines++;
    } else if (style.line.some(marker => trimmed.startsWith(marker))) {
      isComment = true;
      commentLines++;
    } else if (style.block && trimmed.startsWith(style.block[0])) {
      isComment = true;
      commentLines++;
      if (!trimmed.includes(style.block[1])) inBlockComment = true;
    } else {
      loc++;
    }

    /*
    | فقط داخل کامنت شمرده می‌شود. یک `TODO` در یک رشته — مثل
    | `const message = "TODO: ..."` — یادداشتی نیست که کسی بخواهد
    | پیدایش کند.
    */
    if (isComment) {
      const upper = line.toUpperCase();
      if (upper.includes('TODO')) todoCount++;
      if (upper.includes('FIXME')) fixmeCount++;
    }
  }

  return {
    loc,
    blankLines,
    commentLines,
    todoCount,
    fixmeCount,
    // فیلدهای زیر در فاز symbol extraction پر می‌شوند
    classes: 0,
    functions: 0,
    methods: 0,
    imports: 0,
    exports: 0,
    cyclomaticComplexity: 0,
    maxNestingDepth: 0,
  };
}

/**
 * نرمال‌سازی پایان خط روی بایت، معادلِ دقیق `normalizeLineEndings`
 * (`/\r\n?/g → '\n'`) برای UTF-8 — SE-PORT-01 / F-0029.
 *
 * چرا «دقیق» مهم است: پیاده‌سازی قبلی (`stripCarriageReturns`) صرفاً بایت
 * CR را حذف می‌کرد. برای CRLF درست است (CR حذف، LF می‌ماند)، ولی برای یک
 * CR تنها ( CR بدون LF بعدش) با مسیرِ کاملِ حافظه‌ای واگرا می‌شد:
 * `normalizeLineEndings` آن CR را به LF تبدیل می‌کند، پس hash و شمارش خط
 * فرق می‌کرد. یک فایل بزرگ با CR تنها (فایل‌های قدیمی macOS) hash
 * متفاوتی نسبت به نسخهٔ کوچکِ همان فایل می‌گرفت.
 *
 * تابع stateful است و یک CR در انتهای chunk را نگه می‌دارد تا بداند آیا
 * chunk بعدی با LF شروع می‌شود (CRLF روی مرز chunk) یا نه (CR تنها → LF).
 * `pendingCR` بیرونی است تا بین chunkها زنده بماند.
 */
export function normalizeLineEndingsChunk(
  input: Buffer,
  state: { pendingCR: boolean }
): Buffer {
  if (input.length === 0 && !state.pendingCR) return input;

  const out = Buffer.allocUnsafe(input.length + (state.pendingCR ? 1 : 0));
  let j = 0;
  let i = 0;

  // CR نگه‌داشته از chunk قبل: همیشه به LF ترجمه می‌شود مگر اینکه این
  // chunk با LF شروع شود، که آن‌وقت CRLF است و همان LF کفایت می‌کند.
  if (state.pendingCR) {
    if (input[0] === 0x0a) {
      // LF پایین‌تر در حلقه نوشته می‌شود؛ CR را دور می‌اندازیم.
    } else {
      out[j++] = 0x0a; // CR تنها → LF
    }
    state.pendingCR = false;
  }

  for (; i < input.length; i++) {
    const b = input[i]!;
    if (b === 0x0d) {
      // CR: یا CRLF است (LF بعدی) یا CR تنها. تا ندیده‌ایم نگهش می‌داریم؛
      // اگر آخرین بایت chunk باشد، state بعدی مشخص می‌کند.
      const next = i + 1 < input.length ? input[i + 1] : undefined;
      if (next !== undefined) {
        if (next === 0x0a) {
          out[j++] = 0x0a; // CRLF → LF، LF را هم مصرف کن
          i++;
        } else {
          out[j++] = 0x0a; // CR تنها → LF
        }
      } else {
        state.pendingCR = true;
      }
    } else {
      out[j++] = b;
    }
  }

  return out.subarray(0, j);
}
