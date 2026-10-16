/**
 * Helpers shared by the LOD view builders: the canonical edge-basis
 * vocabulary, provenance -> edge metadata, and graph summaries.
 */

import { SubgraphResponse, GraphNode, GraphEdge } from '../../server/types';
import { DEFAULT_GRAPH_MIN_CONFIDENCE } from '../../graphs/GraphQueryEngine';

/*
| این مجموعه قبلاً زیرمجموعهٔ کهنه‌ای از واژگانِ basis بود و
| یال‌های واقعیِ ایندکس — مثلاً basis:'import-resolved' ساختهٔ
| pipeline — را رد می‌کرد؛ نتیجه معماریِ خالی و fallback به نمای
| فایل بود. حالا با واژگانِ canonical لایهٔ گراف هم‌تراز است.
*/
export const GRAPH_BASES = new Set<GraphEdge['metadata']['basis']>([
  'resolved',
  'ast',
  'import-resolved',
  'declared',
  'unresolved',
  'name-match',
  'transitive',
  'blueprint',
  'index',
]);

export function edgeMetadata(provenance: unknown):
  | { confidence: number; basis: GraphEdge['metadata']['basis'] }
  | undefined {
  if (!provenance || typeof provenance !== 'object') return undefined;
  const value = provenance as { confidence?: unknown; basis?: unknown };
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) return undefined;
  if (typeof value.basis !== 'string' || !GRAPH_BASES.has(value.basis as GraphEdge['metadata']['basis'])) {
    return undefined;
  }
  return {
    confidence: value.confidence,
    basis: value.basis as GraphEdge['metadata']['basis'],
  };
}

export function summaryForGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): SubgraphResponse['summary'] {
  const confident = edges.filter(e => e.metadata.confidence >= DEFAULT_GRAPH_MIN_CONFIDENCE).length;
  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    confidentRatio: edges.length > 0 ? confident / edges.length : 1,
  };
}
