import * as fs from 'fs';
import * as path from 'path';
import { FileEntry } from '../core/types/project-index.types';
import { FileIdGenerator } from '../core/id/FileIdGenerator';
import { LanguageRegistry } from '../language/LanguageRegistry';

import { sha256, normalizePath } from '../core/utils/hash';
import { isBinaryBuffer, detectEncoding, countLines, decodeBuffer, normalizeLineEndings } from '../core/utils/encoding';

/*
| SE-SCAN-16: این‌جا یک جدول نشانهٔ کامنت داشت و `LiteralMask` یک جدول
| دیگر، و آن دو با هم نمی‌خواندند. حالا هر دو از جدول زبان‌ها می‌خوانند
| — جایی که نشانهٔ کامنت، مثل پسوند و shebang، خصوصیت خودِ زبان است.
|
| `#` در C و C++ دستور پیش‌پردازنده است نه کامنت؛ آن تصمیم هم به همان
| جدول منتقل شد.
*/
import { computeBasicMetrics, hashAndCountWholeFile, hashWholeBinary, isGenerated, isTestFile } from './fileMetrics';
import { ScannerConfig } from '../core/config/ScannerConfig';
import { ILogger, defaultLogger } from '../host/Logger';

/**
 * قلاب محتوا.
 *
 * FileProcessor هر فایل متنی را برای hash و متریک‌ها می‌خواند و بعد
 * دورش می‌ریزد؛ آن‌طرف، استخراج symbol و وابستگی همان فایل را دوباره
 * از دیسک می‌خوانند. با این قلاب، محتوا همان‌جا تحویل داده می‌شود و
 * خواندن دوباره لازم نیست.
 *
 * فقط وقتی صدا زده می‌شود که *کل* فایل خوانده شده باشد. برای فایل
 * بزرگ‌تر از `maxFileSizeBytes` تنها ۸KB اول در دست است (SE-SCAN-01) و
 * تحویل دادن آن به‌جای محتوای کامل، یک باگ را به باگ بدتری تبدیل
 * می‌کند.
 */
export interface FileContentHook {
  onContent(file: FileEntry, content: string): void;
}

/**
 * گزارش فایلی که پردازش نشد.
 *
 * SE-SCAN-08 — پردازشگر خطا را می‌بلعید و `null` برمی‌گرداند، پس
 * اسکنر آن را «رد شده» می‌شمرد و نه دلیلش را می‌دانست و نه مسیرش را
 * گزارش می‌کرد.
 */
export interface FileSkipHook {
  onSkip(absolutePath: string, reason: string): void;
}

/**
 * FileProcessor — پردازش یک فایل و تولید FileEntry.
 *
 * مسئولیت‌ها:
 * - خواندن محتوا
 * - محاسبه‌ی hash, size, lines, encoding
 * - تشخیص binary, generated, testFile
 * - محاسبه‌ی basic metrics (اگر فعال باشد)
 *
 * این کلاس هیچ symbol extraction انجام نمی‌دهد — آن فازهای بعدی است.
 * فیلدهای symbolIds, imports, exports, diagnostics, outline همگی خالی می‌مانند.
 */
export class FileProcessor {
  constructor(
    private readonly idGenerator: FileIdGenerator,
    private readonly languageRegistry: LanguageRegistry,
    private readonly config: ScannerConfig,
    private readonly workspaceRoot: string,
    private readonly contentHook?: FileContentHook,
    private readonly logger: ILogger = defaultLogger,
    private readonly skipHook?: FileSkipHook
  ) {}

