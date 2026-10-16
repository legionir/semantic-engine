/**
 * TestMapper — نگاشت symbol → فایل‌های تست.
 *
 * ## SE-AI-10 — دو مشکل مستقل
 *
 * **هزینه.** نسخهٔ قبلی حلقهٔ تودرتوی «همهٔ نمادها × همهٔ فایل‌های
 * تست» بود با عملیات رشته‌ای داخلش. اندازه‌گیری روی ایندکس واقعی
 * `semantic-engine/src`:
 *
 * ```
 * ۸٬۸۰۳ نماد × ۱۲۷ فایل تست = ۱٬۱۱۷٬۹۸۱ مقایسه   →   ۱٬۰۲۹ms
 * ```
 *
 * و این یک بار در `buildProjectIndex` و **دوباره در هر به‌روزرسانی
 * incremental** اجرا می‌شود. حالا سه ایندکس یک‌بار ساخته می‌شوند و هر
 * نماد فقط در آنها جست‌وجو می‌شود.
 *
 * **مثبت کاذب.** قاعدهٔ سوم این بود:
 *
 * ```ts
 * if (imp.from.toLowerCase().includes(symbolName.toLowerCase())) return true;
 * ```
 *
 * زیررشتهٔ خام. نمادی به نام `e` با هر مسیر importی که حرف «e» داشت
 * می‌خورد؛ روی ایندکس واقعی به **۱۲۰ فایل تست از ۱۲۷** نگاشت می‌شد و
 * میانگین کل ۶٫۷ فایل تست به ازای هر نماد بود. همان الگوی SE-VEC-11:
 * تطبیق باید روی **قطعه‌های** شناسه باشد نه زیررشته.
 *
 * سه قاعدهٔ نگاشت دست‌نخورده‌اند:
 *
 * ۱. نام فایل تست شامل نام فایل هدف باشد.
 * ۲. فایل تست، فایل هدف را import کرده باشد (`resolvedFileId`).
 * ۳. فایل تست، نمادی هم‌نام را import کرده باشد.
 */

import { ProjectIndex, FileEntry } from '../core/types/project-index.types';
import { identifierSegments } from './tools/queryTerms';

export interface TestMapping {
  readonly symbolId: string;
  readonly testFileIds: readonly string[];
}

export class TestMapper {
  private readonly fileById = new Map<string, FileEntry>();

  /** fileId هدف → فایل‌های تستی که مستقیم importش کرده‌اند. */
  private readonly testsByImportedFileId = new Map<string, Set<string>>();
  /** نامِ specifierِ import شده (lowercase) → فایل‌های تست. */
  private readonly testsBySpecifier = new Map<string, Set<string>>();
  /** پیشوندِ قطعه‌ایِ مسیرِ فایلِ تست → فایل‌های تست. برای قاعدهٔ ۱. */
  private readonly testsByPathPrefix = new Map<string, Set<string>>();
  /**
   * تک‌قطعه‌های مسیرِ import → فایل‌های تست. برای قاعدهٔ ۳.
   *
   * تطابق **برابریِ قطعه** است نه زیررشته: `../parser` قطعهٔ
   * `parser` می‌دهد، پس نمادِ `parser` می‌خورد ولی نمادِ `arse` یا
   * `e` نه.
   */
  private readonly testsByImportPathSegment = new Map<string, Set<string>>();

  private readonly testFiles: FileEntry[] = [];

  constructor(private readonly projectIndex: ProjectIndex) {
    for (const file of projectIndex.files) {
      this.fileById.set(file.id, file);
      if (file.testFile) this.testFiles.push(file);
    }
    this.buildIndexes();
  }

  buildSymbolToTestMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();

    /*
    | قاعدهٔ ۱ و ۲ به *فایل* بستگی دارند نه به نماد، پس یک بار برای
    | هر فایل حساب می‌شوند و بین همهٔ نمادهای آن فایل مشترک‌اند.
    | قبلاً برای هر نماد از نو حساب می‌شدند.
    */
    const byFile = new Map<string, Set<string>>();
    for (const file of this.projectIndex.files) {
      if (file.testFile) continue;
      byFile.set(file.id, this.testsForFile(file));
    }

