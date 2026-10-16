/**
 * فاز ۴۴ — SE-VEC-01 و SE-VEC-09.
 *
 * ## SE-VEC-01 — فقط متادیتا embed می‌شد
 *
 * کامنت سرآمدِ `VectorIndexer` خودش اعتراف کرده بود: «در آینده می‌توان
 * source code واقعی symbol را هم include کرد». اندازه‌گیری روی ایندکس
 * واقعی `semantic-engine/src` (۲۹۴ فایل، ۸٬۴۱۴ نماد، ۲٬۰۵۱ chunk):
 *
 * ```
 * chunkهایی که *هر* نشانهٔ کد دارند ({ } ;):  ۲۶۵ از ۲٬۰۵۱
 * میانگین طول chunk:                          ۳۵۸ کاراکتر — همه‌اش برچسب
 * ```
 *
 * و آن ۲۶۵ تا هم فقط پرانتزِ امضا بودند، نه بدنه. یعنی «جست‌وجوی
 * معنایی» روی همان چیزی کار می‌کرد که جست‌وجوی کلیدواژه‌ای هم می‌کند:
 * نام‌ها و امضاها. تمام ارزش افزودهٔ embedding از دست می‌رفت.
 *
 * ## SE-VEC-09 — شناسهٔ chunk به محتوا گره خورده بود
 *
 * ```ts
 * const input = `${fileId}:${unit}:${content}`;
 * return `vec-${sha256(input).substring(0, 16)}`;
 * ```
 *
 * پس کوچک‌ترین تغییر یعنی chunk جدید، یعنی embedding قبلی دور ریخته
 * می‌شود. اندازه‌گیری: یک ویرایش کوچک در یک فایل، شناسهٔ chunk را عوض
 * کرد. شناسه باید بگوید «این کدام تکه است»، و یک فیلد جدا بگوید «آیا
 * کهنه شده».
 */

import { VectorIndexer } from './VectorIndexer';
import { ProjectIndex, VectorChunk } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';
import { IEmbeddingGenerator, EmbeddingResult } from './EmbeddingGenerator';

const SOURCE = `import { Mailer } from './mailer';

/** Sends the account recovery link. */
export async function beginRecovery(userId: string): Promise<void> {
  const token = await createToken(userId);
  await Mailer.send(userId, token);
}

export function createToken(userId: string): string {
  return userId + Date.now();
}
`;

function file(id: string, filePath: string, lines: number) {
  return {
    id,
    path: filePath,
    language: 'typescript',
    size: SOURCE.length,
    lines,
    hash: 'h',
    binary: false,
    testFile: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
    aiMetadata: { summary: 'account recovery helpers' },
  };
}

function symbolIn(
  id: string,
  fileId: string,
  name: string,
  line: number,
  endLine: number,
  kind = 'function'
) {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    fullyQualifiedName: name,
    signature: `${name}(userId: string)`,
    visibility: 'public',
    line,
    endLine,
    documentation: null,
    deprecated: false,
    exported: true,
    source: 'tree-sitter',
    confidence: makeConfidence(90),
    async: false,
    generator: false,
    abstract: false,
    static: false,
    readonly: false,
    parameters: [],
    returnType: null,
    generics: [],
    extends: [],
    implements: [],
    complexity: 2,
    referenceCount: null,
    calls: [],
    calledBy: [],
  };
}

function index(): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files: [file('f1', 'src/AccountOps.ts', 11)],
    symbols: [
      symbolIn('s-begin', 'f1', 'beginRecovery', 4, 7),
      symbolIn('s-token', 'f1', 'createToken', 9, 11),
    ],
    graphs: {
      dependencyGraph: [],
      reverseDependencyGraph: [],
      callGraph: [],
      typeGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: 1,
      totalLoc: 11,
      totalSymbols: 2,
      avgCyclomaticComplexity: 2,
      languageBreakdown: { typescript: 1 },
    },
  } as unknown as ProjectIndex;
}

const contents = new Map([['f1', SOURCE]]);

class CountingGenerator implements IEmbeddingGenerator {
  readonly modelName = 'counting';
  calls = 0;
  texts: string[] = [];

  async generate(text: string): Promise<EmbeddingResult> {
    this.calls++;
    this.texts.push(text);
    return { embedding: [text.length, 1, 0], model: 'counting', dimensions: 3 };
  }

  async generateBatch(texts: readonly string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(t => this.generate(t)));
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async dispose(): Promise<void> {}
}

