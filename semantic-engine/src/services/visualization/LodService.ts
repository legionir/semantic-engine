/**
 * LodService — Semantic Level of Detail (LoD) Graph Extraction Engine.
 */

import { ManagedProject } from '../ProjectService';
import { SubgraphResponse, GraphNode, GraphEdge } from '../../server/types';
import { GraphViewModelMapper } from './GraphViewModelMapper';
import {
  GraphQueryEngine,
  DEFAULT_GRAPH_DEPTH,
  DEFAULT_GRAPH_MIN_CONFIDENCE,
} from '../../graphs/GraphQueryEngine';
import { edgeMetadata, summaryForGraph, GRAPH_BASES } from './lodShared';
import {
  getPathView,
  getWorkflowView,
  getBusinessMappingView,
  getTestIntelligenceView,
} from './lodAnalysisViews';

export class LodService {
  /**
   * سطح ۱: نمای کلان معماری (Architecture View).
   * کمتر از ۵۰ نود ساختاریافته شامل لایه‌ها و ماژول‌ها.
   */
  getArchitectureView(project: ManagedProject): SubgraphResponse {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const blueprint = project.blueprint?.blueprint;
    const index = project.index;

    if (!index) {
      return { level: 'architecture', nodes: [], edges: [], summary: { totalNodes: 0, totalEdges: 0, confidentRatio: 1 } };
    }

    // ── SE-VIZ-01: نگاشت fileId → moduleId ─────────────────────────────
    /*
    | نسخهٔ قبلی نودهای «ماژول/لایه» می‌ساخت اما یال‌ها را مستقیم از
    | `dependencyGraph` می‌ریخت — که `from`/`to`شان **fileId** و
    | `pkg:*` است، نه شناسهٔ ماژول. نتیجه: هر یال به نودی اشاره می‌کرد
    | که در گراف نبود، پس Visualizer نودها را کنار هم می‌ریخت و هیچ خطی
    | رسم نمی‌شد. حالا یال‌ها را به **همان نودهای معماری** جمع می‌کنیم.
    */
    const fileToModule = new Map<string, string>();
    const moduleNodeIds = new Set<string>();

    // ۱. لایه‌های معماری (اگر blueprint داشته باشد)
    const layers = blueprint?.architectureOverview?.layers ?? [];
    for (const [idx, layer] of layers.entries()) {
      const id = `layer-${idx}`;
      nodes.push(GraphViewModelMapper.createNode(id, 'module', layer.name, { role: 'layer', importance: 90 }));
    }

    // ۲. ماژول‌ها — از blueprint.moduleMap (که fileIds دارد) یا از دایرکتوری‌ها
    const modules = blueprint?.moduleMap ?? [];
    if (modules.length > 0) {
      for (const mod of modules) {
        moduleNodeIds.add(mod.id);
        nodes.push(
          GraphViewModelMapper.createNode(mod.id, 'module', mod.name, {
            path: mod.path,
            importance: 80,
          })
        );
        for (const fid of mod.fileIds ?? []) {
          fileToModule.set(fid, mod.id);
        }
      }
    } else {
      // بدون blueprint: ماژول‌ها را از دو سطح اول مسیر فایل بساز و
      // همان‌جا fileId→module را هم پر کن تا یال‌ها معتبر بمانند.
      const allFiles = project.reader?.getAllFiles() ?? [];
      const dirFor = (p: string): string => {
        const parts = p.split('/');
        return parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0] ?? p;
      };
      for (const f of allFiles) {
        const modId = `mod-${dirFor(f.path)}`;
        fileToModule.set(f.id, modId);
        if (!moduleNodeIds.has(modId)) {
          moduleNodeIds.add(modId);
          nodes.push(
            GraphViewModelMapper.createNode(modId, 'module', dirFor(f.path), {
              path: dirFor(f.path),
              importance: 75,
            })
          );
        }
      }
    }

    // ۳. روت‌های API سطح‌بالا (بدون یال — صرفاً برای context)
    const routes = blueprint?.apiMap ?? [];
    for (const route of routes.slice(0, 15)) {
      const apiNodeId = `api-${route.method}-${route.path}`;
      nodes.push(
        GraphViewModelMapper.createNode(apiNodeId, 'api', `${route.method} ${route.path}`, {
          path: route.handlerSymbolId ?? undefined,
          importance: 85,
        })
      );
    }

