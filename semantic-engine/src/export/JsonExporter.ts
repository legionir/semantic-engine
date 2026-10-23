/**
 * JsonExporter — ترکیب خروجی اسکنر و symbol extractor در یک فایل
 * project-index.json نهایی مطابق schema.
 *
 * این فاز ۵ در build plan است اما ما اسکلت اولیه‌اش را الان می‌سازیم
 * تا end-to-end pipeline حتی با فقط LSP هم قابل اجرا باشد.
 */

import { classifyFileRole, isEntryPointPath } from '../core/fileRole';
import { describeLanguageSupport } from '../symbols/tree-sitter/languageSupport';
import * as path from 'path';
import {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
  Graphs,
  ProjectMetrics,
  FileMetrics,
  ImportEntry,
  ExportEntry,
  VectorChunk,
  IncrementalInfo,
  GitInfo,
  GitFileMetrics,
  ConfigUsageEntry,
  Diagnostic,
  AiMetadata,
} from '../core/types/project-index.types';
import { ScanResult } from '../scanner/WorkspaceScanner';
import { validateAgainstSchema, writeJsonAtomic } from './schemaValidation';
import { SymbolIndex } from '../graphs/SymbolIndex';
import { ReverseDependencyIndex } from '../graphs/ReverseDependencyIndex';
import { SymbolMetricsCalculator } from '../core/metrics/SymbolMetricsCalculator';
import { AiMetadataGenerator } from '../ai/AiMetadataGenerator';
import { ILlmClient } from '../ai/llm/LlmClient';
import { LlmAiMetadataGenerator } from '../ai/llm/LlmAiMetadataGenerator';
import { sortSymbolsDeterministically } from '../core/utils/symbolSort';
import { populateSymbolCallReferences } from './symbolCallReferences';
import { dedupeSymbols } from './symbolDedup';
import { TestMapper } from '../ai/TestMapper';

export interface ExportOptions {
  /** اعتبارسنجی با schema پیش از نوشتن — SE-EXP-06. */
  readonly validate?: boolean;

  /** مسیر خروجی فایل JSON */
  readonly outputPath: string;

  /** root workspace — ترجیحاً relative (مثلاً نام پوشه) */
  readonly workspaceRoot: string;

  /** pretty print (indent) یا minified */
  readonly pretty?: boolean;

  /** نسخه‌ی generator */
  readonly generatorVersion?: string;
}

export interface DependencyResult {
  readonly fileId: string;
  readonly imports: readonly ImportEntry[];
  readonly exports: readonly ExportEntry[];
}

export interface GraphResult {
  readonly callGraph: Graphs['callGraph'];
  readonly typeGraph: Graphs['typeGraph'];
  readonly dependencyGraph: Graphs['dependencyGraph'];
}

export interface ProjectEnrichment {
  /**
   * fileId → استفاده‌های config/env که *قبلاً* استخراج شده‌اند.
   *
   * SE-EXT-03: این‌جا `fileContents: ReadonlyMap<string, string>` بود،
   * یعنی برای اینکه exporter بتواند `configUsages` را حساب کند، باید
   * متن کل کارگاه تا لحظهٔ ساخت ایندکس زنده می‌ماند. روی monorepo،
   * مصرف حافظه با مجموع حجم متنی مخزن رشد می‌کرد و سقفی نداشت.
   *
   * حالا استخراج در همان گذری انجام می‌شود که فایل را برای symbol و
   * وابستگی می‌خواند، و فقط *نتیجه* — که چند ده بایت است — تا این‌جا
   * می‌آید.
   */
  readonly configUsages?: ReadonlyMap<string, readonly ConfigUsageEntry[]>;
  /** filePath → git file metrics */
  readonly gitFileMetrics?: ReadonlyMap<string, GitFileMetrics>;
}

