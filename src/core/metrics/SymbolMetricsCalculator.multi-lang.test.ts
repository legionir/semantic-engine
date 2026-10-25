import { SymbolMetricsCalculator } from './SymbolMetricsCalculator';
import { SymbolEntry, FileEntry } from '../types/project-index.types';
import { makeConfidence } from '../types/common.types';

function createFile(id: string, path: string, language: string): FileEntry {
  return {
    id,
    path,
    language,
    encoding: 'utf8',
    size: 100,
    lines: 20,
    hash: 'abc',
    modified: new Date().toISOString(),
    binary: false,
    testFile: false,
    generated: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  };
}

function createSymbol(id: string, fileId: string, kind: any, name: string): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    line: 1,
    endLine: 10,
    source: 'heuristic',
    confidence: makeConfidence(60),
  } as SymbolEntry;
}

describe('SymbolMetricsCalculator multi-language complexity', () => {
  it('should compute complexity for Python files', () => {
    const workspaceRoot = '/tmp';
    const file = createFile('f1', 'src/app.py', 'python');
    const symbol = createSymbol('s1', 'f1', 'function', 'analyze');

    // We need the file to exist on disk for the calculator to read it
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(workspaceRoot, 'src');
    fs.mkdirSync(dir, { recursive: true });
    const content = `
def analyze(x):
    if x > 0:
        for i in range(x):
            if i % 2 == 0:
                print(i)
`;
    fs.writeFileSync(path.join(workspaceRoot, file.path), content, 'utf8');

    const calculator = new SymbolMetricsCalculator();
    const result = calculator.compute({
      workspaceRoot,
      files: [file],
      symbols: [symbol],
      callGraph: [],
    });

    expect(result[0]!.complexity).toBeGreaterThanOrEqual(4);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should not compute complexity for unsupported languages', () => {
    const file = createFile('f1', 'src/style.css', 'css');
    const symbol = createSymbol('s1', 'f1', 'property', 'color');

    const calculator = new SymbolMetricsCalculator();
    const result = calculator.compute({
      workspaceRoot: '/tmp',
      files: [file],
      symbols: [symbol],
      callGraph: [],
    });

    expect(result[0]!.complexity).toBeNull();
  });
});
