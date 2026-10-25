/**
 * AnalysisGraph — In-memory graph model for deep impact analysis, architecture rule checks, and mutation simulation.
 */

export interface AnalysisNode {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly metadata?: { path?: string; [k: string]: unknown };
}

export interface AnalysisEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  readonly metadata?: { confidence?: number; [k: string]: unknown };
}

export class AnalysisGraph {
  private readonly nodes = new Map<string, AnalysisNode>();
  private readonly incoming = new Map<string, AnalysisEdge[]>();
  private readonly outgoing = new Map<string, AnalysisEdge[]>();

  addNode(node: AnalysisNode): void {
    this.nodes.set(node.id, node);
  }

  getNode(id: string): AnalysisNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): AnalysisNode[] {
    return Array.from(this.nodes.values());
  }

  addEdge(edge: AnalysisEdge): void {
    if (!this.nodes.has(edge.source)) {
      this.addNode({ id: edge.source, type: 'symbol', label: edge.source });
    }
    if (!this.nodes.has(edge.target)) {
      this.addNode({ id: edge.target, type: 'symbol', label: edge.target });
    }

    const outList = this.outgoing.get(edge.source) || [];
    outList.push(edge);
    this.outgoing.set(edge.source, outList);

    const inList = this.incoming.get(edge.target) || [];
    inList.push(edge);
    this.incoming.set(edge.target, inList);
  }

  getIncomingEdges(targetId: string): readonly AnalysisEdge[] {
    return this.incoming.get(targetId) || [];
  }

  getOutgoingEdges(sourceId: string): readonly AnalysisEdge[] {
    return this.outgoing.get(sourceId) || [];
  }

  getAllEdges(): AnalysisEdge[] {
    const all: AnalysisEdge[] = [];
    for (const list of this.outgoing.values()) {
      all.push(...list);
    }
    return all;
  }
}
