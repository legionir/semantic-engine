/**
 * GraphQueryEngine — یک پیمایش‌گر، به‌جای چهار پیمایش hardcode — GAP-01.
 *
 * امروز هر ابزاری که به گراف نیاز دارد پیمایش خودش را دارد.
 * `ImpactAnalysisTool` نمونهٔ گویا است و SE-AI-03 دقیقاً همان را
 * توصیف می‌کند:
 *
 * ```ts
 * const visited = new Set();                       // سراسری
 * const traverse = (id, depth, weight) => {        // DFS بازگشتی
 *   if (visited.has(id)) return;                   // ← گرهٔ نزدیک را از دست می‌دهد
 *   …
 *   if (scores.size >= limit) return;              // ← برش وسط پیمایش
 * };
 * ```
 *
 * دو خطا در چهار خط. `visited` سراسری در DFS یعنی گره‌ای که یک‌بار در
 * عمق ۳ دیده شده، بعداً از مسیر عمق ۱ نادیده گرفته می‌شود — پس
 * «نزدیک‌ترین‌ها» نتیجه نمی‌دهد، «اولین‌هایی که تصادفاً دیده شدند»
 * می‌دهد. و برش `limit` وسط پیمایش یعنی مجموعهٔ خروجی تابعِ **ترتیب
 * پیمایش** است، نه امتیاز.
 *
 * ── تصمیم‌ها ────────────────────────────────────────────────────────
 *
 * **BFS.** با BFS، اولین باری که یک گره دیده می‌شود از کوتاه‌ترین
 * مسیر است. همان `visited` که در DFS باگ می‌سازد، اینجا درست است.
 *
 * **سقف روی گره‌های بازدیدشده، نه فقط عمق.** عمق ۳ روی یک گراف
 * متراکم می‌تواند ده‌ها هزار گره باشد. سقف صریح است و وقتی به آن
 * می‌خوریم، خروجی `truncated: true` دارد — «نگاه نکردیم» با «چیزی
 * نبود» یکی نیست.
 *
 * **حلقه‌ها.** گراف وابستگی حلقه دارد. `visited` جلوی حلقهٔ بی‌پایان
 * را می‌گیرد و `cyclic` گزارش می‌کند که حلقه دیده شده است.
 *
 * **`minConfidence` پیش‌فرض روشن.** از فاز ۱۹ هر یال `provenance`
 * دارد و یال `name-match` اعتمادش ۴۰ است. پیمایشِ بدون فیلتر یعنی
 * «مسیر مطمئنِ غلط» — که از نداشتن مسیر بدتر است.
 */

import { ProjectIndex } from '../core/types/project-index.types';
import { HIGH_CONFIDENCE_THRESHOLD } from './EdgeProvenance';
export * from './graphQueryTypes';
export { reverseEdge } from './graphEdgeConverters';
import {
  ALL_RELATIONS, DEFAULT_GRAPH_DEPTH, DEFAULT_GRAPH_DIRECTION, DEFAULT_GRAPH_MAX_NODES,
  DEFAULT_GRAPH_MIN_CONFIDENCE, DEFAULT_GRAPH_PATH_DEPTH, Direction, GraphEdge, GraphQueryEngineOptions,
  GraphRelation, PathResult, PathStep, SubgraphResult, TraversalOptions, TraversalResult, VisitedNode,
} from './graphQueryTypes';
import { callEdge, dependencyEdge, typeEdge } from './graphEdgeConverters';
import { FactStore, FactStoreStats, ResolvedFact } from '../facts/FactStore';

/** آنچه یک یال جز خود رابطه حمل می‌کند. */
interface EdgeAttributes {
  readonly relation: GraphRelation;
  readonly kind: string;
}

/** ادعای حل‌شده، دوباره به شکل یالی که مصرف‌کننده‌ها می‌شناسند. */
function edgeOf(fact: ResolvedFact<EdgeAttributes>): GraphEdge {
  return {
    from: fact.subject,
    to: fact.object,
    relation: fact.attributes?.relation ?? (fact.predicate as GraphRelation),
    kind: fact.attributes?.kind ?? '',
    confidence: fact.provenance.confidence,
    basis: fact.provenance.basis,
    extractor: fact.provenance.extractor,
    contested: fact.contested,
    superseded: fact.superseded,
  };
}

