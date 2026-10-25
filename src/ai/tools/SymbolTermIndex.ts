/**
 * SymbolTermIndex — ایندکس معکوسِ اصطلاح → نماد.
 *
 * ## SE-VEC-04
 *
 * `getKeywordCandidates` روی **همهٔ** نمادها `map` می‌زد و برای هرکدام
 * قطعه‌های نام، امضا، مستند، مسیر و خلاصه را از نو می‌ساخت — بدون هیچ
 * ایندکس معکوس یا کشی. اندازه‌گیری روی ایندکس واقعی
 * `semantic-engine/src` (۸٬۴۱۴ نماد):
 *
 * ```
 * ۲۰ پرس‌وجوی کلیدواژه‌ای:  ۲٬۲۰۱ms   →  ۱۱۰ms برای هر پرس‌وجو
 * ```
 *
 * و `discover_context` در هر فراخوانی جست‌وجو می‌کند، پس این هزینه
 * روی هر عملیاتِ بالادستی هم سوار می‌شود.
 *
 * ## قرارداد
 *
 * این یک **بهینه‌سازی** است، نه الگوریتم دوم: `candidatesFor` باید
 * دقیقاً همان مجموعه‌ای را بدهد که پیمایشِ کامل با
 * `matchesSegments` می‌داد. آزمونش این را روی هفت پرس‌وجو در برابر
 * پیاده‌سازیِ کندِ مرجع می‌سنجد.
 *
 * ساختِ ایندکس **تنبل** است: پروژه‌ای که هرگز جست‌وجو نمی‌شود،
 * هزینه‌اش را نمی‌پردازد.
 */

import { ProjectIndexReader } from '../ProjectIndexReader';
import { identifierSegments } from './queryTerms';

/**
 * حداقل طولِ پیشوندی که برای آن postings نگه می‌داریم.
 *
 * `matchesSegments` تطبیقِ پیشوندی دارد، پس ایندکسِ «فقط قطعهٔ کامل»
 * جواب‌ها را از دست می‌دهد. به‌جای ذخیرهٔ همهٔ پیشوندها (که ایندکس را
 * چند برابر می‌کند)، پیشوندهای از این طول به بالا ذخیره می‌شوند —
 * همان حداقلی که `queryTerms` برای اصطلاحِ لاتین اجازه می‌دهد.
 */
const MIN_PREFIX = 3;

/*
| دو ایندکس لازم است، نه یکی.
|
| `matchesSegments` سه حالت دارد و دو تای آنها **جهتِ مخالف** هم‌اند:
|
|   segment.startsWith(term)   ← «pars» باید «parser» را بگیرد
|   term.startsWith(segment)   ← «symbols» باید «symbol» را بگیرد
|
| نسخهٔ اول این کلاس هر دو را از یک نگاشتِ پیشوندی می‌خواند و نتیجه
| فاجعه بود: پرس‌وجوی «mod3» کلیدِ «mod» را می‌گرفت که پیشوندِ
| «mod13» هم هست، و ۲۹۰ نمادِ نامربوط برمی‌گشت. آزمونِ برابری با
| پیمایشِ کامل همین را گرفت.
*/
export class SymbolTermIndex {
  /** قطعهٔ دقیق → نمادها. برای حالتِ `term.startsWith(segment)`. */
  private readonly exact = new Map<string, Set<string>>();
  /** پیشوندِ قطعه → نمادها. برای حالتِ `segment.startsWith(term)`. */
  private readonly byPrefix = new Map<string, Set<string>>();
  /**
   * قطعه‌های هر نماد، کش‌شده در همان یک پیمایشِ ساخت.
   *
   * بدون این، امتیازدهی برای هر نامزد در **هر** پرس‌وجو دوباره
   * `identifierSegments` را روی نام، امضا، مستند، مسیر و خلاصه صدا
   * می‌زند. اندازه‌گیری: پرس‌وجوی «lsp client timeout» روی ایندکس
   * واقعی ۲٬۲۲۶ نامزد دارد؛ خودِ جست‌وجوی ایندکس ۰٫۲ms است و بقیهٔ
   * زمان صرفِ همین قطعه‌بندیِ تکراری می‌شد.
   */
  private readonly segmentsById = new Map<string, { name: string[]; context: string[] }>();
  private isBuilt = false;

