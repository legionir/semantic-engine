/**
 * GraphViewModelMapper — Maps internal models to standardized GraphNode and GraphEdge format.
 */

import { NodeType, EdgeRelation, GraphNode, GraphEdge } from '../../server/types';
import { SymbolEntry, FileEntry } from '../../core/types/project-index.types';

/*
| همان اتحادی که در server/types.ts اعلام شده: واژگانِ canonical
| (EdgeProvenance) + میراثِ visualization + یال‌های لایه‌بندی‌شده.
*/
const EDGE_BASES = new Set<GraphEdge['metadata']['basis']>([
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
const EDGE_SOURCE_KINDS = new Set<GraphEdge['metadata']['sourceKind']>([
  'compiler',
  'tree-sitter',
  'heuristic',
  'inferred',
]);

export function isGraphEdgeBasis(value: unknown): value is GraphEdge['metadata']['basis'] {
  return typeof value === 'string' && EDGE_BASES.has(value as GraphEdge['metadata']['basis']);
}

export class GraphViewModelMapper {
  static createNode(
    id: string,
    type: NodeType,
    label: string,
    metadata: GraphNode['metadata'] = {},
    parentId?: string
  ): GraphNode {
    return {
      id,
      type,
      label,
      parentId,
      metadata,
    };
  }

  static createEdge(
    id: string,
    source: string,
    target: string,
    relation: EdgeRelation,
    metadata: GraphEdge['metadata'] = {
      confidence: 100,
      basis: 'resolved',
      sourceKind: 'compiler',
    }
  ): GraphEdge {
    if (!Number.isFinite(metadata.confidence) || metadata.confidence < 0) {
      throw new Error('Graph edge confidence must be a finite non-negative number');
    }
    if (!isGraphEdgeBasis(metadata.basis)) {
      throw new Error(`Unsupported graph edge provenance basis: ${String(metadata.basis)}`);
    }
    if (!EDGE_SOURCE_KINDS.has(metadata.sourceKind)) {
      throw new Error(`Unsupported graph edge source kind: ${String(metadata.sourceKind)}`);
    }
    return {
      id,
      source,
      target,
      relation,
      metadata,
    };
  }

  static fromSymbolEntry(symbol: SymbolEntry, filePath?: string): GraphNode {
    let nodeType: NodeType = 'function';
    if (symbol.kind === 'class') nodeType = 'class';
    else if (symbol.kind === 'method') nodeType = 'method';
    else if (symbol.kind === 'interface') nodeType = 'interface';
    else if (symbol.kind === 'struct') nodeType = 'struct';
    else if (symbol.kind === 'trait') nodeType = 'trait';

    return {
      id: symbol.id,
      type: nodeType,
      label: symbol.name,
      parentId: symbol.parentId || symbol.fileId,
      metadata: {
        path: filePath,
        line: symbol.line,
        endLine: symbol.endLine,
        complexity: symbol.complexity ?? undefined,
        referencesCount: symbol.referenceCount ?? undefined,
        isEntryPoint: symbol.exported,
      },
    };
  }

  static fromFileEntry(file: FileEntry): GraphNode {
    return {
      id: file.id,
      type: 'file',
      label: file.path.split('/').pop() || file.path,
      metadata: {
        path: file.path,
        language: file.language ?? undefined,
        role: file.role,
        isEntryPoint: file.entryPoint,
      },
    };
  }
}
