/**
 * تست VectorIndexer: تولید chunk های embedding از روی project-index.
 */

import { VectorIndexer } from './VectorIndexer';
import { IEmbeddingGenerator } from './EmbeddingGenerator';
import { ProjectIndex, FileEntry, SymbolEntry } from '../core/types/project-index.types';

function createFile(id: string, filePath: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    path: filePath,
    language: 'typescript',
    encoding: 'utf8',
    size: 1000,
    lines: 50,
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
    ...overrides,
  };
}

function createSymbol(id: string, fileId: string, name: string, kind: any, line: number): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    line,
    endLine: line + 5,
    source: 'lsp',
    confidence: 85 as any,
  } as SymbolEntry;
}

describe('VectorIndexer', () => {
  it('should generate a module chunk for each non-binary file', async () => {
    const file = createFile('f1', 'src/app.ts', {
      aiMetadata: {
        summary: 'Application entrypoint',
        keywords: ['app', 'entrypoint'],
        businessDomains: [],
        designPatterns: [],
        frameworks: [],
        relatedFileIds: [],
        estimatedTokenCost: 100,
        aiScore: { importance: 80, readPriority: 90, hotness: 70 },
      },
    });

    const projectIndex: ProjectIndex = {
      schemaVersion: '2.0.0',
      root: 'test',
      generatedAt: new Date().toISOString(),
      languages: ['typescript'],
      files: [file],
      symbols: [],
      graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] },
      diagnostics: [],
      metrics: { totalFiles: 1, totalLoc: 50, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: { typescript: 1 } },
    };

    const indexer = new VectorIndexer();
    const chunks = await indexer.index(projectIndex);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.unit).toBe('module');
    expect(chunks[0]!.fileId).toBe('f1');
    expect(chunks[0]!.content).toContain('Application entrypoint');
    expect(chunks[0]!.tokenEstimate).toBeGreaterThan(0);
  });

  it('should generate symbol chunks for chunkable symbols', async () => {
    const file = createFile('f1', 'src/utils.ts');
    const fn = createSymbol('s1', 'f1', 'helper', 'function', 2);

    const projectIndex: ProjectIndex = {
      schemaVersion: '2.0.0',
      root: 'test',
      generatedAt: new Date().toISOString(),
      languages: ['typescript'],
      files: [file],
      symbols: [fn],
      graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] },
      diagnostics: [],
      metrics: { totalFiles: 1, totalLoc: 50, totalSymbols: 1, avgCyclomaticComplexity: 0, languageBreakdown: { typescript: 1 } },
    };

    const indexer = new VectorIndexer();
    const chunks = await indexer.index(projectIndex);

    const symbolChunk = chunks.find(c => c.symbolId === 's1');
    expect(symbolChunk).toBeDefined();
    expect(symbolChunk!.unit).toBe('function');
    expect(symbolChunk!.content).toContain('helper');
  });

  it('should attach embeddings when generator is provided', async () => {
    const file = createFile('f1', 'src/app.ts', {
      aiMetadata: {
        summary: 'Application entrypoint',
        keywords: ['app'],
        businessDomains: [],
        designPatterns: [],
        frameworks: [],
        relatedFileIds: [],
        estimatedTokenCost: 50,
        aiScore: { importance: 80, readPriority: 90, hotness: 70 },
      },
    });

    const projectIndex: ProjectIndex = {
      schemaVersion: '2.0.0',
      root: 'test',
      generatedAt: new Date().toISOString(),
      languages: ['typescript'],
      files: [file],
      symbols: [],
      graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] },
      diagnostics: [],
      metrics: { totalFiles: 1, totalLoc: 50, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: { typescript: 1 } },
    };

    const mockGenerator: IEmbeddingGenerator = {
      modelName: 'mock-model',
      isReady: async () => true,
      generate: async (text: string) => ({
        embedding: [0.1, 0.2, text.length * 0.01],
        model: 'mock-model',
        dimensions: 3,
      }),
      generateBatch: async (texts: readonly string[]) =>
        texts.map(text => ({
          embedding: [0.1, 0.2, text.length * 0.01],
          model: 'mock-model',
          dimensions: 3,
        })),
      dispose: async () => {},
    };

    const indexer = new VectorIndexer({ embeddingGenerator: mockGenerator });
    const chunks = await indexer.index(projectIndex);

    expect(chunks[0]!.embedding).toBeDefined();
    expect(chunks[0]!.embedding).toHaveLength(3);
  });

  it('should skip binary files', async () => {
    const binaryFile = createFile('f2', 'assets/logo.png', { binary: true, language: null, encoding: 'binary' });

    const projectIndex: ProjectIndex = {
      schemaVersion: '2.0.0',
      root: 'test',
      generatedAt: new Date().toISOString(),
      languages: [],
      files: [binaryFile],
      symbols: [],
      graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] },
      diagnostics: [],
      metrics: { totalFiles: 1, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: {} },
    };

    const indexer = new VectorIndexer();
    const chunks = await indexer.index(projectIndex);

    expect(chunks).toHaveLength(0);
  });
});

describe('VectorIndexer.updateIncremental — a model change in the middle of an index', () => {
  const generator = (model: string, size: number): IEmbeddingGenerator => ({
    modelName: model,
    isReady: async () => true,
    generate: async () => ({ embedding: new Array(size).fill(0.5), model, dimensions: size }),
    generateBatch: async (texts: readonly string[]) =>
      texts.map(() => ({ embedding: new Array(size).fill(0.5), model, dimensions: size })),
    dispose: async () => {},
  });

  const twoFileIndex = (): ProjectIndex => ({
    schemaVersion: '2.0.0',
    root: 'test',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files: [createFile('f1', 'src/a.ts'), createFile('f2', 'src/b.ts')],
    symbols: [],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] },
    diagnostics: [],
    metrics: { totalFiles: 2, totalLoc: 100, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: { typescript: 2 } },
  });

  it('re-embeds untouched files that still carry the previous model, so one index never mixes two models', async () => {
    const index = twoFileIndex();
    const old = new VectorIndexer({ embeddingGenerator: generator('model-old', 4) });
    const first = await old.index(index);
    expect(new Set(first.map(c => c.embeddingModel))).toEqual(new Set(['model-old']));

    /* only f1 changed, but the generator is now another model */
    const next = new VectorIndexer({ embeddingGenerator: generator('model-new', 8) });
    const updated = await next.updateIncremental(index, new Set(['f1']), new Map(), first);

    expect(new Set(updated.map(c => c.embeddingModel))).toEqual(new Set(['model-new']));
    expect(new Set(updated.map(c => c.embedding!.length))).toEqual(new Set([8]));
    expect(updated.map(c => c.fileId).sort()).toEqual(['f1', 'f2']);
  });

  it('still keeps untouched files as they are when the model has not changed', async () => {
    const index = twoFileIndex();
    const same = new VectorIndexer({ embeddingGenerator: generator('model-old', 4) });
    const first = await same.index(index);
    const batches: number[] = [];
    const counting = generator('model-old', 4);
    const original = counting.generateBatch.bind(counting);
    (counting as { generateBatch: IEmbeddingGenerator['generateBatch'] }).generateBatch = async texts => {
      batches.push(texts.length);
      return original(texts);
    };

    await new VectorIndexer({ embeddingGenerator: counting }).updateIncremental(index, new Set(['f1']), new Map(), first);
    expect(batches.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(first.length / 2 + 1);
  });
});
