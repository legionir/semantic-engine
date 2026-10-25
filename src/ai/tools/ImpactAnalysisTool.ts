/**
 * ImpactAnalysisTool — «اگر این را عوض کنم، چه چیزی می‌شکند؟»
 *
 * ── چه چیزی در فاز ۳۹ عوض شد و چرا ────────────────────────────────
 *
 * نسخهٔ قبلی پیمایش خودش را داشت و SE-AI-03 دو خطا در آن پیدا کرده
 * بود:
 *
 * ```ts
 * const visited = new Set();                   // سراسری، در DFS
 * const traverse = (id, depth, weight) => {
 *   if (visited.has(id)) return;               // ← گرهٔ نزدیک را از دست می‌دهد
 *   for (const edge of reverseDeps) {
 *     …
 *     if (scores.size >= limit) return;        // ← برش وسط پیمایش
 *   }
 * };
 * ```
 *
 * با DFS، گره‌ای که یک‌بار در عمق ۳ دیده شود بعداً از مسیر عمق ۱
 * نادیده گرفته می‌شود؛ پس «نزدیک‌ترین‌ها» در نمی‌آید، «اولین‌هایی که
 * تصادفاً دیده شدند» در می‌آید. و برشِ `limit` وسط پیمایش یعنی
 * مجموعهٔ خروجی، تابع ترتیب پیمایش است نه امتیاز — دو اجرا روی یک
 * ایندکس می‌توانند دو جواب بدهند.
 *
 * حالا پیمایش کارِ `GraphQueryEngine` است: BFS، سقف صریح، تشخیص
 * حلقه، و فیلتر اعتماد. این کلاس فقط امتیاز می‌دهد و مرتب می‌کند.
 *
 * ── دو رفتار که عمداً تغییر کرد ────────────────────────────────────
 *
 * **`level: 'symbol'` حالا واقعاً فیلتر می‌کند.** پیش از این فقط
 * شاخهٔ `'file'` فیلتر داشت و `'symbol'` هر چیزی را برمی‌گرداند —
 * پارامتری که وجود داشت و کاری نمی‌کرد.
 *
 * **یال‌های کم‌اعتماد پیش‌فرض کنار می‌روند.** یال `name-match`
 * (اعتماد ۴۰) یعنی «یک symbol هم‌نام جایی در پروژه هست». تحلیل
 * تأثیری که روی آن بنا شود، فایل‌های بی‌ربط را «تحت تأثیر» اعلام
 * می‌کند. با `minConfidence: 0` می‌شود همه را دید.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { GraphQueryEngine, VisitedNode } from '../../graphs/GraphQueryEngine';
import { resolveFileOrSymbolId } from './resolveIndexEntity';
import type { BlueprintIndex } from '../discovery/BlueprintIndex';

export interface ImpactAnalysisInput extends AiToolInput {
  readonly id: string;
  readonly level?: 'file' | 'symbol' | 'any';
  readonly depth?: number;
  readonly limit?: number;
  /** پیش‌فرض ۷۰ — فقط یال‌های قابل اتکا. */
  readonly minConfidence?: number;
}

/** هرچه دورتر، اثر کمتر. همان ۰٫۷ نسخهٔ قبلی. */
const DECAY = 0.7;

export interface ImpactAnalysisOptions {
  readonly blueprint?: BlueprintIndex;
}

