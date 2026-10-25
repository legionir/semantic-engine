import { SemanticSearchTool } from './SemanticSearchTool';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { ProjectIndex, SymbolEntry, FileEntry, VectorChunk } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';
import { IEmbeddingGenerator, EmbeddingResult } from '../../vector/EmbeddingGenerator';

function createSymbol(id: string, fileId: string, name: string, kind: any): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    fullyQualifiedName: `${fileId}::${name}`,
    line: 1,
    endLine: 1,
    source: 'lsp',
    confidence: makeConfidence(85),
  } as SymbolEntry;
}

function createFile(id: string, path: string, language: string): FileEntry {
  return {
    id,
    path,
    language,
    encoding: 'utf8',
    size: 100,
    lines: 10,
    hash: 'abc',
    modified: new Date().toISOString(),
    binary: false,
    testFile: false,
    generated: false,
  } as FileEntry;
}

function createChunk(symbolId: string | null, content: string, embedding: number[]): VectorChunk {
  return {
    id: `chunk-${symbolId ?? 'file'}`,
    fileId: 'f1',
    symbolId,
    unit: 'function',
    content,
    startLine: 1,
    endLine: 1,
    tokenEstimate: 10,
    embedding,
  };
}

class MockEmbeddingGenerator implements IEmbeddingGenerator {
  readonly modelName = 'mock';

  async generate(text: string): Promise<EmbeddingResult> {
    // Simple mock: "authenticate" → [1,0], "database" → [0,1]
    if (text.toLowerCase().includes('authenticate')) {
      return { embedding: [1, 0], model: 'mock', dimensions: 2 };
    }
    return { embedding: [0, 1], model: 'mock', dimensions: 2 };
  }

  async generateBatch(texts: readonly string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(t => this.generate(t)));
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async dispose(): Promise<void> {}
}

function createProjectIndex(): ProjectIndex {
  const files: FileEntry[] = [createFile('f1', 'src/auth.ts', 'typescript')];
  const symbols: SymbolEntry[] = [
    createSymbol('s1', 'f1', 'authenticateUser', 'function'),
    createSymbol('s2', 'f1', 'connectDatabase', 'function'),
  ];

  return {
    schemaVersion: '2.0.0',
    root: '/project',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      callGraph: [],
      typeGraph: [],
      dependencyGraph: [],
      reverseDependencyGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: 1,
      totalLoc: 10,
      totalSymbols: 2,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: 1 },
    },
    vectorChunks: [
      createChunk('s1', 'authenticate user login', [1, 0]),
      createChunk('s2', 'database connection pool', [0, 1]),
    ],
  };
}

describe('SemanticSearchTool', () => {
  it('separates keyword, vector, and hybrid modes and applies minScore', async () => {
    const reader = new ProjectIndexReader(createProjectIndex());
    const tool = new SemanticSearchTool(reader, new MockEmbeddingGenerator());

    const keyword = await tool.execute({ query: 'authenticate', mode: 'keyword' });
    expect(keyword.items.map(i => i.id)).toContain('s1');
    expect(keyword.items.map(i => i.id)).not.toContain('s2');
    expect(keyword.metadata?.usedEmbeddings).toBe(false);

    const vector = await tool.execute({ query: 'database', mode: 'vector' });
    expect(vector.items.map(i => i.id)).toContain('s2');
    expect(vector.items.map(i => i.id)).not.toContain('s1');

    const hybrid = await tool.execute({ query: 'authenticate', mode: 'hybrid' });
    expect(hybrid.metadata?.usedEmbeddings).toBe(true);
    expect(hybrid.items.map(i => i.id)).toContain('s1');

    const filtered = await tool.execute({ query: 'authenticate', mode: 'hybrid', minScore: 2 });
    expect(filtered.items).toEqual([]);
  });

  it('should search by keyword', async () => {
    const reader = new ProjectIndexReader(createProjectIndex());
    const tool = new SemanticSearchTool(reader);
    const result = await tool.execute({ query: 'authenticate user' });

    expect(result.success).toBe(true);
    expect(result.items.map(i => i.name)).toContain('authenticateUser');
  });

  it('should use embeddings when generator provided', async () => {
    const reader = new ProjectIndexReader(createProjectIndex());
    const tool = new SemanticSearchTool(reader, new MockEmbeddingGenerator());
    const result = await tool.execute({ query: 'authenticate' });

    expect(result.success).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.metadata?.usedEmbeddings).toBe(true);
  });

  it('should filter by kind', async () => {
    const reader = new ProjectIndexReader(createProjectIndex());
    const tool = new SemanticSearchTool(reader);
    const result = await tool.execute({ query: 'user', filters: { kind: 'function' } });

    expect(result.success).toBe(true);
    expect(result.items.every(i => i.kind === 'function')).toBe(true);
  });
});

