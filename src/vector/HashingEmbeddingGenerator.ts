/**
 * HashingEmbeddingGenerator — بردارِ واژگانی، بدون هیچ وابستگی.
 *
 * ## چرا لازم شد
 *
 * `LocalEmbeddingGenerator` تنها پیاده‌سازیِ موجود بود و در عمل قابل
 * بارگذاری نیست. اجرای واقعی در همین مخزن با `npm install
 * --ignore-scripts` (که برای CI و برای هر نصبی که به باینریِ native
 * اعتماد نمی‌کند متعارف است):
 *
 * ```
 * $ node -e "require('@xenova/transformers')"
 * Something went wrong installing the "sharp" module
 * Cannot find module '../build/Release/sharp-linux-x64.node'
 * ```
 *
 * `sharp` پردازش تصویر است و موتور هیچ تصویری پردازش نمی‌کند
 * (SE-VEC-10)، ولی `@xenova/transformers` آن را ایستا import می‌کند
 * پس اجتناب‌ناپذیر است. نتیجه: در پیکربندی پیش‌فرض، «جست‌وجوی
 * معنایی» همیشه صرفاً کلیدواژه‌ای بود (SE-VEC-02).
 *
 * ## این چه هست و چه نیست
 *
 * **هست:** یک بردارِ hashed bag-of-segments. شناسه‌ها به قطعه شکسته
 * می‌شوند (`beginAccountRecovery` → `begin`, `account`, `recovery`)،
 * هر قطعه با هش به یک بُعد نگاشته می‌شود، فراوانی‌ها با
 * `1 + log(tf)` وزن می‌گیرند و بردار L2-نرمال می‌شود. دترمینیستیک،
 * آفلاین، بدون دانلود مدل، و روی متن غیرلاتین هم کار می‌کند
 * (SE-VEC-05).
 *
 * **نیست:** مدل معنایی. `car` و `automobile` را نزدیک نمی‌کند. آنچه
 * می‌دهد این است که پرس‌وجوی «reset password email» فایلی را پیدا
 * کند که *بدنه‌اش* `resetPassword` و `sendEmail` دارد، حتی اگر
 * *نامش* `AccountOps.ts` باشد — که دقیقاً معیار پذیرش فاز ۴۴ است، و
 * تا وقتی chunkها فقط برچسب بودند (SE-VEC-01) شدنی نبود.
 *
 * انتخاب آگاهانه: یک پیش‌فرضِ ضعیف‌ترِ **کارکن**، بهتر از یک پیش‌فرضِ
 * قوی‌ترِ **نصب‌نشدنی** است. هرکس `@xenova/transformers` را با موفقیت
 * نصب کند، `LocalEmbeddingGenerator` سر جایش است و می‌تواند تزریقش
 * کند.
 */

import { IEmbeddingGenerator, EmbeddingResult } from './EmbeddingGenerator';

export interface HashingEmbeddingOptions {
  /** ابعاد بردار. پیش‌فرض ۲۵۶. */
  readonly dimensions?: number;
  /**
   * حداکثر کاراکترِ ورودی. پیش‌فرض ۴۰۹۶ — SE-VEC-08.
   *
   * `EmbeddingConfig.maxInputLength` از ابتدا تعریف شده بود و
   * **هیچ‌جا استفاده نمی‌شد**.
   */
  readonly maxInputLength?: number;
}

const DEFAULT_DIMENSIONS = 256;
const DEFAULT_MAX_INPUT = 4096;

/**
 * شباهت کسینوسی، با دو محافظ که نسخهٔ داخلِ `VectorStore` نداشت:
 * بردار صفر `0` می‌دهد نه `NaN`، و طول نابرابر `0` می‌دهد به‌جای
 * خواندنِ `undefined` از بیرون آرایه.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * متن را به قطعه‌های واژگانی می‌شکند.
 *
 * SE-VEC-05 — الگو یونی‌کدی است (`\p{L}` و `\p{N}`) پس فارسی، عربی،
 * روسی و چینی حذف نمی‌شوند. توکن‌سازِ قبلی `[^a-z0-9_]+` بود و روی
 * پرس‌وجوی غیرلاتین آرایهٔ خالی می‌داد.
 */
export function textSegments(text: string): string[] {
  const words = text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const segments: string[] = [];

  for (const word of words) {
    // خودِ کلمه، برای اینکه `resetPassword` هم به‌عنوان یک واحد بماند.
    segments.push(word.toLowerCase());

    const parts = word
      .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
      .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2')
      .split(/[\s_]+/u)
      .filter(Boolean);

    if (parts.length > 1) {
      for (const part of parts) segments.push(part.toLowerCase());
    }
  }

  return segments;
}

/** هش ۳۲ بیتی FNV-1a — ارزان، پایدار، و بین اجراها یکسان. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export class HashingEmbeddingGenerator implements IEmbeddingGenerator {
  private readonly dimensions: number;
  private readonly maxInputLength: number;

  constructor(options: HashingEmbeddingOptions = {}) {
    this.dimensions = Math.max(8, options.dimensions ?? DEFAULT_DIMENSIONS);
    this.maxInputLength = Math.max(1, options.maxInputLength ?? DEFAULT_MAX_INPUT);
  }

  get modelName(): string {
    return `hashing-bag-of-segments-${this.dimensions}`;
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async generate(text: string): Promise<EmbeddingResult> {
    return {
      embedding: this.embed(text),
      model: this.modelName,
      dimensions: this.dimensions,
    };
  }

  async generateBatch(texts: readonly string[]): Promise<EmbeddingResult[]> {
    return texts.map(text => ({
      embedding: this.embed(text),
      model: this.modelName,
      dimensions: this.dimensions,
    }));
  }

  async dispose(): Promise<void> {}

  /**
   * برش روی مرزِ واژه، نه وسطِ آن.
   *
   * برشِ خام روی کاراکترِ n اُم یک واژهٔ نصفه به جا می‌گذارد و آن
   * نصفه یک قطعهٔ جعلی می‌سازد که در هیچ پرس‌وجویی نیست ولی یک بُعد
   * را اشغال می‌کند. با سقف ۲۰ روی متنِ `alpha beta gamma zulu…`
   * قطعهٔ `zul` تولید می‌شد.
   */
  private truncate(text: string): string {
    if (text.length <= this.maxInputLength) return text;

    const cut = text.slice(0, this.maxInputLength);
    const isWordChar = /[\p{L}\p{N}_]/u;

    // اگر برش وسط واژه افتاده، تا مرزِ قبلی عقب برو.
    if (isWordChar.test(text.charAt(this.maxInputLength))) {
      for (let i = cut.length - 1; i >= 0; i--) {
        if (!isWordChar.test(cut.charAt(i))) return cut.slice(0, i);
      }
      return '';
    }

    return cut;
  }

  private embed(text: string): number[] {
    const truncated = this.truncate(text);

    const counts = new Map<number, number>();
    for (const segment of textSegments(truncated)) {
      // قطعهٔ تک‌حرفی سیگنال ندارد و فقط بردار را شلوغ می‌کند.
      if (segment.length < 2) continue;
      const bucket = fnv1a(segment) % this.dimensions;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }

    const vector = new Array<number>(this.dimensions).fill(0);
    if (counts.size === 0) return vector;

    // وزنِ لگاریتمیِ فراوانی: تکرار دهم یک واژه، به‌اندازهٔ تکرار
    // دومش خبر تازه ندارد.
    let norm = 0;
    for (const [bucket, count] of counts) {
      const weight = 1 + Math.log(count);
      vector[bucket] = weight;
      norm += weight * weight;
    }

    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / norm;

    return vector;
  }
}
