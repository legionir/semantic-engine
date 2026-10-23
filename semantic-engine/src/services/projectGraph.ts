/**
 * Analysis graph of a managed project (split from ProjectService.ts, behavior unchanged).
 */

import { AnalysisGraph } from './analysis/AnalysisGraph';
import type { ManagedProject } from './ProjectService';
import type { ProjectRecord } from '../core/config/ProjectRegistry';
import { isSafeProjectId } from '../core/config/ProjectIdentity';

export function buildProjectGraph(project: ManagedProject | undefined): AnalysisGraph {
  const graph = new AnalysisGraph();
  if (!project || !project.index) return graph;

  // Add symbols as nodes
  if (project.index.symbols) {
    for (const s of project.index.symbols) {
      const f = project.reader?.getFileById(s.fileId);
      graph.addNode({
        id: s.id,
        type: s.kind || 'symbol',
        label: s.name,
        metadata: { path: f?.path, line: s.line },
      });
    }
  }

  // Add dependency graph edges
  if (project.index.graphs?.dependencyGraph) {
    for (const [idx, dep] of project.index.graphs.dependencyGraph.entries()) {
      graph.addEdge({
        id: `dep_${idx}`,
        source: dep.from,
        target: dep.to,
        relation: 'depends_on',
        metadata: { confidence: dep.provenance?.confidence },
      });
    }
  }

  // Add call graph edges
  if (project.index.graphs?.callGraph) {
    for (const [idx, cg] of project.index.graphs.callGraph.entries()) {
      graph.addEdge({
        id: `call_${idx}`,
        source: cg.caller,
        target: cg.callee,
        relation: 'calls',
        metadata: { confidence: cg.provenance?.confidence },
      });
    }
  }

  return graph;
}

export function mergeAliases(
  previous: ManagedProject | undefined,
  record: ProjectRecord | undefined,
  id: string,
  requestedId: string
): string[] {
  const aliases = new Set<string>([id]);
  if (previous) {
    aliases.add(previous.id);
    for (const alias of previous.aliases) aliases.add(alias);
  }
  if (record) {
    aliases.add(record.id);
    for (const alias of record.aliases) aliases.add(alias);
  }
  if (requestedId !== '' && isSafeProjectId(requestedId)) aliases.add(requestedId);
  return [...aliases];
}
