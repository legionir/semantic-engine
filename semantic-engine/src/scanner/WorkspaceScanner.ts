import * as fs from 'fs';
import * as path from 'path';
import { FileEntry, Diagnostic } from '../core/types/project-index.types';
import { FileIdGenerator } from '../core/id/FileIdGenerator';
import { LanguageRegistry } from '../language/LanguageRegistry';
import { ScannerConfig, createScannerConfig } from '../core/config/ScannerConfig';
import { FileProcessor, FileContentHook } from './FileProcessor';
import { Result, ok, err } from '../core/types/common.types';
import { ProgressLike } from '../host/Progress';
import { createYielder } from '../host/EventLoop';
import { CancellationToken } from '../host/Cancellation';
import { IgnoreMatcher, normalizeSeparators } from '../core/config/IgnoreMatcher';
import { ILogger, defaultLogger } from '../host/Logger';

/**
 * WorkspaceScanner — اسکن بازگشتی workspace و تولید FileEntry[].
 *
 * طراحی:
 * - Async/streaming: فایل‌ها یکی‌یکی پردازش می‌شوند، نه همه در حافظه
 * - Progress reporting: از ProgressLike میزبان برای نمایش پیشرفت
 * - Cancellation: از CancellationToken پشتیبانی می‌کند
 * - Deterministic: ترتیب خروجی بر اساس sorted path — rerun بدون تغییر = همان خروجی
 */

export interface ScanResult {
  readonly files: FileEntry[];
  readonly languages: string[];
  readonly scanDuration: number; // milliseconds
  readonly skippedCount: number;
  readonly errorCount: number;
  /**
   * چه چیزی ایندکس نشد و چرا.
   *
   * SE-SCAN-08 — قبلاً فقط `errorCount++` بود: نه مسیر ثبت می‌شد نه
   * دلیل. کاربر هیچ راهی نداشت بفهمد کدام فایل از ایندکس افتاده.
   */
  readonly diagnostics: readonly Diagnostic[];
}

export class WorkspaceScanner {
  private readonly config: ScannerConfig;
  private readonly idGenerator: FileIdGenerator;
  private readonly languageRegistry: LanguageRegistry;
  private readonly fileProcessor: FileProcessor;

  /** آنچه ایندکس نشد و چرا — SE-SCAN-08. */
  private diagnostics: Diagnostic[] = [];

  /** Effective ignore patterns after merging .gitignore */
  private readonly ignoreMatcher: IgnoreMatcher;

  constructor(
    private readonly workspaceRoot: string,
    config?: Partial<ScannerConfig>,
    contentHook?: FileContentHook,
    private readonly logger: ILogger = defaultLogger,
    /** Directory the index is written to; ignored by its full relative path. */
    outputDir?: string
  ) {
    this.config = createScannerConfig(config);
    this.idGenerator = new FileIdGenerator();
    this.languageRegistry = new LanguageRegistry();
    this.fileProcessor = new FileProcessor(
      this.idGenerator,
      this.languageRegistry,
      this.config,
      this.workspaceRoot,
      contentHook,
      this.logger,
      {
        onSkip: (absolutePath, reason) => {
          this.diagnostics.push({
            severity: 'warning',
            message: `Could not read ${path.relative(this.workspaceRoot, absolutePath)}: ${reason}`,
            line: 1,
            source: 'scanner',
          });
        },
      }
    );

    /*
    | MIG-42: تصمیم ignore از `IgnoreMatcher` می‌آید — همان چیزی که
    | `FileWatcher` هم استفاده می‌کند. تا فاز ۲۸ این منطق دو بار
    | نوشته شده بود و آن دو با هم نمی‌خواندند (SE-SCAN-03).
    */
    this.ignoreMatcher = new IgnoreMatcher({
      workspaceRoot,
      config: this.config,
      ...(outputDir !== undefined ? { outputDir } : {}),
    });

  }