/** Shared runtime validation for in-memory and SQLite traversals. */
export function validateGraphTraversalOptions(options: Partial<TraversalOptions>): void {
  if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 0)) {
    throw new Error('depth must be a non-negative integer');
  }
  if (options.maxNodes !== undefined && (!Number.isInteger(options.maxNodes) || options.maxNodes < 0)) {
    throw new Error('maxNodes must be a non-negative integer');
  }
  if (options.minConfidence !== undefined && (!Number.isFinite(options.minConfidence) || options.minConfidence < 0)) {
    throw new Error('minConfidence must be a finite non-negative number');
  }
  if (options.direction !== undefined && !['out', 'in', 'both'].includes(options.direction)) {
    throw new Error('direction must be out, in, or both');
  }
  if (options.relations !== undefined && options.relations.some(relation => !ALL_RELATIONS.includes(relation))) {
    throw new Error('relations contains an unsupported graph relation');
  }
}

export class GraphQueryEngine {
  /** یال‌های بیرون‌رونده، به‌ازای هر گره. */
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();

  constructor(index: ProjectIndex, options: GraphQueryEngineOptions = {}) {
    const graphs = index.graphs;
    /*
    | فاز ۴۹ — یال‌ها مستقیم وارد نقشهٔ مجاورت نمی‌شوند، اول از
    | `FactStore` رد می‌شوند.
    |
    | دلیلش یک باگ اندازه‌گیری‌شده است، نه سلیقهٔ معماری: روی ایندکس
    | واقعی، جفت `d9316b2b→695a7f20` هم یال `name-match(40)` داشت و
    | هم `import-resolved(85)`. `add()` هر دو را در یک آرایه
    | می‌ریخت و BFS اولی را برمی‌داشت، پس `path()` می‌گفت
    | «weakestLink: 40، این مسیر حدس است» در حالی که شاهد ۸۵ در
    | همان آرایه بود. یال بیرون‌آمده باید قوی‌ترین ادعا باشد، نه
    | زودترین.
    |
    | سود دوم: ۲۱۰ سطر مازادِ عین‌به‌عین (۱۹۰ کلید) در همان ایندکس
    | به یک یال جمع می‌شوند.
    */
    const facts = new FactStore<EdgeAttributes>();
    for (const edge of graphs?.dependencyGraph ?? []) this.claim(facts, dependencyEdge(edge));
    for (const edge of graphs?.callGraph ?? []) this.claim(facts, callEdge(edge));
    for (const edge of graphs?.typeGraph ?? []) this.claim(facts, typeEdge(edge));
    /*
    | یال‌های بین‌لایه‌ای (فاز ۴۷) از بیرون تزریق می‌شوند، چون
    | ساختنشان به blueprint نیاز دارد و این کلاس فقط ایندکس را
    | می‌شناسد. تزریق، وابستگی را یک‌طرفه نگه می‌دارد.
    */
    for (const edge of options.extraEdges ?? []) this.claim(facts, edge);
    /*
    | گراف معکوس عمداً وارد نمی‌شود: همان یال‌های بالاست از سمت
    | دیگر، و افزودنش هر یال را دوبار می‌شمرد. جهت `in` از نقشهٔ
    | `incoming` می‌آید که همین‌جا ساخته می‌شود.
    */
    for (const resolved of facts.resolve()) this.add(edgeOf(resolved));
    this.factStats = facts.stats();
  }

  /**
   * آمار لایهٔ ادعا — چند ادعا به چند رابطه رسید.
   *
   * بیرون داده می‌شود چون تنها راه دیدن اینکه دو منبع کجا اختلاف
   * داشتند همین است، و بدون آن «قوی‌ترین برنده شد» یک ادعای
   * غیرقابل‌بررسی می‌ماند.
   */
  readonly factStats: FactStoreStats;

  private claim(store: FactStore<EdgeAttributes>, edge: GraphEdge | null): void {
    if (!edge) return;
    store.add({
      subject: edge.from,
      predicate: edge.relation,
      object: edge.to,
      provenance: {
        extractor: edge.extractor ?? 'derived',
        confidence: edge.confidence,
        basis: edge.basis,
      },
      attributes: { relation: edge.relation, kind: edge.kind },
    });
  }

  /** آیا این گره اصلاً در گراف هست؟ */
  has(nodeId: string): boolean {
    return this.outgoing.has(nodeId) || this.incoming.has(nodeId);
  }

