/**
 * SqliteGraphQuery — GAP-10، پیمایش گراف بدون بارگذاری گراف.
 *
 * ── چرا، با عدد ──────────────────────────────────────────────────────
 *
 * `GraphQueryEngine` کل ایندکس را در حافظه می‌خواهد. روی ایندکس
 * واقعی `semantic-engine/src` — که پروژهٔ بزرگی نیست — این یعنی:
 *
 * ```
 * project-index.json                       25.6 MB روی دیسک
 * خواندن + JSON.parse                      228ms
 * RSS پس از parse                          122 MB
 * RSS پس از ساخت GraphQueryEngine          136 MB
 * ```
 *
 * همان پرس‌وجوها روی SQLite:
 *
 * ```
 * باز کردن پایگاه داده                      0ms
 * RSS                                       46 MB
 * ۵۰ پیمایش بازگشتی عمق ۳                    2ms
 * ```
 *
 * ۱۳۶ مگابایت برای ۳۲۴ فایل. مخزنی ده برابر این، ایندکسش در حافظهٔ
 * یک فرایند Node پیش‌فرض جا نمی‌شود. `GRAPH-INTELLIGENCE-GAPS.md`
 * همین را گفته بود: «زمانی لازم می‌شود که گراف در حافظه جا نشود».
 *
 * ── چرا VIEW نه ─────────────────────────────────────────────────────
 *
 * طراحی بدیهی این است که یک `VIEW graph_edges` روی اجتماع سه جدول
 * ساخته شود و پیمایش روی آن نوشته شود. **اندازه‌گیری شد و ۵۳ برابر
 * کندتر بود:**
 *
 * ```
 * WITH RECURSIVE روی VIEW (اجتماع سه جدول)   320ms  /  ۵۰ دانه
 * WITH RECURSIVE با سه شاخهٔ مستقیم             6ms  /  ۵۰ دانه
 * ```
 *
 * دلیلش در `EXPLAIN QUERY PLAN` پیداست: SQLite نمی‌تواند شرط
 * `from_id = ?` را به داخل یک `UNION ALL` که درون یک CTE بازگشتی
 * است هُل بدهد، پس هر گام بازگشت **هر سه جدول را کامل اسکن می‌کند**
 * و یک ایندکس موقت می‌سازد (`SCAN call_graph` … `AUTOMATIC PARTIAL
 * COVERING INDEX`). با سه شاخهٔ جدا، هر شاخه ایندکس واقعی خودش را
 * می‌گیرد (`SEARCH e USING INDEX idx_call_graph_caller`).
 *
 * پس این‌جا SQL تکرار شده، عمداً. انتزاعِ خوانا در این یک مورد
 * پنجاه برابر گران است.
 *
 * ── هم‌خوانی با نسخهٔ حافظه‌ای ───────────────────────────────────────
 *
 * دو پیمایش که دو جواب بدهند از یکی که کند است بدتر است. سه قاعدهٔ
 * `GraphQueryEngine` این‌جا هم رعایت می‌شود:
 *
 * ۱. یال به بستهٔ بیرونی (`pkg:…`) گره نیست و وارد پیمایش نمی‌شود.
 * ۲. جهت یال نوع، از فرزند به والد است.
 * ۳. **قوی‌ترین ادعا برندهٔ هر رابطه است** (فاز ۴۹، همان کاری که
 *    `FactStore` در حافظه می‌کند) — این‌جا با `MAX(confidence)` و
 *    گروه‌بندی روی سه‌تایی.
 *
 * روی ایندکس واقعی، هر دو مسیر ۱۲٬۵۹۸ رابطهٔ یکتا می‌شمارند و برای
 * ۵۰ دانه در عمق ۳ مجموعهٔ گره و عمق **یکسان** می‌دهند.
 */

import { SqliteDriver } from './SqliteDriver';
import {
  GraphRelation,
  Direction,
  GraphEdge,
  DEFAULT_GRAPH_DEPTH,
  DEFAULT_GRAPH_PATH_DEPTH,
  DEFAULT_GRAPH_DIRECTION,
  DEFAULT_GRAPH_MAX_NODES,
  DEFAULT_GRAPH_MIN_CONFIDENCE,
  validateGraphTraversalOptions,
} from '../../graphs/GraphQueryEngine';
import { HIGH_CONFIDENCE_THRESHOLD } from '../../graphs/EdgeProvenance';

/**
 * `layers` عمداً نیست: یال‌های بین‌لایه‌ای فاز ۴۷ از blueprint ساخته
 * می‌شوند و هیچ جدولی در پایگاه داده ندارند. برگرداندن نتیجهٔ خالی
 * برای آن‌ها یعنی «لایه‌ای نیست»، که دروغ است — پس درخواستشان خطا
 * می‌دهد.
 */
