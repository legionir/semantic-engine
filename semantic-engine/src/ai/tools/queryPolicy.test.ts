/**
 * سیاست پرس‌وجو — بدون نیاز به sqlite3.
 *
 * هر مورد اینجا یا از ارزیابی آمده یا یک راه فرار است که هنگام نوشتن
 * سیاست پیدا شد.
 */

import * as path from 'path';
import {
  applyQueryPolicy,
  validateDatabasePath,
  isInsideRoot,
  ALLOWED_TABLES,
} from './queryPolicy';

const POLICY = { allowedRoot: '/work/.semantic-engine', maxRows: 100 };

function accept(sql: string) {
  const result = applyQueryPolicy(sql, POLICY);
  expect(result.ok).toBe(true);
  return result as { ok: true; sql: string };
}

function reject(sql: string) {
  const result = applyQueryPolicy(sql, POLICY);
  expect(result.ok).toBe(false);
  return result as { ok: false; error: string };
}

describe('query policy', () => {

  describe('the stateful regex bug', () => {

    /*
    | FORBIDDEN_KEYWORDS carried the g flag and was used with .test().
    | A regex with g keeps lastIndex between calls, so the same input
    | alternated true, false, true — every second check let the query
    | through. Ten identical calls are enough to catch a return of it.
    */

    it('rejects the same hostile query every time', () => {
      const hostile = 'SELECT * FROM files; DROP TABLE files';

      for (let attempt = 0; attempt < 10; attempt++) {
        const result = applyQueryPolicy(hostile, POLICY);
        expect(result.ok).toBe(false);
      }
    });

    it('accepts the same valid query every time', () => {
      const valid = 'SELECT id, path FROM files WHERE language = ?';

      for (let attempt = 0; attempt < 10; attempt++) {
        expect(applyQueryPolicy(valid, POLICY).ok).toBe(true);
      }
    });
  });

  describe('statement shape', () => {

    it('accepts a plain select', () => {
      accept('SELECT id FROM symbols');
    });

    it('accepts a common table expression and its real source tables', () => {
      accept('WITH recent AS (SELECT id FROM files) SELECT * FROM recent');
      accept('WITH recent AS (SELECT id FROM files) SELECT * FROM recent JOIN symbols ON recent.id = symbols.id');
    });

    it('handles recursive, nested, and column-list CTEs', () => {
      accept(`WITH RECURSIVE chain(id) AS (
        SELECT id FROM files
        UNION ALL
        SELECT id FROM chain JOIN files ON chain.id = files.id
      ) SELECT * FROM chain`);
      accept('WITH outer_cte AS (WITH inner_cte AS (SELECT id FROM files) SELECT id FROM inner_cte) SELECT * FROM outer_cte');
    });

    it('rejects a forbidden table hidden behind a CTE alias', () => {
      expect(reject('WITH recent AS (SELECT id FROM secrets) SELECT * FROM recent').error).toMatch(/not allowed/);
    });

    it('rejects anything that is not a read', () => {
      for (const sql of [
        'DELETE FROM files',
        'UPDATE files SET path = ?',
        'INSERT INTO files VALUES (1)',
        'DROP TABLE files',
        'PRAGMA table_list',
        'VACUUM',
      ]) {
        reject(sql);
      }
    });

    it('rejects a second statement', () => {
      expect(
        reject('SELECT id FROM files; SELECT id FROM symbols').error
      ).toMatch(/single statement/i);
    });

    it('allows a trailing semicolon', () => {
      accept('SELECT id FROM files;');
    });

    it('rejects an empty query', () => {
      reject('   ');
    });
  });

  describe('table allowlist', () => {

    it('accepts every allowed table', () => {
      for (const table of ALLOWED_TABLES) {
        accept(`SELECT * FROM ${table}`);
      }
    });

    it('rejects a table outside the list', () => {
      expect(reject('SELECT * FROM sqlite_master').error).toMatch(/not allowed/);
      expect(reject('SELECT * FROM main.files').error).toMatch(/not allowed/);
    });

    it('checks every table in a join', () => {
      accept('SELECT * FROM files JOIN symbols ON files.id = symbols.file_id');
      reject('SELECT * FROM files JOIN secrets ON files.id = secrets.id');
    });

    /*
    | A query with no FROM never wants anything from the index. It is
    | the shape a call to a built-in function takes, and the old check
    | only looked at tables when a FROM was present.
    */

    it('rejects a query that reads no table', () => {
      expect(reject("SELECT load_extension('/tmp/evil.so')").error)
        .toMatch(/forbidden function/);

      expect(reject('SELECT 1').error).toMatch(/at least one allowed table/);
    });
  });

  describe('dangerous functions', () => {

    it('rejects the functions that reach outside the database', () => {
      for (const sql of [
        "SELECT load_extension('x') FROM files",
        "SELECT readfile('/etc/passwd') FROM files",
        "SELECT writefile('/tmp/x', 'y') FROM files",
        "SELECT * FROM files WHERE path = fts3_tokenizer('x')",
      ]) {
        expect(reject(sql).error).toMatch(/forbidden function/);
      }
    });
  });

  describe('literals and comments', () => {

    /*
    | Keyword matching on raw SQL sees inside strings, so a legitimate
    | query looking for the word "delete" was refused, while a keyword
    | hidden in a comment slipped past.
    */

    it('does not read keywords out of a string literal', () => {
      accept("SELECT * FROM files WHERE path = 'src/delete-user.ts'");
      accept("SELECT * FROM symbols WHERE name = 'dropTable'");
    });

    it('handles an escaped quote inside a literal', () => {
      accept("SELECT * FROM files WHERE path = 'it''s here'");
    });

    it('does not let a comment hide a table', () => {
      reject('SELECT * FROM /* files */ secrets');
    });

    it('does not let a line comment hide a statement', () => {
      reject('SELECT * FROM files -- \n ; DROP TABLE files');
    });
  });

  describe('row cap', () => {

    it('caps in the query rather than after the fetch', () => {
      const result = accept('SELECT * FROM symbols');

      expect(result.sql).toBe('SELECT * FROM (SELECT * FROM symbols) LIMIT 100');
    });

    it('caps a query that already has its own limit', () => {
      const result = accept('SELECT * FROM symbols LIMIT 999999');

      expect(result.sql).toMatch(/LIMIT 100$/);
    });

    it('never emits a limit below one', () => {
      const result =
        applyQueryPolicy('SELECT * FROM files', { ...POLICY, maxRows: 0 });

      expect(result.ok).toBe(true);
      expect((result as { sql: string }).sql).toMatch(/LIMIT 1$/);
    });
  });

  describe('database path', () => {

    it('accepts a file inside the configured directory', () => {
      expect(
        validateDatabasePath('/work/.semantic-engine/project-index.sqlite', POLICY).ok
      ).toBe(true);
    });

    it('rejects a file anywhere else', () => {
      for (const target of [
        '/etc/passwd.sqlite',
        '/home/user/other.sqlite',
        '/work/.semantic-engine/../../secrets.sqlite',
      ]) {
        expect(validateDatabasePath(target, POLICY).ok).toBe(false);
      }
    });

    it('rejects traversal that resolves outside the root', () => {
      expect(
        isInsideRoot('/work/.semantic-engine/../../etc/x.sqlite', '/work/.semantic-engine')
      ).toBe(false);
    });

    it('is not fooled by a sibling with a shared prefix', () => {
      expect(isInsideRoot('/work/.semantic-engine-other/x', '/work/.semantic-engine'))
        .toBe(false);
    });

    it('rejects a path that is not a database file', () => {
      expect(
        validateDatabasePath('/work/.semantic-engine/index.json', POLICY).ok
      ).toBe(false);
    });

    it('refuses everything when no directory is configured', () => {
      const result =
        validateDatabasePath('/anywhere/x.sqlite', { maxRows: 10 });

      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/No database directory/);
    });

    it('accepts a relative path that stays inside the root', () => {
      const root = path.resolve('/work/.semantic-engine');

      expect(isInsideRoot(path.join(root, 'sub', 'a.sqlite'), root)).toBe(true);
    });
  });
});