    // ── ۴. یال‌ها: جمع‌شده به سطح ماژول ─────────────────────────────
    const depEdges = index.graphs?.dependencyGraph ?? [];
    const seenEdges = new Set<string>();
    const pkgNodeIds = new Set<string>();
    const usedModuleIds = new Set<string>();

    const pushEdge = (
      from: string,
      to: string,
      basis: GraphEdge['metadata']['basis'],
      confidence: number
    ): void => {
      const key = `${from}->${to}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push(
        GraphViewModelMapper.createEdge(`edge-${edges.length}`, from, to, 'depends_on', {
          confidence,
          basis,
          sourceKind: 'compiler',
        })
      );
    };

    for (const dep of depEdges) {
      const fromMod = fileToModule.get(dep.from);
      if (!fromMod) continue; // from همیشه fileId است؛ اگر نگاشت نشد رد کن

      const target = String(dep.to);
      const metadata = edgeMetadata(dep.provenance);
      // Never replace invalid or missing provenance with a guessed value.
      if (!metadata) continue;

      if (target.startsWith('pkg:')) {
        // وابستگی خارجی → یک نود package بساز و وصل کن
        if (!pkgNodeIds.has(target)) {
          pkgNodeIds.add(target);
          nodes.push(
            GraphViewModelMapper.createNode(target, 'module', target.replace(/^pkg:/, ''), {
              role: 'external-package',
              importance: 40,
            })
          );
        }
        pushEdge(fromMod, target, metadata.basis, metadata.confidence);
        usedModuleIds.add(fromMod);
      } else {
        const toMod = fileToModule.get(target);
        if (!toMod || toMod === fromMod) continue; // یال داخل یک ماژول را نشان نده
        pushEdge(fromMod, toMod, metadata.basis, metadata.confidence);
        usedModuleIds.add(fromMod);
        usedModuleIds.add(toMod);
      }
    }

    /*
    | SE-VIZ-01: نودهای ماژولِ منزوی (بدون هیچ یالی) را حذف می‌کنیم تا
    | «انبوهی از نود بدون خط» پیش نیاید. لایه‌ها، APIها و package ها که
    | خودشان context یا مقصد یال‌اند نگه داشته می‌شوند.
    */
    /*
    | SE-VIZ-01 (fallback): در پروژه‌های کوچک ممکن است همهٔ فایل‌ها زیر
    | یک ماژول باشند، پس همهٔ وابستگی‌ها «درون‌ماژولی» و حذف می‌شوند و
    | گراف خالی می‌ماند. در این حالت به نمای **فایل‌محور** برمی‌گردیم.
    */
    const hasInternalEdges = edges.some(e => !String(e.target).startsWith('pkg:'));
    const hasContextNodes = nodes.some(n => n.type === 'api' || n.metadata.role === 'layer');
    if (!hasInternalEdges && !hasContextNodes) {
      return this.fileLevelDependencyView(project);
    }

    /*
    | هر نودی که هیچ یالی به آن وصل نیست حذف می‌شود تا «نودهای کنار هم
    | بدون خط» باقی نماند. استثنا: لایه‌های معماری همیشه به‌عنوان
    | برچسب ساختاری نگه داشته می‌شوند (تعدادشان کم است).
    */
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    const prunedNodes = nodes.filter(n => {
      if (n.metadata.role === 'layer' || n.type === 'api') return true;
      return connected.has(n.id);
    });

    return {
      level: 'architecture',
      nodes: prunedNodes,
      edges,
      summary: summaryForGraph(prunedNodes, edges),
    };
  }

  /**
   * نمای فایل‌محورِ وابستگی — fallback نمای معماری برای پروژه‌هایی که
   * ساختار ماژولی معناداری ندارند (SE-VIZ-01). فایل‌ها نود می‌شوند و
   * یال‌های dependencyGraph (فایل→فایل و فایل→package) مستقیماً رسم
   * می‌شوند؛ فقط فایل‌هایی که واقعاً یالی دارند نگه داشته می‌شوند تا
   * نود منزوی نماند.
   */
  /** نمای فایل‌محورِ کامل — برای تب «Dependencies & Calls». */
  getDependenciesView(project: ManagedProject): SubgraphResponse {
    return this.fileLevelDependencyView(project);
  }

  private fileLevelDependencyView(project: ManagedProject): SubgraphResponse {
    const index = project.index;
    if (!index) {
      return { level: 'file', nodes: [], edges: [], summary: { totalNodes: 0, totalEdges: 0, confidentRatio: 1 } };
    }

    const files = index.files ?? [];
    const fileById = new Map(files.map(f => [f.id, f]));

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const seenNodes = new Set<string>();
    const seenEdges = new Set<string>();

    const ensureFileNode = (fileId: string): boolean => {
      if (seenNodes.has(fileId)) return true;
      const f = fileById.get(fileId);
      if (!f) return false;
      seenNodes.add(fileId);
      nodes.push(
        GraphViewModelMapper.createNode(fileId, 'file', f.path, {
          path: f.path,
          language: f.language ?? undefined,
          importance: 60,
        })
      );
      return true;
    };

    const ensurePkgNode = (id: string): void => {
      if (seenNodes.has(id)) return;
      seenNodes.add(id);
      nodes.push(
        GraphViewModelMapper.createNode(id, 'module', id.replace(/^pkg:/, ''), {
          role: 'external-package',
          importance: 40,
        })
      );
    };

    for (const dep of index.graphs?.dependencyGraph ?? []) {
      if (!ensureFileNode(dep.from)) continue;
      const target = String(dep.to);
      const metadata = edgeMetadata(dep.provenance);
      if (!metadata) continue;

      if (target.startsWith('pkg:')) {
        ensurePkgNode(target);
      } else if (!ensureFileNode(target)) {
        continue;
      }

      const key = `${dep.from}->${target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(
        GraphViewModelMapper.createEdge(`edge-${edges.length}`, dep.from, target, 'depends_on', {
          confidence: metadata.confidence,
          basis: metadata.basis,
          sourceKind: 'compiler',
        })
      );
    }

    return {
      level: 'file',
      nodes,
      edges,
      summary: summaryForGraph(nodes, edges),
    };
  }

