/**
 * SE-AI-10 — `TestMapper` درجه‌دوم بود و مثبت کاذب زیاد می‌داد.
 *
 * ```ts
 * for (const symbol of this.projectIndex.symbols) {
 *   for (const test of testFiles) {
 *     if (this.isRelatedTest(test, file, symbol)) ...
 * ```
 *
 * حلقهٔ تودرتوی «همهٔ نمادها × همهٔ فایل‌های تست»، با عملیات رشته‌ای
 * داخلش. اندازه‌گیری روی ایندکس واقعی `semantic-engine/src`:
 *
 * ```
 * ۸٬۸۰۳ نماد × ۱۲۷ فایل تست = ۱٬۱۱۷٬۹۸۱ مقایسه   →   ۱٬۰۲۹ms
 * ```
 *
 * و این یک بار در `buildProjectIndex` و **دوباره در هر به‌روزرسانی
 * incremental** اجرا می‌شود.
 *
 * ایراد دوم بدتر است. قاعدهٔ سوم این بود:
 *
 * ```ts
 * if (imp.from.toLowerCase().includes(symbolName.toLowerCase())) return true;
 * ```
 *
 * یعنی نمادی به نام `e` با هر مسیر importی که حرف «e» داشته باشد
 * می‌خورد. اندازه‌گیری: نمادِ `e` به **۱۲۰ فایل تست** از ۱۲۷ تا نگاشت
 * می‌شد، و میانگین کل ۶٫۷ فایل تست به ازای هر نماد بود.
 */

import { TestMapper } from './TestMapper';
import { ProjectIndex, FileEntry, SymbolEntry } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';

function file(
  id: string,
  path: string,
  extra: Partial<FileEntry> = {}
): FileEntry {
  return {
    id,
    path,
    language: 'typescript',
    size: 100,
    lines: 10,
    hash: 'h',
    binary: false,
    testFile: /\.(test|spec)\.ts$/.test(path),
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
    ...extra,
  } as unknown as FileEntry;
}

function sym(id: string, fileId: string, name: string): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind: 'function',
    name,
    fullyQualifiedName: name,
    signature: `${name}()`,
    visibility: 'public',
    line: 1,
    endLine: 2,
    documentation: null,
    deprecated: false,
    exported: true,
    source: 'tree-sitter',
    confidence: makeConfidence(90),
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
      totalLoc: 100,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

describe('TestMapper — نگاشت‌های درست حفظ می‌شوند', () => {
  it('نام فایل تست شامل نام فایل هدف', () => {
    const files = [file('f1', 'src/auth.ts'), file('t1', 'src/auth.test.ts')];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'login')])).buildSymbolToTestMap();

    expect(map.get('s1')).toEqual(['t1']);
  });

  it('فایل تستی که فایل هدف را import کرده', () => {
    const files = [
      file('f1', 'src/auth.ts'),
      file('t1', 'src/unrelated-name.test.ts', {
        imports: [{ from: '../auth', type: 'local', resolvedFileId: 'f1', specifiers: [] }],
      } as Partial<FileEntry>),
    ];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'login')])).buildSymbolToTestMap();

    expect(map.get('s1')).toEqual(['t1']);
  });

  it('فایل تستی که خودِ نماد را import کرده', () => {
    const files = [
      file('f1', 'src/auth.ts'),
      file('t1', 'src/other.test.ts', {
        imports: [
          {
            from: '../somewhere',
            type: 'local',
            specifiers: [{ imported: 'login', local: 'login' }],
          },
        ],
      } as Partial<FileEntry>),
    ];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'login')])).buildSymbolToTestMap();

    expect(map.get('s1')).toEqual(['t1']);
  });

  it('نمادِ بدون تست، در نگاشت نمی‌آید', () => {
    const files = [file('f1', 'src/auth.ts'), file('t1', 'src/other.test.ts')];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'login')])).buildSymbolToTestMap();

    expect(map.has('s1')).toBe(false);
  });

  it('نتیجه دترمینیستیک و مرتب است', () => {
    const files = [
      file('f1', 'src/auth.ts'),
      file('t2', 'src/auth.spec.ts'),
      file('t1', 'src/auth.test.ts'),
    ];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'login')])).buildSymbolToTestMap();

    expect(map.get('s1')).toEqual(['t1', 't2']);
  });
});