/**
 * SE-EXP-14 — `diagnostics` سطح پروژه.
 *
 * قرارداد این آرایه را «تجمیع diagnostics هر فایل، برای query سریع
 * بدون پیمایش `files[]`» تعریف کرده بود، ولی این‌جا یک `[]` ثابت
 * نوشته می‌شد. یعنی نه هشدارهای استخراج و نه diagnosticهای خودِ
 * اسکنر (فایل ناخوانا، حلقهٔ symlink، فایل بریده‌شده) هرگز به خروجی
 * نمی‌رسیدند.
 *
 * diagnosticهای اسکنر fileId ندارند — فایلی که خوانده نشده، اصلاً در
 * `files[]` نیست — پس فقط این‌جا می‌آیند.
 */
function aggregateDiagnostics(
  scanResult: ScanResult,
  files: readonly FileEntry[]
): readonly Diagnostic[] {
  const fromFiles = files.flatMap(file => file.diagnostics ?? []);
  return [...scanResult.diagnostics, ...fromFiles];
}

export class JsonExporter {
  /** خطاهای schema، هر کدام با مسیر JSON Pointer. خالی یعنی معتبر. */
  validate(index: ProjectIndex): string[] {
    return validateAgainstSchema('project-index', index);
  }

  /**
   * نوشتن ایندکسِ از پیش ساخته‌شده، با اعتبارسنجی اختیاری.
   *
   * SE-EXP-06: اعتبارسنجی *پیش از* نوشتن انجام می‌شود، نه بعدش. یک
   * فایل نامعتبر روی دیسک، بدتر از نبودِ فایل است — مصرف‌کننده
   * می‌خواندش و به‌طور نامعلومی شکست می‌خورد.
   */
  async writeProjectIndex(index: ProjectIndex, options: ExportOptions): Promise<void> {
    await writeJsonAtomic({
      outputPath: options.outputPath,
      value: index,
      schema: 'project-index',
      validate: options.validate === true,
      pretty: options.pretty,
    });
  }

  /**
   * تولید project-index.json از نتایج اسکن + استخراج symbol.
   */
  async export(
    scanResult: ScanResult,
    allSymbols: readonly SymbolEntry[],
    options: ExportOptions,
    dependencies: readonly DependencyResult[] = [],
    graphs: GraphResult = { callGraph: [], typeGraph: [], dependencyGraph: [] },
    vectorChunks: readonly VectorChunk[] = [],
    llmClient?: ILlmClient,
    gitInfo?: GitInfo,
    enrichment?: ProjectEnrichment
  ): Promise<void> {
    const projectIndex = await this.buildProjectIndex(
      scanResult, allSymbols, options, dependencies, graphs, vectorChunks, llmClient, gitInfo, enrichment
    );
    await writeJsonAtomic({
      outputPath: options.outputPath,
      value: projectIndex,
      schema: 'project-index',
      validate: options.validate === true,
      pretty: options.pretty,
    });
  }

