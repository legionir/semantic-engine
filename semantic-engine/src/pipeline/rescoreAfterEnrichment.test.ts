/**
 * SE-AI-13 — `aiScore` پیش از غنی‌سازی حساب می‌شد.
 *
 * ترتیب مراحل در `IndexPipeline` این است و اجباری هم هست:
 *
 * ```
 * symbolها → گراف‌ها → متریک‌ها و aiScore → ساخت ایندکس → غنی‌سازی LSP
 * ```
 *
 * اجباری است چون `SymbolMetricsCalculator` خودش `referenceCount` را
 * از گراف حدسی پر می‌کند؛ اگر غنی‌سازی زودتر بیاید، عددِ کامپایلر با
 * حدس **بازنویسی** می‌شود.
 *
 * عارضه‌اش این بود که `aiScore` — که یکی از ورودی‌هایش همان
 * `referenceCount` است — عددهای اصلاح‌شده را نمی‌دید. در یک ایندکسِ
 * غنی‌شده، `referenceCount` از سرور می‌آمد ولی `importance` و
 * `hotness` هنوز بر اساس تخمینِ قبلی بودند. ناسازگاری **بی‌صدا** بود:
 * هر دو عدد معتبر به نظر می‌رسیدند.
 *
 * این یافته در فاز ۳۷ ثبت و به فاز ۴۵ نسبت داده شده بود، ولی در متنِ
 * آن فاز فهرست نشده بود و از قلم افتاد. اینجا بسته می‌شود.
 */

import { ProjectIndex, SymbolEntry, FileEntry } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';
import { rescoreAfterEnrichment } from './rescoreAfterEnrichment';

function file(id: string, path: string, importance: number): FileEntry {
  return {
    id,
    path,
    language: 'typescript',
    size: 400,
    lines: 40,
    hash: 'h',
    binary: false,
    testFile: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
    aiMetadata: {
      summary: `summary of ${path}`,
      keywords: [],
      relatedFileIds: [],
      estimatedTokenCost: 100,
      aiScore: { importance, readPriority: importance, hotness: 10 },
    },
  } as unknown as FileEntry;
}

function sym(id: string, fileId: string, referenceCount: number | null): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind: 'function',
    name: `fn_${id}`,
    fullyQualifiedName: `fn_${id}`,
    signature: `fn_${id}()`,
    visibility: 'public',
    line: 1,
    endLine: 3,
    documentation: null,
    deprecated: false,
    exported: true,
    source: 'tree-sitter',
    confidence: makeConfidence(90),
    complexity: 2,
    referenceCount,
  } as unknown as SymbolEntry;
}

function index(files: FileEntry[], symbols: SymbolEntry[]): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols,
    graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 80,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 2,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