/*
| SE-VEC-03 — امتیازها نرمال نشده بودند.
|
| فرمول قبلی:
|
|   score = keywordScore * 0.5 + centralityScore * 0.3 + exportedBonus * 0.2
|
| و بعد شباهت برداری با ضریب ۰٫۵ رویش جمع می‌شد. `keywordScore` به
| ازای هر برخوردِ نام `+3` می‌گرفت و کران بالا نداشت. اندازه‌گیری روی
| ایندکس واقعی (۷٬۸۹۹ نماد): بیشینهٔ سهم کلیدواژه ۳٫۵، بیشینهٔ سهم
| مجموعِ همهٔ سیگنال‌های دیگر ۰٫۴۰. یعنی شباهت کسینوسی — حتی برابر ۱ —
| نمی‌توانست یک برخوردِ نام را جبران کند.
*/
describe('SemanticSearchTool — نرمال‌سازی امتیاز (SE-VEC-03)', () => {
  function indexWithSignals(): ProjectIndex {
    const base = createProjectIndex();
    return {
      ...base,
      symbols: base.symbols.map(s =>
        s.id === 's1'
          ? ({ ...s, referenceCount: 40, exported: true } as SymbolEntry)
          : ({ ...s, referenceCount: null } as SymbolEntry)
      ),
    };
  }

  it('همهٔ امتیازها در بازهٔ ۰ تا ۱ می‌مانند', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithSignals()));
    const result = await tool.execute({ query: 'authenticate user authenticate user' });

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(item.relevanceScore).toBeLessThanOrEqual(1);
    }
  });

  it('شباهت برداری کامل، در برابر یک برخوردِ نام دیده می‌شود', async () => {
    const tool = new SemanticSearchTool(
      new ProjectIndexReader(createProjectIndex()),
      new MockEmbeddingGenerator()
    );
    // پرس‌وجویی که فقط با نام s1 برخورد دارد ولی بردارش به s1 نزدیک است:
    const result = await tool.execute({ query: 'authenticate' });
    const s1 = result.items.find(i => i.id === 's1')!;

    expect(s1.metadata!.signals).toContain('vector');
    expect(s1.metadata!.signals).toContain('keyword');
  });

  it('هر نتیجه می‌گوید کدام سیگنال‌ها در امتیازش سهم داشتند', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithSignals()));
    const result = await tool.execute({ query: 'authenticate' });
    const s1 = result.items.find(i => i.id === 's1')!;

    expect(Array.isArray(s1.metadata!.signals)).toBe(true);
    expect(s1.metadata!.signals).toContain('centrality');
    expect(s1.metadata!.signals).toContain('exported');
  });

  it('نمادی با referenceCount نامعلوم، به‌عنوان صفر جریمه نمی‌شود', async () => {
    const index = createProjectIndex();
    const withUnknown = {
      ...index,
      symbols: [
        { ...index.symbols[0], name: 'alphaHandler', referenceCount: null } as SymbolEntry,
        { ...index.symbols[1], name: 'betaHandler', referenceCount: 0 } as SymbolEntry,
      ],
    };
    const tool = new SemanticSearchTool(new ProjectIndexReader(withUnknown));
    const result = await tool.execute({ query: 'handler' });

    const alpha = result.items.find(i => i.id === 's1')!;
    const beta = result.items.find(i => i.id === 's2')!;
    expect(alpha.relevanceScore!).toBeGreaterThan(beta.relevanceScore!);
  });

  it('ترتیب نتایج پایدار است', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithSignals()));
    const a = await tool.execute({ query: 'authenticate database' });
    const b = await tool.execute({ query: 'authenticate database' });
    expect(a.items.map(i => i.id)).toEqual(b.items.map(i => i.id));
  });
});

