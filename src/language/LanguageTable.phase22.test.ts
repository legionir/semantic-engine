/**
 * فاز ۲۲ — جدول زبان‌ها.
 *
 * این تست‌ها جدول زبان را به‌عنوان یک «منبع حقیقت» می‌سنجند، نه به‌عنوان
 * چند ثابت. سه چیز باید هم‌زمان درست باشند و تا امروز نبودند:
 *
 *   ۱. جدول با خودش سازگار باشد — یک id فقط یک بار، یک پسوند فقط یک زبان.
 *   ۲. هر سه API عمومی (`detect`, `isDeepAnalysisSupported`,
 *      `getSymbolExtractionMethod`) روی هر زبان یک جواب بدهند.
 *   ۳. جدول با واقعیت بخواند — زبانی که «تحلیل عمیق دارد» واقعاً یک
 *      استخراج‌گر ثبت‌شده داشته باشد، و هیچ استخراج‌گری زبانی را ادعا
 *      نکند که رجیستری هرگز تولیدش نمی‌کند.
 */

import { LanguageRegistry } from './LanguageRegistry';
import {
  ALL_LANGUAGES,
  EXTENSION_MAP,
  FILENAME_MAP,
  SHEBANG_MAP,
  getSymbolExtractionMethod,
} from './languageMap';
import { createExtractors } from '../pipeline/ExtractorFactory';
import { JsonSymbolExtractor } from '../symbols/heuristic/JsonSymbolExtractor';

const registry = new LanguageRegistry();

/** هر id ای که رجیستری می‌تواند برای یک فایل واقعی برگرداند. */
const EMITTABLE_IDS = new Set(ALL_LANGUAGES.map(l => l.id));

