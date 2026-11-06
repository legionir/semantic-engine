/**
 * SemanticSearchTool — جستجوی معنایی در symbol ها و فایل‌ها.
 *
 * Hybrid scoring:
 * - keyword match (name, signature, documentation, path)
 * - vector similarity (اگر embedding موجود باشد)
 * - reference count / graph centrality
 * - exported bonus
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';

import { VectorStore, VectorStoreOptions } from '../../vector/VectorStore';
import { VectorStoreCache } from '../../vector/VectorStoreCache';
import type { IEmbeddingGenerator } from '../../vector/EmbeddingGenerator';
import { ContextRanker, RankCandidate, SignalName } from '../ranking/ContextRanker';
import { queryTerms } from './queryTerms';
import { SymbolTermIndex } from './SymbolTermIndex';
import { SemanticSearchCandidates, ScoredEntity } from './SemanticSearchCandidates';

export interface SemanticSearchInput extends AiToolInput {
  readonly query: string;
  readonly filters?: {
    readonly language?: string | string[];
    readonly kind?: string | string[];
    readonly path?: string;
    readonly exportedOnly?: boolean;
  };
  readonly limit?: number;
  /** Candidate source(s) to search. Defaults to hybrid. */
  readonly mode?: 'keyword' | 'vector' | 'hybrid';
  /** Minimum final ranked score (not the vector-store threshold). */
  readonly minScore?: number;
  /** @deprecated Prefer mode. */
  readonly useEmbeddings?: boolean;
}

/**
 * SE-AI-13 — «این نتیجه با کدام موتور رتبه‌بندی شد؟»
 *
 * دو اجرایِ یک پرس‌وجو — با مدلِ محلی و بدون آن — می‌توانند خروجیِ
 * بیت‌به‌بیت یکسان بدهند. اگر خروجی نگویید کدام مسیر امتیاز را
 * ساخته، agent نمی‌تواند به نتیجه اعتماد بدهد (مثلاً نتیجهٔ
 * کلیدواژهٔ خالص را با تطبیقِ معنایی یکسان فرض می‌کند).
 */
export interface SearchModeFacts {
  readonly requestedMode: 'keyword' | 'vector' | 'hybrid';
  /** ایندکس واقعاً بردار دارد؟ */
  readonly vectorAvailable: boolean;
  /** generatorِ هم‌سنجه با بردارهای ایندکس در دسترس بود؟ */
  readonly generatorReady: boolean;
  /** آیا نامزدی از مسیر بردار آمد؟ */
  readonly vectorUsed: boolean;
}

export interface SearchModeReport {
  readonly searchMode: 'hybrid' | 'vector-only' | 'keyword-only';
  readonly vectorAvailable: boolean;
  readonly degradedReason?:
    | 'no-vectors-in-index'
    | 'no-embedding-model'
    | 'no-vector-matches';
}

export function describeSearchMode(facts: SearchModeFacts): SearchModeReport {
  const { requestedMode, vectorAvailable, generatorReady, vectorUsed } = facts;

  if (vectorUsed) {
    return requestedMode === 'vector'
      ? { searchMode: 'vector-only', vectorAvailable }
      : { searchMode: 'hybrid', vectorAvailable };
  }

  if (requestedMode === 'keyword') return { searchMode: 'keyword-only', vectorAvailable };

  const degradedReason = !vectorAvailable
    ? 'no-vectors-in-index' as const
    : !generatorReady
      ? 'no-embedding-model' as const
      : 'no-vector-matches' as const;
  return { searchMode: 'keyword-only', vectorAvailable, degradedReason };
}

