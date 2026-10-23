/**
 * SQLiteExporter — نوشتن project-index در یک دیتابیس SQLite نرمال‌سازی‌شده.
 *
 * بهینه‌سازی‌ها:
 * - استفاده از transaction برای insertهای حجیم
 * - prepared statements برای جلوگیری از parse مکرر SQL
 * - batch inserts برای جداول ساده (call_graph, type_graph, dependency_graph)
 * - PRAGMA‌های عملکردی: journal_mode=WAL, synchronous=NORMAL, cache_size=10000
 *
 * ── SE-EXP-07 ─────────────────────────────────────────────────────
 *
 * تا فاز ۲۴ این کلاس فقط `CREATE TABLE IF NOT EXISTS` و
 * `INSERT OR REPLACE` می‌زد. هیچ `DELETE`ای نبود. یعنی هر سطری که
 * یک بار نوشته می‌شد، برای همیشه می‌ماند: فایل حذف‌شده، symbol
 * حذف‌شده، یال حذف‌شده. و چون incremental در هر ذخیره دوباره export
 * می‌کند، دیتابیس به‌سرعت از JSON واگرا می‌شد — همان دیتابیسی که
 * ابزار AIِ `query_index` از آن می‌خواند.
 *
 * ── SE-EXP-08 ─────────────────────────────────────────────────────
 *
 * نه جدول متادیتا بود، نه نسخهٔ schema. با `IF NOT EXISTS`، افزودن
 * یک ستون در آینده روی دیتابیس موجود *بی‌اثر* است و هیچ‌کس متوجه
 * نمی‌شود. حالا `meta` نسخه را نگه می‌دارد و ناسازگاری یعنی بازسازی.
 *
 * ── SE-EXP-09 ─────────────────────────────────────────────────────
 *
 * `PRAGMA foreign_keys = ON` بدون حتی یک FK تعریف‌شده، یک تشریفات
 * بود. حالا `symbols` و `vector_chunks` واقعاً به `files` ارجاع
 * دارند و آبشاری حذف می‌شوند.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectIndex } from '../core/types/project-index.types';
import { createTables } from './sqliteSchema';
import { openSqlite, SqliteDriver, SqliteStatement } from './sqlite/SqliteDriver';

/**
 * نسخهٔ schemaِ خودِ دیتابیس — نه نسخهٔ قرارداد JSON.
 *
 * هر تغییری در ساختار جدول‌ها این عدد را جلو می‌برد. دیتابیسی که
 * نسخه‌اش نخواند، از نو ساخته می‌شود: مهاجرت تدریجی برای یک کش
 * قابل بازتولید، پیچیدگی بی‌دلیل است.
 */
export const SQLITE_SCHEMA_VERSION = 2;

/** هر جدولی که این exporter مالکش است — ترتیب برای DROP اهمیت دارد. */
const TABLES = [
  'vector_chunks',
  'reverse_dependency_graph',
  'dependency_graph',
  'type_graph',
  'call_graph',
  'symbols',
  'files',
] as const;

export interface SQLiteExportOptions {
  readonly outputPath: string;
  /**
   * The database records which project it belongs to (`meta.root_path`).
   * Exporting a different project into it would delete that project's rows
   * (`deleteDeadRows`), so it is refused unless the caller explicitly says the
   * root was moved.
   */
  readonly allowRootChange?: boolean;
}

/** Thrown when an export would overwrite/delete another project's data. */
export class SqliteOwnershipError extends Error {
  constructor(readonly databasePath: string, readonly owner: string, readonly requested: string) {
    super(
      `Refusing to export into ${databasePath}: it belongs to project root "${owner}", not "${requested}". ` +
        'Use a separate database per project, or pass allowRootChange when the root was moved.'
    );
    this.name = 'SqliteOwnershipError';
  }
}

