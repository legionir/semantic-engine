/**
 * ساخت DependencyGraph سطح پروژه از روی import های هر فایل.
 *
 * node ها fileId هستند؛ edge ها از import ها مشخص می‌شوند.
 * resolvedFileId اگر پر شده باشد، مستقیماً استفاده می‌شود.
 */

import { DependencyEdge, FileEntry } from '../core/types/project-index.types';
import { provenanceFor, packageRef, EdgeBasis } from './EdgeProvenance';

export class DependencyGraphBuilder {
  private readonly fileIdByPath = new Map<string, string>();

  constructor(private readonly files: readonly FileEntry[]) {
    for (const file of files) {
      this.fileIdByPath.set(normalizePath(file.path), file.id);
    }
  }

  build(): readonly DependencyEdge[] {
    const edges: DependencyEdge[] = [];

    for (const file of this.files) {
      if (!file.imports) continue;

      for (const imp of file.imports) {
        let to: string;
        let kind: DependencyEdge['kind'];
        let basis: EdgeBasis;

        /*
        | SE-GRAPH-01 — `to` دو معنی داشت: گاهی fileId و گاهی نام خام
        | ماژول. هر مصرف‌کننده‌ای آن را id فرض می‌کرد و برای پکیج‌ها
        | چیزی پیدا نمی‌کرد، و هیچ‌کس نمی‌توانست «شناسهٔ ناشناخته» را
        | از «پکیج معتبر» تشخیص دهد. حالا هرچه فایل این پروژه نیست
        | پیشوند `pkg:` می‌گیرد.
        */
        if (imp.type === 'local' && imp.resolvedFileId) {
          to = imp.resolvedFileId;
          kind = 'import';
          basis = 'import-resolved';
        } else if (imp.type === 'package' || imp.type === 'builtin') {
          to = packageRef(imp.from);
          kind = 'package';
          basis = 'declared';
        } else {
          // وارداتی که local اعلام شده ولی resolve نشده — یک حدس است
          to = packageRef(imp.from);
          kind = imp.dynamic ? 'dynamic-import' : 'import';
          basis = 'unresolved';
        }

        edges.push({
          from: file.id,
          to,
          kind,
          provenance: provenanceFor(basis, 'heuristic', { file: file.path, line: 0 }),
        });
      }
    }

    return edges;
  }

  resolveImportPath(filePath: string): string | undefined {
    return this.fileIdByPath.get(normalizePath(filePath));
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
