/**
 * queryTerms — توکن‌سازی و تطبیقِ اصطلاحات پرس‌وجو با شناسه‌های کد.
 *
 * ## SE-VEC-11 — چرا این ماژول از `SemanticSearchTool` بیرون کشیده شد
 *
 * توکن‌ساز قبلی این بود:
 *
 * ```ts
 * text.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1)
 * ```
 *
 * و تطبیق، تطبیقِ **زیررشتهٔ خام** روی نام و متنِ الحاقی. دو پیامد که
 * روی ایندکس واقعی این پکیج (۷٬۸۹۹ نماد) اندازه‌گیری شدند:
 *
 * ```
 * q="at"  → 6497 نامزد (۸۲٪ کل ایندکس)  نتایج برتر: aiMetadata، cyclomaticComplexity
 * q="is"  → 5600 نامزد                   نتایج برتر: existing، existing، existing
 * q="on"  → 5531 نامزد                   نتایج برتر: json، functions
 * q="in"  → 4823 نامزد
 * q="fix the checkout flow" → نتیجهٔ اول: otherEvents      («the» ⊂ «oTHEr»)
 * ```
 *
 * یعنی یک واژهٔ دوحرفیِ پرکاربرد، ۸۲٪ ایندکس را نامزد می‌کرد و صدرِ
 * نتایج را با شناسه‌های بی‌ربط پر می‌کرد. برای موتوری که کارش «پیدا
 * کردن مرتبط‌ترین‌ها» است، این یعنی سیگنال زیر نویز دفن شده بود.
 *
 * ## دو تغییر
 *
 * ۱. **واژه‌های ایست حذف می‌شوند و توکنِ کوتاه‌تر از سه حرف کنار
 *    می‌رود.** فهرست عمداً کوتاه است و فقط واژه‌های نقشیِ انگلیسی را
 *    دارد؛ واژه‌های دامنه‌ای (`get`, `set`, `new`) نگه داشته می‌شوند
 *    چون در کد معنی دارند.
 *
 * ۲. **تطبیق روی قطعه‌های شناسه است، نه زیررشتهٔ خام.** `aiMetadata`
 *    به `['ai', 'metadata']` شکسته می‌شود، پس `meta` (پیشوندِ یک
 *    قطعه) می‌خورد و `tada` (زیررشتهٔ تصادفی) نمی‌خورد.
 *
 * اثر اندازه‌گیری‌شده روی همان ایندکس: پرس‌وجوهای واقعی تقریباً
 * دست‌نخورده ماندند و نویز از بین رفت.
 *
 * ```
 * پرس‌وجو                    پیش    پس
 * "at"                       6497     0
 * "is"                       5600     0
 * "fix the checkout flow"      32    13
 * "lsp client timeout"        250   246
 * "token budget"               58    58
 * "authenticate user"           6     6
 * ```
 */

/**
 * واژه‌های نقشیِ انگلیسی.
 *
 * عمداً **کوتاه** است. هر واژه‌ای که در کد معنای دامنه‌ای دارد
 * (`get`, `set`, `new`, `add`, `run`, `map`, `key`) اینجا نیست، حتی
 * اگر در انگلیسیِ روزمره پرکاربرد باشد.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'not',
  'are', 'was', 'has', 'have', 'had', 'its', 'but', 'all', 'any', 'out',
  'than', 'then', 'they', 'them', 'their', 'there', 'here', 'what', 'which',
  'while', 'also', 'been', 'were', 'will', 'would', 'should', 'could', 'may',
  'might', 'must', 'shall', 'let', 'our', 'your', 'his', 'her', 'via', 'per',
  'about', 'after', 'before', 'because', 'does', 'each', 'more', 'most',
  'some', 'such', 'only', 'other', 'over', 'under', 'very', 'just',
]);

/** کوتاه‌تر از این، بی‌آنکه واژهٔ ایست باشد هم نویز است. */
const MIN_TERM_LENGTH = 3;

