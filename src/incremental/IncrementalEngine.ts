/**
 * IncrementalEngine — موتور به‌روزرسانی تدریجی project-index.
 *
 * طراحی:
 * - فقط فاز ۱ تا ۵ برای فایل تغییریافته + وابسته‌های مستقیم آن اجرا می‌شود.
 * - graph ها: edge های مربوط به فایل‌های تغییرکرده حذف و دوباره ساخته می‌شوند.
 * - rename: اگر hash محتوا تغییر نکرده، id قدیمی حفظ می‌شود و فقط path آپدیت می‌شود.
 * - delete: فایل، symbol ها، و تمام edge های وابسته cleanup می‌شوند.
 */

import * as fs from 'fs';
import * as path from 'path';
import { FileChangeEvent } from '../core/types/common.types';
import {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
  ImportEntry,
  ExportEntry,
} from '../core/types/project-index.types';
import { FileProcessor } from '../scanner/FileProcessor';
import { FileIdGenerator } from '../core/id/FileIdGenerator';
import { LanguageRegistry } from '../language/LanguageRegistry';
import { createScannerConfig, ScannerConfig } from '../core/config/ScannerConfig';
import { SymbolExtractorManager } from '../symbols/SymbolExtractorManager';
import { DependencyExtractorManager } from '../dependencies/DependencyExtractorManager';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { PROJECT_PATH_LANGUAGES } from '../pipeline/IndexPipeline';

import { ProjectIndexStore } from './ProjectIndexStore';
import { rebuildGraphs, resolveImport } from './incrementalGraphs';
import { finalizeIncrementalIndex } from './incrementalFinalize';
import { DependencyResult } from '../export/JsonExporter';

import { VectorIndexer } from '../vector/VectorIndexer';
import { normalizePath } from '../core/utils/hash';
import { ILogger, defaultLogger } from '../host/Logger';

export interface IncrementalEngineOptions {
  readonly workspaceRoot: string;
  readonly symbolExtractorManager: SymbolExtractorManager;
  readonly dependencyExtractorManager: DependencyExtractorManager;
  /** بردارساز incremental؛ null/undefined یعنی vectorها دست‌نخورده بمانند. */
  readonly vectorIndexer?: VectorIndexer | null;
  readonly blueprintRebuildThreshold?: number;
  /** Same scan overrides the initial index used (`--max-file-size-mb`, `--ignore`, …). */
  readonly scannerConfig?: Partial<ScannerConfig>;
  readonly logger?: ILogger;
}

export interface IncrementalUpdateResult {
  readonly projectIndex: ProjectIndex;
  readonly changedFileIds: readonly string[];
  readonly removedFileIds: readonly string[];
  readonly dependentFileIds: readonly string[];
  readonly driftScore: number;
  readonly shouldRebuildBlueprint: boolean;
}

export class IncrementalEngine {
  private store: ProjectIndexStore | null = null;
  /** زنجیرهٔ ترتیبی `applyChanges` — SE-INC-07. */
  private pending: Promise<void> = Promise.resolve();
  private readonly fileProcessor: FileProcessor;
  private readonly idGenerator: FileIdGenerator;
  private readonly languageRegistry: LanguageRegistry;
  private readonly pathResolver: TSPathResolver;
  private readonly options: Required<IncrementalEngineOptions>;

  constructor(options: IncrementalEngineOptions) {
    this.options = {
      ...options,
      vectorIndexer: options.vectorIndexer ?? null,
      blueprintRebuildThreshold: options.blueprintRebuildThreshold ?? 0.05,
      scannerConfig: options.scannerConfig ?? {},
      logger: options.logger ?? defaultLogger,
    };

    this.idGenerator = new FileIdGenerator();
    this.languageRegistry = new LanguageRegistry();
    const config = createScannerConfig(options.scannerConfig);
    this.fileProcessor = new FileProcessor(
      this.idGenerator,
      this.languageRegistry,
      config,
      this.options.workspaceRoot
    );
    this.pathResolver = new TSPathResolver(this.options.workspaceRoot);
  }