const STORED_RELATIONS: readonly GraphRelation[] = ['imports', 'calls', 'types'];

export interface SqliteTraversalOptions {
  readonly direction?: Direction;
  readonly depth?: number;
  readonly relations?: readonly GraphRelation[];
  /** پیش‌فرض ۷۰ — همان آستانهٔ `GraphQueryEngine`. `0` یعنی همه‌چیز. */
  readonly minConfidence?: number;
  /** سقف گره. پیش‌فرض ۵۰۰۰. */
  readonly maxNodes?: number;
}

export interface SqliteVisitedNode {
  readonly id: string;
  readonly depth: number;
}

export interface SqliteTraversalResult {
  readonly nodes: readonly SqliteVisitedNode[];
  readonly truncated: boolean;
}

export interface SqlitePathResult {
  readonly path: readonly string[] | null;
  readonly confident: boolean;
  readonly weakestLink: number;
}

/** یک شاخهٔ پیمایش: کدام جدول، کدام ستون مبدأ، کدام ستون مقصد. */
interface Branch {
  readonly relation: GraphRelation;
  readonly table: string;
  readonly from: string;
  readonly to: string;
  /** شرط اضافه‌ای که فقط این جدول دارد. */
  readonly filter?: string;
}

const BRANCHES: Readonly<Record<'imports' | 'calls' | 'types', Branch>> = {
  calls: { relation: 'calls', table: 'call_graph', from: 'caller', to: 'callee' },
  imports: {
    relation: 'imports',
    table: 'dependency_graph',
    from: 'from_id',
    to: 'to_id',
    filter: "to_id NOT LIKE 'pkg:%'",
  },
  types: { relation: 'types', table: 'type_graph', from: 'child', to: 'parent' },
};

function branchesFor(relations: readonly GraphRelation[] | undefined): readonly Branch[] {
  const wanted = relations ?? STORED_RELATIONS;
  return wanted.map(relation => {
    const branch = BRANCHES[relation as 'imports' | 'calls' | 'types'];
    if (!branch) {
      throw new Error(
        `relation "${relation}" is not stored in SQLite; it is built in memory from the blueprint`
      );
    }
    return branch;
  });
}

/**
 * یک شاخه، در جهت خواسته‌شده.
 *
 * `both` یعنی دو شاخه — یکی رو به جلو و یکی برعکس. تولید هر دو
 * این‌جا انجام می‌شود تا `SELECT`ها هیچ‌وقت روی جهت شرط نگذارند.
 */
