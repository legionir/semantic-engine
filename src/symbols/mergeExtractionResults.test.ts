/**
 * SE-SYM-01 — نتیجهٔ ناقصِ باکیفیت نباید دور ریخته شود.
 *
 * سناریوی واقعی‌ای که این را لازم می‌کند: زبان‌سرور سلسله‌مراتب و
 * پارامتر-پراپرتی سازنده را می‌دهد ولی `type X = …` را `class`
 * می‌نامد؛ tree-sitter `kind` را درست می‌گوید ولی بعضی اعضا را
 * نمی‌بیند. انتخاب یکی، در هر دو جهت داده از دست می‌دهد.
 */

import { SymbolEntry } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';
import { SymbolExtractionResult } from './ISymbolExtractor';
import { mergeExtractionResults } from './mergeExtractionResults';

function symbol(partial: Partial<SymbolEntry> & { id: string; name: string; line: number }): SymbolEntry {
  return {
    fileId: 'f1',
    parentId: null,
    kind: 'function',
    fullyQualifiedName: partial.name,
    signature: partial.name,
    visibility: 'public',
    endLine: partial.line,
    documentation: null,
    deprecated: false,
    exported: false,
    source: 'lsp',
    confidence: makeConfidence(90),
    async: false,
    generator: false,
    abstract: false,
    static: false,
    readonly: false,
    parameters: [],
    returnType: null,
    generics: [],
    extends: [],
    implements: [],
    complexity: null,
    referenceCount: null,
    calls: [],
    calledBy: [],
    ...partial,
  } as SymbolEntry;
}

function result(over: Partial<SymbolExtractionResult>): SymbolExtractionResult {
  return { symbols: [], source: 'lsp', partial: false, warnings: [], ...over };
}

describe('mergeExtractionResults', () => {
  it('یک نتیجه، همان نتیجه — بدون کپی', () => {
    const only = result({ symbols: [symbol({ id: 'a', name: 'A', line: 1 })] });
    const outcome = mergeExtractionResults([only]);
    expect(outcome.result).toBe(only);
    expect(outcome.stats).toEqual({ added: 0, skipped: 0 });
  });

  it('symbolهای غایب از نتیجهٔ پایین‌دستی اضافه می‌شوند', () => {
    const outcome = mergeExtractionResults([
      result({
        source: 'lsp',
        partial: true,
        symbols: [symbol({ id: 'l1', name: 'Kept', line: 3 })],
      }),
      result({
        source: 'tree-sitter',
        symbols: [
          symbol({ id: 't1', name: 'Kept', line: 3, source: 'tree-sitter' }),
          symbol({ id: 't2', name: 'OnlyInTreeSitter', line: 9, source: 'tree-sitter' }),
        ],
      }),
    ]);

    expect(outcome.result.symbols.map(s => s.name)).toEqual(['Kept', 'OnlyInTreeSitter']);
    expect(outcome.stats).toEqual({ added: 1, skipped: 1 });
  });

  it('نسخهٔ اولویت‌بالاتر برنده است، حتی اگر kind فرق کند', () => {
    /*
    | همان اختلاف واقعی: زبان‌سرور `type Alias = string` را `class`
    | می‌نامد. تطبیق روی `name@line` است، نه روی kind — وگرنه هر دو
    | نسخه وارد ایندکس می‌شوند و یک اعلان دو symbol می‌شود.
    */
    const outcome = mergeExtractionResults([
      result({ symbols: [symbol({ id: 'l1', name: 'Alias', line: 5, kind: 'type-alias' })] }),
      result({
        source: 'tree-sitter',
        symbols: [symbol({ id: 't1', name: 'Alias', line: 5, kind: 'class', source: 'tree-sitter' })],
      }),
    ]);

    expect(outcome.result.symbols).toHaveLength(1);
    expect(outcome.result.symbols[0].kind).toBe('type-alias');
    expect(outcome.result.symbols[0].source).toBe('lsp');
  });

  it('هر symbol منبع خودش را نگه می‌دارد', () => {
    const outcome = mergeExtractionResults([
      result({ symbols: [symbol({ id: 'l1', name: 'FromLsp', line: 1 })] }),
      result({
        source: 'tree-sitter',
        symbols: [symbol({ id: 't1', name: 'FromTs', line: 2, source: 'tree-sitter' })],
      }),
    ]);

    expect(outcome.result.symbols.map(s => [s.name, s.source])).toEqual([
      ['FromLsp', 'lsp'],
      ['FromTs', 'tree-sitter'],
    ]);
  });

  it('parentId به id پایه بازنگاشت می‌شود', () => {
    const outcome = mergeExtractionResults([
      result({
        symbols: [symbol({ id: 'lsp-class', name: 'Klass', line: 1, kind: 'class' })],
      }),
      result({
        source: 'tree-sitter',
        symbols: [
          symbol({ id: 'ts-class', name: 'Klass', line: 1, kind: 'class', source: 'tree-sitter' }),
          symbol({
            id: 'ts-method',
            name: 'onlyHere',
            line: 2,
            kind: 'method',
            parentId: 'ts-class',
            source: 'tree-sitter',
          }),
        ],
      }),
    ]);

    const method = outcome.result.symbols.find(s => s.name === 'onlyHere')!;
    expect(method.parentId).toBe('lsp-class');
  });

  it('والد ناپیدا به null می‌رود، نه به یک id آویزان', () => {
    const outcome = mergeExtractionResults([
      result({ symbols: [] }),
      result({
        source: 'tree-sitter',
        symbols: [
          symbol({
            id: 'ts-method',
            name: 'orphan',
            line: 2,
            parentId: 'a-parent-that-was-never-emitted',
            source: 'tree-sitter',
          }),
        ],
      }),
    ]);

    expect(outcome.result.symbols[0].parentId).toBeNull();
  });

  it('id تکراری بین دو استخراج‌گر، دوبار وارد نمی‌شود', () => {
    const outcome = mergeExtractionResults([
      result({ symbols: [symbol({ id: 'same', name: 'A', line: 1 })] }),
      result({
        source: 'tree-sitter',
        symbols: [symbol({ id: 'same', name: 'B', line: 2, source: 'tree-sitter' })],
      }),
    ]);

    expect(outcome.result.symbols.map(s => s.id)).toEqual(['same']);
    expect(outcome.stats.skipped).toBe(1);
  });

  it('ناقص فقط وقتی همه ناقص باشند', () => {
    const bothPartial = mergeExtractionResults([
      result({ partial: true }),
      result({ source: 'tree-sitter', partial: true }),
    ]);
    expect(bothPartial.result.partial).toBe(true);

    const oneFull = mergeExtractionResults([
      result({ partial: true }),
      result({ source: 'tree-sitter', partial: false }),
    ]);
    expect(oneFull.result.partial).toBe(false);
  });

  it('برچسب source به اولین نتیجه‌ای می‌رسد که واقعاً چیزی داده', () => {
    const outcome = mergeExtractionResults([
      result({ source: 'lsp', partial: true, symbols: [] }),
      result({ source: 'tree-sitter', symbols: [symbol({ id: 't', name: 'A', line: 1 })] }),
    ]);
    expect(outcome.result.source).toBe('tree-sitter');
  });

  it('هشدارها با نام منبعشان می‌مانند', () => {
    const outcome = mergeExtractionResults([
      result({ partial: true, warnings: ['syntax error at line 3'] }),
      result({ source: 'tree-sitter', warnings: ['grammar missing'] }),
    ]);
    expect(outcome.result.warnings).toEqual([
      '[lsp] syntax error at line 3',
      '[tree-sitter] grammar missing',
    ]);
  });
});
