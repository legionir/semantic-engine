import { JsonExporter } from './JsonExporter';
import { FileEntry, SymbolEntry } from '../core/types/project-index.types';
import { ScanResult } from '../scanner/WorkspaceScanner';
import { makeConfidence } from '../core/types/common.types';

function createFile(id: string, path: string): FileEntry {
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
    fullyQualifiedName: `${name}::${name}`,
    signature: name,
    visibility: 'public',
    line: 1,
    endLine: 1,
    documentation: null,
    source: 'lsp',
    confidence: makeConfidence(85),
  } as SymbolEntry;
}

describe('JsonExporter', () => {
  const exporter = new JsonExporter();

  it('should deduplicate repeated symbol ids deterministically without warnings', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const file = createFile('file1', 'src/a.ts');
    const sym1 = createSymbol('s1', 'file1', 'function', 'fn1');
    // duplicate id but with richer data → should be selected as canonical
    const sym2 = {
      ...createSymbol('s1', 'file1', 'function', 'fn1_dup'),
      signature: 'fn1_dup(x: number): number',
      documentation: ' documented ',
      confidence: makeConfidence(95),
    };
    const sym3 = createSymbol('s2', 'file1', 'method', 'm1');

    const scanResult: ScanResult = {
      files: [file],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const index = await exporter.buildProjectIndex(scanResult, [sym1, sym2, sym3], {
      outputPath: '/tmp/out.json',
      workspaceRoot: '/home/user/project',
    });

    expect(index.symbols).toHaveLength(2);
    expect(index.files[0]!.symbolIds).toEqual(['s1', 's2']);
    /*
    | SE-EXP-04: این خط قبلاً `['s1','s2']` را انتظار داشت — یعنی
    | دقیقاً همان `symbolIds`. آن ادعا خودِ باگ بود، نه قرارداد.
    */
    expect(index.files[0]!.outline).toEqual(['function fn1_dup', 'method m1']);
    expect(index.metrics.totalSymbols).toBe(2);

    // canonical selection: richer symbol (sym2) should win despite appearing second
    const canonical = index.symbols.find(s => s.id === 's1')!;
    expect(canonical.name).toBe('fn1_dup');
    expect(canonical.signature).toBe('fn1_dup(x: number): number');

    // هیچ warning نباید چاپ شود
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[JsonExporter] Removed'),
      expect.anything()
    );

    warnSpy.mockRestore();
  });

  it('should compute file metrics from symbols', async () => {
    const file = createFile('file1', 'src/a.ts');
    const symClass = createSymbol('c1', 'file1', 'class', 'MyClass');
    const symFn = createSymbol('f1', 'file1', 'function', 'myFn');
    const symMethod = createSymbol('m1', 'file1', 'method', 'myMethod');

    const scanResult: ScanResult = {
      files: [{ ...file, metrics: { loc: 50 } }],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const index = await exporter.buildProjectIndex(scanResult, [symClass, symFn, symMethod], {
      outputPath: '/tmp/out.json',
      workspaceRoot: '/home/user/project',
    });

    expect(index.files[0]!.metrics).toMatchObject({
      loc: 50,
      classes: 1,
      functions: 1,
      methods: 1,
      cyclomaticComplexity: 0,
    });
  });

  it('should not inflate cyclomaticComplexity when symbol complexity is null', async () => {
    const file = createFile('file1', 'src/a.ts');
    const sym1 = createSymbol('s1', 'file1', 'function', 'fn1');
    const sym2 = createSymbol('s2', 'file1', 'function', 'fn2');
    const sym3 = createSymbol('s3', 'file1', 'function', 'fn3');

    const scanResult: ScanResult = {
      files: [file],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const exporter = new JsonExporter();
    const index = await exporter.buildProjectIndex(scanResult, [sym1, sym2, sym3], {
      outputPath: '/tmp/out.json',
      workspaceRoot: '/home/user/project',
    });

    expect(index.files[0]!.metrics!.cyclomaticComplexity).toBe(0);
    expect(index.metrics.avgCyclomaticComplexity).toBe(0);
  });

  it('should populate symbol.calls/calledBy from callGraph', async () => {
    const file = createFile('file1', 'src/a.ts');
    const symA = createSymbol('sA', 'file1', 'function', 'fnA');
    const symB = createSymbol('sB', 'file1', 'function', 'fnB');

    const scanResult: ScanResult = {
      files: [file],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const graphs = {
      callGraph: [
        {
          id: 'e1', caller: 'sA', callee: 'sB', kind: 'direct' as const, line: 10,
          provenance: { extractor: 'heuristic' as const, confidence: 95, basis: 'ast' as const },
        },
      ],
      typeGraph: [],
      dependencyGraph: [],
    };

    const index = await exporter.buildProjectIndex(scanResult, [symA, symB], {
      outputPath: '/tmp/out.json',
      workspaceRoot: '/home/user/project',
    }, [], graphs);

    const a = index.symbols.find(s => s.id === 'sA')!;
    const b = index.symbols.find(s => s.id === 'sB')!;

    expect(a.calls).toContain('sB');
    expect(b.calledBy).toContain('sA');
  });

  it('should compute avgCyclomaticComplexity from symbol complexities', async () => {
    const file = createFile('file1', 'src/a.ts');
    const sym1 = createSymbol('s1', 'file1', 'function', 'fn1');
    const sym2 = createSymbol('s2', 'file1', 'function', 'fn2');
    const sym3 = createSymbol('s3', 'file1', 'class', 'MyClass');

    const scanResult: ScanResult = {
      files: [{ ...file, metrics: { loc: 30 } }],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const symbols: SymbolEntry[] = [
      { ...sym1, complexity: 2 },
      { ...sym2, complexity: 4 },
      { ...sym3, complexity: null },
    ];

    const index = await exporter.buildProjectIndex(scanResult, symbols, {
      outputPath: '/tmp/out.json',
      workspaceRoot: '/home/user/project',
    });

    expect(index.metrics.avgCyclomaticComplexity).toBe(3);
    expect(index.files[0]!.metrics!.cyclomaticComplexity).toBe(6);
  });

  it('should convert absolute root to basename', async () => {
    const scanResult: ScanResult = {
      files: [],
      languages: [],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const index = await exporter.buildProjectIndex(scanResult, [], {
      outputPath: '/tmp/out.json',
      workspaceRoot: '/home/user/ast tree/src',
    });

    expect(index.root).toBe('src');
  });

  it('should produce deterministic output across multiple runs', async () => {
    const file = createFile('file1', 'src/a.ts');
    const symA = createSymbol('sA', 'file1', 'function', 'fnA');
    const symB = createSymbol('sB', 'file1', 'function', 'fnB');
    const symC = createSymbol('sC', 'file1', 'class', 'MyClass');

    const scanResult: ScanResult = {
      files: [{ ...file, modified: '2026-07-11T00:00:00.000Z', metrics: { loc: 30 } }],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const build = () =>
      exporter.buildProjectIndex(scanResult, [symC, symA, symB], {
        outputPath: '/tmp/out.json',
        workspaceRoot: '/home/user/project',
      });

    const index1 = await build();
    const index2 = await build();

    // generatedAt متفاوت است؛ بقیهٔ فیلدها باید یکسان باشند
    const { generatedAt: _, ...rest1 } = index1;
    const { generatedAt: __, ...rest2 } = index2;
    expect(rest1).toEqual(rest2);

    // ترتیب symbols باید دترمینیستیک (fileId, line, kind, name) باشد
    expect(index1.symbols.map(s => s.id)).toEqual(['sC', 'sA', 'sB']);
  });

  it('should attach testIds to symbols based on test file mapping', async () => {
    const sourceFile = createFile('file1', 'src/utils.ts');
    const testFile: FileEntry = {
      ...createFile('file2', 'src/utils.test.ts'),
      testFile: true,
    };
    const unrelatedTest: FileEntry = {
      ...createFile('file3', 'src/other.test.ts'),
      testFile: true,
    };

    const symFn = createSymbol('s1', 'file1', 'function', 'myFn');

    const scanResult: ScanResult = {
      files: [sourceFile, testFile, unrelatedTest],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const index = await exporter.buildProjectIndex(scanResult, [symFn], {
      outputPath: '/tmp/out.json',
      workspaceRoot: '/home/user/project',
    });

    const symbol = index.symbols.find(s => s.id === 's1')!;
    expect(symbol.testIds).toContain('file2');
    expect(symbol.testIds).not.toContain('file3');
  });

  it('should attach git metrics to files when provided', async () => {
    const file = createFile('file1', 'src/a.ts');
    const gitFileMetrics = new Map<string, import('../core/types/project-index.types').GitFileMetrics>([
      ['src/a.ts', { commitCount: 12, hotspotScore: 45, churnRank: 2 }],
    ]);

    const scanResult: ScanResult = {
      files: [file],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const index = await exporter.buildProjectIndex(
      scanResult,
      [],
      { outputPath: '/tmp/out.json', workspaceRoot: '/home/user/project' },
      [],
      { callGraph: [], typeGraph: [], dependencyGraph: [] },
      [],
      undefined,
      undefined,
      { gitFileMetrics }
    );

    expect(index.files[0]!.gitMetrics).toEqual({
      commitCount: 12,
      hotspotScore: 45,
      churnRank: 2,
    });
  });

  /*
  | SE-EXT-03: این تست قبلاً `fileContents` می‌داد و انتظار داشت
  | exporter خودش استخراج کند. حالا استخراج در گذر اصلی pipeline
  | انجام می‌شود و exporter فقط نتیجه را وصل می‌کند — که همان کاری
  | است که یک exporter باید بکند.
  */
  it('should attach config usages to files when usages provided', async () => {
    const file = createFile('file1', 'src/config.ts');
    const configUsages = new Map([
      [
        'file1',
        [{ kind: 'env' as const, key: 'PORT', line: 1, context: 'const port = process.env.PORT;' }],
      ],
    ]);

    const scanResult: ScanResult = {
      files: [file],
      languages: ['typescript'],
      scanDuration: 0,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const index = await exporter.buildProjectIndex(
      scanResult,
      [],
      { outputPath: '/tmp/out.json', workspaceRoot: '/home/user/project' },
      [],
      { callGraph: [], typeGraph: [], dependencyGraph: [] },
      [],
      undefined,
      undefined,
      { configUsages }
    );

    expect(index.files[0]!.configUsages).toHaveLength(1);
    expect(index.files[0]!.configUsages![0]!).toMatchObject({
      kind: 'env',
      key: 'PORT',
      line: 1,
    });
  });
});
