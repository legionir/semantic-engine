/**
 * فاز ۲۴ — خروجی SQLite.
 *
 *   SE-EXP-07  سطر مرده هرگز حذف نمی‌شد — `INSERT OR REPLACE` بدون `DELETE`
 *   SE-EXP-08  نه جدول متادیتا بود، نه نسخهٔ schema، نه مسیر مهاجرت
 *   SE-EXP-09  `PRAGMA foreign_keys = ON` بدون حتی یک FK
 *
 * این سوئیت روی درایور داخلی Node اجرا می‌شود، پس برخلاف
 * `SQLiteExporter.test.ts` قدیمی به build بومی نیاز ندارد و در
 * `npm test` هم می‌آید.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteExporter, SqliteOwnershipError } from './SQLiteExporter';
import { openSqlite, hasNativeSqlite, SqliteDriver } from './sqlite/SqliteDriver';
import { ProjectIndex, FileEntry, SymbolEntry } from '../core/types/project-index.types';

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'se-sqlite-'));
  dbPath = path.join(directory, 'index.sqlite');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function file(id: string, filePath: string): FileEntry {
  return {
    id,
    path: filePath,
    language: 'typescript',
    encoding: 'utf8',
    size: 1,
    lines: 1,
    hash: `h-${id}`,
    modified: '2026-08-19T00:00:00.000Z',
    binary: false,
    testFile: false,
    generated: false,
  } as FileEntry;
}

function symbol(id: string, fileId: string, name: string): SymbolEntry {
  return { id, fileId, parentId: null, kind: 'function', name, line: 1, endLine: 2 } as SymbolEntry;
}

function index(files: FileEntry[], symbols: SymbolEntry[]): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    rootPath: '/tmp/fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols,
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: files.length,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 0,
      languageBreakdown: { typescript: files.length },
    },
  } as ProjectIndex;
}

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const db: SqliteDriver = await openSqlite(dbPath);
  try {
    return await db.all<T>(sql);
  } finally {
    await db.close();
  }
}

function canLoadSqlite3(): boolean {
  // `sqlite3` is an *optional* native dependency. On a platform whose glibc is
  // older than the prebuilt binary (or with no network at install time) it is
  // legitimately absent and the engine degrades to node:sqlite — SE-BUILD-10.
  try {
    require.resolve('sqlite3');
    require('sqlite3');
    return true;
  } catch {
    return false;
  }
}

describe('درایور SQLite — compatibility matrix', () => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  // Measured: Node 22.12 still needs --experimental-sqlite; unflagged from 22.13 / 23.4 / 24.
  const builtIn =
    major >= 24 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);

  afterEach(() => {
    delete process.env['SEMANTIC_ENGINE_SQLITE_DRIVER'];
  });

  it('the built-in driver exists exactly on Node >= 22.13 (unflagged)', () => {
    expect(hasNativeSqlite()).toBe(builtIn);
  });

  it('default selection: node:sqlite when built in, otherwise the optional sqlite3', async () => {
    const db = await openSqlite(':memory:');
    expect(db.name).toBe(builtIn ? 'node:sqlite' : 'sqlite3');
    await db.close();
  });

  const itIfSqlite3 = canLoadSqlite3() ? it : it.skip;
  itIfSqlite3('the sqlite3 fallback runs the whole exporter and produces the same rows', async () => {
    process.env['SEMANTIC_ENGINE_SQLITE_DRIVER'] = 'sqlite3';
    const db = await openSqlite(':memory:');
    expect(db.name).toBe('sqlite3');
    await db.close();

    await new SQLiteExporter().export(
      index([file('f1', 'a.ts')], [symbol('s1', 'f1', 'alpha')]),
      { outputPath: dbPath }
    );
    expect((await query('SELECT id FROM files')).map(r => r['id'])).toEqual(['f1']);
    expect((await query('SELECT id FROM symbols')).map(r => r['id'])).toEqual(['s1']);
  });

  it('forcing an unknown driver is an error, not a silent switch', async () => {
    process.env['SEMANTIC_ENGINE_SQLITE_DRIVER'] = 'nope';
    await expect(openSqlite(':memory:')).rejects.toThrow(/Unknown SEMANTIC_ENGINE_SQLITE_DRIVER/);
  });
});

describe('SE-EXP-07 — سطر مرده حذف می‌شود', () => {
  it('فایل حذف‌شده و symbolهایش از دیتابیس می‌روند', async () => {
    const exporter = new SQLiteExporter();

    await exporter.export(
      index(
        [file('f1', 'a.ts'), file('f2', 'b.ts')],
        [symbol('s1', 'f1', 'alpha'), symbol('s2', 'f2', 'beta')]
      ),
      { outputPath: dbPath }
    );

    expect((await query('SELECT id FROM files ORDER BY id')).map(r => r['id'])).toEqual(['f1', 'f2']);
    expect((await query('SELECT id FROM symbols ORDER BY id')).map(r => r['id'])).toEqual(['s1', 's2']);

    // اسکن دوباره، بدون b.ts
    await exporter.export(index([file('f1', 'a.ts')], [symbol('s1', 'f1', 'alpha')]), {
      outputPath: dbPath,
    });

    expect((await query('SELECT id FROM files ORDER BY id')).map(r => r['id'])).toEqual(['f1']);
    expect((await query('SELECT id FROM symbols ORDER BY id')).map(r => r['id'])).toEqual(['s1']);
  });

  it('symbol حذف‌شده از فایلی که مانده هم می‌رود', async () => {
    const exporter = new SQLiteExporter();

    await exporter.export(
      index([file('f1', 'a.ts')], [symbol('s1', 'f1', 'alpha'), symbol('s2', 'f1', 'beta')]),
      { outputPath: dbPath }
    );
    expect(await query('SELECT id FROM symbols')).toHaveLength(2);

    await exporter.export(index([file('f1', 'a.ts')], [symbol('s1', 'f1', 'alpha')]), {
      outputPath: dbPath,
    });

    expect((await query('SELECT id FROM symbols')).map(r => r['id'])).toEqual(['s1']);
  });

  it('یال گراف مرده هم می‌رود', async () => {
    const exporter = new SQLiteExporter();
    const withEdge = index([file('f1', 'a.ts')], [symbol('s1', 'f1', 'alpha')]);

    await exporter.export(
      {
        ...withEdge,
        graphs: {
          ...withEdge.graphs,
          callGraph: [
            {
              id: 'e1',
              caller: 's1',
              callee: 's1',
              kind: 'direct',
              line: 1,
              provenance: { extractor: 'heuristic', confidence: 50, basis: 'name-match' },
            },
          ],
        },
      } as ProjectIndex,
      { outputPath: dbPath }
    );
    expect(await query('SELECT id FROM call_graph')).toHaveLength(1);

    await exporter.export(withEdge, { outputPath: dbPath });
    expect(await query('SELECT id FROM call_graph')).toHaveLength(0);
  });
});

describe('SE-EXP-08 — جدول meta و نسخهٔ schema', () => {
  it('meta نوشته می‌شود و چیزهایی دارد که تا امروز فقط در JSON بودند', async () => {
    await new SQLiteExporter().export(index([file('f1', 'a.ts')], []), { outputPath: dbPath });

    const rows = await query<{ key: string; value: string }>('SELECT key, value FROM meta');
    const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));

    expect(meta['schema_version']).toBeDefined();
    expect(meta['index_schema_version']).toBe('2.0.0');
    expect(meta['root']).toBe('fixture');
    expect(meta['root_path']).toBe('/tmp/fixture');
    expect(meta['generated_at']).toBe('2026-08-19T00:00:00.000Z');
    expect(JSON.parse(meta['languages']!)).toEqual(['typescript']);
    expect(JSON.parse(meta['metrics']!).totalFiles).toBe(1);
  });

  it('دیتابیس با نسخهٔ ناسازگار، بازسازی می‌شود نه اینکه بی‌صدا واگرا بماند', async () => {
    const exporter = new SQLiteExporter();
    await exporter.export(index([file('f1', 'a.ts')], []), { outputPath: dbPath });

    // یک نسخهٔ قدیمی جعل می‌کنیم و یک ستون کم می‌گذاریم
    const db = await openSqlite(dbPath);
    await db.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    await db.exec('DROP TABLE symbols');
    await db.close();

    await exporter.export(index([file('f2', 'b.ts')], [symbol('s9', 'f2', 'gamma')]), {
      outputPath: dbPath,
    });

    expect((await query('SELECT id FROM files')).map(r => r['id'])).toEqual(['f2']);
    expect((await query('SELECT id FROM symbols')).map(r => r['id'])).toEqual(['s9']);
  });
});

describe('legacy database without meta — real migration, backup and idempotence', () => {
  async function seedLegacy(): Promise<void> {
    // The pre-phase-24 shape: tables exist, but with fewer columns and no meta table.
    const db = await openSqlite(dbPath);
    await db.exec(`
      CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE symbols (id TEXT PRIMARY KEY, file_id TEXT, name TEXT);
      INSERT INTO files (id, path) VALUES ('old', 'old.ts');
    `);
    await db.close();
  }

  it('rebuilds a legacy database instead of failing on the old columns', async () => {
    await seedLegacy();

    await new SQLiteExporter().export(
      index([file('f1', 'a.ts')], [symbol('s1', 'f1', 'alpha')]),
      { outputPath: dbPath }
    );

    expect((await query('SELECT id FROM files')).map(r => r['id'])).toEqual(['f1']);
    expect((await query('SELECT id FROM symbols')).map(r => r['id'])).toEqual(['s1']);
    const meta = await query<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key = 'schema_version'");
    expect(meta).toHaveLength(1);
  });

  it('keeps a rollback copy of the legacy file and never grows more backups', async () => {
    await seedLegacy();
    const exporter = new SQLiteExporter();
    await exporter.export(index([file('f1', 'a.ts')], []), { outputPath: dbPath });

    const backup = `${dbPath}.schema-legacy.bak`;
    expect(fs.existsSync(backup)).toBe(true);

    const restored = await openSqlite(backup);
    const rows = await restored.all<{ id: string }>('SELECT id FROM files');
    await restored.close();
    expect(rows.map(r => r.id)).toEqual(['old']);

    // Idempotent: a second export sees a current schema and rebuilds nothing.
    await exporter.export(index([file('f2', 'b.ts')], []), { outputPath: dbPath });
    expect(fs.readdirSync(directory).filter(n => n.endsWith('.bak'))).toEqual(['index.sqlite.schema-legacy.bak']);
    expect((await query('SELECT id FROM files')).map(r => r['id'])).toEqual(['f2']);
  });

  it('a fresh database is not treated as legacy and gets no backup', async () => {
    await new SQLiteExporter().export(index([file('f1', 'a.ts')], []), { outputPath: dbPath });
    expect(fs.readdirSync(directory).filter(n => n.endsWith('.bak'))).toEqual([]);
  });
});

describe('cross-project ownership guard', () => {
  it('refuses to export project B into the database of project A and leaves A intact', async () => {
    const exporter = new SQLiteExporter();
    await exporter.export({ ...index([file('a1', 'a.ts')], []), rootPath: path.join(directory, 'proj-a') }, { outputPath: dbPath });

    await expect(
      exporter.export({ ...index([file('b1', 'b.ts')], []), rootPath: path.join(directory, 'proj-b') }, { outputPath: dbPath })
    ).rejects.toBeInstanceOf(SqliteOwnershipError);

    expect((await query('SELECT id FROM files')).map(r => r['id'])).toEqual(['a1']);
  });

  it('allows re-export of the same project and an explicit root move', async () => {
    const exporter = new SQLiteExporter();
    const rootA = path.join(directory, 'proj-a');
    await exporter.export({ ...index([file('a1', 'a.ts')], []), rootPath: rootA }, { outputPath: dbPath });
    await exporter.export({ ...index([file('a2', 'a2.ts')], []), rootPath: rootA }, { outputPath: dbPath });
    expect((await query('SELECT id FROM files')).map(r => r['id'])).toEqual(['a2']);

    const moved = path.join(directory, 'proj-a-moved');
    await exporter.export({ ...index([file('a3', 'a3.ts')], []), rootPath: moved }, { outputPath: dbPath, allowRootChange: true });
    expect((await query('SELECT id FROM files')).map(r => r['id'])).toEqual(['a3']);
  });
});

describe('SE-EXP-09 — کلید خارجی واقعی', () => {
  it('symbols به files ارجاع دارد و آبشاری حذف می‌شود', async () => {
    await new SQLiteExporter().export(
      index([file('f1', 'a.ts')], [symbol('s1', 'f1', 'alpha')]),
      { outputPath: dbPath }
    );

    const foreignKeys = await query<{ table: string; from: string; to: string }>(
      'PRAGMA foreign_key_list(symbols)'
    );
    expect(foreignKeys.length).toBeGreaterThan(0);
    expect(foreignKeys[0]!.table).toBe('files');

    const db = await openSqlite(dbPath);
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec("DELETE FROM files WHERE id = 'f1'");
    const left = await db.all('SELECT id FROM symbols');
    await db.close();

    expect(left).toEqual([]);
  });

  it('یک symbol با fileId ناموجود پذیرفته نمی‌شود', async () => {
    await new SQLiteExporter().export(index([file('f1', 'a.ts')], []), { outputPath: dbPath });

    const db = await openSqlite(dbPath);
    await db.exec('PRAGMA foreign_keys = ON');
    await expect(
      db.exec("INSERT INTO symbols (id, file_id, kind, name) VALUES ('x', 'ghost', 'function', 'x')")
    ).rejects.toThrow(/FOREIGN KEY/i);
    await db.close();
  });
});