/*
| SE-VEC-11 — واژه‌های پرکاربرد به‌عنوان زیررشته داخل شناسه‌ها می‌خوردند.
|
| `tokenize` هر توکنِ بلندتر از یک حرف را نگه می‌داشت و تطبیق، تطبیقِ
| زیررشته بود. پس «at» داخل «aiMetadata» و «cyclomaticComplexity»
| می‌خورد، و «the» داخل «otherEvents» و «weather».
|
| اندازه‌گیری روی ایندکس واقعی (۷٬۸۹۹ نماد):
|
|   q="at"  → 6497 نامزد (۸۲٪ کل ایندکس)   نتایج برتر: aiMetadata, cyclomaticComplexity
|   q="is"  → 5600 نامزد                    نتایج برتر: existing, existing, existing
|   q="on"  → 5531 نامزد                    نتایج برتر: json, functions
|   q="in"  → 4823 نامزد
|   q="fix the checkout flow" → نتیجهٔ اول: otherEvents  (چون «the» ⊂ «oTHEr»)
*/
describe('SemanticSearchTool — نویز واژه‌های پرکاربرد (SE-VEC-11)', () => {
  function indexWithNoisyNames(): ProjectIndex {
    const base = createProjectIndex();
    return {
      ...base,
      symbols: [
        createSymbol('s1', 'f1', 'aiMetadata', 'constant'),
        createSymbol('s2', 'f1', 'cyclomaticComplexity', 'function'),
        createSymbol('s3', 'f1', 'otherEvents', 'constant'),
        createSymbol('s4', 'f1', 'checkoutFlow', 'function'),
      ],
      vectorChunks: [],
    };
  }

  it('واژهٔ ایست، هیچ نامزدی تولید نمی‌کند', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithNoisyNames()));

    for (const query of ['the', 'and', 'with', 'from']) {
      const result = await tool.execute({ query });
      expect({ query, n: result.items.length }).toEqual({ query, n: 0 });
    }
  });

  it('واژهٔ ایست، به‌عنوان *پیشوندِ* یک قطعه هم نمی‌خورد', async () => {
    /*
    | نخستین نسخهٔ آزمون بالا بی‌ارزش بود: با خالی کردن فهرست واژه‌های
    | ایست، **صفر** شکست می‌داد. علتش این بود که «the» و «and» اصلاً
    | پیشوندِ هیچ قطعه‌ای در آن fixture نبودند، پس قطعه‌بندی به‌تنهایی
    | حذفشان می‌کرد و فهرست کاری نمی‌کرد.
    |
    | این آزمون حالتی را می‌سنجد که قطعه‌بندی *نمی‌گیرد*: واژه‌های
    | نقشی که پیشوندِ شناسه‌های واقعی‌اند.
    |
    |   has  ⊂ پیشوندِ  hash
    |   for  ⊂ پیشوندِ  format
    |   not  ⊂ پیشوندِ  notify
    |   all  ⊂ پیشوندِ  allocate
    |   are  ⊂ پیشوندِ  area
    */
    const base = createProjectIndex();
    const withPrefixTraps = {
      ...base,
      symbols: [
        createSymbol('s1', 'f1', 'hashFile', 'function'),
        createSymbol('s2', 'f1', 'formatDate', 'function'),
        createSymbol('s3', 'f1', 'notifyUser', 'function'),
        createSymbol('s4', 'f1', 'allocateBuffer', 'function'),
        createSymbol('s5', 'f1', 'areaOfRect', 'function'),
      ],
      vectorChunks: [],
    };
    const tool = new SemanticSearchTool(new ProjectIndexReader(withPrefixTraps));

    for (const query of ['has', 'for', 'not', 'all', 'are']) {
      const result = await tool.execute({ query });
      expect({ query, n: result.items.length }).toEqual({ query, n: 0 });
    }

    // ولی واژهٔ واقعی همچنان می‌خورد.
    const real = await tool.execute({ query: 'hash' });
    expect(real.items.map(i => i.name)).toContain('hashFile');
  });

  it('توکن دوحرفی داخل شناسه‌ها نمی‌خورد', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithNoisyNames()));

    for (const query of ['at', 'is', 'on', 'in']) {
      const result = await tool.execute({ query });
      expect({ query, n: result.items.length }).toEqual({ query, n: 0 });
    }
  });

  it('واژهٔ ایست، نتیجهٔ درست را از صدر بیرون نمی‌کند', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithNoisyNames()));
    const result = await tool.execute({ query: 'the checkout flow' });

    expect(result.items[0].name).toBe('checkoutFlow');
    expect(result.items.map(i => i.name)).not.toContain('otherEvents');
  });

  it('تطبیق روی قطعه‌های شناسه است، نه زیررشتهٔ خام', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithNoisyNames()));

    // «meta» یک قطعهٔ واقعی در aiMetadata است ⇒ باید بخورد.
    const good = await tool.execute({ query: 'meta' });
    expect(good.items.map(i => i.name)).toContain('aiMetadata');

    // «tada» فقط یک زیررشتهٔ تصادفی در «aiMetaData» است ⇒ نباید بخورد.
    const bad = await tool.execute({ query: 'tada' });
    expect(bad.items.map(i => i.name)).not.toContain('aiMetadata');
  });

  it('پرس‌وجوی معنادار همچنان کار می‌کند', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(createProjectIndex()));
    const result = await tool.execute({ query: 'authenticate user' });

    expect(result.items.map(i => i.name)).toContain('authenticateUser');
  });

  it('پرس‌وجویی که فقط واژهٔ ایست دارد، خطا نمی‌دهد', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(createProjectIndex()));
    const result = await tool.execute({ query: 'the and of to' });

    expect(result.success).toBe(true);
    expect(result.items).toEqual([]);
  });
});

