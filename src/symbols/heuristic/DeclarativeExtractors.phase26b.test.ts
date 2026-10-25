/**
 * فاز ۲۶ب — پاک‌سازی استخراج‌گرهای اعلانی (SE-SYM-30).
 *
 * هر دو استخراج‌گر اعلانی dedupe بر پایهٔ `نام + نوع` داشتند و از
 * `SymbolIdAllocator` استفاده نمی‌کردند. دو پیامد:
 *
 *   ۱. `extractPrimarySelector` از `.panel > h2` مقدار `.panel` را
 *      برمی‌گرداند، که با قاعدهٔ `.panel` واقعی تصادم می‌کند و بی‌صدا
 *      حذف می‌شود.
 *   ۲. یک selector که در سه جای فایل بیاید، فقط یک symbol با یک بازه
 *      دارد — دو جای دیگر ناپدید می‌شوند.
 *
 * اندازه‌گیری پیش از اصلاح، روی یک فایل با چهار قاعده: **یک symbol**.
 */

import { CssSymbolExtractor } from './CssSymbolExtractor';
import { HtmlSymbolExtractor } from './HtmlSymbolExtractor';
import { SymbolEntry } from '../../core/types/project-index.types';

async function css(source: string): Promise<SymbolEntry[]> {
  const result = await new CssSymbolExtractor().extract('f1', 'a.css', source, 'css');
  if (!result.ok) throw result.error;
  return [...result.value.symbols];
}

async function html(source: string): Promise<SymbolEntry[]> {
  const result = await new HtmlSymbolExtractor().extract('f1', 'a.html', source, 'html');
  if (!result.ok) throw result.error;
  return [...result.value.symbols];
}

/** فقط قاعده‌ها (selector) — at-ruleها `module` اند. */
function rules(symbols: readonly SymbolEntry[]): { name: string; line: number; endLine: number }[] {
  return symbols
    .filter(symbol => symbol.kind === 'property')
    .map(symbol => ({ name: symbol.name, line: symbol.line, endLine: symbol.endLine }));
}

describe('SE-SYM-30 — selector مرکب به کلاس اولش فرو نمی‌ریزد', () => {
  it('`.panel > h2` و `.panel` دو symbol جدا با دو بازه‌اند', async () => {
    const symbols = await css(
      [
        '.panel {',      // 1
        '  color: red;', // 2
        '}',             // 3
        '',              // 4
        '.panel > h2 {', // 5
        '  font-size: 2rem;',
        '}',             // 7
        '',
      ].join('\n')
    );

    expect(rules(symbols)).toEqual([
      { name: '.panel', line: 1, endLine: 3 },
      { name: '.panel > h2', line: 5, endLine: 7 },
    ]);
  });

  it('selector نزولی هم کامل می‌ماند', async () => {
    const symbols = await css('.panel .body {\n  margin: 0;\n}\n');
    expect(rules(symbols).map(r => r.name)).toEqual(['.panel .body']);
  });

  it('فاصلهٔ اضافی در selector نرمال می‌شود', async () => {
    const symbols = await css('.a    >     .b {\n  color: red;\n}\n');
    expect(rules(symbols).map(r => r.name)).toEqual(['.a > .b']);
  });

  it('هر قاعده در گروه کاما، symbol خودش را دارد', async () => {
    const symbols = await css('.a, .b > i {\n  color: red;\n}\n');
    expect(rules(symbols).map(r => r.name)).toEqual(['.a', '.b > i']);
  });
});

