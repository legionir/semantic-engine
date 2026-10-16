/**
 * فاز ۴۵ — پاک‌سازی لایهٔ AI.
 *
 * ## SE-AI-01 — اعتبارسنجی ورودی تقریباً وجود نداشت
 *
 * `executeWithValidation` فقط *وجود داشتن* فیلدهای required را چک
 * می‌کرد:
 *
 * ```ts
 * for (const key of required) {
 *   if (!(key in input) || input[key] === undefined) return { error: ... };
 * }
 * ```
 *
 * هیچ بررسی نوع، enum یا محدوده‌ای در کار نبود — با اینکه هر ابزار یک
 * JSON Schema کامل دارد و `ajv` هم از قبل نصب است. اجرای واقعی روی
 * رجیستری:
 *
 * ```
 * get_dependencies { id: 123, direction: 'sideways' }  →  ACCEPTED
 * semantic_search  { query: 'x', limit: 'ten' }        →  ACCEPTED
 * semantic_search  { query: { not: 'a string' } }      →  «text.toLowerCase is not a function»
 * ```
 *
 * سومی بدترین است: ورودی نامعتبر تا عمقِ پیاده‌سازی می‌رفت و پیام
 * خطای داخلی به بیرون درز می‌کرد.
 *
 * ## SE-AI-01b — دو مسیر اجرایی واگرا
 *
 * `execute()` کش داشت ولی اعتبارسنجی نداشت؛ `executeWithValidation()`
 * اعتبارسنجی داشت ولی کش نداشت. سرور MCP فقط دومی را صدا می‌زد، پس
 * کش عملاً بی‌استفاده بود.
 */

import { ProjectIndex } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';
import { ProjectIndexReader } from './ProjectIndexReader';
import { AiToolRegistry } from './AiToolRegistry';

function index(): ProjectIndex {
  const files = [
    {
      id: 'f1',
      path: 'src/auth.ts',
      language: 'typescript',
      size: 100,
      lines: 10,
      hash: 'h',
      binary: false,
      testFile: false,
      symbolIds: [],
      imports: [],
      exports: [],
      diagnostics: [],
      outline: [],
    },
  ];
  const symbols = [
    {
      id: 's1',
      fileId: 'f1',
      parentId: null,
      kind: 'function',
      name: 'authenticateUser',
      fullyQualifiedName: 'authenticateUser',
      signature: 'authenticateUser()',
      visibility: 'public',
      line: 1,
      endLine: 3,
      documentation: null,
      deprecated: false,
      exported: true,
      source: 'tree-sitter',
      confidence: makeConfidence(90),
      complexity: 1,
      referenceCount: null,
    },
  ];

  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    rootPath: '/tmp/fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols,
    graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: 1,
      totalLoc: 10,
      totalSymbols: 1,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: 1 },
    },
  } as unknown as ProjectIndex;
}

/** ایندکسی که هم یال فایل‌به‌فایل دارد و هم یال به یک نماد. */
function indexWithMixedEdges(): ProjectIndex {
  const base = index() as unknown as Record<string, unknown>;
  const files = [
    ...(base.files as unknown[]),
    {
      id: 'f2',
      path: 'src/db.ts',
      language: 'typescript',
      size: 10,
      lines: 5,
      hash: 'h',
      binary: false,
      testFile: false,
      symbolIds: [],
      imports: [],
      exports: [],
      diagnostics: [],
      outline: [],
    },
  ];
  const symbols = [
    ...(base.symbols as unknown[]),
    {
      id: 's2',
      fileId: 'f2',
      parentId: null,
      kind: 'function',
      name: 'connect',
      fullyQualifiedName: 'connect',
      signature: 'connect()',
      visibility: 'public',
      line: 1,
      endLine: 2,
      documentation: null,
      deprecated: false,
      exported: true,
      source: 'tree-sitter',
      confidence: makeConfidence(90),
    },
  ];

  return {
    ...base,
    files,
    symbols,
    graphs: {
      dependencyGraph: [
        { from: 'f1', to: 'f2', kind: 'import' },
        { from: 'f1', to: 's2', kind: 'import' },
      ],
      reverseDependencyGraph: [],
      callGraph: [],
      typeGraph: [],
    },
  } as unknown as ProjectIndex;
}

