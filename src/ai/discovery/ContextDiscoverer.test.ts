/**
 * GAP-04 — کشف نامزد، جدا از ساخت context.
 *
 * تا فاز ۴۳، `assemble_context` یا مسیر صریح می‌گرفت یا مستقیم
 * `semantic_search` می‌کرد. مرحلهٔ گسترش گرافی بین این دو غایب بود:
 *
 * ```
 * Task → Candidate Discovery → Graph Expansion → Ranking → Assembly
 *         (search + blueprint)   (فاز ۴۱)        (فاز ۴۲)
 * ```
 *
 * پیامدش این بود که هر فایلی که نامش با task هم‌خوان نبود، دیده
 * نمی‌شد — هرچقدر هم از نظر ساختاری نزدیک بود. جست‌وجوی کلیدواژه‌ای
 * فقط چیزی را پیدا می‌کند که *اسمش* را بلد باشید.
 */

import { ProjectIndex } from '../../core/types/project-index.types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { ContextDiscoverer } from './ContextDiscoverer';
import { BlueprintIndex } from './BlueprintIndex';
import { BlueprintGenerator } from '../../blueprint/BlueprintGenerator';
import { provenanceFor } from '../../graphs/EdgeProvenance';
import { makeConfidence } from '../../core/types/common.types';

function file(id: string, filePath: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    path: filePath,
    language: 'typescript',
    size: 400,
    lines: 120,
    hash: 'h',
    binary: false,
    testFile: /\.test\.ts$/.test(filePath),
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
    aiMetadata: {
      summary: `summary of ${filePath}`,
      aiScore: { importance: 50, readPriority: 50, hotness: 20 },
    },
    ...extra,
  };
}

function symbolIn(id: string, fileId: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    fileId,
    parentId: null,
    kind: 'function',
    name,
    fullyQualifiedName: name,
    signature: `function ${name}()`,
    visibility: 'public',
    line: 3,
    endLine: 20,
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
    complexity: 3,
    referenceCount: null,
    calls: [],
    calledBy: [],
    testIds: [],
    ...extra,
  };
}

/*
| گراف آزمون — عمداً طوری چیده شده که فقط جست‌وجو کافی نباشد:
|
|   payments/checkout.ts   ← تنها فایلی که نامش با task هم‌خوان است
|        │ import
|        ▼
|   billing/invoice.ts     ← نامش هیچ ربطی به «checkout» ندارد
|        │ import
|        ▼
|   ledger/postings.ts     ← دو هاپ دورتر، باز هم بی‌ربط از نظر نام
|
|   unrelated/weather.ts   ← نه نامش، نه گرافش
*/
function index(): ProjectIndex {
  const files = [
    file('f-checkout', 'payments/checkout.ts'),
    file('f-invoice', 'billing/invoice.ts'),
    file('f-postings', 'ledger/postings.ts'),
    /*
    | هم‌ماژولِ postings، ولی نه نمادی دارد که جست‌وجو پیدایش کند و نه
    | یالی در گراف. تنها راه رسیدن به آن، blueprint است. ماژول‌های
    | واقعی همیشه چند فایل دارند و جست‌وجو فقط یکی‌شان را بالا
    | می‌آورد — این فایل همان حالت را می‌سازد.
    */
    file('f-reconcile', 'ledger/reconcile.ts'),
    file('f-weather', 'unrelated/weather.ts'),
    file('f-checkout-test', 'payments/checkout.test.ts'),
  ];

  const symbols = [
    symbolIn('s-checkout', 'f-checkout', 'runCheckout'),
    symbolIn('s-invoice', 'f-invoice', 'buildInvoice'),
    symbolIn('s-postings', 'f-postings', 'postEntries'),
    symbolIn('s-weather', 'f-weather', 'forecast'),
  ];

  const dep = (from: string, to: string) => ({
    from,
    to,
    kind: 'import' as const,
    provenance: {
      ...provenanceFor('import-resolved', 'typescript-api', { file: from, line: 1 }),
      confidence: 95,
    },
  });

  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    rootPath: '/tmp/fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      dependencyGraph: [
        dep('f-checkout', 'f-invoice'),
        dep('f-invoice', 'f-postings'),
        // فایل تست، ماژولِ زیر آزمون را import می‌کند — همان کاری که
        // هر فایل تستِ واقعی می‌کند.
        dep('f-checkout-test', 'f-checkout'),
      ],
      reverseDependencyGraph: [
        dep('f-invoice', 'f-checkout'),
        dep('f-postings', 'f-invoice'),
        dep('f-checkout', 'f-checkout-test'),
      ],
      callGraph: [],
      typeGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 600,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 3,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

