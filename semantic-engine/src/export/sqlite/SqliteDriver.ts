/**
 * درایور SQLite — SE-BUILD-10 و پیش‌نیاز اثبات SE-EXP-07.
 *
 * ── چرا یک لایهٔ نازک وسط ─────────────────────────────────────────
 *
 * `SQLiteExporter` مستقیم روی `sqlite3` نوشته شده بود، که یک ماژول
 * native است و در نصب، باینری از اینترنت می‌گیرد. دو پیامد داشت:
 *
 *   • در محیط بدون خروجی اینترنت یا با گواهی TLS شرکتی، نصب شکست
 *     می‌خورد (SE-BUILD-10) — و در همین sandbox هم build نمی‌شود.
 *   • سوئیت تستش از `npm test` کنار گذاشته شده بود، پس معیار پذیرش
 *     فاز ۲۴ — «فایل حذف‌شده، سطرش هم برود» — اصلاً قابل اثبات نبود.
 *
 * Node از نسخهٔ ۲۲٫۵ یک SQLite داخلی دارد (`node:sqlite`). CI روی
 * Node ۲۰ و ۲۲ اجرا می‌شود و هدف `engines.node` هم `>=20` است، پس
 * `sqlite3` را نمی‌شود حذف کرد — ولی می‌شود وقتی داخلی موجود است از
 * آن استفاده کرد و native را به یک وابستگی *اختیاری* تنزل داد.
 *
 * رابط ناهمگام است چون `sqlite3` ناهمگام است. پوشاندن یک API همگام
 * در Promise ارزان است؛ عکسش بدون `deasync` ممکن نیست.
 */

export interface SqliteStatement {
  run(...params: readonly unknown[]): Promise<void>;
  finalize(): Promise<void>;
}

export interface SqliteDriver {
  /** نام درایور فعال — برای لاگ و تست. */
  readonly name: 'node:sqlite' | 'sqlite3';
  exec(sql: string): Promise<void>;
  prepare(sql: string): Promise<SqliteStatement>;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * آیا SQLite داخلی Node بدون فلگ در دسترس است؟ اندازه‌گیری‌شده: Node 22.12 هنوز
 * `--experimental-sqlite` می‌خواهد؛ از 22.13 (و 23.4+، و 24) بدون فلگ است.
 */
export function hasNativeSqlite(): boolean {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * یکسان‌سازی مقادیر پیش از bind.
 *
 * `sqlite3` سهل‌گیر است: `undefined` را NULL می‌کند و `boolean` را
 * ۰/۱. `node:sqlite` هر دو را رد می‌کند. اگر این نرمال‌سازی این‌جا
 * نباشد، دو درایور رفتار متفاوت می‌دهند و لایهٔ انتزاع بی‌معنا
 * می‌شود — بدتر از نبودنش، چون تفاوت را پنهان می‌کند.
 *
 * این خودش یک عیب واقعی را لو داد: `SQLiteExporter` برای `source` و
 * `confidence` — برخلاف بقیهٔ ستون‌ها — `?? null` نداشت (SE-EXP-15).
 */
function bindable(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

// ── node:sqlite ───────────────────────────────────────────────────

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

function openNodeSqlite(filePath: string): SqliteDriver {

  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => NodeSqliteDatabase;
  };
  const db = new DatabaseSync(filePath);

  return {
    name: 'node:sqlite',
    async exec(sql) {
      db.exec(sql);
    },
    async prepare(sql) {
      const statement = db.prepare(sql);
      return {
        async run(...params) {
          statement.run(...params.map(bindable));
        },
        /*
        | `node:sqlite` آزادسازی صریح ندارد؛ GC جمعش می‌کند. متد برای
        | یکسان ماندن رابط با `sqlite3` نگه داشته شده.
        */
        async finalize() {
          /* no-op */
        },
      };
    },
    async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params.map(bindable)) as T[];
    },
    async close() {
      db.close();
    },
  };
}

