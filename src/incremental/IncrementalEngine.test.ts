import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IncrementalEngine } from './IncrementalEngine';
import { SymbolExtractorManager } from '../symbols/SymbolExtractorManager';
import { DependencyExtractorManager } from '../dependencies/DependencyExtractorManager';
import { TSDependencyExtractor } from '../dependencies/typescript/TSDependencyExtractor';
import { ProjectIndex, FileEntry, SymbolEntry, SymbolKind } from '../core/types/project-index.types';
import { ISymbolExtractor, SymbolExtractionResult } from '../symbols/ISymbolExtractor';
import { ExtractionSource, ok, makeConfidence } from '../core/types/common.types';
import { JsonExporter } from '../export/JsonExporter';
import { BlueprintExporter } from '../export/BlueprintExporter';
import { VectorIndexer } from '../vector/VectorIndexer';
import { HashingEmbeddingGenerator } from '../vector/HashingEmbeddingGenerator';

/**
 * Mock symbol extractor: برای هر فایل TypeScript، توابع/کلاس‌های سطح بالا را
 * به‌صورت stable symbol id برمی‌گرداند. وابستگی به LSP ندارد.
 */
class MockTSSymbolExtractor implements ISymbolExtractor {
  readonly name: ExtractionSource = 'lsp';
  readonly priority = 100;

  async isAvailable(languageId: string): Promise<boolean> {
    return languageId === 'typescript' || languageId === 'javascript';
  }

  async extract(
    fileId: string,
    filePath: string,
    content: string,
    _languageId: string
  ): Promise<import('../core/types/common.types').Result<SymbolExtractionResult>> {
    const symbols: SymbolEntry[] = [];
    const lines = content.split('\n');

    const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
    const classRegex = /(?:export\s+)?class\s+(\w+)/g;
    const interfaceRegex = /(?:export\s+)?interface\s+(\w+)/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let match: RegExpExecArray | null;

      functionRegex.lastIndex = 0;
      while ((match = functionRegex.exec(line)) !== null) {
        symbols.push(this.createSymbol(fileId, filePath, match[1]!, 'function', i + 1));
      }

      classRegex.lastIndex = 0;
      while ((match = classRegex.exec(line)) !== null) {
        symbols.push(this.createSymbol(fileId, filePath, match[1]!, 'class', i + 1));
      }

      interfaceRegex.lastIndex = 0;
      while ((match = interfaceRegex.exec(line)) !== null) {
        symbols.push(this.createSymbol(fileId, filePath, match[1]!, 'interface', i + 1));
      }
    }

    return ok({
      symbols,
      source: 'lsp',
      partial: false,
      warnings: [],
    });
  }

  private createSymbol(
    fileId: string,
    filePath: string,
    name: string,
    kind: SymbolKind,
    line: number
  ): SymbolEntry {
    const { sha256 } = require('../core/utils/hash');
    return {
      id: `sym-${sha256(`${filePath}:${name}:${kind}`).substring(0, 12)}`,
      fileId,
      parentId: null,
      kind,
      name,
      line,
      endLine: line,
      exported: filePath.includes('utils') || name.startsWith('use'),
      source: 'lsp',
      confidence: makeConfidence(100),
    };
  }

  async dispose(): Promise<void> {}
}

