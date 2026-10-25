/**
 * PatternComplexityCalculator — محاسبه تقریبی Cyclomatic Complexity با regex.
 *
 * این روش جایگزین AST-based نیست، ولی برای زبان‌هایی که هنوز parser ندارند
 * (Python, Go, PHP, Bash, ...) یک تخمین قابل قبول می‌دهد.
 *
 * فرمول: ۱ (base) + تعداد نقاط تصمیم
 *
 * ── SE-METRIC-03 ─────────────────────────────────────────────────────
 *
 * نسخهٔ قبلی یک `stripComments` داشت که برای *همهٔ* زبان‌ها یکی بود:
 *
 * ```ts
 * line.replace(/(?<!:)\/\/.*$/, '').replace(/#.*$/, '')
 * ```
 *
 * سه اشتباه در یک خط:
 *
 *   ۱. `//` در Python تقسیم صحیح است. `return (a // b) or 0` به
 *      `return (a` تبدیل می‌شد و `or` از شمارش می‌افتاد — عدد ۱
 *      به‌جای ۲.
 *   ۲. `#` داخل رشته کامنت نیست. `return "a # b" or c` همان بلا را
 *      سرش می‌آورد.
 *   ۳. رشته‌ها اصلاً دیده نمی‌شدند، پس `"salt and pepper or sugar"`
 *      دو نقطهٔ تصمیم می‌ساخت.
 *
 * حالا `maskLiteralsAndComments` این کار را می‌کند — همان تابعی که
 * استخراج‌گرهای heuristic استفاده می‌کنند، با نشانه‌های کامنتی که از
 * جدول زبان‌ها می‌آیند. طول متن هم حفظ می‌شود، که برای برش بدنهٔ
 * symbol لازم است.
 */

import { maskLiteralsAndComments } from '../../symbols/heuristic/LiteralMask';

export interface ComplexityPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly weight?: number;
}

export interface PatternComplexityOptions {
  readonly patterns: readonly ComplexityPattern[];
  /**
   * زبان، برای انتخاب نشانه‌های کامنت و رشته.
   *
   * پیش‌فرض `undefined` یعنی خانوادهٔ C — همان رفتار قبلی برای هر
   * زبانی که چیزی اعلام نکند.
   */
  readonly languageId?: string;
  readonly ignoreComments?: boolean;
}

export class PatternComplexityCalculator {
  constructor(private readonly options: PatternComplexityOptions) {}

  calculate(content: string): number {
    const code = this.options.ignoreComments
      ? maskLiteralsAndComments(content, this.options.languageId ?? '')
      : content;

    let complexity = 1;
    for (const pattern of this.options.patterns) {
      const weight = pattern.weight ?? 1;
      /*
      | regexها `g` دارند و `String.match` با `g` بدون حالت باقی‌مانده
      | کار می‌کند، ولی `lastIndex` روی نمونهٔ مشترک می‌تواند از یک
      | فراخوانی به فراخوانی بعدی نشت کند. صفر کردنش ارزان است و
      | نتیجه را قطعی می‌کند.
      */
      pattern.regex.lastIndex = 0;
      const matches = code.match(pattern.regex) ?? [];
      complexity += matches.length * weight;
    }

    return complexity;
  }
}
