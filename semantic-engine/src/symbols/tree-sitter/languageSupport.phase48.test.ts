/**
 * SE-SYM-16 و SE-GRAPH-08 — محدودیت‌ها در خروجی اعلام نمی‌شدند.
 *
 * SE-SYM-16: «Python/Go/Java/Rust همه در `getSymbolExtractionMethod`
 * پشتیبانی‌شده علامت خورده‌اند ولی مستقیم به regex سقوط می‌کنند.»
 *
 * SE-GRAPH-08: «`isTsJs` بقیهٔ زبان‌ها را رد می‌کند؛ برای
 * Python/Go/Java هیچ گراف فراخوانی وجود ندارد. این محدودیت در هیچ
 * خروجی یا مستندی اعلام نمی‌شود.»
 *
 * «چیزی پیدا نشد» و «این زبان را در این سطح نمی‌فهمم» دو چیزِ متفاوت
 * است. مصرف‌کننده‌ای که نتواند تفکیکشان کند، سکوت را به‌عنوان واقعیت
 * می‌خواند.
 */

import { describeLanguageSupport } from './languageSupport';

describe('describeLanguageSupport (SE-SYM-16 / SE-GRAPH-08)', () => {
  it('برای TS/JS همه چیز کامل است', () => {
    const support = describeLanguageSupport(['typescript', 'javascript']);

    expect(support.typescript).toEqual({ symbols: 'full', callGraph: true });
    expect(support.javascript).toEqual({ symbols: 'full', callGraph: true });
  });

  it('زبان‌های تازه، ساختاری‌اند و گراف فراخوانی ندارند', () => {
    const support = describeLanguageSupport(['python', 'go', 'java', 'rust']);

    for (const language of ['python', 'go', 'java', 'rust']) {
      expect({ language, ...support[language]! }).toEqual({
        language,
        symbols: 'structural',
        callGraph: false,
      });
    }
  });

  it('زبانِ بدون گرامر، heuristic اعلام می‌شود', () => {
    const support = describeLanguageSupport(['zig']);

    expect(support.zig).toEqual({ symbols: 'heuristic', callGraph: false });
  });

  it('AI-06 — Kotlin و Swift حالا گرامر دارند و structural اعلام می‌شوند', () => {
    const support = describeLanguageSupport(['kotlin', 'swift']);

    for (const language of ['kotlin', 'swift']) {
      expect({ language, ...support[language]! }).toEqual({
        language,
        symbols: 'structural',
        callGraph: false,
      });
    }
  });

  it('C#، PHP و Ruby ساختاری‌اند و گراف فراخوانی ندارند', () => {
    const support = describeLanguageSupport(['csharp', 'php', 'ruby']);

    for (const language of ['csharp', 'php', 'ruby']) {
      expect({ language, ...support[language]! }).toEqual({
        language,
        symbols: 'structural',
        callGraph: false,
      });
    }
  });

  it('فقط زبان‌هایی که واقعاً در پروژه‌اند گزارش می‌شوند', () => {
    const support = describeLanguageSupport(['python']);

    expect(Object.keys(support)).toEqual(['python']);
  });

  it('فهرست خالی، گزارش خالی', () => {
    expect(describeLanguageSupport([])).toEqual({});
  });

  it('زبان تکراری یک بار می‌آید', () => {
    expect(Object.keys(describeLanguageSupport(['python', 'python']))).toEqual(['python']);
  });

  it('خروجی مرتب است تا ایندکس دترمینیستیک بماند', () => {
    const keys = Object.keys(describeLanguageSupport(['rust', 'go', 'python']));

    expect(keys).toEqual([...keys].sort());
  });
});
