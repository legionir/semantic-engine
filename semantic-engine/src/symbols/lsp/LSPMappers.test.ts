/**
 * نگاشت symbolهای LSP به schema.
 *
 * سه چیز اینجا آزموده می‌شود که هر سه در ارزیابی به‌عنوان نقص ثبت شده
 * بودند:
 *   - شماره‌گذاری `SymbolKind` (LSP یک‌مبنا، VS Code صفرمبنا)
 *   - `smartSplitByComma` روی امضاهای واقعی TypeScript — SE-SYM-04
 *   - `inferVisibility` که قاعدهٔ زیرخط را به همهٔ زبان‌ها تحمیل می‌کرد
 *     — SE-SYM-08
 */

import {
  flattenDocumentSymbols,
  smartSplitByComma,
  mapLspSymbolKind,
  mapVSCodeSymbolKind,
  inferVisibility,
} from './LSPMappers';
import { DocumentSymbolLike, LspSymbolKind, VsCodeSymbolKind, SymbolTagLike } from '../types';

function symbol(
  name: string,
  kind: LspSymbolKind,
  line: number,
  detail?: string,
  children: DocumentSymbolLike[] = []
): DocumentSymbolLike {
  const range = { start: { line, character: 0 }, end: { line, character: 10 } };
  return { name, detail, kind, range, selectionRange: range, children };
}

const flatten = (
  symbols: DocumentSymbolLike[],
  filePath = 'src/foo.ts',
  language?: string
) => flattenDocumentSymbols(symbols, {
  fileId: 'file1',
  filePath,
  language,
  kindNumbering: 'lsp',
});

describe('kind mapping', () => {

  /*
  | همان ورودی عددی، دو معنی متفاوت. جدول قدیمی صفرمبنا بود و اگر به
  | یک زبان‌سرور واقعی وصل می‌شد، عدد ۵ را که «Class» است، «Method»
  | می‌خواند.
  */
  it('reads 5 as a class in LSP numbering and a method in VS Code numbering', () => {
    expect(mapLspSymbolKind(5)).toBe('class');
    expect(mapVSCodeSymbolKind(5)).toBe('method');
  });

  it.each([
    [LspSymbolKind.Class, 'class'],
    [LspSymbolKind.Interface, 'interface'],
    [LspSymbolKind.Enum, 'enum'],
    [LspSymbolKind.Struct, 'struct'],
    [LspSymbolKind.Function, 'function'],
    [LspSymbolKind.Method, 'method'],
    [LspSymbolKind.Constructor, 'method'],
    [LspSymbolKind.Variable, 'variable'],
    [LspSymbolKind.Constant, 'constant'],
    [LspSymbolKind.EnumMember, 'constant'],
    [LspSymbolKind.Namespace, 'namespace'],
    [LspSymbolKind.Module, 'module'],
    [LspSymbolKind.Package, 'module'],
    [LspSymbolKind.File, 'module'],
    [LspSymbolKind.Property, 'property'],
    [LspSymbolKind.Field, 'property'],
    [LspSymbolKind.Event, 'property'],
    [LspSymbolKind.Operator, 'function'],
    [LspSymbolKind.TypeParameter, 'type-alias'],
    [LspSymbolKind.Array, 'variable'],
    [LspSymbolKind.Object, 'variable'],
    [LspSymbolKind.Key, 'variable'],
    [LspSymbolKind.Null, 'variable'],
    [LspSymbolKind.Number, 'variable'],
    [LspSymbolKind.String, 'variable'],
    [LspSymbolKind.Boolean, 'variable'],
  ])('maps LSP kind %i to %s', (lspKind, expected) => {
    expect(mapLspSymbolKind(lspKind)).toBe(expected);
  });

  it('maps every VS Code kind through the conversion, never by raw number', () => {
    expect(mapVSCodeSymbolKind(VsCodeSymbolKind.Class)).toBe('class');
    expect(mapVSCodeSymbolKind(VsCodeSymbolKind.Method)).toBe('method');
    expect(mapVSCodeSymbolKind(VsCodeSymbolKind.TypeParameter)).toBe('type-alias');
  });

  it('refuses a number that is not a kind at all', () => {
    expect(() => mapLspSymbolKind(0)).toThrow(RangeError);
    expect(() => mapLspSymbolKind(99)).toThrow(RangeError);
  });

  it('honours the numbering declared by the caller when flattening', () => {
    const asLsp = flattenDocumentSymbols([symbol('X', LspSymbolKind.Class, 1)], {
      fileId: 'f', filePath: 'a.ts', kindNumbering: 'lsp',
    });
    const asVsCode = flattenDocumentSymbols([symbol('X', 5 as LspSymbolKind, 1)], {
      fileId: 'f', filePath: 'a.ts', kindNumbering: 'vscode',
    });

    expect(asLsp[0].kind).toBe('class');
    expect(asVsCode[0].kind).toBe('method');
  });
});

