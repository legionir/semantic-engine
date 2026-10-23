/**
 * Display helpers of the explain_symbol tool (split from ExplainSymbolTool.ts, unchanged).
 */

import type { ProjectIndex, SymbolEntry } from '../../core/types/project-index.types';
import { HIGH_CONFIDENCE_THRESHOLD } from '../../graphs/EdgeProvenance';
import type { RelatedSymbol } from './explainSymbolTypes';

/**
 * چرا این فایل diagnostics ندارد؟ سه جواب ممکن دارد و انتخابِ درست
 * از خودِ ایندکس خوانده می‌شود:
 *
 *   1. `diagnosticsRun` نیست            → مرحلهٔ زبان‌سرور هرگز اجرا نشده
 *   2. فایل بعد از آن مرحله عوض شده   → یافته‌های کهنه پاک شده‌اند
 *   3. هیچ‌کدام                        → واقعاً چیزی پیدا نشد (بدون یادآوری)
 */
/**
 * نام کامل سمبل برای نمایش.
 *
 * `SymbolIdentity` برای یکتا کردن نام‌های تکراری در یک فایل پسوند `#1`, `#2`
 * می‌گذارد — چیزی که برای *شناسه* لازم است ولی در پاسخ ابزار فقط نویز است،
 * مخصوصاً وقتی نام سمبل خودش یک الگوی تخریبی باشد (`{ scene }#2`). سطرِ
 * همراهِ همان آیتم، جای بی‌معنیِ `#N` را برای تمایز می‌گیرد.
 */
export function displaySymbolName(symbol: Pick<SymbolEntry, 'name' | 'fullyQualifiedName'>): string {
  const fq = symbol.fullyQualifiedName;
  if (!fq) return symbol.name;
  const stripped = fq.replace(/#\d+$/, '');
  return stripped.includes('::') ? stripped.split('::').slice(1).join('::') || symbol.name : stripped;
}

export function diagnosticsCaveat(
  index: Pick<ProjectIndex, 'diagnosticsRun'>,
  fileModifiedAt?: string | null
): string | null {
  const run = index.diagnosticsRun;
  if (!run) {
    return (
      'no language-server diagnostics in this index (it was built without --lsp-diagnostics); ' +
      'an empty list here means "not checked", not "clean"'
    );
  }
  if (fileModifiedAt && run.completedAt) {
    const modified = Date.parse(fileModifiedAt);
    const completed = Date.parse(run.completedAt);
    if (Number.isFinite(modified) && Number.isFinite(completed) && modified > completed) {
      return (
        `this file changed after the last diagnostics pass (${run.completedAt}), so any findings it ` +
        'had were cleared as stale — re-run `index --lsp-diagnostics` before reading the empty list as "clean"'
      );
    }
  }
  return null;
}

/**
 * یک کلمه دربارهٔ اینکه این بخش چقدر قابل اتکاست.
 *
 * `resolved` وقتی همه‌چیز از کامپایلر آمده، `mixed` وقتی بعضی
 * حدس‌اند، `name-match` وقتی همه حدس‌اند، و `none` وقتی چیزی نیست.
 */
export function summarize(entries: readonly RelatedSymbol[]): string {
  if (entries.length === 0) return 'none';
  const weak = entries.filter(entry => entry.confidence < HIGH_CONFIDENCE_THRESHOLD).length;
  if (weak === 0) return 'resolved';
  if (weak === entries.length) return 'name-match';
  return 'mixed';
}
