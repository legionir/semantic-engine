/**
 * تست LocalEmbeddingGenerator با mock کردن @xenova/transformers.
 * هدف: verify منطق بدون download مدل واقعی.
 */

import { LocalEmbeddingGenerator } from './LocalEmbeddingGenerator';

jest.mock(
  '@xenova/transformers',
  () => ({
    pipeline: jest.fn().mockResolvedValue({
      __call__: jest.fn().mockImplementation(async (text: string) => ({
        data: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      })),
    }),
  }),
  { virtual: true }
);

/*
| The pipeline is called directly, so the mock is the callable itself.
|
| SE-VEC-08: this mock used to return a fixed four floats no matter how
| many texts it was handed, which only makes sense if the caller invokes
| it once per text — the very behaviour that was wrong. A real
| feature-extraction pipeline given n inputs returns n vectors in one flat
| array, so the mock now does that too. A fixture that cannot express the
| correct behaviour will always vote for the incorrect one.
*/
beforeEach(() => {
  const { pipeline } = jest.requireMock('@xenova/transformers');
  pipeline.mockResolvedValue(
    jest.fn().mockImplementation(async (input: string | string[], _options: unknown) => {
      const count = Array.isArray(input) ? input.length : 1;
      const data: number[] = [];
      for (let i = 0; i < count; i++) data.push(0.1, 0.2, 0.3, 0.4);
      return { data: new Float32Array(data) };
    })
  );
});

describe('LocalEmbeddingGenerator', () => {
  it('should report ready when pipeline loads', async () => {
    const generator = new LocalEmbeddingGenerator({ model: 'mock-model' });
    const ready = await generator.isReady();
    expect(ready).toBe(true);
  });

  it('should generate normalized embedding vector', async () => {
    const generator = new LocalEmbeddingGenerator({ model: 'mock-model' });
    const result = await generator.generate('hello world');

    expect(result.embedding).toHaveLength(4);
    expect(result.dimensions).toBe(4);
    expect(result.model).toBe('mock-model');
  });

  it('should generate batch embeddings', async () => {
    const generator = new LocalEmbeddingGenerator({ model: 'mock-model', batchSize: 2 });
    const results = await generator.generateBatch(['a', 'b', 'c']);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.embedding).toHaveLength(4);
    }
  });
});

/*
| SE-VEC-08 — «batch» واقعی نبود و `maxInputLength` هرگز استفاده
| نمی‌شد.
|
| ```ts
| const batchResults = await Promise.all(batch.map(text => this.generate(text)));
| ```
|
| این یعنی چند فراخوانی **همزمان** روی یک session از
| `@xenova/transformers`. آن pipelineها برای فراخوانی همزمان روی یک
| session امن نیستند، و هیچ سودی هم از batching گرفته نمی‌شد چون مدل
| هر متن را جدا می‌دید.
|
| و `EmbeddingConfig.maxInputLength` از ابتدا تعریف شده بود و در کل
| مخزن **هیچ مصرف‌کننده‌ای نداشت**، پس یک تابعِ ۵۰۰ خطی بی‌سروصدا به
| tokenizer می‌رفت و آن‌جا بریده می‌شد.
*/
describe('LocalEmbeddingGenerator — batch واقعی و سقف ورودی (SE-VEC-08)', () => {
  function mockPipeline() {
    const calls: unknown[][] = [];
    const fn = jest.fn().mockImplementation(async (input: string | string[]) => {
      calls.push([input]);
      const count = Array.isArray(input) ? input.length : 1;
      return { data: new Float32Array(Array.from({ length: 4 * count }, () => 0.5)) };
    });
    return { fn, calls };
  }

  it('یک فراخوانی برای هر batch می‌زند، نه یکی برای هر متن', async () => {
    const { fn, calls } = mockPipeline();
    const { pipeline } = jest.requireMock('@xenova/transformers');
    pipeline.mockResolvedValue(fn);

    const generator = new LocalEmbeddingGenerator({ model: 'mock-model', batchSize: 4 });
    await generator.generateBatch(['a', 'b', 'c', 'd', 'e']);

    // پنج متن با batchSize چهار ⇒ دو فراخوانی، نه پنج‌تا.
    expect(calls).toHaveLength(2);
    expect(Array.isArray(calls[0][0])).toBe(true);
  });

  it('فراخوانی‌ها ترتیبی‌اند، نه همزمان روی یک session', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fn = jest.fn().mockImplementation(async (input: string | string[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      const count = Array.isArray(input) ? input.length : 1;
      return { data: new Float32Array(Array.from({ length: 4 * count }, () => 0.5)) };
    });
    const { pipeline } = jest.requireMock('@xenova/transformers');
    pipeline.mockResolvedValue(fn);

    const generator = new LocalEmbeddingGenerator({ model: 'mock-model', batchSize: 2 });
    await generator.generateBatch(['a', 'b', 'c', 'd', 'e', 'f']);

    expect(maxInFlight).toBe(1);
  });

  it('هر متن یک بردار جدا می‌گیرد، درست تقسیم‌شده', async () => {
    const fn = jest.fn().mockImplementation(async (input: string | string[]) => {
      const count = Array.isArray(input) ? input.length : 1;
      // بردار متنِ i ام همه‌اش عددِ i است، تا تقسیم قابل بررسی باشد.
      const data: number[] = [];
      for (let i = 0; i < count; i++) data.push(i, i, i, i);
      return { data: new Float32Array(data) };
    });
    const { pipeline } = jest.requireMock('@xenova/transformers');
    pipeline.mockResolvedValue(fn);

    const generator = new LocalEmbeddingGenerator({ model: 'mock-model', batchSize: 8 });
    const results = await generator.generateBatch(['a', 'b', 'c']);

    expect(results.map(r => Array.from(r.embedding))).toEqual([
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [2, 2, 2, 2],
    ]);
  });

  it('ورودی روی maxInputLength بریده می‌شود', async () => {
    const seen: string[] = [];
    const fn = jest.fn().mockImplementation(async (input: string | string[]) => {
      for (const t of Array.isArray(input) ? input : [input]) seen.push(t);
      const count = Array.isArray(input) ? input.length : 1;
      return { data: new Float32Array(Array.from({ length: 4 * count }, () => 0.5)) };
    });
    const { pipeline } = jest.requireMock('@xenova/transformers');
    pipeline.mockResolvedValue(fn);

    const generator = new LocalEmbeddingGenerator({ model: 'mock-model', maxInputLength: 10 });
    await generator.generate('x'.repeat(500));

    expect(seen[0]!.length).toBeLessThanOrEqual(10);
  });

  it('متنِ کوتاه‌تر از سقف دست‌نخورده می‌ماند', async () => {
    const seen: string[] = [];
    const fn = jest.fn().mockImplementation(async (input: string | string[]) => {
      for (const t of Array.isArray(input) ? input : [input]) seen.push(t);
      return { data: new Float32Array([0.5, 0.5, 0.5, 0.5]) };
    });
    const { pipeline } = jest.requireMock('@xenova/transformers');
    pipeline.mockResolvedValue(fn);

    const generator = new LocalEmbeddingGenerator({ model: 'mock-model', maxInputLength: 100 });
    await generator.generate('short text');

    expect(seen[0]).toBe('short text');
  });

  it('batch خالی، هیچ فراخوانی نمی‌زند', async () => {
    const { fn, calls } = mockPipeline();
    const { pipeline } = jest.requireMock('@xenova/transformers');
    pipeline.mockResolvedValue(fn);

    const generator = new LocalEmbeddingGenerator({ model: 'mock-model' });
    expect(await generator.generateBatch([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
