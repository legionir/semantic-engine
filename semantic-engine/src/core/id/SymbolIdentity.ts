/**
 * هویت symbol — یک مالک واحد برای «شناسهٔ symbol».
 *
 * پیش از این، سه mapper سه قاعدهٔ متفاوت داشتند و هر سه اشتباه بودند
 * به یکی از این دو شکل:
 *
 *   - استخراج‌گرهای heuristic روی تصادم `continue` می‌کردند، یعنی
 *     overloadها و متدهای هم‌نامِ دو کلاس **بی‌صدا حذف** می‌شدند
 *     (SE-SYM-18).
 *   - mapperهای LSP و tree-sitter پسوند `:L{line}C{col}` می‌زدند، یعنی
 *     یک خط خالی در ابتدای فایل شناسهٔ همهٔ symbolهای هم‌نام را عوض
 *     می‌کرد (SE-DATA-06).
 *
 * راه‌حل هر دو یکی است: تصادم با یک **شمارندهٔ ترتیبی در همان گروه**
 * حل می‌شود، نه با مکان. دومین `parse` در یک فایل همیشه `parse#1` است،
 * چه در خط ۱۰ باشد چه در خط ۱۰۰۰.
 *
 * ── تصمیم دربارهٔ مسیر فایل (SE-DATA-05) ───────────────────────────
 *
 * سرآمد `SymbolIdGenerator` می‌نوشت «اگر فایل rename شود اما نام symbol
 * تغییر نکند، شناسه ثابت می‌ماند». این ادعا هرگز پیاده نشده بود — هر
 * دو mapper مسیر را داخل نام کامل می‌گذاشتند.
 *
 * تصمیم: **مسیر بخشی از هویت است** و مستندات با پیاده‌سازی هم‌راستا
 * شد، نه برعکس. دلیلش این است که ادعای مستند در عمل جمع‌شدنی نیست:
 * دو فایل با تابع `parse` باید دو symbol باشند، وگرنه در هر پروژه‌ای
 * که یک نام تکراری دارد، symbolها روی هم می‌افتند. تشخیص rename جای
 * دیگری حل می‌شود — موتور تدریجی فایل جابه‌جاشده را از روی hash محتوا
 * می‌شناسد.
 */

import { generateSymbolId } from '../utils/hash';

export interface SymbolIdRequest {
  readonly filePath: string;
  readonly parentFqName?: string | null;
  readonly name: string;
  readonly kind: string;
}

export interface AllocatedSymbolId {
  readonly id: string;
  readonly fullyQualifiedName: string;
  /** چندمین symbol با همین نام و نوع در همین دامنه — از صفر. */
  readonly ordinal: number;
}

/**
 * نام کامل: ریشه در فایل، تودرتویی با نقطه.
 *
 * `src/a.ts::Cache.get` — جدا بودن `::` از `.` عمدی است تا مرز
 * «فایل» از مرز «دامنه» قابل تشخیص بماند.
 */
export function buildFullyQualifiedName(
  filePath: string,
  parentFqName: string | null | undefined,
  name: string
): string {
  return parentFqName ? `${parentFqName}.${name}` : `${filePath}::${name}`;
}

export class SymbolIdAllocator {
  /** `fqName:kind` → چند بار تا حالا دیده شده است. */
  private readonly counts = new Map<string, number>();

  allocate(request: SymbolIdRequest): AllocatedSymbolId {
    const base = buildFullyQualifiedName(
      request.filePath,
      request.parentFqName,
      request.name
    );
    const key = `${base}:${request.kind}`;
    const ordinal = this.counts.get(key) ?? 0;
    this.counts.set(key, ordinal + 1);

    /*
    | عضو اول گروه نام خالص را نگه می‌دارد. این یعنی برای اکثریت قاطع
    | symbolها — آن‌هایی که اصلاً تصادمی ندارند — شناسه دقیقاً همان
    | چیزی است که قبلاً بود، و ایندکس‌های موجود بی‌دلیل باطل نمی‌شوند.
    */
    const fullyQualifiedName = ordinal === 0 ? base : `${base}#${ordinal}`;

    return {
      id: generateSymbolId(fullyQualifiedName, request.kind),
      fullyQualifiedName,
      ordinal,
    };
  }

  reset(): void {
    this.counts.clear();
  }
}