  /**
   * ساخت object نهایی ProjectIndex.
   */
  async buildProjectIndex(
    scanResult: ScanResult,
    allSymbols: readonly SymbolEntry[],
    options: ExportOptions,
    dependencies: readonly DependencyResult[] = [],
    graphs: GraphResult = { callGraph: [], typeGraph: [], dependencyGraph: [] },
    vectorChunks: readonly VectorChunk[] = [],
    llmClient?: ILlmClient,
    gitInfo?: GitInfo,
    enrichment?: ProjectEnrichment
  ): Promise<ProjectIndex> {
    // حذف تکرار symbol ها در سطح global به‌صورت دترمینیستیک
    const dedupedSymbols = dedupeSymbols(allSymbols);

    // مرتب‌سازی دترمینیستیک symbols برای خروجی پایدار (ترتیب: fileId, line, kind, name)
    const sortedSymbols = sortSymbolsDeterministically(dedupedSymbols);

    // پر کردن calls / calledBy symbol ها از روی callGraph
    const symbolsWithCallRefs = populateSymbolCallReferences(
      sortedSymbols,
      graphs.callGraph
    );

    // محاسبهٔ complexity و referenceCount برای symbol ها (فاز ۵)
    const symbolsWithMetrics = new SymbolMetricsCalculator().compute({
      workspaceRoot: options.workspaceRoot,
      files: scanResult.files,
      symbols: symbolsWithCallRefs,
      callGraph: graphs.callGraph,
    });

    // اتصال symbolIds و imports/exports به files
    const filesWithSymbols = this.attachSymbolIdsToFiles(
      scanResult.files,
      symbolsWithMetrics
    );
    const filesWithDependencies = this.attachDependenciesToFiles(
      filesWithSymbols,
      dependencies
    );

    // لینک کردن symbolId برای export entry های عادی
    const filesWithLinkedExports = this.linkExportSymbolIds(
      filesWithDependencies,
      symbolsWithMetrics
    );

    // ساخت reverse dependency graph برای AI
    const reverseDependencyGraph = new ReverseDependencyIndex({
      includeSymbolLevel: true,
    }).build({
      callGraph: graphs.callGraph,
      typeGraph: graphs.typeGraph,
      dependencyGraph: graphs.dependencyGraph,
    });

    // نگاشت symbol → test files
    const symbolTestIds = this.buildSymbolTestIds(filesWithLinkedExports, symbolsWithMetrics);
    const symbolsWithTests = symbolsWithMetrics.map(sym => ({
      ...sym,
      testIds: symbolTestIds.get(sym.id),
    }));

    return this.finalizeProjectIndex({
      projectIndex: {
        schemaVersion: '2.0.0',
        root: this.toRelativeRoot(options.workspaceRoot),
        ...(options.workspaceRoot ? { rootPath: path.resolve(options.workspaceRoot) } : {}),
        generatedAt: new Date().toISOString(),
        generatorVersion: options.generatorVersion ?? '0.1.0',
        languages: scanResult.languages,
        /*
        | SE-SYM-16 / SE-GRAPH-08 — سطح پشتیبانی در خودِ ایندکس
        | اعلام می‌شود. تا فاز ۴۸، Python و Go و Java و Rust
        | «پشتیبانی‌شده» به نظر می‌رسیدند و بی‌صدا به regex
        | می‌افتادند، و نبودِ گراف فراخوانی هیچ‌جا گفته نمی‌شد.
        */
        languageSupport: describeLanguageSupport(scanResult.languages),
        files: filesWithLinkedExports,
        symbols: symbolsWithTests,
        graphs: {
          ...graphs,
          reverseDependencyGraph,
        },
        diagnostics: aggregateDiagnostics(scanResult, filesWithLinkedExports),
        git: gitInfo,
        metrics: { totalFiles: 0, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: {} },
        vectorChunks: vectorChunks.length > 0 ? vectorChunks : undefined,
      },
      options,
      incremental: undefined,
      llmClient,
      enrichment,
    });
  }

