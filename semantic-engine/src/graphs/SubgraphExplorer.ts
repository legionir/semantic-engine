/**
 * SubgraphExplorer — «کل کدبیس را نده، همسایگی مرتبط را بده» — GAP-02.
 *
 * `impact_analysis` یک‌جهته و تک‌ریشه است: «اگر این را عوض کنم چه
 * می‌شکند». این چیز دیگری است — چند نامزد در دست داریم (از جست‌وجو،
 * از خطای اجرا، از فایل‌های باز) و می‌خواهیم همسایگی‌شان را تا سقف
 * یک بودجه برداریم.
 *
 * ── چرا BFS ساده کافی نیست ─────────────────────────────────────────
 *
 * `GraphQueryEngine.bfs` وقتی به سقف می‌خورد، هرچه **در آن لحظه** در
 * صف بود را نگه می‌دارد. یعنی یک همسایهٔ عمق‌یک که از یک یال با
 * اعتماد ۴۰ آمده، بر یک گرهٔ عمق‌دو با دو یال قطعی مقدم می‌شود —
 * فقط چون زودتر دیده شد. با سقف ۵۰ گره روی گرافی با هزاران گره،
 * این یعنی نتیجه بیشتر از آنکه به ارتباط ربط داشته باشد، به ترتیب
 * درج یال‌ها ربط دارد.
 *
 * معیار پذیرش این فاز دقیقاً همین است: «زیرگراف با سقف ۵۰ گره،
 * همیشه گره‌های نزدیک‌تر و مطمئن‌تر را ترجیح دهد».
 *
 * ── جست‌وجوی بهترین-اول ────────────────────────────────────────────
 *
 * امتیاز هر گره:
 *
 * ```
 * score = seedWeight × decay^depth × (ضعیف‌ترین اعتمادِ مسیر ÷ ۱۰۰)
 * ```
 *
 * چون `decay < 1` و اعتماد هیچ‌وقت بالای ۱۰۰ نمی‌رود، امتیاز روی هر
 * مسیر **یکنواخت کاهشی** است. با یک صف اولویت، وقتی گرهی بیرون
 * کشیده می‌شود هیچ مسیر بهتری به آن باقی نمانده — همان تضمینی که
 * Dijkstra می‌دهد. پس N گرهٔ نگه‌داشته‌شده، دقیقاً N گرهٔ برتر
 * به‌ترتیب امتیازند، نه N گرهٔ اولی که دیده شدند.
 *
 * ── هزینه ──────────────────────────────────────────────────────────
 *
 * صف اولویت یک heap دودویی دستی است و نه `array.sort()` در هر گام:
 * روی گراف واقعی این مخزن (۶٬۱۹۱ گره، ۱۹٬۶۷۳ یال) مرز جست‌وجو به
 * هزاران گره می‌رسد و مرتب‌سازی مکرر، کاوش را از خودِ ایندکس‌سازی
 * گران‌تر می‌کند.
 */

import { GraphEdge, GraphQueryEngine, GraphRelation, Direction } from './GraphQueryEngine';
import { HIGH_CONFIDENCE_THRESHOLD } from './EdgeProvenance';

export interface ExploreOptions {
  /** سقف گره‌های نگه‌داشته‌شده (بدون شمردن دانه‌ها). پیش‌فرض ۵۰. */
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly direction?: Direction;
  readonly relations?: readonly GraphRelation[];
  /** پیش‌فرض ۷۰ — همان آستانهٔ فاز ۱۹. */
  readonly minConfidence?: number;
  /** وزن هر دانه؛ نبودش یعنی ۱. */
  readonly seedWeights?: Readonly<Record<string, number>>;
  /** افت امتیاز به‌ازای هر گام. پیش‌فرض ۰٫۶. */
  readonly decay?: number;
  /** سقف گره‌های *بررسی‌شده* — محافظ در برابر گراف‌های بزرگ. پیش‌فرض ۵۰۰۰. */
  readonly maxVisited?: number;
}

export interface ExploredNode {
  readonly id: string;
  readonly depth: number;
  readonly score: number;
  /** ضعیف‌ترین یال روی مسیری که به این گره رسید. */
  readonly pathConfidence: number;
  readonly via: GraphEdge | null;
  /** از کدام دانه به آن رسیدیم. */
  readonly seed: string;
}

export interface ExplorationResult {
  /** به‌ترتیب امتیاز، از بیشترین. */
  readonly nodes: readonly ExploredNode[];
  readonly edges: readonly GraphEdge[];
  /** دانه‌هایی که واقعاً در گراف بودند. */
  readonly seeds: readonly string[];
  /** دانه‌هایی که در گراف نبودند — سکوت دربارهٔ آن‌ها گمراه‌کننده است. */
  readonly missingSeeds: readonly string[];
  /** به سقف خوردیم و چیزی بیرون ماند. */
  readonly truncated: boolean;
  readonly visitedCount: number;
  /** چند گره دیده شد ولی جا نشد. */
  readonly droppedCount: number;
}

const DEFAULT_MAX_NODES = 50;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_DECAY = 0.6;
const DEFAULT_MAX_VISITED = 5_000;

