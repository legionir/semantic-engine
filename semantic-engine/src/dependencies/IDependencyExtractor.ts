/**
 * اینترفیس dependency extractor — جدا از symbol چون منطق متفاوتی دارد.
 *
 * DependencyExtractor ممکن است cross-file باشد (مثلاً resolve کردن import paths)
 * در حالی که SymbolExtractor فقط با یک فایل کار می‌کند.
 */

import { ExportEntry, ImportEntry } from '../core/types/project-index.types';
import { ExtractionSource, IDisposable, Result } from '../core/types/common.types';

export interface DependencyExtractionResult {
  readonly imports: readonly ImportEntry[];
  readonly exports: readonly ExportEntry[];
  readonly partial: boolean;
  /**
   * Every problem met on the way to this result (an extractor that threw, returned an error or
   * only a partial answer). Empty/absent means the first available extractor succeeded cleanly.
   */
  readonly diagnostics?: readonly string[];
}

export interface IDependencyExtractor extends IDisposable {
  readonly name: ExtractionSource;
  readonly priority: number;

  isAvailable(languageId: string): Promise<boolean>;

  /**
   * استخراج imports و exports.
   *
   * resolvedFileId در مرحله‌ی resolve (بعد از داشتن workspace map کامل) پر می‌شود.
   * اینجا فقط استخراج خام.
   */
  extractDependencies(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<DependencyExtractionResult>>;
}
