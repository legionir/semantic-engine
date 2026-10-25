/**
 * AI-06 — Kotlin / Swift grammar support (cycle-7).
 *
 * پیش از این چرخه، پشتیبانی Kotlin/Swift به‌عنوان «محیطی/غیرممکن» برچسب
 * خورده بود (CLAIM: گرامرِ سازگار با ABI این web-tree-sitter وجود ندارد).
 * اندازه‌گیریِ مجدد آن را ابطال داد: با `tree-sitter-cli@0.24` + `emsdk`
 * در همین sandbox بیلد گرفته شد و روی همان `web-tree-sitter@0.26.11` که
 * پروژه استفاده می‌کند بارگذاری و پارس می‌شود. گرامرهای نتیجه در
 * `tree-sitter-grammars/tree-sitter-{kotlin,swift}.wasm` کنار بقیه‌اند.
 *
 * نکتهٔ مهمِ honesty: نام گره‌ها حدسی نیستند — هر چهار نمادِ کلیدی
 * (`class_declaration`/`object_declaration`/`function_declaration`/
 * `property_declaration`) و تفکیکِ interface/enum/struct/protocol با یک
 * probe روی همان فایل wasm استخراج شد (§ no-fabricated-completion).
 *
 * Kotlin و Swift هم `class` و هم `interface`/`protocol`/`enum`/`struct` را
 * در یک گرهٔ `class_declaration` می‌ریزند؛ بدون تفکیکِ کلیدواژه، هر
 * interface/enum به‌عنوان `class` ثبت می‌شد — یک برچسبِ غلط که بدتر از
 * سکوت است. این آزمون همان تفکیک را قفل می‌کند.
 */

import * as path from 'path';
import { TreeSitterParserManager } from './TreeSitterParserManager';
import { TreeSitterSymbolExtractor } from './TreeSitterSymbolExtractor';
import { supportLevelFor } from './languageGrammars';
import { SymbolEntry } from '../../core/types/project-index.types';

const grammarDir = path.join(__dirname, '..', '..', '..', 'tree-sitter-grammars');

/* نمونه‌های ایدiomاتیک: گرامر Kotlin به خط‌شکن حساس است (interface یک‌خطی
 | روی همان یک خط با hasError پارس می‌شود) — همان‌طور که در probe دیده
 | شد؛ بدین‌خاطر بدنه‌ها چندقدری‌اند. */
const KOTLIN_SOURCE = `package app

class UserService(val repo: String) : Greeter {
    fun find(id: Int): String = repo

    fun noop() {}
}

interface Greeter {
    fun greet(): String
}

enum class Color {
    RED,
    GREEN
}

object Singleton

fun helper(x: Int): Int = x
`;

const SWIFT_SOURCE = `import Foundation

class UserService: Greeter {
    var repo: String = ""

    func find(_ id: Int) -> String {
        return repo
    }
}

protocol Greeter {
    func greet() -> String
}

struct Point {
    var x: Int
}

enum Color {
    case red
    case green
}

func helper(_ x: Int) -> Int {
    return x
}
`;

async function extract(languageId: string, source: string): Promise<SymbolEntry[]> {
  const manager = new TreeSitterParserManager({ grammarDir });
  const extractor = new TreeSitterSymbolExtractor({ parserManager: manager });
  const result = await extractor.extract(`f-${languageId}`, `s.${languageId}`, source, languageId);
  if (!result.ok) throw new Error(`${languageId} extraction failed: ${result.error.message}`);
  return [...result.value.symbols];
}

function byName(symbols: SymbolEntry[], name: string): SymbolEntry | undefined {
  return symbols.find(s => s.name === name);
}

describe('AI-06 — Kotlin tree-sitter support (real wasm, not heuristic)', () => {
  let symbols: SymbolEntry[];

  beforeAll(async () => {
    symbols = await extract('kotlin', KOTLIN_SOURCE);
  }, 60_000);

  it('سطح پشتیبانی صریحاً structural اعلام می‌شود', () => {
    expect(supportLevelFor('kotlin')).toBe('structural');
  });

  it('کلاس، interface، enum و object با نوعِ درست ثبت می‌شوند', () => {
    expect(byName(symbols, 'UserService')?.kind).toBe('class');
    /* بدون تفکیکِ کلیدواژه، این دو `class` می‌شدند — همان برچسبِ غلط که
    | finding از آن می‌ترسد. */
    expect(byName(symbols, 'Greeter')?.kind).toBe('interface');
    expect(byName(symbols, 'Color')?.kind).toBe('enum');
    expect(byName(symbols, 'Singleton')?.kind).toBe('class');
  });

  it('تابع و متد تفکیک می‌شوند و والدِ درست دارند', () => {
    expect(byName(symbols, 'helper')?.kind).toBe('function');

    const find = byName(symbols, 'find')!;
    expect(find.kind).toBe('method');
    expect(byName(symbols, 'greet')?.kind).toBe('method');

    const svc = byName(symbols, 'UserService')!;
    expect(find.parentId).toBe(svc.id);
  });

  it('عضوهای enum ثابت می‌شوند و والدِ enum را دارند', () => {
    const color = byName(symbols, 'Color')!;
    expect(byName(symbols, 'RED')?.kind).toBe('constant');
    expect(byName(symbols, 'GREEN')?.parentId).toBe(color.id);
  });

  it('هیچ نمادی بی‌نام یا duplicate نیست', () => {
    for (const s of symbols) expect(s.name).toBeTruthy();
    const names = symbols.map(s => `${s.kind}:${s.fileId}:${s.name}`);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('AI-06 — Swift tree-sitter support (real wasm, not heuristic)', () => {
  let symbols: SymbolEntry[];

  beforeAll(async () => {
    symbols = await extract('swift', SWIFT_SOURCE);
  }, 60_000);

  it('سطح پشتیبانی صریحاً structural اعلام می‌شود', () => {
    expect(supportLevelFor('swift')).toBe('structural');
  });

  it('کلاس، protocol (→interface)، struct و enum با نوعِ درست', () => {
    expect(byName(symbols, 'UserService')?.kind).toBe('class');
    expect(byName(symbols, 'Greeter')?.kind).toBe('interface');
    expect(byName(symbols, 'Point')?.kind).toBe('struct');
    expect(byName(symbols, 'Color')?.kind).toBe('enum');
  });

  it('property و method با والد درست ثبت می‌شوند', () => {
    const svc = byName(symbols, 'UserService')!;
    const repo = byName(symbols, 'repo')!;
    expect(repo.kind).toBe('property');
    expect(repo.parentId).toBe(svc.id);

    expect(byName(symbols, 'find')?.kind).toBe('method');
    expect(byName(symbols, 'helper')?.kind).toBe('function');
  });

  it('هیچ نمادی بی‌نام نیست', () => {
    for (const s of symbols) expect(s.name).toBeTruthy();
  });
});
