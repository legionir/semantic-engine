/**
 * SE-SYM-19 — امضای یک کلاس، `Foo()` نیست.
 *
 * قرارداد داده از قبل می‌گفت `signature` یعنی «signature or compact
 * declaration»، ولی هر چهار استخراج‌گر برای همهٔ kindها یک الگو می‌زدند:
 * `name(parameters)`. برای سمبل‌های اعلانی (کلاس، اینترفیس، enum، type،
 * struct، trait، namespace، module) آن رشته هم بی‌معناست هم گمراه‌کننده —
 * انگارسمبل فراخوانی‌شدنی است.
 */

import {
  DECLARATION_KINDS,
  declarationSignature,
  buildSignature,
} from './SymbolExtractionHelpers';
import { HeuristicSymbolExtractor } from './HeuristicSymbolExtractor';
import type { Parameter, SymbolEntry } from '../../core/types/project-index.types';

const p = (name: string, type?: string): Parameter => ({
  name,
  type: type ?? null,
  optional: false,
  defaultValue: null,
  rest: false,
});

describe('declarationSignature', () => {
  it('برای kindهای غیراعلانی null می‌دهد تا امضای تابعی دست‌نخورده بماند', () => {
    for (const kind of ['function', 'method', 'property', 'variable', 'constant', 'decorator']) {
      expect(declarationSignature(kind, 'x')).toBeNull();
    }
  });

  it('خطِ خودِ سورس برتر است، با حذف export/declare و آکولاد پایانی', () => {
    expect(
      declarationSignature('class', 'Repository', { definitionLine: 'export class Repository implements Storage {' })
    ).toBe('class Repository implements Storage');

    expect(
      declarationSignature('type-alias', 'Level', { definitionLine: "export type Level = 'debug' | 'info';" })
    ).toBe("type Level = 'debug' | 'info'");

    expect(
      declarationSignature('class', 'User', { definitionLine: 'data class User(val id: String, val name: String)' })
    ).toBe('data class User(val id: String, val name: String)');

    expect(
      declarationSignature('struct', 'Point', { definitionLine: 'pub struct Point {' })
    ).toBe('pub struct Point');
  });

  it('بی‌خطِ سورس، از قطعه‌های ساختاریافته می‌سازد', () => {
    expect(
      declarationSignature('class', 'FrameMeter', {
        extendsTypes: [],
        implementsTypes: ['Renderer'],
      })
    ).toBe('class FrameMeter implements Renderer');

    expect(
      declarationSignature('class', 'Parser', { generics: ['T'], extendsTypes: ['Base<T>'] })
    ).toBe('class Parser<T> extends Base<T>');

    expect(declarationSignature('interface', 'Storage')).toBe('interface Storage');
    expect(declarationSignature('enum', 'Role')).toBe('enum Role');
    expect(declarationSignature('type-alias', 'ColliderShape')).toBe('type ColliderShape');
  });

  it('خط بی‌ربط یا خیلی بلند، جایزهٔ ساختاری را از بین نمی‌برد', () => {
    /* خطی که نام سمبل در آن نیست، به آن سمبل تعلق ندارد. */
    expect(declarationSignature('class', 'Widget', { definitionLine: 'export default {' })).toBe('class Widget');

    const long = `class ${'X'.repeat(200)} extends Y {`;
    expect(declarationSignature('class', 'Long', { definitionLine: long })).toBe('class Long');
  });

  it('kindهای اعلانی از یک جا اعلام می‌شوند، نه چهار جا', () => {
    for (const kind of ['class', 'interface', 'enum', 'struct', 'trait', 'namespace', 'module', 'type-alias']) {
      expect(DECLARATION_KINDS.has(kind)).toBe(true);
    }
  });
});

describe('buildSignature — مسیر فراخوانی‌شدنی تغییر نمی‌کند', () => {
  it('تابع همان name(params): return است', () => {
    expect(buildSignature('login', [p('id', 'string')], 'typescript')).toBe('login(id: string)');
  });

  it('با kind اعلانی، به امضای اعلان می‌رسد', () => {
    expect(buildSignature('Repository', [p('id', 'string')], 'typescript', 'interface')).toBe('interface Repository');
  });
});

describe('استخراج‌گر heuristic هم همان قاعده را می‌زند', () => {
  /*
  | مسیر heuristic برای TypeScript فقط `class` را می‌شناسد — interface و enum
  | در این fallback تولید نمی‌شوند (کار tree-sitter است). آزمون همین را هم
  | مستند می‌کند: اصلاح امضا، kindی را که لایهٔ جایگزین هرگز گزارش نمی‌کند
  | زنده نمی‌کند.
  */
  const extract = async (content: string) => {
    const result = await new HeuristicSymbolExtractor().extract('f1', 'src/store.ts', content, 'typescript');
    if (!result.ok) throw result.error;
    return new Map<string, SymbolEntry>(result.value.symbols.map((entry: SymbolEntry) => [entry.name, entry]));
  };

  it('امضای کلاس از دل استخراج در می‌آید، با implementsش', async () => {
    const byName = await extract(
      ['export class Repository implements Storage {', '  constructor(private id: string) {}', '}', ''].join('\n')
    );

    expect(byName.get('Repository')?.signature).toBe('class Repository implements Storage');
  });

  it('بدون کلمهٔ کلیدی در خط، امضا باز هم `class Name` است', async () => {
    const byName = await extract(['class Logger {', '  log(): void {}', '}', ''].join('\n'));
    expect(byName.get('Logger')?.signature).toBe('class Logger');
  });

  it('تابع دست‌نخورده می‌ماند', async () => {
    const byName = await extract(['export function boot(id: string): void {}', ''].join('\n'));
    expect(byName.get('boot')?.signature).toContain('boot(');
    expect(byName.get('boot')?.signature).not.toMatch(/^function/);
  });
});
