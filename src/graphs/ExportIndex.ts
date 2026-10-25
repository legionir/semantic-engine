import { FileEntry } from '../core/types/project-index.types';
import { SymbolIndex } from './SymbolIndex';

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Index سریع برای export های هر فایل → symbol id.
 * برای رزولوشن cross-file call مورد نیاز است.
 */
export class ExportIndex {
  private readonly byFile = new Map<string, Map<string, string>>();
  private readonly defaultByFile = new Map<string, string>();

  constructor(files: readonly FileEntry[], private readonly symbolIndex: SymbolIndex) {
    for (const file of files) {
      if (!file.exports || file.exports.length === 0) continue;

      const map = new Map<string, string>();
      for (const exp of file.exports) {
        if (exp.kind === 're-export' || exp.kind === 'namespace') {
          // re-export از فایل دیگری است؛ اینجا فقط local exports را نگه می‌داریم
          continue;
        }

        // SE-DATA-02 — هر entry یک نام دارد؛ توضیح در ReExportResolver.
        const name = exp.name.trim();
        if (name) {
          const sym = this.symbolIndex.findByNameAndFile(file.id, name);
          if (sym) {
            map.set(name, sym.id);
            if (exp.kind === 'default') {
              this.defaultByFile.set(file.id, sym.id);
            }
          }
        }
      }

      if (map.size > 0) {
        this.byFile.set(file.id, map);
      }
    }
  }

  resolve(fileId: string, name: string): string | undefined {
    return this.byFile.get(fileId)?.get(name);
  }

  resolveDefault(fileId: string): string | undefined {
    return this.defaultByFile.get(fileId);
  }
}
