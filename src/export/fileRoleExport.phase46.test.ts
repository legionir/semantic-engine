/**
 * SE-DATA-04 — `role` و `entryPoint` باید واقعاً در خروجی بنشینند.
 *
 * محاسبه کردنشان کافی نیست: `entryPoint` سال‌ها *محاسبه می‌شد* و
 * نتیجه‌اش داخل `aiScore.factors` دفن می‌ماند. آزمونِ خودِ تابعِ
 * دسته‌بندی این را نمی‌گیرد — باید از مسیرِ export پرسید.
 *
 * برگرداندنِ اتصال (حذف دو خط از `attachAiMetadata`) پیش از افزودنِ
 * این آزمون **صفر** شکست می‌داد.
 */

import { JsonExporter } from './JsonExporter';
import { FileEntry } from '../core/types/project-index.types';
import { ScanResult } from '../scanner/WorkspaceScanner';

function file(id: string, path: string): FileEntry {
  return {
    id,
    path,
    language: 'typescript',
    encoding: 'utf8',
    size: 100,
    lines: 10,
    hash: 'h',
    binary: false,
    testFile: /\.test\.ts$/.test(path),
    generated: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  } as unknown as FileEntry;
}

async function exported(paths: string[]) {
  const files = paths.map((p, i) => file(`f${i}`, p));
  const scanResult = {
    files,
    warnings: [],
    diagnostics: [],
    languages: ['typescript'],
    root: '/tmp/fixture',
    stats: { totalFiles: files.length, totalBytes: 0, skipped: 0 },
  } as unknown as ScanResult;

  return new JsonExporter().buildProjectIndex(scanResult, [], {
    workspaceRoot: '/tmp/fixture',
    outputPath: '/tmp/fixture/project-index.json',
  } as never);
}

describe('JsonExporter — role و entryPoint در خروجی (SE-DATA-04)', () => {
  it('هر فایل یک role دارد', async () => {
    const index = await exported([
      'src/user.service.ts',
      'src/user.controller.ts',
      'src/index.ts',
      'src/alpha/beta.ts',
    ]);

    for (const f of index.files) {
      expect({ path: f.path, hasRole: typeof f.role === 'string' }).toEqual({
        path: f.path,
        hasRole: true,
      });
    }
  });

  it('role درست است', async () => {
    const index = await exported(['src/user.service.ts', 'src/user.controller.ts']);
    const byPath = new Map(index.files.map(f => [f.path, f.role]));

    expect(byPath.get('src/user.service.ts')).toBe('service');
    expect(byPath.get('src/user.controller.ts')).toBe('controller');
  });

  it('entryPoint نوشته می‌شود، نه فقط محاسبه', async () => {
    const index = await exported(['src/index.ts', 'src/alpha/beta.ts']);
    const byPath = new Map(index.files.map(f => [f.path, f.entryPoint]));

    expect(byPath.get('src/index.ts')).toBe(true);
    expect(byPath.get('src/alpha/beta.ts')).toBe(false);
  });

  it('فایلی که نقشش معلوم نیست، unknown می‌گیرد نه undefined', async () => {
    const index = await exported(['src/alpha/beta.ts']);

    expect(index.files[0].role).toBe('unknown');
  });
});

/*
| SE-SYM-16 / SE-GRAPH-08 — سطح پشتیبانی باید در خودِ خروجی باشد.
|
| `describeLanguageSupport` آزمون داشت، ولی هیچ‌کس نمی‌پرسید نتیجه‌اش
| به `project-index.json` می‌رسد یا نه. برگرداندنِ اتصال، صفر شکست
| می‌داد — همان شکافی که فاز ۴۶ سه بار در آن افتاد: آزمونِ جزء بدون
| آزمونِ اتصال.
*/
describe('JsonExporter — سطح پشتیبانی زبان در خروجی (SE-SYM-16)', () => {
  it('ایندکس، سطح پشتیبانی را اعلام می‌کند', async () => {
    const index = await exported(['src/a.ts']);

    expect(index.languageSupport).toBeDefined();
    expect(index.languageSupport!.typescript).toEqual({ symbols: 'full', callGraph: true });
  });

  it('برای هر زبانِ موجود یک ورودی هست', async () => {
    const index = await exported(['src/a.ts']);

    for (const language of index.languages) {
      expect({ language, has: language in index.languageSupport! }).toEqual({
        language,
        has: true,
      });
    }
  });
});
