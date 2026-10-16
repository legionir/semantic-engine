/**
 * languageSupport — SE-SYM-16 و SE-GRAPH-08.
 *
 * هر دو یافته یک شکایت مشترک دارند: محدودیت وجود دارد و **اعلام
 * نمی‌شود**. Python و Go و Java و Rust در `getSymbolExtractionMethod`
 * «پشتیبانی‌شده» علامت خورده بودند و مستقیم به regex می‌افتادند، و
 * گراف فراخوانی برایشان اصلاً ساخته نمی‌شد.
 *
 * برای مصرف‌کننده‌ای که ایندکس را می‌خواند، «این فایل تابعی ندارد» و
 * «من توابعِ این زبان را نمی‌فهمم» یک شکل دارند. این ماژول تفکیکشان
 * می‌کند و نتیجه در خودِ `project-index.json` می‌نشیند.
 */

import { supportLevelFor } from './languageGrammars';

export interface LanguageSupportEntry {
  /**
   * - `full` — نماد، امضا، پارامتر و پیچیدگی از AST.
   * - `structural` — نماد و ساختار از AST؛ بدون گراف فراخوانی.
   * - `heuristic` — تطبیق الگو؛ کیفیت به‌شدت پایین‌تر.
   */
  readonly symbols: 'full' | 'structural' | 'heuristic';
  /** SE-GRAPH-08 — `CallGraphBuilder` فقط TS/JS را می‌پیماید. */
  readonly callGraph: boolean;
}

/** زبان‌هایی که `CallGraphBuilder` واقعاً برایشان یال می‌سازد. */
const CALL_GRAPH_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
]);

export function describeLanguageSupport(
  languages: readonly string[]
): Record<string, LanguageSupportEntry> {
  const out: Record<string, LanguageSupportEntry> = {};

  for (const language of [...new Set(languages)].sort()) {
    out[language] = {
      symbols: supportLevelFor(language),
      callGraph: CALL_GRAPH_LANGUAGES.has(language),
    };
  }

  return out;
}
