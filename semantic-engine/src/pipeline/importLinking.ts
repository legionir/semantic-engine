/**
 * پیوند importها به فایل‌ها و نقشهٔ پیچیدگی — توابع خالص جدا شده از `IndexPipeline`.
 */

import { PROJECT_PATH_LANGUAGES, resolveProjectImport } from './importResolution';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { FileEntry, ImportEntry, SymbolEntry } from '../core/types/project-index.types';

/** جمع پیچیدگی symbolهای هر فایل — ورودی امتیاز hotspot در git. */
export function buildFileComplexityMap(
  files: readonly FileEntry[],
  symbols: readonly SymbolEntry[]
): Map<string, number> {
  const complexityByFile = new Map<string, number>();
  for (const symbol of symbols) {
    complexityByFile.set(
      symbol.fileId,
      (complexityByFile.get(symbol.fileId) ?? 0) + (symbol.complexity ?? 0)
    );
  }

  const byPath = new Map<string, number>();
  for (const file of files) {
    const fromSymbols = complexityByFile.get(file.id) ?? 0;
    byPath.set(
      file.path,
      fromSymbols > 0 ? fromSymbols : (file.metrics?.cyclomaticComplexity ?? 0)
    );
  }
  return byPath;
}

function resolveTsPath(
  from: string,
  fromFile: string,
  files: readonly FileEntry[],
  resolver: TSPathResolver
): FileEntry | undefined {
  const resolvedPath = resolver.resolve(from, fromFile);
  if (!resolvedPath) return undefined;
  return files.find(
    candidate =>
      candidate.path === resolvedPath ||
      candidate.path === resolvedPath.replace(/^\.\//, '')
  );
}

export function resolveImport(
  imp: ImportEntry,
  file: FileEntry,
  files: readonly FileEntry[],
  resolver: TSPathResolver
): ImportEntry {
  const language = file.language ?? '';
  const target = PROJECT_PATH_LANGUAGES.has(language)
    ? resolveProjectImport(language, imp.from, file.path, files)
    : resolveTsPath(imp.from, file.path, files, resolver);

  if (!target) return imp;
  /*
  | importِ داخل‌پروژه که به فایل resolve شد، یک وابستگیِ فایل‌به‌فایل است؛
  | DependencyGraphBuilder فقط با type:'local' + resolvedFileId یالِ فایل
  | می‌سازد، پس نوع را هم درست می‌کنیم (Go/Rust/Java/Kotlin/PHPِ مطلق قبلاً
  | package/builtin بودند).
  */
  return { ...imp, resolvedFileId: target.id, type: 'local' };
}