// ── sqlite3 ───────────────────────────────────────────────────────

interface Sqlite3Database {
  run(sql: string, params: unknown[], cb: (err: Error | null) => void): void;
  exec(sql: string, cb: (err: Error | null) => void): void;
  all(sql: string, params: unknown[], cb: (err: Error | null, rows: unknown[]) => void): void;
  prepare(sql: string, cb?: (err: Error | null) => void): Sqlite3Statement;
  close(cb: (err: Error | null) => void): void;
}

interface Sqlite3Statement {
  run(params: unknown[], cb: (err: Error | null) => void): void;
  finalize(cb: (err: Error | null) => void): void;
}

function openSqlite3(filePath: string): Promise<SqliteDriver> {

  let sqlite3: {
    Database: new (path: string, cb: (err: Error | null) => void) => Sqlite3Database;
  };
  try {
    sqlite3 = require('sqlite3');
  } catch (cause) {
    /*
    | Compatibility contract (plan phase 2 / step 5): Node >= 22.5 uses the
    | built-in `node:sqlite`; older Node (engines allows >= 20) needs the
    | optional dependency `sqlite3`. When neither exists say exactly that.
    */
    throw new Error(
      `SQLite export needs Node >= 22.13 (built-in node:sqlite) or the optional dependency "sqlite3"; ` +
        `running Node ${process.versions.node} without sqlite3 installed. Install it with: npm install sqlite3`,
      { cause }
    );
  }

  return new Promise<SqliteDriver>((resolve, reject) => {
    const db: Sqlite3Database = new sqlite3.Database(filePath, error => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        name: 'sqlite3',
        exec: sql => new Promise<void>((ok, no) => db.exec(sql, e => (e ? no(e) : ok()))),
        prepare: sql =>
          new Promise<SqliteStatement>((ok, no) => {
            const statement = db.prepare(sql, e => {
              if (e) {
                no(e);
                return;
              }
              ok({
                run: (...params) =>
                  new Promise<void>((r, j) =>
                    statement.run(params.map(bindable), err => (err ? j(err) : r()))
                  ),
                finalize: () =>
                  new Promise<void>((r, j) => statement.finalize(err => (err ? j(err) : r()))),
              });
            });
          }),
        all: <T>(sql: string, params: readonly unknown[] = []) =>
          new Promise<T[]>((ok, no) =>
            db.all(sql, params as unknown[], (e, rows) => (e ? no(e) : ok(rows as T[])))
          ),
        close: () => new Promise<void>((ok, no) => db.close(e => (e ? no(e) : ok()))),
      });
    });
  });
}

/**
 * باز کردن یک پایگاه داده با بهترین درایور موجود.
 *
 * @param filePath مسیر فایل، یا `:memory:` برای تست.
 */
export async function openSqlite(filePath: string): Promise<SqliteDriver> {
  /*
  | `SEMANTIC_ENGINE_SQLITE_DRIVER=sqlite3|node:sqlite` forces a driver so both
  | code paths can be tested on one Node version. Forcing an unavailable driver
  | is an error, never a silent switch.
  */
  const forced = process.env['SEMANTIC_ENGINE_SQLITE_DRIVER'];
  if (forced === 'sqlite3') return openSqlite3(filePath);
  if (forced === 'node:sqlite') {
    if (!hasNativeSqlite()) {
      throw new Error(`SEMANTIC_ENGINE_SQLITE_DRIVER=node:sqlite but node:sqlite is unavailable on Node ${process.versions.node}`);
    }
    return openNodeSqlite(filePath);
  }
  if (forced !== undefined && forced !== '') {
    throw new Error(`Unknown SEMANTIC_ENGINE_SQLITE_DRIVER "${forced}" (use "sqlite3" or "node:sqlite")`);
  }
  if (hasNativeSqlite()) return openNodeSqlite(filePath);
  return openSqlite3(filePath);
}
