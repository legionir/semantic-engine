/**
 * ContextDiscoverer — GAP-04: کشف نامزد، جدا از ساخت context.
 *
 * ## مسئله
 *
 * تا فاز ۴۳، `assemble_context` دو حالت داشت: یا مسیر صریح می‌گرفت،
 * یا مستقیم `semantic_search` می‌کرد و نتیجه‌اش را همان‌جا مصرف
 * می‌کرد. مرحلهٔ میانی — گسترش گرافی — اصلاً وجود نداشت:
 *
 * ```
 * Task → Candidate Discovery → Graph Expansion → Ranking → Assembly
 *         (search + blueprint)   (فاز ۴۱)        (فاز ۴۲)   (فاز ۴۲)
 *              ▲                      ▲
 *              └── این ماژول ──────────┘
 * ```
 *
 * پیامدِ نبودنش این است که جست‌وجوی کلیدواژه‌ای فقط چیزی را پیدا
 * می‌کند که **اسمش را از قبل بلد باشید**. فایلی که مستقیماً درگیر
 * task است ولی نامش هیچ اصطلاح مشترکی با آن ندارد، نامرئی می‌ماند —
 * هرچند یک `import` با آن فاصله دارد.
 *
 * ## جریان
 *
 * ۱. **دانه از جست‌وجو** — `semantic_search` روی متن task.
 * ۲. **دانه از blueprint** — ماژول‌هایی که با اصطلاحات task می‌خوانند
 *    (SE-BP-06؛ تا این فاز هیچ‌کس blueprint را نمی‌خواند).
 * ۳. **گسترش** — `SubgraphExplorer` (فاز ۴۱) با وزنِ دانه‌ها، بهترین‌اول
 *    و بودجه‌دار.
 * ۴. **رتبه‌بندی** — `ContextRanker` (فاز ۴۲)، با فاصلهٔ گرافیِ واقعی.
 *
 * خروجی **متن نیست**. این تفکیک، نکتهٔ اصلی GAP-04 است: کشف می‌گوید
 * «اینها مرتبط‌اند و این هم دلیلش»، و تصمیمِ اینکه چه مقدارش در بودجه
 * می‌گنجد کارِ `TokenBudget` است.
 */

import { ProjectIndexReader } from '../ProjectIndexReader';
import { SemanticSearchTool } from '../tools/SemanticSearchTool';
import type { IEmbeddingGenerator } from '../../vector/EmbeddingGenerator';
import { GraphQueryEngine } from '../../graphs/GraphQueryEngine';
import { SubgraphExplorer } from '../../graphs/SubgraphExplorer';
import { ContextRanker, RankCandidate } from '../ranking/ContextRanker';
import { BlueprintIndex, ModuleMatch } from './BlueprintIndex';
import { queryTerms } from '../tools/queryTerms';
import type { FileEntry, SymbolEntry } from '../../core/types/project-index.types';

export type CandidateOrigin = 'search' | 'blueprint' | 'expansion';

export interface DiscoveredCandidate {
  readonly id: string;
  readonly kind: 'file' | 'symbol';
  readonly name: string;
  readonly path?: string;
  readonly line?: number;
  /** بازهٔ ۰..۱ از `ContextRanker`. */
  readonly score: number;
  /** چطور وارد مجموعه شد. دانه‌ها `search`/`blueprint`، بقیه `expansion`. */
  readonly origin: CandidateOrigin;
  /** فاصله تا نزدیک‌ترین دانه. دانه‌ها صفر. */
  readonly hops: number;
  readonly moduleId?: string;
  readonly reason: string;
}

export interface DiscoverySeed {
  readonly id: string;
  readonly origin: 'search' | 'blueprint';
  readonly weight: number;
  readonly reason: string;
}

export interface DiscoveryStats {
  readonly searchSeeds: number;
  readonly blueprintSeeds: number;
  /** گره‌هایی که فقط از راه گسترش پیدا شدند. */
  readonly expanded: number;
  readonly visitedCount: number;
  readonly droppedCount: number;
}

export interface DiscoveryResult {
  readonly candidates: readonly DiscoveredCandidate[];
  readonly seeds: readonly DiscoverySeed[];
  readonly modules: readonly ModuleMatch[];
  readonly truncated: boolean;
  readonly stats: DiscoveryStats;
}

