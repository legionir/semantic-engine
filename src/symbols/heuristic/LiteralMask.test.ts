/**
 * پوشاندن رشته و کامنت پیش از اجرای regex — SE-SYM-20.
 *
 * هیچ‌کدام از استخراج‌گرهای heuristic کامنت‌ها و رشته‌ها را کنار
 * نمی‌گذاشتند. نتیجه‌اش تعریف‌های خیالی است: یک نمونهٔ کد داخل کامنت،
 * یا یک فراخوانی داخل رشته، مثل تعریف تابع دیده می‌شود.
 *
 * نکتهٔ کلیدی: پوشاندن باید **طول را حفظ کند**. هر استخراج‌گر از
 * `match.index` برای پیدا کردن شماره خط استفاده می‌کند، پس اگر پوشاندن
 * متن را کوتاه کند، هر شماره خطی بعد از آن غلط می‌شود.
 */

import { maskLiteralsAndComments, isKeywordCallSite } from './LiteralMask';

describe('maskLiteralsAndComments', () => {

  const mask = (source: string, language = 'typescript') =>
    maskLiteralsAndComments(source, language);

  it('keeps the length exactly, so every index stays valid', () => {
    const source = `const s = "hello";\n// a comment\nfunction f() {}\n`;

    expect(mask(source)).toHaveLength(source.length);
  });

  it('keeps every newline, so line numbers stay valid', () => {
    const source = `/* one\n   two\n   three */\nfunction f() {}\n`;
    const masked = mask(source);

    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
    expect(masked.indexOf('function')).toBe(source.indexOf('function'));
  });

  it('blanks the inside of a double-quoted string', () => {
    const inner = 'function fake() {}';

    expect(mask(`const s = "${inner}";`))
      .toBe(`const s = "${' '.repeat(inner.length)}";`);
  });

  it('blanks single quotes and backticks too', () => {
    expect(mask("const s = 'abc';")).toBe("const s = '   ';");
    expect(mask('const s = `abc`;')).toBe('const s = `   `;');
  });

  it('respects an escaped quote', () => {
    // محتوای رشته `a\"b` است — چهار کاراکتر، و نقل‌قول escape شده
    // نباید رشته را ببندد.
    const source = 'const s = "a\\"b";';

    expect(mask(source)).toHaveLength(source.length);
    expect(mask(source)).toBe(`const s = "${' '.repeat(4)}";`);
  });

  it('blanks a line comment but keeps the code before it', () => {
    expect(mask('let x = 1; // function fake() {}'))
      .toBe('let x = 1; ' + ' '.repeat('// function fake() {}'.length));
  });

  it('blanks a block comment across lines', () => {
    const masked = mask('a();\n/* function fake() {}\n   more */\nb();');

    expect(masked).toContain('a();');
    expect(masked).toContain('b();');
    expect(masked).not.toContain('fake');
  });

  it('does not treat a hash as a comment in C-like languages mid-line', () => {
    expect(mask('int a = 1; # not a comment here', 'c')).toContain('#');
  });

  it('blanks a hash comment in python', () => {
    expect(mask('x = 1  # def fake():', 'python')).not.toContain('fake');
  });

  it('blanks a hash comment in shell and ruby', () => {
    expect(mask('x=1 # def fake', 'shellscript')).not.toContain('fake');
    expect(mask('x = 1 # def fake', 'ruby')).not.toContain('fake');
  });

  it('leaves a shebang line alone in content but blanks it as a comment', () => {
    const masked = mask('#!/usr/bin/env python\ndef real():\n    pass\n', 'python');

    expect(masked).toContain('def real');
    expect(masked).not.toContain('usr/bin');
  });

  it('does not start a string on an apostrophe inside a comment', () => {
    const masked = mask("// don't stop here\nfunction real() {}\n");

    expect(masked).toContain('function real');
  });

  /*
  | این همان چیزی است که SE-SYM-20 توصیف می‌کند: نمونهٔ کدی که داخل
  | یک کامنت نوشته شده، نباید symbol تولید کند.
  */
  it('hides a function definition that lives inside a comment', () => {
    const masked = mask(`// function commented() {}\nfunction real() {}\n`);

    expect(masked).not.toContain('commented');
    expect(masked).toContain('real');
  });

  it('hides a function definition that lives inside a string', () => {
    const masked = mask('const template = "function fake() {}";\n');

    expect(masked).not.toContain('fake');
  });

  it('leaves a python docstring blanked', () => {
    const masked = mask(`def real():\n    """def fake(): pass"""\n    return 1\n`, 'python');

    expect(masked).toContain('def real');
    expect(masked).not.toContain('fake');
  });
});

