/**
 * rescoreAfterEnrichment — SE-AI-13.
 *
 * ## مسئله
 *
 * ترتیب مراحل در `IndexPipeline` این است، و اجباری هم هست:
 *
 * ```
 * symbolها → گراف‌ها → متریک‌ها و aiScore → ساخت ایندکس → غنی‌سازی LSP
 * ```
 *
 * اجباری است چون `SymbolMetricsCalculator` خودش `referenceCount` را
 * از گرافِ حدسی پر می‌کند؛ اگر غنی‌سازی زودتر بیاید، عددِ کامپایلر با
 * حدس بازنویسی می‌شود. یعنی جابه‌جا کردنِ دو مرحله، رفع نیست —
 * یک رگرسیونِ بدتر است.
 *
 * عارضه‌اش این بود که `aiScore`، که یکی از ورودی‌هایش همان
 * `referenceCount` است، عددهای اصلاح‌شده را نمی‌دید. در یک ایندکسِ
 * غنی‌شده `referenceCount` از سرور می‌آمد ولی `importance` و
 * `hotness` هنوز بر اساس تخمینِ قبلی بودند. ناسازگاری **بی‌صدا**
 * بود: هر دو عدد معتبر به نظر می‌رسیدند.
 *
 * ## راه‌حل
 *
 * به‌جای جابه‌جا کردنِ مراحل، یک **مرحلهٔ امتیازدهیِ دوباره** پس از
 * غنی‌سازی. ورودی‌اش همان ایندکسِ غنی‌شده است و فقط سهمِ مربوط به
 * `referenceCount` را در `aiScore` به‌روز می‌کند.
 *
 * ## چرا فقط سهمِ ارجاع
 *
 * بقیهٔ ورودی‌های `aiScore` (تعداد import، نقطهٔ ورود، پیچیدگی) با
 * غنی‌سازی عوض نمی‌شوند. بازمحاسبهٔ کاملِ `AiMetadataGenerator`
 * یعنی دوباره خلاصه ساختن و دوباره کلیدواژه استخراج کردن — کارِ
 * گران برای چیزی که تغییر نکرده، و ریسکِ اینکه خروجی بین دو اجرا
 * جابه‌جا شود.
 */

import { ProjectIndex, FileEntry, AiScore } from '../core/types/project-index.types';

/**
 * سقفِ اشباعِ ارجاع.
 *
 * همان عددی که `ContextRanker` (فاز ۴۲) برای نرمال‌سازی مرکزیت
 * استفاده می‌کند. دو تعریفِ متفاوت از «پرارجاع» یعنی رتبه‌بندی و
 * امتیازدهی دربارهٔ یک فایل دو حرف بزنند.
 */
const REFERENCE_CEILING = 10;

/** بیشترین سهمی که ارجاع می‌تواند در `importance` داشته باشد. */
const REFERENCE_WEIGHT = 30;

/**
 * `aiScore` را با `referenceCount`های اصلاح‌شده به‌روز می‌کند.
 *
 * فایلی که `aiMetadata` ندارد دست‌نخورده می‌ماند، و فایلی که هیچ
 * نمادِ **اندازه‌گیری‌شده‌ای** ندارد هم — `null` یعنی «زبان‌سرور به
 * آن نرسید»، نه «صفر ارجاع». همان قاعدهٔ فاز ۴۲: نبودِ سیگنال با
 * سیگنالِ صفر یکی نیست، و جریمه کردنِ فایلی که فقط اندازه‌گیری نشده
 * دقیقاً برعکسِ چیزی است که غنی‌سازی می‌خواست.
 */
export function rescoreAfterEnrichment(index: ProjectIndex): ProjectIndex {
  const measuredByFile = new Map<string, number[]>();

  for (const symbol of index.symbols) {
    if (typeof symbol.referenceCount !== 'number') continue;
    const list = measuredByFile.get(symbol.fileId) ?? [];
    list.push(symbol.referenceCount);
    measuredByFile.set(symbol.fileId, list);
  }

  let changed = false;

  const files: FileEntry[] = index.files.map(file => {
    const score = file.aiMetadata?.aiScore;
    if (!score) return file;

    const measured = measuredByFile.get(file.id);
    if (!measured || measured.length === 0) return file;

    const updated = rescore(score, measured);
    if (
      updated.importance === score.importance &&
      updated.readPriority === score.readPriority &&
      updated.hotness === score.hotness
    ) {
      return file;
    }

    changed = true;
    return { ...file, aiMetadata: { ...file.aiMetadata, aiScore: updated } };
  });

  return changed ? { ...index, files } : index;
}

function rescore(previous: AiScore, referenceCounts: readonly number[]): AiScore {
  /*
  | بیشینه، نه میانگین. یک فایل با یک نمادِ بسیار پرارجاع مهم است،
  | حتی اگر ده نمادِ خصوصیِ بی‌ارجاع هم داشته باشد؛ میانگین دقیقاً
  | همان فایل را تنزل می‌دهد.
  */
  const peak = Math.max(...referenceCounts);
  const normalized = Math.min(peak / REFERENCE_CEILING, 1);
  const contribution = Math.round(normalized * REFERENCE_WEIGHT);

  /*
  | سهمِ قبلیِ ارجاع از `factors` خوانده می‌شود اگر ثبت شده باشد.
  | بدون آن نمی‌شود فهمید چقدر از `importance` مالِ ارجاع بوده، و
  | جمع کردنِ کورکورانه یعنی هر بار اجرا امتیاز بالاتر می‌رود.
  */
  const before = previous.factors?.referenceCountWeight ?? 0;
  const base = clamp(previous.importance - before);

  return {
    importance: clamp(base + contribution),
    readPriority: clamp(previous.readPriority - before + contribution),
    hotness: previous.hotness,
    factors: { ...(previous.factors ?? {}), referenceCountWeight: contribution },
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