    for (const symbol of this.projectIndex.symbols) {
      const fromFile = byFile.get(symbol.fileId);
      if (!fromFile) continue;

      const lowered = symbol.name.toLowerCase();
      const bySymbol = this.testsBySpecifier.get(lowered);
      const byPathSegment = this.testsByImportPathSegment.get(lowered);

      if (fromFile.size === 0 && !bySymbol && !byPathSegment) continue;

      const combined = new Set(fromFile);
      if (bySymbol) for (const id of bySymbol) combined.add(id);
      if (byPathSegment) for (const id of byPathSegment) combined.add(id);

      if (combined.size > 0) map.set(symbol.id, [...combined].sort());
    }

    return map;
  }

  /** قاعدهٔ ۱ و ۲ — وابسته به فایل، نه به نماد. */
  private testsForFile(target: FileEntry): Set<string> {
    const out = new Set<string>();

    const direct = this.testsByImportedFileId.get(target.id);
    if (direct) for (const id of direct) out.add(id);

    /*
    | قاعدهٔ ۱ — نام فایل هدف در مسیر تست.
    |
    | تطبیق روی **قطعه‌ها** است، نه زیررشتهٔ خام: `src/a.ts` نباید با
    | `src/data.test.ts` بخورد فقط چون حرف «a» در آن هست.
    */
    const baseSegments = identifierSegments(
      target.path.replace(/\.[^.]+$/, '')
    );
    if (baseSegments.length > 0) {
      const key = baseSegments.join('/');
      const byPath = this.testsByPathPrefix.get(key);
      if (byPath) for (const id of byPath) out.add(id);
    }

    return out;
  }

  private buildIndexes(): void {
    for (const test of this.testFiles) {
      for (const imp of test.imports ?? []) {
        if (imp.resolvedFileId) {
          add(this.testsByImportedFileId, imp.resolvedFileId, test.id);
        }

        /*
        | قاعدهٔ ۳ (بخش مسیر) — نامِ نماد به‌عنوان یک **قطعهٔ کامل**
        | از مسیرِ import. قبلاً `imp.from.includes(name)` بود، یعنی
        | زیررشتهٔ خام، که نمادِ `e` را به هر مسیرِ حاوی «e» وصل
        | می‌کرد.
        */
        for (const segment of identifierSegments(imp.from)) {
          add(this.testsByImportPathSegment, segment, test.id);
        }

        for (const spec of imp.specifiers ?? []) {
          /*
          | تطابقِ **دقیق** روی نامِ import شده. اینجا طولِ نام مهم
          | نیست: اگر تست واقعاً `import { e }` کرده، آن نگاشت
          | واقعی است — برخلاف حدس زدن از روی مسیر.
          */
          add(this.testsBySpecifier, spec.imported.toLowerCase(), test.id);
          if (spec.local) add(this.testsBySpecifier, spec.local.toLowerCase(), test.id);
        }
      }

      /*
      | همهٔ پیشوندهای قطعه‌ایِ مسیرِ تست، تا قاعدهٔ ۱ بدون پیمایشِ
      | همهٔ تست‌ها قابل جست‌وجو باشد. مسیر `src/auth.test.ts` کلیدهای
      | `src`, `src/auth`, `src/auth/test`, … می‌سازد و فایلِ هدفِ
      | `src/auth.ts` با کلیدِ `src/auth` پیدایش می‌کند.
      */
      const segments = identifierSegments(test.path.replace(/\.[^.]+$/, ''));
      for (let end = 1; end <= segments.length; end++) {
        add(this.testsByPathPrefix, segments.slice(0, end).join('/'), test.id);
      }
    }
  }
}

function add(target: Map<string, Set<string>>, key: string, value: string): void {
  let bucket = target.get(key);
  if (!bucket) {
    bucket = new Set<string>();
    target.set(key, bucket);
  }
  bucket.add(value);
}
