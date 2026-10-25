import { sortSymbolsDeterministically } from './symbolSort';
import { SymbolEntry } from '../types/project-index.types';
import { makeConfidence } from '../types/common.types';

function createSymbol(
  id: string,
  fileId: string,
  kind: SymbolEntry['kind'],
  name: string,
  line: number
): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    line,
    endLine: line,
    signature: name,
    visibility: 'public',
    source: 'lsp',
    confidence: makeConfidence(80),
  } as SymbolEntry;
}

describe('sortSymbolsDeterministically', () => {
  it('should sort by fileId, then line, then kind, then name, then id', () => {
    const symbols: SymbolEntry[] = [
      createSymbol('s3', 'file-b', 'function', 'zFn', 5),
      createSymbol('s1', 'file-a', 'class', 'MyClass', 1),
      createSymbol('s2', 'file-a', 'function', 'aFn', 10),
      createSymbol('s4', 'file-a', 'function', 'aFn', 10), // same line/name, different id
    ];

    const sorted = sortSymbolsDeterministically(symbols);

    expect(sorted.map(s => s.id)).toEqual(['s1', 's2', 's4', 's3']);
  });

  it('should produce the same order on multiple runs', () => {
    const symbols: SymbolEntry[] = [
      createSymbol('s2', 'file-a', 'function', 'b', 2),
      createSymbol('s1', 'file-a', 'class', 'a', 1),
      createSymbol('s3', 'file-a', 'method', 'c', 3),
    ];

    const sorted1 = sortSymbolsDeterministically(symbols);
    const sorted2 = sortSymbolsDeterministically(symbols);

    expect(sorted1.map(s => s.id)).toEqual(sorted2.map(s => s.id));
  });

  /*
  | SE-F-022 — هر عضو union `SymbolKind` باید جایگاه canonical خودش را در
  | KIND_ORDER داشته باشد. پیش از این `trait` و `decorator` در bucket 999
  | می‌افتادند: یک trait هم‌خط با یک constant *بعد از* آن sort می‌شد، برخلاف
  | هر kind سطح-بالای دیگر. این تست کل union را برابر ترتیب مورد انتظار
  | قرار می‌دهد؛ افزودن kind جدید به union بدون افزودن آن به KIND_ORDER،
  | و همچنین جابه‌جایی اشتباه جایگاه، این را قرمز می‌کند.
  */
  it('places every SymbolKind member in its canonical bucket', () => {
    const kinds: SymbolEntry['kind'][] = [
      'decorator', 'constant', 'variable', 'property',
      'method', 'function', 'type-alias', 'enum', 'trait', 'struct',
      'interface', 'class', 'module', 'namespace',
    ];

    // ورودی عمداً معکوس: خروجی باید دقیقاً ترتیب canonical باشد.
    const symbols = kinds.map((kind, i) =>
      createSymbol(`k${i}`, 'file-a', kind, 'Same', 1)
    );

    const sorted = sortSymbolsDeterministically(symbols);

    expect(sorted.map(s => s.kind)).toEqual([
      'namespace', 'module', 'class', 'interface', 'struct', 'trait',
      'enum', 'type-alias', 'function', 'method', 'property', 'variable',
      'constant', 'decorator',
    ]);
  });

  it('stays deterministic for kinds outside KIND_ORDER', () => {
    const mk = (id: string, kind: string) =>
      ({ ...createSymbol(id, 'file-a', 'class', id, 1), kind }) as SymbolEntry;

    const symbols = [mk('z', 'quantum'), mk('a', 'sparkline'), mk('m', 'quantum')];

    const sorted = sortSymbolsDeterministically(symbols);

    // هر دو unknown در bucket 999؛ tie-break نام→id باید پایدار بماند.
    expect(sorted.map(s => s.id)).toEqual(['a', 'm', 'z']);
    const again = sortSymbolsDeterministically([...symbols].reverse());
    expect(again.map(s => s.id)).toEqual(sorted.map(s => s.id));
  });
});
