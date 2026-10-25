/**
 * ContextRanker — GAP-06 و SE-VEC-03.
 *
 * ## چرا این ماژول وجود دارد
 *
 * تنها امتیازدهیِ موتور تا پیش از فاز ۴۲ سه سطر داخل
 * `SemanticSearchTool.getKeywordCandidates` بود:
 *
 * ```ts
 * score = keywordScore * 0.5 + centralityScore * 0.3 + exportedBonus * 0.2;
 * ```
 *
 * دو مشکل داشت و هر دو اندازه‌گیری شدند (ایندکس واقعی `semantic-engine/src`،
 * ۲۸۱ فایل و ۷٬۸۹۹ نماد):
 *
 * ۱. **مقیاس‌ها با هم نمی‌خوانند.** `keywordScore` به‌ازای هر برخوردِ نام
 *    `+3` می‌گیرد و کران بالا ندارد؛ `centralityScore` و `exportedBonus`
 *    هر دو کران‌دارند. اندازه‌گیری: بیشینهٔ سهم کلیدواژه ۳٫۵ در برابر
 *    بیشینهٔ سهم **مجموعِ** بقیه ۰٫۴۰. یعنی رتبه‌بندی عملاً یک مرتب‌سازی
 *    کلیدواژه‌ای بود با چند اعشارِ تزئینی. شباهت برداری (بازهٔ ۰..۱) هم
 *    وقتی اضافه می‌شد، در برابر کلیدواژه دیده نمی‌شد — همان SE-VEC-03.
 *
 * ۲. **موتور سیگنال‌هایی می‌سازد و دور می‌ریزد.** جست‌وجوی کد نشان داد
 *    `aiScore` (importance/hotness/readPriority) در هیچ ابزاری برای
 *    رتبه‌بندی استفاده نمی‌شود؛ همین‌طور `gitMetrics.hotspotScore`،
 *    `churnRank`، `complexity` و `testIds`. هزینهٔ محاسبه پرداخت
 *    می‌شد و فایده‌اش گرفته نمی‌شد.
 *
 * ## دو تصمیم که رفتار را تعیین می‌کنند
 *
 * **الف) نرمال‌سازی دسته‌ای، نه نقطه‌ای.** کلیدواژه نسبت به *بیشینهٔ
 * همان دستهٔ نامزدها* نرمال می‌شود، نه یک ثابت دلبخواه. برای همین
 * `rank()` کل فهرست را می‌گیرد و نه یک آیتم را: هیچ تابع خالصِ
 * تک‌آیتمی نمی‌تواند کلیدواژه را نرمال کند.
 *
 * **ب) «نامعلوم» با «صفر» یکی نیست.** روی ایندکس واقعی،
 * `referenceCount` برای ۹۵٪ نمادها `null` است، چون بدون LSP اندازه‌گیری
 * نمی‌شود. اگر `null` را صفر بگیریم، رتبه‌بند نمادهایی را جریمه می‌کند
 * که فقط *اندازه‌گیری نشده‌اند*. پس سیگنالِ غایب از میانگین وزنی حذف
 * می‌شود و وزنش میان سیگنال‌های حاضر بازتوزیع می‌گردد:
 *
 * ```
 * score = Σ(wᵢ · vᵢ) ÷ Σ(wᵢ)      روی سیگنال‌های حاضر
 * ```
 *
 * نتیجه‌اش این است که یک نامزدِ تک‌سیگنالی با آن سیگنالِ بیشینه، امتیاز
 * کامل می‌گیرد. این عمدی است: رتبه‌بند دربارهٔ آنچه نمی‌داند اظهار نظر
 * نمی‌کند.
 *
 * ## قابل توضیح بودن
 *
 * هر نتیجه `contributions` دارد که مجموعش دقیقاً برابر `score` است، و
 * `missing` که می‌گوید چه سیگنالی نبود. بدون این، «چرا این بالاتر
 * ایستاد» جوابی ندارد — همان نقدی که در فاز ۳۹ به گراف وارد بود.
 */

export type SignalName =
  | 'keyword'
  | 'vector'
  | 'graphDistance'
  | 'centrality'
  | 'importance'
  | 'hotness'
  | 'readPriority'
  | 'hotspot'
  | 'churn'
  | 'complexity'
  | 'tested'
  | 'exported';

