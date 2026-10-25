/**
 * مراحل اختیاریِ زبان‌سرور (diagnostics و غنی‌سازی) — جدا شده از `IndexPipeline`.
 * هر دو بودجه‌دارند و شکستشان ایندکس را از بین نمی‌برد؛ رفتار بدون تغییر است.
 */

import * as path from 'path';
import { throwIfCancelled } from '../host/Cancellation';
import { createYielder } from '../host/EventLoop';
import { Diagnostic, FileEntry, ProjectIndex } from '../core/types/project-index.types';
import { rescoreAfterEnrichment } from './rescoreAfterEnrichment';
import { StageContext } from './stageContext';

export async function collectDiagnostics(
  ctx: StageContext,
  files: readonly FileEntry[],
  contents: Map<string, string>,
  addDiagnostic: (fileId: string, diagnostic: Diagnostic) => void,
  countRead: () => void
): Promise<ProjectIndex['diagnosticsRun'] | null> {
  const source = ctx.options.diagnosticsSource;
  if (!source) return null;

  ctx.report('Collecting diagnostics');
  const startedAt = Date.now();
  const budget = ctx.options.diagnosticsBudgetMs ?? 60_000;
  const workspaceRoot = ctx.options.workspaceRoot;

  let analysed = 0;
  let skipped = 0;
  const tickDiagnostics = createYielder();

  for (const file of files) {
    throwIfCancelled(ctx.token, 'Indexing');
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

    const content = await ctx.contentOf(file, contents, countRead);
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
    ctx.logger.warn('diagnostics budget exhausted', { skipped, budgetMs: budget });
  }
  ctx.logger.debug('diagnostics collected', {
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
export async function enrich(
  ctx: StageContext,
  index: ProjectIndex,
  contents: Map<string, string>
): Promise<ProjectIndex> {
  const enrichment = ctx.options.enrichment;
  if (!enrichment) return index;

  ctx.report('Enriching with the language server');
  try {
    const result = await enrichment.enrich({
      symbols: index.symbols,
      files: index.files,
      workspaceRoot: ctx.options.workspaceRoot,
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

    ctx.logger.debug('enrichment applied', { ...result.stats });

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
    ctx.logger.warn('enrichment failed; keeping the unenriched index', {
      error: error instanceof Error ? error.message : String(error),
    });
    return index;
  }
}