  /**
   * اسکن کامل workspace.
   *
   * @param progress - برای نمایش پیشرفت (اختیاری)
   * @param token - برای لغو عملیات (اختیاری)
   */
  async scan(
    progress?: ProgressLike,
    token?: CancellationToken
  ): Promise<Result<ScanResult>> {
    const startTime = Date.now();
    this.diagnostics = [];
    const files: FileEntry[] = [];
    const languageSet = new Set<string>();
    let skippedCount = 0;
    let errorCount = 0;

    try {
      // ۱. جمع‌آوری لیست تمام فایل‌ها (بدون خواندن محتوا)
      progress?.report({ message: 'Collecting file list...' });
      const filePaths = await this.collectFilePaths(this.workspaceRoot, 0, token);

      if (token?.isCancellationRequested) {
        return err(new Error('Scan cancelled by user'));
      }

      // ۲. Sort برای deterministic output
      filePaths.sort();

      const totalFiles = filePaths.length;
      progress?.report({ message: `Processing ${totalFiles} files...` });

      /*
      | ۳. پردازش با استخر همزمانی محدود — SE-SCAN-06.
      |
      | نتیجه در آرایه‌ای هم‌اندازهٔ ورودی و بر اساس *اندیس* نوشته
      | می‌شود، نه با push. یعنی ترتیب خروجی به ترتیب پایان کارها
      | بستگی ندارد و خروجی قطعی می‌ماند.
      */
      const processed: (FileEntry | null)[] = new Array(filePaths.length).fill(null);
      const concurrency = Math.max(1, this.config.concurrency);
      let nextIndex = 0;
      let completed = 0;
      let cancelled = false;

      const tick = createYielder();

      const worker = async (): Promise<void> => {
        for (;;) {
          const index = nextIndex++;
          if (index >= filePaths.length) return;

          if (token?.isCancellationRequested) {
            cancelled = true;
            return;
          }

          const filePath = filePaths[index]!;

          try {
            processed[index] = await this.fileProcessor.processFile(filePath);
            if (processed[index] === null) skippedCount++;
          } catch (error) {
            errorCount++;
            /*
            | SE-SCAN-08 — قبلاً فقط `errorCount++` بود. بدون مسیر و
            | دلیل، کاربر هیچ راهی ندارد بفهمد چه چیزی ایندکس نشده.
            | P-05/SE-F-036 — مسیرِ onSkip («Could not read <path>: …»)
            | در این شاخه نبود؛ diagnostic قابل نسبت‌دادن به فایل نبود.
            | حالا هر دو شاخهٔ skip/error یک شکل دارند.
            */
            this.diagnostics.push({
              severity: 'warning',
              message: `Could not process file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
              line: 1,
              source: 'scanner',
            });
          }

          completed++;
          if (completed % 25 === 0) {
            progress?.report({
              message: `Processing files... (${completed}/${totalFiles})`,
              increment: (25 / totalFiles) * 100,
            });
          }

          /*
          | SE-PERF-01 — خواندن فایل خودش I/O است و ییلد می‌کند، ولی
          | hash و تشخیص زبان CPU-bound هستند و برای فایل‌های کوچک
          | (که از کش صفحه می‌آیند) کل حلقه عملاً همگام می‌شود.
          */
          await tick();
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, filePaths.length) }, worker));

      if (cancelled) {
        return err(new Error('Scan cancelled by user'));
      }

      for (const entry of processed) {
        if (!entry) continue;
        files.push(entry);
        if (entry.language) languageSet.add(entry.language);
      }

      const languages = Array.from(languageSet).sort();
      const scanDuration = Date.now() - startTime;

      return ok({
        files,
        languages,
        scanDuration,
        skippedCount,
        errorCount,
        diagnostics: this.diagnostics,
      });
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * جمع‌آوری بازگشتی مسیر تمام فایل‌ها (فقط مسیرها، بدون خواندن).
   */
  private async collectFilePaths(
    dirPath: string,
    currentDepth: number,
    token?: CancellationToken,
    visitedRealPaths: Set<string> = new Set()
  ): Promise<string[]> {
    if (token?.isCancellationRequested) return [];

    // بررسی max depth
    if (this.config.maxDepth > 0 && currentDepth >= this.config.maxDepth) {
      return [];
    }

    /*
    | SE-SCAN-07 — symlinkهای پوشه بی‌صدا حذف می‌شدند، چون
    | `entry.isDirectory()` برایشان false است. در monorepo این یعنی
    | زیردرخت‌های کامل از ایندکس بیرون می‌مانند بدون هیچ گزارشی.
    |
    | دنبال کردنشان بدون تشخیص حلقه ممکن نیست: یک symlink به بالادست
    | پیمایش را بی‌نهایت می‌کند. مسیر *واقعی* هر پوشه ثبت می‌شود.
    */
    let realPath: string;
    try {
      realPath = await fs.promises.realpath(dirPath);
    } catch {
      return [];
    }

    if (visitedRealPaths.has(realPath)) {
      this.diagnostics.push({
        severity: 'info',
        message: `Skipped a symlink cycle at ${path.relative(this.workspaceRoot, dirPath) || '.'}`,
        line: 1,
        source: 'scanner',
      });
      return [];
    }
    visitedRealPaths.add(realPath);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      this.diagnostics.push({
        severity: 'warning',
        message: `Could not read directory ${path.relative(this.workspaceRoot, dirPath) || '.'}: ${error instanceof Error ? error.message : String(error)}`,
        line: 1,
        source: 'scanner',
      });
      return [];
    }

    const result: string[] = [];

    for (const entry of entries) {
      if (token?.isCancellationRequested) break;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = normalizeSeparators(path.relative(this.workspaceRoot, fullPath));

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        if (!this.config.followSymlinks) continue;
        try {
          const stat = await fs.promises.stat(fullPath);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch (error) {
          /*
          | SE-SCAN-14: symlink شکسته. قبلاً فقط `continue` بود — همان
          | الگویی که SE-SCAN-08 دربارهٔ آن هشدار داده بود: چیزی از
          | ایندکس می‌افتد و هیچ‌کس نمی‌فهمد. در monorepoها یک
          | `node_modules` نیمه‌نصب دقیقاً همین را می‌سازد.
          */
          this.diagnostics.push({
            severity: 'warning',
            message: `Skipped a broken symlink at ${relativePath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            line: 1,
            source: 'scanner',
          });
          continue;
        }
      }

      if (isDirectory) {
        if (this.shouldIgnoreDirectory(entry.name, relativePath)) continue;
        const subFiles = await this.collectFilePaths(
          fullPath, currentDepth + 1, token, visitedRealPaths
        );
        result.push(...subFiles);
      } else if (isFile) {
        if (this.shouldIgnoreFile(entry.name, relativePath)) continue;
        result.push(fullPath);
      }
    }

    return result;
  }

  /**
   * بررسی اینکه آیا یک directory باید skip شود.
   */
  private shouldIgnoreDirectory(dirName: string, relativePath: string): boolean {
    return this.ignoreMatcher.ignoresDirectory(dirName, relativePath);
  }

  private shouldIgnoreFile(fileName: string, relativePath: string): boolean {
    return this.ignoreMatcher.ignoresFile(fileName, relativePath);
  }

  /**
   * دسترسی به id generator — برای فازهای بعدی که نیاز به consistent id دارند.
   */
  getIdGenerator(): FileIdGenerator {
    return this.idGenerator;
  }

  /**
   * دسترسی به language registry — برای فازهای بعدی.
   */
  getLanguageRegistry(): LanguageRegistry {
    return this.languageRegistry;
  }
}


