/**
* تنظیمات embedding در Semantic Engine.
*
* طراحی:
* - به‌صورت پیش‌فرض disabled است تا هزینه/حافظه نداشته باشد.
* - کاربر می‌تواند در settings VSCode فعال کند.
*/

export interface EmbeddingConfig {
  /** فعال‌بودن تولید embedding */
  readonly enabled: boolean;
  /** نام مدل محلی یا API */
  readonly model: string;
  /** نرمالایز کردن vector */
  readonly normalize: boolean;
  /** تعداد chunk های پردازش‌شده در هر batch */
  readonly batchSize: number;
  /** حداکثر تعداد token/char برای truncate */
  readonly maxInputLength: number;
}

export function createEmbeddingConfig(
  overrides: Partial<EmbeddingConfig> = {}
): EmbeddingConfig {
  return {
    enabled: overrides.enabled ?? false,
    model: overrides.model ?? 'Xenova/all-MiniLM-L6-v2',
    normalize: overrides.normalize ?? true,
    batchSize: overrides.batchSize ?? 8,
    maxInputLength: overrides.maxInputLength ?? 1024,
  };
}