function discoverer(withBlueprint = false): ContextDiscoverer {
  const projectIndex = index();
  const reader = new ProjectIndexReader(projectIndex);
  if (!withBlueprint) return new ContextDiscoverer(reader);

  const blueprint = new BlueprintGenerator().generate(projectIndex);
  return new ContextDiscoverer(reader, { blueprint: new BlueprintIndex(blueprint) });
}

describe('ContextDiscoverer — گسترش گرافی چیزی را پیدا می‌کند که جست‌وجو نمی‌تواند', () => {
  it('معیار پذیرش فاز ۴۳: از یک task متنی و بدون هیچ مسیری، نامزد تولید می‌کند', async () => {
    const result = await discoverer().discover({ task: 'fix the checkout flow' });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.map(c => c.path)).toContain('payments/checkout.ts');
  });

  it('فایلی که نامش با task هم‌خوان نیست ولی یک هاپ فاصله دارد را می‌آورد', async () => {
    const result = await discoverer().discover({ task: 'fix the checkout flow' });
    const invoice = result.candidates.find(c => c.path === 'billing/invoice.ts');

    expect(invoice).toBeDefined();
    expect(invoice!.origin).toBe('expansion');
    expect(invoice!.hops).toBe(1);
  });

  it('جست‌وجوی تنها، همان فایل را پیدا نمی‌کند — پس گسترش واقعاً کار می‌کند', async () => {
    const result = await discoverer().discover({ task: 'fix the checkout flow' });
    const searchOnly = result.seeds.filter(s => s.origin === 'search').map(s => s.id);

    expect(searchOnly).not.toContain('f-invoice');
    expect(result.candidates.map(c => c.id)).toContain('f-invoice');
  });

  it('عمق گسترش قابل کنترل است', async () => {
    const shallow = await discoverer().discover({ task: 'fix the checkout flow', expansionDepth: 1 });
    const deep = await discoverer().discover({ task: 'fix the checkout flow', expansionDepth: 3 });

    expect(shallow.candidates.map(c => c.path)).not.toContain('ledger/postings.ts');
    expect(deep.candidates.map(c => c.path)).toContain('ledger/postings.ts');
  });

  it('فایلِ بی‌ربط از نظر نام و گراف، نامزد نمی‌شود', async () => {
    const result = await discoverer().discover({ task: 'fix the checkout flow', expansionDepth: 3 });

    expect(result.candidates.map(c => c.path)).not.toContain('unrelated/weather.ts');
  });

  it('دانهٔ نمادی، فایلِ صاحبش را هم دانه می‌کند — SE-AI-19', async () => {
    /*
    | جست‌وجو شناسهٔ **نماد** برمی‌گرداند (اندازه‌گیری روی ایندکس
    | واقعی: ۱۰ از ۱۰ نتیجه نماد بودند، صفر فایل) ولی گراف وابستگی
    | کاملاً **فایل‌به‌فایل** است (۵۰۰ از ۵۰۰ یال). پس گسترشی که فقط
    | از دانه‌های نمادی شروع شود، هرگز به گراف import نمی‌رسد —
    | یعنی قوی‌ترین سیگنال ساختاری دست‌نیافتنی می‌ماند.
    */
    const result = await discoverer().discover({ task: 'checkout' });
    const seedIds = result.seeds.map(s => s.id);

    expect(seedIds).toContain('s-checkout'); // نمادی که جست‌وجو پیدا کرد
    expect(seedIds).toContain('f-checkout'); // فایلِ صاحبش، پل به گراف import
  });
});