  /**
   * Post-processing نهایی ProjectIndex:
   * - AI Metadata
   * - File metrics از symbols
   * - Project metrics
   * - Incremental info (اختیاری)
   *
   * در فاز ۹ incremental پس از rebuild graph فراخوانی می‌شود.
   */
  async finalizeProjectIndex(input: {
    projectIndex: ProjectIndex;
    options: ExportOptions;
    incremental?: IncrementalInfo;
    llmClient?: ILlmClient;
    enrichment?: ProjectEnrichment;
    /**
     * SE-INC-04: دامنهٔ تولید متادیتا. بدون آن، هر فراخوانی متادیتای
     * *همهٔ* فایل‌ها را از نو می‌سازد — که در مسیر incremental یعنی
     * کار به‌اندازهٔ کل پروژه به ازای هر ذخیره.
     */
    metadataScope?: {
      changedFileIds: ReadonlySet<string>;
      previous: ReadonlyMap<string, AiMetadata>;
    };
  }): Promise<ProjectIndex> {
    const { projectIndex, options, incremental, llmClient, enrichment } = input;

    // تولید AI Metadata (فاز ۷) — با LLM اگر فعال باشد، در غیر این صورت heuristic
    const aiMetadataByFile = llmClient
      ? await new LlmAiMetadataGenerator({ llmClient }).generate({
          workspaceRoot: options.workspaceRoot,
          files: projectIndex.files,
          symbols: projectIndex.symbols,
          dependencyGraph: projectIndex.graphs.dependencyGraph,
        })
      : new AiMetadataGenerator().generate({
          workspaceRoot: options.workspaceRoot,
          files: projectIndex.files,
          symbols: projectIndex.symbols,
          dependencyGraph: projectIndex.graphs.dependencyGraph,
          ...(input.metadataScope
            ? {
                changedFileIds: input.metadataScope.changedFileIds,
                previous: input.metadataScope.previous,
              }
            : {}),
        });
    const filesWithAiMetadata = this.attachAiMetadata(projectIndex.files, aiMetadataByFile);

    // محاسبه‌ی metrics واقعی از symbols
    const filesWithMetrics = this.computeFileMetricsFromSymbols(
      filesWithAiMetadata,
      projectIndex.symbols
    );

    // غنی‌سازی با git metadata سطح فایل
    const filesWithGitMetrics = this.attachGitMetrics(
      filesWithMetrics,
      enrichment?.gitFileMetrics
    );

    // استخراج config/env usage
    const filesWithConfigUsages = this.attachConfigUsages(
      filesWithGitMetrics,
      enrichment?.configUsages
    );

    // محاسبه‌ی metrics
    const metrics = this.computeProjectMetrics(
      filesWithConfigUsages,
      projectIndex.symbols,
      projectIndex.languages
    );

    return {
      ...projectIndex,
      files: filesWithConfigUsages,
      metrics,
      incremental,
    };
  }

  /**
   * نگاشت symbolId → آرایه‌ای از fileId تست‌های مرتبط.
   * Public برای استفاده در IncrementalEngine.
   */
  buildSymbolTestIds(
    files: readonly FileEntry[],
    symbols: readonly SymbolEntry[]
  ): Map<string, string[]> {
    const projectIndex: ProjectIndex = {
      schemaVersion: '2.0.0',
      root: '',
      generatedAt: new Date().toISOString(),
      languages: [],
      files: [...files],
      symbols: [...symbols],
      graphs: {
        callGraph: [],
        typeGraph: [],
        dependencyGraph: [],
        reverseDependencyGraph: [],
      },
      diagnostics: [],
      metrics: { totalFiles: 0, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: {} },
    };

    const mapper = new TestMapper(projectIndex);
    return mapper.buildSymbolToTestMap();
  }

  /**
   * اتصال git metrics به FileEntry ها.
   */
  private attachGitMetrics(
    files: readonly FileEntry[],
    gitMetricsByPath?: ReadonlyMap<string, GitFileMetrics>
  ): readonly FileEntry[] {
    if (!gitMetricsByPath || gitMetricsByPath.size === 0) return files;

    return files.map(file => {
      const gitMetrics = gitMetricsByPath.get(file.path);
      if (!gitMetrics) return file;
      return { ...file, gitMetrics };
    });
  }

  /**
   * استخراج و اتصال config/env usages به FileEntry ها.
   */
  private attachConfigUsages(
    files: readonly FileEntry[],
    configUsages?: ReadonlyMap<string, readonly ConfigUsageEntry[]>
  ): readonly FileEntry[] {
    if (!configUsages || configUsages.size === 0) return files;

    return files.map(file => {
      const usages = configUsages.get(file.id);
      if (!usages || usages.length === 0) return file;
      return { ...file, configUsages: usages };
    });
  }

  /**
   * اتصال imports/exports به FileEntry های مربوطه.
   */
  /**
   * اتصال imports/exports استخراج‌شده به FileEntryها.
   *
   * SE-EXP-03: این تابع قبلاً الحاق می‌کرد (`[...file.imports, ...dep.imports]`).
   * هر مسیری که هم فایل‌های از پیش غنی‌شده و هم آرایهٔ `dependencies` را
   * می‌داد — که مسیر واقعی pipeline است — هر import را دو بار ثبت
   * می‌کرد. در snapshot طلایی هر ۱۷ فایلِ دارای import دقیقاً همین را
   * نشان می‌داد. `DependencyResult` نتیجهٔ معتبر استخراج همان فایل است،
   * پس جایگزین می‌شود، نه اضافه؛ و این کار فراخوانی دوباره را بی‌ضرر
   * می‌کند.
   */
  private attachDependenciesToFiles(
    files: readonly FileEntry[],
    dependencies: readonly DependencyResult[]
  ): FileEntry[] {
    const depsByFile = new Map<string, DependencyResult>();
    for (const dep of dependencies) {
      depsByFile.set(dep.fileId, dep);
    }

    return files.map(file => {
      const dep = depsByFile.get(file.id);
      if (!dep) return file;
      return {
        ...file,
        imports: dep.imports,
        exports: dep.exports,
      };
    });
  }

