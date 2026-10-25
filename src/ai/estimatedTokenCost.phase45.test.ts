/**
 * SE-AI-09 — `estimatedTokenCost` سه فرمولِ ناسازگار داشت.
 *
 * ```
 * AiMetadataGenerator          Math.round(lines * 15 + size / 4)
 * LlmAiMetadataGenerator       Math.ceil(content.length / 4)
 * LlmAiMetadataGenerator (fallback)  Math.ceil(file.path.length / 4)   ← طولِ *مسیر*
 * ```
 *
 * و از فاز ۴۲ یک چهارمی هم هست: `TokenBudget.estimateTokens`، که
 * بودجه‌بندی واقعی روی آن بنا شده.
 *
 * دو مشکل. اول اینکه `lines * 15` تخمین را بزرگ می‌کند: اندازه‌گیری
 * روی ایندکس واقعی `semantic-engine/src`، نسبت به تقریبِ متعارفِ
 * «چهار کاراکتر یک توکن»:
 *
 * ```
 * میانگین نسبت estimatedTokenCost به (bytes ÷ 4):  ۲٫۶۲ برابر
 * ```
 *
 * دوم و بدتر: مسیرِ fallback هزینهٔ توکنِ یک فایل را از **طول مسیرش**
 * حساب می‌کرد. یک فایل ۵٬۰۰۰ خطی در مسیر `a.ts` هزینه‌اش می‌شد ۲
 * توکن.
 *
 * هر بودجه‌بندی‌ای که روی این عدد بنا شود غلط است — و فاز ۴۲ دقیقاً
 * چنین بودجه‌بندی‌ای ساخت.
 */

import { AiMetadataGenerator } from './AiMetadataGenerator';
import { estimateTokens } from './ranking/TokenBudget';
import { ProjectIndex, FileEntry } from '../core/types/project-index.types';

function file(id: string, path: string, lines: number, size: number): FileEntry {
  return {
    id,
    path,
    language: 'typescript',
    size,
    lines,
    hash: 'h',
    binary: false,
    testFile: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  } as unknown as FileEntry;
}

function index(files: FileEntry[]): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols: [],
    graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 100,
      totalSymbols: 0,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

function costOf(f: FileEntry): number {
  const generated = new AiMetadataGenerator().generate({
    workspaceRoot: '/tmp/fixture',
    files: [f],
    symbols: [],
    dependencyGraph: [],
  });
  return generated.get(f.id)!.estimatedTokenCost!;
}

describe('estimatedTokenCost — یک فرمول (SE-AI-09)', () => {
  it('با همان تخمینی می‌خواند که بودجه‌بندی رویش بنا شده', () => {
    const f = file('f1', 'src/a.ts', 100, 4000);

    expect(costOf(f)).toBe(estimateTokens('x'.repeat(4000)));
  });

  it('به طول مسیر وابسته نیست', () => {
    const short = file('f1', 'a.ts', 100, 4000);
    const long = file('f2', 'src/very/deeply/nested/module/name.ts', 100, 4000);

    expect(costOf(short)).toBe(costOf(long));
  });

  it('با اندازهٔ فایل رشد می‌کند', () => {
    const small = file('f1', 'src/a.ts', 10, 400);
    const big = file('f2', 'src/b.ts', 1000, 40000);

    expect(costOf(big)).toBeGreaterThan(costOf(small) * 50);
  });

  it('تخمین نسبت به bytes÷4 اغراق نمی‌کند', () => {
    /*
    | فرمول قبلی `lines * 15 + size / 4` بود. برای یک فایل معمولیِ
    | ۱٬۰۰۰ خطی و ۳۰KB، این می‌شد ۲۲٬۵۰۰ توکن در برابر ۷٬۵۰۰ توکنِ
    | تقریبِ متعارف — سه برابر.
    */
    const f = file('f1', 'src/a.ts', 1000, 30000);
    const conventional = estimateTokens('x'.repeat(30000));

    expect(costOf(f)).toBeLessThanOrEqual(conventional * 1.2);
  });

  it('فایل خالی، صفر نمی‌دهد', () => {
    expect(costOf(file('f1', 'src/a.ts', 0, 0))).toBeGreaterThanOrEqual(1);
  });

  it('همهٔ فایل‌های یک ایندکس عدد می‌گیرند', () => {
    const files = [file('f1', 'src/a.ts', 10, 100), file('f2', 'src/b.ts', 20, 200)];
    const generated = new AiMetadataGenerator().generate({
      workspaceRoot: '/tmp/fixture',
      files,
      symbols: [],
      dependencyGraph: [],
    });

    for (const f of files) {
      expect(generated.get(f.id)!.estimatedTokenCost).toBeGreaterThan(0);
    }
    void index(files);
  });
});
