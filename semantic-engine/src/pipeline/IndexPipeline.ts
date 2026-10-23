/**
 * IndexPipeline — کل مسیر ایندکس، بدون ویرایشگر — MIG-20.
 *
 * تا امروز این منطق ۸۳۱ خط داخل `extension.ts` بود: درهم‌آمیخته با
 * `vscode.window.withProgress`، با `vscode.workspace.fs.readFile`، و
 * غیرقابل تست. اینجا همان ترتیب مراحل است، ولی وابستگی‌ها تزریق
 * می‌شوند و خروجی یک مقدار برگردانده‌شده است، نه یک اثر جانبی روی
 * دیسک.
 *
 * یک تغییر رفتاری عمدی: **هر فایل یک بار خوانده می‌شود.** نسخهٔ قبلی
 * هر فایل را چهار بار می‌خواند — یک‌بار اسکنر برای hash و متریک، و سه
 * بار دیگر برای symbol، وابستگی و نگاشت پیکربندی. حالا اسکنر محتوا را
 * همان‌جا تحویل می‌دهد و بقیه از همان استفاده می‌کنند.
 */

import * as path from 'path';
import { WorkspaceScanner, ScanResult } from '../scanner/WorkspaceScanner';
import { ScannerConfig } from '../core/config/ScannerConfig';

import { SymbolExtractorManager } from '../symbols/SymbolExtractorManager';
import { DependencyExtractorManager } from '../dependencies/DependencyExtractorManager';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { JsonExporter, GraphResult } from '../export/JsonExporter';
import { CallGraphBuilder, TypeGraphBuilder, DependencyGraphBuilder } from '../graphs';
import { GitInfoCollector } from '../core/git';
import { VectorIndexer } from '../vector/VectorIndexer';
import { ExtractionCache } from './ExtractionCache';
import { resolveReExports } from './reExports';
import { collectDiagnostics, enrich } from './lspStages';
import { StageContext } from './stageContext';
import { extractAll } from './extractionStage';
import { buildFileComplexityMap } from './importLinking';
import {
  FileEntry,
  SymbolEntry,
  ProjectIndex,
  VectorChunk,
} from '../core/types/project-index.types';
import { ILogger, silentLogger } from '../host/Logger';
import { ProgressLike } from '../host/Progress';
import { CancellationToken, throwIfCancelled } from '../host/Cancellation';
import { FileSystemPort, NodeFileSystem } from '../host/FileSystem';
import { yieldToEventLoop } from '../host/EventLoop';
import { ILlmClient } from '../ai/llm/LlmClient';
import { FileDiagnosticsSource } from '../lsp/DiagnosticsProvider';
import { EnrichmentInput, EnrichmentResult } from '../lsp/LspEnrichmentService';

