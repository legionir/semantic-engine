/**
 * فاز ۴۹ / GAP-10 — پیمایش بازگشتی در SQLite.
 *
 * ادعای این سوئیت یک چیز است و بقیه فرعی‌اند: **پیمایش روی پایگاه
 * داده باید دقیقاً همان جوابی را بدهد که پیمایش در حافظه می‌دهد.**
 * دو موتور پیمایش که دو جواب بدهند، از یک موتور کند بدتر است —
 * مصرف‌کننده نمی‌داند به کدام اعتماد کند.
 *
 * پس هر آزمون این‌جا هر دو را اجرا می‌کند و نتیجه را مقایسه، نه
 * اینکه عدد را دستی بنویسد. عدد دستی فقط ثابت می‌کند SQL همانی را
 * می‌دهد که موقع نوشتنش فکر می‌کردیم.
 *
 * سه قاعده‌ای که سر آن‌ها اختلاف محتمل بود و جداگانه آزموده می‌شوند:
 *
 *   ۱. یال به بستهٔ بیرونی (`pkg:react`) گره نیست.
 *   ۲. جهت یال نوع از فرزند به والد است.
 *   ۳. قوی‌ترین ادعا برندهٔ هر رابطه است (فاز ۴۹) — در حافظه با
 *      `FactStore`، در SQL با `MAX(confidence)`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteExporter } from '../SQLiteExporter';
import { openSqlite, SqliteDriver } from './SqliteDriver';
import { SqliteGraphQuery } from './SqliteGraphQuery';
import { GraphQueryEngine } from '../../graphs/GraphQueryEngine';
import { provenanceFor, EdgeBasis } from '../../graphs/EdgeProvenance';
import { ProjectIndex } from '../../core/types/project-index.types';

let directory: string;
let dbPath: string;
let db: SqliteDriver | null = null;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'se-graphsql-'));
  dbPath = path.join(directory, 'index.sqlite');
});

afterEach(async () => {
  if (db) await db.close();
  db = null;
  fs.rmSync(directory, { recursive: true, force: true });
});

/*
| گراف آزمون — عمداً همان شکل‌هایی که در گراف واقعی دردسر ساختند:
|
|   a ──calls(name-match 40)──▶ b        ← ادعای ضعیف، زودتر درج‌شده
|   a ──calls(import-resolved 85)──▶ b   ← ادعای قوی، دیرتر
|   b ──calls(ast 95)──▶ c
|   c ──calls(name-match 40)──▶ d        ← تنها راه رسیدن به d
|   e ──calls(ast 95)──▶ a               ← برای جهت `in`
|   a ──imports──▶ m,  m ──imports──▶ pkg:react   ← بستهٔ بیرونی
|   Child ──extends──▶ Parent            ← جهت یال نوع
|   x ⇄ y                                ← حلقه
*/
function fixtureIndex(): ProjectIndex {
  const call = (caller: string, callee: string, basis: EdgeBasis, line: number) => ({
    id: `${caller}->${callee}@${line}`,
    caller,
    callee,
    kind: 'direct',
    line,
    provenance: provenanceFor(basis, 'tree-sitter', { file: `${caller}.ts`, line }),
  });

  const dep = (from: string, to: string) => ({
    from,
    to,
    kind: 'import',
    provenance: provenanceFor('import-resolved', 'tree-sitter', { file: `${from}.ts`, line: 1 }),
  });

  return {
    schemaVersion: '2.0.0',
    root: 'graphsql',
    rootPath: '/tmp/graphsql',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files: [],
    symbols: [],
    graphs: {
      callGraph: [
        call('a', 'b', 'name-match', 10),
        call('a', 'b', 'name-match', 11),
        call('a', 'b', 'import-resolved', 12),
        call('b', 'c', 'ast', 20),
        call('c', 'd', 'name-match', 30),
        call('e', 'a', 'ast', 40),
        call('x', 'y', 'ast', 50),
        call('y', 'x', 'ast', 51),
        /*
        | شناسه‌هایی که یکی زیررشتهٔ دیگری است. تنها راه رسیدن از
        | s0 به q، گذشتن از pq است — و رشتهٔ مسیر آن‌وقت "s0>pq"
        | می‌شود که حرف q را در خود دارد. محافظ حلقه اگر بدون
        | جداکننده جست‌وجو کند، q را «قبلاً دیده‌شده» می‌بیند و
        | مسیر گم می‌شود.
        */
        call('s0', 'pq', 'ast', 60),
        call('pq', 'q', 'ast', 61),
      ],
      dependencyGraph: [dep('a', 'm'), dep('m', 'pkg:react')],
      reverseDependencyGraph: [],
      typeGraph: [
        {
          parent: 'Parent',
          child: 'Child',
          kind: 'extends',
          provenance: provenanceFor('declared', 'tree-sitter', { file: 'Child.ts', line: 1 }),
        },
      ],
    },
    metrics: { totalFiles: 0, totalSymbols: 0, totalLines: 0 },
  } as unknown as ProjectIndex;
}

