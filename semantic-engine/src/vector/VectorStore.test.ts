import { VectorStore } from './VectorStore';
import { VectorChunk } from '../core/types/project-index.types';

function createChunk(id: string, content: string, embedding: number[]): VectorChunk {
  return {
    id,
    fileId: 'file1',
    symbolId: null,
    unit: 'module',
    content,
    startLine: 1,
    endLine: 1,
    tokenEstimate: 10,
    embedding,
  };
}

describe('VectorStore', () => {
  const chunks: VectorChunk[] = [
    createChunk('c1', 'user authentication', [1, 0, 0]),
    createChunk('c2', 'database connection', [0, 1, 0]),
    createChunk('c3', 'logging utility', [0, 0, 1]),
  ];

  it('should find most similar chunks by cosine similarity (brute-force)', async () => {
    const store = new VectorStore(chunks, { backend: 'brute-force' });
    expect(store.backend.name).toBe('brute-force');

    const results = await store.search([0.9, 0.1, 0], { topK: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]!.chunk.id).toBe('c1');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('should filter chunks (brute-force)', async () => {
    const store = new VectorStore(chunks, { backend: 'brute-force' });
    const results = await store.search([1, 0, 0], {
      topK: 10,
      filter: chunk => chunk.id === 'c1',
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.chunk.id).toBe('c1');
  });

  it('should support usearch backend when available', async () => {
    let usearchAvailable: boolean;
    try {
      require('usearch');
      usearchAvailable = true;
    } catch {
      usearchAvailable = false;
    }

    if (!usearchAvailable) {
      // skip test if usearch is not installed
      return;
    }

    const store = new VectorStore(chunks, { backend: 'usearch' });
    expect(store.backend.name).toBe('usearch');

    const results = await store.search([0.9, 0.1, 0], { topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.chunk.id).toBe('c1');
  });

  it('should auto-select usearch for large datasets', async () => {
    let usearchAvailable: boolean;
    try {
      require('usearch');
      usearchAvailable = true;
    } catch {
      usearchAvailable = false;
    }

    const largeChunks: VectorChunk[] = [];
    for (let i = 0; i < 600; i++) {
      largeChunks.push(createChunk(`c${i}`, `content ${i}`, [Math.random(), Math.random(), Math.random()]));
    }

    const store = new VectorStore(largeChunks, { backend: 'auto', usearchThreshold: 500 });

    if (usearchAvailable) {
      expect(store.backend.name).toBe('usearch');
    } else {
      expect(store.backend.name).toBe('brute-force');
    }
  });

  it('should exclude chunks without embeddings', () => {
    const chunksWithMissing: VectorChunk[] = [
      createChunk('c1', 'auth', [1, 0, 0]),
      { ...createChunk('c2', 'no embedding', []), embedding: undefined },
    ];

    const store = new VectorStore(chunksWithMissing);
    expect(store.backend.name).toBe('brute-force');
  });
});

/*
| SE-VEC-13 — ابعادِ ناهم‌خوان، عددِ بی‌معنا می‌داد که شبیه عددِ
| بامعنا بود.
|
| `cosineSimilarity` روی `a.length` حلقه می‌زد و `b[i]` را بدون بررسی
| می‌خواند. اجرای واقعی پیش از رفع:
|
|   query با ۴ بُعد در برابر chunk با ۲ بُعد  →  NaN  →  بی‌صدا حذف
|   query با ۱ بُعد در برابر chunk با ۲ بُعد  →  score = 1.0  ← «تطابق کامل»
|
| حالت دوم بدتر است: یک بردار تک‌بُعدی، «کاملاً منطبق» گزارش می‌شد.
| این دقیقاً وقتی پیش می‌آید که ایندکس با یک مدل ساخته شده باشد و
| پرس‌وجو با مدلی دیگر — حالتی که پس از افزوده شدن generator دومِ فاز
| ۴۴ کاملاً ممکن است.
*/
describe('VectorStore — نگهبانِ ابعاد (SE-VEC-13)', () => {
  function chunkWith(embedding: number[]) {
    return {
      id: 'c' + embedding.length,
      fileId: 'f1',
      symbolId: null,
      unit: 'module' as const,
      content: 'x',
      startLine: 1,
      endLine: 1,
      tokenEstimate: 1,
      embedding,
    };
  }

  it('پرس‌وجوی کوتاه‌تر، «تطابق کامل» گزارش نمی‌کند', async () => {
    const store = new VectorStore([chunkWith([1, 0])]);
    const results = await store.search([1], { topK: 5, minScore: -1 });

    expect(results.map(r => r.score)).not.toContain(1);
  });

  it('بردار با ابعاد ناهم‌خوان شباهتِ صفر می‌گیرد، نه عددی ساختگی', async () => {
    const store = new VectorStore([chunkWith([1, 0]), chunkWith([1, 0, 0, 0])]);
    const results = await store.search([1, 0, 0, 0], { topK: 5, minScore: -1 });

    const matched = results.find(r => r.chunk.embedding!.length === 4)!;
    const mismatched = results.find(r => r.chunk.embedding!.length === 2)!;

    expect(matched.score).toBeCloseTo(1, 9);
    expect(mismatched.score).toBe(0);
  });

  it('با آستانهٔ پیش‌فرض، ناهم‌خوان‌ها اصلاً برنمی‌گردند', async () => {
    const store = new VectorStore([chunkWith([1, 0]), chunkWith([1, 0, 0, 0])]);
    const results = await store.search([1, 0, 0, 0], { topK: 5, minScore: 0.05 });

    expect(results).toHaveLength(1);
    expect(results[0].chunk.embedding).toHaveLength(4);
  });

  it('هیچ امتیازی NaN نیست', async () => {
    const store = new VectorStore([chunkWith([1, 0]), chunkWith([0, 1, 0])]);
    const results = await store.search([1, 0], { topK: 5, minScore: -1 });

    for (const r of results) expect(Number.isNaN(r.score)).toBe(false);
  });

  it('ابعادِ هم‌خوان همچنان درست کار می‌کند', async () => {
    const store = new VectorStore([chunkWith([1, 0]), chunkWith([0, 1])]);
    const results = await store.search([1, 0], { topK: 5, minScore: -1 });

    expect(results[0].score).toBeCloseTo(1, 9);
  });
});