export class SemanticSearchTool implements AiTool<SemanticSearchInput> {
  readonly name = 'semantic_search';
  readonly description = 'Search symbols and files by natural language query. Uses keyword matching, vector embeddings, and reference count.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language query' },
      filters: {
        type: 'object',
        properties: {
          language: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          kind: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          path: { type: 'string' },
          exportedOnly: { type: 'boolean' },
        },
      },
      limit: { type: 'integer', default: 20 },
      mode: { type: 'string', enum: ['keyword', 'vector', 'hybrid'], default: 'hybrid' },
      minScore: { type: 'number', description: 'Minimum final ranked score' },
      useEmbeddings: { type: 'boolean', default: true },
    },
    required: ['query'],
  };

  private readonly vectorStore: VectorStore | null;
  private embeddingGenerator: IEmbeddingGenerator | undefined;
  private readonly ranker = new ContextRanker();
  /**
   * SE-VEC-04 — ایندکس معکوس، ساخته‌شده به‌صورت تنبل و مشترک بین
   * پرس‌وجوها. اندازه‌گیری پیش از این: ۱۱۰ms برای هر پرس‌وجو روی
   * ۸٬۴۱۴ نماد، چون هر بار کلِ ایندکس پیمایش و قطعه‌بندی می‌شد.
   */
  private readonly termIndex: SymbolTermIndex;
  private readonly candidates: SemanticSearchCandidates;

  constructor(
    private readonly reader: ProjectIndexReader,
    embeddingGenerator?: IEmbeddingGenerator,
    private readonly vectorStoreOptions?: VectorStoreOptions
  ) {
    /*
    | SE-VEC-07 — ایندکس برداری از کشِ مشترک می‌آید.
    |
    | قبلاً هر `SemanticSearchTool` یکی از صفر می‌ساخت، و این کلاس
    | بیش از یک بار ساخته می‌شود: یک‌بار در `AiToolRegistry` و
    | یک‌بار داخل `ContextDiscoverer`. با backendِ usearch یعنی دو
    | بار برپا کردن کاملِ گرافِ HNSW روی همان بردارها.
    |
    | `filter` روی آرایه یک آرایهٔ **تازه** می‌سازد، پس کلیدِ کش هم
    | تازه می‌شد و کش هرگز نمی‌گرفت. برای همین وقتی همهٔ chunkها
    | بردار دارند — حالت متعارف — همان آرایهٔ اصلی به کش داده می‌شود.
    */
    const chunks = reader.projectIndex.vectorChunks ?? [];
    const allHaveEmbeddings = chunks.every(c => c.embedding && c.embedding.length > 0);
    const chunksWithEmbeddings = allHaveEmbeddings
      ? chunks
      : chunks.filter(c => c.embedding && c.embedding.length > 0);
    this.vectorStore = VectorStoreCache.shared.forChunks(
      chunksWithEmbeddings,
      vectorStoreOptions
    );
    this.embeddingGenerator = embeddingGenerator;
    this.termIndex = new SymbolTermIndex(reader);
    this.candidates = new SemanticSearchCandidates({
      reader,
      termIndex: this.termIndex,
      vectorStore: this.vectorStore,
      ...(vectorStoreOptions ? { vectorStoreOptions } : {}),
      ensureEmbeddingGenerator: () => this.ensureEmbeddingGenerator(),
    });
  }

  /**
   * SE-VEC-02 — مسیر برداری در پیکربندی پیش‌فرض مرده بود.
   *
   * دو نقصِ روی هم:
   *
   * ۱. این تابعِ «سازندهٔ تنبل» فقط *داخل* `getEmbeddingCandidates`
   *    صدا زده می‌شد، و آن‌جا فقط وقتی می‌رسیدیم که
   *    `this.embeddingGenerator` از قبل مقدار داشته باشد. یک بن‌بست
   *    کامل: تنها راهِ ساختنِ generator، داشتنِ generator بود.
   * ۲. تنها گزینه‌اش `LocalEmbeddingGenerator` بود که به‌خاطر
   *    زنجیرهٔ `@xenova/transformers → sharp` بارگذاری نمی‌شود
   *    (SE-VEC-10). اجرای واقعی در همین مخزن:
   *    `Cannot find module '../build/Release/sharp-linux-x64.node'`.
   *
   * حالا در `execute` صدا زده می‌شود و اگر مسیر ترنسفورمری در
   * دسترس نبود، به generatorِ بدونِ وابستگی برمی‌گردد.
   *
   * **انتخاب مدل از روی خودِ chunkها**: بردارهای دو مدل مختلف
   * هم‌سنجه نیستند و اگر ابعادشان هم فرق کند، شباهت کسینوسی عددِ
   * بی‌معنا می‌دهد. پس اگر chunkها گفته‌اند با کدام مدل ساخته شده‌اند،
   * همان انتخاب می‌شود؛ وگرنه بردار اصلاً استفاده نمی‌شود.
   */
  private async ensureEmbeddingGenerator(): Promise<IEmbeddingGenerator | undefined> {
    if (this.embeddingGenerator) return this.embeddingGenerator;
    if (!this.vectorStore) return undefined;

    const chunkModel = this.dominantChunkModel();

    if (chunkModel && chunkModel.startsWith('hashing-bag-of-segments-')) {
      const dimensions = Number.parseInt(chunkModel.split('-').pop() ?? '', 10);
      const { HashingEmbeddingGenerator } = await import('../../vector/HashingEmbeddingGenerator');
      this.embeddingGenerator = new HashingEmbeddingGenerator(
        Number.isFinite(dimensions) ? { dimensions } : {}
      );
      return this.embeddingGenerator;
    }

    // آفلاین-محور: بدون مسیر مدل محلی، ترنسفورمر را امتحان نکن — وگرنه
    // transformers.js نام مدل را به‌عنوان شناسهٔ Hub می‌بیند و تلاشِ اتصال به
    // شبکه می‌کند؛ هم خلافِ عهدِ آفلاین بودن است هم در تست‌ها کند/غیرقطعی می‌شود.
    /*
    | `SEMANTIC_ENGINE_MODELS_DIR` is where Settings downloads models (the CLI sets it
    | for every command), so it is just as local as the explicit path. Without it
    | a project indexed with a downloaded model could never be queried with that
    | model, and `semantic_search` degraded to keyword-only (`no-embedding-model`).
    */
    const localModelPath =
      process.env.SEMANTIC_ENGINE_LOCAL_MODEL_PATH || process.env.SEMANTIC_ENGINE_MODELS_DIR || undefined;
    if (!localModelPath) return undefined;

    try {
      const { LocalEmbeddingGenerator } = await import('../../vector/LocalEmbeddingGenerator');
      /*
      | بردارِ پرس‌وجو باید با همان مدلی ساخته شود که chunkها با آن ساخته
      | شده‌اند، وگرنه دو فضای برداری ناهم‌سنجه شباهتِ بی‌معنا می‌دهند.
      */
      const local = new LocalEmbeddingGenerator({
        localModelPath,
        ...(chunkModel ? { model: chunkModel } : {}),
      });
      if (!(await local.isReady())) throw new Error('local embedding model unavailable');
      this.embeddingGenerator = local;
      return this.embeddingGenerator;
    } catch {
      /*
      | نه مدلِ اعلام‌شده‌ای روی chunkها هست و نه مسیر ترنسفورمری کار
      | می‌کند. عمداً به generatorِ پیش‌فرض *برنمی‌گردیم*: بردارهای
      | موجود با مدل دیگری ساخته شده‌اند و پرس‌وجو کردنشان با یک
      | فضای برداریِ دیگر، عددِ بی‌معنا می‌دهد که شبیه عددِ بامعنا
      | است.
      */
      return undefined;
    }
  }

  /** مدلی که بیشترِ chunkها با آن ساخته شده‌اند، اگر اعلام شده باشد. */
  private dominantChunkModel(): string | undefined {
    const counts = new Map<string, number>();
    for (const chunk of this.reader.projectIndex.vectorChunks ?? []) {
      if (!chunk.embedding || chunk.embedding.length === 0) continue;
      const model = chunk.embeddingModel;
      if (!model) continue;
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }

    let winner: string | undefined;
    let best = 0;
    for (const [model, count] of counts) {
      if (count > best) {
        best = count;
        winner = model;
      }
    }
    return winner;
  }

  async execute(input: SemanticSearchInput): Promise<AiToolOutput> {
    try {
      if (typeof input.query !== 'string') return { success: false, error: 'query must be a string', items: [] };
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) return { success: false, error: 'limit must be a positive integer', items: [] };
      if (input.minScore !== undefined && (typeof input.minScore !== 'number' || !Number.isFinite(input.minScore))) return { success: false, error: 'minScore must be a finite number', items: [] };
      if (input.useEmbeddings !== undefined && typeof input.useEmbeddings !== 'boolean') return { success: false, error: 'useEmbeddings must be a boolean', items: [] };
      if (input.mode !== undefined && input.mode !== 'keyword' && input.mode !== 'vector' && input.mode !== 'hybrid') return { success: false, error: 'mode must be keyword, vector, or hybrid', items: [] };
      const mode = input.mode ?? (input.useEmbeddings === false ? 'keyword' : 'hybrid');
      if (input.filters !== undefined && (typeof input.filters !== 'object' || input.filters === null || Array.isArray(input.filters))) return { success: false, error: 'filters must be an object', items: [] };
      const filters = input.filters ?? {};
      const limit = input.limit ?? 20;
      const terms = queryTerms(input.query);

      const kinds = filters.kind ? (Array.isArray(filters.kind) ? filters.kind : [filters.kind]) : [];
      const languages = filters.language ? (Array.isArray(filters.language) ? filters.language : [filters.language]) : [];
      if (kinds.some(kind => typeof kind !== 'string') || languages.some(language => typeof language !== 'string') || (filters.path !== undefined && typeof filters.path !== 'string') || (filters.exportedOnly !== undefined && typeof filters.exportedOnly !== 'boolean')) {
        return { success: false, error: 'filters contain an invalid value', items: [] };
      }

      // Step 1: keyword-based candidates
      const keywordCandidates = mode === 'vector'
        ? []
        : this.candidates.getKeywordCandidates(terms, kinds, languages, filters);

      // Step 2: embedding-based candidates
      let embeddingCandidates: ScoredEntity[] = [];
      let embeddingGenerator: IEmbeddingGenerator | undefined;
      if (mode !== 'keyword' && this.vectorStore) {
        // SE-VEC-02 — تلاش برای ساختنِ generator *پیش* از استفاده،
        // نه داخلِ شاخه‌ای که فقط با داشتنش به آن می‌رسیم.
        embeddingGenerator = await this.ensureEmbeddingGenerator();
        if (embeddingGenerator) {
          embeddingCandidates = await this.candidates.getEmbeddingCandidates(input.query, filters);
        }
      }

      // Step 3: merge and score
      /*
      | SE-VEC-03 — تا فاز ۴۲ اینجا این بود:
      |
      |   merged.set(c.id, { ...c, score: c.score * 0.5 });        // کلیدواژه
      |   merged.set(c.id, { ...existing, score: existing.score + c.score * 0.5 }); // بردار
      |
      | یعنی دو مقیاسِ ناهم‌جنس با ضریب یکسان جمع می‌شدند: کلیدواژه
      | بی‌کران، شباهت کسینوسی کران‌دار به یک. نتیجه‌اش این بود که یک
      | برخوردِ نام (۳ واحد) از یک شباهت کاملِ برداری (۱ واحد) سه برابر
      | سنگین‌تر بود.
      |
      | حالا هر سیگنال خام می‌ماند و `ContextRanker` نرمال‌سازی
      | دسته‌ای می‌کند — و همان‌جا سیگنال‌هایی که موتور می‌ساخت و دور
      | می‌ریخت (aiScore، gitMetrics، complexity، testIds) هم وارد
      | امتیاز می‌شوند (GAP-06).
      */
      const entities = new Map<string, ScoredEntity>();
      const rawKeyword = new Map<string, number>();
      const rawVector = new Map<string, number>();

      for (const c of keywordCandidates) {
        entities.set(c.id, c);
        rawKeyword.set(c.id, c.score);
      }
      for (const c of embeddingCandidates) {
        if (!entities.has(c.id)) entities.set(c.id, c);
        rawVector.set(c.id, c.score);
      }

      const churnRanks: number[] = [];
      for (const f of this.reader.getAllFiles()) {
        const rank = f.gitMetrics?.churnRank;
        if (typeof rank === 'number') churnRanks.push(rank);
      }

      const candidates: RankCandidate<ScoredEntity>[] = Array.from(entities.values()).map(
        entity => {
          const symbol = this.reader.getSymbolById(entity.id);
          const file = symbol
            ? this.reader.getFileById(symbol.fileId)
            : this.reader.getFileById(entity.id);
          const aiScore = file?.aiMetadata?.aiScore;
          const git = file?.gitMetrics;

          return {
            id: entity.id,
            payload: entity,
            signals: {
              keyword: rawKeyword.get(entity.id) ?? null,
              vector: rawVector.get(entity.id) ?? null,
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
        }
      );

      /*
      | SE-AI-HONESTY (P-06) — برشِ `limit` باید اعلام شود. قبلاً یک
      | پرس‌وجوی ۵۰۰نامزدی با `limit: 20` دقیقاً همان شکلِ «۲۰ پاسخ، همه
      | چیز» را برمی‌گرداند و AI نمی‌فهمید که باید سقف را بالا ببرد یا
      | پرس‌وجو را باریک‌تر کند. `totalMatches` کلِ رتبه‌بندی‌شدهٔ منطبق
      | با minScore است (پیش از برش)، نه اندازهٔ صفحه.
      */
      const scoredPool = this.ranker
        .rank<ScoredEntity>(candidates, {
          ...(churnRanks.length > 0 ? { churnRankOutOf: Math.max(...churnRanks) } : {}),
          /*
          | hybridِ واقعی: وقتی بردار در دسته حضور دارد، یک تک‌برخوردِ
          | کلیدواژه‌ای نباید با تطبیقِ معنایی برابر شود. `coreRelevanceSignals`
          | مخرجِ ثابت می‌دهد و وزنِ بردار بالاتر است؛ در حالتِ کلیدواژهٔ خالص
          | (بدون بردار) هیچ‌کدام فعال نمی‌شود و رفتار مثلِ قبل است.
          */
          coreRelevanceSignals: ['keyword', 'vector'],
          weights: { vector: 2, keyword: 1 },
        })
        .filter(r => input.minScore == null || r.score >= input.minScore);
      const totalMatches = scoredPool.length;
      const ranked = scoredPool.slice(0, limit);

      const items = ranked.map(r => {
        const entity = r.payload as ScoredEntity;
        return {
          id: entity.id,
          name: entity.name,
          kind: entity.kind,
          path: entity.path,
          line: entity.line,
          relevanceScore: Math.round(r.score * 1000) / 1000,
          source: entity.source,
          excerpt: entity.excerpt,
          metadata: {
            signals: r.contributions.map(c => c.signal) as SignalName[],
            rawKeyword: rawKeyword.get(entity.id) ?? null,
            rawVector: rawVector.get(entity.id) ?? null,
          },
        };
      });

      return {
        success: true,
        items,
        metadata: {
          keywordCandidates: keywordCandidates.length,
          embeddingCandidates: embeddingCandidates.length,
          /* SE-AI-HONESTY (P-06) — `limit` slice honesty. */
          truncated: totalMatches > ranked.length,
          totalMatches,
          limit,
          /*
          | SE-VEC-02 — قبلاً این فقط می‌گفت «chunk داریم و کاربر
          | مخالفت نکرده»، نه «واقعاً از بردار استفاده شد». کاربر
          | `true` می‌دید در حالی که جست‌وجو صرفاً کلیدواژه‌ای بود.
          */
          usedEmbeddings: embeddingGenerator !== undefined && embeddingCandidates.length > 0,
          embeddingModel: embeddingGenerator?.modelName ?? null,
          /*
          | SE-AI-13 — سطحِ اعتمادِ نتیجه باید خوانا باشد، نه ضمنی.
          | دو اجرایِ یک پرس‌وجو با و بدون مدلِ محلی می‌توانند
          | بیت‌به‌بیت یکی باشند؛ اگر خروجی نگویید کدام موتور
          | رتبه‌بندی کرده، agent نمی‌تواند به نتیجه وزن بدهد.
          */
          ...describeSearchMode({
            requestedMode: mode,
            vectorAvailable: (this.reader.projectIndex.vectorChunks ?? [])
              .some(chunk => Boolean(chunk.embedding) && chunk.embedding!.length > 0),
            generatorReady: embeddingGenerator !== undefined,
            vectorUsed: embeddingCandidates.length > 0,
          }),
          ...(mode !== 'keyword' && this.vectorStore && !embeddingGenerator
            ? { embeddingNote: 'no usable embedding generator for the model these chunks were built with' }
            : {}),
          ...(mode !== 'keyword' && !this.vectorStore
            ? { embeddingNote: 'index has no vector chunks with embeddings' }
            : {}),
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

}
