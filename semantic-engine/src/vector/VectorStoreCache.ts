/**
 * VectorStoreCache — SE-VEC-07.
 *
 * ## مسئله
 *
 * `VectorStore` در سازندهٔ `SemanticSearchTool` ساخته می‌شود، و
 * `SemanticSearchTool` بیش از یک بار ساخته می‌شود: یک نمونه در
 * `AiToolRegistry` و یک نمونهٔ دیگر داخل `ContextDiscoverer`. با
 * backendِ `usearch`، هر ساخت یعنی برپا کردن کاملِ یک گرافِ HNSW از
 * صفر روی همان بردارها — و هیچ چیزی روی دیسک نگه داشته نمی‌شود، پس
 * این هزینه در هر پروسه تکرار می‌شود.
 *
 * ## راه‌حل
 *
 * کلیدِ کش خودِ **آرایهٔ chunkهاست**، نه یک شناسهٔ ساختگی. دو
 * مصرف‌کننده‌ای که یک `ProjectIndex` را می‌خوانند، به یک آرایه اشاره
 * می‌کنند و همان یک `VectorStore` را می‌گیرند. اگر ایندکس عوض شود،
 * آرایه هم عوض می‌شود و کش خودبه‌خود بی‌اعتبار می‌شود — بدون هیچ
 * منطق ابطالِ دستی که بشود از قلم انداخت.
 *
 * `WeakMap` است تا کش، ایندکسِ رهاشده را در حافظه حبس نکند.
 */

import { VectorChunk } from '../core/types/project-index.types';
import { VectorStore, VectorStoreOptions } from './VectorStore';

/** کلیدِ ثانویه، چون گزینه‌های متفاوت ایندکس متفاوتی می‌سازند. */
function optionsKey(options?: VectorStoreOptions): string {
  if (!options) return 'default';
  return JSON.stringify([
    options.backend ?? 'auto',
    options.usearchThreshold ?? null,
    options.minScore ?? null,
    options.topK ?? null,
  ]);
}

export class VectorStoreCache {
  /** نمونهٔ مشترک، تا دو ابزار در یک پروسه دو ایندکس نسازند. */
  static readonly shared = new VectorStoreCache();

  private readonly byChunks = new WeakMap<
    readonly VectorChunk[],
    Map<string, VectorStore>
  >();

  private built = 0;

  /** چند بار واقعاً یک ایندکس ساخته شد. برای اثباتِ «یک‌بار». */
  get buildCount(): number {
    return this.built;
  }

  get usesWeakReferences(): boolean {
    return this.byChunks instanceof WeakMap;
  }

  /**
   * `VectorStore` برای این آرایهٔ chunk، ساخته‌شده حداکثر یک بار.
   *
   * `null` یعنی چیزی برای جست‌وجو نیست — همان قراردادی که
   * `SemanticSearchTool` از قبل داشت.
   */
  forChunks(
    chunks: readonly VectorChunk[],
    options?: VectorStoreOptions
  ): VectorStore | null {
    if (chunks.length === 0) return null;

    let byOptions = this.byChunks.get(chunks);
    if (!byOptions) {
      byOptions = new Map<string, VectorStore>();
      this.byChunks.set(chunks, byOptions);
    }

    const key = optionsKey(options);
    const existing = byOptions.get(key);
    if (existing) return existing;

    const store = new VectorStore([...chunks], options);
    byOptions.set(key, store);
    this.built++;
    return store;
  }
}
