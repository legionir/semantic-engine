/**
 * Pure attach/compute steps of the project index export
 * (split from JsonExporter.ts, behavior unchanged).
 */

/**
 * نگاشت symbolId → آرایه‌ای از fileId تست‌های مرتبط.
 * Public برای استفاده در IncrementalEngine.
 */
import type { DependencyResult } from './JsonExporter';
import { classifyFileRole, isEntryPointPath } from '../core/fileRole';

import * as path from 'path';
import { ProjectIndex, FileEntry, SymbolEntry, ProjectMetrics, FileMetrics, GitFileMetrics, ConfigUsageEntry } from '../core/types/project-index.types';

import { SymbolIndex } from '../graphs/SymbolIndex';

import { TestMapper } from '../ai/TestMapper';

export function buildSymbolTestIds(
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
export function attachGitMetrics(
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
export function attachConfigUsages(
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
export function attachDependenciesToFiles(
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
export function attachAiMetadata(
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
export function attachSymbolIdsToFiles(
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
export function linkExportSymbolIds(
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
export function computeFileMetricsFromSymbols(
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
export function computeProjectMetrics(
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
export function toRelativeRoot(workspaceRoot: string): string {
  if (!workspaceRoot) return '.';
  if (path.isAbsolute(workspaceRoot)) {
    return path.basename(workspaceRoot);
  }
  return workspaceRoot;
}
