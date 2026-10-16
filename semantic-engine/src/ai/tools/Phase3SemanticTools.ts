import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { Phase3SemanticGraphPilot, ResolutionConfidence, SymbolReference, SemanticGraph } from '../../core/codeintel/Phase3SemanticGraph';
import { GraphSnapshotStore, GraphSnapshotRecord, GraphSnapshotStoreError } from '../../core/codeintel/GraphSnapshotStore';
import { Phase1IndexPlatform } from '../../core/codeintel/Phase1Platform';

const fail = (error: string): AiToolOutput => ({ success: false, error, items: [] });
const confidenceRank: Record<ResolutionConfidence, number> = { exact: 4, heuristic: 3, ambiguous: 2, unresolved: 1 };

const storeError = (error: unknown): AiToolOutput =>
  fail(error instanceof GraphSnapshotStoreError ? `SNAPSHOT_${error.kind}: ${error.message}` : `IO_ERROR: ${error instanceof Error ? error.message : String(error)}`);

/**
 * Get-or-build through the persisted store (D-0021 lifecycle, design §5):
 * the persisted snapshot is reused only when it binds to the LIVE index
 * digest and the current graph schema; otherwise a fresh graph is built,
 * published, and handed back with a durable handle.
 */
async function snapshotForStore(store: GraphSnapshotStore, reader: ProjectIndexReader, workspaceRoot: string): Promise<{ record: GraphSnapshotRecord; reused: boolean }> {
  const digest = new Phase1IndexPlatform().snapshotId(reader.projectIndex);
  const current = await store.current();
  if (current && current.meta.sourceIndexDigest === digest && current.meta.graphSchemaVersion === '3-pilot') {
    return { record: current, reused: true };
  }
  const graph = await new Phase3SemanticGraphPilot(reader, workspaceRoot).build();
  const record = await store.publish(graph, digest);
  return { record, reused: false };
}

function referencesMetadata(graph: SemanticGraph, record: GraphSnapshotRecord | undefined, reused: boolean | undefined) {
  return {
    experimental: true,
    language: 'typescript' as const,
    snapshotId: graph.snapshotId,
    unresolvedCount: graph.unresolved.length,
    fileDependencyCount: graph.fileDeps.length,
    ...(record ? { snapshotHandle: record.handle, generation: record.generation, snapshotReused: reused } : {}),
  };
}

