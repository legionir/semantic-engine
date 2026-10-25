/**
 * Section model and budget-section building of the assemble_context tool
 * (split from AssembleContextTool.ts, behavior unchanged).
 */

import type { RankedCandidate } from '../ranking/ContextRanker';
import type { BudgetSection } from '../ranking/TokenBudget';

/** بخشی از context، همراه با سهم تضمین‌شده‌اش. */
export type SectionName =
  | 'targetFiles'
  | 'targetSymbols'
  | 'relatedFiles'
  | 'relatedSymbols'
  | 'tests'
  | 'recentChanges';

export interface Entity {
  readonly id: string;
  readonly section: SectionName;
  readonly name: string;
  readonly kind: string;
  readonly path?: string;
  readonly line?: number;
  readonly text: string;
  readonly hops: number | null;
}

export const SECTION_HEADERS: Readonly<Record<SectionName, string>> = {
  targetFiles: '=== Target Files ===',
  targetSymbols: '=== Target Symbols ===',
  relatedFiles: '=== Related Files ===',
  relatedSymbols: '=== Related Symbols ===',
  tests: '=== Related Tests ===',
  recentChanges: '=== Recent Changes ===',
};

/*
| سهم‌های تضمین‌شده.
|
| «هدف» تضمین دارد چون بدون آن، کل خروجی می‌تواند دربارهٔ همسایه‌ها
| باشد و خودِ چیزی که قرار است تغییر کند بیفتد. «تست» تضمین دارد چون
| معیار پذیرش فاز ۴۲ همین است و چون آخرین بخش است — یعنی دقیقاً همان
| جایی که برشِ از انتها می‌خورد.
|
| بخش‌های بدون تضمین در پاس دومِ بودجه، آزادانه رقابت می‌کنند.
*/
export const SECTION_GUARANTEE: Readonly<Partial<Record<SectionName, number>>> = {
  targetFiles: 0.2,
  targetSymbols: 0.1,
  tests: 0.15,
  /*
  | SE-AI-18 — «تغییرات اخیر» تضمین می‌گیرد چون **صریحاً درخواست
  | شده** است (`includeRecentChanges` پیش‌فرضش false است). بدون
  | تضمین، سطرهای commit امتیازِ صفر می‌گیرند — رتبه‌بند دربارهٔ یک
  | سطر commit هیچ سیگنالی ندارد و صادقانه چیزی نمی‌گوید — و در
  | استخر سراسری همیشه آخر می‌ایستند.
  |
  | اندازه‌گیری‌ای که این را لازم کرد: با بودجهٔ ۲۰۰ توکن یک سطر
  | commit می‌آمد و با بودجهٔ ۴۰۰ توکن هیچ سطری. یعنی بودجهٔ بیشتر،
  | خروجی کمتر.
  */
  recentChanges: 0.1,
};

export const SECTION_ORDER: readonly SectionName[] = [
  'targetFiles',
  'targetSymbols',
  'relatedFiles',
  'relatedSymbols',
  'tests',
  'recentChanges',
];

export function buildSections(
  entities: readonly Entity[],
  ranked: readonly RankedCandidate<Entity>[]
): BudgetSection[] {
  const scoreById = new Map(ranked.map(r => [r.id, r.score]));

  return SECTION_ORDER.map(name => {
    const items = entities
      .filter(e => e.section === name)
      .map(e => ({ id: e.id, text: e.text, score: scoreById.get(e.id) ?? 0 }));

    const guarantee = SECTION_GUARANTEE[name];
    return {
      name,
      header: SECTION_HEADERS[name],
      items,
      ...(guarantee !== undefined ? { guarantee } : {}),
    };
  }).filter(section => section.items.length > 0);
}