function createInitialProjectIndex(workspaceRoot: string): ProjectIndex {
  const utilsPath = path.join(workspaceRoot, 'src', 'utils.ts');
  const mainPath = path.join(workspaceRoot, 'src', 'main.ts');

  const utilsContent = `export function helper(): string { return 'help'; }\n`;
  const mainContent = `import { helper } from './utils';\nexport function main() { helper(); }\n`;

  fs.mkdirSync(path.dirname(utilsPath), { recursive: true });
  fs.writeFileSync(utilsPath, utilsContent, 'utf8');
  fs.writeFileSync(mainPath, mainContent, 'utf8');

  const { generateFileId } = require('../core/utils/hash');
  const utilsId = generateFileId('src/utils.ts');
  const mainId = generateFileId('src/main.ts');

  const files: FileEntry[] = [
    {
      id: utilsId,
      path: 'src/utils.ts',
      language: 'typescript',
      encoding: 'utf8',
      size: utilsContent.length,
      lines: 1,
      hash: require('../core/utils/hash').sha256(utilsContent),
      modified: new Date().toISOString(),
      binary: false,
      testFile: false,
      generated: false,
      imports: [],
      exports: [{ name: 'helper', kind: 'named' }],
      symbolIds: [],
      outline: [],
    },
    {
      id: mainId,
      path: 'src/main.ts',
      language: 'typescript',
      encoding: 'utf8',
      size: mainContent.length,
      lines: 2,
      hash: require('../core/utils/hash').sha256(mainContent),
      modified: new Date().toISOString(),
      binary: false,
      testFile: false,
      generated: false,
      imports: [{ from: './utils', type: 'local', resolvedFileId: utilsId }],
      exports: [{ name: 'main', kind: 'named' }],
      symbolIds: [],
      outline: [],
    },
  ];

  const symbols: SymbolEntry[] = [
    {
      id: `sym-${require('../core/utils/hash').sha256('src/utils.ts:helper:function').substring(0, 12)}`,
      fileId: utilsId,
      parentId: null,
      kind: 'function',
      name: 'helper',
      line: 1,
      endLine: 1,
      exported: true,
      source: 'lsp',
      confidence: makeConfidence(100),
    },
    {
      id: `sym-${require('../core/utils/hash').sha256('src/main.ts:main:function').substring(0, 12)}`,
      fileId: mainId,
      parentId: null,
      kind: 'function',
      name: 'main',
      line: 2,
      endLine: 2,
      exported: true,
      source: 'lsp',
      confidence: makeConfidence(100),
    },
  ];

  return {
    schemaVersion: '2.0.0',
    root: path.basename(workspaceRoot),
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      callGraph: [],
      typeGraph: [],
      dependencyGraph: [
        { from: mainId, to: utilsId, kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
      ],
    },
    diagnostics: [],
    metrics: {
      totalFiles: 2,
      totalLoc: 3,
      totalSymbols: 2,
      avgCyclomaticComplexity: 0,
      languageBreakdown: { typescript: 2 },
    },
  };
}

