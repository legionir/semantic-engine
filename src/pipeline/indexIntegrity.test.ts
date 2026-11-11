import { checkIndexIntegrity, needsRebuild } from './indexIntegrity';
import { ProjectIndex, FileEntry, SymbolEntry, VectorChunk } from '../core/types/project-index.types';

const file = (id: string, extra: Partial<FileEntry> = {}): FileEntry =>
  ({ id, path: `src/${id}.ts`, language: 'typescript', binary: false, ...extra }) as FileEntry;
const symbol = (id: string, fileId: string): SymbolEntry => ({ id, fileId, name: id, kind: 'function', line: 1 }) as unknown as SymbolEntry;
const chunk = (id: string, fileId: string, extra: Partial<VectorChunk> = {}): VectorChunk =>
  ({ id, fileId, unit: 'module', content: 'x', startLine: 1, endLine: 1, tokenEstimate: 1, embedding: [1, 2], embeddingModel: 'm', ...extra }) as VectorChunk;

function index(parts: Partial<ProjectIndex> & { files: FileEntry[] }): ProjectIndex {
  return {
    schemaVersion: '2.0.0', root: 'r', generatedAt: '', languages: [],
    symbols: [], graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] }, diagnostics: [],
    metrics: { totalFiles: parts.files.length, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: {} },
    ...parts,
  } as ProjectIndex;
}

const six = Array.from({ length: 6 }, (_v, i) => file(`f${i}`));
const codes = (i: ProjectIndex, o = {}) => checkIndexIntegrity(i, o).map(x => x.code);

describe('checkIndexIntegrity', () => {
  it('finds nothing wrong in a consistent index', () => {
    const i = index({ files: six, symbols: [symbol('s1', 'f0')], vectorChunks: [chunk('c1', 'f0')] });
    expect(checkIndexIntegrity(i, { expectVectors: true })).toEqual([]);
  });

  it('asks for a rebuild when the parts contradict each other', () => {
    const i = index({
      files: six,
      symbols: [symbol('s1', 'gone')],
      graphs: {
        callGraph: [{ id: 'e', caller: 'nobody', callee: 'x', kind: 'direct', provenance: 'resolved' } as never],
        typeGraph: [],
        dependencyGraph: [{ from: 'gone', to: 'f0', kind: 'import', provenance: 'resolved' } as never],
      },
      vectorChunks: [chunk('c1', 'gone')],
      metrics: { totalFiles: 99, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: {} },
    });
    const found = codes(i);
    expect(found).toEqual(expect.arrayContaining(['orphan-symbols', 'orphan-calls', 'orphan-dependencies', 'orphan-chunks', 'count-mismatch']));
    expect(needsRebuild(checkIndexIntegrity(i))).toBe(true);
  });

  it('asks for a rebuild when vectors of two models are mixed', () => {
    const i = index({ files: six, symbols: [symbol('s', 'f0')], vectorChunks: [chunk('a', 'f0'), chunk('b', 'f1', { embeddingModel: 'other' })] });
    expect(codes(i)).toContain('mixed-embeddings');
    const dims = index({ files: six, symbols: [symbol('s', 'f0')], vectorChunks: [chunk('a', 'f0'), chunk('b', 'f1', { embedding: [1, 2, 3] })] });
    expect(codes(dims)).toContain('mixed-embeddings');
  });

  it('only warns about what a rebuild cannot fix', () => {
    const noSymbols = checkIndexIntegrity(index({ files: six }));
    expect(noSymbols.map(x => x.code)).toEqual(['no-symbols']);
    expect(needsRebuild(noSymbols)).toBe(false);

    const failing = six.map(f => ({ ...f, diagnostics: [{ severity: 'error', code: 'symbol-extraction' }] }) as unknown as FileEntry);
    expect(codes(index({ files: failing, symbols: [symbol('s', 'f0')] }))).toContain('many-parse-failures');

    const noVectors = checkIndexIntegrity(index({ files: six, symbols: [symbol('s', 'f0')] }), { expectVectors: true });
    expect(noVectors.map(x => x.code)).toEqual(['no-vectors']);
    const unembedded = index({ files: six, symbols: [symbol('s', 'f0')], vectorChunks: [chunk('a', 'f0', { embedding: undefined })] });
    const result = checkIndexIntegrity(unembedded, { expectVectors: true });
    expect(result.map(x => x.code)).toEqual(['missing-embeddings']);
    expect(needsRebuild(result)).toBe(false);
  });

  it('does not call a tiny project empty', () => {
    expect(codes(index({ files: six.slice(0, 2) }))).toEqual([]);
  });
});