function validateTraversalBound(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function directed(branch: Branch, direction: Direction): readonly { from: string; to: string; table: string; filter?: string }[] {
  const forward = { table: branch.table, from: branch.from, to: branch.to, filter: branch.filter };
  const backward = { table: branch.table, from: branch.to, to: branch.from, filter: branch.filter };
  if (direction === 'out') return [forward];
  if (direction === 'in') return [backward];
  return [forward, backward];
}

export class SqliteGraphQuery {
  constructor(private readonly db: SqliteDriver) {}

  /**
   * ایندکس‌هایی که پیمایش لازم دارد ولی `SQLiteExporter` نمی‌ساخت.
   *
   * روی پایگاه دادهٔ موجود هم امن است — همه `IF NOT EXISTS`. برای
   * پایگاه دادهٔ تازه، `SQLiteExporter` خودش همین‌ها را می‌سازد؛
   * این متد برای فایل‌هایی است که پیش از فاز ۴۹ نوشته شده‌اند.
   */
  static readonly TRAVERSAL_INDEXES = `
    CREATE INDEX IF NOT EXISTS idx_type_graph_child ON type_graph(child);
    CREATE INDEX IF NOT EXISTS idx_type_graph_parent ON type_graph(parent);
  `;

  async ensureIndexes(): Promise<void> {
    await this.db.exec(SqliteGraphQuery.TRAVERSAL_INDEXES);
  }

  /** چند رابطهٔ یکتا در پایگاه داده هست — معادل `edgeCount` حافظه‌ای. */
  async edgeCount(): Promise<number> {
    const parts = STORED_RELATIONS.map(relation => {
      const branch = BRANCHES[relation as 'imports' | 'calls' | 'types'];
      const where = branch.filter ? ` WHERE ${branch.filter}` : '';
      return `SELECT DISTINCT ${branch.from} AS a, ${branch.to} AS b, '${relation}' AS r FROM ${branch.table}${where}`;
    });
    const rows = await this.db.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (${parts.join(' UNION ALL ')})`
    );
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * قوی‌ترین ادعا برای هر رابطه‌ای که از این گره می‌رود.
   *
   * `MAX(confidence)` به‌همراه ستون‌های برهنه: SQLite تضمین می‌کند
   * ستون‌های برهنه از همان سطری می‌آیند که `MAX` را داده — پس
   * `basis` با `confidence` جور است و ترکیبی از دو سطر ساخته
   * نمی‌شود.
   */
  async edgesFrom(
    nodeId: string,
    direction: Direction = 'out',
    relations?: readonly GraphRelation[],
    minConfidence = DEFAULT_GRAPH_MIN_CONFIDENCE
  ): Promise<readonly GraphEdge[]> {
    validateGraphTraversalOptions({ direction, relations, minConfidence });
    const edges: GraphEdge[] = [];

    for (const branch of branchesFor(relations)) {
      for (const leg of directed(branch, direction)) {
        const filter = leg.filter ? ` AND ${leg.filter}` : '';
        const rows = await this.db.all<{
          a: string;
          b: string;
          kind: string;
          confidence: number;
          basis: string;
          extractor: string;
        }>(
          `SELECT ${leg.from} AS a, ${leg.to} AS b, kind, MAX(confidence) AS confidence, basis, extractor
             FROM ${leg.table}
            WHERE ${leg.from} = ?${filter}
            GROUP BY ${leg.from}, ${leg.to}
           HAVING MAX(confidence) >= ?`,
          [nodeId, minConfidence]
        );

        for (const row of rows) {
          edges.push({
            from: row.a,
            to: row.b,
            relation: branch.relation,
            kind: row.kind,
            confidence: Number(row.confidence),
            basis: row.basis,
            extractor: (row.extractor as GraphEdge['extractor']) ?? undefined,
          });
        }
      }
    }

    return edges;
  }

  /** همسایه‌ها تا عمق داده‌شده — گرهٔ شروع در نتیجه نیست. */
  async neighbors(
    nodeId: string,
    options: SqliteTraversalOptions = {}
  ): Promise<SqliteTraversalResult> {
    validateGraphTraversalOptions(options);
    const depth = options.depth ?? DEFAULT_GRAPH_DEPTH;
    const minConfidence = options.minConfidence ?? DEFAULT_GRAPH_MIN_CONFIDENCE;
    const maxNodes = options.maxNodes ?? DEFAULT_GRAPH_MAX_NODES;
    const direction = options.direction ?? DEFAULT_GRAPH_DIRECTION;
    validateTraversalBound('depth', depth);
    validateTraversalBound('maxNodes', maxNodes);

    const legs = branchesFor(options.relations).flatMap(branch => directed(branch, direction));

    /*
    | `e.<to> <> seed` لازم است و کاشفش همین آزمون‌های هم‌خوانی
    | بودند: در جهت `both`، مسیر `a → b → a` گرهٔ شروع را در عمق ۲
    | برمی‌گرداند. نسخهٔ حافظه‌ای این را نمی‌دهد، چون دانه از همان
    | ابتدا در مجموعهٔ `visited` است. کسی که «همسایه‌های a» را
    | می‌پرسد، a را می‌شناسد.
    */
    const steps = legs.map(leg => {
      const filter = leg.filter ? ` AND e.${leg.filter}` : '';
      return `SELECT e.${leg.to}, r.depth + 1, r.trail || '>' || e.${leg.to} || '>'
                FROM ${leg.table} e JOIN reach r ON e.${leg.from} = r.id
               WHERE r.depth < ? AND e.confidence >= ? AND e.${leg.to} <> ?${filter}
                 AND instr(r.trail, '>' || e.${leg.to} || '>') = 0`;
    });

    /*
    | `LIMIT` روی خودِ CTE، نه روی SELECT بیرونی: SQLite بازگشت را
    | همان‌جا که به سقف رسید متوقف می‌کند. اگر بیرون بگذاریمش، کل
    | زیرگراف ساخته می‌شود و بعد دور ریخته — یعنی سقف، از حافظه
    | محافظت نمی‌کند.
    |
    | یکی بیشتر می‌خواهیم تا بشود فهمید بریده شده یا نه.
    */
    const sql = `
      WITH RECURSIVE reach(id, depth, trail) AS (
        SELECT ?, 0, '>' || ? || '>'
        UNION
        ${steps.join('\n        UNION\n        ')}
        LIMIT ?
      )
      SELECT id, MIN(depth) AS depth FROM reach WHERE depth > 0 GROUP BY id ORDER BY depth, id`;

    const params: unknown[] = [nodeId, nodeId];
    for (const _leg of legs) params.push(depth, minConfidence, nodeId);
    params.push(maxNodes + 2);

    const rows = await this.db.all<{ id: string; depth: number }>(sql, params);
    const truncated = rows.length > maxNodes;
    const nodes = (truncated ? rows.slice(0, maxNodes) : rows).map(row => ({
      id: row.id,
      depth: Number(row.depth),
    }));

    return { nodes, truncated };
  }

  async descendants(
    nodeId: string,
    options: SqliteTraversalOptions = {}
  ): Promise<SqliteTraversalResult> {
    return this.neighbors(nodeId, { ...options, direction: 'out' });
  }

  async ancestors(
    nodeId: string,
    options: SqliteTraversalOptions = {}
  ): Promise<SqliteTraversalResult> {
    return this.neighbors(nodeId, { ...options, direction: 'in' });
  }

  /**
   * کوتاه‌ترین مسیر، با همان سیاست دو مرحله‌ای نسخهٔ حافظه‌ای: اول
   * فقط با یال‌های مطمئن، و اگر نبود با همه‌چیز و اعلام صادقانه.
   *
   * مسیر در خود پرس‌وجو ساخته می‌شود (`trail`) و `instr` جلوی حلقه
   * را می‌گیرد. جست‌وجو عمداً با جداکنندهٔ دو طرف انجام می‌شود
   * (`'>'||id||'>'`): بدون آن، شناسه‌ای که زیررشتهٔ شناسهٔ دیگری
   * است گره‌ای را «دیده‌شده» اعلام می‌کند که هرگز دیده نشده. اینجا `UNION ALL` لازم است نه `UNION`: با `UNION`
   * سطرها روی کل ستون‌ها یکتا می‌شوند و چون `trail` بخشی از سطر
   * است، یکتاسازی هیچ کاری نمی‌کند جز هزینه.
   */
  async path(
    fromId: string,
    toId: string,
    options: SqliteTraversalOptions = {}
  ): Promise<SqlitePathResult> {
    const threshold = options.minConfidence ?? HIGH_CONFIDENCE_THRESHOLD;

    const strong = await this.shortestPath(fromId, toId, options, threshold);
    if (strong) return { path: strong.path, confident: true, weakestLink: strong.weakest };

    if (threshold <= 0) return { path: null, confident: false, weakestLink: 0 };

    const weak = await this.shortestPath(fromId, toId, options, 0);
    if (!weak) return { path: null, confident: false, weakestLink: 0 };

    return {
      path: weak.path,
      confident: weak.weakest >= HIGH_CONFIDENCE_THRESHOLD,
      weakestLink: weak.weakest,
    };
  }

  private async shortestPath(
    fromId: string,
    toId: string,
    options: SqliteTraversalOptions,
    minConfidence: number
  ): Promise<{ path: string[]; weakest: number } | null> {
    validateGraphTraversalOptions(options);
    const depth = options.depth ?? DEFAULT_GRAPH_PATH_DEPTH;
    const direction = options.direction ?? DEFAULT_GRAPH_DIRECTION;
    validateTraversalBound('depth', depth);
    const legs = branchesFor(options.relations).flatMap(branch => directed(branch, direction));

    const steps = legs.map(leg => {
      const filter = leg.filter ? ` AND e.${leg.filter}` : '';
      return `SELECT e.${leg.to}, r.depth + 1, r.trail || '>' || e.${leg.to},
                     MIN(r.weakest, e.confidence)
                FROM ${leg.table} e JOIN reach r ON e.${leg.from} = r.id
               WHERE r.depth < ? AND e.confidence >= ?${filter}
                 AND instr('>' || r.trail || '>', '>' || e.${leg.to} || '>') = 0`;
    });

    const sql = `
      WITH RECURSIVE reach(id, depth, trail, weakest) AS (
        SELECT ?, 0, ?, 100
        UNION ALL
        ${steps.join('\n        UNION ALL\n        ')}
        LIMIT ?
      )
      SELECT trail, weakest FROM reach WHERE id = ? ORDER BY depth, weakest DESC LIMIT 1`;

    const params: unknown[] = [fromId, fromId];
    for (const _leg of legs) params.push(depth, minConfidence);
    params.push((options.maxNodes ?? DEFAULT_GRAPH_MAX_NODES) + 1, toId);

    const rows = await this.db.all<{ trail: string; weakest: number }>(sql, params);
    if (rows.length === 0) return null;

    return { path: rows[0]!.trail.split('>'), weakest: Number(rows[0]!.weakest) };
  }
}