describe('فاز ۲۲ — سازگاری درونی جدول زبان‌ها', () => {
  it('هیچ زبانی دو بار تعریف نشده است', () => {
    const seen = new Map<string, number>();
    for (const lang of ALL_LANGUAGES) {
      seen.set(lang.id, (seen.get(lang.id) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(duplicates).toEqual([]);
    expect(ALL_LANGUAGES.length).toBe(EMITTABLE_IDS.size);
  });

  it('هیچ پسوندی به دو زبان تعلق ندارد', () => {
    const owners = new Map<string, string[]>();
    for (const lang of ALL_LANGUAGES) {
      for (const ext of lang.extensions) {
        const key = ext.toLowerCase();
        owners.set(key, [...(owners.get(key) ?? []), lang.id]);
      }
    }
    const contested = [...owners.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([ext, ids]) => `${ext} -> ${ids.join(', ')}`);
    expect(contested).toEqual([]);
  });

  it('هیچ نام‌فایل یا shebangی به دو زبان تعلق ندارد', () => {
    const collide = (pick: (l: (typeof ALL_LANGUAGES)[number]) => readonly string[] | undefined) => {
      const owners = new Map<string, string[]>();
      for (const lang of ALL_LANGUAGES) {
        for (const key of pick(lang) ?? []) {
          const k = key.toLowerCase();
          owners.set(k, [...(owners.get(k) ?? []), lang.id]);
        }
      }
      return [...owners.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([k, ids]) => `${k} -> ${ids.join(', ')}`);
    };
    expect(collide(l => l.filenames)).toEqual([]);
    expect(collide(l => l.shebangs)).toEqual([]);
  });

  it('جدول‌های lookup چیزی از جدول اصلی گم نکرده‌اند', () => {
    const extCount = ALL_LANGUAGES.reduce((n, l) => n + l.extensions.length, 0);
    const nameCount = ALL_LANGUAGES.reduce((n, l) => n + (l.filenames?.length ?? 0), 0);
    const shebangCount = ALL_LANGUAGES.reduce((n, l) => n + (l.shebangs?.length ?? 0), 0);
    expect(EXTENSION_MAP.size).toBe(extCount);
    expect(FILENAME_MAP.size).toBe(nameCount);
    expect(SHEBANG_MAP.size).toBe(shebangCount);
  });
});

describe('فاز ۲۲ — سه API روی هر زبان یک جواب می‌دهند', () => {
  /*
  | SE-SCAN-05: `detect()` از `EXTENSION_MAP` می‌خواند (آخرین تعریف برنده)
  | ولی `isDeepAnalysisSupported()` از `.some()` روی `ALL_LANGUAGES`
  | (اولین تعریفِ `true` برنده). با تعریف تکراری، این دو برای html/css/
  | scss/less جواب متضاد می‌دادند.
  */
  it.each(ALL_LANGUAGES.map(l => [l.id, l] as const))(
    'زبان %s: detect() و isDeepAnalysisSupported() هم‌نظرند',
    (id, lang) => {
      const samples = [
        ...lang.extensions.map(e => `dir/sample.${e}`),
        ...(lang.filenames ?? []).map(n => `dir/${n}`),
      ];
      expect(samples.length).toBeGreaterThan(0);

      for (const sample of samples) {
        const detected = registry.detect(sample);
        expect(detected).not.toBeNull();
        expect(detected!.id).toBe(id);
        expect(detected!.deepAnalysisSupported).toBe(registry.isDeepAnalysisSupported(id));
      }
    }
  );

  it.each(ALL_LANGUAGES.map(l => [l.id, l] as const))(
    'زبان %s: تشخیص با shebang همان زبان را می‌دهد',
    (id, lang) => {
      for (const shebang of lang.shebangs ?? []) {
        const detected = registry.detect('scripts/runme', `#!/usr/bin/env ${shebang}`);
        expect(detected?.id).toBe(id);
      }
    }
  );

  it('روش استخراج دقیقاً برای زبان‌های «تحلیل عمیق» تعریف شده است', () => {
    const disagreement: string[] = [];
    for (const lang of ALL_LANGUAGES) {
      const hasMethod = getSymbolExtractionMethod(lang.id) !== null;
      if (hasMethod !== lang.deepAnalysisSupported) {
        disagreement.push(
          `${lang.id}: deepAnalysisSupported=${lang.deepAnalysisSupported} ولی method=${getSymbolExtractionMethod(lang.id)}`
        );
      }
    }
    expect(disagreement).toEqual([]);
  });

  it('getDeepAnalysisLanguages دقیقاً همان مجموعه است و تکراری ندارد', () => {
    const deep = registry.getDeepAnalysisLanguages();
    const ids = deep.map(l => l.id);
    expect([...new Set(ids)]).toEqual(ids);
    expect(new Set(ids)).toEqual(
      new Set(ALL_LANGUAGES.filter(l => l.deepAnalysisSupported).map(l => l.id))
    );
  });
});

describe('فاز ۲۲ — جدول با استخراج‌گرهای واقعی می‌خواند', () => {
  const set = createExtractors({ workspaceRoot: process.cwd(), treeSitter: false });

  afterAll(() => set.dispose());

  it('هر زبان «تحلیل عمیق» واقعاً یک استخراج‌گر ثبت‌شده دارد — و بالعکس', async () => {
    const disagreement: string[] = [];
    for (const lang of ALL_LANGUAGES) {
      const covered = await set.symbols.hasExtractorFor(lang.id);
      if (covered !== lang.deepAnalysisSupported) {
        disagreement.push(
          `${lang.id}: deepAnalysisSupported=${lang.deepAnalysisSupported} ولی استخراج‌گر=${covered}`
        );
      }
    }
    expect(disagreement).toEqual([]);
  });

  /*
  | SE-SCAN-13: چند استخراج‌گر روی *پسوند* شرط گذاشته بودند نه روی
  | languageId — مثلاً `languageId === 'htm'`. رجیستری هرگز 'htm' را
  | برنمی‌گرداند (پسوند .htm زبانِ 'html' است)، پس آن شاخه‌ها مرده بودند.
  */
  it('هیچ استخراج‌گری زبانی را ادعا نمی‌کند که رجیستری تولیدش نمی‌کند', async () => {
    const suspects = new Set<string>();
    for (const lang of ALL_LANGUAGES) {
      for (const ext of lang.extensions) {
        if (!EMITTABLE_IDS.has(ext)) suspects.add(ext);
      }
    }

    const bogus: string[] = [];
    for (const candidate of suspects) {
      if (await set.symbols.hasExtractorFor(candidate)) {
        bogus.push(candidate);
      }
    }
    expect(bogus).toEqual([]);
  });
});

describe('فاز ۲۲ — JSON با کامنت یک زبان مستقل است', () => {
  /*
  | SE-SCAN-12: فاز ۱۶ کامنت‌زدایی را «فقط برای jsonc/json5» کرد، ولی
  | رجیستری پسوند .jsonc را به idِ 'json' نگاشت می‌کرد. یعنی آن شرط
  | هرگز روی یک فایل واقعی true نمی‌شد و هر فایل JSONC صفر symbol
  | می‌داد — از جمله tsconfig.json خودِ همین پکیج.
  */
  it.each([
    ['config.jsonc', 'jsonc'],
    ['config.json5', 'json5'],
    ['tsconfig.json', 'jsonc'],
    ['jsconfig.json', 'jsonc'],
    ['.eslintrc.json', 'jsonc'],
    ['package.json', 'json'],
    ['data.json', 'json'],
  ])('%s → زبان %s', (file, expected) => {
    expect(registry.detect(`some/dir/${file}`)?.id).toBe(expected);
  });

  it('یک فایل jsonc واقعی symbol می‌دهد، نه خطای تجزیه', async () => {
    const extractor = new JsonSymbolExtractor();
    const source = ['{', '  // the port to bind', '  "port": 8080,', '  /* block */', '  "host": "0.0.0.0"', '}'].join('\n');

    const languageId = registry.detect('app/config.jsonc')!.id;
    const result = await extractor.extract('f1', 'app/config.jsonc', source, languageId);

    if (!result.ok) throw result.error;
    expect(result.value.warnings).toEqual([]);
    expect(result.value.symbols.map(s => s.name).sort()).toEqual(['host', 'port']);
  });

  it('کامنت در فایل .json ساده همچنان خطاست', async () => {
    const extractor = new JsonSymbolExtractor();
    const source = '{\n  // not allowed here\n  "a": 1\n}';

    const languageId = registry.detect('data.json')!.id;
    const result = await extractor.extract('f1', 'data.json', source, languageId);

    if (!result.ok) throw result.error;
    expect(result.value.symbols).toEqual([]);
    expect(result.value.warnings.join(' ')).toMatch(/parse error/i);
  });
});

describe('فاز ۲۲ — جدول در برابر بازگشت باگ محافظت می‌شود', () => {
  it('ساخت جدول با idِ تکراری در همان لحظهٔ بارگذاری می‌ترکد', () => {
    const { buildLanguageTable } = require('./languageMap') as {
      buildLanguageTable: (langs: readonly unknown[]) => unknown;
    };
    const dup = [
      { id: 'x', displayName: 'X', deepAnalysisSupported: true, extensions: ['x'] },
      { id: 'x', displayName: 'X again', deepAnalysisSupported: false, extensions: ['y'] },
    ];
    expect(() => buildLanguageTable(dup)).toThrow(/duplicate language id: x/i);
  });

  it('ساخت جدول با پسوند تکراری هم می‌ترکد', () => {
    const { buildLanguageTable } = require('./languageMap') as {
      buildLanguageTable: (langs: readonly unknown[]) => unknown;
    };
    const dup = [
      { id: 'a', displayName: 'A', deepAnalysisSupported: true, extensions: ['q'] },
      { id: 'b', displayName: 'B', deepAnalysisSupported: false, extensions: ['q'] },
    ];
    expect(() => buildLanguageTable(dup)).toThrow(/extension "q"/i);
  });
});