class InvalidGenerator implements IEmbeddingGenerator {
  readonly modelName = 'invalid';
  constructor(private readonly shape: 'cardinality' | 'non-finite' | 'dimensions') {}
  async generate(_text: string): Promise<EmbeddingResult> {
    return { embedding: [1, 2], model: 'invalid', dimensions: 2 };
  }
  async generateBatch(texts: readonly string[]): Promise<EmbeddingResult[]> {
    if (this.shape === 'cardinality') return texts.slice(0, -1).map(() => ({ embedding: [1, 2], model: 'invalid', dimensions: 2 }));
    if (this.shape === 'non-finite') return texts.map(() => ({ embedding: [1, Number.NaN], model: 'invalid', dimensions: 2 }));
    return texts.map((_, i) => ({ embedding: i === 0 ? [1, 2] : [1, 2, 3], model: 'invalid', dimensions: i === 0 ? 2 : 3 }));
  }
  async isReady(): Promise<boolean> { return true; }
  async dispose(): Promise<void> {}
}

describe('VectorIndexer — سورس واقعی، نه فقط برچسب (SE-VEC-01)', () => {
  it('بدنهٔ نماد را داخل chunk می‌گذارد', async () => {
    const chunks = await new VectorIndexer().index(index(), { contents });
    const begin = chunks.find(c => c.symbolId === 's-begin')!;

    expect(begin.content).toContain('await Mailer.send(userId, token)');
    expect(begin.content).toContain('const token = await createToken(userId)');
  });

  it('فقط خطوط همان نماد را برمی‌دارد، نه کل فایل', async () => {
    const chunks = await new VectorIndexer().index(index(), { contents });
    const token = chunks.find(c => c.symbolId === 's-token')!;

    expect(token.content).toContain('return userId + Date.now()');
    expect(token.content).not.toContain('Mailer.send');
  });

  it('برچسب‌ها را هم نگه می‌دارد — سورس جایگزینشان نیست', async () => {
    const chunks = await new VectorIndexer().index(index(), { contents });
    const begin = chunks.find(c => c.symbolId === 's-begin')!;

    expect(begin.content).toContain('beginRecovery');
    expect(begin.content).toContain('src/AccountOps.ts');
  });

  it('بدون contents، همان رفتار قبلی را دارد و نمی‌شکند', async () => {
    const chunks = await new VectorIndexer().index(index());
    const begin = chunks.find(c => c.symbolId === 's-begin')!;

    expect(begin.content).toContain('beginRecovery');
    expect(begin.content).not.toContain('Mailer.send');
  });

  it('سورس روی سقف خط بریده می‌شود', async () => {
    const long = { ...index() } as ProjectIndex;
    const bigSource = Array.from({ length: 500 }, (_, i) => `  const line${i} = ${i};`).join('\n');
    const chunks = await new VectorIndexer({ maxSourceLines: 5 }).index(long, {
      contents: new Map([['f1', bigSource]]),
    });
    const begin = chunks.find(c => c.symbolId === 's-begin')!;
    const sourceLines = begin.content.split('\n').filter(l => l.includes('const line'));

    expect(sourceLines.length).toBeLessThanOrEqual(5);
  });

  it('chunk سطح فایل هم سرِ فایل را می‌گیرد', async () => {
    const chunks = await new VectorIndexer().index(index(), { contents });
    const module = chunks.find(c => c.unit === 'module')!;

    expect(module.content).toContain("import { Mailer } from './mailer'");
  });

  it('tokenEstimate با محتوای واقعی می‌خواند', async () => {
    const chunks = await new VectorIndexer().index(index(), { contents });

    for (const c of chunks) {
      expect(c.tokenEstimate).toBe(Math.max(1, Math.ceil(c.content.length / 4)));
    }
  });
});

describe('VectorIndexer — اعتبارسنجی خروجی embedding', () => {
  it.each([
    ['cardinality', /cardinality mismatch/],
    ['non-finite', /empty, non-finite/],
    ['dimensions', /inconsistent vector dimensions/],
  ] as const)('fails fast on %s provider output', async (shape, error) => {
    await expect(new VectorIndexer({ embeddingGenerator: new InvalidGenerator(shape) }).index(index(), { contents }))
      .rejects.toThrow(error);
  });
});

