/**
 * VectorIndexer — تولید chunk های آمادهٔ embedding از روی project-index.
 *
 * ## SE-VEC-01 — تا فاز ۴۴ فقط برچسب embed می‌شد
 *
 * کامنت سرآمدِ همین فایل خودش اعتراف کرده بود: «در آینده می‌توان
 * source code واقعی symbol را هم include کرد». اندازه‌گیری روی ایندکس
 * واقعی `semantic-engine/src` (۲۹۴ فایل، ۸٬۴۱۴ نماد، ۲٬۰۵۱ chunk):
 *
 * ```
 * chunkهایی که هر نشانهٔ کد دارند ({ } ;):  ۲۶۵ از ۲٬۰۵۱
 * میانگین طول chunk:                        ۳۵۸ کاراکتر — همه‌اش برچسب
 * ```
 *
 * و همان ۲۶۵ تا هم فقط پرانتزِ امضا بودند. یعنی «جست‌وجوی معنایی»
 * روی همان چیزی کار می‌کرد که جست‌وجوی کلیدواژه‌ای هم می‌کند: نام و
 * امضا. حالا بدنهٔ واقعی هم داخل chunk می‌آید — برچسب‌ها می‌مانند
 * چون کلماتی دارند (`Kind: function`، مسیر فایل) که در سورس نیستند.
 *
 * ## SE-VEC-09 — شناسه به محتوا گره خورده بود
 *
 * `id` حالا **هویتی** است و فقط از `fileId` و `symbolId` ساخته
 * می‌شود؛ کهنگی از `contentHash` فهمیده می‌شود. با `previous`
 * می‌شود embeddingهای دست‌نخورده را دوباره استفاده کرد به‌جای اینکه
 * کل پروژه بعد از هر ذخیره دوباره embed شود.
 */

import {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
  VectorChunk,
} from '../core/types/project-index.types';
import { sha256 } from '../core/utils/hash';
import { IEmbeddingGenerator, EmbeddingResult } from './EmbeddingGenerator';

export interface VectorIndexerOptions {
  readonly embeddingGenerator?: IEmbeddingGenerator;
  /**
   * حداکثر خطِ سورس در یک chunk. پیش‌فرض ۸۰.
   *
   * مدل‌های embedding پنجرهٔ محدودی دارند (all-MiniLM-L6-v2 حدود ۲۵۶
   * توکن) و یک تابعِ ۵۰۰ خطی هرچه هم مهم باشد، بریده می‌شود. بریدنِ
   * آگاهانه بهتر از بریدنِ خاموشِ tokenizer است.
   */
  readonly maxSourceLines?: number;
  /** حداکثر کاراکترِ کلِ chunk. پیش‌فرض ۴۰۰۰. */
  readonly maxChunkChars?: number;
}

export interface IndexOptions {
  /** `fileId` → محتوای فایل. بدون آن، رفتار قبلی (فقط برچسب). */
  readonly contents?: ReadonlyMap<string, string>;
  /**
   * chunkهای اجرای قبلی. هر chunk با شناسه و `contentHash` یکسان و
   * embeddingِ موجود، دوباره تولید **نمی‌شود** (SE-VEC-09).
   */
  readonly previous?: readonly VectorChunk[];
}

export class VectorIndexer {
  constructor(private readonly options: VectorIndexerOptions = {}) {}

  async index(projectIndex: ProjectIndex, indexOptions: IndexOptions = {}): Promise<VectorChunk[]> {
    const fileById = new Map(projectIndex.files.map(f => [f.id, f]));
    const contents = indexOptions.contents;
    const chunks: VectorChunk[] = [];

    // ۱. File-level chunks (module-level overview)
    for (const file of projectIndex.files) {
      if (file.binary) continue;
      const chunk = this.createFileChunk(file, contents?.get(file.id));
      if (chunk) chunks.push(chunk);
    }

    // ۲. Symbol-level chunks
    for (const sym of projectIndex.symbols) {
      const file = fileById.get(sym.fileId);
      if (!file || file.binary) continue;
      if (!this.isChunkableSymbol(sym)) continue;

      const chunk = this.createSymbolChunk(sym, file, contents?.get(file.id));
      if (chunk) chunks.push(chunk);
    }

    // ۳. Generate embeddings if generator provided
    if (this.options.embeddingGenerator) {
      await this.attachEmbeddings(chunks, indexOptions.previous);
    }

    return chunks;
  }

