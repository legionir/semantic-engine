/**
 * محاسبه تقریبی Cyclomatic Complexity برای Python.
 *
 * ── SE-METRIC-02 ─────────────────────────────────────────────────────
 *
 * فهرست قبلی چهار الگوی اضافه داشت و هر چهار تا عدد را بالا می‌بردند:
 *
 *   `with`         نقطهٔ تصمیم نیست. `with open(...)` هیچ شاخه‌ای
 *                  نمی‌سازد؛ یک context manager است.
 *   `assert`       شاخه نمی‌سازد — یا رد می‌شود یا استثنا می‌دهد، و
 *                  مسیر استثنا در Cyclomatic شمرده نمی‌شود.
 *   `comprehension` الگوی `\[.*\bfor\b.*\bin\b.*\]` روی همان `for`ی
 *                  می‌افتاد که الگوی `for` قبلاً شمرده بود. دوباره‌شماری.
 *   `ternary`      الگوی `\bif\b[\s\S]*?\belse\b` بود. `[\s\S]` یعنی
 *                  خط جدید هم شامل می‌شود، پس یک `if` در یک تابع
 *                  می‌توانست با `else`ای ده‌ها خط پایین‌تر در تابع
 *                  دیگری جفت شود. حتی وقتی درست جفت می‌شد، همان
 *                  `if` را دو بار می‌شمرد: عبارت شرطی `a if b else c`
 *                  در Python **یک** نقطهٔ تصمیم دارد، نه دو.
 *
 * چیزی که می‌ماند دقیقاً کلیدواژه‌هایی است که شاخه می‌سازند. `elif`
 * جداگانه لازم است چون `\bif\b` داخل `elif` نمی‌افتد (مرز کلمه بین
 * `l` و `i` وجود ندارد).
 *
 * ── آنچه عمداً شمرده نمی‌شود ──────────────────────────────────────
 *
 * `match`/`case` (Python 3.10) — `case` یک کلیدواژهٔ *نرم* است و
 * `case = 1` یک نام کاملاً معتبر. بدون parser، افزودنش مثبت کاذب
 * می‌سازد. برای فاز ۳۳ (tree-sitter برای بقیهٔ زبان‌ها).
 *
 * `and`/`or` این‌جا همیشه یک نقطهٔ تصمیم فرض می‌شوند، حتی وقتی جزء
 * یک عبارت boolean ساده باشند. همان قراردادی که ابزارهای الگومحور
 * دیگر هم دارند؛ دقتش فقط با AST بیشتر می‌شود.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const PYTHON_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'elif', regex: /\belif\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'except', regex: /\bexcept\b/g },
  { name: 'and', regex: /\band\b/g },
  { name: 'or', regex: /\bor\b/g },
];

export function createPythonComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: PYTHON_PATTERNS,
    languageId: 'python',
    ignoreComments: true,
  });
}
