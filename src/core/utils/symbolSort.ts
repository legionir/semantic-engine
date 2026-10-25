import { SymbolEntry } from '../types/project-index.types';

/**
 * ترتیب canonical برای kind ها — namespace/module در بالا، parameter در پایین.
 */
const KIND_ORDER = [
  'namespace',
  'module',
  'class',
  'interface',
  'struct',
  'trait',
  'enum',
  'type-alias',
  'function',
  'method',
  'property',
  'variable',
  'constant',
  'parameter',
  'decorator',
];

/*
| KIND_ORDER باید تمام اعضای union `SymbolKind` در project-index.types را بپوشاند.
| قبل از این، `trait` و `decorator` در bucket 999 می‌افتندند؛ خروجی همچنان
| دترمینیستیک بود (tie-break با name/id) ولی ترتیب canonical را نقض می‌کرد:
| یک trait کنار یک constantِ هم‌خط/هم‌نام بعد از آن sort می‌شد، برخلاف
| باقی kindهای سطح-بالا. تست `covers every SymbolKind member` این را قفل می‌کند.
*/

function kindOrder(kind: string): number {
  const idx = KIND_ORDER.indexOf(kind);
  return idx === -1 ? 999 : idx;
}

/**
 * مرتب‌سازی دترمینیستیک symbols برای خروجی پایدار.
 * ترتیب: fileId → line → kind → name → id
 */
export function sortSymbolsDeterministically(symbols: readonly SymbolEntry[]): SymbolEntry[] {
  return [...symbols].sort((a, b) => {
    if (a.fileId !== b.fileId) return a.fileId.localeCompare(b.fileId);
    if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
    if (kindOrder(a.kind) !== kindOrder(b.kind)) return kindOrder(a.kind) - kindOrder(b.kind);
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.id.localeCompare(b.id);
  });
}
