/**
 * MutationSimulator — In-memory virtual refactoring and graph diffing simulator.
 */

import { AnalysisGraph } from './AnalysisGraph';

export interface MutationAction {
  readonly type: 'rename_symbol' | 'delete_symbol' | 'move_symbol';
  readonly targetSymbolId: string;
  readonly newName?: string;
  readonly newPath?: string;
}

export interface BrokenReference {
  readonly callerId: string;
  readonly callerFile: string;
  readonly callerLabel: string;
  readonly callerLine?: number | null;
  readonly targetId: string;
  readonly relation: string;
}

export interface MutationDiffResult {
  readonly action: MutationAction;
  readonly affectedSymbolsCount: number;
  readonly brokenReferences: readonly BrokenReference[];
  readonly addedEdgesCount: number;
  readonly removedEdgesCount: number;
  readonly isSafe: boolean;
}

export class MutationSimulator {
  simulate(graph: AnalysisGraph, action: MutationAction): MutationDiffResult {
    if (
      action.type === 'move_symbol' &&
      (typeof action.newPath !== 'string' || action.newPath.trim().length === 0)
    ) {
      throw new Error('newPath is required for move_symbol');
    }

    const brokenReferences: BrokenReference[] = [];
    let removedEdgesCount = 0;
    const incoming = graph.getIncomingEdges(action.targetSymbolId);
    const recordBrokenReference = (edge: ReturnType<AnalysisGraph['getIncomingEdges']>[number]) => {
      const callerNode = graph.getNode(edge.source);
      brokenReferences.push({
        callerId: edge.source,
        callerFile: callerNode?.metadata?.path || 'unknown',
        callerLabel: callerNode ? (callerNode.metadata?.path ?? callerNode.label) : edge.source,
        callerLine: typeof edge.metadata?.line === 'number' ? edge.metadata.line : null,
        targetId: action.targetSymbolId,
        relation: edge.relation,
      });
    };

    if (action.type === 'delete_symbol') {
      for (const edge of incoming) {
        removedEdgesCount++;
        recordBrokenReference(edge);
      }
    } else if (action.type === 'rename_symbol') {
      // Keep rename semantics unchanged: only symbol-level references are
      // broken; a file import itself does not change when a symbol is renamed.
      for (const edge of incoming) {
        if (edge.relation === 'calls' || edge.relation === 'references' || edge.relation === 'imports') {
          recordBrokenReference(edge);
        }
      }
    } else {
      /*
       * A move changes the file/qualified path, not merely the symbol name.
       * The graph stores symbol callers on the symbol node, while imports are
       * file-to-file edges. Include both sets without mutating the source
       * graph: the new path is the virtual target path used by this diff.
       */
      const targetNode = graph.getNode(action.targetSymbolId);
      const currentPath = targetNode?.metadata?.path;
      const newPath = action.newPath!.trim();

      // Moving to the path the graph already has is a no-op. This is the
      // important distinction from rename/delete and avoids false positives.
      if (currentPath !== newPath) {
        const affectedEdges = [...incoming];

        // Dependency edges point at the containing file, not at the symbol.
        // Find that file by its graph metadata rather than assuming that a
        // symbol id and a file id share a shape.
        if (currentPath) {
          const movedFileIds = graph
            .getAllNodes()
            .filter(node => node.type === 'file' && node.metadata?.path === currentPath)
            .map(node => node.id);
          for (const fileId of movedFileIds) {
            affectedEdges.push(...graph.getIncomingEdges(fileId));
          }
        }

        // A graph should not contain duplicate edge ids, but de-duplicate here
        // because a caller may provide both a symbol edge and a file edge for
        // the same logical reference.
        const seen = new Set<string>();
        for (const edge of affectedEdges) {
          if (seen.has(edge.id)) continue;
          seen.add(edge.id);
          recordBrokenReference(edge);
        }
      }
    }

    return {
      action,
      // For moves this includes affected file-import edges as well as direct
      // symbol edges; for rename/delete retain the established semantics.
      affectedSymbolsCount: action.type === 'move_symbol'
        ? brokenReferences.length
        : incoming.length,
      brokenReferences,
      addedEdgesCount: 0,
      removedEdgesCount,
      isSafe: brokenReferences.length === 0,
    };
  }
}