/*
| SE-VEC-06 و SE-VEC-12 — دو باگ در مسیر برداری.
|
| SE-VEC-06: فیلتر مسیر با `chunk.content` مقایسه می‌شد نه با مسیر
| فایلِ chunk. پس فیلتر «فقط داخل src/lsp» هر chunkی را قبول می‌کرد که
| رشتهٔ «src/lsp» در *متنش* باشد — مثلاً فایلی که آن مسیر را import
| کرده — و chunkهای واقعی همان پوشه را که مسیرشان در متن نیامده رد
| می‌کرد.
|
| SE-VEC-12: `minScore: 0.3` در محل فراخوانی هاردکد شده بود. این عدد
| به مدل وابسته است و برای هر مدلی جز آنکه در ذهن نویسنده بوده، یعنی
| حذف کامل. اندازه‌گیری با generator پیش‌فرض فاز ۴۴:
|
|   cosine(query, chunk درست)     0.2445   ← زیر آستانه، حذف می‌شد
|   cosine(query, chunk نامرتبط)  0.0000
*/
describe('SemanticSearchTool — فیلتر و آستانهٔ مسیر برداری', () => {
  function chunk(id: string, fileId: string, content: string, embedding: number[]): VectorChunk {
    return {
      id,
      fileId,
      symbolId: null,
      unit: 'module',
      content,
      startLine: 1,
      endLine: 5,
      tokenEstimate: 10,
      embedding,
    };
  }

  function indexWithChunks(): ProjectIndex {
    const base = createProjectIndex();
    const files: FileEntry[] = [
      createFile('f1', 'src/auth.ts', 'typescript'),
      createFile('f2', 'src/lsp/client.ts', 'typescript'),
    ];
    return {
      ...base,
      files,
      symbols: [
        createSymbol('s1', 'f1', 'authenticateUser', 'function'),
        createSymbol('s2', 'f2', 'connectServer', 'function'),
      ],
      vectorChunks: [
        // متنش مسیر src/lsp را دارد ولی خودش در src/lsp نیست.
        chunk('c1', 'f1', 'imports from src/lsp/client', [1, 0]),
        // خودش در src/lsp است ولی متنش آن رشته را ندارد.
        chunk('c2', 'f2', 'connect to the server over a socket', [1, 0]),
      ],
    };
  }

  it('فیلتر مسیر روی مسیر فایلِ chunk اعمال می‌شود، نه متنش — SE-VEC-06', async () => {
    const tool = new SemanticSearchTool(
      new ProjectIndexReader(indexWithChunks()),
      new MockEmbeddingGenerator(),
      { minScore: 0 }
    );

    const result = await tool.execute({
      query: 'authenticate server',
      filters: { path: 'src/lsp' },
      limit: 10,
    });

    const paths = result.items.map(i => i.path);
    expect(paths).not.toContain('src/auth.ts');
    expect(result.items.every(i => (i.path ?? '').includes('src/lsp'))).toBe(true);
  });

  it('آستانهٔ شباهت قابل تنظیم است — SE-VEC-12', async () => {
    const reader = new ProjectIndexReader(indexWithChunks());

    const strict = new SemanticSearchTool(reader, new MockEmbeddingGenerator(), {
      minScore: 0.99,
    });
    const loose = new SemanticSearchTool(reader, new MockEmbeddingGenerator(), {
      minScore: 0,
    });

    const a = await strict.execute({ query: 'database', limit: 10 });
    const b = await loose.execute({ query: 'database', limit: 10 });

    expect((b.metadata!.embeddingCandidates as number)).toBeGreaterThan(
      a.metadata!.embeddingCandidates as number
    );
  });

  it('آستانهٔ پیش‌فرض، نتایج واقعی را حذف نمی‌کند', async () => {
    const tool = new SemanticSearchTool(
      new ProjectIndexReader(indexWithChunks()),
      new MockEmbeddingGenerator()
    );

    const result = await tool.execute({ query: 'authenticate', limit: 10 });
    expect(result.metadata!.embeddingCandidates as number).toBeGreaterThan(0);
  });

  it('usedEmbeddings وقتی generator نیست دروغ نمی‌گوید — SE-VEC-02', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithChunks()));
    const result = await tool.execute({ query: 'authenticate', limit: 10 });

    // یا واقعاً از بردار استفاده شده، یا گزارش می‌کند که نشده.
    if (result.metadata!.usedEmbeddings === true) {
      expect(result.metadata!.embeddingCandidates as number).toBeGreaterThanOrEqual(0);
      expect(result.items.some(i => (i.metadata!.signals as string[]).includes('vector'))).toBe(true);
    }
  });
});

