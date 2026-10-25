import { generateSymbolId } from '../utils/hash';

/**
 * کش hash نام کامل → شناسه.
 *
 * فرمول: hash(fullyQualifiedName + ':' + kind)
 *
 * ── تصحیح یک ادعای نادرست (SE-DATA-05) ────────────────────────────
 *
 * این سرآمد قبلاً می‌گفت «اگر فایل rename شود اما نام symbol تغییر
 * نکند، شناسه ثابت می‌ماند». آن ادعا هیچ‌وقت درست نبود: هر سه mapper
 * مسیر فایل را داخل نام کامل می‌گذاشتند، پس rename همهٔ شناسه‌ها را
 * عوض می‌کرد.
 *
 * تصمیم فاز ۱۵: **مسیر بخشی از هویت است** و مستندات با پیاده‌سازی
 * هم‌راستا شد، نه برعکس — چون دو فایل با تابع `parse` واقعاً دو symbol
 * هستند و یکی کردنشان در هر پروژه‌ای فروپاشی می‌سازد. تشخیص rename
 * جای دیگری حل می‌شود: موتور تدریجی فایل جابه‌جاشده را از روی hash
 * محتوا می‌شناسد.
 *
 * سیاست تصادم در `SymbolIdentity.ts` است، نه اینجا.
 */
export class SymbolIdGenerator {
  private readonly cache = new Map<string, string>();

  getId(fullyQualifiedName: string, kind: string): string {
    const key = `${fullyQualifiedName}:${kind}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    const id = generateSymbolId(fullyQualifiedName, kind);
    this.cache.set(key, id);
    return id;
  }

  invalidateByPrefix(fqNamePrefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(fqNamePrefix)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