export class ImpactAnalysisTool implements AiTool<ImpactAnalysisInput> {
  readonly name = 'impact_analysis';
  readonly description =
    'Estimate which files or symbols are impacted by changing a given file or symbol.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'fileId, symbolId, or indexed relative file path' },
      level: { enum: ['file', 'symbol', 'any'], default: 'file' },
      depth: { type: 'integer', default: 2 },
      limit: { type: 'integer', default: 30 },
      minConfidence: {
        type: 'integer',
        default: 70,
        description: 'Ignore graph edges below this confidence. 0 includes name-match guesses.',
      },
    },
    required: ['id'],
  };

  private engine: GraphQueryEngine | undefined;

  constructor(
    private readonly reader: ProjectIndexReader,
    private readonly options: ImpactAnalysisOptions = {}
  ) {}

  async execute(input: ImpactAnalysisInput): Promise<AiToolOutput> {
    try {
      const depth = Math.min(input.depth ?? 2, 3);
      const limit = input.limit ?? 30;
      const level = input.level ?? 'file';
      const seeds = this.resolveSeeds(input.id);

      /*
      | ساخت گراف یک بار برای کل عمر ابزار. رجیستری ابزارها با هر
      | ایندکس تازه دوباره ساخته می‌شود (SE-AI-02)، پس این کش با
      | همان چرخه باطل می‌شود.
      */
      const engine = (this.engine ??= new GraphQueryEngine(this.reader.projectIndex, {
        /* GraphQueryEngine normally omits external package nodes. Module
           impact needs them because consumers import a package name rather
           than one of the module's individual files. */
        extraEdges: (this.reader.projectIndex.graphs?.dependencyGraph ?? [])
          .filter(edge => edge.to.startsWith('pkg:'))
          .map(edge => ({
            from: edge.from,
            to: edge.to,
            relation: 'imports' as const,
            kind: edge.kind,
            confidence: edge.provenance.confidence,
            basis: edge.provenance.basis,
            extractor: edge.provenance.extractor,
          })),
      }));

      /*
      | جهت `in`: «چه چیزی به این وابسته است». پیمایش تا سقفِ
      | *گره* می‌رود و بعد امتیاز داده می‌شود — نه اینکه وسط
      | پیمایش بریده شود. سقف را سخاوتمندانه از `limit` بزرگ‌تر
      | می‌گیریم تا مرتب‌سازی روی مجموعه‌ای معنادار انجام شود.
      */
      const traversal = seeds.length > 1
        ? engine.subgraph(seeds, {
            direction: 'in',
            depth,
            minConfidence: input.minConfidence ?? 70,
            maxNodes: Math.max(limit * 10, 200),
          })
        : engine.ancestors(seeds[0] ?? input.id, {
            depth,
            minConfidence: input.minConfidence ?? 70,
            maxNodes: Math.max(limit * 10, 200),
          });

      const cyclic = 'cyclic' in traversal ? traversal.cyclic : false;
      const visitedCount = 'visitedCount' in traversal
        ? traversal.visitedCount
        : seeds.length + traversal.nodes.length;

      const symbolCallers = new Map<string, string[]>();
      const candidates = level === 'file'
        ? this.rollUpToFiles(traversal.nodes, symbolCallers)
        : traversal.nodes.filter(node => this.matchesLevel(node.id, level));

      const items = candidates
        .map(node => this.describe(node, level === 'file' ? symbolCallers.get(node.id) : undefined))
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
        .slice(0, limit);

      /*
      | SE-AI-HONESTY (P-06) — دو سقفِ مستقل در این ابزار وجود دارد:
      | (۱) سقف *گره* پیمایش (`maxNodes`) و (۲) برش خروجی به `limit`
      | پس از مرتب‌سازی. محاسبهٔ قبلی فقط (۱) را گزارش می‌کرد؛ یعنی
      | اگر ۵۰ کاندید وجود داشت و ۳۰ تا برمی‌گشت، خروجی «کامل» به نظر
      | می‌رسید. حالا `truncated` اتحادِ هر دو است و شمارشِ کاندیدها
      | همراهش می‌آید تا AI بداند سقف را بالا ببرد یا depth را کم کند.
      */
      const droppedByLimit = candidates.length > items.length;

      return {
        success: true,
        items,
        metadata: {
          visited: visitedCount,
          truncated: traversal.truncated || droppedByLimit,
          candidateCount: candidates.length,
          droppedByLimit,
          traversalExhausted: traversal.truncated,
          limit,
          cyclic,
          minConfidence: input.minConfidence ?? 70,
          targetType: this.isModule(input.id)
            ? 'module'
            : this.isPackage(input.id)
              ? 'package'
              : 'file_or_symbol',
          seedCount: seeds.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        items: [],
      };
    }
  }

  private isPackage(value: string): boolean {
    return value.startsWith('pkg:') &&
      (this.reader.projectIndex.graphs?.dependencyGraph ?? []).some(edge => edge.to === value);
  }


  private isModule(value: string): boolean {
    return Boolean(
      this.options.blueprint?.getModule(value) ||
      (!resolveFileOrSymbolId(this.reader, value) &&
        this.reader.getAllFiles().some(file =>
          file.path === value || file.path.startsWith(`${value.replace(/[\\/]+$/, '')}/`)
        ))
    );
  }


  private resolveSeeds(value: string): string[] {
    const direct = resolveFileOrSymbolId(this.reader, value);
    if (direct) return [direct];

    if (this.isPackage(value)) return [value];

    const module = this.options.blueprint?.getModule(value);
    const modulePath = module?.path || value;
    const prefix = modulePath.replace(/[\\/]+$/, '');
    const fileIds = this.reader
      .getAllFiles()
      .filter(file => file.path === prefix || file.path.startsWith(`${prefix}/`))
      .map(file => file.id);

    /* Package imports are represented as pkg:<name> graph nodes. A module
       such as packages/engine-input/src therefore needs its package node as
       a seed too, otherwise consumers importing @web-engine/engine-input
       appear unrelated to the selected module. */
    const segments = prefix.split(/[\\/]/).filter(Boolean);
    const leaf = segments[segments.length - 1] === 'src'
      ? segments[segments.length - 2] || ''
      : segments[segments.length - 1] || '';
    const packageSeeds = (this.reader.projectIndex.graphs?.dependencyGraph ?? [])
      .map(edge => edge.to)
      .filter(id =>
        id.startsWith('pkg:') &&
        leaf !== '' &&
        id.replace(/^pkg:/, '').split(/[\\/]/).pop() === leaf
      );

    return [...new Set([...fileIds, ...packageSeeds])];
  }


  /*
  | SE-AI-12 — فراخوانِ یک سمبل، فایلش را گم نمی‌کند.
  |
  | `GraphQueryEngine` سرِ یال call را **سمبل** می‌شناسد؛ فیلتر
  | `level: 'file'` آن گره‌ها را دور می‌ریخت، پس impact_analysis فقط
  | فایل‌هایی را نشان می‌داد که فراخوانشان در سطح ماژول نوشته شده
  | بود. روی همین مخزن، سه caller واقعیِ `ContextRanker.rank`
  | (SemanticSearchTool، ContextDiscoverer، AssembleContextTool) غیب
  | می‌شدند و agent برداشتِ کم‌تأثیر می‌گرفت — همان چیزی که برای
  | تصمیمِ ویرایشِ امن خطرناک است.
  |
  | سمبل‌ها به فایل مادرشان جمع می‌شوند و نزدیک‌ترین/مطمئن‌ترین مسیر
  | نگه داشته می‌شود؛ نام سمبل‌های فراخوان هم در metadata می‌ماند تا
  | مشخص باشد این تأثیر از کجا آمده.
  */
  private rollUpToFiles(
    nodes: readonly VisitedNode[],
    symbolCallers: Map<string, string[]>
  ): VisitedNode[] {
    const best = new Map<string, VisitedNode>();

    for (const node of nodes) {
      const symbol = this.reader.getSymbolById(node.id);
      const fileId = symbol ? symbol.fileId : node.id;
      if (!this.reader.getFileById(fileId)) continue;
      if (symbol) {
        const seen = symbolCallers.get(fileId) ?? [];
        if (!seen.includes(symbol.name)) symbolCallers.set(fileId, [...seen, symbol.name]);
      }

      const candidate: VisitedNode = symbol ? { ...node, id: fileId } : node;
      const current = best.get(fileId);
      if (
        !current ||
        candidate.depth < current.depth ||
        (candidate.depth === current.depth && candidate.pathConfidence > current.pathConfidence)
      ) {
        best.set(fileId, candidate);
      }
    }

    return [...best.values()];
  }

  private matchesLevel(id: string, level: 'file' | 'symbol' | 'any'): boolean {
    if (level === 'any') return true;
    if (level === 'file') return this.reader.getFileById(id) !== undefined;
    return this.reader.getSymbolById(id) !== undefined;
  }

  private describe(node: VisitedNode, viaSymbols?: string[]) {
    const file = this.reader.getFileById(node.id);
    const symbol = this.reader.getSymbolById(node.id);

    /*
    | امتیاز از **عمق** می‌آید و نه از ترتیب دیده شدن — و چون
    | پیمایش BFS است، عمق همان کوتاه‌ترین فاصله است. اعتمادِ
    | ضعیف‌ترین یالِ مسیر هم در امتیاز ضرب می‌شود: یک فایلِ نزدیک
    | که فقط از راه یک حدس به آن رسیده‌ایم، نباید هم‌رده با
    | همسایهٔ قطعی باشد.
    */
    const distanceWeight = Math.pow(DECAY, node.depth - 1);
    const score = distanceWeight * (node.pathConfidence / 100);

    return {
      id: node.id,
      name: symbol?.name ?? file?.path ?? node.id,
      kind: symbol?.kind ?? 'file',
      path: file?.path ?? (symbol ? this.reader.getFileById(symbol.fileId)?.path : undefined),
      line: symbol?.line,
      relevanceScore: Math.round(score * 100) / 100,
      source: 'impact-analysis',
      metadata: {
        depth: node.depth,
        pathConfidence: node.pathConfidence,
        via: node.via ? `${node.via.relation}:${node.via.basis}` : null,
        ...(viaSymbols && viaSymbols.length > 0 ? { viaSymbols } : {}),
      },
    };
  }
}