/*
| SE-VEC-05 — پرس‌وجوی غیرلاتین صفر نتیجه می‌داد.
|
| `queryTerms` روی `split(/[^a-z0-9_]+/)` کار می‌کرد، یعنی هر حرفِ
| غیرِ a-z دور ریخته می‌شد. اندازه‌گیری روی ایندکس واقعی:
|
|   q="بردار"  → ۰ نتیجه
|   q="向量"    → ۰ نتیجه
|   q="симв"   → ۰ نتیجه
|
| برای محصولی که کامنت‌ها و مستنداتش فارسی است، این یعنی جست‌وجو روی
| نیمی از متنِ خودش کار نمی‌کند.
*/
describe('SemanticSearchTool — پرس‌وجوی غیرلاتین (SE-VEC-05)', () => {
  function indexWithPersianDocs(): ProjectIndex {
    const base = createProjectIndex();
    return {
      ...base,
      symbols: [
        {
          ...createSymbol('s1', 'f1', 'buildVector', 'function'),
          documentation: 'این تابع بردار را از روی محتوا می‌سازد',
        } as SymbolEntry,
        {
          ...createSymbol('s2', 'f1', 'openSocket', 'function'),
          documentation: 'اتصال شبکه را باز می‌کند',
        } as SymbolEntry,
      ],
      vectorChunks: [],
    };
  }

  it('پرس‌وجوی فارسی نتیجه می‌دهد', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithPersianDocs()));
    const result = await tool.execute({ query: 'بردار' });

    expect(result.items.map(i => i.name)).toContain('buildVector');
  });

  it('پرس‌وجوی فارسی، نمادِ بی‌ربط را نمی‌آورد', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithPersianDocs()));
    const result = await tool.execute({ query: 'بردار' });

    expect(result.items.map(i => i.name)).not.toContain('openSocket');
  });

  it('چینی و سیریلیک هم دور ریخته نمی‌شوند', async () => {
    const base = createProjectIndex();
    const withCjk = {
      ...base,
      symbols: [
        { ...createSymbol('s1', 'f1', 'renderChart', 'function'), documentation: '向量图表' } as SymbolEntry,
        { ...createSymbol('s2', 'f1', 'saveFile', 'function'), documentation: 'символ таблица' } as SymbolEntry,
      ],
      vectorChunks: [],
    };
    const tool = new SemanticSearchTool(new ProjectIndexReader(withCjk));

    expect((await tool.execute({ query: '向量' })).items.map(i => i.name)).toContain('renderChart');
    expect((await tool.execute({ query: 'символ' })).items.map(i => i.name)).toContain('saveFile');
  });

  it('حداقلِ طولِ سه‌حرفی روی زبان‌های غیرالفبایی اعمال نمی‌شود', async () => {
    // «向量» دو کاراکتر است ولی یک واژهٔ کامل.
    const base = createProjectIndex();
    const withCjk = {
      ...base,
      symbols: [
        { ...createSymbol('s1', 'f1', 'renderChart', 'function'), documentation: '向量' } as SymbolEntry,
      ],
      vectorChunks: [],
    };
    const tool = new SemanticSearchTool(new ProjectIndexReader(withCjk));

    expect((await tool.execute({ query: '向量' })).items.length).toBeGreaterThan(0);
  });

  it('واژهٔ ایستِ انگلیسی همچنان حذف می‌شود', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithPersianDocs()));
    const result = await tool.execute({ query: 'the and with' });

    expect(result.items).toEqual([]);
  });
});