/**
 * سیگنال‌های خام یک نامزد. هر فیلد `undefined` یا `null` یعنی
 * «اندازه‌گیری نشده» — که با صفر فرق دارد.
 */
export interface RankSignals {
  /** امتیاز خام کلیدواژه؛ بی‌کران. نسبت به بیشینهٔ دسته نرمال می‌شود. */
  readonly keyword?: number | null;
  /** شباهت کسینوسی، از پیش در بازهٔ ۰..۱. */
  readonly vector?: number | null;
  /** فاصله تا نزدیک‌ترین گرهِ هدف. صفر یعنی خودِ هدف. */
  readonly graphHops?: number | null;
  /** `SymbolEntry.referenceCount` — روی ایندکس واقعی اغلب `null`. */
  readonly referenceCount?: number | null;
  /** `aiMetadata.aiScore.importance` — بازهٔ ۰..۱۰۰. */
  readonly importance?: number | null;
  /** `aiMetadata.aiScore.hotness` — بازهٔ ۰..۱۰۰. */
  readonly hotness?: number | null;
  /** `aiMetadata.aiScore.readPriority` — بازهٔ ۰..۱۰۰. */
  readonly readPriority?: number | null;
  /** `gitMetrics.hotspotScore` — بازهٔ ۰..۱۰۰ و فقط درون‌پروژه‌ای معنا دارد. */
  readonly hotspotScore?: number | null;
  /** `gitMetrics.churnRank` — رتبهٔ ۱ یعنی پرتغییرترین فایل. */
  readonly churnRank?: number | null;
  /** پیچیدگی سیکلوماتیک نماد. */
  readonly complexity?: number | null;
  /** تعداد فایل‌های تستی که این نماد را پوشش می‌دهند (`testIds.length`). */
  readonly testCount?: number | null;
  readonly exported?: boolean | null;
}

export interface RankCandidate<T = unknown> {
  readonly id: string;
  readonly signals: RankSignals;
  readonly payload?: T;
}

export interface SignalContribution {
  readonly signal: SignalName;
  /** مقدار نرمال‌شده در بازهٔ ۰..۱. */
  readonly normalized: number;
  readonly weight: number;
  /** `normalized × weight ÷ Σweight` — مجموع اینها برابر `score` است. */
  readonly contribution: number;
}

export interface RankedCandidate<T = unknown> {
  readonly id: string;
  /** بازهٔ ۰..۱. */
  readonly score: number;
  readonly payload?: T;
  readonly contributions: readonly SignalContribution[];
  /** سیگنال‌هایی که برای این نامزد اندازه‌گیری نشده بودند. */
  readonly missing: readonly SignalName[];
}

export interface RankOptions {
  readonly weights?: Partial<Record<SignalName, number>>;
  /**
   * تعداد کل فایل‌های رتبه‌بندی‌شده در churn. اگر ندهید، از بیشینهٔ
   * `churnRank` داخل همین دسته استفاده می‌شود — که برای دسته‌های کوچک
   * رتبه‌ها را به هم می‌فشارد.
   */
  readonly churnRankOutOf?: number;
  /** `referenceCount` از این عدد به بالا، سیگنالِ اشباع‌شده است. */
  readonly centralityCeiling?: number;
  /** `complexity` از این عدد به بالا، سیگنالِ اشباع‌شده است. */
  readonly complexityCeiling?: number;
  /** `testCount` از این عدد به بالا، سیگنالِ اشباع‌شده است. */
  readonly testCountCeiling?: number;
  /**
   * سیگنال‌های «ربطِ اصلی» با **مخرجِ ثابت**.
   *
   * قاعدهٔ پیش‌فرضِ رتبه‌بند این است که «یک نامزدِ تک‌سیگنالی با آن
   * سیگنالِ بیشینه، امتیازِ کامل می‌گیرد». برای جست‌وجوی صرفاً
   * کلیدواژه‌ای درست است، اما در حالت hybrid فاجعه می‌سازد: یک
   * برخوردِ سطحیِ نام (مثلاً `constant functions` روی واژهٔ «function»)
   * با یک تطبیقِ معناییِ درست (مثلاً `MutationSimulator` برای «blast
   * radius» ) تساوی می‌گیرد و نویزِ کلیدواژه، جوابِ درست را دفن می‌کند.
   *
   * با این گزینه، سیگنال‌های لیست‌شده مخرجِ ثابت می‌گیرند: نامزدی که یک
   * سیگنالِ اصلیِ موجود در دسته را **ندارد**، جریمه می‌شود، پس
   * تطبیقِ هر دو (کلیدواژه + بردار) بر تک‌سیگنالی غالب است. فقط وقتی
   * اعمال می‌شود که آن سیگنال در دسته حضور داشته باشد؛ پس حالتِ
   * تک‌مسیره (کلیدواژهٔ خالص) دقیقاً مثل قبل می‌ماند.
   */
  readonly coreRelevanceSignals?: readonly SignalName[];
}

