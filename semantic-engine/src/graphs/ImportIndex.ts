/**
 * Index سریع برای binding های import‌شده در هر فایل.
 *
 * این index به CallGraphBuilder اجازه می‌دهد تا:
 * - یک identifier صدا-zده‌شده را به symbol اصلی‌اش در فایل مقصد map کند
 * - method calls روی instance های import‌شده (مثل service.getUsers()) را رزولو کند
 */

import { FileEntry, ImportEntry, ImportSpecifier } from '../core/types/project-index.types';

export interface ImportBinding {
  /** نام local که در کد استفاده می‌شود (مثل userService) */
  readonly localName: string;
  /** نام اصلی در فایل مبدأ (مثل UserService، یا 'default'، یا '*') */
  readonly importedName: string;
  /** مسیر import اصلی */
  readonly from: string;
  /** id فایل resolved‌شده در صورت local import */
  readonly resolvedFileId: string | null;
  readonly isDefault: boolean;
  readonly isNamespace: boolean;
}

export class ImportIndex {
  private readonly importsByFile = new Map<string, Map<string, ImportBinding>>();

  constructor(files: readonly FileEntry[]) {
    for (const file of files) {
      if (!file.imports || file.imports.length === 0) continue;

      const map = new Map<string, ImportBinding>();
      for (const imp of file.imports) {
        if (!imp.specifiers || imp.specifiers.length === 0) continue;
        for (const spec of imp.specifiers) {
          const binding = this.toBinding(imp, spec);
          if (binding) {
            map.set(binding.localName, binding);
          }
        }
      }

      if (map.size > 0) {
        this.importsByFile.set(file.id, map);
      }
    }
  }

  getBinding(fileId: string, localName: string): ImportBinding | undefined {
    return this.importsByFile.get(fileId)?.get(localName);
  }

  private toBinding(imp: ImportEntry, spec: ImportSpecifier): ImportBinding | null {
    const localName = spec.local;
    const importedName = spec.imported;
    if (!localName || !importedName) return null;

    return {
      localName,
      importedName,
      from: imp.from,
      resolvedFileId: imp.resolvedFileId ?? null,
      isDefault: spec.isDefault ?? false,
      isNamespace: spec.isNamespace ?? false,
    };
  }
}