export interface DiscoverInput {
  readonly task: string;
  /** سقف نامزدهای برگشتی. پیش‌فرض ۲۰. */
  readonly limit?: number;
  /** چند هاپ از دانه‌ها دور شویم. پیش‌فرض ۲. */
  readonly expansionDepth?: number;
  /** چند دانه از جست‌وجو بگیریم. پیش‌فرض ۸. */
  readonly seedLimit?: number;
  /** حداکثر فایل از هر ماژولِ منطبق. پیش‌فرض ۳. */
  readonly filesPerModule?: number;
  /** سقف گره‌های بازدیدشده در گسترش. پیش‌فرض ۲۰۰. */
  readonly maxNodes?: number;
  /** پیش‌فرض false — فایل‌های تست نامزد نمی‌شوند. */
  readonly includeTests?: boolean;
  /**
   * سقف نامزد از هر فایل. پیش‌فرض ۲.
   *
   * SE-AI-20 — نماد و فایلِ صاحبش هر دو نامزدند، پس یک فایلِ پرنماد
   * می‌تواند کل سهمیه را ببلعد. اندازه‌گیری روی ایندکس واقعی: پنج
   * نتیجهٔ برترِ یک پرس‌وجو، هر پنج‌تا `lsp/LspClient.ts` بودند.
   */
  readonly maxPerFile?: number;
}

export interface ContextDiscovererOptions {
  readonly blueprint?: BlueprintIndex;
  readonly embeddingGenerator?: IEmbeddingGenerator;
}

export class ContextDiscoverer {
  private readonly search: SemanticSearchTool;
  private readonly ranker = new ContextRanker();
  private graph: GraphQueryEngine | null = null;
  private explorer: SubgraphExplorer | null = null;

  constructor(
    private readonly reader: ProjectIndexReader,
    private readonly options: ContextDiscovererOptions = {}
  ) {
    this.search = new SemanticSearchTool(reader, options.embeddingGenerator);
  }

