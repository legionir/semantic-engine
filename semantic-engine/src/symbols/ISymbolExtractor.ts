/**
 * اینترفیس مشترک برای تمام استراتژی‌های symbol extraction.
 *
 * این اینترفیس تضمین می‌کند که هر سه استراتژی (LSP, tree-sitter, heuristic)
 * خروجی یکسان تولید کنند — مصرف‌کننده اهمیتی به منبع استخراج نمی‌دهد.
 *
 * افزودن tree-sitter یا heuristic در آینده = فقط implement کردن همین اینترفیس.
 */

import {
  SymbolEntry,
} from '../core/types/project-index.types';
import { ExtractionSource, IDisposable, Result } from '../core/types/common.types';

/**
 * نتیجه‌ی استخراج symbol ها از یک فایل.
 */
export interface SymbolExtractionResult {
  /** symbol های استخراج‌شده */
  readonly symbols: readonly SymbolEntry[];

  /** source استخراج */
  readonly source: ExtractionSource;

  /** آیا استخراج کامل بود یا partial (مثلاً syntax error) */
  readonly partial: boolean;

  /** خطاها/هشدارهای حین استخراج */
  readonly warnings: readonly string[];
}

/**
 * اینترفیس symbol extractor.
 * هر implementation (LSP, tree-sitter, heuristic) باید این را implement کند.
 */
export interface ISymbolExtractor extends IDisposable {
  /** نام استراتژی — برای logging و debug */
  readonly name: ExtractionSource;

  /** اولویت — بالاتر = ترجیح بیشتر (lsp=100, tree-sitter=50, heuristic=10) */
  readonly priority: number;

  /**
   * بررسی اینکه آیا این extractor برای یک زبان خاص فعال/در دسترس است.
   *
   * مثلاً استخراج‌گر tree-sitter بررسی می‌کند که آیا گرامر زبان مربوطه
   * نصب و فعال است.
   */
  isAvailable(languageId: string): Promise<boolean>;

  /**
   * استخراج symbol ها از یک فایل.
   *
   * @param fileId - id فایل (از FileIdGenerator)
   * @param filePath - مسیر relative فایل
   * @param content - محتوای فایل (برای tree-sitter/heuristic)
   * @param languageId - زبان فایل (از LanguageRegistry)
   *
   * فایل content را به‌عنوان پارامتر می‌گیرد (نه خودش بخواند) تا:
   * - در تست‌ها mock-پذیر باشد
   * - فایل دوبار خوانده نشود (یک‌بار در FileProcessor، یک‌بار اینجا)
   */
  extract(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<SymbolExtractionResult>>;
}
