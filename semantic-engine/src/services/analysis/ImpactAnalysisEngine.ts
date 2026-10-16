/**
 * ImpactAnalysisEngine — Multi-tiered Blast Radius & Change Risk Estimator for Platform V2.
 */

import { AnalysisGraph } from './AnalysisGraph';

export interface AffectedEntity {
  readonly id: string;
  readonly name: string;
  readonly type: 'file' | 'symbol' | 'api' | 'test';
  readonly path: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly propagationPath: readonly string[];
}

export interface ImpactAnalysisResult {
  readonly rootSymbolId: string;
  readonly riskScore: number; // 0 - 100
  readonly blastRadius: {
    readonly directDependentsCount: number;
    readonly transitiveDependentsCount: number;
    readonly affectedFilesCount: number;
    readonly affectedApisCount: number;
    readonly affectedTestsCount: number;
  };
  readonly affectedEntities: readonly AffectedEntity[];
}

export class ImpactAnalysisEngine {
  analyzeImpact(
    graph: AnalysisGraph,
    targetSymbolId: string,
    maxDepth: number = 3
  ): ImpactAnalysisResult {
    const directDependents = new Set<string>();
    const transitiveDependents = new Set<string>();
    const affectedFiles = new Set<string>();
    const affectedApis = new Set<string>();
    const affectedTests = new Set<string>();
    const affectedEntities: AffectedEntity[] = [];

    const queue: Array<{ id: string; depth: number; path: string[] }> = [
      { id: targetSymbolId, depth: 0, path: [targetSymbolId] },
    ];
    const visited = new Set<string>([targetSymbolId]);

    // Backward traversal: Find callers and dependents of the target symbol
    while (queue.length > 0) {
      const { id, depth, path: currentPath } = queue.shift()!;

      if (depth >= maxDepth) continue;

      const incoming = graph.getIncomingEdges(id);
      for (const edge of incoming) {
        if (!['calls', 'references', 'imports', 'depends_on', 'uses'].includes(edge.relation)) continue;

        const callerId = edge.source;
        const nextDepth = depth + 1;
        const nextPath = [...currentPath, callerId];

        if (!visited.has(callerId)) {
          visited.add(callerId);

          if (nextDepth === 1) {
            directDependents.add(callerId);
          } else {
            transitiveDependents.add(callerId);
          }

          const node = graph.getNode(callerId);
          const type = node ? (node.type as 'file' | 'symbol' | 'api' | 'test') : 'symbol';
          const filePath = node?.metadata?.path || '';

          if (filePath) affectedFiles.add(filePath);
          if (type === 'api' || callerId.includes('Controller') || callerId.includes('api')) {
            affectedApis.add(callerId);
          }
          if (type === 'test' || filePath.includes('.test.') || filePath.includes('.spec.')) {
            affectedTests.add(callerId);
          }

          /*
          | F-0016 — severity must be monotonic by depth for a given node
          | type. The old chain read:
          |     if (api || depth===1) sev = high
          |     if (api && depth===1) sev = critical
          |     else if (depth===2) sev = medium
          | Because the last two form one if/else-if, an **api** node at depth
          | 2 matched the `else if` and was *downgraded to medium*, while an
          | api node at depth 3 fell through to `high` — so a nearer impact
          | (d2) scored lower than a farther one (d3).
          |
          | Correct model: a base tier by depth (1→high, 2→medium, ≥3→low) and
          | an api escalation of exactly one tier. Both are non-increasing with
          | depth, so severity never rises as you move away from the change.
          */
          const SEVERITY_ORDER: readonly AffectedEntity['severity'][] = ['low', 'medium', 'high', 'critical'];
          const baseByDepth = nextDepth === 1 ? 2 : nextDepth === 2 ? 1 : 0; // index into SEVERITY_ORDER
          const rank = type === 'api' ? Math.min(baseByDepth + 1, SEVERITY_ORDER.length - 1) : baseByDepth;
          const severity = SEVERITY_ORDER[rank]!;

          affectedEntities.push({
            id: callerId,
            name: node?.label || callerId,
            type,
            path: filePath,
            severity,
            propagationPath: nextPath,
          });

          queue.push({ id: callerId, depth: nextDepth, path: nextPath });
        }
      }
    }

    // Risk Score Calculation
    const directCount = directDependents.size;
    const transitiveCount = transitiveDependents.size;
    const apiCount = affectedApis.size;
    const testCount = affectedTests.size;

    let rawScore = directCount * 12 + transitiveCount * 4 + apiCount * 20 - testCount * 3;
    if (rawScore < 0) rawScore = 0;
    const riskScore = Math.min(100, Math.max(5, Math.round(rawScore)));

    return {
      rootSymbolId: targetSymbolId,
      riskScore,
      blastRadius: {
        directDependentsCount: directCount,
        transitiveDependentsCount: transitiveCount,
        affectedFilesCount: affectedFiles.size,
        affectedApisCount: apiCount,
        affectedTestsCount: testCount,
      },
      affectedEntities,
    };
  }
}