/**
 * وزن‌های پیش‌فرض.
 *
 * اینها **قضاوت‌اند، نه اندازه‌گیری** — هیچ مجموعهٔ داوری‌شده‌ای وجود
 * ندارد که بشود رویش تنظیمشان کرد. منطقشان:
 *
 * - `keyword` و `vector` هم‌وزن‌اند؛ هیچ‌کدام نباید دیگری را خفه کند
 *   (SE-VEC-03 دقیقاً همین بود).
 * - `graphDistance` هم‌ردهٔ آنهاست: نزدیکیِ ساختاری به هدف، به اندازهٔ
 *   شباهت متنی خبر می‌دهد.
 * - سیگنال‌های مشتق‌شده (`importance`, `readPriority`, `centrality`)
 *   وزن میانی دارند.
 * - سیگنال‌های گیت (`hotness`, `hotspot`, `churn`) کم‌وزن‌اند چون
 *   نسبی‌اند و به عمق تاریخچهٔ در دسترس حساس.
 * - `exported` و `tested` و `complexity` فقط شکنندهٔ تساوی‌اند.
 */
export const DEFAULT_SIGNAL_WEIGHTS: Readonly<Record<SignalName, number>> = Object.freeze({
  keyword: 1.0,
  vector: 1.0,
  graphDistance: 0.9,
  centrality: 0.5,
  importance: 0.5,
  readPriority: 0.4,
  hotness: 0.2,
  hotspot: 0.2,
  churn: 0.15,
  complexity: 0.15,
  tested: 0.15,
  exported: 0.2,
});

const ALL_SIGNALS: readonly SignalName[] = Object.freeze(
  Object.keys(DEFAULT_SIGNAL_WEIGHTS) as SignalName[]
);

