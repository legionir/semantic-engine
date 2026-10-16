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
import { PROJECT_PATH_LANGUAGES, resolveProjectImport } from './importResolution';
import { WorkspaceScanner, ScanResult } from '../scanner/WorkspaceScanner';
import { ScannerConfig } from '../core/config/ScannerConfig';

import { SymbolExtractorManager } from '../symbols/SymbolExtractorManager';
import { ConfigUsageMapper } from '../ai/ConfigUsageMapper';
import { DependencyExtractorManager } from '../dependencies/DependencyExtractorManager';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { ReExportResolver } from '../dependencies/typescript/ReExportResolver';
import { JsonExporter, DependencyResult, GraphResult } from '../export/JsonExporter';
import { CallGraphBuilder, TypeGraphBuilder, DependencyGraphBuilder } from '../graphs';
import { GitInfoCollector } from '../core/git';
import { VectorIndexer } from '../vector/VectorIndexer';
import { rescoreAfterEnrichment } from './rescoreAfterEnrichment';
import {
  FileEntry,
  ImportEntry,
  SymbolEntry,
  DependencyEdge,
  ProjectIndex,
  VectorChunk,
  Diagnostic,
  ConfigUsageEntry,
} from '../core/types/project-index.types';
import { ILogger, silentLogger } from '../host/Logger';
import { ProgressLike } from '../host/Progress';
import { CancellationToken, throwIfCancelled } from '../host/Cancellation';
import { FileSystemPort, NodeFileSystem } from '../host/FileSystem';
import { createYielder, yieldToEventLoop } from '../host/EventLoop';
import { ILlmClient } from '../ai/llm/LlmClient';
import { FileDiagnosticsSource } from '../lsp/DiagnosticsProvider';
import { EnrichmentInput, EnrichmentResult } from '../lsp/LspEnrichmentService';
import { provenanceFor } from '../graphs/EdgeProvenance';

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
    let fileReads = 0;

    const scanner = new WorkspaceScanner(
      workspaceRoot,
      this.options.scannerConfig ?? {},
      {
        onContent: (file, content) => {
          fileReads++;
          if (!file.binary) contents.set(file.id, content);
        },
      },
      undefined,
      path.dirname(path.resolve(this.options.outputPath))
    );

    const scanned = await scanner.scan(this.progress, this.token);
    if (!scanned.ok) {
      throw new Error(`Scan failed: ${scanned.error.message}`);
    }
    throwIfCancelled(this.token, 'Indexing');

    const files = scanned.value.files;
    this.logger.debug('scan complete', { files: files.length, contents: contents.size });

    // ── ۲. symbol و وابستگی، روی محتوای همان گذر ───────────────────────
    this.report('Extracting symbols and dependencies');

    const symbols: SymbolEntry[] = [];
    const dependencies: DependencyResult[] = [];
    const resolver = new TSPathResolver(workspaceRoot);

    /*
    | SE-EXP-14: نتیجهٔ استخراج سه چیز دارد — symbolها، پرچم `partial`
    | و `warnings`. تا امروز فقط اولی برداشته می‌شد. یعنی یک فایل
    | می‌توانست کاملاً در تجزیه شکست بخورد و در خروجی هیچ ردی نگذارد.
    | همین بود که SE-SCAN-12 را ماه‌ها پنهان نگه داشت.
    */
    const diagnosticsByFile = new Map<string, Diagnostic[]>();

    /*
    | SE-EXT-03: `configUsages` این‌جا حساب می‌شود، نه در exporter.
    | فایل همین حالا در دست است؛ نگه داشتنش تا مرحلهٔ ساخت ایندکس
    | فقط برای این کار، یعنی کل متن مخزن در حافظه.
    */
    const configUsageMapper = new ConfigUsageMapper();
    const configUsagesByFile = new Map<string, readonly ConfigUsageEntry[]>();
    const addDiagnostic = (fileId: string, diagnostic: Diagnostic): void => {
      const list = diagnosticsByFile.get(fileId);
      if (list) list.push(diagnostic);
      else diagnosticsByFile.set(fileId, [diagnostic]);
    };

    let processed = 0;
    const tick = createYielder();

    for (const file of files) {
      throwIfCancelled(this.token, 'Indexing');

      if (file.binary || !file.language) continue;

      const content = await this.contentOf(file, contents, () => fileReads++);
      if (content === null) continue;

      const usages = configUsageMapper.extract(file.path, content);
      if (usages.length > 0) configUsagesByFile.set(file.id, usages);

      if (await this.options.symbolExtractors.hasExtractorFor(file.language)) {
        const result = await this.options.symbolExtractors
          .extract(file.id, file.path, content, file.language);

        if (result.ok) {
          symbols.push(...result.value.symbols);
          for (const warning of result.value.warnings) {
            addDiagnostic(file.id, {
              severity: 'warning',
              code: 'symbol-extraction',
              line: 1,
              message: warning,
              source: 'symbol-extraction',
              fileId: file.id,
            });
          }
        } else {
          this.logger.warn('symbol extraction failed', {
            file: file.path,
            reason: result.error.message,
          });
          addDiagnostic(file.id, {
            severity: 'error',
            code: 'symbol-extraction',
            line: 1,
            message: result.error.message,
            source: 'symbol-extraction',
            fileId: file.id,
          });
        }
      }

      if (await this.options.dependencyExtractors.hasExtractorFor(file.language)) {
        const result = await this.options.dependencyExtractors
          .extract(file.id, file.path, content, file.language);

        if (result.ok) {
          dependencies.push({
            fileId: file.id,
            imports: result.value.imports.map(imp =>
              imp.type === 'local' || PROJECT_PATH_LANGUAGES.has(file.language ?? '')
                ? resolveImport(imp, file, files, resolver)
                : imp
            ),
            exports: result.value.exports,
          });
          for (const message of result.value.diagnostics ?? []) {
            addDiagnostic(file.id, {
              severity: 'warning',
              code: 'dependency-extraction',
              line: 1,
              message,
              source: 'dependency-extraction',
            });
          }
        } else {
          this.logger.warn('dependency extraction failed', {
            file: file.path,
            reason: result.error.message,
          });
          addDiagnostic(file.id, {
            severity: 'error',
            code: 'dependency-extraction',
            line: 1,
            message: result.error.message,
            source: 'dependency-extraction',
            fileId: file.id,
          });
        }
      }

      processed++;
      if (processed % 25 === 0) {
        this.report(`Extracting… (${processed}/${files.length})`, (25 / files.length) * 100);
      }

      /*
      | SE-PERF-01 — استخراج CPU-bound است و `await`های بالا همگی
      | microtask هستند، پس بدون این خط صف I/O تا پایان ایندکس
      | اجرا نمی‌شود و سرور (حتی `/health`) پاسخ نمی‌دهد.
      */
      await tick();
    }

    // ── ۲.۵ diagnostics از زبان‌سرور (فاز ۳۴) ──────────────────────────
    const diagnosticsRun = await this.collectDiagnostics(
      files, contents, addDiagnostic, () => fileReads++
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

    const reExportEdges: DependencyEdge[] = [];
    const reExportSymbolIds = new Map<string, string>();
    const resolved = new ReExportResolver(
      workspaceRoot,
      filesWithDependencies,
      symbols,
      resolver
    ).resolve(dependencies);

    for (const item of resolved) {
      if (item.resolvedFileId) {
        reExportEdges.push({
          from: item.fileId,
          to: item.resolvedFileId,
          kind: 'import',
          // re-export از خود کد خوانده شده و مقصدش به فایل resolve شده
          provenance: provenanceFor('import-resolved', 'typescript-api'),
        });
      }
      if (item.resolvedSymbolId) {
        reExportSymbolIds.set(`${item.fileId}::${item.export.name}`, item.resolvedSymbolId);
      }
    }

    filesWithDependencies = filesWithDependencies.map(file => {
      if (!file.exports || file.exports.length === 0) return file;
      return {
        ...file,
        exports: file.exports.map(exp => {
          if (exp.symbolId) return exp;
          if (exp.kind !== 're-export' && exp.kind !== 'namespace') return exp;
          const symbolId = reExportSymbolIds.get(`${file.id}::${exp.name}`);
          return symbolId ? { ...exp, symbolId } : exp;
        }),
      };
    });

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
    const enriched = await this.enrich(projectIndex, contents);

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
      fileReads,
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

  /**
   * diagnostics واقعی — LSP-14.
   *
   * جدا از حلقهٔ اصلی اجرا می‌شود و نه داخلش، به یک دلیل: این مرحله
   * بودجه دارد و باید بتواند وسط کار بایستد بدون اینکه symbolها یا
   * وابستگی‌ها نیمه‌کاره بمانند. اگر داخل همان حلقه بود، تمام شدن
   * بودجه یعنی فایل‌های بعدی *هیچ‌چیز* نمی‌گرفتند.
   */
  private async collectDiagnostics(
    files: readonly FileEntry[],
    contents: Map<string, string>,
    addDiagnostic: (fileId: string, diagnostic: Diagnostic) => void,
    countRead: () => void
  ): Promise<ProjectIndex['diagnosticsRun'] | null> {
    const source = this.options.diagnosticsSource;
    if (!source) return null;

    this.report('Collecting diagnostics');
    const startedAt = Date.now();
    const budget = this.options.diagnosticsBudgetMs ?? 60_000;
    const workspaceRoot = this.options.workspaceRoot;

    let analysed = 0;
    let skipped = 0;
    const tickDiagnostics = createYielder();

    for (const file of files) {
      throwIfCancelled(this.token, 'Indexing');
      if (file.binary || !file.language) continue;

      /*
      | `>=` و نه `>`: با بودجهٔ صفر، اولین فایل در همان میلی‌ثانیه
      | شروع می‌شود و شرط بزرگ‌تر هرگز برقرار نمی‌شود — یعنی «هیچ
      | وقتی نده» در عمل «یک فایل را بررسی کن» می‌شد.
      */
      if (Date.now() - startedAt >= budget) {
        skipped++;
        continue;
      }

      const content = await this.contentOf(file, contents, countRead);
      if (content === null) continue;

      const found = await source.diagnosticsFor(
        path.isAbsolute(file.path) ? file.path : path.join(workspaceRoot, file.path),
        file.language,
        content,
        file.id
      );
      for (const diagnostic of found) addDiagnostic(file.id, diagnostic);
      if (found.length > 0) analysed++;

      await tickDiagnostics();
    }

    if (skipped > 0) {
      /*
      | بریدن بی‌صدا یعنی مصرف‌کننده فکر می‌کند این فایل‌ها مشکلی
      | ندارند. «نگاه نکردیم» با «چیزی نبود» یکی نیست.
      */
      this.logger.warn('diagnostics budget exhausted', { skipped, budgetMs: budget });
    }
    this.logger.debug('diagnostics collected', {
      filesWithFindings: analysed,
      skipped,
      ms: Date.now() - startedAt,
    });

    return {
      filesWithFindings: analysed,
      filesSkippedByBudget: skipped,
      budgetMs: budget,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * غنی‌سازی بودجه‌دار — LSP-08 و LSP-17.
   *
   * **بعد از** ساخت ایندکس اجرا می‌شود و نه قبلش، چون
   * `SymbolMetricsCalculator` خودش `referenceCount` را از گراف حدسی
   * پر می‌کند؛ اگر جای این دو عوض شود، عددِ کامپایلر با حدس
   * بازنویسی می‌شود.
   *
   * SE-AI-13 — عارضه‌اش این بود که `aiScore` پیش از غنی‌سازی حساب
   * شده و عددهای اصلاح‌شده را نمی‌دید. جابه‌جا کردنِ مراحل رفع
   * نیست (بالا را ببینید)، پس به‌جایش یک مرحلهٔ امتیازدهیِ دوباره
   * **پس از** غنی‌سازی اضافه شد: `rescoreAfterEnrichment`.
   */
  private async enrich(
    index: ProjectIndex,
    contents: Map<string, string>
  ): Promise<ProjectIndex> {
    const enrichment = this.options.enrichment;
    if (!enrichment) return index;

    this.report('Enriching with the language server');
    try {
      const result = await enrichment.enrich({
        symbols: index.symbols,
        files: index.files,
        workspaceRoot: this.options.workspaceRoot,
        contentOf: fileId => contents.get(fileId),
      });

      if (result.callEdges.length === 0 && result.symbols === index.symbols) return index;

      /*
      | یال‌های سرور به گراف *افزوده* می‌شوند و جای چیزی را
      | نمی‌گیرند: یال حدسی هم اطلاعات دارد، فقط `basis`ش
      | ضعیف‌تر است و مصرف‌کننده می‌تواند بر همان اساس فیلتر کند
      | (فاز ۱۹).
      */
      const graphs = index.graphs
        ? { ...index.graphs, callGraph: [...(index.graphs.callGraph ?? []), ...result.callEdges] }
        : index.graphs;

      this.logger.debug('enrichment applied', { ...result.stats });

      /*
      | SE-AI-13 — امتیازها با ارجاع‌های اصلاح‌شده به‌روز می‌شوند.
      | بدون این، `referenceCount` از سرور می‌آمد ولی `importance`
      | هنوز بر اساس حدسِ قبلی بود، و هر دو عدد معتبر به نظر
      | می‌رسیدند.
      */
      return rescoreAfterEnrichment({ ...index, symbols: result.symbols, graphs });
    } catch (error) {
      /*
      | غنی‌سازی یک لایهٔ اضافه است. شکستش نباید ایندکس را از بین
      | ببرد — همان قاعدهٔ diagnostics در فاز ۳۴.
      */
      this.logger.warn('enrichment failed; keeping the unenriched index', {
        error: error instanceof Error ? error.message : String(error),
      });
      return index;
    }
  }

  private report(message: string, increment?: number): void {
    this.progress?.report(increment === undefined ? { message } : { message, increment });
  }
}

/** جمع پیچیدگی symbolهای هر فایل — ورودی امتیاز hotspot در git. */
export function buildFileComplexityMap(
  files: readonly FileEntry[],
  symbols: readonly SymbolEntry[]
): Map<string, number> {
  const complexityByFile = new Map<string, number>();
  for (const symbol of symbols) {
    complexityByFile.set(
      symbol.fileId,
      (complexityByFile.get(symbol.fileId) ?? 0) + (symbol.complexity ?? 0)
    );
  }

  const byPath = new Map<string, number>();
  for (const file of files) {
    const fromSymbols = complexityByFile.get(file.id) ?? 0;
    byPath.set(
      file.path,
      fromSymbols > 0 ? fromSymbols : (file.metrics?.cyclomaticComplexity ?? 0)
    );
  }
  return byPath;
}

function resolveTsPath(
  from: string,
  fromFile: string,
  files: readonly FileEntry[],
  resolver: TSPathResolver
): FileEntry | undefined {
  const resolvedPath = resolver.resolve(from, fromFile);
  if (!resolvedPath) return undefined;
  return files.find(
    candidate =>
      candidate.path === resolvedPath ||
      candidate.path === resolvedPath.replace(/^\.\//, '')
  );
}

function resolveImport(
  imp: ImportEntry,
  file: FileEntry,
  files: readonly FileEntry[],
  resolver: TSPathResolver
): ImportEntry {
  const language = file.language ?? '';
  const target = PROJECT_PATH_LANGUAGES.has(language)
    ? resolveProjectImport(language, imp.from, file.path, files)
    : resolveTsPath(imp.from, file.path, files, resolver);

  if (!target) return imp;
  /*
  | importِ داخل‌پروژه که به فایل resolve شد، یک وابستگیِ فایل‌به‌فایل است؛
  | DependencyGraphBuilder فقط با type:'local' + resolvedFileId یالِ فایل
  | می‌سازد، پس نوع را هم درست می‌کنیم (Go/Rust/Java/Kotlin/PHPِ مطلق قبلاً
  | package/builtin بودند).
  */
  return { ...imp, resolvedFileId: target.id, type: 'local' };
}

/* Kept for existing importers; the implementations live in importResolution.ts. */
export {
  PROJECT_PATH_LANGUAGES,
  resolveProjectImport,
  resolvePythonImport,
  resolveGoImport,
  resolveRustImport,
  resolveJavaImport,
} from './importResolution';