function sameRoot(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

export class SQLiteExporter {
  async export(projectIndex: ProjectIndex, options: SQLiteExportOptions): Promise<void> {
    const db = await openSqlite(options.outputPath);
    try {
      await this.optimizeForBulkInsert(db);
      await this.assertOwnership(db, projectIndex, options);
      await this.ensureSchema(db, options.outputPath);
      await this.runInTransaction(db, async () => {
        await this.insertFiles(db, projectIndex.files);
        await this.insertSymbols(db, projectIndex.symbols);
        await this.insertCallGraph(db, projectIndex.graphs.callGraph);
        await this.insertTypeGraph(db, projectIndex.graphs.typeGraph);
        await this.insertDependencyGraph(db, projectIndex.graphs.dependencyGraph);
        await this.insertReverseDependencyGraph(db, projectIndex.graphs.reverseDependencyGraph ?? []);
        await this.insertVectorChunks(
          db,
          projectIndex.vectorChunks ?? [],
          new Set(projectIndex.files.map(f => f.id)),
          new Set(projectIndex.symbols.map(s => s.id))
        );
        await this.deleteDeadRows(db, projectIndex);
        await this.writeMeta(db, projectIndex);
      });
    } finally {
      await db.close();
    }
  }

  private async assertOwnership(
    db: SqliteDriver,
    projectIndex: ProjectIndex,
    options: SQLiteExportOptions
  ): Promise<void> {
    if (options.allowRootChange) return;
    const requested = projectIndex.rootPath ?? '';
    if (requested === '') return;
    let owner = '';
    try {
      const rows = await db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'root_path'");
      owner = rows[0]?.value ?? '';
    } catch {
      return; // no meta table: fresh or legacy database, nothing to protect yet
    }
    if (owner !== '' && !sameRoot(owner, requested)) {
      throw new SqliteOwnershipError(options.outputPath, owner, requested);
    }
  }

  private async optimizeForBulkInsert(db: SqliteDriver): Promise<void> {
    await db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = 10000;
      PRAGMA temp_store = MEMORY;
    `);
  }

  private async runInTransaction(db: SqliteDriver, work: () => Promise<void>): Promise<void> {
    await db.exec('BEGIN EXCLUSIVE TRANSACTION');
    try {
      await work();
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * ساخت جدول‌ها، و اگر نسخهٔ موجود نخواند، بازسازی از صفر.
   *
   * SE-EXP-08: بدون این، `CREATE TABLE IF NOT EXISTS` روی یک
   * دیتابیس قدیمی هیچ کاری نمی‌کند و ستون جدید هرگز اضافه نمی‌شود —
   * بی‌صدا، تا وقتی یک `INSERT` با تعداد ستون اشتباه بترکد.
   */
  private async ensureSchema(db: SqliteDriver, databasePath: string): Promise<void> {
    const existing = await this.readSchemaVersion(db);

    /*
    | دیتابیس قدیمی (پیش از جدول `meta`) نسخه‌ای اعلام نمی‌کند ولی جدول‌های
    | با ستون‌های قدیمی دارد؛ `CREATE TABLE IF NOT EXISTS` رویشان بی‌اثر است
    | و INSERT بعدی با تعداد ستون اشتباه می‌ترکد. پس «نسخهٔ نامعلوم + جدول
    | موجود» همان «نسخهٔ ناسازگار» است و باید بازسازی شود.
    */
    const legacy = existing === null && (await this.hasOwnedTables(db));
    const mismatched = existing !== null && existing !== SQLITE_SCHEMA_VERSION;

    if (legacy || mismatched) {
      await this.backupBeforeRebuild(db, databasePath, existing);
      await this.runInTransaction(db, async () => {
        await this.dropAll(db);
        await this.createTables(db);
      });
      return;
    }

    await this.createTables(db);
  }

  private async hasOwnedTables(db: SqliteDriver): Promise<boolean> {
    const rows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    const owned = new Set<string>(TABLES);
    return rows.some(row => owned.has(row.name));
  }

  /**
   * مسیر rollback: پیش از هر بازسازی، فایل قبلی کنار خودش نگه داشته می‌شود
   * (`<db>.schema-<نسخه|legacy>.bak`). نام ثابت است، پس اجرای دوباره
   * فایل جدید نمی‌سازد و رشد نمی‌کند (idempotent).
   */
  private async backupBeforeRebuild(
    db: SqliteDriver,
    databasePath: string,
    existing: number | null
  ): Promise<void> {
    try {
      await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(databasePath, `${databasePath}.schema-${existing ?? 'legacy'}.bak`);
    } catch {
      /* :memory: یا مسیر غیرفایلی — چیزی برای پشتیبان‌گیری نیست. */
    }
  }

  private async readSchemaVersion(db: SqliteDriver): Promise<number | null> {
    try {
      const rows = await db.all<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'"
      );
      if (rows.length === 0) return null;
      const parsed = Number(rows[0]!.value);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      /*
      | جدول `meta` وجود ندارد. یا دیتابیس تازه است، یا از پیش از
      | فاز ۲۴ مانده — در هر دو حالت «نسخه‌ای اعلام نشده».
      */
      return null;
    }
  }

  private async dropAll(db: SqliteDriver): Promise<void> {
    for (const table of TABLES) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    await db.exec('DROP TABLE IF EXISTS meta');
  }

  private async createTables(db: SqliteDriver): Promise<void> {
    await createTables(db);
  }

  private async insertFiles(db: SqliteDriver, files: ProjectIndex['files']): Promise<void> {
    const sql = `
      INSERT OR REPLACE INTO files
      (id, path, language, size, lines, hash, modified, binary, role, entry_point, test_file, generated,
       metrics_json, git_metrics_json, config_usages_json, ai_metadata_json, imports_json, exports_json, symbol_ids_json, outline_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const stmt = await this.prepare(db, sql);
    try {
      for (const file of files) {
        await this.runStatement(stmt, [
          file.id,
          file.path,
          file.language,
          file.size,
          file.lines,
          file.hash,
          file.modified,
          file.binary ? 1 : 0,
          file.role ?? null,
          file.entryPoint ? 1 : 0,
          file.testFile ? 1 : 0,
          file.generated ? 1 : 0,
          JSON.stringify(file.metrics ?? null),
          JSON.stringify(file.gitMetrics ?? null),
          JSON.stringify(file.configUsages ?? []),
          JSON.stringify(file.aiMetadata ?? null),
          JSON.stringify(file.imports ?? []),
          JSON.stringify(file.exports ?? []),
          JSON.stringify(file.symbolIds ?? []),
          JSON.stringify(file.outline ?? []),
        ]);
      }
    } finally {
      await this.finalize(stmt);
    }
  }

  private async insertSymbols(db: SqliteDriver, symbols: ProjectIndex['symbols']): Promise<void> {
    const sql = `
      INSERT OR REPLACE INTO symbols
      (id, file_id, parent_id, kind, name, fully_qualified_name, signature, visibility, line, end_line,
       documentation, deprecated, exported, async, generator, abstract, static, readonly,
       parameters_json, return_type, throws_json, side_effects, generics_json, extends_json, implements_json,
       complexity, reference_count, calls_json, called_by_json, test_ids_json, source, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const stmt = await this.prepare(db, sql);
    try {
      for (const sym of symbols) {
        await this.runStatement(stmt, [
          sym.id,
          sym.fileId,
          sym.parentId ?? null,
          sym.kind,
          sym.name,
          sym.fullyQualifiedName ?? null,
          sym.signature ?? null,
          sym.visibility ?? null,
          sym.line,
          sym.endLine,
          sym.documentation ?? null,
          sym.deprecated ? 1 : 0,
          sym.exported ? 1 : 0,
          sym.async ? 1 : 0,
          sym.generator ? 1 : 0,
          sym.abstract ? 1 : 0,
          sym.static ? 1 : 0,
          sym.readonly ? 1 : 0,
          JSON.stringify(sym.parameters ?? []),
          sym.returnType ?? null,
          JSON.stringify(sym.throws ?? []),
          sym.sideEffects === null ? null : (sym.sideEffects ? 1 : 0),
          JSON.stringify(sym.generics ?? []),
          JSON.stringify(sym.extends ?? []),
          JSON.stringify(sym.implements ?? []),
          sym.complexity ?? null,
          sym.referenceCount ?? null,
          JSON.stringify(sym.calls ?? []),
          JSON.stringify(sym.calledBy ?? []),
          JSON.stringify(sym.testIds ?? []),
          /*
          | SE-EXP-15: این دو تنها ستون‌هایی بودند که `?? null`
          | نداشتند. `sqlite3` بی‌صدا NULL می‌کرد؛ یک درایور
          | سخت‌گیرتر همان‌جا می‌ترکد.
          */
          sym.source ?? null,
          sym.confidence ?? null,
        ]);
      }
    } finally {
      await this.finalize(stmt);
    }
  }

  private async insertCallGraph(db: SqliteDriver, edges: ProjectIndex['graphs']['callGraph']): Promise<void> {
    const sql = `INSERT OR REPLACE INTO call_graph (id, caller, callee, kind, line, extractor, confidence, basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const stmt = await this.prepare(db, sql);
    try {
      for (const edge of edges) {
        await this.runStatement(stmt, [
          edge.id, edge.caller, edge.callee, edge.kind, edge.line ?? null,
          edge.provenance.extractor, edge.provenance.confidence, edge.provenance.basis,
        ]);
      }
    } finally {
      await this.finalize(stmt);
    }
  }

  private async insertTypeGraph(db: SqliteDriver, edges: ProjectIndex['graphs']['typeGraph']): Promise<void> {
    const sql = `INSERT OR REPLACE INTO type_graph (parent, child, kind, extractor, confidence, basis) VALUES (?, ?, ?, ?, ?, ?)`;
    const stmt = await this.prepare(db, sql);
    try {
      for (const edge of edges) {
        await this.runStatement(stmt, [
          edge.parent, edge.child, edge.kind,
          edge.provenance.extractor, edge.provenance.confidence, edge.provenance.basis,
        ]);
      }
    } finally {
      await this.finalize(stmt);
    }
  }

  private async insertDependencyGraph(db: SqliteDriver, edges: ProjectIndex['graphs']['dependencyGraph']): Promise<void> {
    const sql = `INSERT OR REPLACE INTO dependency_graph (from_id, to_id, kind, extractor, confidence, basis) VALUES (?, ?, ?, ?, ?, ?)`;
    const stmt = await this.prepare(db, sql);
    try {
      for (const edge of edges) {
        await this.runStatement(stmt, [
          edge.from, edge.to, edge.kind,
          edge.provenance.extractor, edge.provenance.confidence, edge.provenance.basis,
        ]);
      }
    } finally {
      await this.finalize(stmt);
    }
  }

  private async insertReverseDependencyGraph(db: SqliteDriver, edges: NonNullable<ProjectIndex['graphs']['reverseDependencyGraph']>): Promise<void> {
    const sql = `INSERT OR REPLACE INTO reverse_dependency_graph (from_id, to_id, kind, extractor, confidence, basis) VALUES (?, ?, ?, ?, ?, ?)`;
    const stmt = await this.prepare(db, sql);
    try {
      for (const edge of edges) {
        await this.runStatement(stmt, [
          edge.from, edge.to, edge.kind,
          edge.provenance.extractor, edge.provenance.confidence, edge.provenance.basis,
        ]);
      }
    } finally {
      await this.finalize(stmt);
    }
  }

  private async insertVectorChunks(
    db: SqliteDriver,
    chunks: NonNullable<ProjectIndex['vectorChunks']>,
    validFileIds: ReadonlySet<string>,
    validSymbolIds: ReadonlySet<string>
  ): Promise<void> {
    const sql = `
      INSERT OR REPLACE INTO vector_chunks
      (id, file_id, symbol_id, unit, content, start_line, end_line, token_estimate, embedding_json, embedding_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const stmt = await this.prepare(db, sql);
    let skipped = 0;
    let orphanSymbolRefs = 0;
    try {
      for (const chunk of chunks) {
        /*
        | SE-VEC-10 — جدول یک FK به files و symbols دارد. اگر chunk به
        | fileId/symbolId ای اشاره کند که در ایندکس نیست، درج با
        | `FOREIGN KEY constraint failed` کلِ تراکنش را می‌شکست و
        | `vector_chunks` خالی می‌ماند — دقیقاً همان چیزی که در JSON پر
        | بود ولی در SQLite نه. حالا:
        |   • chunk با fileId نامعتبر رد می‌شود (file_id NOT NULL است).
        |   • symbolId نامعتبر به NULL تبدیل می‌شود (chunk حفظ می‌شود).
        */
        if (!validFileIds.has(chunk.fileId)) {
          skipped++;
          continue;
        }
        let symbolId = chunk.symbolId ?? null;
        if (symbolId !== null && !validSymbolIds.has(symbolId)) {
          symbolId = null;
          orphanSymbolRefs++;
        }
        await this.runStatement(stmt, [
          chunk.id,
          chunk.fileId,
          symbolId,
          chunk.unit,
          chunk.content,
          chunk.startLine,
          chunk.endLine,
          chunk.tokenEstimate,
          chunk.embedding ? JSON.stringify(chunk.embedding) : null,
          chunk.embedding ? chunk.embeddingModel ?? 'unknown' : null,
        ]);
      }
      // ارجاع‌های ناسازگار بی‌صدا سازگار می‌شوند (skipped/orphanSymbolRefs)
      // تا export sqlite هرگز به‌خاطر یک chunkِ آویزان کاملاً fail نشود.
      void skipped;
      void orphanSymbolRefs;
    } finally {
      await this.finalize(stmt);
    }
  }

  /**
   * حذف هر سطری که در ایندکس تازه نیست — SE-EXP-07.
   *
   * روش، «drop و بازنویسی» نیست بلکه «نگه دار آنچه هست، بقیه را
   * ببر»: دیتابیس ممکن است بزرگ باشد و بازنویسی کاملش گران است.
   * شناسه‌ها در یک جدول موقت می‌روند و `DELETE ... WHERE id NOT IN`
   * بقیه را می‌برد — یک عبارت، بدون سقف تعداد پارامتر SQL.
   *
   * ترتیب مهم است: فایل‌ها آخر حذف می‌شوند تا CASCADE بتواند کارش
   * را بکند بدون اینکه با DELETEهای صریح تداخل پیدا کند.
   */
  private async deleteDeadRows(db: SqliteDriver, index: ProjectIndex): Promise<void> {
    const keepIds = async (ids: readonly string[]): Promise<void> => {
      await db.exec('DROP TABLE IF EXISTS temp.keep_ids');
      await db.exec('CREATE TEMP TABLE keep_ids (id TEXT PRIMARY KEY)');
      if (ids.length === 0) return;
      const statement = await db.prepare('INSERT OR IGNORE INTO temp.keep_ids (id) VALUES (?)');
      try {
        for (const id of ids) await statement.run(id);
      } finally {
        await statement.finalize();
      }
    };

    const prune = async (table: string, column: string, ids: readonly string[]): Promise<void> => {
      await keepIds(ids);
      await db.exec(`DELETE FROM ${table} WHERE ${column} NOT IN (SELECT id FROM temp.keep_ids)`);
    };

    await prune('symbols', 'id', index.symbols.map(symbol => symbol.id));
    await prune('call_graph', 'id', index.graphs.callGraph.map(edge => edge.id));
    await prune('vector_chunks', 'id', (index.vectorChunks ?? []).map(chunk => chunk.id));

    /*
    | سه جدول یال دیگر کلید مرکب دارند نه `id`. یک کلید ترکیبی
    | ساخته می‌شود تا همان الگو کار کند.
    |
    | جداکننده `char(30)` (RECORD SEPARATOR) است، نه `:` — چون
    | شناسهٔ یال وابستگی می‌تواند خودش `:` داشته باشد (`pkg:react`)
    | و آن‌وقت دو کلید متفاوت یکی می‌شدند. NUL هم کار نمی‌کند:
    | تجزیه‌گر SQLite داخل رشتهٔ نقل‌قولی قبولش ندارد.
    */
    const SEP = String.fromCharCode(30);
    await this.pruneComposite(
      db,
      'type_graph',
      'parent || char(30) || child || char(30) || kind',
      index.graphs.typeGraph.map(edge => `${edge.parent}${SEP}${edge.child}${SEP}${edge.kind}`)
    );
    await this.pruneComposite(
      db,
      'dependency_graph',
      'from_id || char(30) || to_id || char(30) || kind',
      index.graphs.dependencyGraph.map(edge => `${edge.from}${SEP}${edge.to}${SEP}${edge.kind}`)
    );
    await this.pruneComposite(
      db,
      'reverse_dependency_graph',
      'from_id || char(30) || to_id || char(30) || kind',
      (index.graphs.reverseDependencyGraph ?? []).map(
        edge => `${edge.from}${SEP}${edge.to}${SEP}${edge.kind}`
      )
    );

    await prune('files', 'id', index.files.map(file => file.id));
    await db.exec('DROP TABLE IF EXISTS temp.keep_ids');
  }

  private async pruneComposite(
    db: SqliteDriver,
    table: string,
    expression: string,
    keys: readonly string[]
  ): Promise<void> {
    await db.exec('DROP TABLE IF EXISTS temp.keep_ids');
    await db.exec('CREATE TEMP TABLE keep_ids (id TEXT PRIMARY KEY)');

    if (keys.length > 0) {
      const statement = await db.prepare('INSERT OR IGNORE INTO temp.keep_ids (id) VALUES (?)');
      try {
        for (const key of keys) await statement.run(key);
      } finally {
        await statement.finalize();
      }
    }

    await db.exec(
      `DELETE FROM ${table} WHERE (${expression}) NOT IN (SELECT id FROM temp.keep_ids)`
    );
  }

  /**
   * جدول `meta` — SE-EXP-08.
   *
   * علاوه بر نسخه، آن بخش‌هایی از ایندکس که تا امروز فقط در JSON
   * بودند: `root`, `rootPath`, `generatedAt`, `languages`, `metrics`,
   * `git`. مصرف‌کنندهٔ SQLite برای فهمیدن «این دیتابیس مال کدام
   * پروژه و کدام commit است» مجبور بود فایل JSON را هم بخواند.
   */
  private async writeMeta(db: SqliteDriver, index: ProjectIndex): Promise<void> {
    const entries: readonly (readonly [string, string])[] = [
      ['schema_version', String(SQLITE_SCHEMA_VERSION)],
      ['index_schema_version', index.schemaVersion],
      ['root', index.root],
      ['root_path', index.rootPath ?? ''],
      ['generated_at', index.generatedAt],
      ['generator_version', index.generatorVersion ?? ''],
      ['languages', JSON.stringify(index.languages)],
      ['metrics', JSON.stringify(index.metrics)],
      ['git', JSON.stringify(index.git ?? null)],
      ['file_count', String(index.files.length)],
      ['symbol_count', String(index.symbols.length)],
    ];

    const statement = await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    try {
      for (const [key, value] of entries) await statement.run(key, value);
    } finally {
      await statement.finalize();
    }
  }

  private prepare(db: SqliteDriver, sql: string): Promise<SqliteStatement> {
    return db.prepare(sql);
  }

  private runStatement(stmt: SqliteStatement, params: unknown[]): Promise<void> {
    return stmt.run(...params);
  }

  private finalize(stmt: SqliteStatement): Promise<void> {
    return stmt.finalize();
  }
}
