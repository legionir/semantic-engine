/**
 * ادغام نتیجهٔ استخراج‌گرها — SE-SYM-01.
 *
 * تا امروز `SymbolExtractorManager` نتیجهٔ `partial` را **دور
 * می‌ریخت** و به استخراج‌گر بعدی می‌رفت. یعنی اگر زبان‌سرور به‌خاطر
 * یک خطای نحوی جزئی `partial: true` می‌داد، جایش را یک مشت regex
 * می‌گرفت که همیشه `partial: false` برمی‌گرداند — «کامل» بودنش فقط
 * یعنی هیچ‌وقت اعتراف نمی‌کند چیزی را از دست داده.
 *
 * ── چرا ادغام و نه «هرکس بالاتر بود ببرد» ──────────────────────────
 *
 * چون هیچ‌کدام به‌طور یکنواخت بهتر نیستند. اندازه‌گیری روی همین
 * fixture (فاز ۳۳):
 *
 * ```
 * زبان‌سرور     : سلسله‌مراتب کامل، پارامتر-پراپرتی سازنده، endLine واقعی
 *                 ولی  type X = … → kind=Class   و  const → variable
 *                 و    detail هرگز نمی‌آید
 * tree-sitter  : kind دقیق، امضا دارد
 *                 ولی  اعضای بعضی ساختارها را نمی‌بیند
 * ```
 *
 * پس نتیجهٔ درست، اجتماع آن‌هاست با ترجیح اولویت بالاتر — نه انتخاب
 * یکی و دور ریختن دیگری.
 *
 * ── قواعد ──────────────────────────────────────────────────────────
 *
 * - پایه، اولین نتیجه است (بالاترین اولویت).
 * - از نتیجه‌های بعدی فقط symbolهایی اضافه می‌شوند که در پایه نیستند.
 *   کلید تطبیق: `name@line`. یک اعلان روی یک خط، یک چیز است — حتی
 *   اگر دو استخراج‌گر `kind`های متفاوتی برایش بگویند.
 * - `parentId` نتیجهٔ پایین‌دستی **بازنگاشت** می‌شود به id پایه. یال
 *   آویزان بدتر از نبودن symbol است: مصرف‌کننده درخت را می‌سازد و
 *   شاخه گم می‌شود.
 * - `source` هر `SymbolEntry` دست‌نخورده می‌ماند، پس خروجی صادقانه
 *   می‌گوید هر symbol از کجا آمده.
 */

import { SymbolEntry } from '../core/types/project-index.types';
import { SymbolExtractionResult } from './ISymbolExtractor';

/** `name@line` — یک اعلان روی یک خط. */
function keyOf(symbol: SymbolEntry): string {
  return `${symbol.name}@${symbol.line}`;
}

export interface MergeStats {
  /** چند symbol از نتیجه‌های پایین‌دستی اضافه شد. */
  readonly added: number;
  /** چند symbol به‌خاطر تکراری بودن رد شد. */
  readonly skipped: number;
}

export interface MergeOutcome {
  readonly result: SymbolExtractionResult;
  readonly stats: MergeStats;
}

/**
 * چند نتیجه، به‌ترتیب اولویت (بالاترین اول)، در یکی.
 *
 * با یک ورودی، همان ورودی برمی‌گردد — بدون کپی، بدون تغییر.
 */
export function mergeExtractionResults(
  results: readonly SymbolExtractionResult[]
): MergeOutcome {
  if (results.length === 0) {
    return {
      result: { symbols: [], source: 'heuristic', partial: true, warnings: ['no extractor ran'] },
      stats: { added: 0, skipped: 0 },
    };
  }
  if (results.length === 1) {
    return { result: results[0], stats: { added: 0, skipped: 0 } };
  }

  const merged: SymbolEntry[] = [...results[0].symbols];
  const byKey = new Map<string, string>();   // key → id در نتیجهٔ ادغام‌شده
  const ids = new Set<string>();
  for (const symbol of merged) {
    byKey.set(keyOf(symbol), symbol.id);
    ids.add(symbol.id);
  }

  let added = 0;
  let skipped = 0;

  for (const result of results.slice(1)) {
    // نگاشت id → symbol داخل همین نتیجه، برای پیدا کردن والد.
    const own = new Map<string, SymbolEntry>();
    for (const symbol of result.symbols) own.set(symbol.id, symbol);

    const incoming: SymbolEntry[] = [];
    for (const symbol of result.symbols) {
      if (byKey.has(keyOf(symbol)) || ids.has(symbol.id)) {
        skipped++;
        continue;
      }
      incoming.push(symbol);
      byKey.set(keyOf(symbol), symbol.id);
      ids.add(symbol.id);
    }

    for (const symbol of incoming) {
      merged.push({ ...symbol, parentId: remapParent(symbol, own, byKey) });
      added++;
    }
  }

  const contributor = results.find(result => result.symbols.length > 0) ?? results[results.length - 1];

  return {
    result: {
      symbols: merged,
      source: contributor.source,
      /*
      | ناقص فقط وقتی که *همه* ناقص باشند. یک نتیجهٔ کامل در زنجیره
      | یعنی جای خالی‌ها پر شده است.
      */
      partial: results.every(result => result.partial),
      warnings: results.flatMap(result =>
        result.warnings.map(warning => `[${result.source}] ${warning}`)
      ),
    },
    stats: { added, skipped },
  };
}

/**
 * والد را در نتیجهٔ ادغام‌شده پیدا می‌کند.
 *
 * اگر والد در نتیجهٔ خودش پیدا نشود یا در ادغام نباشد، `parentId` به
 * `null` می‌رود: symbol به سطح بالا می‌آید ولی گم نمی‌شود. یک id
 * آویزان، درخت مصرف‌کننده را می‌شکند.
 */
function remapParent(
  symbol: SymbolEntry,
  own: ReadonlyMap<string, SymbolEntry>,
  byKey: ReadonlyMap<string, string>
): string | null {
  if (!symbol.parentId) return null;
  const parent = own.get(symbol.parentId);
  if (!parent) return null;
  return byKey.get(keyOf(parent)) ?? null;
}
