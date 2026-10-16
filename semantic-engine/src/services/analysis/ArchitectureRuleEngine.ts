/**
 * ArchitectureRuleEngine — Detects Architecture Layer Violations & Dependency Cycles (Tarjan SCC).
 */

import { AnalysisGraph } from './AnalysisGraph';

export interface ArchitectureViolation {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: 'error' | 'warning';
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly description: string;
  readonly suggestion: string;
}

export interface DependencyCycle {
  readonly cycleLength: number;
  readonly nodes: readonly string[];
}

export interface ArchitectureDebtReport {
  readonly totalViolations: number;
  readonly circularDependencies: readonly DependencyCycle[];
  readonly layerViolations: readonly ArchitectureViolation[];
}

export class ArchitectureRuleEngine {
  /**
   * Find circular dependencies using Tarjan's Strongly Connected Components (SCC) algorithm.
   *
   * F-0018 — iterative (explicit work stack), not recursive. The recursive
   * form overflowed Node's call stack on deep graphs (a long import chain of
   * tens of thousands of files). Semantics are identical to the recursive
   * version, including the relation filter (`imports`/`depends_on`/`calls`).
   */
  findCircularDependencies(graph: AnalysisGraph): DependencyCycle[] {
    let counter = 0;
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];

    const relations = ['imports', 'depends_on', 'calls'];
    const allNodes = graph.getAllNodes();

    for (const startNode of allNodes) {
      const start = startNode.id;
      if (indices.has(start)) continue;

      // Each frame tracks the node and how far through its neighbours it got.
      type Frame = { node: string; edgeIndex: number; neighbours: string[] };
      const work: Frame[] = [];

      const push = (nodeId: string): void => {
        indices.set(nodeId, counter);
        lowlinks.set(nodeId, counter);
        counter++;
        stack.push(nodeId);
        onStack.add(nodeId);
        const neighbours = graph
          .getOutgoingEdges(nodeId)
          .filter(edge => relations.includes(edge.relation))
          .map(edge => edge.target);
        work.push({ node: nodeId, edgeIndex: 0, neighbours });
      };

      push(start);

      while (work.length > 0) {
        const frame = work[work.length - 1]!;

        if (frame.edgeIndex < frame.neighbours.length) {
          const targetId = frame.neighbours[frame.edgeIndex]!;
          frame.edgeIndex++;

          if (!indices.has(targetId)) {
            // Recurse into the child; its lowlink is folded into this node
            // when the child frame is popped (see the pop-time propagation
            // below) — NOT here, because the child is not finalized yet.
            push(targetId);
          } else if (onStack.has(targetId)) {
            lowlinks.set(
              frame.node,
              Math.min(lowlinks.get(frame.node)!, indices.get(targetId)!)
            );
          }
          continue;
        }

        // All neighbours processed: this node is an SCC root if its lowlink
        // equals its index. Pop the component off the stack.
        if (lowlinks.get(frame.node) === indices.get(frame.node)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.node);

          if (scc.length > 1) {
            sccs.push(scc);
          }
        }

        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!;
          lowlinks.set(
            parent.node,
            Math.min(lowlinks.get(parent.node)!, lowlinks.get(frame.node)!)
          );
        }
      }
    }

    return sccs.map(nodes => ({
      cycleLength: nodes.length,
      nodes,
    }));
  }

  /**
   * Detects layered architectural rule violations.
   */
  detectLayerViolations(graph: AnalysisGraph): ArchitectureViolation[] {
    const violations: ArchitectureViolation[] = [];
    const allEdges = graph.getAllEdges();

    for (const edge of allEdges) {
      /*
      | F-0017: node ids are opaque sha256 hex in the real index (buildIndexGraph
      | stores the readable file path in metadata.path and the name in label).
      | Matching layer keywords against the id never fires — resolve the readable
      | text first. Falls back to id so hand-built graphs using readable ids (and
      | the unit tests) still match.
      */
      const describe = (id: string): string => {
        const node = graph.getNode(id);
        const path = node?.metadata?.path;
        return String(path ?? node?.label ?? id).toLowerCase();
      };
      const src = describe(edge.source);
      const tgt = describe(edge.target);

      // Rule 1: Controller bypassing Service directly to Repository/DB
      if (src.includes('controller') && (tgt.includes('repository') || tgt.includes('dao') || tgt.includes('database'))) {
        violations.push({
          ruleId: 'ARCH-001',
          ruleName: 'Layer Bypassing: Controller to Repository',
          severity: 'error',
          sourceNode: edge.source,
          targetNode: edge.target,
          description: `Controller '${edge.source}' directly invokes data repository '${edge.target}' without going through a Service.`,
          suggestion: 'Inject and route calls through an intermediary domain Service.',
        });
      }

      // Rule 2: Database / Domain layer depending on Web/UI layer
      if ((src.includes('service') || src.includes('repository') || src.includes('entity')) &&
          (tgt.includes('controller') || tgt.includes('view') || tgt.includes('ui'))) {
        violations.push({
          ruleId: 'ARCH-002',
          ruleName: 'Inverted Dependency: Domain depending on UI',
          severity: 'error',
          sourceNode: edge.source,
          targetNode: edge.target,
          description: `Core domain entity '${edge.source}' depends upwards on presentation layer '${edge.target}'.`,
          suggestion: 'Apply Inversion of Control or event-driven callbacks.',
        });
      }
    }

    return violations;
  }

  analyzeArchitectureDebt(graph: AnalysisGraph): ArchitectureDebtReport {
    const circularDependencies = this.findCircularDependencies(graph);
    const layerViolations = this.detectLayerViolations(graph);

    return {
      totalViolations: circularDependencies.length + layerViolations.length,
      circularDependencies,
      layerViolations,
    };
  }
}