  /**
   * به‌روزرسانی incremental بردارها.
   *
   * فایل‌های affected از روی index جدید دوباره chunk می‌شوند، اما
   * chunkهای فایل‌های دست‌نخورده همان‌طور که هستند نگه داشته می‌شوند.
   * `attachEmbeddings` نیز embeddingهای هم‌محتوا را reuse می‌کند؛ بنابراین
   * تغییر یک فایل باعث تولید embedding برای کل پروژه نمی‌شود.
   */
  async updateIncremental(
    projectIndex: ProjectIndex,
    affectedFileIds: ReadonlySet<string>,
    contents: ReadonlyMap<string, string>,
    previous: readonly VectorChunk[] = projectIndex.vectorChunks ?? [],
  ): Promise<VectorChunk[]> {
    const liveFileIds = new Set(projectIndex.files.map(file => file.id));
    const liveSymbolIds = new Set(projectIndex.symbols.map(symbol => symbol.id));

    const previousLive = previous.filter(chunk =>
      liveFileIds.has(chunk.fileId) &&
      (!chunk.symbolId || liveSymbolIds.has(chunk.symbolId))
    );

    /*
    | A file whose kept chunks were embedded by another model than the current
    | generator is re-embedded too. Otherwise the first save after changing the
    | model leaves the index half old model, half new: two incomparable vector
    | spaces (and, before the store learned to cope, a project that failed to load).
    */
    const generator = this.options.embeddingGenerator;
    let affected: ReadonlySet<string> = affectedFileIds;
    if (generator) {
      const foreign = new Set<string>();
      for (const chunk of previousLive) {
        if (chunk.embedding && chunk.embeddingModel && chunk.embeddingModel !== generator.modelName) {
          foreign.add(chunk.fileId);
        }
      }
      if (foreign.size > 0) affected = new Set([...affectedFileIds, ...foreign]);
    }

    const retained = previousLive.filter(chunk => !affected.has(chunk.fileId));
    const affectedFiles = projectIndex.files.filter(file => affected.has(file.id));
    const affectedSymbols = projectIndex.symbols.filter(symbol => affected.has(symbol.fileId));
    const affectedIndex: ProjectIndex = {
      ...projectIndex,
      files: affectedFiles,
      symbols: affectedSymbols,
      vectorChunks: undefined,
    };

    const refreshed = await this.index(affectedIndex, {
      contents,
      previous: previousLive.filter(chunk => affected.has(chunk.fileId)),
    });

    return [...retained, ...refreshed].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * فقط chunkهایی embed می‌شوند که تازه یا تغییرکرده‌اند.
   *
   * SE-VEC-09 — پیش از این، هر اجرا کلِ chunkها را دوباره embed
   * می‌کرد، و چون `extension.ts` این کار را بعد از هر ذخیره تکرار
   * می‌کرد، عملاً کلِ پروژه هر بار از نو بردار می‌گرفت.
   */
  private async attachEmbeddings(
    chunks: VectorChunk[],
    previous?: readonly VectorChunk[]
  ): Promise<void> {
    const generator = this.options.embeddingGenerator!;
    const ready = await generator.isReady();
    if (!ready) return;

    const reusable = new Map<string, VectorChunk>();
    let reusableDimensions: number | undefined;
    for (const chunk of previous ?? []) {
      if (!chunk.embedding) continue;
      // An explicitly present empty vector is malformed; only an absent
      // vector means that this chunk still needs embedding.
      if (chunk.embedding.length === 0) {
        throw new Error('previous embedding returned an empty vector');
      }
      // تعویض مدل، بردارهای قبلی را بی‌اعتبار می‌کند: دو مدل، دو
      // فضای برداریِ ناهم‌سنجه‌اند.
      if (chunk.embeddingModel && chunk.embeddingModel !== generator.modelName) continue;
      const dimensions = this.validateEmbeddingVector(chunk.embedding, reusableDimensions, 'previous embedding');
      reusableDimensions ??= dimensions;
      reusable.set(chunk.id, chunk);
    }

    const pending: VectorChunk[] = [];

    for (const chunk of chunks) {
      const prior = reusable.get(chunk.id);
      if (prior && prior.contentHash && prior.contentHash === chunk.contentHash) {
        const writable = chunk as VectorChunk & {
          embedding?: number[];
          embeddingModel?: string;
        };
        writable.embedding = [...prior.embedding!];
        writable.embeddingModel = prior.embeddingModel ?? generator.modelName;
        continue;
      }
      pending.push(chunk);
    }

    if (pending.length === 0) return;

    const results = await generator.generateBatch(pending.map(c => c.content));
    this.validateEmbeddingResults(results, pending.length);

    for (let i = 0; i < pending.length; i++) {
      const chunk = pending[i]!;
      const result = results[i];
      if (!result) throw new Error(`Embedding result missing at index ${i}`);

      const writable = chunk as VectorChunk & { embedding?: number[]; embeddingModel?: string };
      writable.embedding = [...result.embedding];
      writable.embeddingModel = result.model ?? generator.modelName;
    }
  }

  private validateEmbeddingResults(
    results: readonly EmbeddingResult[],
    expected: number
  ): number {
    if (results.length !== expected) {
      throw new Error(`Embedding cardinality mismatch: expected ${expected}, received ${results.length}`);
    }
    let dimensions: number | undefined;
    for (const result of results) {
      dimensions = this.validateEmbeddingVector(result.embedding, dimensions, 'embedding provider');
    }
    // expected is positive whenever this helper is called from pending, but
    // retaining a deterministic failure makes the invariant explicit.
    if (dimensions === undefined) throw new Error('Embedding provider returned no vectors');
    return dimensions;
  }

  private validateEmbeddingVector(
    vector: readonly number[] | undefined,
    expectedDimensions: number | undefined,
    source: string
  ): number {
    if (!Array.isArray(vector) || vector.length === 0 || vector.some(value => !Number.isFinite(value))) {
      throw new Error(`${source} returned an empty, non-finite, or invalid vector`);
    }
    if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
      throw new Error(`${source} returned inconsistent vector dimensions: expected ${expectedDimensions}, received ${vector.length}`);
    }
    return vector.length;
  }

