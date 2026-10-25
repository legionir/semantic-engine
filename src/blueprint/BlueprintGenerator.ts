/**
 * BlueprintGenerator — تولید blueprint.json از روی project-index.json.
 *
 * این فاز کاملاً derived است؛ هیچ id جدیدی برای symbol/file نمی‌سازد.
 * module id ها با پیشوند `mod-` و ساختار path-based تولید می‌شوند.
 */

import * as path from 'path';
import {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
} from '../core/types/project-index.types';
import { Blueprint, BlueprintMeta, ModuleEntry, BlueprintDependencyGraph, GraphNode, GraphEdge, BlueprintSymbolIndexEntry, ApiEntry } from '../core/types/blueprint.types';
import { sha256 } from '../core/utils/hash';
import { ROOT_MODULE_PATH } from './blueprintCategories';
import {
  buildFolderStructure,
  deriveModulePath,
  inferResponsibility,
  modulePathToId,
} from './blueprintStructure';
import {
  buildArchitectureOverview,
  buildTechnicalConstraints,
} from './blueprintArchitecture';
import { ApiMapExtractor } from './ApiMapExtractor';
import { EntityMapExtractor, WorkflowExtractor } from './EntityMapExtractor';

export interface BlueprintGeneratorOptions {
  readonly generatorVersion?: string;
  readonly gitCommit?: string;
  readonly driftScore?: number;
  /**
   * سورسِ یک فایل، برای استخراجِ `apiMap` — SE-BP-02.
   *
   * blueprint در اصل «کاملاً derived» است و فقط از project-index
   * می‌خواند. ثبتِ مسیرهای HTTP اما در ایندکس نیست: نه symbol است نه
   * dependency. به‌جای افزودنِ یک فیلدِ تازه به قرارداد داده، سورس
   * به‌صورت **اختیاری** تزریق می‌شود.
   *
   * بدون آن، `apiMap` خالی می‌ماند — که صادقانه است: «نگاه نکردم»
   * نه «چیزی نبود».
   */
  readonly sourceOf?: (file: FileEntry) => string | undefined;
}

export class BlueprintGenerator {
  private readonly moduleMap = new Map<string, ModuleEntry>();
  /**
   * fileId → moduleId، از آخرین `generate()`.
   *
   * SE-DATA-04 — `FileEntry.blueprintRef` در قرارداد اعلام شده بود و
   * هیچ‌جا نوشته نمی‌شد. نگاشتِ فایل به ماژول فقط داخل blueprint
   * وجود داشت، پس هر مصرف‌کننده‌ای که از project-index شروع می‌کرد
   * یا باید دوباره حسابش می‌کرد یا بی‌خبر می‌ماند.
   */
  private readonly moduleByFileId = new Map<string, string>();

  /** نگاشتِ فایل به ماژولِ آخرین blueprintِ تولیدشده. */
  moduleRefs(): ReadonlyMap<string, string> {
    return this.moduleByFileId;
  }

  constructor(private readonly options: BlueprintGeneratorOptions = {}) {}

  generate(projectIndex: ProjectIndex): Blueprint {
    const modules = this.buildModuleMap(projectIndex.files);
    const apiMap = this.buildApiMap(projectIndex);
    const folderStructure = buildFolderStructure(projectIndex.files);
    const dependencyGraph = this.buildDependencyGraph(projectIndex, modules);
    const moduleDependencies = this.deriveModuleDependencies(modules, dependencyGraph);

    const modulesWithDeps: ModuleEntry[] = modules.map(mod => {
      const deps = moduleDependencies.get(mod.id) ?? [];
      return deps.length > 0 ? { ...mod, dependsOnModuleIds: deps } : mod;
    });

    return {
      schemaVersion: '2.0.0',
      meta: this.buildMeta(projectIndex),
      architectureOverview: buildArchitectureOverview(modulesWithDeps),
      moduleMap: modulesWithDeps,
      folderStructure,
      dependencyGraph,
      entityTechnicalMapping: new EntityMapExtractor().extract({
        projectIndex,
        ...(this.options.sourceOf ? { sourceOf: this.options.sourceOf } : {}),
      }),
      apiMap,
      workflowExecutionMap: new WorkflowExtractor().extract({ projectIndex, apiMap }),
      symbolIndex: this.buildSymbolIndex(projectIndex.symbols, projectIndex.files),
      technicalConstraints: buildTechnicalConstraints(projectIndex),
    };
  }