export class SubgraphExplorer {
  constructor(private readonly engine: GraphQueryEngine) {}

  explore(seeds: readonly string[], options: ExploreOptions = {}): ExplorationResult {
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxVisited = options.maxVisited ?? DEFAULT_MAX_VISITED;
    const decay = options.decay ?? DEFAULT_DECAY;
    const direction = options.direction ?? 'both';
    const minConfidence = options.minConfidence ?? HIGH_CONFIDENCE_THRESHOLD;

    const present: string[] = [];
    const missing: string[] = [];
    for (const seed of new Set(seeds)) {
      if (this.engine.has(seed)) present.push(seed);
      else missing.push(seed);
    }

    const frontier = new MaxHeap<ExploredNode>();
    const bestScore = new Map<string, number>();
    const settled = new Map<string, ExploredNode>();

    for (const seed of present) {
      const weight = options.seedWeights?.[seed] ?? 1;
      const node: ExploredNode = {
        id: seed,
        depth: 0,
        score: weight,
        pathConfidence: 100,
        via: null,
        seed,
      };
      bestScore.set(seed, weight);
      frontier.push(node, weight);
    }

    const kept: ExploredNode[] = [];
    let visited = 0;
    let dropped = 0;

    while (frontier.size > 0) {
      const current = frontier.pop()!;
      /*
      | نسخهٔ کهنه: همین گره قبلاً با امتیاز بهتری بیرون کشیده
      | شده. حذف از وسط heap گران است؛ رد کردنش ارزان.
      */
      if (settled.has(current.id)) continue;
      settled.set(current.id, current);
      visited++;

      if (current.depth > 0) {
        if (kept.length >= maxNodes) {
          /*
          | چون بهترین-اول است، هرچه از این به بعد بیاید امتیازش
          | کمتر است. پس شمردن باقی‌مانده کافی است و ادامهٔ گسترش
          | فقط هزینه است.
          */
          dropped += frontier.size + 1;
          return this.finish(kept, present, missing, true, visited, dropped, options);
        }
        kept.push(current);
      }

      /*
      | سقف بازدید پیش از بررسی عمق سنجیده می‌شود: روی گرهی با
      | دویست همسایه، همه‌شان در عمق یک‌اند و هرگز به شاخهٔ گسترش
      | نمی‌رسند — پس اگر بررسی آنجا باشد، سقفی که برای مهار کار
      | گذاشته شده هیچ‌وقت نمی‌خورد.
      */
      if (visited >= maxVisited) {
        dropped += frontier.size;
        return this.finish(kept, present, missing, true, visited, dropped, options);
      }
      if (current.depth >= maxDepth) continue;

      for (const edge of this.engine.edgesFrom(current.id, direction, options.relations, minConfidence)) {
        const neighbour = edge.from === current.id ? edge.to : edge.from;
        if (settled.has(neighbour)) continue;

        const pathConfidence = Math.min(current.pathConfidence, edge.confidence);
        const score =
          (options.seedWeights?.[current.seed] ?? 1) *
          Math.pow(decay, current.depth + 1) *
          (pathConfidence / 100);

        const known = bestScore.get(neighbour);
        if (known !== undefined && known >= score) continue;

        bestScore.set(neighbour, score);
        frontier.push(
          {
            id: neighbour,
            depth: current.depth + 1,
            score,
            pathConfidence,
            via: edge,
            seed: current.seed,
          },
          score
        );
      }
    }

    return this.finish(kept, present, missing, false, visited, dropped, options);
  }

  private finish(
    kept: readonly ExploredNode[],
    seeds: readonly string[],
    missingSeeds: readonly string[],
    truncated: boolean,
    visitedCount: number,
    droppedCount: number,
    options: ExploreOptions
  ): ExplorationResult {
    const inside = new Set<string>([...seeds, ...kept.map(node => node.id)]);
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const minConfidence = options.minConfidence ?? HIGH_CONFIDENCE_THRESHOLD;

    for (const id of inside) {
      for (const edge of this.engine.edgesFrom(id, 'out', options.relations, minConfidence)) {
        if (!inside.has(edge.to)) continue;
        const key = `${edge.from}→${edge.to}:${edge.relation}:${edge.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(edge);
      }
    }

    return {
      nodes: kept,
      edges,
      seeds,
      missingSeeds,
      truncated,
      visitedCount,
      droppedCount,
    };
  }
}

/**
 * heap دودویی — کوچک، و عمداً بدون وابستگی.
 *
 * `array.sort()` در هر گام روی مرزی با هزاران گره، کاوش را از
 * ایندکس‌سازی گران‌تر می‌کند.
 */
class MaxHeap<T> {
  private readonly items: { value: T; priority: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(value: T, priority: number): void {
    this.items.push({ value, priority });
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].priority >= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let largest = index;
        if (left < this.items.length && this.items[left].priority > this.items[largest].priority) {
          largest = left;
        }
        if (right < this.items.length && this.items[right].priority > this.items[largest].priority) {
          largest = right;
        }
        if (largest === index) break;
        [this.items[largest], this.items[index]] = [this.items[index], this.items[largest]];
        index = largest;
      }
    }
    return top.value;
  }
}