describe('isKeywordCallSite', () => {

  /*
  | SE-SYM-20، مثال خودِ ارزیابی: الگوی C روی `return foo(x);` می‌افتد
  | و `foo` را تعریف تابع ثبت می‌کند. آنچه لو می‌دهد، کلمهٔ پیش از نام
  | است.
  */
  it('recognises a call after return as not a definition', () => {
    expect(isKeywordCallSite('    return foo(x);', 'foo')).toBe(true);
  });

  it.each(['if', 'while', 'for', 'switch', 'else', 'do', 'case', 'goto', 'sizeof'])(
    'recognises a call after %s as not a definition',
    keyword => {
      expect(isKeywordCallSite(`    ${keyword} foo(x);`, 'foo')).toBe(true);
    }
  );

  it('accepts a real definition', () => {
    expect(isKeywordCallSite('int compute(int x) {', 'compute')).toBe(false);
    expect(isKeywordCallSite('static void run(void) {', 'run')).toBe(false);
  });

  it('accepts a definition whose type is a user type', () => {
    expect(isKeywordCallSite('struct Token *next(struct Token *t) {', 'next')).toBe(false);
  });

  /*
  | `for` در `impl Trait for Type` نحو Rust است، نه کنترل جریان. تنها
  | چیزی که واقعاً فراخوانی را مشخص می‌کند، `(` بلافاصله بعد از نام
  | است. این را روی fixture گرفتیم — نوع `Echo` از ایندکس ناپدید شده
  | بود.
  */
  it('does not reject a rust impl block because of the word for', () => {
    expect(isKeywordCallSite('impl Handler for Echo {', 'Echo')).toBe(false);
  });

  it('does not reject a name that is not followed by a paren', () => {
    expect(isKeywordCallSite('return someValue;', 'someValue')).toBe(false);
    expect(isKeywordCallSite('for item in items {', 'items')).toBe(false);
  });

  it('treats the control keyword itself as a call site', () => {
    expect(isKeywordCallSite('    for (int i = 0; i < 3; i++) {', 'for')).toBe(true);
    expect(isKeywordCallSite('    if (x) {', 'if')).toBe(true);
  });
});

/**
 * فاز ۲۳ — نشانهٔ کامنت از جدول زبان‌ها می‌آید.
 *
 * SE-SYM-33: این فایل `//` را در *هر* زبانی کامنت می‌گرفت.
 * SE-SCAN-16: و مجموعهٔ خودش را از «کجا `#` کامنت است» داشت، که با
 * جدول دوم در `FileProcessor` نمی‌خواند.
 */
describe('فاز ۲۳ — پوشاندن زبان‌آگاه', () => {
  it('`//` در Python تقسیم صحیح است، نه کامنت', () => {
    expect(maskLiteralsAndComments('x = a // b or c', 'python')).toBe('x = a // b or c');
    expect(maskLiteralsAndComments('n = 7 // 2', 'python')).toBe('n = 7 // 2');
  });

  it('`//` در Ruby هم کامنت نیست', () => {
    expect(maskLiteralsAndComments('x = a / b', 'ruby')).toBe('x = a / b');
  });

  it('`#` در PHP کامنت است — هیچ‌کدام از دو جدول قبلی این را نداشت', () => {
    expect(maskLiteralsAndComments('$x = 1; # note', 'php')).toBe('$x = 1;       ');
    expect(maskLiteralsAndComments('$x = 1; // note', 'php')).toBe('$x = 1;        ');
  });

  it('`#` در C دستور پیش‌پردازنده است، نه کامنت', () => {
    expect(maskLiteralsAndComments('#include <stdio.h>', 'c')).toBe('#include <stdio.h>');
  });

  it('کامنت خانوادهٔ C دست‌نخورده کار می‌کند', () => {
    expect(maskLiteralsAndComments('const x = 1; // note', 'typescript')).toBe(
      'const x = 1;        '
    );
    expect(maskLiteralsAndComments('a /* b */ c', 'typescript')).toBe('a         c');
  });

  it('HTML کامنت خانوادهٔ C ندارد', () => {
    expect(maskLiteralsAndComments('<b>a // b</b>', 'html')).toBe('<b>a // b</b>');
    expect(maskLiteralsAndComments('<!-- x -->y', 'html')).toBe('          y');
  });

  it('در همهٔ حالت‌ها طول حفظ می‌شود', () => {
    for (const [source, language] of [
      ['x = a // b or c', 'python'],
      ['$x = 1; # note', 'php'],
      ['<!-- x -->y', 'html'],
      ['a /* b */ c', 'typescript'],
      ['-- note', 'sql'],
    ] as const) {
      expect(maskLiteralsAndComments(source, language)).toHaveLength(source.length);
    }
  });
});

/**
 * SE-SCAN-16 — یک جدول، نه دو تا.
 */
describe('فاز ۲۳ — نشانهٔ کامنت فقط یک منبع دارد', () => {
  it('هر زبان جدول یک CommentSyntax حل‌شده دارد', () => {
    const { ALL_LANGUAGES, commentSyntaxFor } = require('../../language/languageMap');
    for (const language of ALL_LANGUAGES) {
      expect(language.comments).toBeDefined();
      expect(Array.isArray(language.comments.line)).toBe(true);
      expect(commentSyntaxFor(language.id)).toBe(language.comments);
    }
  });

  it('زبان ناشناخته به خانوادهٔ C برمی‌گردد', () => {
    const { commentSyntaxFor } = require('../../language/languageMap');
    expect(commentSyntaxFor('brand-new-lang').line).toEqual(['//']);
    expect(commentSyntaxFor(null).line).toEqual(['//']);
  });
});
