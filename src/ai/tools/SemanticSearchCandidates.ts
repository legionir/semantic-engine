/**
 * Candidate gathering of the semantic search tool (keyword via the term index,
 * vector via the vector store) — split from SemanticSearchTool.ts, behavior unchanged.
 */

import type { SymbolEntry } from '../../core/types/project-index.types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { VectorStore, VectorStoreOptions } from '../../vector/VectorStore';
import type { IEmbeddingGenerator } from '../../vector/EmbeddingGenerator';
import { identifierSegments, matchesSegments } from './queryTerms';
import { SymbolTermIndex } from './SymbolTermIndex';
import type { SemanticSearchInput } from './SemanticSearchTool';

/**
 * SE-VEC-12 — پیش‌فرضِ پایین و عمدی.
 *
 * لایهٔ برداری «نامزد» تولید می‌کند، نه «جواب». حذف کردن نامزد بر
 * اساس یک آستانهٔ مطلق، کارِ رتبه‌بند را پیش از رتبه‌بندی انجام
 * می‌دهد — و با عددی که هیچ‌کس تنظیمش نکرده.
 */
const DEFAULT_MIN_SCORE = 0.05;

export interface ScoredEntity {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly path?: string;
  readonly line?: number;
  readonly source: string;
  readonly excerpt?: string;
  /**
   * امتیاز **خام** — برای کلیدواژه بی‌کران، برای بردار در بازهٔ ۰..۱.
   *
   * تا فاز ۴۲ همین عدد مستقیم با ضریب ۰٫۵ جمع می‌شد و SE-VEC-03
   * دقیقاً همین بود. حالا خام می‌ماند و نرمال‌سازی را `ContextRanker`
   * انجام می‌دهد، که مقیاس هر سیگنال را نسبت به دستهٔ نامزدها
   * می‌سنجد.
   */
  readonly score: number;
}

export interface CandidateSources {
  readonly reader: ProjectIndexReader;
  readonly termIndex: SymbolTermIndex;
  readonly vectorStore: VectorStore | null;
  readonly vectorStoreOptions?: VectorStoreOptions;
  readonly ensureEmbeddingGenerator: () => Promise<IEmbeddingGenerator | undefined>;
}

export class SemanticSearchCandidates {
  private readonly reader: ProjectIndexReader;
  private readonly termIndex: SymbolTermIndex;
  private readonly vectorStore: VectorStore | null;
  private readonly vectorStoreOptions: VectorStoreOptions | undefined;
  private readonly ensureEmbeddingGenerator: () => Promise<IEmbeddingGenerator | undefined>;

  constructor(sources: CandidateSources) {
    this.reader = sources.reader;
    this.termIndex = sources.termIndex;
    this.vectorStore = sources.vectorStore;
    this.vectorStoreOptions = sources.vectorStoreOptions;
    this.ensureEmbeddingGenerator = sources.ensureEmbeddingGenerator;
  }

  getKeywordCandidates(
    terms: string[],
    kinds: string[],
    languages: string[],
    filters: SemanticSearchInput['filters']
  ): ScoredEntity[] {
    /*
    | SE-VEC-04 — به‌جای پیمایشِ همهٔ نمادها، فقط آنهایی که ایندکس
    | معکوس نامزد می‌داند. `SymbolTermIndex` تضمین می‌کند مجموعه‌اش
    | دقیقاً همان چیزی است که پیمایشِ کامل می‌داد؛ آزمونِ برابری‌اش
    | این را روی هفت پرس‌وجو می‌سنجد.
    */
    const candidateIds = this.termIndex.candidatesFor(terms);

    /*
    | نامزدها مستقیم از روی شناسه برداشته می‌شوند، نه با فیلترِ
    | `getAllSymbols()`. آن فیلتر خودش یک پیمایشِ کاملِ دیگر است و
    | نصفِ صرفه‌جوییِ ایندکس معکوس را پس می‌دهد.
    */
    let symbols: SymbolEntry[] = [];
    for (const id of candidateIds) {
      const symbol = this.reader.getSymbolById(id);
      if (symbol) symbols.push(symbol);
    }
    // ترتیب پایدار: `Set` ترتیبِ درج دارد که به ترتیبِ ساختِ ایندکس
    // گره خورده؛ مرتب‌سازی صریح، نتیجه را از آن مستقل می‌کند.
    symbols.sort((a, b) => a.id.localeCompare(b.id));

    if (kinds.length > 0) symbols = symbols.filter(s => kinds.includes(s.kind));
    if (filters?.exportedOnly) symbols = symbols.filter(s => s.exported);

    if (languages.length > 0 || filters?.path) {
      symbols = symbols.filter(s => {
        const file = this.reader.getFileById(s.fileId);
        if (!file) return false;
        if (languages.length > 0 && file.language && !languages.includes(file.language)) return false;
        if (filters?.path && !file.path.toLowerCase().includes(filters.path.toLowerCase())) return false;
        return true;
      });
    }

    return symbols.map(symbol => {
      const file = this.reader.getFileById(symbol.fileId);

      /*
      | SE-VEC-11 — تطبیق روی **قطعه‌های** شناسه است، نه زیررشتهٔ خام.
      |
      | قبلاً `symbol.name.toLowerCase().includes(term)` بود، که یعنی
      | «at» داخل «aiMetadata» می‌خورد و «the» داخل «otherEvents».
      | روی ایندکس واقعی، پرس‌وجوی «at» هشتاد و دو درصد ایندکس را
      | نامزد می‌کرد.
      */
      // قطعه‌ها یک‌بار هنگام ساختِ ایندکس معکوس حساب شده‌اند.
      const cached = this.termIndex.segmentsOf(symbol.id);
      const nameSegments = cached
        ? cached.name
        : identifierSegments(symbol.name);
      const contextSegments = cached
        ? cached.context
        : [
            ...(symbol.fullyQualifiedName ? identifierSegments(symbol.fullyQualifiedName) : []),
            ...(symbol.signature ? identifierSegments(symbol.signature) : []),
            ...(symbol.documentation ? identifierSegments(symbol.documentation) : []),
            ...(file?.path ? identifierSegments(file.path) : []),
            ...(file?.aiMetadata?.summary ? identifierSegments(file.aiMetadata.summary) : []),
          ];

      let keywordScore = 0;
      for (const term of terms) {
        if (matchesSegments(term, nameSegments)) keywordScore += 3;
        else if (this.matchesContextTerm(term, contextSegments)) keywordScore += 1;
      }

      /*
      | فقط سیگنالِ خامِ کلیدواژه. مرکزیت و «exported» از اینجا حذف
      | شدند چون داخل یک عددِ واحد قاطی می‌شدند و بعد قابل تفکیک
      | نبودند؛ حالا هر کدام سیگنالِ مستقلِ خودشان را در
      | `ContextRanker` دارند و در `metadata.signals` قابل دیدن‌اند.
      */
      return {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        path: file?.path,
        line: symbol.line,
        source: symbol.source,
        excerpt: symbol.signature ?? symbol.documentation ?? file?.aiMetadata?.summary,
        score: keywordScore,
      };
    }).filter(c => c.score > 0);
  }