export interface IndexPipelineOptions {
  readonly workspaceRoot: string;
  /** مسیری که در `ProjectIndex` ثبت می‌شود؛ نوشتن کار `OutputWriter` است. */
  readonly outputPath: string;
  readonly symbolExtractors: SymbolExtractorManager;
  readonly dependencyExtractors: DependencyExtractorManager;
  readonly scannerConfig?: Partial<ScannerConfig>;
  readonly logger?: ILogger;
  readonly progress?: ProgressLike;
  readonly token?: CancellationToken;
  readonly fileSystem?: FileSystemPort;
  readonly llmClient?: ILlmClient | null;
  /** `null` یعنی بدون بردار. پیش‌فرض هم همین است. */
  readonly vectorIndexer?: VectorIndexer | null;
  /**
   * chunkهای برداریِ اجرای قبلی — SE-VEC-09.
   *
   * وقتی داده شود، embeddingِ chunkهای دست‌نخورده دوباره تولید
   * نمی‌شود. شناسهٔ chunk از فاز ۴۴ هویتی است، پس این تطبیق پایدار
   * است.
   */
  readonly previousVectorChunks?: readonly VectorChunk[];
  /** `null` یعنی بدون git — لازم برای خروجی قطعی در تست. */
  readonly gitCollector?: GitInfoCollector | null;
  /**
   * منبع diagnostic — فاز ۳۴. `null` (پیش‌فرض) یعنی فقط هشدارهای
   * اسکنر و استخراج، همان چیزی که تا فاز ۳۳ بود.
   *
   * جدا از `symbolExtractors` است چون کار متفاوتی می‌کند و هزینهٔ
   * متفاوتی دارد: می‌شود diagnostic گرفت بدون اینکه symbolها از
   * زبان‌سرور بیایند، و برعکس.
   */
  readonly diagnosticsSource?: FileDiagnosticsSource | null;
  /**
   * سقف زمانی کل مرحلهٔ diagnostics. وقتی تمام شد، بقیهٔ فایل‌ها
   * بدون diagnostic می‌مانند و یک هشدار ثبت می‌شود.
   *
   * روی ۱۶۴ فایل این مخزن، زبان‌سرور ۷٫۷ ثانیه طول می‌کشد؛ روی یک
   * مخزن ۱۰٬۰۰۰ فایلی، بی‌سقف یعنی ایندکس هرگز تمام نمی‌شود.
   */
  readonly diagnosticsBudgetMs?: number;
  /**
   * غنی‌سازی با زبان‌سرور — فاز ۳۷. `null` (پیش‌فرض) یعنی همان
   * چیزی که تا فاز ۳۶ بود.
   *
   * اینترفیس عمداً کوچک است تا pipeline به زیرسیستم LSP گره نخورد —
   * همان کاری که `diagnosticsSource` در فاز ۳۴ کرد.
   */
  readonly enrichment?: { enrich(input: EnrichmentInput): Promise<EnrichmentResult> } | null;
  /**
   * کش استخراج هر فایل (براساس هش محتوا). ندادن آن یعنی همیشه استخراج کامل؛
   * خروجی در هر دو حالت یکی است. `run()` آن را load و save می‌کند.
   */
  readonly extractionCache?: ExtractionCache | null;
  readonly pretty?: boolean;
}

export interface IndexStats {
  readonly files: number;
  readonly symbols: number;
  readonly filesWithDependencies: number;
  readonly vectorChunks: number;
  readonly durationMs: number;
  /** چند بار محتوای یک فایل از دیسک خوانده شد. */
  readonly fileReads: number;
  /** فایل‌هایی که استخراجشان از کش آمد / دوباره انجام شد. */
  readonly extractionCache?: { readonly hits: number; readonly misses: number };
}

export interface IndexResult {
  readonly projectIndex: ProjectIndex;
  readonly stats: IndexStats;
}

export class IndexPipeline {
  /**
   * بایت‌هایی که پس از اجرا هنوز نگه داشته شده‌اند — SE-EXT-03.
   * برای اندازه‌گیری در تست.
   */
  private retainedBytes = 0;
  private contentReleased = false;
  private fileReads = 0;

  /**
   * بایت‌های متنی که در اوجِ اجرا نگه داشته شده بودند.
   *
   * SE-EXT-09 — قبلاً این عدد **بعد** از `contents.clear()` حساب
   * می‌شد، پس همیشه صفر بود؛ و هیچ‌جا هم خوانده نمی‌شد، پس صفرِ
   * همیشگی‌اش دیده نشد. حالا پیش از رهاسازی اندازه گرفته می‌شود.
   */
  get retainedContentBytes(): number {
    return this.retainedBytes;
  }

  /** آیا متن فایل‌ها پس از آخرین مصرف‌کننده رها شد. */
  get releasedContent(): boolean {
    return this.contentReleased;
  }

  private readonly logger: ILogger;
  private readonly fs: FileSystemPort;
  private readonly progress: ProgressLike | undefined;
  private readonly token: CancellationToken | undefined;

  constructor(private readonly options: IndexPipelineOptions) {
    this.logger = (options.logger ?? silentLogger);
    this.fs = options.fileSystem ?? new NodeFileSystem();
    this.progress = options.progress;
    this.token = options.token;
  }