  /**
   * اتصال AI Metadata به FileEntry ها.
   */
  private attachAiMetadata(
    files: readonly FileEntry[],
    aiMetadataByFile: Map<string, import('../core/types/project-index.types').AiMetadata>
  ): FileEntry[] {
    return files.map(file => {
      const aiMetadata = aiMetadataByFile.get(file.id);

      /*
      | SE-DATA-04 — `role` و `entryPoint` سال‌ها در قرارداد بودند و
      | هیچ مسیر نوشتنی مقداردهی‌شان نمی‌کرد. `entryPoint` حتی
      | *محاسبه* می‌شد ولی نتیجه‌اش داخل `aiScore.factors` دفن
      | می‌ماند و به خودِ فیلد نمی‌رسید.
      */
      const enriched: FileEntry = {
        ...file,
        role: classifyFileRole(file.path),
        entryPoint: isEntryPointPath(file.path),
      };

      return aiMetadata ? { ...enriched, aiMetadata } : enriched;
    });
  }

  /**
   * اتصال symbol id ها به FileEntry های مربوطه.
   * خروجی symbolIds و outline بدون تکرار است (ترتیب ظاهرشدن حفظ می‌شود).
   *
   * ── SE-EXP-04 ──────────────────────────────────────────────────
   *
   * `outline` دقیقاً `symbolIds` بود:
   *
   * ```ts
   * outline: symbolIds, // outline = ترتیب ظاهرشدن (فعلاً همان symbolIds)
   * ```
   *
   * روی snapshot طلایی، هر ۵۵ فایل `outline === symbolIds` داشتند.
   * یعنی ۲٫۳٪ حجم فایل صرف کپی کردن آرایه‌ای می‌شد که همان بغلش بود.
   *
   * چیزی که مصرف‌کننده از outline می‌خواهد، «چه چیزی در این فایل
   * هست» است بدون اینکه مجبور شود `symbols[]` را پیمایش کند و
   * شناسه‌ها را resolve کند. پس همان: «نوع نام»، به ترتیب ظاهر شدن.
   */
  private attachSymbolIdsToFiles(
    files: readonly FileEntry[],
    symbols: readonly SymbolEntry[]
  ): FileEntry[] {
    // گروه‌بندی symbols بر اساس fileId — با حفظ ترتیب و بدون تکرار
    const symbolsByFile = new Map<string, SymbolEntry[]>();

    for (const sym of symbols) {
      const existing = symbolsByFile.get(sym.fileId);
      if (existing) {
        if (!existing.some(other => other.id === sym.id)) {
          existing.push(sym);
        }
      } else {
        symbolsByFile.set(sym.fileId, [sym]);
      }
    }

    return files.map(file => {
      const fileSymbols = symbolsByFile.get(file.id) ?? [];
      return {
        ...file,
        symbolIds: fileSymbols.map(sym => sym.id),
        outline: fileSymbols.map(sym => `${sym.kind} ${sym.name}`),
      };
    });
  }