function present(value: number | boolean | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export class ContextRanker {
  private readonly weights: Record<SignalName, number>;

  constructor(private readonly defaults: RankOptions = {}) {
    this.weights = { ...DEFAULT_SIGNAL_WEIGHTS, ...(defaults.weights ?? {}) };
  }

  rank<T = unknown>(
    candidates: readonly RankCandidate<T>[],
    options: RankOptions = {}
  ): RankedCandidate<T>[] {
    if (candidates.length === 0) return [];

    const weights: Record<SignalName, number> = {
      ...this.weights,
      ...(options.weights ?? {}),
    };

    const centralityCeiling =
      options.centralityCeiling ?? this.defaults.centralityCeiling ?? 10;
    const complexityCeiling =
      options.complexityCeiling ?? this.defaults.complexityCeiling ?? 20;
    const testCountCeiling =
      options.testCountCeiling ?? this.defaults.testCountCeiling ?? 3;

    /*
    | نرمال‌سازی دسته‌ای: کلیدواژه بی‌کران است، پس مقیاسش را از خودِ
    | دسته می‌گیریم. اگر بیشینه صفر باشد، هیچ‌کس کلیدواژه‌ای ندارد و
    | سیگنال کلاً غایب حساب می‌شود — نه اینکه همه صفر بگیرند و وزنش
    | بی‌خود مصرف شود.
    */
    let maxKeyword = 0;
    let maxChurnRank = 0;
    for (const c of candidates) {
      const kw = c.signals.keyword;
      if (present(kw) && (kw as number) > maxKeyword) maxKeyword = kw as number;
      const cr = c.signals.churnRank;
      if (present(cr) && (cr as number) > maxChurnRank) maxChurnRank = cr as number;
    }

    const churnOutOf = Math.max(
      2,
      options.churnRankOutOf ?? this.defaults.churnRankOutOf ?? maxChurnRank
    );

    /*
    | سیگنال‌های ربطِ اصلی که در این دسته «فعال»اند. فقط همین‌ها مخرجِ
    | ثابت می‌گیرند؛ اگر بردار اصلاً در دسته نباشد (حالتِ کلیدواژه)،
    | `vector` فعال نیست و رفتار مثلِ قبل می‌ماند.
    */
    const vectorActive = candidates.some(c => present(c.signals.vector));
    const activeCoreSignals = (options.coreRelevanceSignals ?? this.defaults.coreRelevanceSignals ?? [])
      .filter(signal =>
        signal === 'keyword' ? maxKeyword > 0
          : signal === 'vector' ? vectorActive
            : false
      );

    const ranked = candidates.map(candidate => {
      const s = candidate.signals;
      const normalized = new Map<SignalName, number>();

      if (maxKeyword > 0 && present(s.keyword)) {
        normalized.set('keyword', clamp01((s.keyword as number) / maxKeyword));
      }
      if (present(s.vector)) {
        normalized.set('vector', clamp01(s.vector as number));
      }
      if (present(s.graphHops)) {
        // hops 0 → 1، hops 1 → 0.5، hops 3 → 0.25. افت هذلولی، چون
        // تفاوت یک و دو هاپ خیلی مهم‌تر از تفاوت هشت و نه هاپ است.
        normalized.set('graphDistance', 1 / (1 + Math.max(0, s.graphHops as number)));
      }
      if (present(s.referenceCount)) {
        normalized.set(
          'centrality',
          clamp01((s.referenceCount as number) / centralityCeiling)
        );
      }
      if (present(s.importance)) {
        normalized.set('importance', clamp01((s.importance as number) / 100));
      }
      if (present(s.hotness)) {
        normalized.set('hotness', clamp01((s.hotness as number) / 100));
      }
      if (present(s.readPriority)) {
        normalized.set('readPriority', clamp01((s.readPriority as number) / 100));
      }
      if (present(s.hotspotScore)) {
        normalized.set('hotspot', clamp01((s.hotspotScore as number) / 100));
      }
      if (present(s.churnRank)) {
        // رتبهٔ ۱ = پرتغییرترین ⇒ باید بالاترین مقدار را بگیرد.
        const rank = Math.max(1, s.churnRank as number);
        normalized.set('churn', clamp01(1 - (rank - 1) / (churnOutOf - 1)));
      }
      if (present(s.complexity)) {
        normalized.set('complexity', clamp01((s.complexity as number) / complexityCeiling));
      }
      if (present(s.testCount)) {
        normalized.set('tested', clamp01((s.testCount as number) / testCountCeiling));
      }
      if (present(s.exported)) {
        normalized.set('exported', s.exported ? 1 : 0);
      }

      let totalWeight = 0;
      for (const [signal] of normalized) {
        totalWeight += weights[signal] ?? 0;
      }

      /*
      | مخرجِ ثابت برای سیگنال‌های ربطِ اصلیِ فعال: نامزدی که یکی از
      | آن‌ها را ندارد، وزنِ آن سیگنال در مخرج می‌ماند و صورتِ‌اش صفر ⇒
      | سقفِ امتیازش می‌آید پایین. این همان چیزی است که اجازه نمی‌دهد
      | یک تک‌برخوردِ کلیدواژه‌ای با تطبیقِ معنایی برابر شود.
      */
      for (const signal of activeCoreSignals) {
        if (!normalized.has(signal)) totalWeight += weights[signal] ?? 0;
      }

      const contributions: SignalContribution[] = [];
      let score = 0;

      if (totalWeight > 0) {
        for (const signal of ALL_SIGNALS) {
          const value = normalized.get(signal);
          if (value === undefined) continue;
          const weight = weights[signal] ?? 0;
          if (weight === 0) continue;
          const contribution = (value * weight) / totalWeight;
          contributions.push({ signal, normalized: value, weight, contribution });
          score += contribution;
        }
      }

      const missing = ALL_SIGNALS.filter(signal => !normalized.has(signal));

      const result: RankedCandidate<T> = {
        id: candidate.id,
        score: clamp01(score),
        contributions,
        missing,
        ...(candidate.payload !== undefined ? { payload: candidate.payload } : {}),
      };
      return result;
    });

    // مرتب‌سازی پایدار و قابل بازتولید: امتیاز نزولی، سپس id صعودی.
    return ranked.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  }
}
