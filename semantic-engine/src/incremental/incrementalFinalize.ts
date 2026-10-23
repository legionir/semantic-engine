/**
 * مرحلهٔ پایانیِ به‌روزرسانی تدریجی: ساخت ایندکس با گراف جدید، call-reference،
 * متریک، git/config/test، بردار و متادیتای AI — جدا شده از `IncrementalEngine`
 * (رفتار بدون تغییر).
 */

import { ProjectIndex } from '../core/types/project-index.types';
import { GraphResult, JsonExporter, ProjectEnrichment } from '../export/JsonExporter';
import { populateSymbolCallReferences } from '../export/symbolCallReferences';
import { SymbolMetricsCalculator } from '../core/metrics/SymbolMetricsCalculator';
import { ConfigUsageMapper } from '../ai/ConfigUsageMapper';
import { GitInfoCollector } from '../core/git/GitInfoCollector';
import { VectorIndexer } from '../vector/VectorIndexer';
import { ProjectIndexStore } from './ProjectIndexStore';

export interface FinalizeOptions {
  readonly workspaceRoot: string;
  readonly vectorIndexer: VectorIndexer | null;
}

export interface FinalizeInput {
  readonly graphs: GraphResult;
  readonly affectedFileIds: ReadonlySet<string>;
  readonly changedFileIds: ReadonlySet<string>;
  readonly removedFileIds: ReadonlySet<string>;
  readonly fileContents: ReadonlyMap<string, string>;
}

export async function finalizeIncrementalIndex(
  store: ProjectIndexStore,
  options: FinalizeOptions,
  input: FinalizeInput
): Promise<ProjectIndex> {
  const { graphs, affectedFileIds, changedFileIds, removedFileIds, fileContents } = input;

  // ۵. Post-processing: symbol calls/calledBy + metrics + AI metadata
  const projectIndexWithGraphs = store.buildUpdatedIndex({
    mode: 'incremental',
    baseGeneratedAt: store.projectIndex.generatedAt,
    changedFileIds: Array.from(changedFileIds),
    removedFileIds: Array.from(removedFileIds),
    graphs,
  });

  const symbolsWithCallRefs = populateSymbolCallReferences(
    projectIndexWithGraphs.symbols,
    projectIndexWithGraphs.graphs.callGraph
  );

  /*
  | SE-INC-02: دامنه‌دار. بدون این، هر ذخیره کل پروژه را از دیسک
  | می‌خواند و parse می‌کند — ۷۵٪ زمان یک ذخیره روی مخزن ۱۰۰۰
  | فایلی. محاسبه‌گر هم dispose می‌شود؛ نمونهٔ بی‌صاحب یعنی کش
  | فایلِ کل پروژه تا GC بعدی زنده می‌ماند (SE-METRIC-04).
  */
  const metricsCalculator = new SymbolMetricsCalculator();
  const symbolsWithMetrics = metricsCalculator.compute({
    workspaceRoot: options.workspaceRoot,
    files: projectIndexWithGraphs.files,
    symbols: symbolsWithCallRefs,
    callGraph: projectIndexWithGraphs.graphs.callGraph,
    changedFileIds: affectedFileIds,
  });
  metricsCalculator.dispose();

  const projectIndexWithSymbols = {
    ...projectIndexWithGraphs,
    symbols: symbolsWithMetrics,
  };

  const exporter = new JsonExporter();

  // ۵.۵ Enrichment فاز C برای فایل‌های affected
  const affectedPaths = Array.from(affectedFileIds)
    .map(id => store.getFileById(id)?.path)
    .filter((p): p is string => !!p);

  const fileComplexityByPath = new Map<string, number>();
  for (const sym of symbolsWithMetrics) {
    const file = store.getFileById(sym.fileId);
    if (!file) continue;
    const current = fileComplexityByPath.get(file.path) ?? 0;
    fileComplexityByPath.set(file.path, current + (sym.complexity ?? 0));
  }

  const gitCollector = new GitInfoCollector(options.workspaceRoot);
  const gitFileMetricsResult = await gitCollector.collectFileMetrics(
    affectedPaths,
    fileComplexityByPath
  );

  const configUsageMapper = new ConfigUsageMapper();
  const configUsagesByFileId = new Map<string, import('../core/types/project-index.types').ConfigUsageEntry[]>();
  for (const [fileId, content] of fileContents) {
    const file = store.getFileById(fileId);
    if (!file || file.binary || !content) continue;
    const usages = configUsageMapper.extract(file.path, content);
    if (usages.length > 0) {
      configUsagesByFileId.set(fileId, usages);
    }
  }

  // testIds mapping برای symbol ها
  const symbolTestIds = exporter.buildSymbolTestIds(
    projectIndexWithSymbols.files,
    projectIndexWithSymbols.symbols
  );
  const symbolsWithTests = projectIndexWithSymbols.symbols.map(sym => ({
    ...sym,
    testIds: symbolTestIds.get(sym.id),
  }));

  const projectIndexWithTests = {
    ...projectIndexWithSymbols,
    symbols: symbolsWithTests,
  };

  /*
  | SE-VEC-11: در مسیر watch، vectorها باید همانند symbol و graph
  | بخشی از update incremental باشند. پیش از این فقط chunkهای orphan
  | حذف می‌شدند و chunk فایل تغییرکرده با محتوای قدیمی باقی می‌ماند.
  | VectorIndexer فقط فایل‌های affected را دوباره chunk می‌کند و
  | embeddingهای unchanged را از previous reuse می‌کند.
  */
  const vectorChunks = options.vectorIndexer
    ? await options.vectorIndexer.updateIncremental(
        projectIndexWithTests,
        affectedFileIds,
        fileContents,
        store.projectIndex.vectorChunks ?? []
      )
    : projectIndexWithTests.vectorChunks;
  const projectIndexWithVectors = {
    ...projectIndexWithTests,
    ...(vectorChunks ? { vectorChunks } : {}),
  };

  /*
  | SE-INC-10: این map از قبل بالاتر ساخته می‌شد و بعد *استفاده
  | نمی‌شد*؛ به‌جایش `fileContents` تحویل exporter می‌شد تا همان
  | کار را از نو انجام دهد. هر ذخیره، دو بار روی محتوای هر فایل
  | تغییرکرده اسکن config می‌کرد و نتیجهٔ اولی را دور می‌ریخت.
  */
  const enrichment: ProjectEnrichment = {
    configUsages: configUsagesByFileId,
    gitFileMetrics: gitFileMetricsResult.metricsByPath,
  };

  /*
  | SE-INC-04: متادیتای AI هم دامنه می‌گیرد. `previous` از ایندکسِ
  | پیش از این batch می‌آید، پس فایل دست‌نخورده همان شیء قبلی‌اش را
  | نگه می‌دارد.
  */
  const previousAiMetadata = new Map(
    store.projectIndex.files
      .filter(file => file.aiMetadata)
      .map(file => [file.id, file.aiMetadata!] as const)
  );

  const finalizedProjectIndex = await exporter.finalizeProjectIndex({
    projectIndex: projectIndexWithVectors,
    options: {
      outputPath: '',
      workspaceRoot: options.workspaceRoot,
    },
    incremental: projectIndexWithGraphs.incremental,
    enrichment,
    metadataScope: { changedFileIds: affectedFileIds, previous: previousAiMetadata },
  });

  return finalizedProjectIndex;
}