describe('TestMapper — مثبت کاذب (SE-AI-10)', () => {
  it('نمادِ تک‌حرفی به هر فایل تستی نگاشت نمی‌شود', () => {
    /*
    | قاعدهٔ قبلی `imp.from.includes(symbolName)` بود، پس نمادی به نام
    | `e` با هر مسیر importی که حرف e داشت می‌خورد. روی ایندکس
    | واقعی، `e` به ۱۲۰ فایل تست از ۱۲۷ تا نگاشت می‌شد.
    */
    const tests = Array.from({ length: 20 }, (_, i) =>
      file(`t${i}`, `src/feature${i}.test.ts`, {
        imports: [{ from: `../feature${i}`, type: 'local', specifiers: [] }],
      } as Partial<FileEntry>)
    );
    const files = [file('f1', 'src/util.ts'), ...tests];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'e')])).buildSymbolToTestMap();

    expect(map.get('s1') ?? []).toEqual([]);
  });

  it('نامِ کوتاه که زیررشتهٔ مسیر است، تطابق حساب نمی‌شود', () => {
    const files = [
      file('f1', 'src/util.ts'),
      file('t1', 'src/parser.test.ts', {
        imports: [{ from: '../parser', type: 'local', specifiers: [] }],
      } as Partial<FileEntry>),
    ];
    // «arse» زیررشتهٔ «parser» است ولی قطعهٔ آن نیست.
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'arse')])).buildSymbolToTestMap();

    expect(map.get('s1') ?? []).toEqual([]);
  });

  it('نامِ کاملِ منطبق با قطعهٔ مسیر، همچنان می‌خورد', () => {
    const files = [
      file('f1', 'src/util.ts'),
      file('t1', 'src/parser.test.ts', {
        imports: [{ from: '../parser', type: 'local', specifiers: [] }],
      } as Partial<FileEntry>),
    ];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'parser')])).buildSymbolToTestMap();

    expect(map.get('s1')).toEqual(['t1']);
  });

  it('تطابق دقیقِ specifier به طول نام حساس نیست', () => {
    // یک نماد تک‌حرفی که *واقعاً* import شده، باید بخورد.
    const files = [
      file('f1', 'src/util.ts'),
      file('t1', 'src/other.test.ts', {
        imports: [
          { from: '../util', type: 'local', specifiers: [{ imported: 'e', local: 'e' }] },
        ],
      } as Partial<FileEntry>),
    ];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'e')])).buildSymbolToTestMap();

    expect(map.get('s1')).toEqual(['t1']);
  });

  it('ماژولی با نامِ پیشوندی، تستِ ماژول دیگر را نمی‌قاپد', () => {
    /*
    | قاعدهٔ ۱ قبلاً `test.path.includes(targetBase)` بود، یعنی
    | زیررشتهٔ خامِ کلِ مسیر. برای فایلِ `src/user.ts` مقدار
    | `targetBase` می‌شود `src/user`، و
    | `'src/user2.test.ts'.includes('src/user')` **درست** است — پس
    | `user.ts` تستِ `user2.ts` را هم مالِ خودش می‌دانست.
    |
    | با قطعه‌بندی، `src/user` پیشوندِ قطعه‌ایِ
    | `['src','user2','test']` نیست، پس نمی‌خورد.
    */
    const files = [
      file('f1', 'src/user.ts'),
      file('f2', 'src/user2.ts'),
      file('t1', 'src/user2.test.ts'),
    ];
    const map = new TestMapper(
      index(files, [sym('s1', 'f1', 'helper'), sym('s2', 'f2', 'helper2')])
    ).buildSymbolToTestMap();

    expect(map.get('s1') ?? []).toEqual([]);
    expect(map.get('s2')).toEqual(['t1']);
  });

  it('نام فایلِ هدف باید قطعهٔ کاملی از مسیر تست باشد', () => {
    // `src/a.ts` نباید با `src/data.test.ts` بخورد فقط چون «a» در آن هست.
    const files = [file('f1', 'src/a.ts'), file('t1', 'src/data.test.ts')];
    const map = new TestMapper(index(files, [sym('s1', 'f1', 'helper')])).buildSymbolToTestMap();

    expect(map.get('s1') ?? []).toEqual([]);
  });
});

