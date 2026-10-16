/**
 * تایپ‌های عمومی مشترک بین تمام بخش‌های Semantic Engine.
 * هیچ وابستگی به VSCode API ندارد — قابل استفاده در تست‌های خارج از extension context.
 */

/** استراتژی استخراج — ترتیب fallback: lsp > tree-sitter > heuristic */
/**
 * منبع استخراج.
 *
 * `typescript-api` در فاز ۱۸ اضافه شد: `TSDependencyExtractor` با
 * TypeScript compiler API کار می‌کند و خودش را `'tree-sitter'` معرفی
 * می‌کرد، که یعنی `source` در خروجی دروغ می‌گفت (SE-DEP-08).
 */
export type ExtractionSource = 'lsp' | 'tree-sitter' | 'typescript-api' | 'heuristic';

/** سطح اطمینان استخراج (0-100) */
export type Confidence = number & { readonly __brand: 'Confidence' };

export function makeConfidence(value: number): Confidence {
  if (value < 0 || value > 100 || !Number.isInteger(value)) {
    throw new RangeError(`Confidence must be integer 0-100, got ${value}`);
  }
  return value as Confidence;
}

/** نتیجه‌ی یک عملیات که ممکن است fail شود — بدون throw */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Disposable pattern — برای resource cleanup.
 * هم LSP client ها و هم tree-sitter parser ها باید dispose شوند.
 */
export interface IDisposable {
  dispose(): void | Promise<void>;
}

/**
 * رویداد تغییر فایل — ورودی فاز incremental (فاز ۹).
 * از الان تعریف می‌شود تا اینترفیس‌ها بتوانند آن را در signature بپذیرند.
 */
export interface FileChangeEvent {
  readonly type: 'created' | 'modified' | 'deleted' | 'renamed';
  readonly path: string;
  readonly oldPath?: string; // فقط برای renamed
}