export class SymbolReferencesTool implements AiTool {
  readonly name = 'symbol_references';
  readonly description = 'Experimental TypeScript semantic references with explicit resolution confidence, provenance, and persisted snapshot handles (D-0021 lifecycle).';
  readonly inputSchema = { type: 'object', properties: { symbolId: { type: 'string' }, symbolKey: { type: 'string' }, name: { type: 'string' }, minConfidence: { enum: ['exact', 'heuristic', 'ambiguous', 'unresolved'] }, limit: { type: 'integer', minimum: 1, maximum: 10000 }, snapshotHandle: { type: 'string', description: 'Durable handle from a previous response; resolved against the persisted store only (stale/mismatched handles fail closed).' } }, anyOf: [{ required: ['symbolId'] }, { required: ['symbolKey'] }, { required: ['name'] }] };
  constructor(private readonly reader: ProjectIndexReader, private readonly workspaceRoot?: string, private readonly store?: GraphSnapshotStore) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> {
    if (!this.workspaceRoot) return fail('DISABLED: Phase 3 workspaceRoot is not configured');
    const target = typeof input.symbolId === 'string' ? this.reader.getSymbolById(input.symbolId) : typeof input.symbolKey === 'string' ? input.symbolKey : typeof input.name === 'string' ? input.name : undefined;
    if (!target) return fail('NOT_FOUND: target symbol');
    try {
      const pilot = new Phase3SemanticGraphPilot(this.reader, this.workspaceRoot);
      if (this.store) {
        // Handle path: references to persisted state only — never a silent rebuild (D-0021).
        const resolved = input.snapshotHandle !== undefined
          ? await (async () => { if (typeof input.snapshotHandle !== 'string') return fail('SNAPSHOT_INVALID_HANDLE: snapshotHandle must be a string'); return { record: await this.store!.resolveHandle(input.snapshotHandle), reused: true }; })()
          : await snapshotForStore(this.store, this.reader, this.workspaceRoot);
        if ('success' in resolved && resolved.success === false) return resolved;
        const { record, reused } = resolved as { record: GraphSnapshotRecord; reused: boolean };
        const symbol = typeof target === 'string' ? pilot.findSymbol(target) : target;
        const references: readonly SymbolReference[] = symbol ? pilot.referencesWithin(record.graph, symbol) : [];
        const min = typeof input.minConfidence === 'string' && input.minConfidence in confidenceRank ? input.minConfidence as ResolutionConfidence : 'unresolved';
        const limit = typeof input.limit === 'number' ? input.limit : 1000;
        /*
        | SE-AI-HONESTY (P-06) — دو علتِ متفاوت برای «کمتر از همه» یکی
        | نبودنِ نتیجه: (۱) فیلترِ minConfidence و (۲) برشِ limit.
        | محاسبهٔ قبلی `references.length > selected.length` این دو را
        | قاطی می‌کرد: اگر فیلتر نصفِ رفرنس‌ها را حذف می‌کرد ولی برشی
        | رخ نمی‌داد، باز هم `truncated: true` گزارش می‌شد — یعنی ابزار
        | ادعای برش می‌کرد آنجا که برشی نبود. حالا هر دو جدا اعلام
        | می‌شوند و AI می‌فهمد باید سقف را بالا ببرد یا اطمینان را پایین.
        */
        const confidenceFiltered = references.filter(r => confidenceRank[r.provenance.confidence] >= confidenceRank[min]);
        const selected = confidenceFiltered.slice(0, limit);
        return {
          success: true,
          items: selected.map(r => ({ id: r.id, name: r.targetSymbolKey, kind: 'symbol_reference', path: r.sourcePath, line: r.line, source: 'phase3-semantic-graph', excerpt: r.text, metadata: { start: r.start, end: r.end, targetSymbolId: r.targetSymbolId, targetSymbolKey: r.targetSymbolKey, confidence: r.provenance.confidence, via: r.provenance.via, candidates: r.provenance.candidates, snapshotId: record.graph.snapshotId } })),
          metadata: { ...referencesMetadata(record.graph, record, reused), referenceCount: selected.length, totalReferenceCount: references.length, aboveMinConfidence: confidenceFiltered.length, truncated: confidenceFiltered.length > selected.length, droppedByConfidence: references.length - confidenceFiltered.length, limit, trust: 'untrusted-source-content' },
        };
      }
      const result = await pilot.referencesFor(target);
      const min = typeof input.minConfidence === 'string' && input.minConfidence in confidenceRank ? input.minConfidence as ResolutionConfidence : 'unresolved';
      const limit = typeof input.limit === 'number' ? input.limit : 1000;
      const confidenceFiltered = result.references.filter(r => confidenceRank[r.provenance.confidence] >= confidenceRank[min]);
      const selected = confidenceFiltered.slice(0, limit);
      return { success: true, items: selected.map(r => ({ id: r.id, name: r.targetSymbolKey, kind: 'symbol_reference', path: r.sourcePath, line: r.line, source: 'phase3-semantic-graph', excerpt: r.text, metadata: { start: r.start, end: r.end, targetSymbolId: r.targetSymbolId, targetSymbolKey: r.targetSymbolKey, confidence: r.provenance.confidence, via: r.provenance.via, candidates: r.provenance.candidates, snapshotId: result.graph.snapshotId } })), metadata: { ...referencesMetadata(result.graph, undefined, undefined), referenceCount: selected.length, totalReferenceCount: result.references.length, aboveMinConfidence: confidenceFiltered.length, truncated: confidenceFiltered.length > selected.length, droppedByConfidence: result.references.length - confidenceFiltered.length, limit, trust: 'untrusted-source-content' } };
    } catch (error) {
      if (error instanceof GraphSnapshotStoreError) return storeError(error);
      return fail(`IO_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class SemanticGraphInspectTool implements AiTool {
  readonly name = 'semantic_graph_inspect';
  readonly description = 'Experimental bounded semantic graph diagnostics for the TypeScript pilot, with persisted snapshot handles (D-0021 lifecycle).';
  readonly inputSchema = { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10000 }, snapshotHandle: { type: 'string', description: 'Durable handle from a previous response; resolved against the persisted store only (stale/mismatched handles fail closed).' } } };
  constructor(private readonly reader: ProjectIndexReader, private readonly workspaceRoot?: string, private readonly store?: GraphSnapshotStore) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> {
    if (!this.workspaceRoot) return fail('DISABLED: Phase 3 workspaceRoot is not configured');
    try {
      if (this.store) {
        const resolved = input.snapshotHandle !== undefined
          ? await (async () => { if (typeof input.snapshotHandle !== 'string') return fail('SNAPSHOT_INVALID_HANDLE: snapshotHandle must be a string'); return { record: await this.store!.resolveHandle(input.snapshotHandle), reused: true }; })()
          : await snapshotForStore(this.store, this.reader, this.workspaceRoot);
        if ('success' in resolved && resolved.success === false) return resolved;
        const { record, reused } = resolved as { record: GraphSnapshotRecord; reused: boolean };
        const limit = typeof input.limit === 'number' ? input.limit : 1000;
        const items = record.graph.fileDeps.slice(0, limit).map((d, i) => ({ id: `${d.fromFileId}:${d.specifier}`, name: d.specifier, kind: d.resolved ? 'file_dependency' : 'unresolved_dependency', source: 'phase3-semantic-graph', metadata: { fromFileId: d.fromFileId, toFileId: d.toFileId, resolved: d.resolved, snapshotId: record.graph.snapshotId, ordinal: i } }));
        return { success: true, items, metadata: { ...referencesMetadata(record.graph, record, reused), referenceCount: record.graph.references.length, trust: 'untrusted-source-content' } };
      }
      const graph = await new Phase3SemanticGraphPilot(this.reader, this.workspaceRoot).build();
      const limit = typeof input.limit === 'number' ? input.limit : 1000;
      const items = graph.fileDeps.slice(0, limit).map((d, i) => ({ id: `${d.fromFileId}:${d.specifier}`, name: d.specifier, kind: d.resolved ? 'file_dependency' : 'unresolved_dependency', source: 'phase3-semantic-graph', metadata: { fromFileId: d.fromFileId, toFileId: d.toFileId, resolved: d.resolved, snapshotId: graph.snapshotId, ordinal: i } }));
      return { success: true, items, metadata: { ...referencesMetadata(graph, undefined, undefined), referenceCount: graph.references.length, trust: 'untrusted-source-content' } };
    } catch (error) {
      if (error instanceof GraphSnapshotStoreError) return storeError(error);
      return fail(`IO_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
