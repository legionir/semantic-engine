import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { Phase3SemanticGraphPilot } from './Phase3SemanticGraph';
import { ProjectIndex } from '../types/project-index.types';
import { makeConfidence } from '../types/common.types';

function index(): ProjectIndex {
  const files = [
    { id: 'a', path: 'src/math.ts', language: 'typescript', encoding: 'utf8', size: 0, lines: 2, hash: 'a', modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false },
    { id: 'b', path: 'src/use.ts', language: 'typescript', encoding: 'utf8', size: 0, lines: 4, hash: 'b', modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false },
  ];
  return { schemaVersion: '2.0.0', root: 'fixture', rootPath: '/', generatedAt: '2026-01-01T00:00:00Z', languages: ['typescript'], files, symbols: [{ id: 'add-id', fileId: 'a', parentId: null, kind: 'function', name: 'add', fullyQualifiedName: 'add', signature: 'function add(a: number, b: number): number', line: 1, endLine: 1, exported: true, source: 'typescript-api', confidence: makeConfidence(100) }], graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] }, diagnostics: [], metrics: { totalFiles: 2, totalLoc: 6, totalSymbols: 1, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 2 } } };
}

describe('Phase 3 semantic graph pilot', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase3-')); await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/math.ts'), 'export function add(a: number, b: number) { return a + b; }\n'); await fs.writeFile(path.join(root, 'src/use.ts'), "import { add } from './math';\nconst result = add(1, 2);\n"); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('resolves a unique relative import as exact with import-graph provenance', async () => {
    const graph = await new Phase3SemanticGraphPilot(new ProjectIndexReader(index()), root).build();
    expect(graph.schemaVersion).toBe('3-pilot');
    expect(graph.references).toHaveLength(1);
    expect(graph.references[0].targetSymbolId).toBe('add-id');
    expect(graph.references[0].provenance).toMatchObject({ confidence: 'exact', via: 'import-graph' });
    expect(graph.fileDeps).toEqual([{ fromFileId: 'b', toFileId: 'a', specifier: './math', resolved: true }]);
  });

  it('records unresolved imports instead of dropping them', async () => {
    await fs.writeFile(path.join(root, 'src/use.ts'), "import { missing } from './absent';\nmissing();\n");
    const graph = await new Phase3SemanticGraphPilot(new ProjectIndexReader(index()), root).build();
    expect(graph.unresolved.length).toBeGreaterThan(0);
    expect(graph.unresolved[0].provenance.confidence).toBe('unresolved');
    expect(graph.fileDeps[0].resolved).toBe(false);
  });

  it('is deterministic and snapshot-bound', async () => {
    const pilot = new Phase3SemanticGraphPilot(new ProjectIndexReader(index()), root);
    const first = await pilot.build(); const second = await pilot.build();
    expect(second).toEqual(first);
    expect(await pilot.buildIncremental(first, ['src/use.ts'])).toEqual(first);
    await fs.writeFile(path.join(root, 'src/use.ts'), "import { add } from './math';\nconst result = add(1, 2);\n// changed\n");
    const changed = await new Phase3SemanticGraphPilot(new ProjectIndexReader(index()), root).build();
    expect(changed.snapshotId).toBe(first.snapshotId); // producer index hash is unchanged; caller must refresh index before claiming parity
  });
});
