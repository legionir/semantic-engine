/**
 * سیاست پرس‌وجوی SQL — جدا از دسترسی به دیتابیس.
 *
 * دو دلیل برای جداسازی:
 *
 * ۱. تصمیم امنیتی باید بدون بالا آوردن sqlite3 قابل آزمون باشد. ماژول
 *    native ممکن است در محیط build نشود (SE-BUILD-09) و آن‌وقت سیاست
 *    اصلاً آزمون نمی‌شود.
 * ۲. یک تابع خالص با ورودی و خروجی مشخص، جای درستی برای منطقی است که
 *    باید کامل و قابل مرور باشد.
 */

import * as path from 'path';

export const ALLOWED_TABLES: ReadonlySet<string> = new Set([
  'files',
  'symbols',
  'call_graph',
  'type_graph',
  'dependency_graph',
  'reverse_dependency_graph',
  'vector_chunks',
]);

/**
 * توابعی که SQLite از طریق آن‌ها به بیرون از دیتابیس دسترسی پیدا می‌کند.
 * یک پرس‌وجوی `SELECT` بدون هیچ جدولی می‌تواند فقط با صدا زدن این‌ها
 * فایل بخواند یا کد بارگذاری کند.
 */
const DANGEROUS_FUNCTIONS: readonly string[] = [
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'fts3_tokenizer',
  'sqlite_compileoption_used',
  'sqlite_dbpage',
];

const MUTATING_KEYWORDS: readonly string[] = [
  'drop', 'delete', 'update', 'insert', 'alter', 'create',
  'attach', 'detach', 'pragma', 'reindex', 'vacuum', 'replace',
];

export interface QueryPolicyOptions {
  /** دایرکتوری‌ای که فایل sqlite باید داخلش باشد. بدون آن، هر مسیری رد می‌شود. */
  readonly allowedRoot?: string;
  /** سقف سطر. همیشه در خود SQL اعمال می‌شود، نه بعد از واکشی. */
  readonly maxRows: number;
}

export type PolicyResult =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly error: string };

/**
 * حذف رشته‌های نقل‌قولی و کامنت‌ها.
 *
 * بررسی کلیدواژه روی SQL خام، مقدار داخل رشته را هم می‌بیند:
 * `WHERE name = 'drop table'` بی‌دلیل رد می‌شود، و برعکس یک کامنت
 * می‌تواند کلیدواژه را پنهان کند.
 */
function stripLiterals(sql: string): string {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // دو نقل‌قول پشت‌سرهم یعنی escape، نه پایان رشته
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }

    if (ch === '[') {
      while (i < sql.length && sql[i] !== ']') i++;
      i++;
      out += ' ';
      continue;
    }

    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * جدول‌هایی که پرس‌وجو به آن‌ها اشاره می‌کند.
 *
 * این کار عمداً با tokenهای سبک انجام می‌شود، نه regex روی SQL خام:
 * `FROM recent` در یک CTE باید alias باشد، در حالی که `FROM files`
 * واقعاً به جدول ایندکس اشاره می‌کند. tokenها روی SQLای ساخته می‌شوند
 * که رشته/کامنت از آن حذف شده، بنابراین پرانتزهای تو در تو و عبارت‌های
 * چندخطی هم بدون اجرای SQL قابل تحلیل‌اند.
 */
interface SqlToken {
  readonly value: string;
  readonly lower: string;
}

function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const pattern = /[A-Za-z_][A-Za-z0-9_$]*|[0-9]+|[(),.]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const value = match[0]!;
    tokens.push({ value, lower: value.toLowerCase() });
  }
  return tokens;
}

function matchingParen(tokens: readonly SqlToken[], opening: number): number {
  let depth = 0;
  for (let i = opening; i < tokens.length; i++) {
    if (tokens[i]!.value === '(') depth++;
    else if (tokens[i]!.value === ')' && --depth === 0) return i;
  }
  return -1;
}

/** همه aliasهای CTE را جمع می‌کند؛ nested WITHها هم با scan سراسری دیده می‌شوند. */
function cteAliases(tokens: readonly SqlToken[]): ReadonlySet<string> {
  const aliases = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.lower !== 'with') continue;
    let cursor = i + 1;
    if (tokens[cursor]?.lower === 'recursive') cursor++;

    for (;;) {
      const alias = tokens[cursor];
      if (!alias || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(alias.value)) break;
      aliases.add(alias.lower);
      cursor++;

      // ستون‌های alias: `name (a, b) AS (...)`
      if (tokens[cursor]?.value === '(') {
        const close = matchingParen(tokens, cursor);
        if (close < 0) break;
        cursor = close + 1;
      }
      if (tokens[cursor]?.lower !== 'as' || tokens[cursor + 1]?.value !== '(') break;
      const close = matchingParen(tokens, cursor + 1);
      if (close < 0) break;
      cursor = close + 1;
      if (tokens[cursor]?.value !== ',') break;
      cursor++;
    }
  }

  return aliases;
}

