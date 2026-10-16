/**
 * FactStore — GAP-08، لایهٔ میانی میان «کسی که ادعا می‌کند» و «کسی که
 * از ادعا استفاده می‌کند».
 *
 * ── چرا حالا، و نه در فاز ۴۹ که «اختیاری» نوشته شده بود ────────────
 *
 * `GRAPH-INTELLIGENCE-GAPS.md` این لایه را به تعویق انداخت با یک دلیل
 * مشخص: «امروز فقط دو منبع وجود دارد (tree-sitter، heuristic)؛ ارزش
 * انتزاع وقتی ظاهر می‌شود که منبع سوم و چهارم اضافه شود». آن شرط
 * برقرار شده — بلوک E زبان‌سرور را به‌عنوان منبع سوم اضافه کرد و
 * `ExtractionSource` امروز چهار مقدار دارد.
 *
 * ولی دلیل واقعیِ ساختنش یک انتزاع نیست، یک باگ اندازه‌گیری‌شده است.
 * روی ایندکس واقعی `semantic-engine/src`:
 *
 * ```
 * callGraph rows                                 23,462
 * distinct (caller, callee)                      11,540
 * جفت‌هایی که دو ادعای متناقض دارند                     1
 *   d9316b2b→695a7f20  basis=[name-match(40), import-resolved(85)]
 * ```
 *
 * آن یک جفت کافی بود: `path()` برای همان دو گره `weakestLink: 40` و
 * `confident: false` برمی‌گرداند — یعنی «این مسیر حدس است» — در حالی
 * که یال `import-resolved` با اعتماد ۸۵ **بین همان دو گره** موجود
 * است. علتش این است که `GraphQueryEngine` یال‌ها را در یک آرایه
 * می‌ریزد و BFS اولین عضو آرایه را برمی‌دارد؛ ترتیب آرایه ترتیب
 * درج است، نه ترتیب قوت شواهد. یک مسیرِ **مطمئنِ برچسب‌خوردهٔ حدس**
 * از نبودن مسیر بدتر است: مصرف‌کننده یاد می‌گیرد به برچسب اعتماد
 * نکند.
 *
 * ── مدل ─────────────────────────────────────────────────────────────
 *
 * یک `Fact` یک ادعای سه‌تایی است — `subject` `predicate` `object` —
 * به‌همراه اینکه چه کسی و از روی چه شواهدی آن را گفته. چند منبع
 * می‌توانند همان سه‌تایی را ادعا کنند؛ `FactStore` هیچ‌کدام را دور
 * نمی‌ریزد و در `resolve()` بر اساس یک سیاست صریح یکی را «برنده»
 * اعلام می‌کند و بقیه را به‌عنوان شواهد جانبی نگه می‌دارد.
 *
 * تفاوت با «هرکس اول آمد ببرد»: سیاست قابل بازرسی است و بازنده گم
 * نمی‌شود. تفاوت با «هرکس آخر آمد ببرد»: نتیجه به ترتیب اجرای
 * استخراج‌گرها وابسته نیست، پس یک اسکن دوباره همان جواب را می‌دهد.
 */

import { EdgeBasis, EdgeLocation, EDGE_CONFIDENCE } from '../graphs/EdgeProvenance';
import { ExtractionSource } from '../core/types/common.types';

/**
 * چه کسی ادعا را کرده.
 *
 * چهار مقدار `ExtractionSource` کسانی‌اند که کد را خوانده‌اند.
 * `derived` برای ادعایی است که خودِ موتور از روی ادعاهای دیگر ساخته
 * — مثل یال‌های بین‌لایه‌ای فاز ۴۷ که از blueprint می‌آیند و هیچ
 * استخراج‌گری آن‌ها را در فایلی ندیده است. برچسب زدن آن‌ها به یکی
 * از استخراج‌گرها، همان دروغی است که فاز ۱۹ برای رفعش provenance
 * اضافه کرد.
 */
export type ClaimSource = ExtractionSource | 'derived';

