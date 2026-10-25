import { ProjectIndexStore } from './ProjectIndexStore';
import { ProjectIndex, FileEntry, SymbolEntry } from '../core/types/project-index.types';

function createMockProjectIndex(): ProjectIndex {
  const files: FileEntry[] = [
    {
      id: 'file-a',
      path: 'src/a.ts',
      language: 'typescript',
      encoding: 'utf8',
      size: 100,
      lines: 10,
      hash: 'hash-a',
      modified: new Date().toISOString(),
      binary: false,
      testFile: false,
      generated: false,
      imports: [{ from: './b', type: 'local', resolvedFileId: 'file-b' }],
      exports: [],
    },
    {
      id: 'file-b',
      path: 'src/b.ts',
      language: 'typescript',
      encoding: 'utf8',
      size: 100,
      lines: 10,
      hash: 'hash-b',
      modified: new Date().toISOString(),
      binary: false,
      testFile: false,
      generated: false,
      imports: [],
      exports: [{ name: 'helper', kind: 'named' }],
    },
    {
      id: 'file-c',
      path: 'src/c.ts',
      language: 'typescript',
      encoding: 'utf8',
      size: 100,
      lines: 10,
      hash: 'hash-c',
      modified: new Date().toISOString(),
      binary: false,
      testFile: false,
      generated: false,
      imports: [{ from: './b', type: 'local', resolvedFileId: 'file-b' }],
      exports: [],
    },
  ];

  const symbols: SymbolEntry[] = [
    {
      id: 'sym-a',
      fileId: 'file-a',
      parentId: null,
      kind: 'function',
      name: 'useHelper',
      line: 1,
      endLine: 5,
      source: 'lsp',
      confidence: 100 as any,
    },
    {
      id: 'sym-b',
      fileId: 'file-b',
      parentId: null,
      kind: 'function',
      name: 'helper',
      line: 1,
      endLine: 3,
      source: 'lsp',
      confidence: 100 as any,
    },
  ];

  return {
    schemaVersion: '2.0.0',
    root: 'test-project',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      callGraph: [],
      typeGraph: [],
      dependencyGraph: [
        { from: 'file-a', to: 'file-b', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
        { from: 'file-c', to: 'file-b', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
      ],
    },
    diagnostics: [],
    metrics: {
      totalFiles: 3,
      totalLoc: 30,
      totalSymbols: 2,
      avgCyclomaticComplexity: 0,
      languageBreakdown: { typescript: 3 },
    },
  };
}

describe('ProjectIndexStore', () => {
  it('rebuilds the files/symbols arrays lazily and keeps them consistent after many updates', () => {
    const store = new ProjectIndexStore(createMockProjectIndex());
    const base = store.projectIndex.files.find(f => f.id === 'file-a')!;
    const symbol = (id: string, fileId: string, line: number): SymbolEntry => ({ ...store.projectIndex.symbols[0]!, id, fileId, name: id, line });

    for (let i = 0; i < 50; i++) {
      store.upsertFile({ ...base, hash: `hash-${i}` });
      store.setSymbolsForFile('file-a', [symbol(`s-${i}-b`, 'file-a', 5), symbol(`s-${i}-a`, 'file-a', 2)]);
    }

    const index = store.projectIndex;
    expect(index.files.find(f => f.id === 'file-a')!.hash).toBe('hash-49');
    expect(index.symbols.filter(s => s.fileId === 'file-a').map(s => s.id)).toEqual(['s-49-a', 's-49-b']);
    expect(store.projectIndex).toBe(index);
    expect(index.files.map(f => f.path)).toEqual([...index.files.map(f => f.path)].sort());
  });

  it('should find direct dependents of a file', () => {
    const store = new ProjectIndexStore(createMockProjectIndex());
    const dependents = store.getDirectDependents('file-b');

    expect(dependents.map(f => f.id).sort()).toEqual(['file-a', 'file-c']);
  });

  it('should compute drift score correctly', () => {
    const store = new ProjectIndexStore(createMockProjectIndex());
    const score = store.computeDriftScore(['file-a'], ['file-b']);

    expect(score).toBeCloseTo(2 / 3);
  });

  it('should remove file and its symbols', () => {
    const store = new ProjectIndexStore(createMockProjectIndex());
    store.removeFile('file-b');

    expect(store.getFileById('file-b')).toBeUndefined();
    expect(store.getSymbolsForFile('file-b')).toEqual([]);
  });

  it('should upsert a file and rebuild updated index', () => {
    const store = new ProjectIndexStore(createMockProjectIndex());
    const updatedFile: FileEntry = {
      ...store.getFileById('file-a')!,
      lines: 20,
      hash: 'hash-a-v2',
    };

    store.upsertFile(updatedFile);
    const updated = store.buildUpdatedIndex({
      mode: 'incremental',
      baseGeneratedAt: null,
      changedFileIds: ['file-a'],
      removedFileIds: [],
      graphs: createMockProjectIndex().graphs,
    });

    const fileA = updated.files.find(f => f.id === 'file-a');
    expect(fileA?.lines).toBe(20);
    expect(updated.incremental?.changedFileIds).toEqual(['file-a']);
  });
});
