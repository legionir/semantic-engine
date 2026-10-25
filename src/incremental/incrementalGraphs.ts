/**
 * بازسازی گراف‌ها و resolve کردن importها برای به‌روزرسانی تدریجی —
 * جدا شده از `IncrementalEngine` (رفتار بدون تغییر).
 */

import { FileEntry, ImportEntry } from '../core/types/project-index.types';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { resolveProjectImport, PROJECT_PATH_LANGUAGES } from '../pipeline/IndexPipeline';
import { CallGraphBuilder, TypeGraphBuilder, DependencyGraphBuilder } from '../graphs';
import { GraphResult } from '../export/JsonExporter';
import { ProjectIndexStore } from './ProjectIndexStore';

/**
 * rebuild graph ها برای فایل‌های affected.
 * - dependencyGraph: از تمام files (ارزان است)
 * - typeGraph: از تمام symbols (ارزان است)
 * - callGraph: فقط برای affected files
 */
export function rebuildGraphs(
  store: ProjectIndexStore | null,
  workspaceRoot: string,
  affectedFileIds: ReadonlySet<string>,
  removedSymbolIds: ReadonlySet<string>
): GraphResult {
  if (!store) {
    return { callGraph: [], typeGraph: [], dependencyGraph: [] };
  }

  const files = store.projectIndex.files;
  const symbols = store.projectIndex.symbols;

  // ۱. DependencyGraph — rebuild کامل (ارزان)
  const dependencyGraphBuilder = new DependencyGraphBuilder(files);
  const dependencyGraph = dependencyGraphBuilder.build();

  // ۲. TypeGraph — rebuild کامل (ارزان)
  const typeGraphBuilder = new TypeGraphBuilder(symbols);
  const typeGraph = typeGraphBuilder.build();

  /*
  | ۳. CallGraph — یال‌های فایل‌های affected دور ریخته و دوباره
  | ساخته می‌شوند؛ بقیه نگه داشته می‌شوند.
  |
  | SE-INC-03: مجموعهٔ «symbolهای رفته» قبلاً این‌طور حساب می‌شد:
  |
  |   symbols.filter(s => … || removedFileIds.has(s.fileId))
  |
  | ولی `symbols` وضعیت *پس از* حذف است، پس هیچ symbolی از فایل
  | حذف‌شده در آن نیست و آن شرط هرگز چیزی برنمی‌گرداند. تنها
  | دلیلی که این تا امروز خرابی نمی‌ساخت، یک باگ دوم بود
  | (SE-INC-11): `removeFile` آرایهٔ symbols را همگام نمی‌کرد، پس
  | symbolهای رفته اتفاقاً هنوز آن‌جا بودند. با اصلاح آن باگ، این
  | یکی زنده می‌شد.
  |
  | حالا شناسه‌ها همان لحظهٔ حذف برداشته می‌شوند و صریح تحویل
  | می‌آیند.
  */
  const existingCallGraph = store.projectIndex.graphs.callGraph;
  const affectedSymbolIds = new Set(
    symbols.filter(symbol => affectedFileIds.has(symbol.fileId)).map(symbol => symbol.id)
  );

  const preservedEdges = existingCallGraph.filter(
    edge =>
      !affectedSymbolIds.has(edge.caller) &&
      !affectedSymbolIds.has(edge.callee) &&
      !removedSymbolIds.has(edge.caller) &&
      !removedSymbolIds.has(edge.callee)
  );

  // ساخت edge های جدید برای affected files
  const callGraphBuilder = new CallGraphBuilder({
    workspaceRoot: workspaceRoot,
    files,
    symbols,
  });
  const newEdges = callGraphBuilder.buildForFiles(affectedFileIds);

  const callGraph = [...preservedEdges, ...newEdges];

  return { callGraph, typeGraph, dependencyGraph };
}

export function resolveImport(
  imp: ImportEntry,
  file: FileEntry,
  store: ProjectIndexStore | null,
  pathResolver: TSPathResolver
): ImportEntry {
  /*
  | هم‌راستا با IndexPipeline: زبان‌هایی که importشان مسیرِ ماژول/بسته است
  | (پایتون/Go/Rust/Java/Kotlin/C-Cpp/Ruby/PHP) با resolveProjectImport مشترک
  | resolve می‌شوند؛ ایندکسِ افزایشی (watch) هم باید همان یال‌ها را ببیند.
  */
  const language = file.language ?? '';
  if (PROJECT_PATH_LANGUAGES.has(language)) {
    const target = resolveProjectImport(language, imp.from, file.path, store?.projectIndex.files ?? []);
    return target ? { ...imp, resolvedFileId: target.id, type: 'local' } : imp;
  }

  const resolvedPath = pathResolver.resolve(imp.from, file.path);
  if (!resolvedPath) return imp;

  const targetFile = store?.getFileByPath(resolvedPath)
    ?? store?.getFileByPath(resolvedPath.replace(/^\.\//, ''));
  if (!targetFile) return imp;

  return {
    ...imp,
    resolvedFileId: targetFile.id,
  };
}
