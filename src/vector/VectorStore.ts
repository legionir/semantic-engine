/**
 * VectorStore — جستجوی نزدیک‌ترین همسایه برای vector chunks.
 *
 * پشتیبانی از دو backend:
 * - brute-force: همیشه در دسترس، دقیق، برای پروژه‌های کوچک
 * - usearch: approximate nearest neighbor، برای پروژه‌های بزرگ
 *
 * انتخاب backend بر اساس تعداد chunks و تنظیمات:
 * - اگر تعداد chunks از threshold بیشتر باشد و usearch نصب باشد، از usearch استفاده می‌شود.
 * - در غیر این صورت brute-force.
 */

import { VectorChunk } from '../core/types/project-index.types';

export interface VectorSearchResult {
  readonly chunk: VectorChunk;
  readonly score: number;
}

export interface VectorSearchOptions {
  readonly filter?: (chunk: VectorChunk) => boolean;
  readonly topK?: number;
  readonly minScore?: number;
}

export interface VectorStoreOptions {
  readonly backend?: 'brute-force' | 'usearch' | 'auto';
  /** آستانهٔ تعداد chunks برای انتخاب usearch در حالت auto */
  readonly usearchThreshold?: number;
  /**
   * حداقل شباهت برای اینکه یک chunk نامزد شود — SE-VEC-12.
   *
   * قبلاً `0.3` در محلِ فراخوانی هاردکد بود. این عدد به **مدل**
   * وابسته است: برای یک مدل ترنسفورمریِ نرمال‌شده معنا دارد، و برای
   * یک بردار واژگانی یعنی حذفِ کامل. اندازه‌گیری با generator
   * پیش‌فرض فاز ۴۴: شباهت پرس‌وجو با chunkِ درست ۰٫۲۴ بود، یعنی
   * زیر آستانه، یعنی هیچ نتیجه‌ای.
   *
   * پیش‌فرض عمداً پایین است؛ فیلترِ واقعی `topK` و رتبه‌بند است.
   */
  readonly minScore?: number;
  /** چند نامزد از لایهٔ برداری بیرون بیاید. پیش‌فرض ۵۰. */
  readonly topK?: number;
}

export interface VectorStoreBackend {
  readonly name: string;
  search(queryEmbedding: readonly number[], options: VectorSearchOptions): Promise<VectorSearchResult[]>;
}

class BruteForceBackend implements VectorStoreBackend {
  readonly name = 'brute-force';

  constructor(private readonly chunks: VectorChunk[]) {}

