/**
 * EmbeddingGenerator — abstraction برای تولید vector embedding.
 *
 * Implementations:
 * - LocalEmbeddingGenerator: مدل محلی @xenova/transformers (بدون API key)
 * - (future) ApiEmbeddingGenerator: OpenAI / Cohere / etc.
 */

export interface EmbeddingGeneratorOptions {
  readonly model?: string;
  readonly batchSize?: number;
  readonly normalize?: boolean;
  /** مسیر کش مدل (default: کش پیش‌فرض @xenova/transformers) */
  readonly cacheDir?: string;
  /**
   * پوشهٔ محلیِ مدل (transformers.js `env.localModelPath`).
   *
   * اگر ست شود، مدل **آفلاین** از روی دیسک خوانده می‌شود و هیچ درخواست
   * شبکه‌ای به HuggingFace زده نمی‌شود (`allowRemoteModels=false`). برای
   * مدل‌های ONNX که کاربر خودش دانلود/کپی کرده. نبودش یعنی رفتار قبلی.
   */
  readonly localModelPath?: string;
  /**
   * حداکثر کاراکترِ ورودی — SE-VEC-08.
   *
   * `EmbeddingConfig.maxInputLength` از ابتدا تعریف شده بود و در کل
   * مخزن **هیچ مصرف‌کننده‌ای نداشت**. نتیجه‌اش این بود که یک تابعِ
   * ۵۰۰ خطی بی‌سروصدا به tokenizer می‌رفت و آن‌جا بریده می‌شد —
   * بریدنی که نه قابل تنظیم بود و نه قابل مشاهده.
   */
  readonly maxInputLength?: number;
}

export interface EmbeddingResult {
  readonly embedding: readonly number[];
  readonly model: string;
  readonly dimensions: number;
}

export interface IEmbeddingGenerator {
  /**
   * نام مدل استفاده‌شده.
   */
  readonly modelName: string;

  /**
   * تولید embedding برای یک متن.
   */
  generate(text: string): Promise<EmbeddingResult>;

  /**
   * تولید embedding برای یک batch از متن‌ها.
   */
  generateBatch(texts: readonly string[]): Promise<EmbeddingResult[]>;

  /**
   * آیا generator آماده استفاده است؟
   */
  isReady(): Promise<boolean>;

  /**
   * آزادسازی منابع (model cache و...).
   */
  dispose(): Promise<void>;
}