async function writeAndOpen(index: ProjectIndex): Promise<SqliteGraphQuery> {
  await new SQLiteExporter().export(index, { outputPath: dbPath });
  db = await openSqlite(dbPath);
  return new SqliteGraphQuery(db);
}

/** همان مقایسه‌ای که همهٔ آزمون‌ها انجام می‌دهند: مجموعهٔ (گره، عمق). */
function asPairs(nodes: readonly { id: string; depth: number }[]): string[] {
  return nodes.map(node => `${node.id}@${node.depth}`).sort();
}

describe('SqliteGraphQuery — GAP-10', () => {
  describe('هم‌خوانی با پیمایش در حافظه', () => {
    it('همان گره‌ها و همان عمق‌ها، در هر سه جهت', async () => {
      const index = fixtureIndex();
      const sql = await writeAndOpen(index);
      const memory = new GraphQueryEngine(index);

      for (const direction of ['out', 'in', 'both'] as const) {
        for (const depth of [1, 2, 3, 4]) {
          const fromSql = await sql.neighbors('a', { direction, depth, minConfidence: 0 });
          const fromMemory = memory.neighbors('a', { direction, depth, minConfidence: 0 });
          expect(asPairs(fromSql.nodes)).toEqual(asPairs(fromMemory.nodes));
        }
      }
    });

    it('آستانهٔ اعتماد همان گره‌ها را حذف می‌کند', async () => {
      const index = fixtureIndex();
      const sql = await writeAndOpen(index);
      const memory = new GraphQueryEngine(index);

      for (const minConfidence of [0, 40, 70, 90, 100]) {
        const fromSql = await sql.neighbors('a', { direction: 'out', depth: 4, minConfidence });
        const fromMemory = memory.neighbors('a', { direction: 'out', depth: 4, minConfidence });
        expect(asPairs(fromSql.nodes)).toEqual(asPairs(fromMemory.nodes));
      }
    });

    it('فیلتر رابطه همان کار را می‌کند', async () => {
      const index = fixtureIndex();
      const sql = await writeAndOpen(index);
      const memory = new GraphQueryEngine(index);

      const onlyCalls = await sql.neighbors('a', {
        direction: 'out',
        depth: 3,
        minConfidence: 0,
        relations: ['calls'],
      });
      expect(asPairs(onlyCalls.nodes)).toEqual(
        asPairs(memory.neighbors('a', { direction: 'out', depth: 3, minConfidence: 0, relations: ['calls'] }).nodes)
      );

      const onlyImports = await sql.neighbors('a', {
        direction: 'out',
        depth: 3,
        minConfidence: 0,
        relations: ['imports'],
      });
      expect(asPairs(onlyImports.nodes)).toEqual(['m@1']);
    });

    it('حلقه، پیمایش را متوقف نمی‌کند', async () => {
      const index = fixtureIndex();
      const sql = await writeAndOpen(index);
      const result = await sql.neighbors('x', { direction: 'both', depth: 5, minConfidence: 0 });
      expect(asPairs(result.nodes)).toEqual(['y@1']);
    });

    it('تعداد رابطه‌های یکتا با `edgeCount` حافظه‌ای یکی است', async () => {
      const index = fixtureIndex();
      const sql = await writeAndOpen(index);
      const memory = new GraphQueryEngine(index);
      expect(await sql.edgeCount()).toBe(memory.edgeCount);
    });
  });

  describe('سه قاعده‌ای که ممکن بود واگرا شوند', () => {
    it('یال به بستهٔ بیرونی گره نیست', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      const result = await sql.neighbors('m', {
        direction: 'out',
        depth: 2,
        minConfidence: 0,
        relations: ['imports'],
      });
      expect(result.nodes).toEqual([]);
    });

    it('جهت یال نوع از فرزند به والد است', async () => {
      const sql = await writeAndOpen(fixtureIndex());

      const up = await sql.neighbors('Child', { direction: 'out', depth: 1, minConfidence: 0 });
      expect(asPairs(up.nodes)).toEqual(['Parent@1']);

      const down = await sql.neighbors('Parent', { direction: 'in', depth: 1, minConfidence: 0 });
      expect(asPairs(down.nodes)).toEqual(['Child@1']);
    });

    it('قوی‌ترین ادعا برندهٔ هر رابطه است — نه اولین سطر', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      const edges = await sql.edgesFrom('a', 'out', ['calls'], 0);

      expect(edges).toHaveLength(1);
      expect(edges[0]!.confidence).toBe(85);
      expect(edges[0]!.basis).toBe('import-resolved');
    });

    it('`basis` از همان سطری می‌آید که بیشترین اعتماد را داشت', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      const [edge] = await sql.edgesFrom('a', 'out', ['calls'], 0);
      /*
      | خطر واقعی در `MAX()` با ستون برهنه، ترکیب دو سطر است:
      | اعتماد از یکی و مبنا از دیگری. SQLite تضمین می‌کند این
      | اتفاق نمی‌افتد؛ این آزمون همان تضمین را قفل می‌کند.
      */
      expect(edge!.confidence).toBe(85);
      expect(edge!.basis).toBe('import-resolved');
      expect(edge!.basis).not.toBe('name-match');
    });
  });

  describe('مسیر', () => {
    it('کوتاه‌ترین مسیر، همان طول مسیر حافظه‌ای', async () => {
      const index = fixtureIndex();
      const sql = await writeAndOpen(index);
      const memory = new GraphQueryEngine(index);

      const fromSql = await sql.path('a', 'd', { relations: ['calls'], depth: 5 });
      const fromMemory = memory.path('a', 'd', { relations: ['calls'], depth: 5 });

      expect(fromSql.path).toEqual(fromMemory.path?.map(step => step.node));
    });

    it('مسیری که یال ضعیف دارد، صادقانه ضعیف اعلام می‌شود', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      const result = await sql.path('a', 'd', { relations: ['calls'], depth: 5 });
      expect(result.confident).toBe(false);
      expect(result.weakestLink).toBe(40);
    });

    it('مسیر کاملاً مطمئن، مطمئن اعلام می‌شود', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      const result = await sql.path('a', 'c', { relations: ['calls'], depth: 5 });
      expect(result.path).toEqual(['a', 'b', 'c']);
      expect(result.confident).toBe(true);
      expect(result.weakestLink).toBe(85);
    });

    it('شناسهٔ زیررشته‌ای، مسیر را گم نمی‌کند', async () => {
      /*
      | محافظ حلقه در SQL با `instr` روی رشتهٔ مسیر کار می‌کند. بدون
      | جداکنندهٔ دو طرف (`'>'||id||'>'`)، هر شناسه‌ای که زیررشتهٔ
      | مسیر تا اینجا باشد «دیده‌شده» شمرده می‌شود — حتی اگر هرگز
      | دیده نشده باشد.
      */
      const index = fixtureIndex();
      const sql = await writeAndOpen(index);
      const memory = new GraphQueryEngine(index);

      const fromSql = await sql.path('s0', 'q', { relations: ['calls'], depth: 5, direction: 'out' });
      expect(fromSql.path).toEqual(['s0', 'pq', 'q']);
      expect(fromSql.path).toEqual(
        memory.path('s0', 'q', { relations: ['calls'], depth: 5, direction: 'out' }).path?.map(step => step.node)
      );
    });

    it('مسیر نبودن، `null` است نه مسیر خالی', async () => {
      /*
      | در جهت `out` هیچ راهی از d به a نیست. در جهت `both` هست
      | (d → c → b → a)، و هر دو موتور همان را می‌گویند — اولین
      | نسخهٔ این آزمون جهت را ننوشته بود و «باگ» گزارش می‌کرد که
      | باگ نبود.
      */
      const index = fixtureIndex();
      const sql = await writeAndOpen(index);
      const memory = new GraphQueryEngine(index);

      const result = await sql.path('d', 'a', { relations: ['calls'], depth: 5, direction: 'out' });
      expect(result.path).toBeNull();
      expect(memory.path('d', 'a', { relations: ['calls'], depth: 5, direction: 'out' }).path).toBeNull();

      const bothWays = await sql.path('d', 'a', { relations: ['calls'], depth: 5, direction: 'both' });
      expect(bothWays.path).toEqual(['d', 'c', 'b', 'a']);
    });
  });

  describe('سقف و صداقت', () => {
    it('سقف گره، نتیجه را می‌برد و اعلام می‌کند', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      const result = await sql.neighbors('a', {
        direction: 'out',
        depth: 5,
        minConfidence: 0,
        maxNodes: 1,
      });
      expect(result.nodes).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it('وقتی نبریده، `truncated` دروغ نمی‌گوید', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      const result = await sql.neighbors('a', {
        direction: 'out',
        depth: 5,
        minConfidence: 0,
        maxNodes: 100,
      });
      expect(result.truncated).toBe(false);
    });

    it('رابطه‌ای که جدول ندارد، خطا می‌دهد نه نتیجهٔ خالی', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      await expect(
        sql.neighbors('a', { relations: ['layers'], minConfidence: 0 })
      ).rejects.toThrow(/layers/);
    });
  });

  describe('ایندکس‌های پیمایش', () => {
    it('`type_graph` از سمت `child` ایندکس دارد — نه اسکن کامل', async () => {
      await writeAndOpen(fixtureIndex());
      const plan = await db!.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT parent FROM type_graph WHERE child = ?',
        ['Child']
      );
      const detail = plan.map(row => row.detail).join(' | ');
      expect(detail).toMatch(/SEARCH/);
      expect(detail).not.toMatch(/SCAN type_graph/);
    });

    it('هر شاخهٔ پیمایش از یک ایندکس استفاده می‌کند، نه اسکن', async () => {
      const sql = await writeAndOpen(fixtureIndex());
      await sql.ensureIndexes();

      /*
      | این آزمون همان چیزی را قفل می‌کند که طراحی را تعیین کرد:
      | یک VIEW روی اجتماع سه جدول، هر گام بازگشت را به اسکن کامل
      | هر سه جدول تبدیل می‌کرد (۳۲۰ms در برابر ۶ms روی ایندکس
      | واقعی). اگر کسی روزی SQL را «تمیز» کند، این‌جا قرمز
      | می‌شود.
      */
      for (const [table, column] of [
        ['call_graph', 'caller'],
        ['dependency_graph', 'from_id'],
        ['type_graph', 'child'],
      ] as const) {
        const plan = await db!.all<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${column} = ?`,
          ['a']
        );
        const detail = plan.map(row => row.detail).join(' | ');
        expect(`${table}: ${detail}`).toMatch(/SEARCH/);
      }
    });
  });
});