  /**
   * بارگذاری project-index موجود در engine.
   */
  load(projectIndex: ProjectIndex): void {
    this.store = new ProjectIndexStore(projectIndex);

    /*
    | SE-INC-01: کش با شناسهٔ *ذخیره‌شده* پر می‌شود، نه با
    | `getId(file.path)` که دوباره hash مسیر را می‌گیرد.
    |
    | این تفاوت فقط وقتی مهم می‌شود که یک rename شناسه را عمداً حفظ
    | کرده باشد — از آن لحظه `hash(path)` دیگر با شناسهٔ واقعی نمی‌خواند
    | و هر تغییری در آن فایل یک ورودی دوم در ایندکس می‌ساخت.
    */
    for (const file of projectIndex.files) {
      this.idGenerator.seed(file.path, file.id);
    }
  }

  /**
   * دریافت store فعلی (برای تست).
   */
  getStore(): ProjectIndexStore | null {
    return this.store;
  }

  /**
   * اعمال یک batch از رویدادهای فایل‌سیستم.
   *
   * ── SE-INC-07 ────────────────────────────────────────────────────
   *
   * هیچ‌چیز مانع اجرای هم‌زمان دو batch نبود — و در حالت watch این
   * حالت عادی است، نه استثنا: تایمر batch دوم وقتی fire می‌کند که
   * اولی هنوز وسط I/O است. store مشترک است، پس دو اجرا روی یک
   * نگاشت می‌نویسند.
   *
   * اندازه‌گیری‌شده با شمردن ورود/خروج در `reprocessFile`: سه
   * `applyChanges` هم‌زمان، **۸ بار** هم‌پوشانی داشتند.
   *
   * مهار، یک زنجیرهٔ promise است نه قفل واقعی: هر فراخوانی به دنبال
   * قبلی می‌ایستد. ترتیب همان ترتیب فراخوانی می‌ماند، که برای
   * رویدادهای فایل‌سیستم دقیقاً همان چیزی است که می‌خواهیم.
   */
  async applyChanges(events: FileChangeEvent[]): Promise<IncrementalUpdateResult> {
    const run = this.pending
      .catch(() => undefined)
      .then(() => this.applyChangesUnsafe(events));

    /*
    | `pending` نباید rejected بماند وگرنه هر batch بعدی هم شکست
    | می‌خورد؛ خطا فقط به فراخوانِ خودش برمی‌گردد.
    */
    this.pending = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  private async applyChangesUnsafe(events: FileChangeEvent[]): Promise<IncrementalUpdateResult> {
    if (!this.store) {
      throw new Error('IncrementalEngine not loaded. Call load() first.');
    }

    // مسیرها را به فرم POSIX نرمال کن — watcher ویندوز backslash می‌فرستد
    // و کل index با '/' کار می‌کند.
    events = events.map(e => ({
      ...e,
      path: normalizePath(e.path),
      oldPath: e.oldPath ? normalizePath(e.oldPath) : e.oldPath,
    }));

    const changedFileIds = new Set<string>();
    const removedFileIds = new Set<string>();
    const dependentFileIds = new Set<string>();
    const fileContents = new Map<string, string>();
    /*
    | SE-INC-03: شناسهٔ symbolهایی که با فایل‌های حذف‌شده رفتند.
    | پس از `removeFile` هیچ جای دیگری ثبت نیستند، پس اگر همین‌جا
    | برداشته نشوند، پاک‌سازی یال‌ها راهی برای شناختنشان ندارد.
    */
    const removedSymbolIds = new Set<string>();

    // ۱. پردازش رویدادهای rename (قبل از delete/create برای حفظ id)
    const renameEvents = events.filter(e => e.type === 'renamed');
    const otherEvents = events.filter(e => e.type !== 'renamed');

    for (const event of renameEvents) {
      const result = await this.handleRename(event);
      if (result) {
        changedFileIds.add(result.fileId);
        for (const symbolId of result.removedSymbolIds ?? []) {
          removedSymbolIds.add(symbolId);
        }
        if (result.content) {
          fileContents.set(result.fileId, result.content);
        }
        if (result.dependents) {
          for (const dep of result.dependents) {
            dependentFileIds.add(dep.id);
          }
        }
      }
    }

    // ۲. پردازش رویدادهای create/modify/delete
    for (const event of otherEvents) {
      if (event.type === 'deleted') {
        const file = this.store.getFileByPath(event.path);
        if (file) {
          // وابسته‌های مستقیم را هم برای reprocess علامت بزن
          for (const dep of this.store.getTransitiveDependents(file.id)) {
            dependentFileIds.add(dep.id);
          }
          for (const symbolId of this.store.removeFile(file.id)) {
            removedSymbolIds.add(symbolId);
          }
          removedFileIds.add(file.id);
        }
        continue;
      }

      if (event.type === 'created' || event.type === 'modified') {
        const result = await this.reprocessFile(event.path);
        if (result) {
          this.store.upsertFile(result.file);
          this.store.setSymbolsForFile(result.file.id, result.symbols);
          changedFileIds.add(result.file.id);
          fileContents.set(result.file.id, result.content);

          /*
          | SE-INC-06: ترانزیتیو، نه فقط یک سطح. یک تایپ که از پشت
          | یک barrel دوباره export می‌شود، مصرف‌کنندهٔ واقعی‌اش دو
          | گام دورتر است.
          */
          for (const dep of this.store.getTransitiveDependents(result.file.id)) {
            dependentFileIds.add(dep.id);
          }
        }
      }
    }

    // ۳. پردازش مجدد وابسته‌های مستقیم (فاز ۱-۵ برای آن‌ها هم اجرا شود)
    for (const depFile of Array.from(dependentFileIds)) {
      if (removedFileIds.has(depFile)) continue;
      const dep = this.store.getFileById(depFile);
      if (!dep) continue;

      const result = await this.reprocessFile(dep.path);
      if (result) {
        this.store.upsertFile(result.file);
        this.store.setSymbolsForFile(result.file.id, result.symbols);
        fileContents.set(result.file.id, result.content);
      }
    }

    // ۴. rebuild graph ها فقط برای فایل‌های تغییرکرده + وابسته‌ها
    const affectedFileIds = new Set([...changedFileIds, ...dependentFileIds]);
    const graphs = rebuildGraphs(this.store, this.options.workspaceRoot, affectedFileIds, removedSymbolIds);

    const finalizedProjectIndex = await finalizeIncrementalIndex(this.store, this.options, {
      graphs,
      affectedFileIds,
      changedFileIds,
      removedFileIds,
      fileContents,
    });

    const driftScore = this.store.computeDriftScore(
      Array.from(changedFileIds),
      Array.from(removedFileIds)
    );
    const shouldRebuildBlueprint = driftScore > this.options.blueprintRebuildThreshold;

    return {
      projectIndex: finalizedProjectIndex,
      changedFileIds: Array.from(changedFileIds).sort(),
      removedFileIds: Array.from(removedFileIds).sort(),
      dependentFileIds: Array.from(dependentFileIds).sort(),
      driftScore,
      shouldRebuildBlueprint,
    };
  }

  /**
   * پردازش مجدد یک فایل: فاز ۱ (اسکن) + فاز ۳ (symbols) + فاز ۴ (deps).
   */
  private async reprocessFile(relativePath: string): Promise<{
    file: FileEntry;
    symbols: SymbolEntry[];
    dependencies: DependencyResult;
    content: string;
  } | null> {
    const absolutePath = path.join(this.options.workspaceRoot, relativePath);

    if (!fs.existsSync(absolutePath)) {
      return null;
    }

    // ۱. File scan + read content
    const fileEntry = await this.fileProcessor.processFile(absolutePath);
    if (!fileEntry) {
      return null;
    }

    let file = fileEntry;
    let content = '';
    if (!file.binary) {
      try {
        content = await fs.promises.readFile(absolutePath, 'utf8');
      } catch {
        content = '';
      }
    }

    // ۲. Symbol extraction (فاز ۳)
    const symbols: SymbolEntry[] = [];
    if (!file.binary && file.language && content) {
      const hasExtractor = await this.options.symbolExtractorManager.hasExtractorFor(file.language);
      if (hasExtractor) {
        try {
          const result = await this.options.symbolExtractorManager.extract(
            file.id,
            file.path,
            content,
            file.language
          );
          if (result.ok) {
            symbols.push(...result.value.symbols);
          }
        } catch (error) {
          this.options.logger.warn('symbol extraction failed', { file: file.path, cause: error });
        }
      }
    }

    // ۳. Dependency extraction (فاز ۴)
    let imports: ImportEntry[] = [];
    let exports: ExportEntry[] = [];
    if (!file.binary && file.language && content) {
      const hasExtractor = await this.options.dependencyExtractorManager.hasExtractorFor(file.language);
      if (hasExtractor) {
        try {
          const result = await this.options.dependencyExtractorManager.extract(
            file.id,
            file.path,
            content,
            file.language
          );
          if (result.ok) {
            imports = result.value.imports.map(imp =>
              imp.type === 'local' || PROJECT_PATH_LANGUAGES.has(file.language ?? '')
                ? resolveImport(imp, file, this.store, this.pathResolver)
                : imp
            );
            exports = [...result.value.exports];
          }
        } catch (error) {
          this.options.logger.warn('dependency extraction failed', { file: file.path, cause: error });
        }
      }
    }

    /*
    | SE-INC-11 — `FileProcessor` این دو را خالی می‌گذارد و پر کردنشان فقط
    | در `JsonExporter.attachSymbolIdsToFiles` (مسیر کامل) انجام می‌شد.
    | نتیجه: فایلی که watcher تازه دیده یا بازنویسی شده در ایندکس
    | `symbolIds: []` و `outline: []` داشت، با اینکه سمبل‌هایش در `symbols[]`
    | موجود بودند — یعنی هر مصرف‌کننده‌ای که از فایل به سمبل می‌رود تا یک
    | full re-index بی‌خبر می‌ماند. اینجا همان فرمول، با همان dedupe.
    */
    const fileSymbols: SymbolEntry[] = [];
    for (const sym of symbols) {
      if (!fileSymbols.some(other => other.id === sym.id)) fileSymbols.push(sym);
    }

    file = {
      ...file,
      imports,
      exports,
      symbolIds: fileSymbols.map(sym => sym.id),
      outline: fileSymbols.map(sym => `${sym.kind} ${sym.name}`),
      /*
      | diagnostics کهنه بدتر از نبودنِ آن‌هاست: این‌ها به محتوای *پیشین*
      | اشاره داشتند. در مسیر افزایشی زبان‌سرور اجرا نمی‌شود، پس پاک
      | می‌شوند و در next full index دوباره گرفته می‌شوند.
      */
      diagnostics: [],
    };

    return { file, symbols, dependencies: { fileId: file.id, imports, exports }, content };
  }

  /**
   * مدیریت rename: اگر hash محتوا یکسان باشد، id قدیمی حفظ می‌شود.
   */
  private async handleRename(event: FileChangeEvent): Promise<{
    fileId: string;
    dependents: FileEntry[];
    content?: string;
    /**
     * SE-P0-PARITY-02 — symbolهای فایلِ *مسیر قبلی* وقتی محتوا هم عوض شده
     * (یا rename به فایل ناموجود تنزل می‌کند). بدون این‌ها `rebuildGraphs`
     * یال‌های مرده را نگه می‌داشت، چون `removeFile` دیگر آن‌ها را در
     * `projectIndex.symbols` نمی‌گذارد.
     */
    removedSymbolIds?: readonly string[];
  } | null> {
    if (!event.oldPath || !this.store) return null;

    const oldFile = this.store.getFileByPath(event.oldPath);
    if (!oldFile) {
      // فایل قبلاً نبوده → به‌عنوان create جدید
      const result = await this.reprocessFile(event.path);
      if (result) {
        this.store.upsertFile(result.file);
        this.store.setSymbolsForFile(result.file.id, result.symbols);
        return {
          fileId: result.file.id,
          dependents: this.store.getTransitiveDependents(result.file.id),
          content: result.content,
        };
      }
      return null;
    }

    const newAbsolutePath = path.join(this.options.workspaceRoot, event.path);
    if (!fs.existsSync(newAbsolutePath)) {
      /*
      | rename به فایل موجود نیست → به‌عنوان delete.
      |
      | SE-P0-PARITY-02: قبلاً فقط `removeFile` صدا زده می‌شد و هم
      | شناسهٔ symbolهای رفته دور ریخته می‌شد و هم وابسته‌های فایلِ
      | قدیمی بازپردازش نمی‌شدند. یعنی مسیر rename یک زیرمجموعهٔ
      | ناقصِ مسیر delete بود.
      */
      const dependents = this.store.getTransitiveDependents(oldFile.id);
      const removedSymbolIds = this.store.removeFile(oldFile.id);
      return { fileId: oldFile.id, dependents, removedSymbolIds };
    }

    // مقایسه hash محتوا
    const newContent = await fs.promises.readFile(newAbsolutePath, 'utf8');
    const { sha256 } = await import('../core/utils/hash');
    const newHash = sha256(newContent);

    if (newHash === oldFile.hash) {
      /*
      | محتوا یکسان → id ثابت، فقط path آپدیت می‌شود.
      |
      | SE-P0-PARITY-01: این‌جا `removeFile` + `upsertFile` استفاده
      | می‌شد. `removeFile` symbolهای فایل را هم پاک می‌کند (SE-INC-11)،
      | پس rename فایل را بی‌symbol می‌گذاشت: ایندکس افزایشی ۵ symbol،
      | rebuild کامل ۶. `renameFile` مسیر را عوض می‌کند و symbolها را
      | نگه می‌دارد، چون rename یعنی همان فایل با مسیر دیگر.
      */
      this.store.renameFile(oldFile.id, event.path);
      this.idGenerator.invalidate(oldFile.path);
      /*
      | SE-INC-01: `getId` این‌جا بود، با کامنتِ «cache new path → old
      | id». ولی `getId` دقیقاً همان کار را *نمی‌کرد* — مسیر تازه را
      | hash می‌گرفت و شناسهٔ دیگری کش می‌کرد. کامنت درست بود و کد نه.
      */
      this.idGenerator.seed(event.path, oldFile.id);

      return {
        fileId: oldFile.id,
        dependents: this.store.getTransitiveDependents(oldFile.id),
        content: newContent,
      };
    }

    /*
    | محتوا تغییر کرده → delete old + create new.
    |
    | SE-P0-PARITY-02: وابسته‌های مسیر قدیمی (مثلاً فایلی که
    | `import { alpha } from './a'` داشت) باید بازپردازش شوند، وگرنه
    | import آن‌ها تا ابد به شناسهٔ فایلی اشاره می‌کند که دیگر نیست.
    */
    const oldDependents = this.store.getTransitiveDependents(oldFile.id);
    const removedSymbolIds = this.store.removeFile(oldFile.id);
    const result = await this.reprocessFile(event.path);
    if (result) {
      this.store.upsertFile(result.file);
      this.store.setSymbolsForFile(result.file.id, result.symbols);
      return {
        fileId: result.file.id,
        dependents: [...oldDependents, ...this.store.getTransitiveDependents(result.file.id)],
        content: result.content,
        removedSymbolIds,
      };
    }
    return { fileId: oldFile.id, dependents: oldDependents, removedSymbolIds };
  }

}