  /**
   * سطح ۲: نمای ماژول (Module View).
   * نمایش فایل‌ها و ارتباطات درون و بین ماژول‌ها.
   */
  getModuleView(project: ManagedProject, moduleId?: string): SubgraphResponse {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const allFiles = project.reader?.getAllFiles() ?? [];
    const selectedModule = moduleId ? project.blueprint?.getModule(moduleId) : undefined;
    const filteredFiles = selectedModule
      ? project.reader?.getFilesForIds(selectedModule.fileIds) ?? []
      : moduleId
        ? allFiles.filter(f => f.path.startsWith(moduleId.replace(/^mod-/, '')))
        : allFiles.slice(0, 60);

    for (const f of filteredFiles) {
      nodes.push(GraphViewModelMapper.fromFileEntry(f));
    }

    const fileIds = new Set(filteredFiles.map(f => f.id));
    const depEdges = project.index?.graphs?.dependencyGraph ?? [];

    for (const dep of depEdges) {
      // Only emit edges whose source is represented in this view. A local
      // target outside the selection would otherwise be dangling.
      if (!fileIds.has(dep.from)) continue;
      const target = String(dep.to);
      const metadata = edgeMetadata(dep.provenance);
      if (!metadata) continue;
      if (target.startsWith('pkg:')) {
        if (!nodes.some(node => node.id === target)) {
          nodes.push(GraphViewModelMapper.createNode(target, 'module', target.replace(/^pkg:/, ''), {
            role: 'external-package',
            importance: 40,
          }));
        }
      } else if (!fileIds.has(target)) {
        continue;
      }
      edges.push(
        GraphViewModelMapper.createEdge(
          `edge-mod-${edges.length}`,
          dep.from,
          target,
          'imports',
          { confidence: metadata.confidence, basis: metadata.basis, sourceKind: 'compiler' }
        )
      );
    }

    return {
      level: 'module',
      nodes,
      edges,
      summary: summaryForGraph(nodes, edges),
    };
  }

