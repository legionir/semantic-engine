/**
 * SE-VEC-07 — ایندکس برداری برای هر مصرف‌کننده از نو ساخته می‌شد.
 *
 * `VectorStore` در سازندهٔ `SemanticSearchTool` ساخته می‌شود، و
 * `SemanticSearchTool` در چند جا ساخته می‌شود: یک‌بار در
 * `AiToolRegistry`، یک‌بار داخل `ContextDiscoverer`. با backendِ
 * `usearch` هر ساخت یعنی برپا کردن کاملِ یک گرافِ HNSW از صفر، و هیچ
 * چیزی روی دیسک نگه داشته نمی‌شود.
 *
 * راه‌حل یک کشِ کوچک است که کلیدش خودِ آرایهٔ chunkهاست: دو
 * مصرف‌کننده که یک ایندکس را می‌خوانند، یک `VectorStore` می‌گیرند.
 */

import { VectorStoreCache } from './VectorStoreCache';
import { VectorChunk } from '../core/types/project-index.types';

function chunk(id: string, embedding: number[]): VectorChunk {
  return {
    id,
    fileId: 'f1',
    symbolId: null,
    unit: 'module',
    content: id,
    startLine: 1,
    endLine: 1,
    tokenEstimate: 1,
    embedding,
  };
}

describe('VectorStoreCache (SE-VEC-07)', () => {
  it('همان آرایهٔ chunk، همان نمونه را می‌دهد', () => {
    const cache = new VectorStoreCache();
    const chunks = [chunk('a', [1, 0]), chunk('b', [0, 1])];

    expect(cache.forChunks(chunks)).toBe(cache.forChunks(chunks));
  });

  it('دو آرایهٔ متفاوت، دو نمونه می‌گیرند', () => {
    const cache = new VectorStoreCache();
    const first = [chunk('a', [1, 0])];
    const second = [chunk('b', [0, 1])];

    expect(cache.forChunks(first)).not.toBe(cache.forChunks(second));
  });

  it('آرایهٔ خالی، نمونه نمی‌سازد', () => {
    const cache = new VectorStoreCache();
    expect(cache.forChunks([])).toBeNull();
  });

  it('گزینه‌های متفاوت، نمونهٔ متفاوت می‌سازند', () => {
    const cache = new VectorStoreCache();
    const chunks = [chunk('a', [1, 0])];

    const brute = cache.forChunks(chunks, { backend: 'brute-force' });
    const auto = cache.forChunks(chunks, { backend: 'auto' });

    expect(brute).not.toBe(auto);
  });

  it('شمارِ ساخت را گزارش می‌کند، تا «یک‌بار ساخته شد» قابل اثبات باشد', () => {
    const cache = new VectorStoreCache();
    const chunks = [chunk('a', [1, 0])];

    expect(cache.buildCount).toBe(0);
    cache.forChunks(chunks);
    cache.forChunks(chunks);
    cache.forChunks(chunks);
    expect(cache.buildCount).toBe(1);
  });

  it('کشِ سراسری بین دو مصرف‌کننده مشترک است', () => {
    const chunks = [chunk('a', [1, 0])];
    const before = VectorStoreCache.shared.buildCount;

    const one = VectorStoreCache.shared.forChunks(chunks);
    const two = VectorStoreCache.shared.forChunks(chunks);

    expect(one).toBe(two);
    expect(VectorStoreCache.shared.buildCount).toBe(before + 1);
  });

  it('ارجاعِ ضعیف است: کش، ایندکسِ رهاشده را زنده نگه نمی‌دارد', () => {
    // WeakMap تضمین می‌کند نگه‌داشتنِ کش، کلِ ایندکس پروژه را در
    // حافظه حبس نکند. این را نمی‌شود مستقیم آزمود، ولی می‌شود
    // تضمین کرد که ساختار داده واقعاً WeakMap است.
    expect(new VectorStoreCache().usesWeakReferences).toBe(true);
  });
});