describe('TestMapper — هزینه (SE-AI-10)', () => {
  it('با بزرگ شدن پروژه، درجه‌دوم رشد نمی‌کند', () => {
    function build(symbolCount: number, testCount: number): number {
      const sources = Array.from({ length: 50 }, (_, i) => file(`f${i}`, `src/mod${i}.ts`));
      const tests = Array.from({ length: testCount }, (_, i) =>
        file(`t${i}`, `src/mod${i % 50}.test.ts`, {
          imports: [{ from: `./mod${i % 50}`, type: 'local', specifiers: [] }],
        } as Partial<FileEntry>)
      );
      const symbols = Array.from({ length: symbolCount }, (_, i) =>
        sym(`s${i}`, `f${i % 50}`, `handler${i}`)
      );

      const mapper = new TestMapper(index([...sources, ...tests], symbols));
      const started = Date.now();
      mapper.buildSymbolToTestMap();
      return Date.now() - started;
    }

    // گرم کردن، تا JIT نتیجه را به‌هم نریزد.
    build(500, 20);

    const small = build(2000, 40);
    const large = build(4000, 80);

    /*
    | با رفتار درجه‌دوم، دو برابر کردنِ *هر دو* بُعد یعنی چهار برابر
    | کار. آستانه سخاوتمندانه است چون زمان‌سنجی زیر بار کل سوئیت
    | نوسان دارد؛ چیزی که رد می‌شود، رشدِ چهاربرابری است.
    */
    expect({ small, large, ratio: large / Math.max(1, small) }).toEqual(
      expect.objectContaining({ small, large })
    );
    expect(large).toBeLessThan(Math.max(60, small * 3));
  });

  it('همان نگاشتی را می‌دهد که پیمایش کامل می‌داد', () => {
    const sources = Array.from({ length: 12 }, (_, i) => file(`f${i}`, `src/mod${i}.ts`));
    const tests = Array.from({ length: 8 }, (_, i) =>
      file(`t${i}`, `src/mod${i}.test.ts`, {
        imports: [
          {
            from: `./mod${i}`,
            type: 'local',
            resolvedFileId: `f${i}`,
            specifiers: [{ imported: `run${i}`, local: `run${i}` }],
          },
        ],
      } as Partial<FileEntry>)
    );
    const symbols = Array.from({ length: 24 }, (_, i) => sym(`s${i}`, `f${i % 12}`, `run${i % 12}`));
    const projectIndex = index([...sources, ...tests], symbols);

    const map = new TestMapper(projectIndex).buildSymbolToTestMap();

    // مرجع: همان سه قاعده، اجراشده به‌صورت کاملاً مستقیم.
    const testFiles = projectIndex.files.filter(f => f.testFile);
    const fileById = new Map(projectIndex.files.map(f => [f.id, f]));
    for (const s of projectIndex.symbols) {
      const owner = fileById.get(s.fileId)!;
      const base = owner.path.replace(/\.[^.]+$/, '').toLowerCase();
      const expected = testFiles
        .filter(
          t =>
            t.path.toLowerCase().includes(base) ||
            (t.imports ?? []).some(imp => imp.resolvedFileId === owner.id) ||
            (t.imports ?? []).some(imp =>
              (imp.specifiers ?? []).some(sp => sp.imported.toLowerCase() === s.name.toLowerCase())
            )
        )
        .map(t => t.id)
        .sort();

      expect({ id: s.id, got: map.get(s.id) ?? [] }).toEqual({ id: s.id, got: expected });
    }
  });
});
