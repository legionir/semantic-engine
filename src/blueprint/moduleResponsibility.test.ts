/**
 * SE-BP-05 — «مسئولیت ماژول» با تطبیق زیررشته روی *الحاقِ* همهٔ مسیرها
 * حساب می‌شد.
 *
 * ```ts
 * const names = files.map(f => f.path).join(' ');
 * const lower = names.toLowerCase();
 * if (lower.includes('service')) return 'Business logic and orchestration';
 * ...
 * if (lower.includes('test')) return 'Test specifications';
 * ```
 *
 * یعنی **یک** فایل کافی بود تا برچسبِ کلِ ماژول عوض شود. اندازه‌گیری
 * روی ایندکس واقعی `semantic-engine/src` (۲۸۱ فایل، ۳۲ ماژول):
 *
 * ```
 * ۲۵ ماژول از ۳۲ برچسب «Test specifications» گرفتند
 * ۲۰ تای آن ۲۵ تا، اکثریتشان کدِ منبع بود
 *   mod-ai-tools  →  «Test specifications»            ۱۴ فایل منبع، ۴ فایل تست
 *   mod-lsp       →  «Business logic and orchestration» ۱۸ فایل تست، ۱۳ فایل منبع
 * ```
 *
 * `mod-lsp` برچسب منطق کسب‌وکار گرفت چون یک فایل به نام
 * `LspEnrichmentService.ts` دارد و «service» پیش از «test» بررسی
 * می‌شود. یعنی ترتیبِ if ها هم بخشی از باگ بود.
 *
 * چرا snapshot طلایی این را نگرفت: fixture تقریباً یک فایل در هر پوشه
 * دارد، پس «الحاقِ مسیرها» با «مسیرِ تک‌فایل» یکی می‌شود و باگ اصلاً
 * تمرین نمی‌شود. همان درسِ SE-SEC-07 — تضمینی که fixture تمرینش نکند،
 * تضمین نیست.
 */

import { BlueprintGenerator } from './BlueprintGenerator';
import { ProjectIndex, FileEntry } from '../core/types/project-index.types';

function file(id: string, filePath: string): FileEntry {
  return {
    id,
    path: filePath,
    language: 'typescript',
    size: 100,
    lines: 20,
    hash: 'h',
    binary: false,
    testFile: /\.(test|spec)\.[jt]sx?$/.test(filePath),
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  } as unknown as FileEntry;
}

function indexOf(paths: readonly string[]): ProjectIndex {
  const files = paths.map((p, i) => file(`f${i}`, p));
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols: [],
    graphs: {
      dependencyGraph: [],
      reverseDependencyGraph: [],
      callGraph: [],
      typeGraph: [],
    },
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

function responsibilityOf(paths: readonly string[], moduleId: string): string {
  const bp = new BlueprintGenerator().generate(indexOf(paths));
  const mod = bp.moduleMap.find(m => m.id === moduleId);
  if (!mod) throw new Error(`module ${moduleId} not found in ${bp.moduleMap.map(m => m.id).join(', ')}`);
  return mod.responsibility;
}

describe('BlueprintGenerator — مسئولیت ماژول با رأی‌گیری، نه تطبیق زیررشته (SE-BP-05)', () => {
  it('یک فایل تست، برچسب یک ماژولِ عمدتاً منبع را عوض نمی‌کند', () => {
    const responsibility = responsibilityOf(
      [
        'src/tools/AssembleContextTool.ts',
        'src/tools/ExplainSymbolTool.ts',
        'src/tools/FindSymbolTool.ts',
        'src/tools/GetFileSummaryTool.ts',
        'src/tools/AssembleContextTool.test.ts',
      ],
      'mod-src-tools'
    );

    expect(responsibility).not.toBe('Test specifications');
  });

  it('ماژولی که همهٔ فایل‌هایش تست‌اند، همچنان «تست» است', () => {
    const responsibility = responsibilityOf(
      ['src/__tests__/a.test.ts', 'src/__tests__/b.test.ts'],
      // SE-BP-01 — مسیرِ دارای زیرخط، پسوندِ هش می‌گیرد تا با
      // `src/tests` تصادم نکند.
      'mod-src-tests-2a29cd'
    );

    expect(responsibility).toBe('Test specifications');
  });

  it('یک فایل با «service» در نام، ماژولی از سیزده فایل را برچسب نمی‌زند', () => {
    // دقیقاً شکلِ mod-lsp: یک LspEnrichmentService در میان دوازده فایل دیگر.
    const paths = [
      'src/lsp/LspEnrichmentService.ts',
      ...Array.from({ length: 12 }, (_, i) => `src/lsp/protocol-${i}.ts`),
    ];

    expect(responsibilityOf(paths, 'mod-src-lsp')).not.toBe(
      'Business logic and orchestration'
    );
  });

  it('اکثریت تعیین می‌کند، نه ترتیب if ها', () => {
    // «service» در فهرست قبل از «repository» بررسی می‌شد، پس ماژولی با
    // چهار repository و یک service، منطق کسب‌وکار اعلام می‌شد.
    const responsibility = responsibilityOf(
      [
        'src/data/UserRepository.ts',
        'src/data/OrderRepository.ts',
        'src/data/AuditRepository.ts',
        'src/data/CacheRepository.ts',
        'src/data/SyncService.ts',
      ],
      'mod-src-data'
    );

    expect(responsibility).toBe('Data access and persistence');
  });

  it('ماژول تک‌فایلی همان رفتار قبلی را دارد', () => {
    expect(responsibilityOf(['src/api/routes.ts'], 'mod-src-api')).toBe(
      'Handles HTTP/API routing'
    );
    expect(responsibilityOf(['src/model/User.ts'], 'mod-src-model')).toBe(
      'Domain models and data structures'
    );
    expect(responsibilityOf(['src/util/hash.ts'], 'mod-src-util')).toBe(
      'Shared utilities and helpers'
    );
  });

  it('وقتی هیچ الگویی اکثریت ندارد، به نام ماژول برمی‌گردد', () => {
    const responsibility = responsibilityOf(
      ['src/thing/alpha.ts', 'src/thing/beta.ts', 'src/thing/gamma.ts'],
      'mod-src-thing'
    );

    expect(responsibility).toBe('Module thing');
  });

  it('نتیجه دترمینیستیک است و به ترتیب ورودی حساس نیست', () => {
    const paths = [
      'src/x/OrderRepository.ts',
      'src/x/UserService.ts',
      'src/x/ItemRepository.ts',
    ];
    const forward = responsibilityOf(paths, 'mod-src-x');
    const backward = responsibilityOf([...paths].reverse(), 'mod-src-x');

    expect(forward).toBe(backward);
  });

  it('فایل تست، در رأی‌گیریِ موضوع شرکت نمی‌کند', () => {
    // بدون این قاعده، `UserService.test.ts` یک رأی برای «service»
    // می‌داد و ماژولِ دو فایلیِ زیر مساوی می‌شد.
    const responsibility = responsibilityOf(
      [
        'src/y/UserRepository.ts',
        'src/y/UserService.test.ts',
        'src/y/UserService.spec.ts',
      ],
      'mod-src-y'
    );

    expect(responsibility).toBe('Data access and persistence');
  });
});