describe('IncrementalEngine', () => {
  let workspaceRoot: string;
  let symbolManager: SymbolExtractorManager;
  let dependencyManager: DependencyExtractorManager;
  let engine: IncrementalEngine;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-incr-'));
    symbolManager = new SymbolExtractorManager();
    symbolManager.register(new MockTSSymbolExtractor());
    dependencyManager = new DependencyExtractorManager();
    dependencyManager.register(new TSDependencyExtractor());

    engine = new IncrementalEngine({
      workspaceRoot,
      symbolExtractorManager: symbolManager,
      dependencyExtractorManager: dependencyManager,
      blueprintRebuildThreshold: 0.05,
    });
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('should throw if applyChanges is called before load', async () => {
    await expect(engine.applyChanges([{ type: 'modified', path: 'a.ts' }])).rejects.toThrow(
      'IncrementalEngine not loaded'
    );
  });

  it('should reprocess changed file and its direct dependents', async () => {
    const projectIndex = createInitialProjectIndex(workspaceRoot);
    engine.load(projectIndex);

    // Modify utils.ts
    const newUtilsContent = `export function helper(): string { return 'help!'; }\nexport function anotherHelper(): number { return 42; }\n`;
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'utils.ts'), newUtilsContent, 'utf8');

    const utilsId = projectIndex.files.find(f => f.path === 'src/utils.ts')!.id;
    const mainId = projectIndex.files.find(f => f.path === 'src/main.ts')!.id;

    const result = await engine.applyChanges([{ type: 'modified', path: 'src/utils.ts' }]);

    expect(result.changedFileIds).toContain(utilsId);
    expect(result.dependentFileIds).toContain(mainId);
    expect(result.projectIndex.files.find(f => f.path === 'src/utils.ts')?.lines).toBe(2);

    // main.ts را هم دوباره پردازش کرده → hash یا metrics ممکن است تغییر کرده باشد
    const mainFile = result.projectIndex.files.find(f => f.path === 'src/main.ts');
    expect(mainFile).toBeDefined();
  });

  it('applies the scan overrides of the initial index to changed files', async () => {
    const limited = new IncrementalEngine({
      workspaceRoot,
      symbolExtractorManager: symbolManager,
      dependencyExtractorManager: dependencyManager,
      scannerConfig: { maxFileSizeBytes: 64 },
    });
    limited.load(createInitialProjectIndex(workspaceRoot));
    engine.load(createInitialProjectIndex(workspaceRoot));

    const big = `export function big(): number { return 1; }\n${'// padding line\n'.repeat(40)}`;
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'big.ts'), big, 'utf8');

    const withLimit = await limited.applyChanges([{ type: 'created', path: 'src/big.ts' }]);
    const withDefault = await engine.applyChanges([{ type: 'created', path: 'src/big.ts' }]);

    expect(withLimit.projectIndex.files.find(f => f.path === 'src/big.ts')?.truncated).toBe(true);
    expect(withDefault.projectIndex.files.find(f => f.path === 'src/big.ts')?.truncated).toBeUndefined();
  });

  it('should refresh affected vectors and reuse unchanged embeddings', async () => {
    const base = createInitialProjectIndex(workspaceRoot);
    const utilsId = base.files.find(f => f.path === 'src/utils.ts')!.id;
    const mainId = base.files.find(f => f.path === 'src/main.ts')!.id;
    const contents = new Map<string, string>([
      [utilsId, fs.readFileSync(path.join(workspaceRoot, 'src/utils.ts'), 'utf8')],
      [mainId, fs.readFileSync(path.join(workspaceRoot, 'src/main.ts'), 'utf8')],
    ]);
    const vectorIndexer = new VectorIndexer({ embeddingGenerator: new HashingEmbeddingGenerator() });
    const previousVectors = await vectorIndexer.index(base, { contents });
    const projectIndex: ProjectIndex = { ...base, vectorChunks: previousVectors };
    const vectorEngine = new IncrementalEngine({
      workspaceRoot,
      symbolExtractorManager: symbolManager,
      dependencyExtractorManager: dependencyManager,
      vectorIndexer,
    });
    vectorEngine.load(projectIndex);

    const oldMainVector = previousVectors.find(
      chunk => chunk.fileId === mainId && chunk.symbolId === null
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'utils.ts'),
      `export function helper(): string { return 'changed'; }\n`,
      'utf8'
    );

    const result = await vectorEngine.applyChanges([{ type: 'modified', path: 'src/utils.ts' }]);
    const updatedUtilsVector = result.projectIndex.vectorChunks?.find(
      chunk => chunk.fileId === utilsId && chunk.symbolId === null
    );
    const updatedMainVector = result.projectIndex.vectorChunks?.find(
      chunk => chunk.fileId === mainId && chunk.symbolId === null
    );

    expect(updatedUtilsVector?.content).toContain("return 'changed'");
    expect(updatedUtilsVector?.contentHash).not.toBe(
      previousVectors.find(chunk => chunk.fileId === utilsId && chunk.symbolId === null)?.contentHash
    );
    expect(updatedMainVector?.embedding).toEqual(oldMainVector?.embedding);
  });

  it('should keep file id stable on rename when content hash is unchanged', async () => {
    const projectIndex = createInitialProjectIndex(workspaceRoot);
    engine.load(projectIndex);

    const oldUtilsId = projectIndex.files[0]!.id;

    // Rename file on disk (same content)
    fs.renameSync(
      path.join(workspaceRoot, 'src', 'utils.ts'),
      path.join(workspaceRoot, 'src', 'helpers.ts')
    );

    const result = await engine.applyChanges([
      { type: 'renamed', path: 'src/helpers.ts', oldPath: 'src/utils.ts' },
    ]);

    const renamedFile = result.projectIndex.files.find(f => f.path === 'src/helpers.ts');
    expect(renamedFile).toBeDefined();
    expect(renamedFile!.id).toBe(oldUtilsId);

    // main.ts is reprocessed as a dependent, but its import path './utils'
    // is no longer valid on disk, so resolvedFileId becomes null until the
    // user updates the import path (matches real VSCode rename behavior).
    const mainFile = result.projectIndex.files.find(f => f.path === 'src/main.ts');
    expect(mainFile?.imports?.[0]?.resolvedFileId).toBeNull();
  });

  it('keeps every symbol of a file renamed with identical content (symbol parity)', async () => {
    const projectIndex = createInitialProjectIndex(workspaceRoot);
    engine.load(projectIndex);

    const utilsId = projectIndex.files[0]!.id;
    const before = projectIndex.symbols.filter(symbol => symbol.fileId === utilsId).map(symbol => symbol.id).sort();
    expect(before.length).toBeGreaterThan(0);

    fs.renameSync(path.join(workspaceRoot, 'src', 'utils.ts'), path.join(workspaceRoot, 'src', 'helpers.ts'));
    const result = await engine.applyChanges([
      { type: 'renamed', path: 'src/helpers.ts', oldPath: 'src/utils.ts' },
    ]);

    const after = result.projectIndex.symbols.filter(symbol => symbol.fileId === utilsId).map(symbol => symbol.id).sort();
    expect(after).toEqual(before);
  });

  it('should cleanup edges when a file is deleted', async () => {
    const projectIndex = createInitialProjectIndex(workspaceRoot);
    engine.load(projectIndex);

    const utilsId = projectIndex.files[0]!.id;
    const mainId = projectIndex.files[1]!.id;

    fs.unlinkSync(path.join(workspaceRoot, 'src', 'utils.ts'));

    const result = await engine.applyChanges([{ type: 'deleted', path: 'src/utils.ts' }]);

    expect(result.removedFileIds).toContain(utilsId);
    expect(result.projectIndex.files.find(f => f.id === utilsId)).toBeUndefined();

    // No dependency edge should point to deleted file
    const edgesToDeleted = result.projectIndex.graphs.dependencyGraph.filter(
      e => e.to === utilsId
    );
    expect(edgesToDeleted).toHaveLength(0);

    // main.ts should still exist but its import should not resolve
    const mainFile = result.projectIndex.files.find(f => f.id === mainId);
    expect(mainFile).toBeDefined();
  });

  it('should produce a valid ProjectIndex after incremental update', async () => {
    const projectIndex = createInitialProjectIndex(workspaceRoot);
    engine.load(projectIndex);

    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'utils.ts'),
      `export function helper(): string { return 'v2'; }\n`,
      'utf8'
    );

    const result = await engine.applyChanges([{ type: 'modified', path: 'src/utils.ts' }]);

    expect(result.projectIndex.schemaVersion).toBe('2.0.0');
    expect(result.projectIndex.incremental?.mode).toBe('incremental');
    expect(result.projectIndex.incremental?.changedFileIds.length).toBeGreaterThan(0);
  });

  it('should trigger blueprint rebuild when drift score exceeds threshold', async () => {
    const projectIndex = createInitialProjectIndex(workspaceRoot);
    engine.load(projectIndex);

    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'utils.ts'),
      `export function helper(): string { return 'v3'; }\n`,
      'utf8'
    );

    const result = await engine.applyChanges([{ type: 'modified', path: 'src/utils.ts' }]);

    // 2 files total, 1 changed → driftScore = 0.5 > 0.05
    expect(result.driftScore).toBe(0.5);
    expect(result.shouldRebuildBlueprint).toBe(true);
  });

  it('should not rebuild blueprint when drift score is below threshold', async () => {
    // Create a larger project so one change stays below threshold
    const largeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-large-'));
    const files: FileEntry[] = [];
    const symbols: SymbolEntry[] = [];

    const { generateFileId } = require('../core/utils/hash');
    for (let i = 0; i < 100; i++) {
      const filePath = `src/file${i}.ts`;
      const fileId = generateFileId(filePath);
      const file: FileEntry = {
        id: fileId,
        path: filePath,
        language: 'typescript',
        encoding: 'utf8',
        size: 100,
        lines: 10,
        hash: `hash-${i}`,
        modified: new Date().toISOString(),
        binary: false,
        testFile: false,
        generated: false,
        imports: [],
        exports: [],
        symbolIds: [],
        outline: [],
      };
      files.push(file);
      fs.mkdirSync(path.join(largeRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(largeRoot, filePath), `export function fn${i}() {}\n`, 'utf8');
    }

    const largeIndex: ProjectIndex = {
      schemaVersion: '2.0.0',
      root: 'large-project',
      generatedAt: new Date().toISOString(),
      languages: ['typescript'],
      files,
      symbols,
      graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] },
      diagnostics: [],
      metrics: {
        totalFiles: 100,
        totalLoc: 1000,
        totalSymbols: 0,
        avgCyclomaticComplexity: 0,
        languageBreakdown: { typescript: 100 },
      },
    };

    const largeEngine = new IncrementalEngine({
      workspaceRoot: largeRoot,
      symbolExtractorManager: symbolManager,
      dependencyExtractorManager: dependencyManager,
      blueprintRebuildThreshold: 0.05,
    });
    largeEngine.load(largeIndex);

    const result = await largeEngine.applyChanges([
      { type: 'modified', path: 'src/file0.ts' },
    ]);

    expect(result.driftScore).toBe(0.01); // 1 / 100
    expect(result.shouldRebuildBlueprint).toBe(false);

    fs.rmSync(largeRoot, { recursive: true, force: true });
  });
});
