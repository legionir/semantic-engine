/**
 * Budgets and data shapes of the LSP enrichment stage (split from LspEnrichmentService.ts, unchanged).
 */

import { CallEdge, FileEntry, SymbolEntry } from '../core/types/project-index.types';

export interface EnrichmentBudget {
  /** حداکثر چند symbol اصلاً در نظر گرفته شوند. */
  readonly maxSymbols: number;
  /** سقف زمان دیواری کل مرحله. */
  readonly maxWallClockMs: number;
  readonly maxReferenceQueries: number;
  readonly maxCallHierarchyQueries: number;
  /** پیش‌فرض صفر — SE-SYM-07. */
  readonly maxHoverQueries: number;
  /** چند درخواست هم‌زمان. */
  readonly concurrency: number;
}

/**
 * اسکن کامل: سرور سرد است و هزاران فایل در راه.
 * اعداد از بخش ۵.۵ سند طراحی.
 */
export const BATCH_BUDGET: EnrichmentBudget = {
  maxSymbols: 2000,
  maxWallClockMs: 60_000,
  maxReferenceQueries: 500,
  maxCallHierarchyQueries: 500,
  maxHoverQueries: 0,
  concurrency: 4,
};

/**
 * حالت watch — LSP-10.
 *
 * اینجا سرور از قبل گرم است و فقط چند فایل تغییر کرده‌اند. همان
 * نکته‌ای که سند طراحی می‌گوید: «در حالت watch، LSP تقریباً رایگان
 * است». پس بودجه سخاوتمندتر است ولی **بی‌نهایت نیست** — یک ذخیره
 * نباید ثانیه‌ها طول بکشد.
 */
export const WATCH_BUDGET: EnrichmentBudget = {
  maxSymbols: 500,
  maxWallClockMs: 10_000,
  maxReferenceQueries: 200,
  maxCallHierarchyQueries: 200,
  maxHoverQueries: 0,
  concurrency: 4,
};

export interface EnrichmentInput {
  readonly symbols: readonly SymbolEntry[];
  readonly files: readonly FileEntry[];
  readonly workspaceRoot: string;
  /** محتوای در حافظه، اگر هست — در watch از دیسک جلوتر است. */
  readonly contentOf?: (fileId: string) => string | undefined;
  /** در حالت watch، این فایل‌ها اول می‌آیند. */
  readonly changedFileIds?: ReadonlySet<string>;
  readonly languageId?: string;
}

export interface EnrichmentStats {
  readonly consideredSymbols: number;
  readonly referenceQueries: number;
  readonly callHierarchyQueries: number;
  readonly hoverQueries: number;
  readonly enrichedSymbols: number;
  readonly resolvedEdges: number;
  readonly durationMs: number;
  readonly budgetExhausted: boolean;
}

export interface EnrichmentResult {
  readonly symbols: readonly SymbolEntry[];
  readonly callEdges: readonly CallEdge[];
  readonly stats: EnrichmentStats;
}
