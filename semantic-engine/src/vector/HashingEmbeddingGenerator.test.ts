/**
 * SE-VEC-02 / SE-VEC-10 / SE-DEP-10 — مسیر برداری در پیکربندی
 * پیش‌فرض مرده بود، و علتش فقط تزریق‌نشدنِ generator نبود.
 *
 * اجرای واقعی در همین مخزن، با `npm install --ignore-scripts`:
 *
 * ```
 * $ node -e "require('@xenova/transformers')"
 * Something went wrong installing the "sharp" module
 * Cannot find module '../build/Release/sharp-linux-x64.node'
 * ```
 *
 * یعنی حتی وقتی بسته **نصب** است، بارگذاری‌اش می‌ترکد چون `sharp` یک
 * ماژول native با باینری دانلودی است. موتور فقط feature-extraction
 * متنی می‌کند و هیچ‌جا تصویر پردازش نمی‌کند، ولی زنجیرهٔ وابستگی
 * `@xenova/transformers → sharp → libvips` (حدود ۱۰۰MB) اجباری است.
 *
 * نتیجه: هر نصبی که `--ignore-scripts` یا `--omit=optional` باشد —
 * که برای یک ابزار CLI کاملاً متعارف است — جست‌وجوی برداری را از
 * دست می‌دهد، **بی‌آنکه خبردار شود**.
 */

import { HashingEmbeddingGenerator, cosine } from './HashingEmbeddingGenerator';

describe('HashingEmbeddingGenerator — بردار بدون هیچ وابستگی', () => {
  it('بدون نصب هیچ بستهٔ اختیاری کار می‌کند', async () => {
    const gen = new HashingEmbeddingGenerator();

    expect(await gen.isReady()).toBe(true);

    const result = await gen.generate('reset the user password by email');
    expect(result.embedding).toHaveLength(result.dimensions);
    expect(result.embedding.some(v => v !== 0)).toBe(true);
  });

  it('بردار نرمال‌شده است', async () => {
    const gen = new HashingEmbeddingGenerator();
    const { embedding } = await gen.generate('some source code here');

    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('دترمینیستیک است — همان متن، همان بردار', async () => {
    const a = await new HashingEmbeddingGenerator().generate('exact same text');
    const b = await new HashingEmbeddingGenerator().generate('exact same text');

    expect(a.embedding).toEqual(b.embedding);
  });

  it('متن خالی، بردار صفر می‌دهد نه NaN', async () => {
    const { embedding } = await new HashingEmbeddingGenerator().generate('   ');

    expect(embedding.every(v => Number.isFinite(v))).toBe(true);
    expect(embedding.every(v => v === 0)).toBe(true);
  });

  it('ابعاد قابل تنظیم است', async () => {
    const gen = new HashingEmbeddingGenerator({ dimensions: 64 });
    const { embedding, dimensions } = await gen.generate('anything');

    expect(dimensions).toBe(64);
    expect(embedding).toHaveLength(64);
  });

  it('طول ورودی را رعایت می‌کند — SE-VEC-08', async () => {
    const gen = new HashingEmbeddingGenerator({ maxInputLength: 20 });
    const short = await gen.generate('alpha beta gamma');
    const padded = await gen.generate('alpha beta gamma' + ' zulu'.repeat(200));

    // هرچه بعد از سقف بیاید نادیده گرفته می‌شود، پس بردار یکی است.
    expect(padded.embedding).toEqual(short.embedding);
  });
});

describe('HashingEmbeddingGenerator — شباهت معنادار روی واژگانِ کد', () => {
  const gen = new HashingEmbeddingGenerator();

  it('متن هم‌واژه، شباهت بالا می‌گیرد', async () => {
    const a = await gen.generate('function resetPassword(user) { sendEmail(user); }');
    const b = await gen.generate('reset password send email to user');
    const c = await gen.generate('parse the abstract syntax tree of a module');

    expect(cosine(a.embedding, b.embedding)).toBeGreaterThan(
      cosine(a.embedding, c.embedding)
    );
  });

  it('قطعه‌های camelCase را می‌شکند، پس پرس‌وجوی چندکلمه‌ای می‌خورد', async () => {
    const code = await gen.generate('export async function beginAccountRecovery() {}');
    const query = await gen.generate('account recovery');
    const other = await gen.generate('database connection pool');

    expect(cosine(code.embedding, query.embedding)).toBeGreaterThan(
      cosine(code.embedding, other.embedding)
    );
  });

  it('متن غیرلاتین را دور نمی‌ریزد — SE-VEC-05', async () => {
    const a = await gen.generate('بازیابی رمز عبور کاربر');
    const b = await gen.generate('بازیابی رمز عبور');
    const c = await gen.generate('پردازش تصویر');

    expect(a.embedding.some(v => v !== 0)).toBe(true);
    expect(cosine(a.embedding, b.embedding)).toBeGreaterThan(cosine(a.embedding, c.embedding));
  });

  it('متن بی‌ربط، شباهت پایین می‌گیرد', async () => {
    const a = await gen.generate('cryptographic hash of the file contents');
    const b = await gen.generate('render the html template for the sidebar');

    expect(cosine(a.embedding, b.embedding)).toBeLessThan(0.3);
  });
});

describe('HashingEmbeddingGenerator — batch', () => {
  it('batch و تکی یک نتیجه می‌دهند', async () => {
    const gen = new HashingEmbeddingGenerator();
    const texts = ['alpha one', 'beta two', 'gamma three'];

    const batch = await gen.generateBatch(texts);
    const single = await Promise.all(texts.map(t => gen.generate(t)));

    expect(batch.map(r => r.embedding)).toEqual(single.map(r => r.embedding));
  });

  it('batch خالی، آرایهٔ خالی می‌دهد', async () => {
    expect(await new HashingEmbeddingGenerator().generateBatch([])).toEqual([]);
  });

  it('نام مدل، بردارها را از مدل دیگر قابل تفکیک می‌کند', async () => {
    const gen = new HashingEmbeddingGenerator({ dimensions: 128 });
    expect(gen.modelName).toContain('hashing');
    expect(gen.modelName).toContain('128');
  });
});

describe('cosine', () => {
  it('بردار یکسان → ۱', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 9);
  });

  it('بردار عمود → ۰', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 9);
  });

  it('بردار صفر → ۰ نه NaN', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('طول نابرابر → ۰ به‌جای خواندنِ بیرون از آرایه', () => {
    expect(cosine([1, 0, 0], [1, 0])).toBe(0);
  });
});
