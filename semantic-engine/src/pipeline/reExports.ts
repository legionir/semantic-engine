/**
 * re-exportها — جدا شده از `IndexPipeline` (رفتار بدون تغییر).
 */

import { ReExportResolver } from '../dependencies/typescript/ReExportResolver';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { DependencyResult } from '../export/JsonExporter';
import { provenanceFor } from '../graphs/EdgeProvenance';
import { DependencyEdge, FileEntry, SymbolEntry } from '../core/types/project-index.types';

/** مرحلهٔ ۴ — re-exportها: یال‌های import و symbolId مقصدِ هر re-export. */
export function resolveReExports(
workspaceRoot: string,
  inputFiles: readonly FileEntry[],
  symbols: readonly SymbolEntry[],
  dependencies: readonly DependencyResult[],
  resolver: TSPathResolver
): { readonly files: FileEntry[]; readonly edges: DependencyEdge[] } {
  let files: FileEntry[] = [...inputFiles];
  const reExportEdges: DependencyEdge[] = [];
  const reExportSymbolIds = new Map<string, string>();
  const resolved = new ReExportResolver(
    workspaceRoot,
    files,
    symbols,
    resolver
  ).resolve(dependencies);

  for (const item of resolved) {
    if (item.resolvedFileId) {
      reExportEdges.push({
        from: item.fileId,
        to: item.resolvedFileId,
        kind: 'import',
        // re-export از خود کد خوانده شده و مقصدش به فایل resolve شده
        provenance: provenanceFor('import-resolved', 'typescript-api'),
      });
    }
    if (item.resolvedSymbolId) {
      reExportSymbolIds.set(`${item.fileId}::${item.export.name}`, item.resolvedSymbolId);
    }
  }

  files = files.map(file => {
    if (!file.exports || file.exports.length === 0) return file;
    return {
      ...file,
      exports: file.exports.map(exp => {
        if (exp.symbolId) return exp;
        if (exp.kind !== 're-export' && exp.kind !== 'namespace') return exp;
        const symbolId = reExportSymbolIds.get(`${file.id}::${exp.name}`);
        return symbolId ? { ...exp, symbolId } : exp;
      }),
    };
  });

  return { files, edges: reExportEdges };
}
