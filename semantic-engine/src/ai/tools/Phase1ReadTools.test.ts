import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { ProjectIndex } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';
import { CodeFoldTool, CodeReadTool, DiagnosticsGetTool, ProjectInfoTool, ProjectListFilesTool, SearchTextTool, SymbolInspectTool, GainsReportTool, CodeOutlineTool, SymbolFindTool } from './Phase1ReadTools';

function index(rootPath: string): ProjectIndex {
  return {
    schemaVersion: '2.0.0', root: 'fixture', rootPath, generatedAt: '2026-01-01T00:00:00.000Z',
    languages: ['typescript'], files: [{ id: 'f1', path: 'src/a.ts', language: 'typescript', encoding: 'utf8', size: 50, lines: 4, hash: 'fixture-hash', modified: '2026-01-01T00:00:00.000Z', binary: false, testFile: false, generated: false }],
    symbols: [{ id: 's1', fileId: 'f1', parentId: null, kind: 'function', name: 'add', fullyQualifiedName: 'add', line: 2, endLine: 4, signature: 'function add(a: number, b: number)', source: 'tree-sitter', confidence: makeConfidence(100), exported: true }],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] }, diagnostics: [{ severity: 'warning', line: 2, message: 'fixture warning', source: 'fixture' }], metrics: { totalFiles: 1, totalLoc: 4, totalSymbols: 1, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 1 } },
  } as ProjectIndex;
}

describe('Phase 1 read-only tools', () => {
  let root: string; let reader: ProjectIndexReader;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-engine-p1-')); await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.ts'), 'import x from "x";\nexport function add(a: number, b: number) {\n  return a + b;\n}\n', 'utf8'); reader = new ProjectIndexReader(index(root)); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('code_read reads bounded UTF-16 ranges and emits a freshness handle', async () => { const result = await new CodeReadTool(reader, root).execute({ path: 'src/a.ts', start: 0, end: 6 }); expect(result.success).toBe(true); expect(result.items[0]?.excerpt).toBe('import'); expect(result.items[0]?.metadata).toEqual(expect.objectContaining({ handle: expect.stringContaining('src/a.ts:0-6#') })); });
  test('code_read refuses traversal and stale handles without source', async () => { const denied = await new CodeReadTool(reader, root).execute({ path: '../secret' }); expect(denied.success).toBe(false); const first = await new CodeReadTool(reader, root).execute({ path: 'src/a.ts', start: 0, end: 4 }); const handle = first.items[0]?.metadata?.handle as string; await fs.appendFile(path.join(root, 'src/a.ts'), '\n// changed'); const stale = await new CodeReadTool(reader, root).execute({ handle }); expect(stale.success).toBe(false); expect(stale.error).toContain('STALE_HANDLE'); });
  test('code_fold is deterministic, bounded, and reports telemetry', async () => { const tool = new CodeFoldTool(reader, root); const a = await tool.execute({ path: 'src/a.ts', level: 2, maxTokens: 20 }); const b = await tool.execute({ path: 'src/a.ts', level: 2, maxTokens: 20 }); expect(a).toEqual(b); expect(a.success).toBe(true); expect(a.items[0]?.metadata).toEqual(expect.objectContaining({ returnedTokens: expect.any(Number), unfoldable: true })); });
  test('index-only tools sort files and expose diagnostics caveat', async () => { const info = await new ProjectInfoTool(reader).execute({}); expect(info.success).toBe(true); expect(info.items[0]?.metadata).toEqual(expect.objectContaining({ schemaVersion: '2.0.0', snapshotId: expect.any(String) })); const files = await new ProjectListFilesTool(reader).execute({}); expect(files.items.map(i => i.path)).toEqual(['src/a.ts']); const diagnostics = await new DiagnosticsGetTool(reader).execute({}); expect(diagnostics.items).toHaveLength(1); expect(diagnostics.metadata?.warning).toContain('does not mean clean'); });
  test('outline and symbol_find are deterministic and bounded', async () => { const outline = await new CodeOutlineTool(reader).execute({ path: 'src/a.ts' }); expect(outline.success).toBe(true); expect(outline.items[0]?.metadata?.symbolKey).toBe('src/a.ts::add::function'); const found = await new SymbolFindTool(reader).execute({ query: 'AD', limit: 1 }); expect(found.items).toHaveLength(1); expect(found.items[0]?.id).toBe('s1'); });
  test('search, inspect, and gains are deterministic and carry provenance', async () => { const search = await new SearchTextTool(reader, root).execute({ query: 'return', limit: 10 }); expect(search.items).toHaveLength(1); expect(search.items[0]?.metadata?.enclosingSymbol).toBe('s1'); const inspect = await new SymbolInspectTool(reader).execute({ id: 's1' }); expect(inspect.items[0]?.metadata).toEqual(expect.objectContaining({ symbolKey: 'src/a.ts::add::function', endLine: 4 })); const gains = await new GainsReportTool(reader, root).execute({ path: 'src/a.ts' }); expect(gains.items[0]?.metadata?.avoidedTokensEstimate).toBeGreaterThan(0); });
});