  /**
   * SE-BP-02 — `apiMap` از روی سورس، بدون LLM.
   *
   * فقط فایل‌هایی خوانده می‌شوند که `sourceOf` برایشان چیزی بدهد.
   * اگر تزریق نشده باشد، فهرست خالی است.
   */
  private buildApiMap(projectIndex: ProjectIndex): ApiEntry[] {
    const sourceOf = this.options.sourceOf;
    if (!sourceOf) return [];

    const extractor = new ApiMapExtractor();
    const entries: ApiEntry[] = [];
    const symbolsByFile = new Map<string, SymbolEntry[]>();

    for (const symbol of projectIndex.symbols) {
      const list = symbolsByFile.get(symbol.fileId) ?? [];
      list.push(symbol);
      symbolsByFile.set(symbol.fileId, list);
    }

    for (const file of projectIndex.files) {
      if (file.binary) continue;

      const source = sourceOf(file);
      if (!source) continue;

      for (const route of extractor.extract(file.path, source)) {
        /*
        | handler به یک symbol واقعی وصل می‌شود اگر پیدا شود. نامِ
        | تنها، بدون شناسه، برای مصرف‌کننده‌ای که می‌خواهد به کد
        | برود کافی نیست.
        */
        const handlerSymbol = route.handlerName
          ? (symbolsByFile.get(file.id) ?? []).find(sym => sym.name === route.handlerName)
          : undefined;

        entries.push({
          id: `api-${sha256(`${file.id}:${route.method}:${route.path}:${route.line}`).substring(0, 12)}`,
          method: route.method as ApiEntry['method'],
          path: route.path,
          handlerSymbolId: handlerSymbol?.id ?? null,
          handlerName: route.handlerName,
          fileId: file.id,
          line: route.line,
          framework: route.framework,
          derivedFrom: 'static-analysis',
          /*
          | SE-SEC-001: تشخیصِ اینکه یک مسیر احراز هویت می‌خواهد، از نحو
          | برنمی‌آید. `false` قدیمی به AI می‌گفت «این route باز است» در
          | حالی که منظور «شواهدی ندیدم» بود — یعنی evidence of absence
          | جا زده می‌شد با absence of evidence (§15). حالا `null` یعنی
          | «بررسی نشد» و فقط وقتی واقعاً middleware احراز هویت روی route
          | دیده شده true/false صادر می‌شود.
          */
          authRequired: null,
        });
      }
    }

    return entries.sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method) ||
        (a.fileId ?? '').localeCompare(b.fileId ?? '')
    );
  }

  private buildMeta(projectIndex: ProjectIndex): BlueprintMeta {
    const projectName = typeof projectIndex.root === 'string' && projectIndex.root.length > 0
      ? projectIndex.root
      : 'unknown-project';

    return {
      id: this.generateBlueprintId(projectIndex),
      projectName,
      generatedAt: new Date().toISOString(),
      sourceProjectIndex: {
        generatedAt: projectIndex.generatedAt,
        schemaVersion: projectIndex.schemaVersion,
        fileCountAtSync: projectIndex.files.length,
      },
      lastSyncedCommit: this.options.gitCommit ?? 'unknown',
      driftScore: this.options.driftScore ?? 0,
      generatorVersion: this.options.generatorVersion ?? projectIndex.generatorVersion ?? '0.1.0',
    };
  }

  private generateBlueprintId(projectIndex: ProjectIndex): string {
    const input = `${projectIndex.root}:${projectIndex.generatedAt}:${projectIndex.files.length}`;
    return `bp-${sha256(input).substring(0, 12)}`;
  }

  private buildModuleMap(files: readonly FileEntry[]): ModuleEntry[] {
    this.moduleMap.clear();
    this.moduleByFileId.clear();
    const moduleFiles = new Map<string, FileEntry[]>();

    for (const file of files) {
      if (file.binary) continue;
      const modulePath = deriveModulePath(file.path);

      const list = moduleFiles.get(modulePath);
      if (list) {
        list.push(file);
      } else {
        moduleFiles.set(modulePath, [file]);
      }
    }

    const modules: ModuleEntry[] = [];
    for (const [modulePath, fileList] of moduleFiles) {
      const id = modulePathToId(modulePath);
      const name = modulePath === ROOT_MODULE_PATH
        ? 'root'
        : path.basename(modulePath) || modulePath;
      const entry: ModuleEntry = {
        id,
        name,
        path: modulePath,
        responsibility: inferResponsibility(name, fileList),
        fileIds: fileList.map(f => f.id).sort(),
      };
      modules.push(entry);
      this.moduleMap.set(modulePath, entry);
      for (const fileId of entry.fileIds) this.moduleByFileId.set(fileId, id);
    }

    return modules.sort((a, b) => a.path.localeCompare(b.path));
  }

  private buildDependencyGraph(
    projectIndex: ProjectIndex,
    modules: ModuleEntry[]
  ): BlueprintDependencyGraph {
    const nodes: GraphNode[] = [];
    const nodeIds = new Set<string>();

    // file nodes
    for (const file of projectIndex.files) {
      if (file.binary) continue;
      nodes.push({ id: file.id, kind: 'file' });
      nodeIds.add(file.id);
    }

    // module nodes
    for (const mod of modules) {
      nodes.push({ id: mod.id, kind: 'module' });
      nodeIds.add(mod.id);
    }

    const edges: GraphEdge[] = [];
    const edgeCounts = new Map<string, number>();

    for (const dep of projectIndex.graphs.dependencyGraph) {
      const fromId = dep.from;
      const toId = dep.to;
      if (!nodeIds.has(fromId)) continue;

      // اگر to یک package باشد، node نمی‌سازیم (external) ولی edge رد نمی‌کنیم؟
      // طبق schema، to باید یک node موجود باشد؛ برای package ها فعلاً skip می‌کنیم.
      if (!nodeIds.has(toId)) continue;

      const key = `${fromId}::${toId}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }

    for (const [key, weight] of edgeCounts) {
      const [from, to] = key.split('::');
      edges.push({
        from: from!,
        to: to!,
        kind: 'imports',
        weight,
      });
    }

    return { nodes, edges };
  }

  private deriveModuleDependencies(
    modules: ModuleEntry[],
    dependencyGraph: BlueprintDependencyGraph
  ): Map<string, string[]> {
    const fileIdToModuleId = new Map<string, string>();
    for (const mod of modules) {
      for (const fileId of mod.fileIds) {
        fileIdToModuleId.set(fileId, mod.id);
      }
    }

    const deps = new Map<string, Set<string>>();
    for (const edge of dependencyGraph.edges) {
      const fromMod = fileIdToModuleId.get(edge.from);
      const toMod = fileIdToModuleId.get(edge.to);
      if (!fromMod || !toMod) continue;
      if (fromMod === toMod) continue;

      const set = deps.get(fromMod) ?? new Set<string>();
      set.add(toMod);
      deps.set(fromMod, set);
    }

    const result = new Map<string, string[]>();
    for (const [modId, set] of deps) {
      result.set(modId, Array.from(set).sort());
    }
    return result;
  }

  private buildSymbolIndex(
    symbols: readonly SymbolEntry[],
    files: readonly FileEntry[]
  ): BlueprintSymbolIndexEntry[] {
    const aiScoreByFile = new Map(
      files.map(f => [f.id, f.aiMetadata?.aiScore?.importance])
    );

    return symbols.map(sym => {
      let importance = aiScoreByFile.get(sym.fileId) ?? 50;
      importance += (sym.referenceCount ?? 0) * 8;
      importance += (sym.complexity ?? 0) * 2;
      importance = Math.min(100, Math.max(0, Math.floor(importance)));

      return {
        id: sym.id,
        name: sym.name,
        kind: sym.kind,
        fileId: sym.fileId,
        line: sym.line,
        signature: sym.signature ?? null,
        importanceScore: importance,
      };
    });
  }

}