  /**
   * یال‌های یک گره، فیلترشده.
   *
   * بیرون داده می‌شود چون `SubgraphExplorer` (فاز ۴۱) همین را
   * لازم دارد و کپی کردنش یعنی دو تعریف از «یال قابل پیمایش».
   */
  edgesFrom(
    nodeId: string,
    direction: Direction,
    relations?: readonly GraphRelation[],
    minConfidence?: number
  ): readonly GraphEdge[] {
    validateGraphTraversalOptions({ direction, relations, minConfidence });
    return this.edgesOf(nodeId, direction, relations ?? ALL_RELATIONS, minConfidence);
  }

  /** چند گره در گراف هست — برای گزارش و آزمون. */
  get nodeCount(): number {
    const ids = new Set<string>();
    for (const id of this.outgoing.keys()) ids.add(id);
    for (const id of this.incoming.keys()) ids.add(id);
    return ids.size;
  }

  get edgeCount(): number {
    let total = 0;
    for (const edges of this.outgoing.values()) total += edges.length;
    return total;
  }

  /**
   * همسایه‌ها تا عمق داده‌شده — BFS.
   *
   * گرهٔ شروع در نتیجه نیست: کسی که «همسایه‌های X» می‌پرسد، X را
   * می‌شناسد.
   */
  neighbors(nodeId: string, options: TraversalOptions = {}): TraversalResult {
    return this.bfs([nodeId], options);
  }

  /** هرچه به این گره می‌رسد (وابسته‌ها، فراخوان‌ها، فرزندان نوع). */
  ancestors(nodeId: string, options: TraversalOptions = {}): TraversalResult {
    return this.bfs([nodeId], { ...options, direction: 'in' });
  }

  /** هرچه این گره به آن می‌رسد. */
  descendants(nodeId: string, options: TraversalOptions = {}): TraversalResult {
    return this.bfs([nodeId], { ...options, direction: 'out' });
  }

  /** فراخوانندگان مستقیم. */
  callers(symbolId: string, options: TraversalOptions = {}): readonly GraphEdge[] {
    validateGraphTraversalOptions(options);
    return this.edgesOf(symbolId, 'in', ['calls'], options.minConfidence);
  }

  /** فراخوانده‌شده‌های مستقیم. */
  callees(symbolId: string, options: TraversalOptions = {}): readonly GraphEdge[] {
    validateGraphTraversalOptions(options);
    return this.edgesOf(symbolId, 'out', ['calls'], options.minConfidence);
  }

  /**
   * کوتاه‌ترین مسیر، و صادق دربارهٔ کیفیتش.
   *
   * اول فقط با یال‌های مطمئن جست‌وجو می‌شود. اگر مسیری نبود، دوباره
   * با همهٔ یال‌ها — و نتیجه با `confident: false` و فهرست یال‌های
   * ضعیف برمی‌گردد. مصرف‌کننده باید بتواند بگوید «مسیر هست ولی از
   * روی حدسِ نام».
   */
  path(fromId: string, toId: string, options: TraversalOptions = {}): PathResult {
    const threshold = options.minConfidence ?? DEFAULT_GRAPH_MIN_CONFIDENCE;

    const strong = this.shortestPath(fromId, toId, { ...options, minConfidence: threshold });
    if (strong.path) return strong;

    if (threshold <= 0) return strong;

    const weak = this.shortestPath(fromId, toId, { ...options, minConfidence: 0 });
    return weak;
  }

  /**
   * زیرگراف اطراف چند دانه.
   *
   * از فاز ۴۱ این فقط یک نما روی `SubgraphExplorer` است. داشتن دو
   * پیاده‌سازی از یک مفهوم — یکی که با ترتیب پیمایش می‌برد و یکی
   * که با امتیاز — همان چیزی است که فاز ۳۹ برای پیمایش از بین برد.
   */
  subgraph(seeds: readonly string[], options: TraversalOptions = {}): SubgraphResult {
    validateGraphTraversalOptions(options);
    /*
    | require تنبل و درون‌متدی: `SubgraphExplorer` خودش این کلاس را
    | import می‌کند و import ایستای دوطرفه در CommonJS یکی از دو
    | ماژول را نیمه‌ساخته تحویل می‌دهد.
    */
    const { SubgraphExplorer } = require('./SubgraphExplorer') as typeof import('./SubgraphExplorer');
    const explorer = new SubgraphExplorer(this);

    const result = explorer.explore(seeds, {
      maxNodes: options.maxNodes ?? DEFAULT_GRAPH_MAX_NODES,
      maxDepth: options.depth ?? DEFAULT_GRAPH_DEPTH,
      direction: options.direction ?? DEFAULT_GRAPH_DIRECTION,
      relations: options.relations,
      minConfidence: options.minConfidence,
    });

    return {
      nodes: result.nodes.map(node => ({
        id: node.id,
        depth: node.depth,
        pathConfidence: node.pathConfidence,
        via: node.via,
      })),
      edges: result.edges,
      truncated: result.truncated,
      seeds: result.seeds,
    };
  }

