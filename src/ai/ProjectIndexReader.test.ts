import { ProjectIndexReader } from './ProjectIndexReader';
import { ProjectIndex, FileEntry, SymbolEntry } from '../core/types/project-index.types';

function createFile(id: string, path: string, testFile = false): FileEntry {
  return {
    id,
    path,
    language: 'typescript',
    encoding: 'utf8',
    size: 100,
    lines: 10,
    hash: 'abc',
    modified: new Date().toISOString(),
    binary: false,
    testFile,
    generated: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  };
}

function createSymbol(id: string, fileId: string, name: string, testIds?: string[]): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind: 'function',
    name,
    line: 1,
    endLine: 1,
    source: 'lsp',
    confidence: 85,
    testIds,
  } as SymbolEntry;
}

function createIndex(files: FileEntry[], symbols: SymbolEntry[]): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: '/project',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      callGraph: [],
      typeGraph: [],
      dependencyGraph: [],
      reverseDependencyGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 0,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 0,
      languageBreakdown: { typescript: files.length },
    },
  };
}

describe('ProjectIndexReader', () => {
  it('should index tests for symbols', () => {
    const sourceFile = createFile('f1', 'src/utils.ts');
    const testFile = createFile('f2', 'src/utils.test.ts', true);
    const symbol = createSymbol('s1', 'f1', 'myFn', ['f2']);

    const reader = new ProjectIndexReader(createIndex([sourceFile, testFile], [symbol]));

    const tests = reader.getTestsForSymbol('s1');
    expect(tests).toHaveLength(1);
    expect(tests[0]!.id).toBe('f2');
  });

  it('should aggregate tests for files from symbol testIds', () => {
    const sourceFile = createFile('f1', 'src/utils.ts');
    const testFile1 = createFile('f2', 'src/utils.test.ts', true);
    const testFile2 = createFile('f3', 'src/utils.spec.ts', true);
    const symbol = createSymbol('s1', 'f1', 'myFn', ['f2', 'f3']);

    const reader = new ProjectIndexReader(createIndex([sourceFile, testFile1, testFile2], [symbol]));

    const tests = reader.getTestsForFile('f1');
    expect(tests.map(t => t.id).sort()).toEqual(['f2', 'f3']);
  });

  it('should ignore non-test files in testIds', () => {
    const sourceFile = createFile('f1', 'src/utils.ts');
    const notATest = createFile('f2', 'src/helper.ts', false);
    const symbol = createSymbol('s1', 'f1', 'myFn', ['f2']);

    const reader = new ProjectIndexReader(createIndex([sourceFile, notATest], [symbol]));

    expect(reader.getTestsForSymbol('s1')).toHaveLength(0);
  });
});