  async search(queryEmbedding: readonly number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? 0;
    const filter = options.filter ?? (() => true);

    const scored: VectorSearchResult[] = [];

    for (const chunk of this.chunks) {
      if (!filter(chunk)) continue;
      const score = this.cosineSimilarity(queryEmbedding, chunk.embedding!);
      if (score >= minScore) {
        scored.push({ chunk, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * SE-VEC-13 — نگهبانِ ابعاد.
   *
   * قبلاً حلقه روی `a.length` بود و `b[i]` بدون بررسی خوانده می‌شد.
   * اگر `b` کوتاه‌تر بود، `undefined` وارد حساب می‌شد و `NaN`
   * بیرون می‌آمد که بی‌صدا از فیلتر می‌افتاد؛ و اگر `a` کوتاه‌تر
   * بود، شباهت فقط روی چند بُعدِ اول حساب می‌شد و یک بردار
   * تک‌بُعدی «تطابق کامل» می‌گرفت.
   *
   * دو مدلِ متفاوت، دو فضای برداریِ ناهم‌سنجه‌اند. پاسخ درست
   * «شباهتِ صفر» است، نه یک عددِ ساختگی.
   */
  private cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

interface UsearchMatches {
  readonly keys: readonly bigint[];
  readonly distances: readonly number[];
}

interface UsearchIndex {
  add(keys: readonly bigint[], vectors: readonly number[][]): void;
  search(query: Float32Array, count: number, offset: number): UsearchMatches;
}

class UsearchBackend implements VectorStoreBackend {
  readonly name = 'usearch';
  private readonly index: UsearchIndex;
  private readonly chunksByKey: Map<bigint, VectorChunk>;

  constructor(chunks: VectorChunk[]) {
    if (chunks.length === 0) {
      throw new Error('Cannot create usearch index with zero chunks');
    }

    const dimensions = chunks[0]!.embedding!.length;
    const { Index, MetricKind, ScalarKind } = require('usearch') as {
      Index: new (options: Record<string, unknown>) => UsearchIndex;
      MetricKind: { Cos: unknown };
      ScalarKind: { F32: unknown };
    };

    this.index = new Index({
      dimensions,
      metric: MetricKind.Cos,
      quantization: ScalarKind.F32,
      connectivity: 16,
      expansion_add: 40,
      expansion_search: 16,
      multi: false,
    });

    const keys: bigint[] = [];
    const vectors: number[][] = [];
    this.chunksByKey = new Map();

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const key = BigInt(i);
      keys.push(key);
      vectors.push(Array.from(chunk.embedding!));
      this.chunksByKey.set(key, chunk);
    }

    this.index.add(keys, vectors);
  }

  async search(queryEmbedding: readonly number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? 0;
    const filter = options.filter;

    // usearch نمی‌تواند filter داشته باشد؛ پس اگر filter فعال باشد باید topK بزرگ‌تری بگیریم و سپس فیلتر کنیم
    const searchK = filter ? Math.min(topK * 10, this.chunksByKey.size) : topK;

    const query = new Float32Array(queryEmbedding as number[]);
    const matches = this.index.search(query, searchK, 0);

    const results: VectorSearchResult[] = [];
    for (let i = 0; i < matches.keys.length; i++) {
      const key = matches.keys[i]!;
      const score = 1 - matches.distances[i]!; // usearch cosine distance → similarity
      if (score < minScore) continue;

      const chunk = this.chunksByKey.get(key);
      if (!chunk) continue;
      if (filter && !filter(chunk)) continue;

      results.push({ chunk, score });
      if (results.length >= topK) break;
    }

    return results;
  }
}

/** The chunks that share the most common embedding size, order kept. */
export function dominantDimension(chunks: readonly VectorChunk[]): VectorChunk[] {
  const counts = new Map<number, number>();
  for (const chunk of chunks) counts.set(chunk.embedding!.length, (counts.get(chunk.embedding!.length) ?? 0) + 1);
  if (counts.size <= 1) return [...chunks];
  let winner = 0;
  let best = -1;
  for (const [size, count] of counts) {
    if (count > best) {
      best = count;
      winner = size;
    }
  }
  return chunks.filter(chunk => chunk.embedding!.length === winner);
}

export class VectorStore {
  readonly backend: VectorStoreBackend;

  constructor(
    chunks: readonly VectorChunk[],
    options: VectorStoreOptions = {}
  ) {
    const validChunks = chunks.filter(c => c.embedding && c.embedding.length > 0);
    const backendName = this.selectBackend(validChunks.length, options);

    if (backendName === 'usearch') {
      /*
      | One usearch index, one vector space. An index can hold chunks of two
      | models for a while (a model was changed in Settings and only the files
      | touched since were re-embedded). usearch takes its dimension from the
      | first chunk and threw "length of keys must match the number of vectors"
      | on the rest, which made the whole project fail to load. Keep the dominant
      | size; the others cannot be compared with the query anyway, which is what
      | the brute-force backend already expresses as a score of 0.
      */
      this.backend = new UsearchBackend(dominantDimension(validChunks));
    } else {
      this.backend = new BruteForceBackend(validChunks);
    }
  }

  private selectBackend(
    chunkCount: number,
    options: VectorStoreOptions
  ): 'brute-force' | 'usearch' {
    const backend = options.backend ?? 'auto';
    if (backend === 'brute-force') return 'brute-force';
    if (backend === 'usearch') {
      if (!this.isUsearchAvailable()) {
        throw new Error('usearch backend requested but package is not available');
      }
      return 'usearch';
    }

    // auto
    const threshold = options.usearchThreshold ?? 500;
    if (chunkCount >= threshold && this.isUsearchAvailable()) {
      return 'usearch';
    }
    return 'brute-force';
  }

  private isUsearchAvailable(): boolean {
    try {
      require('usearch');
      return true;
    } catch {
      return false;
    }
  }

  async search(queryEmbedding: readonly number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    return this.backend.search(queryEmbedding, options);
  }
}
