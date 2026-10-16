import { SymbolExtractorManager } from './SymbolExtractorManager';
import { ISymbolExtractor, SymbolExtractionResult } from './ISymbolExtractor';
import { ExtractionSource, Result, ok, err } from '../core/types/common.types';

function createMockExtractor(
  name: ExtractionSource,
  priority: number,
  available: boolean,
  result: Result<SymbolExtractionResult>
): ISymbolExtractor {
  return {
    name,
    priority,
    isAvailable: async () => available,
    extract: async () => result,
    dispose: async () => {},
  };
}

const fullResult: SymbolExtractionResult = {
  symbols: [],
  source: 'lsp',
  partial: false,
  warnings: [],
};

const partialResult: SymbolExtractionResult = {
  symbols: [],
  source: 'lsp',
  partial: true,
  warnings: ['partial'],
};

describe('SymbolExtractorManager', () => {
  it('should return full result immediately and skip fallback', async () => {
    const manager = new SymbolExtractorManager();
    const fullExtractor = createMockExtractor('lsp', 100, true, ok(fullResult));
    const neverCalled = createMockExtractor('tree-sitter', 50, true, ok(fullResult));

    const extractSpy = jest.spyOn(neverCalled, 'extract');

    manager.register(fullExtractor);
    manager.register(neverCalled);

    const result = await manager.extract('file1', 'a.ts', '', 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.partial).toBe(false);
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('should fallback when result is partial', async () => {
    const manager = new SymbolExtractorManager();
    const partialExtractor = createMockExtractor('lsp', 100, true, ok(partialResult));
    const fullExtractor = createMockExtractor('tree-sitter', 50, true, ok({
      ...fullResult,
      source: 'tree-sitter' as ExtractionSource,
    }));

    manager.register(partialExtractor);
    manager.register(fullExtractor);

    const result = await manager.extract('file1', 'a.ts', '', 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.partial).toBe(false);
    expect(result.value.source).toBe('tree-sitter');
  });

  it('should return last partial if no extractor returns full', async () => {
    const manager = new SymbolExtractorManager();
    const partial1 = createMockExtractor('lsp', 100, true, ok(partialResult));
    const partial2 = createMockExtractor('tree-sitter', 50, true, ok({
      ...partialResult,
      source: 'tree-sitter' as ExtractionSource,
    }));

    manager.register(partial1);
    manager.register(partial2);

    const result = await manager.extract('file1', 'a.ts', '', 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.partial).toBe(true);
    expect(result.value.source).toBe('tree-sitter');
  });

  it('should skip unavailable extractors', async () => {
    const manager = new SymbolExtractorManager();
    const unavailable = createMockExtractor('lsp', 100, false, ok(fullResult));
    const fallback = createMockExtractor('tree-sitter', 50, true, ok({
      ...fullResult,
      source: 'tree-sitter' as ExtractionSource,
    }));

    manager.register(unavailable);
    manager.register(fallback);

    const result = await manager.extract('file1', 'a.ts', '', 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.source).toBe('tree-sitter');
  });
});

// ── فاز ۳۳ ────────────────────────────────────────────────────────────

import { SymbolEntry } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';

function entry(
  over: Partial<SymbolEntry> & { id: string; name: string; line: number }
): SymbolEntry {
  return {
    fileId: 'file1',
    parentId: null,
    kind: 'function',
    fullyQualifiedName: over.name,
    signature: over.name,
    visibility: 'public',
    endLine: over.line,
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
    ...over,
  } as SymbolEntry;
}

describe('SE-SYM-01 — نتیجهٔ ناقص با نتیجهٔ بعدی ادغام می‌شود', () => {
  it('symbolهای زبان‌سرور از دست نمی‌روند وقتی ناقص است', async () => {
    /*
    | این همان باگ است: زبان‌سرور به‌خاطر یک خطای نحوی جزئی
    | `partial: true` می‌داد و کل نتیجه‌اش — شامل symbolهایی که هیچ
    | استخراج‌گر دیگری نمی‌بیند — دور ریخته می‌شد.
    */
    const manager = new SymbolExtractorManager();
    manager.register(
      createMockExtractor('lsp', 90, true, ok({
        symbols: [entry({ id: 'l1', name: 'OnlyLspSeesThis', line: 4 })],
        source: 'lsp' as ExtractionSource,
        partial: true,
        warnings: ['syntax error'],
      }))
    );
    manager.register(
      createMockExtractor('tree-sitter', 50, true, ok({
        symbols: [entry({ id: 't1', name: 'OnlyTreeSitterSeesThis', line: 9, source: 'tree-sitter' })],
        source: 'tree-sitter' as ExtractionSource,
        partial: false,
        warnings: [],
      }))
    );

    const result = await manager.extract('file1', 'a.ts', '', 'typescript');
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.symbols.map(s => s.name)).toEqual([
      'OnlyLspSeesThis',
      'OnlyTreeSitterSeesThis',
    ]);
    expect(result.value.partial).toBe(false);
    expect(result.value.warnings).toContain('[lsp] syntax error');
  });

  it('نتیجهٔ کامل زنجیره را تمام می‌کند — استخراج‌گر بعدی صدا زده نمی‌شود', async () => {
    const manager = new SymbolExtractorManager();
    const never = createMockExtractor('heuristic', 10, true, ok(fullResult));
    const spy = jest.spyOn(never, 'extract');

    manager.register(createMockExtractor('tree-sitter', 50, true, ok({
      ...fullResult,
      source: 'tree-sitter' as ExtractionSource,
    })));
    manager.register(never);

    await manager.extract('file1', 'a.ts', '', 'typescript');
    expect(spy).not.toHaveBeenCalled();
  });

  it('خطای یک استخراج‌گر در هشدارهای نتیجهٔ موفق دیده می‌شود', async () => {
    const manager = new SymbolExtractorManager();
    manager.register(createMockExtractor('lsp', 90, true, err(new Error('server died'))));
    manager.register(createMockExtractor('tree-sitter', 50, true, ok({
      ...fullResult,
      source: 'tree-sitter' as ExtractionSource,
    })));

    const result = await manager.extract('file1', 'a.ts', '', 'typescript');
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.warnings.join(' ')).toContain('server died');
  });
});

