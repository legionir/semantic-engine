/**
 * هویت symbol — SE-SYM-18، SE-DATA-05، SE-DATA-06.
 *
 * سه مشکل جدا که همه به یک جا برمی‌گردند: هیچ‌کس مالک «شناسهٔ symbol»
 * نبود و هر mapper قاعدهٔ خودش را داشت.
 *
 *   SE-SYM-18 — کلید فقط `مسیر + نام + نوع` بود و استخراج‌گرهای
 *   heuristic روی تصادم `continue` می‌کردند. یعنی overloadهای Java و
 *   C++، متدهای هم‌نام در دو کلاسِ یک فایل، و توابع هم‌نام در دو
 *   ماژول Python **بی‌صدا حذف می‌شدند**.
 *
 *   SE-DATA-06 — mapperهای LSP و tree-sitter در تصادم پسوند
 *   `:L{line}C{col}` می‌زدند. افزودن یک خط خالی در ابتدای فایل، شناسهٔ
 *   هر symbol هم‌نامی را عوض می‌کرد و diff ایندکس را منفجر می‌کرد.
 *
 *   SE-DATA-05 — سرآمد `SymbolIdGenerator` می‌گفت rename فایل شناسه را
 *   حفظ می‌کند، ولی هر دو mapper مسیر را داخل FQN می‌گذاشتند.
 */

import { SymbolIdAllocator, buildFullyQualifiedName } from './SymbolIdentity';

describe('buildFullyQualifiedName', () => {

  it('roots a top-level symbol at its file', () => {
    expect(buildFullyQualifiedName('src/a.ts', null, 'parse')).toBe('src/a.ts::parse');
  });

  it('nests a child under its parent', () => {
    expect(buildFullyQualifiedName('src/a.ts', 'src/a.ts::Cache', 'get'))
      .toBe('src/a.ts::Cache.get');
  });

  it('nests deeply', () => {
    const outer = buildFullyQualifiedName('a.ts', null, 'A');
    const middle = buildFullyQualifiedName('a.ts', outer, 'B');

    expect(buildFullyQualifiedName('a.ts', middle, 'c')).toBe('a.ts::A.B.c');
  });
});

describe('SymbolIdAllocator', () => {

  const request = (name: string, kind = 'function', parentFqName: string | null = null) =>
    ({ filePath: 'src/a.ts', parentFqName, name, kind });

  it('gives a symbol a stable id', () => {
    const first = new SymbolIdAllocator().allocate(request('parse'));
    const second = new SymbolIdAllocator().allocate(request('parse'));

    expect(first.id).toBe(second.id);
    expect(first.ordinal).toBe(0);
  });

  it('gives different names different ids', () => {
    const allocator = new SymbolIdAllocator();

    expect(allocator.allocate(request('a')).id).not.toBe(allocator.allocate(request('b')).id);
  });

  it('gives the same name in different kinds different ids', () => {
    const allocator = new SymbolIdAllocator();

    expect(allocator.allocate(request('X', 'class')).id)
      .not.toBe(allocator.allocate(request('X', 'interface')).id);
  });

  /*
  | معیار پذیرش ۱ — دو overload هم‌نام باید دو symbol بدهند. پیش از
  | این، دومی بی‌صدا دور ریخته می‌شد.
  */
  it('keeps every overload instead of dropping the later ones', () => {
    const allocator = new SymbolIdAllocator();

    const first = allocator.allocate(request('parse'));
    const second = allocator.allocate(request('parse'));
    const third = allocator.allocate(request('parse'));

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect([first.ordinal, second.ordinal, third.ordinal]).toEqual([0, 1, 2]);
  });

  it('separates same-named methods of two classes in one file', () => {
    const allocator = new SymbolIdAllocator();
    const a = buildFullyQualifiedName('src/a.ts', null, 'A');
    const b = buildFullyQualifiedName('src/a.ts', null, 'B');

    const first = allocator.allocate(request('run', 'method', a));
    const second = allocator.allocate(request('run', 'method', b));

    expect(first.id).not.toBe(second.id);
    // نه به‌خاطر شمارنده، بلکه چون واقعاً دو نام کامل متفاوت‌اند
    expect(first.ordinal).toBe(0);
    expect(second.ordinal).toBe(0);
  });

  /*
  | معیار پذیرش ۲ — شناسه نباید به شماره خط وابسته باشد. چون شمارنده
  | ترتیبی است و نه مکانی، جابه‌جا شدن کل فایل هیچ اثری ندارد.
  */
  it('does not change when the file shifts down', () => {
    const before = new SymbolIdAllocator();
    const after = new SymbolIdAllocator();

    // همان ترتیب، صرف‌نظر از اینکه در فایل کجا نشسته‌اند
    const beforeIds = ['a', 'parse', 'parse', 'z'].map(n => before.allocate(request(n)).id);
    const afterIds = ['a', 'parse', 'parse', 'z'].map(n => after.allocate(request(n)).id);

    expect(afterIds).toEqual(beforeIds);
  });

  it('has no line or column anywhere in its input', () => {
    const allocator = new SymbolIdAllocator();
    const { fullyQualifiedName } = allocator.allocate(request('parse'));
    allocator.allocate(request('parse'));

    expect(fullyQualifiedName).not.toMatch(/:L\d+|C\d+/);
    expect(allocator.allocate(request('parse')).fullyQualifiedName).not.toMatch(/:L\d+/);
  });

  it('keeps the plain name for the first of a group', () => {
    const allocator = new SymbolIdAllocator();

    expect(allocator.allocate(request('parse')).fullyQualifiedName).toBe('src/a.ts::parse');
  });

  it('marks later members of a group in the qualified name', () => {
    const allocator = new SymbolIdAllocator();
    allocator.allocate(request('parse'));

    expect(allocator.allocate(request('parse')).fullyQualifiedName)
      .toBe('src/a.ts::parse#1');
  });

  /*
  | SE-DATA-05 — تصمیم صریح: مسیر فایل *بخشی از هویت* است. سرآمد
  | قدیمی خلافش را ادعا می‌کرد؛ آن ادعا هرگز پیاده نشده بود و اگر
  | می‌شد، هر دو فایلِ دارای تابع `parse` یک symbol می‌شدند.
  */
  it('treats the same name in two files as two symbols', () => {
    const allocator = new SymbolIdAllocator();

    const inA = allocator.allocate({ filePath: 'src/a.ts', parentFqName: null, name: 'parse', kind: 'function' });
    const inB = allocator.allocate({ filePath: 'src/b.ts', parentFqName: null, name: 'parse', kind: 'function' });

    expect(inA.id).not.toBe(inB.id);
    expect(inA.ordinal).toBe(0);
    expect(inB.ordinal).toBe(0);
  });

  it('produces a short hex id', () => {
    expect(new SymbolIdAllocator().allocate(request('parse')).id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('starts fresh when reset', () => {
    const allocator = new SymbolIdAllocator();
    const first = allocator.allocate(request('parse')).id;
    allocator.reset();

    expect(allocator.allocate(request('parse')).id).toBe(first);
  });
});