  private createFileChunk(file: FileEntry, source?: string): VectorChunk | null {
    const lines = file.lines ?? 1;
    const content = this.cap(this.buildFileContent(file, source));

    return {
      id: this.chunkId(file.id, null),
      fileId: file.id,
      symbolId: null,
      unit: 'module',
      content,
      contentHash: this.hashContent(content),
      startLine: 1,
      endLine: Math.max(1, lines),
      tokenEstimate: this.estimateTokens(content),
    };
  }

  private createSymbolChunk(
    sym: SymbolEntry,
    file: FileEntry,
    source?: string
  ): VectorChunk | null {
    const content = this.cap(this.buildSymbolContent(sym, file, source));

    return {
      id: this.chunkId(file.id, sym.id),
      fileId: file.id,
      symbolId: sym.id,
      unit: this.mapSymbolKindToUnit(sym.kind),
      content,
      contentHash: this.hashContent(content),
      startLine: sym.line,
      endLine: Math.max(sym.line, sym.endLine),
      tokenEstimate: this.estimateTokens(content),
    };
  }

  /** خطوط `[from, to]` (۱-مبنا) از سورس، با سقفِ خط. */
  private sliceSource(source: string, from: number, to: number): string {
    const maxLines = this.options.maxSourceLines ?? 80;
    const all = source.split('\n');
    const start = Math.max(0, from - 1);
    const end = Math.min(all.length, Math.max(from, to));
    return all.slice(start, Math.min(end, start + maxLines)).join('\n');
  }

  private cap(content: string): string {
    const max = this.options.maxChunkChars ?? 4000;
    return content.length <= max ? content : content.slice(0, max);
  }