  // ── درون ────────────────────────────────────────────────────────────

  private add(edge: GraphEdge | null): void {
    if (!edge) return;
    const out = this.outgoing.get(edge.from);
    if (out) out.push(edge);
    else this.outgoing.set(edge.from, [edge]);

    const into = this.incoming.get(edge.to);
    if (into) into.push(edge);
    else this.incoming.set(edge.to, [edge]);
  }

  private edgesOf(
    nodeId: string,
    direction: Direction,
    relations: readonly GraphRelation[],
    minConfidence?: number
  ): GraphEdge[] {
    const options: TraversalOptions = { relations, minConfidence };
    const collected: GraphEdge[] = [];
    if (direction === 'out' || direction === 'both') {
      collected.push(...(this.outgoing.get(nodeId) ?? []).filter(edge => this.passes(edge, options)));
    }
    if (direction === 'in' || direction === 'both') {
      collected.push(...(this.incoming.get(nodeId) ?? []).filter(edge => this.passes(edge, options)));
    }
    return collected;
  }

  private passes(edge: GraphEdge, options: TraversalOptions): boolean {
    const relations = options.relations ?? ALL_RELATIONS;
    if (!relations.includes(edge.relation)) return false;
    const threshold = options.minConfidence ?? DEFAULT_GRAPH_MIN_CONFIDENCE;
    return edge.confidence >= threshold;
  }

  /**
   * پیمایش سطح‌به‌سطح.
   *
   * `visited` اینجا امن است چون BFS اولین بار از کوتاه‌ترین مسیر
   * می‌رسد — همان چیزی که در DFS باگ SE-AI-03 را می‌ساخت.
   */
  private bfs(starts: readonly string[], options: TraversalOptions): TraversalResult {
    validateGraphTraversalOptions(options);
    const depthLimit = options.depth ?? DEFAULT_GRAPH_DEPTH;
    const maxNodes = options.maxNodes ?? DEFAULT_GRAPH_MAX_NODES;
    const direction = options.direction ?? 'out';

    const visited = new Set<string>(starts);
    const result: VisitedNode[] = [];
    let queue: VisitedNode[] = starts.map(id => ({
      id,
      depth: 0,
      pathConfidence: 100,
      via: null,
    }));
    let truncated = false;
    let cyclic = false;

    /*
    | `byId` برای این است که «دوباره‌دیدن» را از «حلقه» جدا کنیم.
    |
    | نسخهٔ قبلی هر همسایهٔ دیدهنشده را حلقه می‌شمرد، ولی در BFS یک لوزی
    | (A→B، A→C، B→D، C→D) دقیقاً همان شرط را برآورده می‌کند: D دومین بار
    | از مسیر دیگر دیده می‌شود. روی `apps/web/src/config.ts` همین باعث شد
    | `impact_analysis` برای یک فایل با **صفر یال خروجی** `cyclic: true`
    | بدهد. حلقه فقط وقتی حلقه است که گره روی مسیر جاری باشد — یا مبدأِ
    | خودش باشد.
    */
    const byId = new Map<string, VisitedNode>();
    const startsSet = new Set(starts);

    const onCurrentPath = (from: VisitedNode, id: string): boolean => {
      if (from.id === id) return true;              // خودحلقه
      if (startsSet.has(id)) return true;            // برگشت به مبدأ
      const walked = new Set<string>();
      let cursor: VisitedNode | undefined = from;
      while (cursor) {
        if (cursor.id === id) return true;
        if (walked.has(cursor.id)) return false;
        walked.add(cursor.id);
        const parent: VisitedNode | undefined = cursor.via ? byId.get(cursor.via.from) : undefined;
        cursor = parent;
      }
      return false;
    };

    for (let depth = 0; depth < depthLimit && queue.length > 0; depth++) {
      const next: VisitedNode[] = [];

      for (const current of queue) {
        for (const edge of this.edgesOf(current.id, direction, options.relations ?? ALL_RELATIONS, options.minConfidence)) {
          const neighbour = edge.from === current.id ? edge.to : edge.from;
          if (visited.has(neighbour)) {
            if (onCurrentPath(current, neighbour)) cyclic = true;
            continue;
          }
          if (result.length >= maxNodes) {
            truncated = true;
            break;
          }

          visited.add(neighbour);
          const node: VisitedNode = {
            id: neighbour,
            depth: depth + 1,
            pathConfidence: Math.min(current.pathConfidence, edge.confidence),
            via: edge,
          };
          byId.set(node.id, node);
          result.push(node);
          next.push(node);
        }
        if (truncated) break;
      }

      if (truncated) break;
      queue = next;
    }

    return { nodes: result, truncated, cyclic, visitedCount: visited.size };
  }

