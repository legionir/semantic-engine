import {
  ISymbolExtractor,
  SymbolExtractionResult,
} from './ISymbolExtractor';
import { ExtractionSource, Result, ok, err, IDisposable } from '../core/types/common.types';
import { mergeExtractionResults } from './mergeExtractionResults';

/**
 * SymbolExtractorManager — مدیریت fallback chain بین extractors.
 *
 * ترتیب: LSP (priority=90) > tree-sitter (50) > heuristic (10)
 *
 * اگر LSP در دسترس نباشد، به tree-sitter fallback می‌کند.
 * اگر آن هم نباشد، به regex/heuristic.
 *
 * طراحی plugin-like:
 * - extractors در constructor register می‌شوند
 * - افزودن tree-sitter = فقط register کردن یک instance جدید
 * - هیچ تغییری در این کلاس لازم نیست
 *
 * ── دو تغییر در فاز ۳۳ ─────────────────────────────────────────────
 *
 * **SE-SYM-01 — نتیجهٔ ناقص دیگر دور ریخته نمی‌شود.** پیش از این، اگر
 * بالاترین اولویت `partial: true` برمی‌گرداند، کل نتیجه‌اش کنار
 * می‌رفت و استخراج‌گر بعدی — که همیشه `partial: false` می‌گوید —
 * جایش را می‌گرفت. حالا نتیجه‌ها ادغام می‌شوند
 * (`mergeExtractionResults`).
 *
 * **SE-SYM-03 — `isAvailable` دیگر به‌ازای هر فایل صدا زده نمی‌شود.**
 * روی یک اسکن ۵۵ فایلی یعنی ۵۵ بار پرسیدن از هر استخراج‌گر، و برای
 * زبان‌سرور هر بار یعنی احتمال یک رفت‌وبرگشت. جواب به‌ازای
 * (استخراج‌گر × زبان) با TTL کش می‌شود: بی‌TTL، سروری که وسط اسکن
 * می‌میرد تا آخر «در دسترس» می‌ماند.
 */

/** پیش‌فرض کش در دسترس بودن. همان ۳۰ ثانیه‌ای که `LSPClientManager` قدیمی داشت. */
const DEFAULT_AVAILABILITY_TTL_MS = 30_000;

export interface SymbolExtractorManagerOptions {
  /** صفر یعنی بدون کش. */
  readonly availabilityTtlMs?: number;
  readonly now?: () => number;
}

interface AvailabilityEntry {
  readonly available: boolean;
  readonly at: number;
}

export class SymbolExtractorManager implements IDisposable {
  private readonly extractors: ISymbolExtractor[] = [];
  private readonly availability = new Map<ISymbolExtractor, Map<string, AvailabilityEntry>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SymbolExtractorManagerOptions = {}) {
    this.ttlMs = options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * ثبت یک extractor جدید.
   * خودکار بر اساس priority مرتب می‌شود (بالاترین اول).
   */
  register(extractor: ISymbolExtractor): void {
    this.extractors.push(extractor);
    this.extractors.sort((a, b) => b.priority - a.priority);
    this.availability.delete(extractor);
  }

  /** فراموش کردن پاسخ‌های کش‌شدهٔ `isAvailable`. */
  invalidateAvailability(): void {
    this.availability.clear();
  }

  /**
   * استخراج symbol ها با fallback chain.
   *
   * 1. بالاترین priority را امتحان می‌کند
   * 2. اگر available نبود یا fail کرد → بعدی
   * 3. نتیجهٔ ناقص کنار گذاشته نمی‌شود؛ با نتیجهٔ بعدی ادغام می‌شود
   * 4. اگر هیچ‌کدام کار نکرد → error
   */
  async extract(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<SymbolExtractionResult>> {
    const errors: string[] = [];
    const collected: SymbolExtractionResult[] = [];

    for (const extractor of this.extractors) {
      const available = await this.isAvailable(extractor, languageId);
      if (!available) {
        continue;
      }

      const result = await extractor.extract(fileId, filePath, content, languageId);
      if (!result.ok) {
        /*
        | SE-SYM-03 (بخش دوم): خطای استخراج‌گرهای قبلی وقتی یکی
        | موفق می‌شد دور ریخته می‌شد. حالا به `warnings` نتیجه
        | می‌رسد، چون «tree-sitter جواب داد» و «LSP قبلش ترکید» دو
        | خبر متفاوت‌اند.
        */
        errors.push(`[${extractor.name}] ${result.error.message}`);
        continue;
      }

      collected.push(result.value);

      // نتیجهٔ کامل، زنجیره را تمام می‌کند.
      if (!result.value.partial) break;
    }

    if (collected.length === 0) {
      return err(new Error(
        `No symbol extractor available for language "${languageId}". Tried: ${errors.join('; ')}`
      ));
    }

    const merged = mergeExtractionResults(collected);
    if (errors.length === 0) return ok(merged.result);

    return ok({ ...merged.result, warnings: [...merged.result.warnings, ...errors] });
  }

  /**
   * بررسی اینکه حداقل یک extractor برای یک زبان در دسترس است.
   */
  async hasExtractorFor(languageId: string): Promise<boolean> {
    for (const extractor of this.extractors) {
      if (await this.isAvailable(extractor, languageId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * لیست extractors ثبت‌شده — برای debug/logging.
   */
  getRegisteredExtractors(): readonly { name: ExtractionSource; priority: number }[] {
    return this.extractors.map(e => ({ name: e.name, priority: e.priority }));
  }

  async dispose(): Promise<void> {
    for (const extractor of this.extractors) {
      await extractor.dispose();
    }
    this.extractors.length = 0;
    this.availability.clear();
  }

  private async isAvailable(extractor: ISymbolExtractor, languageId: string): Promise<boolean> {
    if (this.ttlMs <= 0) return extractor.isAvailable(languageId);

    let perLanguage = this.availability.get(extractor);
    if (!perLanguage) {
      perLanguage = new Map();
      this.availability.set(extractor, perLanguage);
    }

    const cached = perLanguage.get(languageId);
    const now = this.now();
    if (cached && now - cached.at < this.ttlMs) return cached.available;

    const available = await extractor.isAvailable(languageId);
    perLanguage.set(languageId, { available, at: now });
    return available;
  }
}
