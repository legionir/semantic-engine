import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { Phase3SemanticGraphPilot, SemanticGraph } from './Phase3SemanticGraph';
import { GraphSnapshotStore, GraphSnapshotStoreError, GRAPH_STORE_SCHEMA_VERSION } from './GraphSnapshotStore';
import { ProjectIndex, SymbolEntry } from '../types/project-index.types';
import { makeConfidence } from '../types/common.types';

/*
 * D-0021 executed-test criteria for the persisted graph snapshot store
 * (docs/validation/phase3-store/graph-store-design.md §6).
 *
 *  1 restart save/restore          6 incremental == full after restart
 *  2 durable handles               8 schema migration/versioning
 *  3 stale/mismatch fail-closed    9 safe old-generation cleanup
 *  4 kill-during-publication      10 no silent partial serve
 *  5 atomic/generation-dir publication
 *
 * Criterion 7 (same scenarios via MCP/Gateway) is executed in
 * src/ai/mcp/GraphSnapshotMcp.test.ts.
 */

const FILES_V1: Record<string, string> = {
  'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
  'src/use.ts': "import { add } from './math';\nexport const total = add(1, 2);\n",
};
const FILES_V2: Record<string, string> = {
  ...FILES_V1,
  'src/extra.ts': "import { add } from './math';\nexport const extra = add(7, 8);\n",
};

function symbol(id: string, fileId: string, kind: SymbolEntry['kind'], name: string, line: number, endLine: number): SymbolEntry {
  return { id, fileId, parentId: null, kind, name, fullyQualifiedName: name, line, endLine, exported: true, source: 'typescript-api', confidence: makeConfidence(100) };
}

function indexFor(files: Record<string, string>): ProjectIndex {
  const fileIds: Record<string, string> = {};
  const entries = Object.keys(files).map((p) => {
    const id = `f-${path.basename(p, '.ts')}`;
    fileIds[p] = id;
    return { id, path: p, language: 'typescript', encoding: 'utf8', size: files[p].length, lines: files[p].split('\n').length - 1, hash: `h-${id}-${files[p].length}`, modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false };
  });
  const symbols = [
    symbol('s-add', fileIds['src/math.ts'], 'function', 'add', 1, 3),
    symbol('s-total', fileIds['src/use.ts'], 'variable', 'total', 2, 2),
    ...(files['src/extra.ts'] ? [symbol('s-extra', fileIds['src/extra.ts'], 'variable', 'extra', 2, 2)] : []),
  ];
  return {
    schemaVersion: '2.0.0', root: 'store-fixture', rootPath: '/', generatedAt: '2026-01-01T00:00:00Z', languages: ['typescript'],
    files: entries, symbols,
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] }, diagnostics: [],
    metrics: { totalFiles: entries.length, totalLoc: 6, totalSymbols: symbols.length, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: entries.length } },
  };
}

async function writeWorkspace(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
}

async function buildGraph(root: string, files: Record<string, string>): Promise<SemanticGraph> {
  await writeWorkspace(root, files);
  return new Phase3SemanticGraphPilot(new ProjectIndexReader(indexFor(files)), root).build();
}

async function tmpStore(): Promise<{ root: string; storeRoot: string; store: GraphSnapshotStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-store-'));
  const storeRoot = path.join(root, 'store');
  return { root, storeRoot, store: new GraphSnapshotStore(storeRoot) };
}

const expectStoreError = async (promise: Promise<unknown>, kind: string): Promise<GraphSnapshotStoreError> => {
  await expect(promise).rejects.toMatchObject({ name: 'GraphSnapshotStoreError', kind });
  try { await promise; } catch (error) { return error as GraphSnapshotStoreError; }
  throw new Error('unreachable');
};

