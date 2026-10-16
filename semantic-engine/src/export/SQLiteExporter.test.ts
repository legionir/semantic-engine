/**
 * تست SQLiteExporter: بررسی نوشتن project-index در SQLite.
 */

import * as path from 'path';
import * as fs from 'fs';
/*
| SE-BUILD-10 / فاز ۲۴: این سوئیت مستقیم روی `sqlite3` نوشته شده بود،
| که یک ماژول native است و در محیط بدون شبکه build نمی‌شود. برای
| همین از `npm test` کنار گذاشته شده بود — و با آن، تنها پوششی که
| خروجی SQLite داشت. حالا روی همان درایوری اجرا می‌شود که خودِ
| exporter استفاده می‌کند.
*/
import { openSqlite, SqliteDriver } from './sqlite/SqliteDriver';
import { SQLiteExporter } from './SQLiteExporter';
import { ProjectIndex, FileEntry, SymbolEntry, VectorChunk } from '../core/types/project-index.types';

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
    imports: [{ from: './b', type: 'local', resolvedFileId: 'f2' }],
    exports: [{ name: 'foo', kind: 'named' }],
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
    endLine: line + 2,
    source: 'lsp',
    confidence: 85,
  } as SymbolEntry;
}

const outDir = path.join(__dirname, '..', '..', 'tmp-sqlite-test');
const dbPath = path.join(outDir, 'test.sqlite');

// Windows holds file handles briefly after close; await the real close so
// afterEach rmSync never hits EPERM.
function closeDb(db: SqliteDriver): Promise<void> {
  return db.close();
}

describe('SQLiteExporter', () => {
  beforeEach(() => {
    fs.mkdirSync(outDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  function buildProjectIndex(vectorChunks: VectorChunk[] = []): ProjectIndex {
    const fileA = createFile('f1', 'src/a.ts');
    const fileB = createFile('f2', 'src/b.ts');
    const sym = createSymbol('s1', 'f1', 'foo', 'function', 1);

    return {
      schemaVersion: '2.0.0',
      root: 'test',
      generatedAt: new Date().toISOString(),
      languages: ['typescript'],
      files: [fileA, fileB],
      symbols: [sym],
      graphs: {
        callGraph: [{ id: 'e1', caller: 's1', callee: 's1', kind: 'recursive', line: 1, provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } }],
        typeGraph: [],
        dependencyGraph: [{ from: 'f1', to: 'f2', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } }],
      },
      diagnostics: [],
      metrics: { totalFiles: 2, totalLoc: 100, totalSymbols: 1, avgCyclomaticComplexity: 0, languageBreakdown: { typescript: 2 } },
      vectorChunks,
    };
  }

  it('should create a sqlite database with all tables', async () => {
    const exporter = new SQLiteExporter();
    await exporter.export(buildProjectIndex(), { outputPath: dbPath });

    expect(fs.existsSync(dbPath)).toBe(true);

    const db = await openSqlite(dbPath);
    const tables = (
      await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
    ).map(row => row.name);

    expect(tables).toContain('files');
    expect(tables).toContain('symbols');
    expect(tables).toContain('call_graph');
    expect(tables).toContain('type_graph');
    expect(tables).toContain('dependency_graph');
    expect(tables).toContain('vector_chunks');

    await closeDb(db);
  });

  it('should insert files and symbols', async () => {
    const exporter = new SQLiteExporter();
    await exporter.export(buildProjectIndex(), { outputPath: dbPath });

    const db = await openSqlite(dbPath);
    const fileCount = Number(
      (await db.all<{ c: number }>('SELECT COUNT(*) as c FROM files'))[0]!.c
    );
    const symbolCount = Number(
      (await db.all<{ c: number }>('SELECT COUNT(*) as c FROM symbols'))[0]!.c
    );

    expect(fileCount).toBe(2);
    expect(symbolCount).toBe(1);

    await closeDb(db);
  });

  it('should insert vector chunks', async () => {
    const chunk: VectorChunk = {
      id: 'vec-1',
      fileId: 'f1',
      symbolId: null,
      unit: 'module',
      content: 'module summary',
      startLine: 1,
      endLine: 10,
      tokenEstimate: 5,
    };

    const exporter = new SQLiteExporter();
    await exporter.export(buildProjectIndex([chunk]), { outputPath: dbPath });

    const db = await openSqlite(dbPath);
    const count = Number(
      (await db.all<{ c: number }>('SELECT COUNT(*) as c FROM vector_chunks'))[0]!.c
    );

    expect(count).toBe(1);
    await closeDb(db);
  });

  it('SE-VEC-10 — reconciles chunks that reference a missing symbol instead of failing the whole export', async () => {
    const chunks: VectorChunk[] = [
      { id: 'vec-file', fileId: 'f1', symbolId: null, unit: 'module', content: 'file body', startLine: 1, endLine: 10, tokenEstimate: 5, embedding: [0.1, 0.2], embeddingModel: 'test-model' },
      // symbolId موجود
      { id: 'vec-sym', fileId: 'f1', symbolId: 's1', unit: 'function', content: 'foo body', startLine: 1, endLine: 3, tokenEstimate: 4, embedding: [0.3], embeddingModel: 'test-model' },
      // symbolId که در ایندکس نیست → قبلاً کلِ export را می‌شکست
      { id: 'vec-orphan', fileId: 'f1', symbolId: 'DOES-NOT-EXIST', unit: 'function', content: 'orphan', startLine: 4, endLine: 6, tokenEstimate: 4, embedding: [0.4], embeddingModel: 'test-model' },
      // fileId که در ایندکس نیست → باید رد شود (file_id NOT NULL)
      { id: 'vec-badfile', fileId: 'NO-FILE', symbolId: null, unit: 'module', content: 'ghost', startLine: 1, endLine: 1, tokenEstimate: 1, embedding: [0.5], embeddingModel: 'test-model' },
    ];

    const exporter = new SQLiteExporter();
    // نباید throw کند
    await exporter.export(buildProjectIndex(chunks), { outputPath: dbPath });

    const db = await openSqlite(dbPath);
    const rows = await db.all<{ id: string; symbol_id: string | null; embedding_model: string | null }>(
      'SELECT id, symbol_id, embedding_model FROM vector_chunks ORDER BY id'
    );
    // سه chunk با fileId معتبر درج می‌شوند؛ آنِ با fileId نامعتبر رد می‌شود
    expect(rows.map(r => r.id).sort()).toEqual(['vec-file', 'vec-orphan', 'vec-sym']);
    // symbolId آویزان به NULL تبدیل شده
    expect(rows.find(r => r.id === 'vec-orphan')!.symbol_id).toBeNull();
    expect(rows.find(r => r.id === 'vec-sym')!.symbol_id).toBe('s1');
    // embedding_model از خود chunk خوانده می‌شود، نه هاردکد
    expect(rows.find(r => r.id === 'vec-file')!.embedding_model).toBe('test-model');
    await closeDb(db);
  });
});