describe('VectorIndexer — شناسهٔ پایدار و استفادهٔ مجدد (SE-VEC-09)', () => {
  it('شناسه با تغییرِ محتوا عوض نمی‌شود', async () => {
    const before = await new VectorIndexer().index(index(), { contents });
    const after = await new VectorIndexer().index(index(), {
      contents: new Map([['f1', SOURCE.replace('Date.now()', 'clock.now()')]]),
    });

    const b = before.find(c => c.symbolId === 's-token')!;
    const a = after.find(c => c.symbolId === 's-token')!;

    expect(a.id).toBe(b.id);
  });

  it('اما contentHash عوض می‌شود، پس کهنگی قابل تشخیص است', async () => {
    const before = await new VectorIndexer().index(index(), { contents });
    const after = await new VectorIndexer().index(index(), {
      contents: new Map([['f1', SOURCE.replace('Date.now()', 'clock.now()')]]),
    });

    const b = before.find(c => c.symbolId === 's-token')!;
    const a = after.find(c => c.symbolId === 's-token')!;

    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('دو نماد در یک فایل، شناسهٔ متفاوت می‌گیرند', async () => {
    const chunks = await new VectorIndexer().index(index(), { contents });
    const ids = new Set(chunks.map(c => c.id));

    expect(ids.size).toBe(chunks.length);
  });

  it('embedding دست‌نخورده دوباره تولید نمی‌شود', async () => {
    const gen = new CountingGenerator();
    const first = await new VectorIndexer({ embeddingGenerator: gen }).index(index(), { contents });
    const callsAfterFirst = gen.calls;
    expect(callsAfterFirst).toBe(first.length);

    const second = await new VectorIndexer({ embeddingGenerator: gen }).index(index(), {
      contents,
      previous: first,
    });

    expect(gen.calls).toBe(callsAfterFirst); // هیچ فراخوانی تازه‌ای
    expect(second.every(c => Array.isArray(c.embedding))).toBe(true);
  });

  it('فقط chunkِ تغییرکرده دوباره embed می‌شود', async () => {
    const gen = new CountingGenerator();
    const first = await new VectorIndexer({ embeddingGenerator: gen }).index(index(), { contents });
    gen.calls = 0;

    const edited = new Map([['f1', SOURCE.replace('return userId + Date.now();', 'return "x";')]]);
    await new VectorIndexer({ embeddingGenerator: gen }).index(index(), {
      contents: edited,
      previous: first,
    });

    // فایل و نمادِ createToken عوض شده‌اند؛ beginRecovery نه.
    expect(gen.calls).toBeGreaterThan(0);
    expect(gen.calls).toBeLessThan(first.length);
  });

  it('chunkی که در اجرای قبلی embedding نداشت، دوباره تلاش می‌شود', async () => {
    const gen = new CountingGenerator();
    const stale = (await new VectorIndexer().index(index(), { contents })).map(
      c => ({ ...c, embedding: undefined }) as VectorChunk
    );

    await new VectorIndexer({ embeddingGenerator: gen }).index(index(), {
      contents,
      previous: stale,
    });

    expect(gen.calls).toBe(stale.length);
  });

  it('تعویض مدل، بردارهای قبلی را بی‌اعتبار می‌کند', async () => {
    /*
    | دو مدل، دو فضای برداریِ ناهم‌سنجه‌اند. استفادهٔ مجدد از بردارِ
    | مدل الف در ایندکسی که با مدل ب پرس‌وجو می‌شود، عددِ بی‌معنا
    | می‌دهد که شبیه عددِ بامعناست — همان چیزی که SE-VEC-13 در
    | سطح `VectorStore` نشانش داد.
    */
    const gen = new CountingGenerator();
    const fromAnotherModel = (await new VectorIndexer().index(index(), { contents })).map(
      c =>
        ({
          ...c,
          embedding: [1, 2, 3],
          embeddingModel: 'some-other-model',
        }) as VectorChunk
    );

    await new VectorIndexer({ embeddingGenerator: gen }).index(index(), {
      contents,
      previous: fromAnotherModel,
    });

    expect(gen.calls).toBe(fromAnotherModel.length);
  });

  it('بردارِ بدون اعلامِ مدل، بازاستفاده می‌شود', async () => {
    // ایندکس‌های پیش از فاز ۴۴ فیلد مدل ندارند؛ ردشان نمی‌کنیم.
    const gen = new CountingGenerator();
    const legacy = (await new VectorIndexer().index(index(), { contents })).map(
      c => ({ ...c, embedding: [9, 9, 9] }) as VectorChunk
    );

    await new VectorIndexer({ embeddingGenerator: gen }).index(index(), {
      contents,
      previous: legacy,
    });

    expect(gen.calls).toBe(0);
  });

  it('embedding بازاستفاده‌شده، همان بردار قبلی است', async () => {
    const gen = new CountingGenerator();
    const first = await new VectorIndexer({ embeddingGenerator: gen }).index(index(), { contents });
    const second = await new VectorIndexer({ embeddingGenerator: gen }).index(index(), {
      contents,
      previous: first,
    });

    for (const c of second) {
      const prior = first.find(p => p.id === c.id)!;
      expect(c.embedding).toEqual(prior.embedding);
    }
  });
});
