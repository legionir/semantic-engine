import { generateFileId } from '../utils/hash';

/**
 * تولید و مدیریت id فایل‌ها.
 *
 * طراحی class-based (نه فقط function) به دو دلیل:
 * 1. cache: اگر یک فایل چندبار پرسیده شود، hash دوباره محاسبه نمی‌شود
 * 2. آمادگی فاز ۹: باید بتواند rename tracking انجام دهد
 *    (old path → new path، اما old id → deprecated)
 */
export class FileIdGenerator {
  private readonly cache = new Map<string, string>();

  /**
   * تولید id برای یک relative path.
   * همیشه برای یک path یکسان، id یکسان برمی‌گرداند (deterministic + cached).
   */
  getId(relativePath: string): string {
    const existing = this.cache.get(relativePath);
    if (existing) return existing;

    const id = generateFileId(relativePath);
    this.cache.set(relativePath, id);
    return id;
  }

  /**
   * تثبیت یک شناسهٔ *موجود* روی یک مسیر — SE-INC-01.
   *
   * ثابت معمول سیستم `id = hash(path)` است، ولی rename عمداً آن را
   * می‌شکند: وقتی محتوا عوض نشده، شناسه باید بماند تا ارجاع‌های
   * موجود معتبر بمانند. تا امروز راهی برای گفتنِ این به مولد نبود —
   * `getId` همیشه دوباره hash می‌گرفت. نتیجه این بود که پس از
   * restart، همان فایل یک شناسهٔ دوم می‌گرفت و در ایندکس دوبار
   * ظاهر می‌شد.
   */
  seed(relativePath: string, id: string): void {
    this.cache.set(relativePath, id);
  }

  /**
   * پاک کردن id یک path (مثلاً بعد از حذف فایل).
   * لازم برای فاز ۹ incremental.
   */
  invalidate(relativePath: string): void {
    this.cache.delete(relativePath);
  }

  /**
   * بررسی اینکه آیا path قبلاً id گرفته.
   */
  has(relativePath: string): boolean {
    return this.cache.has(relativePath);
  }

  /**
   * پاک‌سازی کامل cache.
   */
  clear(): void {
    this.cache.clear();
  }
}
