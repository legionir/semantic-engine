/**
 * ReverseDependencyIndex — ساخت reverse dependency graph برای AI.
 *
 * ورودی: dependencyGraph و typeGraph موجود در ProjectIndex.
 * خروجی: reverseDependencyGraph که نشان می‌دهد هر فایل/symbol توسط چه کسانی استفاده می‌شود.
 */

import {
  Graphs,
  ReverseDependencyEdge,
  DependencyEdge,
  CallEdge,
} from '../core/types/project-index.types';

export interface ReverseDependencyIndexOptions {
  readonly includeSymbolLevel: boolean;
}

export class ReverseDependencyIndex {
  constructor(private readonly options: ReverseDependencyIndexOptions = { includeSymbolLevel: true }) {}

  build(graphs: Graphs): ReverseDependencyEdge[] {
    const edges: ReverseDependencyEdge[] = [];

    // Reverse file-level dependencies
    for (const edge of graphs.dependencyGraph) {
      const reverse = this.reverseDependencyEdge(edge);
      if (reverse) edges.push(reverse);
    }

    /*
    | SE-GRAPH-09 — این حلقه قبلاً `from: parent, to: child` می‌گذاشت،
    | یعنی دقیقاً همان جهت یال اصلی را تکرار می‌کرد. یک ایندکس معکوس
    | باید به سؤال «چه کسی *به من* وابسته است» جواب بدهد؛ برای
    | `class B extends A` جواب این است که از A به B برسیم — یعنی
    | `from: child, to: parent` در قرارداد این ایندکس، که `from`
    | همان چیزی است که به آن وابسته‌اند.
    */
    for (const edge of graphs.typeGraph) {
      edges.push({
        from: edge.child,
        to: edge.parent,
        kind: edge.kind === 'extends' ? 'extends' : 'implements',
        provenance: edge.provenance,
      });
    }

    // Reverse call relationships if symbol-level is enabled
    if (this.options.includeSymbolLevel) {
      const callReverse = this.buildCallReverseEdges(graphs.callGraph);
      edges.push(...callReverse);
    }

    return this.deduplicate(edges);
  }

  private reverseDependencyEdge(edge: DependencyEdge): ReverseDependencyEdge | null {
    if (edge.kind === 'import' || edge.kind === 'dynamic-import') {
      return {
        from: edge.to,
        to: edge.from,
        kind: 'imported-by',
        provenance: edge.provenance,
      };
    }
    // package dependencies don't have a meaningful reverse at file level
    return null;
  }

  private buildCallReverseEdges(callGraph: readonly CallEdge[]): ReverseDependencyEdge[] {
    const result: ReverseDependencyEdge[] = [];
    for (const edge of callGraph) {
      // Only reverse internal symbol-to-symbol calls
      if (edge.kind === 'external') continue;
      result.push({
        from: edge.callee,
        to: edge.caller,
        kind: 'called-by',
        provenance: edge.provenance,
      });
    }
    return result;
  }

  private deduplicate(edges: ReverseDependencyEdge[]): ReverseDependencyEdge[] {
    const seen = new Set<string>();
    return edges.filter(edge => {
      const key = `${edge.from}|${edge.to}|${edge.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