  matchesContextTerm(term: string, segments: readonly string[]): boolean {
    const latin = /^[a-z0-9_]+$/.test(term);
    return segments.some(segment => segment === term || segment.startsWith(term) || (!latin && segment.includes(term)));
  }

  async getEmbeddingCandidates(
    query: string,
    filters: SemanticSearchInput['filters']
  ): Promise<ScoredEntity[]> {
    if (!this.vectorStore) return [];

    const generator = await this.ensureEmbeddingGenerator();
    if (!generator) return [];

    const queryEmbedding = await generator.generate(query);
    const kinds = filters?.kind ? (Array.isArray(filters.kind) ? filters.kind : [filters.kind]) : [];

    const results = await this.vectorStore.search(queryEmbedding.embedding, {
      topK: this.vectorStoreOptions?.topK ?? 50,
      /*
      | SE-VEC-12 — این عدد قبلاً `0.3` و هاردکد بود. آستانهٔ شباهت
      | به مدل وابسته است و یک ثابتِ دلبخواه، برای هر مدلی جز آنکه
      | در ذهن نویسنده بوده یعنی حذفِ کامل نتایج.
      */
      minScore: this.vectorStoreOptions?.minScore ?? DEFAULT_MIN_SCORE,
      filter: chunk => {
        if (kinds.length > 0 && chunk.symbolId) {
          const sym = this.reader.getSymbolById(chunk.symbolId);
          if (sym && !kinds.includes(sym.kind)) return false;
        }
        /*
        | SE-VEC-06 — فیلتر مسیر باید روی مسیرِ **فایلِ** chunk
        | باشد. قبلاً با `chunk.content` مقایسه می‌شد، پس فایلی که
        | فقط آن مسیر را import کرده بود قبول می‌شد و chunkهای واقعیِ
        | همان پوشه که مسیرشان در متن نیامده بود رد می‌شدند.
        */
        if (filters?.path) {
          const owner = this.reader.getFileById(chunk.fileId);
          const ownerPath = owner?.path.toLowerCase() ?? '';
          if (!ownerPath.includes(filters.path.toLowerCase())) return false;
        }
        return true;
      },
    });

    const candidates = new Map<string, ScoredEntity>();

    for (const result of results) {
      const chunk = result.chunk;
      if (chunk.symbolId) {
        const sym = this.reader.getSymbolById(chunk.symbolId);
        const file = sym ? this.reader.getFileById(sym.fileId) : undefined;
        if (!sym) continue;
        if (filters?.exportedOnly && !sym.exported) continue;

        const existing = candidates.get(sym.id);
        if (!existing || existing.score < result.score) {
          candidates.set(sym.id, {
            id: sym.id,
            name: sym.name,
            kind: sym.kind,
            path: file?.path,
            line: sym.line,
            source: sym.source,
            excerpt: sym.signature ?? sym.documentation ?? undefined,
            score: result.score,
          });
        }
      } else {
        const file = this.reader.getFileById(chunk.fileId);
        if (!file) continue;

        const existing = candidates.get(file.id);
        if (!existing || existing.score < result.score) {
          candidates.set(file.id, {
            id: file.id,
            name: file.path,
            kind: 'file',
            path: file.path,
            source: 'index',
            excerpt: file.aiMetadata?.summary,
            score: result.score,
          });
        }
      }
    }

    return Array.from(candidates.values());
  }
}
