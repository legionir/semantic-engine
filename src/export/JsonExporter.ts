/**
 * JsonExporter — ترکیب خروجی اسکنر و symbol extractor در یک فایل
 * project-index.json نهایی مطابق schema.
 *
 * این فاز ۵ در build plan است اما ما اسکلت اولیه‌اش را الان می‌سازیم
 * تا end-to-end pipeline حتی با فقط LSP هم قابل اجرا باشد.
 */

import { describeLanguageSupport } from '../symbols/tree-sitter/languageSupport';
import * as path from 'path';
import { ProjectIndex, FileEntry, SymbolEntry, Graphs, ImportEntry, ExportEntry, VectorChunk, IncrementalInfo, GitInfo, GitFileMetrics, ConfigUsageEntry, Diagnostic, AiMetadata } from '../core/types/project-index.types';
import { ScanResult } from '../scanner/WorkspaceScanner';
import { validateAgainstSchema, writeJsonAtomic } from './schemaValidation';

import { ReverseDependencyIndex } from '../graphs/ReverseDependencyIndex';
import { SymbolMetricsCalculator } from '../core/metrics/SymbolMetricsCalculator';
import { AiMetadataGenerator } from '../ai/AiMetadataGenerator';
import { ILlmClient } from '../ai/llm/LlmClient';
import { LlmAiMetadataGenerator } from '../ai/llm/LlmAiMetadataGenerator';
import { sortSymbolsDeterministically } from '../core/utils/symbolSort';
import { populateSymbolCallReferences } from './symbolCallReferences';
import { dedupeSymbols } from './symbolDedup';

import {
  attachSymbolIdsToFiles,
  attachDependenciesToFiles,
  linkExportSymbolIds,
  buildSymbolTestIds,
  toRelativeRoot,
  attachAiMetadata,
  computeFileMetricsFromSymbols,
  attachGitMetrics,
  attachConfigUsages,
  computeProjectMetrics,
} from './projectIndexAttach';

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
  /** شناسهٔ تست‌های هر symbol (API عمومی؛ پیاده‌سازی در projectIndexAttach). */
  buildSymbolTestIds(files: readonly FileEntry[], symbols: readonly SymbolEntry[]): Map<string, string[]> {
    return buildSymbolTestIds(files, symbols);
  }

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
    const filesWithSymbols = attachSymbolIdsToFiles(
      scanResult.files,
      symbolsWithMetrics
    );
    const filesWithDependencies = attachDependenciesToFiles(
      filesWithSymbols,
      dependencies
    );

    // لینک کردن symbolId برای export entry های عادی
    const filesWithLinkedExports = linkExportSymbolIds(
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
    const symbolTestIds = buildSymbolTestIds(filesWithLinkedExports, symbolsWithMetrics);
    const symbolsWithTests = symbolsWithMetrics.map(sym => ({
      ...sym,
      testIds: symbolTestIds.get(sym.id),
    }));

    return this.finalizeProjectIndex({
      projectIndex: {
        schemaVersion: '2.0.0',
        root: toRelativeRoot(options.workspaceRoot),
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
    const filesWithAiMetadata = attachAiMetadata(projectIndex.files, aiMetadataByFile);

    // محاسبه‌ی metrics واقعی از symbols
    const filesWithMetrics = computeFileMetricsFromSymbols(
      filesWithAiMetadata,
      projectIndex.symbols
    );

    // غنی‌سازی با git metadata سطح فایل
    const filesWithGitMetrics = attachGitMetrics(
      filesWithMetrics,
      enrichment?.gitFileMetrics
    );

    // استخراج config/env usage
    const filesWithConfigUsages = attachConfigUsages(
      filesWithGitMetrics,
      enrichment?.configUsages
    );

    // محاسبه‌ی metrics
    const metrics = computeProjectMetrics(
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

}
