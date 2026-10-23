/**
 * کش استخراج هر فایل برای `index`.
 *
 * استخراج symbol و وابستگی حدود نیمی از زمان یک ایندکس است و فقط به
 * `(مسیر، شناسهٔ فایل، هش محتوا، زبان)` و کد استخراج‌گرها بستگی دارد. اینجا
 * خروجی خام (پیش از resolve کردن importها، چون به فایل‌های دیگر وابسته است)
 * نگه داشته می‌شود تا اجرای بعدی روی فایل‌های دست‌نخورده استخراج را رد کند.
 *
 * همه‌ی مراحل بعد (resolve، گراف‌ها، git، diagnostics، بردار) هر بار اجرا
 * می‌شوند؛ پس خروجی با ایندکس کامل یکی است و ابطال فقط یک سؤال دارد:
 * «آیا استخراج‌گرها همان‌اند؟». اثر انگشت آن در `ExtractorFactory` ساخته می‌شود.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConfigUsageEntry, ExportEntry, ImportEntry, SymbolEntry } from '../core/types/project-index.types';

/** با تغییر شکل فایل کش بالا ببرید. */
export const EXTRACTION_CACHE_SCHEMA = 1;

export interface CachedExtraction {
  readonly fileId: string;
  readonly hash: string;
  readonly language: string;
  readonly usages: readonly ConfigUsageEntry[];
  /** `null` یعنی استخراج‌گری برای این زبان نبود. */
  readonly symbols: { readonly symbols: readonly SymbolEntry[]; readonly warnings: readonly string[] } | null;
  readonly dependencies: {
    readonly imports: readonly ImportEntry[];
    readonly exports: readonly ExportEntry[];
    readonly diagnostics: readonly string[];
  } | null;
}

interface CacheFile {
  readonly schema: number;
  readonly fingerprint: string;
  readonly files: Record<string, CachedExtraction>;
}

export interface ExtractionCacheStats {
  readonly hits: number;
  readonly misses: number;
}

export class ExtractionCache {
  private previous = new Map<string, CachedExtraction>();
  private readonly next = new Map<string, CachedExtraction>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly filePath: string,
    private readonly fingerprint: string,
    private readonly options: { readonly reuse?: boolean } = {}
  ) {}

  /** خواندن کش قبلی؛ هر مشکلی (نبود، خراب، اثر انگشت متفاوت) یعنی کش خالی. */
  load(): void {
    this.previous = new Map();
    if (this.options.reuse === false) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<CacheFile>;
      if (parsed.schema !== EXTRACTION_CACHE_SCHEMA || parsed.fingerprint !== this.fingerprint) return;
      if (!parsed.files || typeof parsed.files !== 'object') return;
      this.previous = new Map(Object.entries(parsed.files));
    } catch {
      this.previous = new Map();
    }
  }

  get(relativePath: string, fileId: string, hash: string, language: string): CachedExtraction | null {
    const entry = this.previous.get(relativePath);
    if (entry && entry.fileId === fileId && entry.hash === hash && entry.language === language) {
      this.hits++;
      this.next.set(relativePath, entry);
      return entry;
    }
    this.misses++;
    return null;
  }

  set(relativePath: string, entry: CachedExtraction): void {
    this.next.set(relativePath, entry);
  }

  get stats(): ExtractionCacheStats {
    return { hits: this.hits, misses: this.misses };
  }

  /**
   * فقط فایل‌های همین اجرا نگه داشته می‌شوند (فایل حذف‌شده از کش هم می‌رود).
   * نوشتن اتمی است و شکستش هرگز ایندکس را خراب نمی‌کند.
   */
  save(): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const body: CacheFile = {
        schema: EXTRACTION_CACHE_SCHEMA,
        fingerprint: this.fingerprint,
        files: Object.fromEntries(this.next),
      };
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, this.filePath);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* کش اختیاری است */
      }
    }
  }
}
