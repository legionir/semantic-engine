/**
 * Resolver برای re-export های JS/TS.
 *
 * وظایف:
 * - resolve کردن مسیر reExportFrom به fileId
 * - پیدا کردن symbolId مربوط به export شده در فایل مبدأ
 * - لینک کردن symbolId برای export entry ها
 */

import { FileEntry, SymbolEntry, ExportEntry } from '../../core/types/project-index.types';
import { TSPathResolver } from './TSPathResolver';
import { SymbolIndex } from '../../graphs/SymbolIndex';

export interface ResolvedReExport {
  readonly fileId: string;
  readonly export: ExportEntry;
  readonly resolvedFileId: string | null;
  readonly resolvedSymbolId: string | null;
}

export class ReExportResolver {
  private readonly symbolIndex: SymbolIndex;
  private readonly fileById = new Map<string, FileEntry>();
  private readonly fileByPath = new Map<string, FileEntry>();

  constructor(
    private readonly workspaceRoot: string,
    files: readonly FileEntry[],
    symbols: readonly SymbolEntry[],
    private readonly pathResolver: TSPathResolver
  ) {
    this.symbolIndex = new SymbolIndex(symbols);
    for (const file of files) {
      this.fileById.set(file.id, file);
      this.fileByPath.set(normalizePath(file.path), file);
    }
  }

  /**
   * Resolve تمام re-export های موجود در dependency results.
   */
  resolve(dependencies: readonly { fileId: string; exports: readonly ExportEntry[] }[]): ResolvedReExport[] {
    const result: ResolvedReExport[] = [];

    for (const dep of dependencies) {
      const file = this.fileById.get(dep.fileId);
      if (!file) continue;

      for (const exp of dep.exports) {
        if (exp.kind !== 're-export' && exp.kind !== 'namespace') continue;
        if (!exp.reExportFrom) continue;

        const resolvedFileId = this.resolveTargetFileId(exp.reExportFrom, file.path);
        const resolvedSymbolId = resolvedFileId
          ? this.resolveTargetSymbolId(resolvedFileId, exp.name)
          : null;

        result.push({
          fileId: dep.fileId,
          export: exp,
          resolvedFileId,
          resolvedSymbolId,
        });
      }
    }

    return result;
  }

  /**
   * لینک کردن symbolId برای export entry های عادی (named/default) بر اساس symbols موجود در همان فایل.
   */
  linkLocalExportSymbolIds(files: readonly FileEntry[]): FileEntry[] {
    return files.map(file => {
      if (!file.exports || file.exports.length === 0) return file;

      const linkedExports = file.exports.map(exp => {
        if (exp.symbolId) return exp;
        if (exp.kind === 're-export' || exp.kind === 'namespace') return exp;

        /*
        | SE-DATA-02 — تا فاز ۱۸ نام‌ها با کاما در یک رشته بودند و
        | اینجا فقط `names[0]` استفاده می‌شد؛ یعنی از `export {a, b}`
        | تنها `a` شناسهٔ symbol می‌گرفت. حالا هر نام entry خودش را
        | دارد و split معنایی ندارد.
        */
        const name = exp.name.trim();
        if (!name) return exp;

        const sym = this.symbolIndex.findByNameAndFile(file.id, name);
        if (sym) {
          return { ...exp, symbolId: sym.id };
        }
        return exp;
      });

      return { ...file, exports: linkedExports };
    });
  }

  private resolveTargetFileId(reExportFrom: string, importerPath: string): string | null {
    const resolvedPath = this.pathResolver.resolve(reExportFrom, importerPath);
    if (!resolvedPath) return null;

    const target = this.fileByPath.get(normalizePath(resolvedPath))
      ?? this.fileByPath.get(normalizePath(resolvedPath.replace(/^\.\//, '')));

    return target?.id ?? null;
  }

  private resolveTargetSymbolId(targetFileId: string, exportName: string): string | null {
    if (exportName === '*') return null;

    const sym = this.symbolIndex.findByNameAndFile(targetFileId, exportName.trim());
    return sym ? sym.id : null;
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