/**
 * آیا این اصطلاح از خطِ لاتین است.
 *
 * SE-VEC-05 — قاعدهٔ «حداقل سه حرف» یک قاعدهٔ **انگلیسی** است. در
 * چینی و ژاپنی یک یا دو کاراکتر می‌تواند یک واژهٔ کامل باشد
 * («向量» = بردار)، و فهرست واژه‌های ایست هم فقط انگلیسی است. اعمال
 * کردن هر دو روی خطوط دیگر یعنی حذفِ کاملِ آن زبان‌ها.
 */
function isLatin(term: string): boolean {
  return /^[a-z0-9_]+$/.test(term);
}

/**
 * اصطلاحات قابل استفادهٔ یک پرس‌وجو.
 *
 * ممکن است آرایهٔ خالی برگرداند (پرس‌وجویی که فقط واژهٔ ایست دارد) و
 * فراخوان باید با آن کنار بیاید — «هیچ نتیجه» پاسخِ درستی است برای
 * «the and of to».
 */
export function queryTerms(text: string): string[] {
  /*
  | SE-VEC-05 — الگو یونی‌کدی است.
  |
  | قبلاً `split(/[^a-z0-9_]+/)` بود، یعنی هر حرفِ غیرِ a-z مرزِ
  | واژه حساب می‌شد و در عمل دور ریخته می‌شد. اندازه‌گیری روی
  | ایندکس واقعی: پرس‌وجوی «بردار»، «向量» و «симв» هر سه صفر نتیجه
  | می‌دادند — روی محصولی که مستنداتِ خودش فارسی است.
  */
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(t => {
      if (t.length === 0) return false;
      if (!isLatin(t)) return true;
      return t.length >= MIN_TERM_LENGTH && !STOPWORDS.has(t);
    });
}

/**
 * یک شناسه یا مسیر را به قطعه‌های معنادارش می‌شکند.
 *
 * `LspClientOptions` → `['lsp', 'client', 'options']`
 * `src/ai/tools/find_symbol.ts` → `['src', 'ai', 'tools', 'find', 'symbol', 'ts']`
 * `HTTPServer` → `['http', 'server']`
 */
export function identifierSegments(text: string): string[] {
  return text
    // مرزِ camelCase
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    // مرزِ HTTPServer → HTTP Server
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2')
    .toLowerCase()
    // SE-VEC-05 — نگه داشتنِ حروفِ غیرلاتین.
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * آیا اصطلاح با یکی از قطعه‌ها می‌خواند.
 *
 * برابری یا **پیشوند** — پیشوند برای اینکه `symbol` با `symbols` و
 * `pars` با `parser` بخورد، بدون اینکه به زیررشتهٔ وسطِ کلمه برگردیم.
 */
export function matchesSegments(term: string, segments: readonly string[]): boolean {
  const latin = isLatin(term);

  for (const segment of segments) {
    if (segment === term) return true;

    /*
    | تطبیقِ پیشوندی فقط برای خطِ لاتین.
    |
    | در چینی، «向» پیشوندِ «向量» است ولی معنایش فرق می‌کند و
    | مرزِ واژه هم وجود ندارد؛ پیشوندگیری آن‌جا همان نویزی را
    | می‌سازد که SE-VEC-11 برای انگلیسی توصیفش کرد. برای
    | غیرلاتین، «شاملِ» کافی است چون خودِ واژه‌ها به‌هم چسبیده
    | نوشته می‌شوند.
    */
    if (!latin) {
      if (segment.includes(term)) return true;
      continue;
    }

    if (segment.startsWith(term)) return true;
    // جمعِ ساده: پرس‌وجوی «symbols» باید قطعهٔ «symbol» را هم بگیرد.
    if (term.startsWith(segment) && segment.length >= MIN_TERM_LENGTH) return true;
  }
  return false;
}