describe('GraphSnapshotStore — D-0021 executed criteria', () => {
  it('1+2: restart save/restore and durable handles (new store instance serves the same graph)', async () => {
    const { root, storeRoot, store } = await tmpStore();
    try {
      const graph = await buildGraph(root, FILES_V1);
      const published = await store.publish(graph, `digest-${graph.snapshotId.slice(0, 8)}`);
      // Restart: a brand-new store instance over the same directory.
      const reopened = new GraphSnapshotStore(storeRoot);
      const current = await reopened.current();
      expect(current).not.toBeNull();
      expect(current!.graph).toEqual(graph);
      expect(current!.meta.graphSnapshotId).toBe(graph.snapshotId);
      expect(current!.handle).toBe(published.handle);
      expect(current!.handle).toMatch(/^gen-000001@[0-9a-f]{12}$/u);
      // Durable handle: resolves after restart to the identical graph.
      const byHandle = await reopened.resolveHandle(published.handle);
      expect(byHandle.graph).toEqual(graph);
      expect(byHandle.generation).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('3: stale, mismatched and malformed handles fail closed — never a fallback to current', async () => {
    const { root, storeRoot, store } = await tmpStore();
    try {
      const g1 = await buildGraph(root, FILES_V1);
      await store.publish(g1, 'd1', '0.1.0', { keep: 10 });
      const g2 = await buildGraph(root, FILES_V2);
      const second = await store.publish(g2, 'd2', '0.1.0', { keep: 10 });
      await store.cleanup(1); // keeps only generation 2
      await expectStoreError(store.resolveHandle('gen-000001@' + g1.snapshotId.slice(0, 12)), 'STALE_HANDLE');
      await expectStoreError(store.resolveHandle('gen-000002@000000000000'), 'SNAPSHOT_MISMATCH');
      await expectStoreError(store.resolveHandle('not-a-handle'), 'INVALID_HANDLE');
      // current() is untouched by failed resolutions — no silent fallback ever served.
      const current = await store.current();
      expect(current!.handle).toBe(second.handle);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('4: kill-during-publication recovery — pointer never torn, next publish succeeds, tmp swept', async () => {
    const { root, storeRoot, store } = await tmpStore();
    try {
      const g1 = await buildGraph(root, FILES_V1);
      const first = await store.publish(g1, 'd1');
      const g2 = await buildGraph(root, FILES_V2);
      // Crash AFTER the generation dir was renamed but BEFORE the pointer swap.
      await expectStoreError(store.publish(g2, 'd2', '0.1.0', { crashAt: 'before-pointer-swap' }), 'IO_ERROR');
      const afterCrash = await store.current();
      expect(afterCrash!.handle).toBe(first.handle); // previous COMPLETE generation still current
      expect(afterCrash!.graph).toEqual(g1);
      expect(await store.listGenerations()).toEqual([1, 2]); // orphan generation 2 is complete but unreferenced
      // Crash BEFORE the generation rename: only a tmp dir exists.
      await expectStoreError(store.publish(g1, 'd1', '0.1.0', { crashAt: 'before-generation-rename' }), 'IO_ERROR');
      expect((await store.current())!.handle).toBe(first.handle);
      // Next successful publish sweeps tmp dirs and takes the next free ordinal.
      const third = await store.publish(g2, 'd2', '0.1.0', { keep: 10 });
      expect(third.generation).toBe(3);
      expect(await store.listGenerations()).toEqual([1, 2, 3]);
      const entries = await fs.readdir(path.join(storeRoot, 'generations'));
      expect(entries.filter(name => name.startsWith('.tmp-publish-'))).toHaveLength(0);
      const current = await store.current();
      expect(current!.handle).toBe(third.handle);
      expect(current!.graph).toEqual(g2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('5: atomic generation-directory publication layout', async () => {
    const { root, storeRoot, store } = await tmpStore();
    try {
      const graph = await buildGraph(root, FILES_V1);
      const record = await store.publish(graph, 'digest-x');
      const genDir = path.join(storeRoot, 'generations', 'gen-000001');
      const meta = JSON.parse(await fs.readFile(path.join(genDir, 'meta.json'), 'utf8'));
      expect(meta.storeSchemaVersion).toBe(GRAPH_STORE_SCHEMA_VERSION);
      expect(meta.counts).toEqual({
        references: graph.references.length, unresolved: graph.unresolved.length,
        hardBindings: graph.hardBindings.length, occurrenceAudit: graph.occurrenceAudit.length,
        fileDeps: graph.fileDeps.length,
      });
      const pointer = JSON.parse(await fs.readFile(path.join(storeRoot, 'current.json'), 'utf8'));
      expect(pointer).toMatchObject({ generation: 1, handle: record.handle, graphSnapshotId: graph.snapshotId });
      const entries = await fs.readdir(path.join(storeRoot, 'generations'));
      expect(entries.filter(name => name.startsWith('.tmp'))).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('6: persisted snapshot equals a fresh full rebuild — same input, and after the input changes', async () => {
    const { root, storeRoot, store } = await tmpStore();
    try {
      const g1 = await buildGraph(root, FILES_V1);
      await store.publish(g1, `d-${g1.snapshotId.slice(0, 8)}`);
      const reopened = new GraphSnapshotStore(storeRoot);
      // After "restart" the persisted snapshot is deep-equal to a fresh full build.
      expect((await reopened.current())!.graph).toEqual(await buildGraph(root, FILES_V1));
      // Changed input → rebuild + publish; the new persisted snapshot equals the new full build.
      const g2 = await buildGraph(root, FILES_V2);
      const second = await store.publish(g2, `d-${g2.snapshotId.slice(0, 8)}`);
      const reopened2 = new GraphSnapshotStore(storeRoot);
      expect((await reopened2.current())!.graph).toEqual(await buildGraph(root, FILES_V2));
      expect((await reopened2.current())!.handle).toBe(second.handle);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('8: schema migration/versioning — v0 migrates and revalidates, future rejects fail-closed', async () => {
    const { root, storeRoot } = await tmpStore();
    try {
      const graph = await buildGraph(root, FILES_V1);
      const genDir = path.join(storeRoot, 'generations', 'gen-000001');
      await fs.mkdir(genDir, { recursive: true });
      // store schema 0 record: no engineVersion, no counts, graph predates occurrenceAudit.
      const legacyGraph = { ...graph, occurrenceAudit: undefined } as unknown as Record<string, unknown>;
      delete legacyGraph.occurrenceAudit;
      await fs.writeFile(path.join(genDir, 'meta.json'), JSON.stringify({
        storeSchemaVersion: 0, graphSchemaVersion: '3-pilot', graphSnapshotId: graph.snapshotId, sourceIndexDigest: 'legacy', createdAt: '2026-01-01T00:00:00Z',
      }));
      await fs.writeFile(path.join(genDir, 'graph.json'), JSON.stringify(legacyGraph));
      await fs.writeFile(path.join(storeRoot, 'current.json'), JSON.stringify({
        storeSchemaVersion: 0, generation: 1, handle: `gen-000001@${graph.snapshotId.slice(0, 12)}`, graphSnapshotId: graph.snapshotId,
      }));
      const store = new GraphSnapshotStore(storeRoot);
      const migrated = await store.current();
      expect(migrated!.meta.storeSchemaVersion).toBe(GRAPH_STORE_SCHEMA_VERSION);
      expect(migrated!.meta.engineVersion).toBe('pre-store');
      expect(migrated!.graph.occurrenceAudit).toEqual([]);
      expect(migrated!.graph.references).toEqual(graph.references);

      // Future schema: refused, never guessed.
      const futureDir = path.join(storeRoot, 'generations', 'gen-000002');
      await fs.mkdir(futureDir, { recursive: true });
      await fs.writeFile(path.join(futureDir, 'meta.json'), JSON.stringify({ ...migrated!.meta, storeSchemaVersion: GRAPH_STORE_SCHEMA_VERSION + 1 }));
      await fs.writeFile(path.join(futureDir, 'graph.json'), JSON.stringify(graph));
      await fs.writeFile(path.join(storeRoot, 'current.json'), JSON.stringify({
        storeSchemaVersion: GRAPH_STORE_SCHEMA_VERSION + 1, generation: 2, handle: `gen-000002@${graph.snapshotId.slice(0, 12)}`, graphSnapshotId: graph.snapshotId,
      }));
      await expectStoreError(store.current(), 'FUTURE_SCHEMA');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('9: safe old-generation cleanup — keeps the pointer target, idempotent, deleted handles go stale', async () => {
    const { root, storeRoot, store } = await tmpStore();
    try {
      const graph = await buildGraph(root, FILES_V1);
      await store.publish(graph, 'd1', '0.1.0', { keep: 10 });
      await store.publish(graph, 'd2', '0.1.0', { keep: 10 });
      await store.publish(graph, 'd3', '0.1.0', { keep: 10 });
      const fourth = await store.publish(graph, 'd4', '0.1.0', { keep: 10 });
      expect(await store.listGenerations()).toEqual([1, 2, 3, 4]);
      await store.cleanup(2);
      expect(await store.listGenerations()).toEqual([3, 4]);
      const current = await store.current();
      expect(current!.handle).toBe(fourth.handle); // pointer target survived
      await store.cleanup(2); // idempotent
      expect(await store.listGenerations()).toEqual([3, 4]);
      await expectStoreError(store.resolveHandle('gen-000001@' + graph.snapshotId.slice(0, 12)), 'STALE_HANDLE');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('10: no silent partial serve — fresh store is null, torn states are hard errors', async () => {
    const { root, storeRoot, store } = await tmpStore();
    try {
      expect(await store.current()).toBeNull(); // fresh store: no pointer, no guess
      const graph = await buildGraph(root, FILES_V1);
      await store.publish(graph, 'd1');
      // Pointer naming a missing generation.
      await fs.writeFile(path.join(storeRoot, 'current.json'), JSON.stringify({
        storeSchemaVersion: 1, generation: 9, handle: 'gen-000009@deadbeefdead', graphSnapshotId: graph.snapshotId,
      }));
      await expectStoreError(store.current(), 'CORRUPT_STATE');
      // Incomplete generation (meta without graph).
      await store.publish(graph, 'd2', '0.1.0', { keep: 10 });
      await fs.rm(path.join(storeRoot, 'generations', 'gen-000002', 'graph.json'));
      await expectStoreError(store.current(), 'CORRUPT_STATE');
      // A record whose counts no longer match the arrays (edited/torn) is rejected.
      await store.publish(graph, 'd3', '0.1.0', { keep: 10 });
      const metaPath = path.join(storeRoot, 'generations', 'gen-000003', 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      meta.counts.references += 1;
      await fs.writeFile(metaPath, JSON.stringify(meta));
      await expectStoreError(store.current(), 'CORRUPT_STATE');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