  constructor(private readonly reader: ProjectIndexReader) {}

  get built(): boolean {
    return this.isBuilt;
  }

  get termCount(): number {
    return this.exact.size;
  }

  /**
   * شناسهٔ نمادهایی که با دست‌کم یکی از اصطلاحات می‌خوانند.
   *
   * **اجتماع** است نه اشتراک، چون امتیازدهی پایین‌دستی خودش تعداد
   * برخوردها را می‌شمارد؛ اشتراک گرفتن اینجا یعنی حذف کردنِ نامزدی
   * که با دو اصطلاح از سه اصطلاح می‌خواند.
   */
  /** قطعه‌های کش‌شدهٔ یک نماد. ایندکس را در صورت لزوم می‌سازد. */
  segmentsOf(symbolId: string): { name: string[]; context: string[] } | undefined {
    this.build();
    return this.segmentsById.get(symbolId);
  }

  candidatesFor(terms: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (terms.length === 0) return out;

    this.build();

    for (const term of terms) {
      if (!/^[a-z0-9_]+$/.test(term)) {
        /*
        | غیرلاتین: `matchesSegments` از «شامل» استفاده می‌کند، نه
        | پیشوند. زیررشتهٔ وسطِ کلمه با هیچ ایندکس پیشوندی پیدا
        | نمی‌شود، پس اینجا کلیدها پیمایش می‌شوند — روی مجموعهٔ
        | کلیدها، نه روی همهٔ نمادها.
        */
        for (const [segment, ids] of this.exact) {
          if (segment.includes(term)) for (const id of ids) out.add(id);
        }
        continue;
      }

      // حالت ۱ و ۲: برابری و `segment.startsWith(term)`.
      const withPrefix = this.byPrefix.get(term);
      if (withPrefix) for (const id of withPrefix) out.add(id);

      /*
      | حالت ۳: `term.startsWith(segment)` — قطعه‌ای که *کوتاه‌تر* از
      | اصطلاح است. اینجا باید ایندکسِ **دقیق** خوانده شود؛ خواندنِ
      | ایندکسِ پیشوندی یعنی «mod3» کلیدِ «mod» را می‌گیرد و با
      | «mod13» هم می‌خورد، که غلط است.
      */
      for (let len = MIN_PREFIX; len < term.length; len++) {
        const shorter = this.exact.get(term.slice(0, len));
        if (shorter) for (const id of shorter) out.add(id);
      }
    }

    return out;
  }

  private build(): void {
    if (this.isBuilt) return;

    for (const symbol of this.reader.getAllSymbols()) {
      const file = this.reader.getFileById(symbol.fileId);

      const nameSegments = identifierSegments(symbol.name);
      const contextSegments = [
        ...(symbol.fullyQualifiedName ? identifierSegments(symbol.fullyQualifiedName) : []),
        ...(symbol.signature ? identifierSegments(symbol.signature) : []),
        ...(symbol.documentation ? identifierSegments(symbol.documentation) : []),
        ...(file?.path ? identifierSegments(file.path) : []),
        ...(file?.aiMetadata?.summary ? identifierSegments(file.aiMetadata.summary) : []),
      ];

      this.segmentsById.set(symbol.id, { name: nameSegments, context: contextSegments });

      const segments = [...nameSegments, ...contextSegments];

      for (const segment of segments) {
        this.add(this.exact, segment, symbol.id);
        this.add(this.byPrefix, segment, symbol.id);

        // پیشوندها، تا `segment.startsWith(term)` از دست نرود.
        for (let len = MIN_PREFIX; len < segment.length; len++) {
          this.add(this.byPrefix, segment.slice(0, len), symbol.id);
        }
      }
    }

    this.isBuilt = true;
  }

  private add(target: Map<string, Set<string>>, term: string, symbolId: string): void {
    let bucket = target.get(term);
    if (!bucket) {
      bucket = new Set<string>();
      target.set(term, bucket);
    }
    bucket.add(symbolId);
  }
}
