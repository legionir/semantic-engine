/**
 * Symbol de-duplication for the project index: one canonical `SymbolEntry` per
 * id, chosen by extractor tier, confidence and completeness.
 */

import { SymbolEntry } from '../core/types/project-index.types';

/**
 * حذف duplicate symbols بر اساس id به‌صورت دترمینیستیک.
 *
 * - هیچ warning در console چاپ نمی‌شود (تکرارها silently merge می‌شوند).
 * - برای هر گروه duplicate، یک symbol canonical انتخاب می‌شود:
 *   first party: LSP > tree-sitter > heuristic
 *   سپس: confidence بالاتر، دادهٔ کامل‌تر (signature/documentation/parameters)،
 *   و در نهایت خط کوچک‌تر.
 * - ترتیب خروجی بر اساس اولین رخداد هر id در ورودی حفظ می‌شود.
 */
export function dedupeSymbols(symbols: readonly SymbolEntry[]): SymbolEntry[] {
  const groups = new Map<string, SymbolEntry[]>();
  const firstIndex = new Map<string, number>();

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i]!;
    if (!groups.has(sym.id)) {
      firstIndex.set(sym.id, i);
      groups.set(sym.id, []);
    }
    groups.get(sym.id)!.push(sym);
  }

  const selected: { readonly sym: SymbolEntry; readonly index: number }[] = [];

  for (const [id, group] of groups) {
    const canonical = group.length === 1 ? group[0]! : selectCanonicalSymbol(group);
    selected.push({ sym: canonical, index: firstIndex.get(id)! });
  }

  // حفظ ترتیب اولین رخداد
  selected.sort((a, b) => a.index - b.index);
  return selected.map(s => s.sym);
}

/**
 * انتخاب deterministic نماد canonical از یک گروه duplicate.
 */
function selectCanonicalSymbol(symbols: SymbolEntry[]): SymbolEntry {
  const sourcePriority = (source: string | undefined): number => {
    switch (source) {
      case 'lsp':
        return 3;
      case 'tree-sitter':
        return 2;
      case 'heuristic':
        return 1;
      default:
        return 0;
    }
  };

  const score = (sym: SymbolEntry): number => {
    let s = sourcePriority(sym.source) * 10000;
    s += (sym.confidence as number | undefined) ?? 0;
    s += sym.signature && sym.signature.length > sym.name.length ? 20 : 0;
    s += sym.documentation ? 10 : 0;
    s += sym.parameters && sym.parameters.length > 0 ? 5 : 0;
    // ترجیح خط کوچک‌تر (تفاوت ناچیز تا score اعداد صحیح باقی بماند)
    s -= (sym.line ?? Number.MAX_SAFE_INTEGER) * 0.0001;
    return s;
  };

  const sorted = [...symbols].sort((a, b) => {
    const scoreA = score(a);
    const scoreB = score(b);
    if (scoreB !== scoreA) return scoreB - scoreA;
    if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
    return a.name.localeCompare(b.name);
  });

  return sorted[0]!;
}
