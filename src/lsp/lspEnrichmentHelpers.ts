/**
 * Pure helpers of the LSP enrichment stage (split from LspEnrichmentService.ts, behavior unchanged).
 */

import * as path from 'path';
import { SymbolEntry } from '../core/types/project-index.types';
import type { EnrichmentInput } from './lspEnrichmentTypes';

/**
 * ترتیب نامزدها، از سند طراحی بخش ۵.۵:
 *
 * ۱. symbolهای exported در فایل‌های entryPoint
 * ۲. symbolهای فایل‌های تغییرکرده (حالت watch)
 * ۳. exported دیگر
 * ۴. class / interface / function سطح بالا
 * ۵. بقیه — فقط اگر بودجه ماند
 *
 * ترتیب داخل هر رده، ترتیب خودِ ایندکس است تا خروجی قطعی بماند.
 */
export function prioritize(input: EnrichmentInput, maxSymbols: number): SymbolEntry[] {
  /*
  | «entryPoint» یک پرچم مستقل نیست؛ `AiMetadata` فقط `aiScore` دارد.
  | نزدیک‌ترین چیزِ موجود، اهمیتِ محاسبه‌شدهٔ فایل است — و اگر
  | امتیازی نباشد (اجرای بدون متادیتا)، این رده خالی می‌ماند و
  | اولویت به ردهٔ بعدی می‌افتد.
  */
  const importantFiles = new Set(
    input.files
      .filter(file => (file.aiMetadata?.aiScore?.importance ?? 0) >= 70)
      .map(file => file.id)
  );
  const changed = input.changedFileIds ?? new Set<string>();

  const rank = (symbol: SymbolEntry): number => {
    if (symbol.exported && importantFiles.has(symbol.fileId)) return 0;
    if (changed.has(symbol.fileId)) return 1;
    if (symbol.exported) return 2;
    if (
      symbol.parentId === null &&
      ['class', 'interface', 'function', 'type-alias', 'enum'].includes(symbol.kind)
    ) {
      return 3;
    }
    return 4;
  };

  return input.symbols
    .map((symbol, index) => ({ symbol, index, rank: rank(symbol) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, maxSymbols)
    .map(entry => entry.symbol);
}

/** درونی‌ترین symbolای که این خط داخلش می‌افتد. */
export function findEnclosing(
  symbols: readonly SymbolEntry[],
  line: number
): SymbolEntry | undefined {
  let best: SymbolEntry | undefined;
  for (const symbol of symbols) {
    if (symbol.line > line || symbol.endLine < line) continue;
    if (!best || symbol.line > best.line) best = symbol;
  }
  return best;
}

/** ستون نام در خط اعلان، یا صفر اگر متن در دست نباشد. */
export function columnOfName(lines: readonly string[] | undefined, symbol: SymbolEntry): number {
  const line = lines?.[symbol.line - 1];
  if (!line) return 0;
  const at = line.indexOf(symbol.name);
  return at >= 0 ? at : 0;
}

/**
 * آیا این آیتم، خودِ فایل است؟
 *
 * دو نشانه، چون هیچ‌کدام به‌تنهایی قابل اتکا نیست: `kind: 2`
 * (Module) در پروتکل، و نامی که مسیر مطلق همان فایل است — کاری که
 * `tsgo` می‌کند و فاز ۳۵ ثبتش کرد.
 */
export function isModuleItem(
  item: { readonly kind: number; readonly name: string },
  filePath: string
): boolean {
  if (item.kind !== 2) return false;
  return path.isAbsolute(item.name) || item.name === path.basename(filePath);
}

export function readFileOrNull(absolute: string): string | null {
  try {
    return require('fs').readFileSync(absolute, 'utf8') as string;
  } catch {
    return null;
  }
}

export function safeFsPath(uri: string | undefined): string | null {
  if (!uri || !uri.startsWith('file:')) return null;
  try {
    return require('url').fileURLToPath(uri) as string;
  } catch {
    return null;
  }
}

export interface CallHierarchyItem {
  readonly name: string;
  readonly kind: number;
  readonly uri: string;
  readonly range: { start: { line: number; character: number } };
  readonly selectionRange?: { start: { line: number; character: number } };
}

export interface IncomingCall {
  readonly from: CallHierarchyItem;
  readonly fromRanges?: readonly { start: { line: number; character: number } }[];
}