describe('ContextDiscoverer — هر نامزد می‌گوید چرا اینجاست', () => {
  it('دانه‌های جست‌وجو با origin=search و hops=0 برمی‌گردند', async () => {
    const result = await discoverer().discover({ task: 'checkout' });
    const seed = result.candidates.find(c => c.path === 'payments/checkout.ts')!;

    expect(seed.origin).toBe('search');
    expect(seed.hops).toBe(0);
  });

  it('هر نامزد یک reason خواندنی دارد', async () => {
    const result = await discoverer().discover({ task: 'fix the checkout flow' });

    for (const candidate of result.candidates) {
      expect(typeof candidate.reason).toBe('string');
      expect(candidate.reason.length).toBeGreaterThan(0);
    }
  });

  it('امتیازها در بازهٔ ۰..۱ و نزولی‌اند', async () => {
    const result = await discoverer().discover({ task: 'fix the checkout flow' });
    const scores = result.candidates.map(c => c.score);

    expect(scores.every(s => s >= 0 && s <= 1)).toBe(true);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('گزارش می‌کند چند دانه از هر منبع آمد', async () => {
    const result = await discoverer().discover({ task: 'fix the checkout flow' });

    expect(result.stats.searchSeeds).toBeGreaterThan(0);
    expect(typeof result.stats.blueprintSeeds).toBe('number');
    expect(result.stats.expanded).toBeGreaterThan(0);
  });

  it('نتیجه دترمینیستیک است', async () => {
    const a = await discoverer().discover({ task: 'fix the checkout flow' });
    const b = await discoverer().discover({ task: 'fix the checkout flow' });

    expect(a.candidates.map(c => c.id)).toEqual(b.candidates.map(c => c.id));
  });
});

describe('ContextDiscoverer — blueprint به‌عنوان منبع دانه (SE-BP-06)', () => {
  it('بدون blueprint هم کار می‌کند و صفر دانهٔ blueprint گزارش می‌دهد', async () => {
    const result = await discoverer(false).discover({ task: 'billing' });

    expect(result.stats.blueprintSeeds).toBe(0);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('blueprint فایلی را می‌آورد که نه جست‌وجو می‌بیند نه گراف', async () => {
    /*
    | `ledger/reconcile.ts` نه نمادی دارد که جست‌وجو پیدایش کند و نه
    | یالی در گراف. تنها راهِ رسیدن به آن، عضویتش در ماژولی است که با
    | task می‌خواند — یعنی دقیقاً همان نیمهٔ دومِ «search + blueprint»
    | که GAP-04 می‌خواست و تا امروز وجود نداشت.
    */
    const withoutBlueprint = await discoverer(false).discover({ task: 'ledger' });
    const withBlueprint = await discoverer(true).discover({ task: 'ledger' });

    expect(withoutBlueprint.candidates.map(c => c.path)).not.toContain('ledger/reconcile.ts');
    expect(withBlueprint.candidates.map(c => c.path)).toContain('ledger/reconcile.ts');
    expect(withBlueprint.stats.blueprintSeeds).toBeGreaterThan(0);
  });

  it('ماژول‌های منطبق را با دلیلشان گزارش می‌کند', async () => {
    const result = await discoverer(true).discover({ task: 'ledger' });

    expect(result.modules.length).toBeGreaterThan(0);
    expect(result.modules[0].id).toBe('mod-ledger');
    expect(result.modules[0].reason).toContain('ledger');
  });

  it('taskی که با هیچ ماژولی نمی‌خواند، دانهٔ blueprint نمی‌سازد', async () => {
    const result = await discoverer(true).discover({ task: 'zzzz nonexistent topic' });

    expect(result.stats.blueprintSeeds).toBe(0);
  });
});

describe('ContextDiscoverer — سقف‌ها و حالت‌های مرزی', () => {
  it('limit تعداد نامزدها را محدود می‌کند', async () => {
    const result = await discoverer().discover({ task: 'fix the checkout flow', limit: 2 });

    expect(result.candidates.length).toBeLessThanOrEqual(2);
  });

  it('برشِ limit همان بالاترین‌های فهرست کامل است', async () => {
    const full = await discoverer().discover({ task: 'fix the checkout flow', limit: 100 });
    const capped = await discoverer().discover({ task: 'fix the checkout flow', limit: 2 });

    expect(capped.candidates.map(c => c.id)).toEqual(full.candidates.slice(0, 2).map(c => c.id));
  });

  it('task خالی خطا نمی‌دهد', async () => {
    const result = await discoverer().discover({ task: '' });
    expect(Array.isArray(result.candidates)).toBe(true);
  });

  it('taskی که هیچ چیزی را پیدا نمی‌کند، فهرست خالی می‌دهد نه خطا', async () => {
    const result = await discoverer().discover({ task: 'zzzz qqqq xxxx' });

    expect(result.candidates).toEqual([]);
    expect(result.stats.searchSeeds).toBe(0);
  });

  it('فایل‌های تست به‌صورت پیش‌فرض نامزد نمی‌شوند', async () => {
    const result = await discoverer().discover({ task: 'checkout' });

    expect(result.candidates.map(c => c.path)).not.toContain('payments/checkout.test.ts');
  });

  it('با includeTests می‌شود آنها را هم خواست', async () => {
    const result = await discoverer().discover({ task: 'checkout', includeTests: true });

    expect(result.candidates.map(c => c.path)).toContain('payments/checkout.test.ts');
  });
});

/*
| SE-VEC-11 (ادامه) — کشف، توکن‌سازِ خودش را داشت.
|
| `ContextDiscoverer` یک `tokenize` محلی داشت که عمداً رفتار قدیمیِ
| `SemanticSearchTool` را تکرار می‌کرد. وقتی آن یکی رفع شد، این یکی
| جا ماند و نتیجه‌اش روی ایندکس واقعی دیده شد:
|
|   task: "fix a timeout bug in the language server client"
|   ماژول‌های منطبق: mod-ai-ranking, mod-blueprint, mod-incremental, ...
|
| سه‌تای آن پنج ماژول را واژهٔ «in» آورده بود: rank«in»g، bluepr«in»t،
| «in»cremental. یعنی نیمی از دانه‌های blueprint نویز بود.
*/
describe('ContextDiscoverer — همان توکن‌سازِ جست‌وجو (SE-VEC-11)', () => {
  it('واژهٔ ایست، ماژول را با زیررشته نمی‌خوراند', async () => {
    const result = await discoverer(true).discover({ task: 'in the of' });

    expect(result.modules).toEqual([]);
    expect(result.stats.blueprintSeeds).toBe(0);
  });

  it('«in» ماژولِ billing را فقط به‌خاطر «bILLINg» انتخاب نمی‌کند', async () => {
    const result = await discoverer(true).discover({ task: 'checkout' });

    expect(result.modules.map(m => m.id)).not.toContain('mod-billing');
  });
});

/*
| SE-AI-20 — نتایج کشف را یک فایل قبضه می‌کرد.
|
| نماد و فایلِ صاحبش هر دو نامزدند، و یک فایلِ پرنماد ده نامزدِ
| هم‌امتیاز تولید می‌کند. اندازه‌گیری روی ایندکس واقعی:
|
|   task: "fix a timeout bug in the language server client"
|   پنج نتیجهٔ برتر: LspClient.ts ×۵
|
| برای ابزاری که کارش «کجا را نگاه کنم» است، این یعنی کلِ سهمیه صرف
| یک فایل می‌شود و بقیهٔ کدبیس نامرئی می‌ماند.
*/
describe('ContextDiscoverer — تنوع نتایج (SE-AI-20)', () => {
  function indexWithCrowdedFile(): ProjectIndex {
    const base = index();
    const extra = Array.from({ length: 8 }, (_, i) =>
      symbolIn(`s-crowd-${i}`, 'f-checkout', `checkoutStep${i}`)
    );
    return { ...base, symbols: [...base.symbols, ...extra] } as ProjectIndex;
  }

  it('یک فایل بیش از سقف، سهمیهٔ نتایج را نمی‌گیرد', async () => {
    const d = new ContextDiscoverer(new ProjectIndexReader(indexWithCrowdedFile()));
    const result = await d.discover({ task: 'checkout', limit: 10 });

    const perPath = new Map<string, number>();
    for (const c of result.candidates) {
      perPath.set(c.path!, (perPath.get(c.path!) ?? 0) + 1);
    }

    for (const [path, count] of perPath) {
      expect({ path, count }).toEqual({ path, count: Math.min(count, 2) });
    }
  });

  it('سقف قابل تنظیم است', async () => {
    const d = new ContextDiscoverer(new ProjectIndexReader(indexWithCrowdedFile()));
    const result = await d.discover({ task: 'checkout', limit: 20, maxPerFile: 5 });

    const fromCheckout = result.candidates.filter(c => c.path === 'payments/checkout.ts');
    expect(fromCheckout.length).toBeLessThanOrEqual(5);
    expect(fromCheckout.length).toBeGreaterThan(2);
  });

  it('با سقف، فایل‌های بیشتری دیده می‌شوند', async () => {
    const d = new ContextDiscoverer(new ProjectIndexReader(indexWithCrowdedFile()));
    const capped = await d.discover({ task: 'checkout', limit: 6 });
    const uncapped = await d.discover({ task: 'checkout', limit: 6, maxPerFile: 100 });

    const distinct = (r: { candidates: readonly { path?: string }[] }) =>
      new Set(r.candidates.map(c => c.path)).size;

    expect(distinct(capped)).toBeGreaterThan(distinct(uncapped));
  });

  it('سقف، پرامتیازترین‌های هر فایل را نگه می‌دارد', async () => {
    const d = new ContextDiscoverer(new ProjectIndexReader(indexWithCrowdedFile()));
    const capped = await d.discover({ task: 'checkout', limit: 50 });
    const uncapped = await d.discover({ task: 'checkout', limit: 50, maxPerFile: 100 });

    const keptForFile = capped.candidates.filter(c => c.path === 'payments/checkout.ts');
    const allForFile = uncapped.candidates.filter(c => c.path === 'payments/checkout.ts');

    expect(keptForFile.map(c => c.id)).toEqual(allForFile.slice(0, keptForFile.length).map(c => c.id));
  });
});
