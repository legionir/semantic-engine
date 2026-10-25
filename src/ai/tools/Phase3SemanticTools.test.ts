import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { SymbolReferencesTool } from './Phase3SemanticTools';
import { ProjectIndex } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';

const fixture = (): ProjectIndex => ({ schemaVersion: '2.0.0', root: 'fixture', rootPath: '/', generatedAt: '2026-01-01T00:00:00Z', languages: ['typescript'], files: [
  { id: 'a', path: 'a.ts', language: 'typescript', encoding: 'utf8', size: 0, lines: 1, hash: 'a', modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false },
  { id: 'b', path: 'b.ts', language: 'typescript', encoding: 'utf8', size: 0, lines: 2, hash: 'b', modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false },
], symbols: [{ id: 'fn', fileId: 'a', parentId: null, kind: 'function', name: 'f', fullyQualifiedName: 'f', signature: 'f(): void', line: 1, endLine: 1, exported: true, source: 'typescript-api', confidence: makeConfidence(100) }], graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] }, diagnostics: [], metrics: { totalFiles: 2, totalLoc: 3, totalSymbols: 1, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 2 } } });

describe('Phase 3 symbol_references tool', () => {
  it('is disabled without a workspace root', async () => { const result = await new SymbolReferencesTool(new ProjectIndexReader(fixture())).execute({ symbolId: 'fn' }); expect(result.success).toBe(false); expect(result.error).toContain('DISABLED'); });
  it('returns provenance, confidence and snapshot metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase3-tool-')); await fs.writeFile(path.join(root, 'a.ts'), 'export function f() {}\n'); await fs.writeFile(path.join(root, 'b.ts'), "import { f } from './a';\nf();\n");
    try { const result = await new SymbolReferencesTool(new ProjectIndexReader(fixture()), root).execute({ symbolId: 'fn', minConfidence: 'exact' }); expect(result.success).toBe(true); expect(result.items).toHaveLength(1); expect(result.items[0].metadata).toMatchObject({ confidence: 'exact', via: 'import-graph', targetSymbolId: 'fn' }); expect(result.metadata).toMatchObject({ experimental: true, language: 'typescript' }); } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