  /**
   * سطح ۳: نمای فایل و نمادهای داخلی (File / Symbol Explorer).
   */
  getFileView(project: ManagedProject, fileIdOrPath: string): SubgraphResponse {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const file = project.reader?.getFileById(fileIdOrPath) || project.reader?.getFileByPath(fileIdOrPath);
    if (!file) {
      return { level: 'file', nodes: [], edges: [], summary: { totalNodes: 0, totalEdges: 0, confidentRatio: 1 } };
    }

    const fileNode = GraphViewModelMapper.fromFileEntry(file);
    nodes.push(fileNode);

    const symbols = project.reader?.getSymbolsForFile(file.id) ?? [];
    for (const s of symbols) {
      const symNode = GraphViewModelMapper.fromSymbolEntry(s, file.path);
      nodes.push(symNode);

      // یال دربرگیری
      edges.push(
        GraphViewModelMapper.createEdge(
          `contains-${file.id}-${s.id}`,
          file.id,
          s.id,
          'contains',
          { confidence: 100, basis: 'resolved', sourceKind: 'compiler' }
        )
      );
    }

    return {
      level: 'file',
      nodes,
      edges,
      summary: summaryForGraph(nodes, edges),
    };
  }

  /**
   * سطح ۴: نمای همسایگی و فراخوانی نماد (Neighborhood / Focus View).
   */
  getNeighborhoodView(
    project: ManagedProject,
    seedId: string,
    depth = DEFAULT_GRAPH_DEPTH,
    minConfidence = DEFAULT_GRAPH_MIN_CONFIDENCE
  ): SubgraphResponse {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    if (!project.reader || !project.index) {
      return { level: 'neighborhood', nodes: [], edges: [], summary: { totalNodes: 0, totalEdges: 0, confidentRatio: 1 } };
    }

    const engine = new GraphQueryEngine(project.index);
    const result = engine.neighbors(seedId, {
      depth,
      minConfidence,
      direction: 'both',
      maxNodes: 50,
    });

    const nodeIds = new Set([seedId, ...result.nodes.map(n => n.id)]);
    for (const id of nodeIds) {
      const sym = project.reader.getSymbolById(id);
      if (sym) {
        const f = project.reader.getFileById(sym.fileId);
        nodes.push(GraphViewModelMapper.fromSymbolEntry(sym, f?.path));
      } else {
        const file = project.reader.getFileById(id) || project.reader.getFileByPath(id);
        if (file) {
          nodes.push(GraphViewModelMapper.fromFileEntry(file));
        } else {
          nodes.push(GraphViewModelMapper.createNode(id, 'function', id));
        }
      }
    }

    const nodeIdsForEdges = new Set(nodes.map(node => node.id));
    for (const [idx, visitedNode] of result.nodes.entries()) {
      if (!visitedNode.via) continue;
      const edge = visitedNode.via;
      if (!nodeIdsForEdges.has(edge.from) || !nodeIdsForEdges.has(edge.to)) continue;
      if (!GRAPH_BASES.has(edge.basis as GraphEdge['metadata']['basis'])) continue;
      edges.push(
        GraphViewModelMapper.createEdge(
          `edge-nh-${idx}`,
          edge.from,
          edge.to,
          edge.relation === 'calls' ? 'calls' : (edge.relation === 'types' ? 'references' : 'depends_on'),
          {
            confidence: edge.confidence,
            basis: edge.basis as GraphEdge['metadata']['basis'],
            sourceKind: 'compiler',
          }
        )
      );
    }

    return {
      level: 'neighborhood',
      nodes,
      edges,
      summary: summaryForGraph(nodes, edges),
    };
  }

  getPathView(project: ManagedProject, fromId: string, toId: string): SubgraphResponse {
    return getPathView(project, fromId, toId);
  }

  getWorkflowView(project: ManagedProject, workflowId?: string): SubgraphResponse {
    return getWorkflowView(project, workflowId);
  }

  getBusinessMappingView(project: ManagedProject): SubgraphResponse {
    return getBusinessMappingView(project);
  }

  getTestIntelligenceView(project: ManagedProject): SubgraphResponse {
    return getTestIntelligenceView(project);
  }
}