  async discover(input: DiscoverInput): Promise<DiscoveryResult> {
    const limit = input.limit ?? 20;
    const expansionDepth = Math.max(0, input.expansionDepth ?? 2);
    const seedLimit = input.seedLimit ?? 8;
    const filesPerModule = input.filesPerModule ?? 3;
    const maxNodes = input.maxNodes ?? 200;
    const includeTests = input.includeTests ?? false;
    const maxPerFile = Math.max(1, input.maxPerFile ?? 2);

    /*
    | SE-VEC-11 — همان توکن‌سازِ `SemanticSearchTool`، نه یک کپیِ محلی.
    |
    | نسخهٔ اول این ماژول یک `tokenize` خصوصی داشت که عمداً رفتار
    | *قدیمیِ* جست‌وجو را تکرار می‌کرد تا دو تعریف از «اصطلاح» نداشته
    | باشیم. وقتی جست‌وجو رفع شد، این یکی جا ماند و روی ایندکس واقعی
    | نتیجه‌اش این بود:
    |
    |   task: "fix a timeout bug in the language server client"
    |   ماژول‌های منطبق: mod-ai-ranking، mod-blueprint، mod-incremental
    |
    | هر سه را واژهٔ «in» آورده بود: rank«in»g، bluepr«in»t،
    | «in»cremental. اشتراکِ توکن‌ساز، از جنسِ همان درس است — ولی فقط
    | اگر واقعاً *یک* پیاده‌سازی باشد.
    */
    const terms = queryTerms(input.task);

    // ── ۱. دانه از جست‌وجو ────────────────────────────────────────
    const seeds = new Map<string, DiscoverySeed>();
    const keywordById = new Map<string, number>();

    const searchResult = await this.search.execute({ query: input.task, limit: seedLimit });
    for (const item of searchResult.items) {
      const score = item.relevanceScore ?? 0;
      keywordById.set(item.id, score);
      seeds.set(item.id, {
        id: item.id,
        origin: 'search',
        weight: Math.max(score, 0.1),
        reason: `semantic_search matched "${input.task}" (score ${score})`,
      });

      /*
      | SE-AI-19 — پل از نماد به فایل.
      |
      | جست‌وجو شناسهٔ **نماد** برمی‌گرداند؛ اندازه‌گیری روی ایندکس
      | واقعی: ۱۰ از ۱۰ نتیجه نماد بودند و صفر فایل. ولی گراف
      | وابستگی کاملاً **فایل‌به‌فایل** است — ۵۰۰ از ۵۰۰ یالِ
      | نمونه‌برداری‌شده از فایل شروع می‌شدند.
      |
      | پس گسترشی که فقط با دانه‌های نمادی شروع شود، فقط می‌تواند
      | callGraph و typeGraph را بپیماید و گراف import — قوی‌ترین
      | سیگنال ساختاری موجود — کاملاً دست‌نیافتنی می‌ماند. فایلِ
      | صاحبِ هر نمادِ دانه، خودش دانه می‌شود.
      */
      const owner = this.reader.getSymbolById(item.id);
      if (!owner) continue;
      const ownerFile = this.reader.getFileById(owner.fileId);
      if (!ownerFile || seeds.has(ownerFile.id)) continue;
      seeds.set(ownerFile.id, {
        id: ownerFile.id,
        origin: 'search',
        // وزن کمی کمتر از خودِ نماد: فایل به‌واسطه وارد شده.
        weight: Math.max(score * 0.8, 0.1),
        reason: `owns ${owner.name}, which semantic_search matched`,
      });
    }

    // ── ۲. دانه از blueprint ──────────────────────────────────────
    const modules = this.options.blueprint?.matchModules(terms) ?? [];
    let blueprintSeeds = 0;

    for (const mod of modules) {
      /*
      | از هر ماژول فقط چند فایلِ مهم برداشته می‌شود، نه همه.
      | `mod-lsp` روی ایندکس واقعی ۳۱ فایل دارد؛ ریختنِ همه‌شان به
      | داخل دانه‌ها یعنی گسترش از همان اول اشباع می‌شود و رتبه‌بندی
      | چیزی برای تفکیک ندارد.
      */
      const ranked = this.reader
        .getFilesForIds([...mod.fileIds])
        .filter(f => includeTests || !f.testFile)
        .sort(
          (a, b) =>
            (b.aiMetadata?.aiScore?.importance ?? 0) - (a.aiMetadata?.aiScore?.importance ?? 0) ||
            a.path.localeCompare(b.path)
        )
        .slice(0, filesPerModule);

      for (const f of ranked) {
        if (seeds.has(f.id)) continue;
        seeds.set(f.id, {
          id: f.id,
          origin: 'blueprint',
          weight: Math.max(mod.score, 0.1),
          reason: mod.reason,
        });
        blueprintSeeds++;
      }
    }

    if (seeds.size === 0) {
      return {
        candidates: [],
        seeds: [],
        modules,
        truncated: false,
        stats: {
          searchSeeds: 0,
          blueprintSeeds: 0,
          expanded: 0,
          visitedCount: 0,
          droppedCount: 0,
        },
      };
    }

    // ── ۳. گسترش گرافی ────────────────────────────────────────────
    const seedIds = Array.from(seeds.keys());
    const seedWeights: Record<string, number> = {};
    for (const [id, seed] of seeds) seedWeights[id] = seed.weight;

    const exploration = this.subgraphExplorer().explore(seedIds, {
      maxDepth: expansionDepth,
      maxNodes,
      direction: 'both',
      seedWeights,
    });

    const hopsById = new Map<string, number>();
    for (const node of exploration.nodes) {
      const previous = hopsById.get(node.id);
      if (previous === undefined || node.depth < previous) hopsById.set(node.id, node.depth);
    }
    // دانه‌هایی که اصلاً در گراف نیستند (مثلاً نمادِ بدون یال) نباید
    // به‌خاطر نبودشان در گراف حذف شوند.
    for (const id of seedIds) if (!hopsById.has(id)) hopsById.set(id, 0);

    // ── ۴. رتبه‌بندی ──────────────────────────────────────────────
    interface Entity {
      readonly id: string;
      readonly kind: 'file' | 'symbol';
      readonly name: string;
      readonly path?: string;
      readonly line?: number;
      readonly hops: number;
      readonly origin: CandidateOrigin;
      readonly reason: string;
      readonly moduleId?: string;
    }

    const entities: Entity[] = [];

    for (const [id, hops] of hopsById) {
      const seed = seeds.get(id);
      const origin: CandidateOrigin = seed ? seed.origin : 'expansion';

      const f = this.reader.getFileById(id);
      if (f) {
        if (!includeTests && f.testFile) continue;
        entities.push({
          id,
          kind: 'file',
          name: f.path,
          path: f.path,
          hops,
          origin,
          reason: seed ? seed.reason : `${hops} hop(s) from a seed in the dependency graph`,
          ...(this.moduleIdOf(id) ? { moduleId: this.moduleIdOf(id) as string } : {}),
        });
        continue;
      }

      const s = this.reader.getSymbolById(id);
      if (!s) continue;
      const owner = this.reader.getFileById(s.fileId);
      if (!includeTests && owner?.testFile) continue;
      entities.push({
        id,
        kind: 'symbol',
        name: s.name,
        ...(owner ? { path: owner.path } : {}),
        line: s.line,
        hops,
        origin,
        reason: seed ? seed.reason : `${hops} hop(s) from a seed in the call/type graph`,
        ...(this.moduleIdOf(s.fileId) ? { moduleId: this.moduleIdOf(s.fileId) as string } : {}),
      });
    }

    const churnRanks: number[] = [];
    for (const f of this.reader.getAllFiles()) {
      const rank = f.gitMetrics?.churnRank;
      if (typeof rank === 'number') churnRanks.push(rank);
    }

    const rankCandidates: RankCandidate<Entity>[] = entities.map(entity => {
      const symbol: SymbolEntry | undefined = this.reader.getSymbolById(entity.id);
      const file: FileEntry | undefined = symbol
        ? this.reader.getFileById(symbol.fileId)
        : this.reader.getFileById(entity.id);
      const aiScore = file?.aiMetadata?.aiScore;
      const git = file?.gitMetrics;

      return {
        id: entity.id,
        payload: entity,
        signals: {
          keyword: keywordById.get(entity.id) ?? null,
          graphHops: entity.hops,
          referenceCount: symbol ? symbol.referenceCount ?? null : null,
          importance: aiScore?.importance ?? null,
          hotness: aiScore?.hotness ?? null,
          readPriority: aiScore?.readPriority ?? null,
          hotspotScore: git?.hotspotScore ?? null,
          churnRank: git?.churnRank ?? null,
          complexity: symbol?.complexity ?? null,
          testCount: symbol?.testIds?.length ?? null,
          exported: symbol?.exported ?? null,
        },
      };
    });

    const ranked = this.ranker.rank<Entity>(rankCandidates, {
      ...(churnRanks.length > 0 ? { churnRankOutOf: Math.max(...churnRanks) } : {}),
    });

    const candidates: DiscoveredCandidate[] = ranked.map(r => {
      const e = r.payload as Entity;
      return {
        id: e.id,
        kind: e.kind,
        name: e.name,
        ...(e.path ? { path: e.path } : {}),
        ...(e.line !== undefined ? { line: e.line } : {}),
        score: Math.round(r.score * 1000) / 1000,
        origin: e.origin,
        hops: e.hops,
        ...(e.moduleId ? { moduleId: e.moduleId } : {}),
        reason: e.reason,
      };
    });

    /*
    | SE-AI-20 — تنوع پیش از برش.
    |
    | سقف *بعد* از رتبه‌بندی و *پیش* از `limit` اعمال می‌شود، پس
    | پرامتیازترین‌های هر فایل نگه داشته می‌شوند و سهمیه به فایل‌های
    | بیشتری می‌رسد. اگر بعد از `limit` اعمال می‌شد، فقط نتیجه را
    | کوتاه‌تر می‌کرد بی‌آنکه چیز تازه‌ای نشان دهد.
    */
    const perFile = new Map<string, number>();
    const diversified: DiscoveredCandidate[] = [];
    for (const candidate of candidates) {
      const key = candidate.path ?? candidate.id;
      const seen = perFile.get(key) ?? 0;
      if (seen >= maxPerFile) continue;
      perFile.set(key, seen + 1);
      diversified.push(candidate);
    }

    const expanded = diversified.filter(c => c.origin === 'expansion').length;

    return {
      candidates: diversified.slice(0, limit),
      seeds: Array.from(seeds.values()),
      modules,
      truncated: diversified.length > limit || candidates.length > diversified.length || exploration.truncated,
      stats: {
        searchSeeds: searchResult.items.length,
        blueprintSeeds,
        expanded,
        visitedCount: exploration.visitedCount,
        droppedCount: exploration.droppedCount,
      },
    };
  }

  private moduleIdOf(fileId: string): string | undefined {
    return this.options.blueprint?.moduleOf(fileId)?.id;
  }

  private subgraphExplorer(): SubgraphExplorer {
    if (!this.explorer) {
      this.graph = this.graph ?? new GraphQueryEngine(this.reader.projectIndex);
      this.explorer = new SubgraphExplorer(this.graph);
    }
    return this.explorer;
  }
}