  async run(): Promise<IndexResult> {
    const startedAt = Date.now();
    const { workspaceRoot } = this.options;

    // ── ۱. اسکن، با گرفتن محتوا در همان گذر ────────────────────────────
    this.report('Scanning workspace');

    const contents = new Map<string, string>();
    this.fileReads = 0;

    const scanner = new WorkspaceScanner(
      workspaceRoot,
      this.options.scannerConfig ?? {},
      {
        onContent: (file, content) => {
          this.fileReads++;
          if (!file.binary) contents.set(file.id, content);
        },
      },
      undefined,
      path.dirname(path.resolve(this.options.outputPath))
    );

    this.options.extractionCache?.load();
    const scanned = await scanner.scan(this.progress, this.token);
    if (!scanned.ok) {
      throw new Error(`Scan failed: ${scanned.error.message}`);
    }
    throwIfCancelled(this.token, 'Indexing');

    const files = scanned.value.files;
    this.logger.debug('scan complete', { files: files.length, contents: contents.size });

    // ── ۲. symbol و وابستگی، روی محتوای همان گذر ───────────────────────
    this.report('Extracting symbols and dependencies');

    const resolver = new TSPathResolver(workspaceRoot);
    const { symbols, dependencies, diagnosticsByFile, configUsagesByFile, addDiagnostic } =
      await extractAll(this.stageContext(), files, contents, resolver, () => this.fileReads++);
    /* پیش از مراحل بعد ذخیره می‌شود: آن‌ها ممکن است symbolها را غنی کنند و کش باید خام بماند. */
    this.options.extractionCache?.save();

    // ── ۲.۵ diagnostics از زبان‌سرور (فاز ۳۴) ──────────────────────────
    const diagnosticsRun = await collectDiagnostics(
      this.stageContext(), files, contents, addDiagnostic, () => this.fileReads++
    );

    /*
    | SE-EXT-09 — اینجا `contents.clear()` بود، با این توضیح که «از
    | این نقطه به بعد هیچ‌کس به متن فایل‌ها نیاز ندارد».
    |
    | آن ادعا همان موقع هم غلط بود. دو مرحلهٔ بعدی هر دو `contents`
    | می‌گیرند: `enrich()` (فاز ۳۷) که چون fallback به دیسک دارد
    | بی‌صدا هر فایل را **دوباره می‌خواند** — یعنی دقیقاً کاری که
    | این کش قرار بود جلویش را بگیرد — و `buildVectors()` که از فاز
    | ۴۴ سورس واقعی می‌خواهد و هیچ fallbackی ندارد. اندازه‌گیری روی
    | fixture: از ۲٬۱۷۶ chunk فقط یکی سورس داشت.
    |
    | رهاسازی به بعد از آخرین مصرف‌کننده منتقل شد. هدفِ SE-EXT-03 —
    | اینکه کلِ کارگاه تا پایان اجرا در حافظه نماند — سر جایش است،
    | فقط مرزش درست شد.
    */

    // ── ۳. اتصال وابستگی‌ها به فایل‌ها ─────────────────────────────────
    const dependencyByFile = new Map(dependencies.map(dep => [dep.fileId, dep]));

    let filesWithDependencies: FileEntry[] = files.map(file => {
      const dependency = dependencyByFile.get(file.id);
      const extraction = diagnosticsByFile.get(file.id);
      const withDiagnostics = extraction
        ? { ...file, diagnostics: [...(file.diagnostics ?? []), ...extraction] }
        : file;
      return dependency
        ? { ...withDiagnostics, imports: dependency.imports, exports: dependency.exports }
        : withDiagnostics;
    });

    // ── ۴. re-exportها ────────────────────────────────────────────────
    this.report('Resolving re-exports');

    const reExports = resolveReExports(workspaceRoot, filesWithDependencies, symbols, dependencies, resolver);
    filesWithDependencies = reExports.files;
    const reExportEdges = reExports.edges;

    // ── ۵. گراف‌ها ────────────────────────────────────────────────────
    this.report('Building graphs');
    throwIfCancelled(this.token, 'Indexing');

    /*
    | SE-PERF-01 — این سه سازنده کاملاً همگام‌اند و روی یک مخزن
    | بزرگ چند ثانیه طول می‌کشند. یک ییلد میان هرکدام، صف I/O را
    | باز می‌کند بدون اینکه خود ساخت گراف کند شود.
    */
    const callGraph = await new CallGraphBuilder({
      workspaceRoot,
      files: filesWithDependencies,
      symbols,
    }).buildAsync();
    await yieldToEventLoop();

    const typeGraph = new TypeGraphBuilder(symbols).build();
    await yieldToEventLoop();

    const dependencyGraph = [
      ...new DependencyGraphBuilder(filesWithDependencies).build(),
      ...reExportEdges,
    ];
    await yieldToEventLoop();

    const graphs: GraphResult = { callGraph, typeGraph, dependencyGraph };

    const scanResult: ScanResult = { ...scanned.value, files: filesWithDependencies };

    // ── ۶. git ────────────────────────────────────────────────────────
    const git = await this.collectGit(scanResult.files, symbols);

    // ── ۷. ساخت ایندکس ────────────────────────────────────────────────
    this.report('Building project index');

    const exporter = new JsonExporter();
    const projectIndex = await exporter.buildProjectIndex(
      scanResult,
      symbols,
      {
        outputPath: this.options.outputPath,
        workspaceRoot,
        pretty: this.options.pretty !== false,
      },
      /*
      | عمداً خالی: وابستگی‌ها همین بالا به فایل‌ها متصل شده‌اند و
      | `exports` هم با شناسهٔ symbol مقصدِ re-export غنی شده است. دادن
      | دوبارهٔ آرایه، آن غنی‌سازی را با نسخهٔ خام بازنویسی می‌کرد —
      | و پیش از اصلاح SE-EXP-03 هر import را هم دو بار ثبت می‌کرد.
      */
      [],
      graphs,
      [],
      this.options.llmClient ?? undefined,
      git.gitInfo,
      { configUsages: configUsagesByFile, gitFileMetrics: git.fileMetrics }
    );

    // ── ۷.۵ غنی‌سازی با زبان‌سرور (فاز ۳۷) ────────────────────────────
    const enriched = await enrich(this.stageContext(), projectIndex, contents);

    /*
    | ── ۸. بردارها ──────────────────────────────────────────────────
    |
    | SE-VEC-01 — `contents` اینجا هنوز زنده است و تا فاز ۴۴ به
    | ایندکسر داده نمی‌شد، پس chunkها فقط برچسب داشتند. حالا سورس
    | واقعی هم می‌رود.
    */
    const vectorChunks = await this.buildVectors(enriched, contents);
    const finalIndex: ProjectIndex = {
      ...(vectorChunks ? { ...enriched, vectorChunks } : enriched),
      /*
      | مرحله اجرا شده باشد، نتیجه‌اش را در ایندکس می‌نویسیم تا مصرف‌کننده
      | بتواند «دیباگ نبود» را از «دیباگی نیست» تشخیص بدهد.
      */
      ...(diagnosticsRun ? { diagnosticsRun } : {}),
    };

    /*
    | SE-EXT-03 / SE-EXT-09 — اندازه‌گیری **پیش از** رهاسازی.
    |
    | تا امروز این حلقه بعد از `clear()` اجرا می‌شد و روی یک map
    | خالی می‌چرخید، پس همیشه صفر می‌داد. عددِ واقعی این است که در
    | اوج چقدر متن زنده بوده.
    */
    this.retainedBytes = 0;
    for (const text of contents.values()) this.retainedBytes += text.length;

    // آخرین مصرف‌کننده تمام شد؛ حالا رها می‌شود.
    contents.clear();
    this.contentReleased = true;

    const stats: IndexStats = {
      files: finalIndex.files.length,
      symbols: finalIndex.symbols.length,
      filesWithDependencies: dependencies.length,
      vectorChunks: vectorChunks?.length ?? 0,
      durationMs: Date.now() - startedAt,
      fileReads: this.fileReads,
      ...(this.options.extractionCache ? { extractionCache: this.options.extractionCache.stats } : {}),
    };

    this.logger.info('index built', { ...stats });
    return { projectIndex: finalIndex, stats };
  }

