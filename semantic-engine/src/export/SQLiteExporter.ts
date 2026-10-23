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
import {
  insertCallGraph, insertDependencyGraph, insertFiles, insertReverseDependencyGraph,
  insertSymbols, insertTypeGraph, insertVectorChunks,
} from './sqliteInserts';
import { openSqlite, SqliteDriver } from './sqlite/SqliteDriver';

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
        await insertFiles(db, projectIndex.files);
        await insertSymbols(db, projectIndex.symbols);
        await insertCallGraph(db, projectIndex.graphs.callGraph);
        await insertTypeGraph(db, projectIndex.graphs.typeGraph);
        await insertDependencyGraph(db, projectIndex.graphs.dependencyGraph);
        await insertReverseDependencyGraph(db, projectIndex.graphs.reverseDependencyGraph ?? []);
        await insertVectorChunks(
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

}
