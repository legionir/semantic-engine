/**
 * Index سریع برای پیدا کردن symbol id بر اساس فایل و محدوده‌ی خط.
 *
 * در فاز ۴ برای ساخت CallGraph/TypeGraph استفاده می‌شود تا بتوانیم
 * callee را به symbol id موجود در project-index map کنیم.
 */

import { SymbolEntry } from '../core/types/project-index.types';

export class SymbolIndex {
  private readonly byId = new Map<string, SymbolEntry>();
  private readonly byFile = new Map<string, SymbolEntry[]>();
  /* Lookup tables built on first use; first match in iteration order wins, as before. */
  private byNameCache?: Map<string, SymbolEntry>;
  private byFileNameCache?: Map<string, Map<string, SymbolEntry>>;
  private byParentCache?: Map<string, SymbolEntry[]>;

  constructor(symbols: readonly SymbolEntry[]) {
    for (const sym of symbols) {
      this.byId.set(sym.id, sym);
      const existing = this.byFile.get(sym.fileId);
      if (existing) {
        existing.push(sym);
      } else {
        this.byFile.set(sym.fileId, [sym]);
      }
    }
  }

  getById(id: string): SymbolEntry | undefined {
    return this.byId.get(id);
  }

  /**
   * پیدا کردن تمام symbol هایی که در فایل داده‌شده و در خط داده‌شده قرار دارند.
   * (برای انتخاب دقیق‌ترین symbol در هنگام nesting.)
   */
  findSymbolsAtLine(fileId: string, line: number): SymbolEntry[] {
    const symbols = this.byFile.get(fileId) ?? [];
    return symbols.filter(s => s.line <= line && line <= s.endLine);
  }

  /**
   * پیدا کردن symbol ای که در فایل داده‌شده و در خط داده‌شده قرار دارد.
   * برای call site هایی که دقیقاً روی declaration یک symbol نیستند (مثلاً call به تابع دیگر).
   */
  findSymbolAtLine(fileId: string, line: number): SymbolEntry | undefined {
    const candidates = this.findSymbolsAtLine(fileId, line);
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line));
    return candidates[0];
  }

  /**
   * پیدا کردن symbol ای که دقیقاً در فایل و خط شروع داده‌شده تعریف شده.
   */
  findSymbolByStartLine(fileId: string, line: number): SymbolEntry | undefined {
    const symbols = this.byFile.get(fileId) ?? [];
    return symbols.find(s => s.line === line);
  }

  /**
   * پیدا کردن symbol بر اساس نام در کل پروژه.
   * در صورت وجود چندین match، اولی برگردانده می‌شود.
   */
  findByName(name: string): SymbolEntry | undefined {
    if (!this.byNameCache) {
      const table = new Map<string, SymbolEntry>();
      for (const sym of this.byId.values()) {
        if (!table.has(sym.name)) table.set(sym.name, sym);
      }
      this.byNameCache = table;
    }
    return this.byNameCache.get(name);
  }

  /**
   * پیدا کردن symbol بر اساس نام در یک فایل مشخص.
   */
  findByNameAndFile(fileId: string, name: string): SymbolEntry | undefined {
    if (!this.byFileNameCache) this.byFileNameCache = new Map();
    let table = this.byFileNameCache.get(fileId);
    if (!table) {
      table = new Map();
      for (const sym of this.byFile.get(fileId) ?? []) {
        if (!table.has(sym.name)) table.set(sym.name, sym);
      }
      this.byFileNameCache.set(fileId, table);
    }
    return table.get(name);
  }

  /**
   * پیدا کردن فرزندان یک symbol (مثلاً methods یک class).
   */
  findChildren(parentId: string): SymbolEntry[] {
    const fileId = this.getById(parentId)?.fileId ?? '';
    if (!this.byParentCache) this.byParentCache = new Map();
    const key = `${fileId}\u0000${parentId}`;
    let children = this.byParentCache.get(key);
    if (!children) {
      children = (this.byFile.get(fileId) ?? []).filter(s => s.parentId === parentId);
      this.byParentCache.set(key, children);
    }
    return [...children];
  }

  /**
   * پیدا کردن نزدیک‌ترین والد از نوع class/interface برای یک symbol.
   */
  findEnclosingTypeSymbol(sym: SymbolEntry): SymbolEntry | undefined {
    let current: SymbolEntry | undefined = sym;
    while (current) {
      if (current.parentId === null) {
        if (current.kind === 'class' || current.kind === 'interface') {
          return current;
        }
        return undefined;
      }
      const parent = this.getById(current.parentId);
      if (!parent) return undefined;
      if (parent.kind === 'class' || parent.kind === 'interface') {
        return parent;
      }
      current = parent;
    }
    return undefined;
  }
}