  private buildFileContent(file: FileEntry, source?: string): string {
    const parts: string[] = [
      `File: ${file.path}`,
      `Language: ${file.language ?? 'unknown'}`,
    ];

    if (file.aiMetadata?.summary) {
      parts.push(`Summary: ${file.aiMetadata.summary}`);
    }

    const exportNames = (file.exports ?? []).map(e => e.name).filter(n => n.length > 0);
    if (exportNames.length > 0) {
      parts.push(`Exports: ${exportNames.join(', ')}`);
    }

    const importFroms = (file.imports ?? []).map(i => i.from).filter(f => f.length > 0);
    if (importFroms.length > 0) {
      parts.push(`Imports from: ${importFroms.join(', ')}`);
    }

    if (file.aiMetadata?.keywords && file.aiMetadata.keywords.length > 0) {
      parts.push(`Keywords: ${file.aiMetadata.keywords.join(', ')}`);
    }

    /*
    | سرِ فایل: importها و چند خط اول، همان چیزی که یک آدم برای
    | فهمیدن «این فایل دربارهٔ چیست» نگاه می‌کند.
    */
    if (source) {
      parts.push('Source:', this.sliceSource(source, 1, this.options.maxSourceLines ?? 80));
    }

    return parts.join('\n');
  }

  private buildSymbolContent(sym: SymbolEntry, file: FileEntry, source?: string): string {
    const parts: string[] = [
      `Symbol: ${sym.name}`,
      `Kind: ${sym.kind}`,
      `File: ${file.path}`,
    ];

    if (sym.signature) {
      parts.push(`Signature: ${sym.signature}`);
    }

    if (sym.fullyQualifiedName) {
      parts.push(`FQN: ${sym.fullyQualifiedName}`);
    }

    if (sym.documentation) {
      parts.push(`Docs: ${sym.documentation}`);
    }

    if (sym.returnType) {
      parts.push(`Returns: ${sym.returnType}`);
    }

    if (sym.parameters && sym.parameters.length > 0) {
      const params = sym.parameters.map(p => `${p.name}: ${p.type ?? 'unknown'}`).join(', ');
      parts.push(`Parameters: (${params})`);
    }

    if (typeof sym.complexity === 'number') {
      parts.push(`Complexity: ${sym.complexity}`);
    }

    if (typeof sym.referenceCount === 'number') {
      parts.push(`Cross-file references: ${sym.referenceCount}`);
    }

    /*
    | SE-VEC-01 — بدنهٔ واقعی. برچسب‌ها بالا می‌مانند چون کلماتی
    | دارند که در سورس نیستند (نوعِ نماد، مسیر فایل، شمار ارجاع) و
    | برای پرس‌وجوهای «کجا کلاسِ X است» مفیدند.
    */
    if (source) {
      const body = this.sliceSource(source, sym.line, Math.max(sym.line, sym.endLine));
      if (body.trim().length > 0) parts.push('Source:', body);
    }

    return parts.join('\n');
  }

  private isChunkableSymbol(sym: SymbolEntry): boolean {
    return sym.kind === 'class' ||
      sym.kind === 'interface' ||
      sym.kind === 'function' ||
      sym.kind === 'method';
  }

  private mapSymbolKindToUnit(kind: SymbolEntry['kind']): VectorChunk['unit'] {
    if (kind === 'interface') return 'interface';
    if (kind === 'function') return 'function';
    if (kind === 'method') return 'method';
    return 'class';
  }

  private estimateTokens(content: string): number {
    // rough estimate: ~4 chars per token
    return Math.max(1, Math.ceil(content.length / 4));
  }

  /**
   * شناسهٔ هویتی — SE-VEC-09.
   *
   * قبلاً محتوا داخل هش بود (`${fileId}:${unit}:${content}`)، پس هر
   * ویرایش یک chunk «جدید» می‌ساخت و embeddingِ قبلی بی‌استفاده
   * می‌شد. ضمناً `unit` برای تفکیک دو نمادِ هم‌نوع در یک فایل کافی
   * نبود و فقط چون محتوا داخل هش بود تصادم رخ نمی‌داد.
   */
  private chunkId(fileId: string, symbolId: string | null): string {
    const input = `${fileId}:${symbolId ?? 'module'}`;
    return `vec-${sha256(input).substring(0, 16)}`;
  }

  private hashContent(content: string): string {
    return sha256(content).substring(0, 16);
  }
}
