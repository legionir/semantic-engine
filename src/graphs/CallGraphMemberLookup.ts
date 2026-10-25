/**
 * Member lookup (instance/imported method resolution) of the call-graph builder
 * (split from CallGraphBuilder.ts, behavior unchanged).
 */

import { SymbolEntry } from '../core/types/project-index.types';
import { SymbolIndex } from './SymbolIndex';
import { ImportBinding } from './ImportIndex';
import { ExportIndex } from './ExportIndex';
import { EdgeBasis } from './EdgeProvenance';

export interface CalleeResolution {
  readonly symbolId?: string;
  readonly externalName: string;
  /**
   * چطور مقصد پیدا شد. بدون این، یالی که از «اولین symbol هم‌نام در
   * کل پروژه» ساخته شده از یالی که از AST همان فایل آمده قابل تشخیص
   * نیست (SE-GRAPH-03، پیش‌نیاز بلوک F).
   */
  readonly basis?: EdgeBasis;
}

export class CallGraphMemberLookup {
  constructor(
    private readonly symbolIndex: SymbolIndex,
    private readonly exportIndex: ExportIndex
  ) {}

  resolveImportedMember(binding: ImportBinding, methodName: string, fullName: string): CalleeResolution {
    if (!binding.resolvedFileId) {
      return { externalName: fullName };
    }

    if (binding.isNamespace) {
      // namespace import: utils.foo() → exported symbol foo در فایل مقصد
      const exportedSymbolId = this.exportIndex.resolve(binding.resolvedFileId, methodName);
      if (exportedSymbolId) {
        return { symbolId: exportedSymbolId, externalName: fullName, basis: 'import-resolved' };
      }
      const fallback = this.symbolIndex.findByNameAndFile(binding.resolvedFileId, methodName);
      if (fallback) {
        return { symbolId: fallback.id, externalName: fullName, basis: 'import-resolved' };
      }
      return { externalName: fullName };
    }

    // default / named import: service.getUsers() → کلاس UserService و متد getUsers
    const importedName = binding.isDefault ? binding.localName : binding.importedName;
    const classSymbolId = this.exportIndex.resolve(binding.resolvedFileId, importedName)
      ?? this.exportIndex.resolveDefault(binding.resolvedFileId)
      ?? this.symbolIndex.findByNameAndFile(binding.resolvedFileId, importedName)?.id;

    if (classSymbolId) {
      const member = this.findMemberSymbolById(classSymbolId, [methodName]);
      if (member) {
        return {
          symbolId: member.symbol.id,
          externalName: fullName,
          basis: member.basis === 'name-match' ? 'name-match' : 'import-resolved',
        };
      }
    }

    return { externalName: fullName };
  }

  /**
   * پیدا کردن عضو، **و اینکه چطور پیدا شد** — SE-GRAPH-05.
   *
   * تا فاز ۴۰، وقتی عضو در فرزندان ریشه نبود، این تابع به
   * `findByName(prop)` سراسری می‌افتاد — همان fallbackی که
   * SE-GRAPH-03 محکومش کرده بود — و فراخوان، یال را با
   * `basis: 'ast'` و اعتماد ۹۵ ثبت می‌کرد. یعنی حدس، «قطعی»
   * برچسب می‌خورد.
   *
   * روی ایندکس خودِ این مخزن، `lines.push(...)` داخل `runDoctor`
   * به symbolای به نام `push` در یک فایل تستِ بی‌ربط وصل شده بود،
   * با اعتماد ۹۵. هر مصرف‌کننده‌ای که روی آستانهٔ ۷۰ فیلتر کند —
   * از جمله `GraphQueryEngine` فاز ۳۹ — آن را قابل اتکا می‌بیند.
   *
   * حالا خودِ روش پیدا شدن برمی‌گردد و فراخوان **ضعیف‌ترین** مبنا
   * را می‌گیرد.
   */
  findMemberSymbol(
    rootSymbol: SymbolEntry,
    properties: readonly string[]
  ): { symbol: SymbolEntry; basis: EdgeBasis } | undefined {
    let current: SymbolEntry | undefined = rootSymbol;
    let basis: EdgeBasis = 'ast';

    for (const prop of properties) {
      if (!current) return undefined;
      const children = this.symbolIndex.findChildren(current.id);
      const child = children.find(c => c.name === prop);
      if (child) {
        current = child;
        continue;
      }

      /*
      | همان فایل: هنوز یک حدس است ولی حدسی محدود به یک فایل.
      | سراسری: «اولین symbol هم‌نام در کل پروژه» — همان چیزی که
      | باید `name-match` بماند.
      */
      const sameFile = this.symbolIndex.findByNameAndFile(rootSymbol.fileId, prop);
      if (sameFile) {
        current = sameFile;
        continue;
      }

      current = this.symbolIndex.findByName(prop);
      if (current) basis = 'name-match';
    }

    return current ? { symbol: current, basis } : undefined;
  }

  findMemberSymbolById(
    rootSymbolId: string,
    properties: readonly string[]
  ): { symbol: SymbolEntry; basis: EdgeBasis } | undefined {
    const root = this.symbolIndex.getById(rootSymbolId);
    if (!root) return undefined;
    return this.findMemberSymbol(root, properties);
  }
}