  /**
   * محتوای یک فایل، ترجیحاً از همان گذر اسکن.
   *
   * تنها موردی که به دیسک برمی‌گردد، فایلی است که اسکنر عمداً ناقص
   * خوانده (بزرگ‌تر از `maxFileSizeBytes`، SE-SCAN-01). تحویل دادن آن
   * ۸KB به استخراج‌گر یعنی ایندکسی که ادعا می‌کند فایل را دیده است.
   */
  /*
  | SE-SCAN-17: the real output directory must never be indexed, or every run indexes the
  | previous run's index. It is passed to the scanner as `outputDir` and ignored by its
  | FULL relative path (`IgnoreMatcher.isOutput`). The earlier version added only the first
  | path segment to `ignoreDirectories`, so an output under `src/out` made the scanner skip
  | the whole `src` tree (audit F-16).
  */

  private async contentOf(
    file: FileEntry,
    cache: Map<string, string>,
    countRead: () => void
  ): Promise<string | null> {
    const cached = cache.get(file.id);
    if (cached !== undefined) return cached;

    try {
      const content = await this.fs.readFile(path.join(this.options.workspaceRoot, file.path));
      countRead();
      cache.set(file.id, content);
      return content;
    } catch (error) {
      this.logger.warn('could not read file', {
        file: file.path,
        reason: (error as Error).message,
      });
      return null;
    }
  }