/** مثل `EdgeProvenance`، ولی منبع می‌تواند «مشتق‌شده» هم باشد. */
export interface ClaimProvenance {
  readonly extractor: ClaimSource;
  readonly confidence: number;
  readonly basis: string;
  readonly location?: EdgeLocation;
}

/**
 * یک ادعا دربارهٔ رابطهٔ دو چیز.
 *
 * `attributes` جای هر چیزی است که مصرف‌کنندهٔ خاص لازم دارد و
 * `FactStore` معنایش را نمی‌داند — مثلاً `kind` یال یا شمارهٔ خط.
 * عمداً در کلید تطبیق نیست: دو فراخوانی در دو خط، یک رابطهٔ
 * «الف را صدا می‌زند» هستند.
 */
export interface Fact<A = Readonly<Record<string, unknown>>> {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly provenance: ClaimProvenance;
  readonly attributes?: A;
}

/**
 * ادعای برنده، به‌همراه آنچه دربارهٔ رقبایش می‌دانیم.
 *
 * `corroborations` تعداد ادعاهای *دیگری* است که همین سه‌تایی را
 * گفته‌اند — چه موافق و چه مخالف. `supersededBy` منشأ ادعاهایی است
 * که کنار گذاشته شدند، به ترتیب نزولی اعتماد، تا کسی که می‌پرسد
 * «مگر نگفتی این حدس است؟» جوابی داشته باشد.
 */
export interface ResolvedFact<A = Readonly<Record<string, unknown>>> extends Fact<A> {
  readonly corroborations: number;
  readonly superseded: readonly ClaimProvenance[];
  /**
   * آیا منابع دربارهٔ قوت این رابطه هم‌نظر نبودند؟
   *
   * فقط تکرار یک ادعا اختلاف نیست. اختلاف یعنی دو `basis` متفاوت —
   * همان چیزی که `weakestLink` را خراب می‌کرد.
   */
  readonly contested: boolean;
}

export interface FactStoreStats {
  /** چند ادعا وارد شد. */
  readonly claims: number;
  /** چند رابطهٔ یکتا بیرون آمد. */
  readonly resolved: number;
  /** چند ادعا چیزی به دانستهٔ ما اضافه نکرد (تکرار عین‌به‌عین). */
  readonly duplicates: number;
  /** چند رابطه بیش از یک `basis` داشت. */
  readonly contested: number;
}

/**
 * رتبهٔ مبنا، برای وقتی که دو ادعا اعتماد یکسان دارند.
 *
 * بدون این، دو ادعای ۹۰ (`declared` و یک `resolved` که پایین آورده
 * شده) به ترتیب درج حل می‌شدند — یعنی همان مشکلی که این کلاس برای
 * رفعش نوشته شده، یک لایه بالاتر تکرار می‌شد.
 */
const BASIS_RANK: Readonly<Record<EdgeBasis, number>> = {
  resolved: 6,
  ast: 5,
  declared: 4,
  'import-resolved': 3,
  'name-match': 2,
  unresolved: 1,
};

function rankOf(basis: string): number {
  return BASIS_RANK[basis as EdgeBasis] ?? 0;
}

/**
 * آیا ادعای دوم باید جای اول را بگیرد؟
 *
 * ترتیب: اعتماد بالاتر، بعد مبنای قوی‌تر. اگر هر دو برابر بودند
 * **نه** — اولین می‌ماند، چون تنها راه قطعی‌بودن نتیجه همین است.
 */
function beats(challenger: ClaimProvenance, holder: ClaimProvenance): boolean {
  if (challenger.confidence !== holder.confidence) {
    return challenger.confidence > holder.confidence;
  }
  return rankOf(challenger.basis) > rankOf(holder.basis);
}

function keyOf(fact: Fact<never> | Fact<Readonly<Record<string, unknown>>>): string {
  return `${fact.subject}\u0000${fact.predicate}\u0000${fact.object}`;
}

interface Bucket<A> {
  best: Fact<A>;
  /** منشأ همهٔ ادعاهای کنارگذاشته‌شده. */
  readonly others: ClaimProvenance[];
  readonly bases: Set<string>;
  /** چند ادعا عیناً تکرار ادعای قبلی بود. */
  duplicates: number;
  /** برای پایداری خروجی: چندمین رابطهٔ یکتایی بود که دیدیم. */
  readonly order: number;
}

