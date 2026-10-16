import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SemanticEngineMcpServer } from './SemanticEngineMcpServer';
import { SymbolReferencesTool } from '../tools/Phase3SemanticTools';
import { GraphSnapshotStore } from '../../core/codeintel/GraphSnapshotStore';
import { Phase3SemanticGraphPilot } from '../../core/codeintel/Phase3SemanticGraph';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { ProjectIndex, SymbolEntry } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';

/*
 * D-0021 criterion 7: the persisted-snapshot lifecycle scenarios run identically
 * through the MCP surface (tools/call) and the direct tool API, across restarts.
 * Criteria 1–6, 8–10 are executed in src/core/codeintel/GraphSnapshotStore.test.ts.
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
    schemaVersion: '2.0.0', root: 'mcp-store-fixture', rootPath: '/', generatedAt: '2026-01-01T00:00:00Z', languages: ['typescript'],
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

function payload(result: { content: unknown }): any {
  const text = (result.content as { text: string }[])[0].text;
  return JSON.parse(text);
}

describe('Phase 3 persisted snapshot lifecycle over MCP (D-0021 criterion 7)', () => {
  it('serves, reuses across restart, resolves durable handles, and fails closed on stale/mismatched handles — with direct-API parity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-store-mcp-'));
    const index = indexFor(FILES_V1);
    try {
      await writeWorkspace(root, FILES_V1);

      // First MCP call publishes a snapshot and returns a durable handle.
      const server1 = new SemanticEngineMcpServer({ projectIndex: index, workspaceRoot: root, experimental: { 'semantic-graph': true } });
      const first = await server1.callTool('symbol_references', { symbolId: 's-add' });
      expect(first.isError).toBe(false);
      const firstPayload = payload(first);
      expect(firstPayload.success).toBe(true);
      expect(firstPayload.items.length).toBeGreaterThan(0);
      expect(firstPayload.metadata.snapshotReused).toBe(false);
      const handle = firstPayload.metadata.snapshotHandle as string;
      expect(handle).toMatch(/^gen-000001@[0-9a-f]{12}$/u);
      await server1.close?.();

      // Restart: a brand-new server instance reuses the persisted snapshot (no rebuild).
      const server2 = new SemanticEngineMcpServer({ projectIndex: index, workspaceRoot: root, experimental: { 'semantic-graph': true } });
      const second = payload(await server2.callTool('symbol_references', { symbolId: 's-add' }));
      expect(second.success).toBe(true);
      expect(second.metadata.snapshotReused).toBe(true);
      expect(second.metadata.snapshotHandle).toBe(handle);
      expect(second.items).toEqual(firstPayload.items);

      // Durable handle across restart, over tools/call.
      const byHandle = payload(await server2.callTool('symbol_references', { symbolId: 's-add', snapshotHandle: handle }));
      expect(byHandle.success).toBe(true);
      expect(byHandle.items).toEqual(firstPayload.items);
      expect(byHandle.metadata.snapshotHandle).toBe(handle);

      // Parity: the same handle through the direct tool API returns identical items.
      const storeDir = path.join(root, '.semantic-engine', 'graph-snapshots');
      const direct = await new SymbolReferencesTool(new ProjectIndexReader(index), root, new GraphSnapshotStore(storeDir)).execute({ symbolId: 's-add', snapshotHandle: handle });
      expect(direct.success).toBe(true);
      expect(direct.items).toEqual(firstPayload.items);

      // Stale handle: publish a new generation, keep only it, then the old handle fails closed.
      await writeWorkspace(root, FILES_V2);
      const graphV2 = await new Phase3SemanticGraphPilot(new ProjectIndexReader(indexFor(FILES_V2)), root).build();
      await new GraphSnapshotStore(storeDir).publish(graphV2, `d-${graphV2.snapshotId.slice(0, 8)}`, '0.1.0', { keep: 1 });
      const stale = await server2.callTool('symbol_references', { symbolId: 's-add', snapshotHandle: handle });
      expect(stale.isError).toBe(true);
      expect(payload(stale).error).toContain('SNAPSHOT_STALE_HANDLE');

      // Mismatched handle (existing generation, wrong id suffix) fails closed too.
      const mismatch = await server2.callTool('symbol_references', { symbolId: 's-add', snapshotHandle: 'gen-000002@000000000000' });
      expect(mismatch.isError).toBe(true);
      expect(payload(mismatch).error).toContain('SNAPSHOT_MISMATCH');

      // The server's own index is unchanged (V1), so the next call must rebuild and
      // publish rather than serve the V2 snapshot (digest binding, no stale reuse).
      const rebuilt = payload(await server2.callTool('symbol_references', { symbolId: 's-add' }));
      expect(rebuilt.success).toBe(true);
      expect(rebuilt.metadata.snapshotReused).toBe(false);
      expect(rebuilt.metadata.snapshotHandle).not.toBe(handle);
      expect(rebuilt.items).toEqual(firstPayload.items);
      await server2.close?.();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