function referencedTables(strippedSql: string): string[] {
  const tokens = sqlTokens(strippedSql);
  const aliases = cteAliases(tokens);
  const tables: string[] = [];
  const clauseEnd = new Set(['where', 'group', 'order', 'having', 'limit', 'union', 'except', 'intersect', 'window', 'returning']);
  let expectSource = false;
  let inFromClause = false;
  let fromDepth = 0;
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.value === '(') { depth++; continue; }
    if (token.value === ')') { depth = Math.max(0, depth - 1); continue; }

    if (token.lower === 'from' || token.lower === 'join') {
      expectSource = true;
      inFromClause = true;
      fromDepth = depth;
      continue;
    }
    if (inFromClause && depth === fromDepth && clauseEnd.has(token.lower)) {
      inFromClause = false;
      expectSource = false;
      continue;
    }
    if (inFromClause && depth === fromDepth && token.lower === 'on') {
      expectSource = false;
      continue;
    }
    if (inFromClause && depth === fromDepth && token.value === ',') {
      expectSource = true;
      continue;
    }
    if (!expectSource) continue;

    // `FROM (...)` is a subquery, not a table. Its inner FROM/JOIN tokens
    // are still scanned by this loop.
    if (token.value === '(') { expectSource = false; continue; }
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(token.value)) {
      expectSource = false;
      continue;
    }

    let name = token.value;
    let next = i + 1;
    while (tokens[next]?.value === '.' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(tokens[next + 1]?.value ?? '')) {
      name += `.${tokens[next + 1]!.value}`;
      next += 2;
      i = next - 1;
    }
    if (!aliases.has(name.toLowerCase())) tables.push(name);
    expectSource = false;
  }

  return tables;
}

/**
 * بررسی اینکه مسیر داده‌شده واقعاً داخل ریشهٔ مجاز است.
 * `path.resolve` قبل از مقایسه، `..` را جمع می‌کند.
 */
export function isInsideRoot(target: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);

  if (resolvedTarget === resolvedRoot) {
    return true;
  }

  return resolvedTarget.startsWith(resolvedRoot + path.sep);
}

/**
 * ارزیابی یک پرس‌وجو. در صورت پذیرش، SQL امن‌شده با سقف سطر برمی‌گردد.
 */
export function applyQueryPolicy(
  rawSql: string,
  options: QueryPolicyOptions
): PolicyResult {
  const sql = rawSql.trim().replace(/;\s*$/, '');

  if (sql.length === 0) {
    return { ok: false, error: 'Query is empty' };
  }

  const stripped = stripLiterals(sql);
  const lower = stripped.toLowerCase();

  if (!/^\s*(select|with)\b/i.test(stripped)) {
    return { ok: false, error: 'Only SELECT queries are allowed' };
  }

  /*
  | چند دستور در یک رشته. sqlite3.all فقط اولی را اجرا می‌کند، اما
  | تکیه بر آن یعنی تکیه بر جزئیات پیاده‌سازی درایور.
  */
  if (stripped.includes(';')) {
    return { ok: false, error: 'Only a single statement is allowed' };
  }

  for (const keyword of MUTATING_KEYWORDS) {
    /*
    | بدون پرچم g. یک regex با g مقدار lastIndex را نگه می‌دارد و
    | فراخوانی دوم روی همان رشته false برمی‌گرداند — یعنی هر بررسی
    | دوم از فیلتر رد می‌شد.
    */
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(lower)) {
      return { ok: false, error: `Query contains a forbidden keyword: ${keyword}` };
    }
  }

  for (const fn of DANGEROUS_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\b`, 'i').test(lower)) {
      return { ok: false, error: `Query calls a forbidden function: ${fn}` };
    }
  }

  const tables = referencedTables(stripped);

  /*
  | پرس‌وجویی که هیچ جدولی ندارد هرگز داده‌ای از ایندکس نمی‌خواهد.
  | چیزی مثل `SELECT load_extension('x')` دقیقاً همین شکل است.
  */
  if (tables.length === 0) {
    return {
      ok: false,
      error: 'Query must read from at least one allowed table',
    };
  }

  for (const table of tables) {
    if (!ALLOWED_TABLES.has(table)) {
      return { ok: false, error: `Table '${table}' is not allowed` };
    }
  }

  /*
  | سقف سطر با پیچیدن پرس‌وجو اعمال می‌شود، نه با بریدن نتیجه بعد از
  | واکشی. `SELECT * FROM symbols` روی یک ایندکس بزرگ، پیش از این کل
  | جدول را به حافظه می‌آورد و بعد ۱۰۰ سطر اول را برمی‌داشت.
  */
  const limited = `SELECT * FROM (${sql}) LIMIT ${Math.max(1, Math.floor(options.maxRows))}`;

  return { ok: true, sql: limited };
}

/**
 * ارزیابی مسیر فایل دیتابیس.
 */
export function validateDatabasePath(
  target: string,
  options: QueryPolicyOptions
): { ok: true } | { ok: false; error: string } {
  if (!options.allowedRoot) {
    return {
      ok: false,
      error: 'No database directory is configured, so no database may be opened',
    };
  }

  if (!isInsideRoot(target, options.allowedRoot)) {
    return {
      ok: false,
      error: 'Database path is outside the configured output directory',
    };
  }

  if (!/\.sqlite3?$/i.test(target) && !/\.db$/i.test(target)) {
    return { ok: false, error: 'Database path must be a .sqlite, .sqlite3 or .db file' };
  }

  return { ok: true };
}