export class FactStore<A = Readonly<Record<string, unknown>>> {
  private readonly buckets = new Map<string, Bucket<A>>();
  private claims = 0;

  /** یک ادعا. تکراری بودنش اشکالی ندارد — همین کلاس برای همین است. */
  add(fact: Fact<A>): void {
    this.claims++;
    const key = keyOf(fact as Fact<Readonly<Record<string, unknown>>>);
    const bucket = this.buckets.get(key);

    if (!bucket) {
      this.buckets.set(key, {
        best: fact,
        others: [],
        bases: new Set([fact.provenance.basis]),
        duplicates: 0,
        order: this.buckets.size,
      });
      return;
    }

    bucket.bases.add(fact.provenance.basis);

    if (
      bucket.best.provenance.basis === fact.provenance.basis &&
      bucket.best.provenance.confidence === fact.provenance.confidence &&
      bucket.best.provenance.extractor === fact.provenance.extractor
    ) {
      /*
      | ادعای عین‌به‌عین. روی ایندکس واقعی ۲۱۰ سطر مازاد از همین
      | جنس بود — دو فراخوانی روی یک خط، مثل `m.has(a) && m.has(b)`.
      | خطا نیست، ولی برای پیمایش نویز است: یال یکی است.
      */
      bucket.duplicates++;
      return;
    }

    if (beats(fact.provenance, bucket.best.provenance)) {
      bucket.others.push(bucket.best.provenance);
      bucket.best = fact;
    } else {
      bucket.others.push(fact.provenance);
    }
  }

  addAll(facts: Iterable<Fact<A>>): void {
    for (const fact of facts) this.add(fact);
  }

  /** چند ادعا وارد شده — نه چند رابطه. */
  get claimCount(): number {
    return this.claims;
  }

  /** چند رابطهٔ یکتا. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * رابطه‌های یکتا، هرکدام با قوی‌ترین شاهدشان.
   *
   * ترتیب، ترتیب *اولین بار دیده شدن* هر رابطه است — نه ترتیب
   * اعتماد. مصرف‌کننده‌ای که ترتیب دیگری می‌خواهد خودش مرتب کند؛
   * عوض کردن ترتیب اینجا یعنی خروجی به سیاست حل وابسته می‌شود.
   */
  resolve(): readonly ResolvedFact<A>[] {
    const out: ResolvedFact<A>[] = new Array(this.buckets.size);
    for (const bucket of this.buckets.values()) {
      out[bucket.order] = this.finish(bucket);
    }
    return out;
  }

  /** فقط ادعاهایی که این subject دارد. */
  resolveFor(subject: string, predicate?: string): readonly ResolvedFact<A>[] {
    const out: ResolvedFact<A>[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.best.subject !== subject) continue;
      if (predicate !== undefined && bucket.best.predicate !== predicate) continue;
      out.push(this.finish(bucket));
    }
    return out.sort((a, b) => b.provenance.confidence - a.provenance.confidence);
  }

  stats(): FactStoreStats {
    let duplicates = 0;
    let contested = 0;
    for (const bucket of this.buckets.values()) {
      duplicates += bucket.duplicates;
      if (bucket.bases.size > 1) contested++;
    }
    return { claims: this.claims, resolved: this.buckets.size, duplicates, contested };
  }

  private finish(bucket: Bucket<A>): ResolvedFact<A> {
    return {
      ...bucket.best,
      corroborations: bucket.others.length + bucket.duplicates,
      superseded: [...bucket.others].sort((a, b) => b.confidence - a.confidence),
      contested: bucket.bases.size > 1,
    };
  }
}

/**
 * اعتماد پیش‌فرض یک مبنا — برای منبعی که فقط می‌داند «از AST خواندم»
 * و نمی‌خواهد عدد را خودش از خاطر بنویسد.
 */
export function confidenceOf(basis: EdgeBasis): number {
  return EDGE_CONFIDENCE[basis];
}