  private shortestPath(fromId: string, toId: string, options: TraversalOptions): PathResult {
    validateGraphTraversalOptions(options);
    const maxNodes = options.maxNodes ?? DEFAULT_GRAPH_MAX_NODES;
    /*
    | پرس‌وجوی «مسیر بین دو گرهٔ مشخص» با سقفِ عمقِ ۲ — پیش‌فرضِ
    | پرس‌وجوهای همسایگی — عملاً همیشه null می‌دهد. معیار پذیرش فاز
    | ۴۷ مسیرِ پنج‌گامیِ `API /login → Database` را فقط با
    | `minConfidence: 0` می‌خواهد و این حق است: کسی که گرهٔ مقصد
    | را داده، عمق را نمی‌داند. پس اینجا پیش‌فرض، بی‌سقف است و
    | تنها مهار، `maxNodes` و تمام‌شدنِ مؤلفهٔ همبندی است؛ عمقِ
    | داده‌شده‌شدهٔ صریح همچنان respected است.
    */
    const depthLimit = options.depth ?? DEFAULT_GRAPH_PATH_DEPTH;
    const direction = options.direction ?? 'out';

    if (fromId === toId) {
      return {
        path: [{ node: fromId, via: null }],
        confident: true,
        weakestLink: 100,
        weakEdges: [],
        truncated: false,
      };
    }

    const cameFrom = new Map<string, { previous: string; edge: GraphEdge }>();
    const visited = new Set<string>([fromId]);
    let queue = [fromId];
    let truncated = false;

    for (let depth = 0; depth < depthLimit && queue.length > 0; depth++) {
      const next: string[] = [];

      for (const current of queue) {
        for (const edge of this.edgesOf(current, direction, options.relations ?? ALL_RELATIONS, options.minConfidence)) {
          const neighbour = edge.from === current ? edge.to : edge.from;
          if (visited.has(neighbour)) continue;
          visited.add(neighbour);
          cameFrom.set(neighbour, { previous: current, edge });

          // maxNodes bounds discovered nodes (the start is not an output
          // node), matching bfs()/SQLite neighbors().
          if (visited.size - 1 > maxNodes) {
            truncated = true;
            break;
          }
          if (neighbour === toId) {
            return this.buildPath(fromId, toId, cameFrom, truncated);
          }

          next.push(neighbour);
        }
        if (truncated) break;
      }

      if (truncated) break;
      queue = next;
    }

    return { path: null, confident: false, weakestLink: 0, weakEdges: [], truncated };
  }

  private buildPath(
    fromId: string,
    toId: string,
    cameFrom: ReadonlyMap<string, { previous: string; edge: GraphEdge }>,
    truncated: boolean
  ): PathResult {
    const steps: PathStep[] = [];
    let current = toId;

    while (current !== fromId) {
      const previous = cameFrom.get(current);
      if (!previous) break;
      steps.unshift({ node: current, via: previous.edge });
      current = previous.previous;
    }
    steps.unshift({ node: fromId, via: null });

    const edges = steps.map(step => step.via).filter((edge): edge is GraphEdge => edge !== null);
    const weakestLink = edges.reduce((lowest, edge) => Math.min(lowest, edge.confidence), 100);
    const weakEdges = edges.filter(edge => edge.confidence < HIGH_CONFIDENCE_THRESHOLD);

    return {
      path: steps,
      confident: weakEdges.length === 0,
      weakestLink,
      weakEdges,
      truncated,
    };
  }
}