describe('SE-SYM-30 — selector تکرارشونده گم نمی‌شود', () => {
  /*
  | تصمیم طراحی، صریح: **هر قاعده یک symbol است**، نه یک symbol با
  | چند بازه.
  |
  | دلیل: یک قاعدهٔ CSS واحدی با مکان و اعلان‌های خودش است. مصرف‌کننده
  | که می‌پرسد «`.panel` کجا تعریف شده؟» جواب صادقانه «خط ۱ تا ۳ و
  | خط ۱۳ تا ۱۵» است. جایگزینش — یک symbol با آرایه‌ای از بازه‌ها —
  | نیازمند تغییر قرارداد است (`SymbolEntry` یک `line` و یک `endLine`
  | دارد) و همان اطلاعات را با هزینهٔ بیشتر می‌دهد.
  |
  | `SymbolIdAllocator` از فاز ۱۵ دقیقاً برای همین حالت ساخته شده:
  | عضو اول نام خالص را نگه می‌دارد و بقیه ordinal می‌گیرند، پس
  | شناسه‌های موجود بی‌دلیل باطل نمی‌شوند.
  */
  it('سه قاعده برای `.panel` سه symbol با سه بازه‌اند', async () => {
    const symbols = await css(
      [
        '.panel {',           // 1
        '  color: red;',
        '}',                  // 3
        '',
        '.panel {',           // 5
        '  border: 1px;',
        '}',                  // 7
        '',
        '.panel {',           // 9
        '  margin: 0;',
        '}',                  // 11
        '',
      ].join('\n')
    );

    expect(rules(symbols)).toEqual([
      { name: '.panel', line: 1, endLine: 3 },
      { name: '.panel', line: 5, endLine: 7 },
      { name: '.panel', line: 9, endLine: 11 },
    ]);
  });

  it('شناسه‌ها یکتا می‌مانند و اولی نام خالص را نگه می‌دارد', async () => {
    const symbols = await css('.panel {\n  color: red;\n}\n.panel {\n  border: 0;\n}\n');
    const ids = symbols.map(s => s.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(symbols[0]!.fullyQualifiedName).toBe('a.css::.panel');
    expect(symbols[1]!.fullyQualifiedName).toBe('a.css::.panel#1');
  });

  it('پروندهٔ چهار قاعده‌ای که باگ را نشان می‌داد', async () => {
    const symbols = await css(
      [
        '.panel {',        // 1
        '  color: red;',
        '}',               // 3
        '',
        '.panel > h2 {',   // 5
        '  font-size: 2rem;',
        '}',               // 7
        '',
        '.panel .body {',  // 9
        '  margin: 0;',
        '}',               // 11
        '',
        '.panel {',        // 13
        '  border: 1px solid;',
        '}',               // 15
        '',
      ].join('\n')
    );

    // قبل از اصلاح: ۱ symbol
    expect(rules(symbols)).toEqual([
      { name: '.panel', line: 1, endLine: 3 },
      { name: '.panel > h2', line: 5, endLine: 7 },
      { name: '.panel .body', line: 9, endLine: 11 },
      { name: '.panel', line: 13, endLine: 15 },
    ]);
  });
});

describe('SE-SYM-30 — همان قاعده برای HTML', () => {
  it('هر بار که یک class ظاهر می‌شود، مکان خودش را دارد', async () => {
    const symbols = await html(
      [
        '<div class="a">',      // 1
        '  <span id="x">one</span>',
        '</div>',
        '<div class="a">',      // 4
        '  <span id="y">two</span>',
        '</div>',
        '',
      ].join('\n')
    );

    /*
    | `id` هم از فاز ۱۶ به بعد `property` است (SE-SYM-24)، پس فقط
    | نامِ class فیلتر می‌شود.
    */
    const classes = symbols
      .filter(s => s.kind === 'property' && s.name === 'a')
      .map(s => ({ name: s.name, line: s.line }));

    expect(classes).toEqual([
      { name: 'a', line: 1 },
      { name: 'a', line: 4 },
    ]);
  });

  it('شناسه‌های HTML هم یکتا می‌مانند', async () => {
    const symbols = await html('<div class="a"></div>\n<div class="a"></div>\n');
    const ids = symbols.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('چند class روی یک تگ، همه ثبت می‌شوند', async () => {
    const symbols = await html('<div class="card wide">x</div>\n');
    const names = symbols.filter(s => s.kind === 'property').map(s => s.name);
    expect(names).toEqual(['card', 'wide']);
  });
});

describe('SE-SYM-30 — at-rule دو بار ثبت نمی‌شود', () => {
  /*
  | رگرسیونی که خودِ همین فاز ساخت و probe روی fixture گرفتش:
  | `extractPrimarySelector` برای `@media (max-width: 600px)` مقدار
  | null می‌داد و اتفاقاً ردش می‌کرد. با برداشتن نام کاملِ selector،
  | همان مقدمه یک بار دیگر — این‌بار به‌عنوان `property` — ثبت شد.
  */
  it('مقدمهٔ @media به‌عنوان selector شمرده نمی‌شود', async () => {
    const symbols = await css(
      [
        '@media (max-width: 600px) {',  // 1
        '  .panel {',                   // 2
        '    color: red;',
        '  }',                          // 4
        '}',                            // 5
        '',
      ].join('\n')
    );

    expect(symbols.filter(s => s.kind === 'module').map(s => s.name)).toEqual(['@media']);
    expect(rules(symbols).map(r => r.name)).toEqual(['.panel']);
  });

  it('@keyframes هم همین‌طور', async () => {
    const symbols = await css('@keyframes spin {\n  from { opacity: 0; }\n}\n');
    expect(rules(symbols).map(r => r.name)).not.toContain('@keyframes spin');
  });
});