function registry(overrides: Record<string, unknown> = {}): AiToolRegistry {
  return new AiToolRegistry({
    reader: new ProjectIndexReader(index()),
    projectHash: 'hash-1',
    ...overrides,
  });
}

describe('AiToolRegistry — اعتبارسنجی واقعی ورودی (SE-AI-01)', () => {
  it('معیار پذیرش: فراخوانی با نوع اشتباه رد می‌شود', async () => {
    const result = await registry().execute('get_dependencies', {
      id: 123,
      direction: 'forward',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/id/);
  });

  it('مقدار خارج از enum رد می‌شود', async () => {
    const result = await registry().execute('get_dependencies', {
      id: 'f1',
      direction: 'sideways',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/direction/);
  });

  it('عدد به‌جای رشته رد می‌شود، پیش از رسیدن به پیاده‌سازی', async () => {
    const result = await registry().execute('semantic_search', {
      query: { not: 'a string' },
    });

    expect(result.success).toBe(false);
    // پیام خطای داخلی نباید درز کند.
    expect(result.error).not.toMatch(/toLowerCase/);
  });

  it('رشته به‌جای عدد صحیح رد می‌شود', async () => {
    const result = await registry().execute('semantic_search', {
      query: 'authenticate',
      limit: 'ten',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/limit/);
  });

  it('فیلد required غایب، همچنان رد می‌شود', async () => {
    const result = await registry().execute('semantic_search', {});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/query/);
  });

  it('ورودی معتبر می‌گذرد', async () => {
    const result = await registry().execute('semantic_search', {
      query: 'authenticate',
      limit: 5,
    });

    expect(result.success).toBe(true);
  });

  it('پیام خطا می‌گوید کدام فیلد و چرا', async () => {
    const result = await registry().execute('get_dependencies', {
      id: 'f1',
      direction: 'sideways',
    });

    expect(result.error).toContain('direction');
    expect(result.error).toMatch(/forward|backward|enum|allowed/i);
  });

  it('چند خطا با هم گزارش می‌شوند، نه فقط اولی', async () => {
    const result = await registry().execute('get_dependencies', {
      id: 123,
      direction: 'sideways',
    });

    expect(result.error).toContain('id');
    expect(result.error).toContain('direction');
  });

  it('ابزار ناموجود همچنان پیام روشن می‌دهد', async () => {
    const result = await registry().execute('no_such_tool', {});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('AiToolRegistry — یک مسیر اجرا، نه دو تا (SE-AI-01b)', () => {
  it('executeWithValidation و execute یک رفتار دارند', async () => {
    const reg = registry();
    const bad = { id: 123, direction: 'sideways' };

    const a = await reg.execute('get_dependencies', bad);
    const b = await reg.executeWithValidation('get_dependencies', bad);

    expect(a.success).toBe(b.success);
    expect(a.error).toBe(b.error);
  });

  it('مسیرِ اعتبارسنجی هم از کش استفاده می‌کند', async () => {
    const reg = registry();
    const input = { query: 'authenticate', limit: 5 };

    await reg.executeWithValidation('semantic_search', input);
    const before = reg.cacheSize;
    expect(before).toBeGreaterThan(0);

    await reg.executeWithValidation('semantic_search', input);
    expect(reg.cacheSize).toBe(before);
  });

  it('نتیجهٔ ناموفق کش نمی‌شود', async () => {
    /*
    | یک خطای گذرا نباید تا انقضای ttl به همهٔ فراخوانی‌های بعدی هم
    | تحمیل شود. `get_file_summary` روی مسیری که وجود ندارد
    | `success: false` می‌دهد بی‌آنکه ورودی نامعتبر باشد — پس از
    | اعتبارسنجی رد می‌شود و به خودِ ابزار می‌رسد.
    */
    const reg = registry();
    const result = await reg.execute('get_file_summary', { path: 'src/does-not-exist.ts' });

    expect(result.success).toBe(false);
    expect(reg.cacheSize).toBe(0);
  });

  it('نتیجهٔ موفق کش می‌شود', async () => {
    const reg = registry();
    await reg.execute('get_file_summary', { path: 'src/auth.ts' });

    expect(reg.cacheSize).toBe(1);
  });

  it('ورودی نامعتبر کش نمی‌شود', async () => {
    const reg = registry();
    await reg.execute('semantic_search', { query: 123 });

    expect(reg.cacheSize).toBe(0);
  });
});

describe('AiToolRegistry — بی‌اعتبارسازی هنگام تغییر ایندکس (SE-AI-02)', () => {
  it('عوض شدن projectHash، نتایج کهنه را برنمی‌گرداند', async () => {
    const reg = registry();
    const input = { query: 'authenticate', limit: 5 };

    await reg.execute('semantic_search', input);
    expect(reg.cacheSize).toBeGreaterThan(0);

    reg.invalidate('hash-2');
    expect(reg.cacheSize).toBe(0);
  });

  it('بی‌اعتبارسازی با همان hash، کش را دور نمی‌ریزد', async () => {
    const reg = registry();
    await reg.execute('semantic_search', { query: 'authenticate' });
    const before = reg.cacheSize;

    reg.invalidate('hash-1');
    expect(reg.cacheSize).toBe(before);
  });

  it('پس از بی‌اعتبارسازی، پرس‌وجو دوباره اجرا می‌شود', async () => {
    const reg = registry();
    const input = { query: 'authenticate' };

    const first = await reg.execute('semantic_search', input);
    reg.invalidate('hash-2');
    const second = await reg.execute('semantic_search', input);

    expect(second.success).toBe(first.success);
    expect(reg.cacheSize).toBe(1);
  });
});

describe('AiToolRegistry — schema و پیاده‌سازی می‌خوانند (SE-AI-06)', () => {
  it('get_file_summary با fileId پذیرفته می‌شود', async () => {
    const result = await registry().execute('get_file_summary', { fileId: 'f1' });

    expect(result.success).toBe(true);
  });

  it('get_file_summary با path هم پذیرفته می‌شود', async () => {
    const result = await registry().execute('get_file_summary', { path: 'src/auth.ts' });

    expect(result.success).toBe(true);
  });

  it('get_file_summary بدون هیچ‌کدام رد می‌شود', async () => {
    const result = await registry().execute('get_file_summary', {});

    expect(result.success).toBe(false);
  });

  it("level='symbol' فقط نماد برمی‌گرداند، level='file' فقط فایل", async () => {
    /*
    | SE-AI-06 — `level` در schema و interface اعلام شده بود و هرگز
    | خوانده نمی‌شد. یک گزینهٔ اعلام‌شده که کاری نمی‌کند بدتر از
    | نبودنش است: مصرف‌کننده فکر می‌کند فیلتر کرده.
    */
    const reg = new AiToolRegistry({
      reader: new ProjectIndexReader(indexWithMixedEdges()),
      projectHash: 'h',
    });

    const files = await reg.execute('get_dependencies', {
      id: 'f1',
      direction: 'forward',
      level: 'file',
    });
    const symbols = await reg.execute('get_dependencies', {
      id: 'f1',
      direction: 'forward',
      level: 'symbol',
    });

    expect(files.items.map(i => i.id)).toEqual(['f2']);
    expect(symbols.items.map(i => i.id)).toEqual(['s2']);
  });

  it('عمقِ بزرگ‌تر از سقف رد می‌شود، نه بی‌صدا کوچک', async () => {
    const result = await registry().execute('get_dependencies', {
      id: 'f1',
      direction: 'forward',
      depth: 10,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/depth/);
  });

  it('هر فیلدِ اعلام‌شده در schema، واقعاً استفاده می‌شود', () => {
    /*
    | SE-AI-06 — `GetDependenciesTool` پارامتر `level` را در schema و
    | در interface اعلام می‌کرد و هرگز نمی‌خواند. یک گزینهٔ اعلام‌شده
    | که کاری نمی‌کند، بدتر از نبودنش است: مصرف‌کننده فکر می‌کند
    | فیلتر کرده.
    */
    const tool = registry()
      .list()
      .find(t => t.name === 'get_dependencies')!;
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'tools', 'GetDependenciesTool.ts'),
      'utf8'
    );

    const properties = Object.keys(
      (tool.inputSchema as { properties: Record<string, unknown> }).properties
    );

    for (const property of properties) {
      // هر فیلد باید دست‌کم یک بار *خوانده* شود، نه فقط در schema باشد.
      expect({ property, used: source.includes(`input.${property}`) }).toEqual({
        property,
        used: true,
      });
    }
  });
});