describe('rescoreAfterEnrichment (SE-AI-13)', () => {
  it('فایلی که ارجاعش بالا رفته، importance بالاتری می‌گیرد', () => {
    const before = index(
      [file('f1', 'src/a.ts', 20), file('f2', 'src/b.ts', 20)],
      [sym('s1', 'f1', 2), sym('s2', 'f2', 2)]
    );

    // غنی‌سازی: زبان‌سرور می‌گوید f1 بسیار پرارجاع است.
    const enriched = index(
      [file('f1', 'src/a.ts', 20), file('f2', 'src/b.ts', 20)],
      [sym('s1', 'f1', 90), sym('s2', 'f2', 2)]
    );

    const rescored = rescoreAfterEnrichment(enriched);

    const a = rescored.files.find(f => f.id === 'f1')!.aiMetadata!.aiScore!;
    const b = rescored.files.find(f => f.id === 'f2')!.aiMetadata!.aiScore!;

    expect(a.importance).toBeGreaterThan(b.importance);
    void before;
  });

  it('بدون تغییر در ارجاع‌ها، امتیازها دست‌نخورده می‌مانند', () => {
    const projectIndex = index([file('f1', 'src/a.ts', 42)], [sym('s1', 'f1', 5)]);
    const rescored = rescoreAfterEnrichment(projectIndex);

    // فقط وقتی چیزی عوض می‌شود که ورودی عوض شده باشد؛ همان ورودی
    // باید همان خروجی بدهد.
    const twice = rescoreAfterEnrichment(rescored);
    expect(twice.files[0]!.aiMetadata!.aiScore).toEqual(rescored.files[0]!.aiMetadata!.aiScore);
  });

  it('فایلی که aiMetadata ندارد، دست‌نخورده می‌ماند', () => {
    const bare = {
      id: 'f1',
      path: 'src/a.ts',
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
    } as unknown as FileEntry;

    const rescored = rescoreAfterEnrichment(index([bare], [sym('s1', 'f1', 9)]));

    expect(rescored.files[0]!.aiMetadata).toBeUndefined();
  });

  it('بقیهٔ aiMetadata حفظ می‌شود', () => {
    const projectIndex = index([file('f1', 'src/a.ts', 20)], [sym('s1', 'f1', 50)]);
    const rescored = rescoreAfterEnrichment(projectIndex);

    const meta = rescored.files[0]!.aiMetadata!;
    expect(meta.summary).toBe('summary of src/a.ts');
    expect(meta.estimatedTokenCost).toBe(100);
  });

  it('امتیاز در بازهٔ ۰ تا ۱۰۰ می‌ماند', () => {
    const projectIndex = index(
      [file('f1', 'src/a.ts', 99)],
      [sym('s1', 'f1', 100000), sym('s2', 'f1', 100000)]
    );
    const score = rescoreAfterEnrichment(projectIndex).files[0]!.aiMetadata!.aiScore!;

    expect(score.importance).toBeGreaterThanOrEqual(0);
    expect(score.importance).toBeLessThanOrEqual(100);
    expect(score.readPriority).toBeLessThanOrEqual(100);
  });

  it('ارجاعِ نامعلوم، امتیاز را صفر نمی‌کند', () => {
    /*
    | همان قاعدهٔ فاز ۴۲: `null` یعنی «اندازه‌گیری نشده»، نه «صفر
    | ارجاع». فایلی که زبان‌سرور به آن نرسیده نباید تنزل کند.
    */
    const measured = index([file('f1', 'src/a.ts', 60)], [sym('s1', 'f1', 8)]);
    const unmeasured = index([file('f1', 'src/a.ts', 60)], [sym('s1', 'f1', null)]);

    const a = rescoreAfterEnrichment(measured).files[0]!.aiMetadata!.aiScore!;
    const b = rescoreAfterEnrichment(unmeasured).files[0]!.aiMetadata!.aiScore!;

    expect(b.importance).toBe(60);
    expect(a.importance).not.toBe(0);
  });

  it('ارجاعِ نامعلوم، سهمِ قبلی را پس نمی‌گیرد', () => {
    /*
    | حالتی که آزمون قبلی از آن رد می‌شد: فایلی که قبلاً سهمِ ارجاع
    | گرفته و حالا زبان‌سرور به آن نرسیده. اگر `null` را صفر
    | بگیریم، آن سهم پس گرفته می‌شود و فایل بی‌دلیل تنزل می‌کند.
    */
    const withPriorWeight = {
      ...file('f1', 'src/a.ts', 60),
      aiMetadata: {
        summary: 'x',
        aiScore: {
          importance: 60,
          readPriority: 60,
          hotness: 10,
          factors: { referenceCountWeight: 25 },
        },
      },
    } as unknown as FileEntry;

    const rescored = rescoreAfterEnrichment(index([withPriorWeight], [sym('s1', 'f1', null)]));

    expect(rescored.files[0]!.aiMetadata!.aiScore!.importance).toBe(60);
  });

  it('بیشینهٔ ارجاع تعیین‌کننده است، نه میانگین', () => {
    /*
    | یک فایل با یک نمادِ پرارجاع مهم است، حتی اگر ده نمادِ خصوصیِ
    | بی‌ارجاع هم داشته باشد. میانگین دقیقاً همان فایل را تنزل
    | می‌دهد.
    */
    const projectIndex = index(
      [file('f1', 'src/a.ts', 20)],
      [sym('s1', 'f1', 20), sym('s2', 'f1', 0), sym('s3', 'f1', 0), sym('s4', 'f1', 0)]
    );

    const score = rescoreAfterEnrichment(projectIndex).files[0]!.aiMetadata!.aiScore!;

    // بیشینه ۲۰ ⇒ اشباع ⇒ سهم کامل ۳۰.
    expect(score.factors!.referenceCountWeight).toBe(30);
  });

  it('ایندکس بدون فایل، خطا نمی‌دهد', () => {
    expect(() => rescoreAfterEnrichment(index([], []))).not.toThrow();
  });

  it('دترمینیستیک است', () => {
    const projectIndex = index([file('f1', 'src/a.ts', 20)], [sym('s1', 'f1', 30)]);

    expect(rescoreAfterEnrichment(projectIndex)).toEqual(rescoreAfterEnrichment(projectIndex));
  });
});
