/**
 * Types and defaults of the graph query engine (split from GraphQueryEngine.ts, unchanged).
 */

import { HIGH_CONFIDENCE_THRESHOLD } from './EdgeProvenance';
import type { ClaimProvenance } from '../facts/FactStore';

/** رابطه‌هایی که گراف می‌شناسد. */
/**
 * `layers` — یال‌های بین‌لایه‌ای فاز ۴۷ (GAP-09).
 *
 * عمداً یک relationِ جدا است نه یکی از سه تای موجود: پرس‌وجویی که
 * فقط دربارهٔ ساختارِ کد است، نباید بی‌اختیار از گرهِ API سر دربیاورد.
 */
export type GraphRelation = 'imports' | 'calls' | 'types' | 'layers';

export type Direction = 'out' | 'in' | 'both';

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: GraphRelation;
  /** نوع دقیق یال، همان چیزی که در ایندکس است (`import`, `direct`, `extends`, …). */
  readonly kind: string;
  readonly confidence: number;
  readonly basis: string;
  /** کدام استخراج‌گر این ادعا را کرد — `derived` یعنی خود موتور. */
  readonly extractor?: ClaimProvenance['extractor'];
  /**
   * منابع دربارهٔ قوت این رابطه هم‌نظر نبودند (فاز ۴۹).
   *
   * یال با قوی‌ترین شاهد بیرون می‌آید؛ این پرچم می‌گوید که شاهد
   * ضعیف‌تری هم بوده. مصرف‌کننده‌ای که می‌خواهد سخت‌گیر باشد
   * می‌تواند رابطهٔ مورد اختلاف را جدا نشان دهد.
   */
  readonly contested?: boolean;
  /** ادعاهای کنارگذاشته‌شده دربارهٔ همین رابطه، از قوی به ضعیف. */
  readonly superseded?: readonly ClaimProvenance[];
}

export interface GraphQueryEngineOptions {
  /** یال‌های افزوده — مثلاً لایه‌های بالا از `LayeredGraph`. */
  readonly extraEdges?: readonly GraphEdge[];
}

export interface TraversalOptions {
  readonly direction?: Direction;
  readonly depth?: number;
  readonly relations?: readonly GraphRelation[];
  /** پیش‌فرض ۷۰ — همان آستانهٔ فاز ۱۹. `0` یعنی همه‌چیز. */
  readonly minConfidence?: number;
  /** سقف گره‌های بازدیدشده. پیش‌فرض ۵۰۰۰. */
  readonly maxNodes?: number;
}

export interface VisitedNode {
  readonly id: string;
  /** فاصله از نزدیک‌ترین شروع — با BFS همیشه کوتاه‌ترین است. */
  readonly depth: number;
  /** ضعیف‌ترین یال روی مسیری که با آن به این گره رسیدیم. */
  readonly pathConfidence: number;
  readonly via: GraphEdge | null;
}

export interface TraversalResult {
  readonly nodes: readonly VisitedNode[];
  /** به سقف خوردیم — نتیجه ناقص است. */
  readonly truncated: boolean;
  /** در پیمایش به گره‌ای رسیدیم که قبلاً دیده بودیم. */
  readonly cyclic: boolean;
  readonly visitedCount: number;
}

export interface PathStep {
  readonly node: string;
  readonly via: GraphEdge | null;
}

export interface PathResult {
  /** `null` یعنی هیچ مسیری نیست — حتی با یال‌های ضعیف. */
  readonly path: readonly PathStep[] | null;
  /** آیا همهٔ یال‌های مسیر بالای آستانه‌اند؟ */
  readonly confident: boolean;
  /** کمترین اعتماد روی مسیر. */
  readonly weakestLink: number;
  /**
   * یال‌هایی که مسیر را ضعیف کرده‌اند.
   *
   * معیار پذیرش فاز: «مسیرهای `name-match` را جدا گزارش کند». نه یک
   * پرچم مبهم، بلکه خودِ آن یال‌ها.
   */
  readonly weakEdges: readonly GraphEdge[];
  readonly truncated: boolean;
}

export interface SubgraphResult {
  readonly nodes: readonly VisitedNode[];
  readonly edges: readonly GraphEdge[];
  readonly truncated: boolean;
  /** کدام دانه‌ها اصلاً در گراف بودند. */
  readonly seeds: readonly string[];
}

export const DEFAULT_GRAPH_MAX_NODES = 5_000;
export const DEFAULT_GRAPH_DEPTH = 2;
/** Shortest-path search needs a deeper default than neighbourhood traversal; shared by the traversals. */
export const DEFAULT_GRAPH_PATH_DEPTH = 8;
export const DEFAULT_GRAPH_DIRECTION: Direction = 'out';
export const DEFAULT_GRAPH_MIN_CONFIDENCE = HIGH_CONFIDENCE_THRESHOLD;
export const ALL_RELATIONS: readonly GraphRelation[] = ['imports', 'calls', 'types', 'layers'];