describe('SE-SYM-03 — isAvailable به‌ازای هر فایل پرسیده نمی‌شود', () => {
  it('یک بار برای هر زبان پرسیده می‌شود، نه یک بار برای هر فایل', async () => {
    const manager = new SymbolExtractorManager();
    const extractor = createMockExtractor('tree-sitter', 50, true, ok({
      ...fullResult,
      source: 'tree-sitter' as ExtractionSource,
    }));
    const spy = jest.spyOn(extractor, 'isAvailable');
    manager.register(extractor);

    for (let index = 0; index < 20; index++) {
      await manager.extract(`file${index}`, `a${index}.ts`, '', 'typescript');
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('هر زبان جواب خودش را دارد', async () => {
    const manager = new SymbolExtractorManager();
    const extractor: ISymbolExtractor = {
      name: 'tree-sitter',
      priority: 50,
      isAvailable: async (languageId: string) => languageId === 'typescript',
      extract: async () => ok({ ...fullResult, source: 'tree-sitter' as ExtractionSource }),
      dispose: async () => {},
    };
    const spy = jest.spyOn(extractor, 'isAvailable');
    manager.register(extractor);

    expect(await manager.hasExtractorFor('typescript')).toBe(true);
    expect(await manager.hasExtractorFor('go')).toBe(false);
    expect(await manager.hasExtractorFor('typescript')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('کش بعد از TTL منقضی می‌شود — سروری که مرده، تا ابد زنده نمی‌ماند', async () => {
    /*
    | کش بی‌انقضا یعنی اگر زبان‌سرور وسط یک اسکن بمیرد، مدیر تا
    | پایان همان اسکن به سراغش می‌رود و هر فایل یک خطا می‌گیرد.
    */
    let clock = 1_000;
    const manager = new SymbolExtractorManager({ availabilityTtlMs: 500, now: () => clock });
    const extractor = createMockExtractor('tree-sitter', 50, true, ok({
      ...fullResult,
      source: 'tree-sitter' as ExtractionSource,
    }));
    const spy = jest.spyOn(extractor, 'isAvailable');
    manager.register(extractor);

    await manager.hasExtractorFor('typescript');
    clock += 100;
    await manager.hasExtractorFor('typescript');
    expect(spy).toHaveBeenCalledTimes(1);

    clock += 500;
    await manager.hasExtractorFor('typescript');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('ttl صفر یعنی بدون کش', async () => {
    const manager = new SymbolExtractorManager({ availabilityTtlMs: 0 });
    const extractor = createMockExtractor('tree-sitter', 50, true, ok({
      ...fullResult,
      source: 'tree-sitter' as ExtractionSource,
    }));
    const spy = jest.spyOn(extractor, 'isAvailable');
    manager.register(extractor);

    await manager.hasExtractorFor('typescript');
    await manager.hasExtractorFor('typescript');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('invalidateAvailability کش را پاک می‌کند', async () => {
    const manager = new SymbolExtractorManager();
    const extractor = createMockExtractor('tree-sitter', 50, true, ok({
      ...fullResult,
      source: 'tree-sitter' as ExtractionSource,
    }));
    const spy = jest.spyOn(extractor, 'isAvailable');
    manager.register(extractor);

    await manager.hasExtractorFor('typescript');
    manager.invalidateAvailability();
    await manager.hasExtractorFor('typescript');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
