/**
 * SQLite DDL for the project index export.
 *
 * Kept apart from `SQLiteExporter` so the schema — which is versioned by
 * `SQLITE_SCHEMA_VERSION` — can be read and reviewed without the row-writing
 * code around it.
 */

import { SqliteDriver } from './sqlite/SqliteDriver';

/** Every table/index the exporter owns, created idempotently. */
export const SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        language TEXT,
        size INTEGER,
        lines INTEGER,
        hash TEXT,
        modified TEXT,
        binary INTEGER,
        role TEXT,
        entry_point INTEGER,
        test_file INTEGER,
        generated INTEGER,
        metrics_json TEXT,
        git_metrics_json TEXT,
        config_usages_json TEXT,
        ai_metadata_json TEXT,
        imports_json TEXT,
        exports_json TEXT,
        symbol_ids_json TEXT,
        outline_json TEXT
      );

      /*
      | SE-EXP-09: ستون file_id حالا واقعاً یک FK است. تا امروز
      | PRAGMA foreign_keys روشن بود ولی هیچ محدودیتی وجود نداشت که
      | اعمال شود.
      */
      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        parent_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        fully_qualified_name TEXT,
        signature TEXT,
        visibility TEXT,
        line INTEGER,
        end_line INTEGER,
        documentation TEXT,
        deprecated INTEGER,
        exported INTEGER,
        async INTEGER,
        generator INTEGER,
        abstract INTEGER,
        static INTEGER,
        readonly INTEGER,
        parameters_json TEXT,
        return_type TEXT,
        throws_json TEXT,
        side_effects INTEGER,
        generics_json TEXT,
        extends_json TEXT,
        implements_json TEXT,
        complexity INTEGER,
        reference_count INTEGER,
        calls_json TEXT,
        called_by_json TEXT,
        test_ids_json TEXT,
        source TEXT,
        confidence INTEGER
      );

      /*
      | ستون‌های provenance روی هر چهار جدول یال تکرار می‌شوند.
      | نرمال‌سازی به یک جدول جدا وسوسه‌انگیز است، ولی هر پرس‌وجوی
      | مفیدی روی گراف بلافاصله به confidence نیاز دارد — و یک join
      | به‌ازای هر یال، همان چیزی است که فیلتر کردن را غیرعملی
      | می‌کند.
      */
      CREATE TABLE IF NOT EXISTS call_graph (
        id TEXT PRIMARY KEY,
        caller TEXT,
        callee TEXT,
        kind TEXT,
        line INTEGER,
        extractor TEXT,
        confidence INTEGER,
        basis TEXT
      );

      CREATE TABLE IF NOT EXISTS type_graph (
        parent TEXT,
        child TEXT,
        kind TEXT,
        extractor TEXT,
        confidence INTEGER,
        basis TEXT,
        PRIMARY KEY (parent, child, kind)
      );

      CREATE TABLE IF NOT EXISTS dependency_graph (
        from_id TEXT,
        to_id TEXT,
        kind TEXT,
        extractor TEXT,
        confidence INTEGER,
        basis TEXT,
        PRIMARY KEY (from_id, to_id, kind)
      );

      CREATE TABLE IF NOT EXISTS reverse_dependency_graph (
        from_id TEXT,
        to_id TEXT,
        kind TEXT,
        extractor TEXT,
        confidence INTEGER,
        basis TEXT,
        PRIMARY KEY (from_id, to_id, kind)
      );

      CREATE TABLE IF NOT EXISTS vector_chunks (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        symbol_id TEXT REFERENCES symbols(id) ON DELETE CASCADE,
        unit TEXT,
        content TEXT,
        start_line INTEGER,
        end_line INTEGER,
        token_estimate INTEGER,
        embedding_json TEXT,
        embedding_model TEXT
      );

      /*
      | SE-EXP-08: نسخهٔ schema و آن بخش‌هایی از ایندکس که تا امروز
      | فقط در JSON بودند — root، languages، metrics، git.
      */
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_call_graph_caller ON call_graph(caller);
      CREATE INDEX IF NOT EXISTS idx_call_graph_callee ON call_graph(callee);
      CREATE INDEX IF NOT EXISTS idx_dependency_from ON dependency_graph(from_id);
      CREATE INDEX IF NOT EXISTS idx_dependency_to ON dependency_graph(to_id);
      CREATE INDEX IF NOT EXISTS idx_reverse_dependency_from ON reverse_dependency_graph(from_id);
      CREATE INDEX IF NOT EXISTS idx_reverse_dependency_to ON reverse_dependency_graph(to_id);

      /*
      | فاز ۴۹ — type_graph تنها جدول یالی بود که هیچ ایندکس صریحی
      | نداشت. کلید اصلی‌اش (parent, child, kind) است، پس جست‌وجو با
      | parent از پیشوند چپِ همان کلید استفاده می‌کند ولی جست‌وجو با
      | child نمی‌تواند: EXPLAIN QUERY PLAN روی "WHERE child = ?"
      | می‌گفت SCAN type_graph — یعنی اسکن کامل جدول.
      |
      | تا فاز ۴۸ کسی از این سمت نمی‌پرسید. SqliteGraphQuery هر گام
      | پیمایشِ نوع را از سمت child می‌پرسد (جهت یال نوع از فرزند به
      | والد است)، یعنی یک اسکن کامل به‌ازای هر گام بازگشت.
      |
      | ایندکس روی parent هم اضافه می‌شود: پیمایش معکوس («چه چیزهایی
      | از این ارث می‌برند») فقط همین دو ستون را می‌خواهد و با یک
      | ایندکس پوشا اصلاً به جدول دست نمی‌زند.
      */
      CREATE INDEX IF NOT EXISTS idx_type_graph_child ON type_graph(child);
      CREATE INDEX IF NOT EXISTS idx_type_graph_parent ON type_graph(parent);
      CREATE INDEX IF NOT EXISTS idx_vector_file_id ON vector_chunks(file_id);
      CREATE INDEX IF NOT EXISTS idx_vector_symbol_id ON vector_chunks(symbol_id);
    `;

export async function createTables(db: SqliteDriver): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