  /**
   * پردازش یک فایل و تولید FileEntry.
   *
   * @param absolutePath - مسیر مطلق فایل
   * @returns FileEntry مطابق schema، یا null اگر فایل قابل خواندن نبود
   */
  async processFile(absolutePath: string): Promise<FileEntry | null> {
    try {
      const stat = await fs.promises.stat(absolutePath);
      if (!stat.isFile()) return null;

      const relativePath = normalizePath(path.relative(this.workspaceRoot, absolutePath));
      const id = this.idGenerator.getId(relativePath);

      // خواندن بخش اول فایل برای binary detection
      const complete = stat.size <= this.config.maxFileSizeBytes;
      const buffer = await this.readFileBuffer(absolutePath, stat.size);
      const binary = isBinaryBuffer(buffer);

      // فایل‌های باینری: فقط metadata، بدون تحلیل محتوا
      if (binary) {
        /*
        | SE-SCAN-01، مسیر باینری — برای فایلی که بریده شده، بافرِ ۸KB
        | برای hash کافی نیست؛ کل فایل استریم می‌شود.
        */
        const hash = complete
          ? sha256(buffer)
          : await hashWholeBinary(absolutePath);

        return this.createBinaryFileEntry(id, relativePath, stat, hash);
      }

      // فایل‌های متنی: تحلیل کامل
      const encoding = detectEncoding(buffer);
      const content = decodeBuffer(buffer, encoding);

      /*
      | SE-PORT-01 — محتوای نرمال‌شده (CRLF/CR → LF) مبنای hash/size/
      | lines است تا ایندکس بین ویندوز و لینوکس یکسان بماند و جابه‌جایی
      | OS نیازی به re-index نداشته باشد. `content` خام برای تحلیل
      | tree-sitter دست‌نخورده می‌ماند (شمارهٔ خط‌ها ثابت است).
      */
      const normalizedContent = normalizeLineEndings(content);

      /*
      | SE-SCAN-01 — hash و شمارش خط باید روی **کل** فایل باشند، حتی
      | وقتی محتوا برای تحلیل بریده شده. نسخهٔ قبلی هر دو را از همان
      | ۸KB می‌گرفت، یعنی هر تغییری بعد از بایت ۸۱۹۲ روی hash اثری
      | نداشت و تشخیص staleness برای فایل بزرگ کاملاً از کار می‌افتاد.
      | بازتولید شد: دو فایل ۱۰MB که فقط بایت آخرشان فرق داشت، hash
      | یکسان می‌گرفتند.
      */
      const { hash: contentHash, lines } = complete
        ? { hash: sha256(normalizedContent), lines: countLines(normalizedContent) }
        : await hashAndCountWholeFile(absolutePath, encoding);

      const firstLine = content.split('\n')[0] || '';
      const languageInfo = this.languageRegistry.detect(relativePath, firstLine);

      const entry: FileEntry = {
        id,
        path: relativePath,
        language: languageInfo?.id ?? null,
        encoding,
        /*
        | SE-PORT-01 — اندازه بر حسب بایتِ محتوای نرمال‌شده (UTF-8، LF)
        | ذخیره می‌شود، نه `stat.size` خام روی دیسک. `stat.size` با
        | CRLF/LF و BOM فرق می‌کند و ایندکس را غیرقابل‌حمل بین OSها
        | می‌کرد. برای فایل‌های بریده‌شده به `stat.size` عقب‌گرد می‌کنیم.
        */
        size: complete ? Buffer.byteLength(normalizedContent, 'utf8') : stat.size,
        lines,
        hash: contentHash,
        modified: stat.mtime.toISOString(),
        binary: false,
        /*
        | فقط وقتی نوشته می‌شود که واقعاً بریده شده باشد. `false` روی
        | هر فایل، نویز است و schema هم پیش‌فرضش را `false` گذاشته.
        */
        ...(complete ? {} : { truncated: true }),
        testFile: isTestFile(relativePath),
        generated: isGenerated(relativePath, content),
        // فیلدهای فاز‌های بعدی — خالی/undefined
        symbolIds: [],
        imports: [],
        exports: [],
        diagnostics: [],
        outline: [],
        metrics: this.config.computeBasicMetrics
          ? computeBasicMetrics(content, languageInfo?.id ?? null)
          : undefined,
      };

      if (complete) {
        this.contentHook?.onContent(entry, content);
      }

      return entry;
    } catch (error) {
      // فایلی که قابل خواندن نیست (permission denied, etc.) → skip با warning
      this.logger.warn('cannot process file', { path: absolutePath, cause: error });
      this.skipHook?.onSkip(absolutePath, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * خواندن محتوای فایل — با رعایت maxFileSizeBytes.
   * فایل‌های بزرگ‌تر از حد: فقط بخش اول خوانده می‌شود (برای binary detection و shebang).
   */
  private async readFileBuffer(absolutePath: string, fileSize: number): Promise<Buffer> {
    if (fileSize <= this.config.maxFileSizeBytes) {
      return fs.promises.readFile(absolutePath);
    }

    // فایل بزرگ: فقط 8KB اول برای binary detection
    const fd = await fs.promises.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
  }

  /**
   * ساخت FileEntry برای فایل باینری — حداقل metadata.
   */
  private createBinaryFileEntry(
    id: string,
    relativePath: string,
    stat: fs.Stats,
    hash: string
  ): FileEntry {
    const languageInfo = this.languageRegistry.detect(relativePath);
    return {
      id,
      path: relativePath,
      language: languageInfo?.id ?? null,
      encoding: 'binary',
      size: stat.size,
      lines: 0,
      hash,
      modified: stat.mtime.toISOString(),
      binary: true,
      testFile: false,
      generated: false,
      symbolIds: [],
      imports: [],
      exports: [],
      diagnostics: [],
      outline: [],
    };
  }

}