  private async collectGit(
    files: readonly FileEntry[],
    symbols: readonly SymbolEntry[]
  ): Promise<{
    gitInfo: NonNullable<Awaited<ReturnType<GitInfoCollector['collect']>>['gitInfo']> | undefined;
    driftScore: number;
    fileMetrics: Awaited<ReturnType<GitInfoCollector['collectFileMetrics']>>['metricsByPath'] | undefined;
  }> {
    const collector = this.options.gitCollector;
    if (collector === null || collector === undefined) {
      return { gitInfo: undefined, driftScore: 0, fileMetrics: undefined };
    }

    this.report('Collecting git information');
    const paths = files.map(file => file.path);
    const [info, metrics] = await Promise.all([
      collector.collect(paths),
      collector.collectFileMetrics(paths, buildFileComplexityMap(files, symbols)),
    ]);

    return {
      gitInfo: info.gitInfo ?? undefined,
      driftScore: info.driftScore,
      fileMetrics: metrics.metricsByPath,
    };
  }

  private async buildVectors(
    index: ProjectIndex,
    contents: ReadonlyMap<string, string>
  ): Promise<VectorChunk[] | null> {
    const indexer = this.options.vectorIndexer;
    if (!indexer) return null;

    this.report('Indexing vector chunks');
    return indexer.index(index, {
      contents,
      /*
      | SE-VEC-09 — chunkهای اجرای قبلی. هر chunk با شناسه و
      | contentHash یکسان، embeddingش دوباره تولید نمی‌شود. بدون
      | این، هر اجرای incremental کلِ پروژه را از نو بردار می‌کرد.
      */
      ...(this.options.previousVectorChunks
        ? { previous: this.options.previousVectorChunks }
        : {}),
    });
  }

  private stageContext(): StageContext {
    return {
      options: this.options,
      logger: this.logger,
      token: this.token,
      report: (message, increment) => this.report(message, increment),
      contentOf: (file, cache, countRead) => this.contentOf(file, cache, countRead),
    };
  }

  private report(message: string, increment?: number): void {
    this.progress?.report(increment === undefined ? { message } : { message, increment });
  }
}

export { buildFileComplexityMap } from './importLinking';

/* Kept for existing importers; the implementations live in importResolution.ts. */
export {
  PROJECT_PATH_LANGUAGES,
  resolveProjectImport,
  resolvePythonImport,
  resolveGoImport,
  resolveRustImport,
  resolveJavaImport,
} from './importResolution';
