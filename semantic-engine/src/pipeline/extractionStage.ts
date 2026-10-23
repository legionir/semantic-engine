/**
 * مرحلهٔ ۲ ایندکس — استخراج symbol، وابستگی و configUsage هر فایل (با کش) —
 * جدا شده از `IndexPipeline`، رفتار بدون تغییر.
 */

import { StageContext } from './stageContext';
import { CachedExtraction } from './ExtractionCache';
import { PROJECT_PATH_LANGUAGES } from './importResolution';
import { resolveImport } from './importLinking';
import { ConfigUsageMapper } from '../ai/ConfigUsageMapper';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { DependencyResult } from '../export/JsonExporter';
import { throwIfCancelled } from '../host/Cancellation';
import { createYielder } from '../host/EventLoop';
import {
  ConfigUsageEntry,
  Diagnostic,
  FileEntry,
  SymbolEntry,
} from '../core/types/project-index.types';

/**
 * مرحلهٔ ۲ — symbol، وابستگی، configUsage و diagnosticهای استخراج برای هر فایل.
 * همهٔ دادهٔ اولیه را برمی‌گرداند؛ هیچ حالتی جز `fileReads` تغییر نمی‌کند.
 */
export async function extractAll(
  ctx: StageContext,
  files: readonly FileEntry[],
  contents: Map<string, string>,
  resolver: TSPathResolver,
  countRead: () => void
): Promise<{
  readonly symbols: SymbolEntry[];
  readonly dependencies: DependencyResult[];
  readonly diagnosticsByFile: Map<string, Diagnostic[]>;
  readonly configUsagesByFile: Map<string, readonly ConfigUsageEntry[]>;
  readonly addDiagnostic: (fileId: string, diagnostic: Diagnostic) => void;
}> {
  const symbols: SymbolEntry[] = [];
  const dependencies: DependencyResult[] = [];

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
    throwIfCancelled(ctx.token, 'Indexing');

    if (file.binary || !file.language) continue;

    const content = await ctx.contentOf(file, contents, countRead);
    if (content === null) continue;

    const cached = ctx.options.extractionCache?.get(
      file.path, file.id, file.hash, file.language
    ) ?? null;
    const fresh = cached ? null : await extractFile(ctx, file, content, configUsageMapper);
    const entry = cached ?? fresh!.entry;

    if (entry.usages.length > 0) configUsagesByFile.set(file.id, entry.usages);

    if (entry.symbols) {
      symbols.push(...entry.symbols.symbols);
      for (const warning of entry.symbols.warnings) {
        addDiagnostic(file.id, {
          severity: 'warning',
          code: 'symbol-extraction',
          line: 1,
          message: warning,
          source: 'symbol-extraction',
          fileId: file.id,
        });
      }
    }
    if (fresh?.symbolError) {
      ctx.logger.warn('symbol extraction failed', { file: file.path, reason: fresh.symbolError });
      addDiagnostic(file.id, {
        severity: 'error',
        code: 'symbol-extraction',
        line: 1,
        message: fresh.symbolError,
        source: 'symbol-extraction',
        fileId: file.id,
      });
    }

    if (entry.dependencies) {
      dependencies.push({
        fileId: file.id,
        imports: entry.dependencies.imports.map(imp =>
          imp.type === 'local' || PROJECT_PATH_LANGUAGES.has(file.language ?? '')
            ? resolveImport(imp, file, files, resolver)
            : imp
        ),
        exports: entry.dependencies.exports,
      });
      for (const message of entry.dependencies.diagnostics) {
        addDiagnostic(file.id, {
          severity: 'warning',
          code: 'dependency-extraction',
          line: 1,
          message,
          source: 'dependency-extraction',
        });
      }
    }
    if (fresh?.dependencyError) {
      ctx.logger.warn('dependency extraction failed', {
        file: file.path,
        reason: fresh.dependencyError,
      });
      addDiagnostic(file.id, {
        severity: 'error',
        code: 'dependency-extraction',
        line: 1,
        message: fresh.dependencyError,
        source: 'dependency-extraction',
        fileId: file.id,
      });
    }

    /* شکست‌ها (و نتیجهٔ ناقص) کش نمی‌شوند: اجرای بعد دوباره تلاش می‌کند. */
    if (fresh && !fresh.symbolError && !fresh.dependencyError) {
      ctx.options.extractionCache?.set(file.path, fresh.entry);
    }

    processed++;
    if (processed % 25 === 0) {
      ctx.report(`Extracting… (${processed}/${files.length})`, (25 / files.length) * 100);
    }

    /*
    | SE-PERF-01 — استخراج CPU-bound است و `await`های بالا همگی
    | microtask هستند، پس بدون این خط صف I/O تا پایان ایندکس
    | اجرا نمی‌شود و سرور (حتی `/health`) پاسخ نمی‌دهد.
    */
    await tick();
  }

  return { symbols, dependencies, diagnosticsByFile, configUsagesByFile, addDiagnostic };
}

/** استخراج خام یک فایل؛ خروجی همان چیزی است که کش نگه می‌دارد. */
async function extractFile(
  ctx: StageContext,
  file: FileEntry,
  content: string,
  configUsageMapper: ConfigUsageMapper
): Promise<{ entry: CachedExtraction; symbolError?: string; dependencyError?: string }> {
  const language = file.language ?? '';
  let symbols: CachedExtraction['symbols'] = null;
  let dependencies: CachedExtraction['dependencies'] = null;
  let symbolError: string | undefined;
  let dependencyError: string | undefined;

  if (await ctx.options.symbolExtractors.hasExtractorFor(language)) {
    const result = await ctx.options.symbolExtractors
      .extract(file.id, file.path, content, language);
    if (result.ok) {
      symbols = { symbols: result.value.symbols, warnings: result.value.warnings };
    } else {
      symbolError = result.error.message;
    }
  }

  if (await ctx.options.dependencyExtractors.hasExtractorFor(language)) {
    const result = await ctx.options.dependencyExtractors
      .extract(file.id, file.path, content, language);
    if (result.ok) {
      dependencies = {
        imports: result.value.imports,
        exports: result.value.exports,
        diagnostics: result.value.diagnostics ?? [],
      };
    } else {
      dependencyError = result.error.message;
    }
  }

  return {
    entry: {
      fileId: file.id,
      hash: file.hash,
      language,
      usages: configUsageMapper.extract(file.path, content),
      symbols,
      dependencies,
    },
    ...(symbolError ? { symbolError } : {}),
    ...(dependencyError ? { dependencyError } : {}),
  };
}