describe('flattenDocumentSymbols', () => {

  it('flattens a hierarchy and keeps parentId', () => {
    const parent = symbol('MyClass', LspSymbolKind.Class, 1, undefined, [
      symbol('method1', LspSymbolKind.Method, 2, '(): void'),
      symbol('method2', LspSymbolKind.Method, 3, '(): void'),
    ]);

    const result = flatten([parent], 'src/MyClass.ts');

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('MyClass');
    expect(result[0].parentId).toBeNull();
    expect(result[1].parentId).toBe(result[0].id);
    expect(result[2].parentId).toBe(result[0].id);
  });

  it('gives colliding symbols distinct but stable ids', () => {
    const symbols = [
      symbol('foo', LspSymbolKind.Function, 1, '(): void'),
      symbol('foo', LspSymbolKind.Function, 5, '(): number'),
    ];

    const first = flatten(symbols);
    const again = flatten(symbols);

    expect(first[0].id).not.toBe(first[1].id);
    expect(again.map(s => s.id)).toEqual(first.map(s => s.id));
  });

  it('produces no duplicate ids however deep the nesting', () => {
    const outer = symbol('outer', LspSymbolKind.Class, 1, undefined, [
      symbol('middle', LspSymbolKind.Class, 2, undefined, [
        symbol('inner', LspSymbolKind.Method, 3),
      ]),
    ]);

    const ids = flatten([outer]).map(s => s.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('converts 0-based LSP lines to the 1-based lines of the schema', () => {
    const result = flatten([symbol('f', LspSymbolKind.Function, 41)]);

    expect(result[0].line).toBe(42);
  });

  it('reads the deprecated tag', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const tagged: DocumentSymbolLike = {
      name: 'old', kind: LspSymbolKind.Function, range, selectionRange: range,
      tags: [SymbolTagLike.Deprecated],
    };

    expect(flatten([tagged])[0].deprecated).toBe(true);
  });

  /*
  | SE-SYM-09 — `detail` مستندسازی نیست؛ همان چیزی است که `signature`
  | از آن ساخته می‌شود. گذاشتنش در `documentation` فقط داده را دو بار
  | ذخیره می‌کند و خواننده را فریب می‌دهد.
  */
  it('does not pass detail off as documentation', () => {
    const result = flatten([symbol('greet', LspSymbolKind.Function, 1, '(name: string): void')]);

    expect(result[0].signature).toContain('(name: string): void');
    expect(result[0].documentation).toBeNull();
  });

  /*
  | SE-SYM-06 — `computeLSPConfidence` همیشه با `hasHover=false` صدا
  | زده می‌شد، پس آن شاخه کد مرده بود. حالا امتیاز فقط از چیزهایی
  | می‌آید که واقعاً در دست است.
  */
  it('scores confidence from what is actually present', () => {
    const withDetail = flatten([symbol('a', LspSymbolKind.Function, 1, '(): void')])[0];
    const withoutDetail = flatten([symbol('b', LspSymbolKind.Function, 1)])[0];

    expect(withDetail.confidence as number).toBeGreaterThan(withoutDetail.confidence as number);
    expect(withDetail.confidence as number).toBeLessThanOrEqual(98);
    expect(withoutDetail.confidence as number).toBeGreaterThanOrEqual(50);
  });

  it('marks the source as lsp', () => {
    expect(flatten([symbol('a', LspSymbolKind.Function, 1)])[0].source).toBe('lsp');
  });
});

describe('smartSplitByComma', () => {

  it('splits simple parameters', () => {
    expect(smartSplitByComma('a, b, c')).toEqual(['a', 'b', 'c']);
  });

  it('does not split inside generics', () => {
    expect(smartSplitByComma('map: Map<string, number>, items: string[]')).toEqual([
      'map: Map<string, number>',
      'items: string[]',
    ]);
  });

  it('does not split inside destructuring', () => {
    expect(smartSplitByComma('{ a, b }: { a: number, b: string }, c: string')).toEqual([
      '{ a, b }: { a: number, b: string }',
      'c: string',
    ]);
  });

  /*
  | SE-SYM-04، بازتولیدشدهٔ دقیق. کاراکتر `>` همیشه «بستن» شمرده
  | می‌شد، پس `=>` عمق را منفی می‌کرد و کاماها دیگر جدا نمی‌شدند.
  | callback با نوع تابعی در TypeScript نادر نیست — قاعده است.
  */
  it('splits a signature that contains an arrow type', () => {
    expect(smartSplitByComma('cb: () => void, retries: number')).toEqual([
      'cb: () => void',
      'retries: number',
    ]);
  });

  it('handles several arrow types in one signature', () => {
    expect(smartSplitByComma('onOk: (v: string) => void, onErr: (e: Error) => void, tries: number'))
      .toEqual([
        'onOk: (v: string) => void',
        'onErr: (e: Error) => void',
        'tries: number',
      ]);
  });

  it('handles an arrow returning a generic', () => {
    expect(smartSplitByComma('load: () => Promise<Map<string, number>>, eager: boolean'))
      .toEqual(['load: () => Promise<Map<string, number>>', 'eager: boolean']);
  });

  it('handles a comparison-like sequence without going negative', () => {
    expect(smartSplitByComma('a: number, b: A extends B ? C : D')).toEqual([
      'a: number',
      'b: A extends B ? C : D',
    ]);
  });

  /*
  | یک مقدار پیش‌فرض رشته‌ای که خودش کاما دارد، بدون آگاهی از نقل‌قول
  | به دو پارامتر جعلی تبدیل می‌شود.
  */
  it('does not split inside a string literal', () => {
    expect(smartSplitByComma('sep: string = ", ", trim: boolean')).toEqual([
      'sep: string = ", "',
      'trim: boolean',
    ]);
  });

  it('does not split inside a single-quoted or backtick literal', () => {
    expect(smartSplitByComma("a: string = 'x,y', b: number")).toEqual(["a: string = 'x,y'", 'b: number']);
    expect(smartSplitByComma('a: string = `x,y`, b: number')).toEqual(['a: string = `x,y`', 'b: number']);
  });

  it('keeps an escaped quote from ending the literal', () => {
    expect(smartSplitByComma('a: string = "he said \\", ok", b: number')).toEqual([
      'a: string = "he said \\", ok"',
      'b: number',
    ]);
  });

  it('returns nothing for an empty input', () => {
    expect(smartSplitByComma('')).toEqual([]);
    expect(smartSplitByComma('   ')).toEqual([]);
  });

  it('never returns an empty fragment for a trailing comma', () => {
    expect(smartSplitByComma('a, b,')).toEqual(['a', 'b']);
  });
});

describe('parameters parsed from detail', () => {

  const paramsOf = (detail: string) =>
    flatten([symbol('fn', LspSymbolKind.Function, 1, detail)])[0].parameters ?? [];

  it('parses name and type', () => {
    const params = paramsOf('(map: Map<string, number>, items: string[]): void');

    expect(params).toHaveLength(2);
    expect(params[0]).toMatchObject({ name: 'map', type: 'Map<string, number>' });
    expect(params[1]).toMatchObject({ name: 'items', type: 'string[]' });
  });

  /*
  | همان باگ SE-SYM-04، این بار از دید مصرف‌کننده: قبلاً *یک* پارامتر
  | به نام `cb` با تایپ `() => void, retries: number` بیرون می‌آمد.
  */
  it('parses a callback parameter as its own parameter', () => {
    const params = paramsOf('(cb: () => void, retries: number): void');

    expect(params.map(p => p.name)).toEqual(['cb', 'retries']);
    expect(params[0].type).toBe('() => void');
    expect(params[1].type).toBe('number');
  });

  it('marks optional and rest parameters', () => {
    const params = paramsOf('(a: string, b?: number, ...rest: string[]): void');

    expect(params[1]).toMatchObject({ name: 'b', optional: true });
    expect(params[2]).toMatchObject({ name: 'rest', rest: true });
  });

  it('reads a default value', () => {
    const params = paramsOf('(retries: number = 3): void');

    expect(params[0]).toMatchObject({ name: 'retries', type: 'number', defaultValue: '3' });
  });

  it('finds no parameters where there are none', () => {
    expect(paramsOf('(): void')).toEqual([]);
  });
});

describe('inferVisibility', () => {

  it('treats a leading underscore as private in TypeScript and Python', () => {
    expect(inferVisibility('_helper', 'typescript')).toBe('private');
    expect(inferVisibility('_helper', 'python')).toBe('private');
  });

  it('treats a JS private field as private in any language', () => {
    expect(inferVisibility('#count', 'javascript')).toBe('private');
  });

  it('keeps Python dunder methods public', () => {
    expect(inferVisibility('__init__', 'python')).toBe('public');
    expect(inferVisibility('__mangled', 'python')).toBe('private');
  });

  /*
  | SE-SYM-08 — در Go قاعده بزرگی حرف اول است. زیرخط هیچ معنایی ندارد
  | و `_helper` در Go دقیقاً به‌اندازهٔ `helper` غیرصادراتی است؛ هر دو
  | package-private اند، نه private.
  */
  it('uses capitalisation, not underscores, for Go', () => {
    expect(inferVisibility('ServeHTTP', 'go')).toBe('public');
    expect(inferVisibility('serveHTTP', 'go')).toBe('internal');
    expect(inferVisibility('_helper', 'go')).toBe('internal');
  });

  /*
  | در Java و C# دسترسی با کلیدواژه اعلام می‌شود و از نام هیچ چیزی
  | برنمی‌آید. حدس زدن از روی زیرخط، داده‌ای می‌سازد که ساختگی است.
  */
  it('does not guess from the name in Java, C# or Kotlin', () => {
    for (const language of ['java', 'csharp', 'kotlin']) {
      expect(inferVisibility('_field', language)).toBe('public');
      expect(inferVisibility('field', language)).toBe('public');
    }
  });

  it('keeps the underscore convention when the language is unknown', () => {
    expect(inferVisibility('_x')).toBe('private');
    expect(inferVisibility('x')).toBe('public');
  });

  it('is picked up by the flattener from the file language', () => {
    const goSymbol = symbol('serveHTTP', LspSymbolKind.Method, 1);

    expect(flatten([goSymbol], 'src/server.go', 'go')[0].visibility).toBe('internal');
  });

  it('falls back to the file extension when no language is given', () => {
    const result = flattenDocumentSymbols([symbol('serveHTTP', LspSymbolKind.Method, 1)], {
      fileId: 'f',
      filePath: 'src/server.go',
      kindNumbering: 'lsp',
    });

    expect(result[0].visibility).toBe('internal');
  });
});