  /**
   * لینک کردن symbolId برای export entry های عادی (named/default) بر اساس symbols همان فایل.
   */
  private linkExportSymbolIds(
    files: readonly FileEntry[],
    symbols: readonly SymbolEntry[]
  ): FileEntry[] {
    const symbolIndex = new SymbolIndex(symbols);

    return files.map(file => {
      if (!file.exports || file.exports.length === 0) return file;

      const linkedExports = file.exports.map(exp => {
        if (exp.symbolId) return exp;
        if (exp.kind === 're-export' || exp.kind === 'namespace') return exp;

        // SE-DATA-02 — هر entry یک نام دارد؛ توضیح در ReExportResolver.
        const name = exp.name.trim();
        if (!name) return exp;

        const sym = symbolIndex.findByNameAndFile(file.id, name);
        if (sym) {
          return { ...exp, symbolId: sym.id };
        }
        return exp;
      });

      return { ...file, exports: linkedExports };
    });
  }

  /**
   * محاسبه‌ی file metrics واقعی از روی symbols.
   * فیلدهای classes, functions, methods, imports, exports, cyclomaticComplexity
   * بر اساس تعداد symbols و kind آن‌ها پر می‌شوند.
   */
  private computeFileMetricsFromSymbols(
    files: readonly FileEntry[],
    symbols: readonly SymbolEntry[]
  ): FileEntry[] {
    const metricsByFile = new Map<string, Partial<FileMetrics>>();

    for (const sym of symbols) {
      const existing = metricsByFile.get(sym.fileId) ?? {};

      const classes = (existing.classes ?? 0) + (sym.kind === 'class' ? 1 : 0);
      const functions = (existing.functions ?? 0) + (sym.kind === 'function' ? 1 : 0);
      const methods = (existing.methods ?? 0) + (sym.kind === 'method' ? 1 : 0);
      const cyclomaticComplexity = (existing.cyclomaticComplexity ?? 0) + (sym.complexity ?? 0);

      metricsByFile.set(sym.fileId, {
        ...existing,
        classes,
        functions,
        methods,
        cyclomaticComplexity,
      });
    }

    return files.map(file => {
      const symbolMetrics = metricsByFile.get(file.id);
      if (!symbolMetrics) return file;

      const current = file.metrics ?? {};
      return {
        ...file,
        metrics: {
          ...current,
          classes: symbolMetrics.classes ?? current.classes ?? 0,
          functions: symbolMetrics.functions ?? current.functions ?? 0,
          methods: symbolMetrics.methods ?? current.methods ?? 0,
          cyclomaticComplexity: symbolMetrics.cyclomaticComplexity ?? current.cyclomaticComplexity ?? 0,
        },
      };
    });
  }

  /**
   * محاسبه‌ی project-level metrics.
   */
  private computeProjectMetrics(
    files: readonly FileEntry[],
    symbols: readonly SymbolEntry[],
    _languages: readonly string[]
  ): ProjectMetrics {
    let totalLoc = 0;
    let totalComplexity = 0;
    let complexityCount = 0;
    const languageBreakdown: Record<string, number> = {};

    for (const file of files) {
      if (file.metrics?.loc) totalLoc += file.metrics.loc;
      if (file.language) {
        languageBreakdown[file.language] = (languageBreakdown[file.language] ?? 0) + 1;
      }
    }

    // میانگین complexity سطح symbol (function/method) — دقیق‌تر از میانگین سطح file
    for (const sym of symbols) {
      if (sym.complexity && sym.complexity > 0) {
        totalComplexity += sym.complexity;
        complexityCount++;
      }
    }

    return {
      totalFiles: files.length,
      totalLoc,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: complexityCount > 0 ? totalComplexity / complexityCount : 0,
      languageBreakdown,
    };
  }

  /**
   * نام کوتاه پروژه.
   *
   * SE-EXP-05: این تابع تنها چیزی بود که `root` را پر می‌کرد، پس
   * مسیر مطلق برای همیشه گم می‌شد. حالا کنارش `rootPath` هم نوشته
   * می‌شود و این یکی فقط نقش «نام» را دارد — همان نقشی که
   * `BlueprintGenerator` از آن انتظار دارد.
   */
  private toRelativeRoot(workspaceRoot: string): string {
    if (!workspaceRoot) return '.';
    if (path.isAbsolute(workspaceRoot)) {
      return path.basename(workspaceRoot);
    }
    return workspaceRoot;
  }
}
