/**
 * فاز ۲۳ — متریک‌های سطح symbol.
 *
 * پنج یافتهٔ AUDIT، هر کدام با یک عدد قابل اندازه‌گیری:
 *
 *   SE-METRIC-01  پیچیدگی *کل فایل* به تک‌تک symbolهای آن نسبت داده می‌شد
 *   SE-METRIC-02  الگوهای Python دوباره‌شماری می‌کردند و غیرتصمیم‌ها را می‌شمردند
 *   SE-METRIC-03  کامنت‌زدایی یک‌اندازه‌برای‌همه، عدد Python را می‌شکست
 *   SE-METRIC-04  کش‌ها بی‌سقف بودند و `dispose` نداشتند
 *   SE-METRIC-05  تطبیق گرهٔ تابع فقط با شماره خط دقیق بود
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolMetricsCalculator } from './SymbolMetricsCalculator';
import { createPythonComplexityCalculator } from './PythonComplexityCalculator';
import { FileEntry, SymbolEntry } from '../types/project-index.types';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-metric-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function file(id: string, relative: string, language: string): FileEntry {
  return {
    id,
    path: relative,
    language,
    encoding: 'utf8',
    size: 0,
    lines: 0,
    hash: '',
    modified: '',
    binary: false,
    testFile: false,
    generated: false,
  } as FileEntry;
}

function symbol(
  id: string,
  fileId: string,
  name: string,
  line: number,
  endLine: number,
  kind: SymbolEntry['kind'] = 'function'
): SymbolEntry {
  return { id, fileId, parentId: null, kind, name, line, endLine } as SymbolEntry;
}

/** complexity هر symbol، با نام. */
function complexities(
  files: readonly FileEntry[],
  symbols: readonly SymbolEntry[]
): Record<string, number | null | undefined> {
  const calculator = new SymbolMetricsCalculator();
  const out = calculator.compute({ workspaceRoot: workspace, files, symbols, callGraph: [] });
  calculator.dispose();
  return Object.fromEntries(out.map(s => [s.name, s.complexity]));
}

describe('SE-METRIC-01 — پیچیدگی به بدنهٔ خودِ symbol تعلق دارد', () => {
  it('دو تابع Python با پیچیدگی متفاوت، دو عدد متفاوت می‌گیرند', () => {
    write(
      'm.py',
      [
        'def add(a, b):',
        '    return a + b',
        '',
        '',
        'def classify(n):',
        '    if n < 0:',
        '        return "neg"',
        '    elif n == 0:',
        '        return "zero"',
        '    for i in range(n):',
        '        while i > 0:',
        '            i -= 1',
        '    return "pos"',
        '',
      ].join('\n')
    );

    const got = complexities(
      [file('f1', 'm.py', 'python')],
      [symbol('s1', 'f1', 'add', 1, 2), symbol('s2', 'f1', 'classify', 5, 13)]
    );

    expect(got['add']).toBe(1);
    expect(got['classify']).toBe(5); // 1 + if + elif + for + while
    expect(got['add']).not.toBe(got['classify']);
  });

  it('تصمیم‌های تابع تودرتو به والد نشت نمی‌کند', () => {
    write(
      'n.py',
      [
        'def outer(xs):',           // 1
        '    def inner(y):',        // 2
        '        if y:',            // 3
        '            return 1',     // 4
        '        return 0',         // 5
        '    return inner',         // 6
        '',
      ].join('\n')
    );

    const got = complexities(
      [file('f1', 'n.py', 'python')],
      [symbol('s1', 'f1', 'outer', 1, 6), symbol('s2', 'f1', 'inner', 2, 5)]
    );

    expect(got['inner']).toBe(2);
    expect(got['outer']).toBe(1);
  });

  it('همین برای Go هم برقرار است', () => {
    write(
      'm.go',
      [
        'package m',
        '',
        'func Small() int {',
        '\treturn 1',
        '}',
        '',
        'func Big(n int) int {',
        '\tif n < 0 {',
        '\t\treturn -1',
        '\t}',
        '\tfor i := 0; i < n; i++ {',
        '\t\tswitch i {',
        '\t\tcase 1:',
        '\t\t\treturn i',
        '\t\t}',
        '\t}',
        '\treturn 0',
        '}',
        '',
      ].join('\n')
    );

    const got = complexities(
      [file('f1', 'm.go', 'go')],
      [symbol('s1', 'f1', 'Small', 3, 5), symbol('s2', 'f1', 'Big', 7, 18)]
    );

    expect(got['Small']).toBe(1);
    expect(got['Big']!).toBeGreaterThan(got['Small']!);
  });

  it('نبودِ endLine معتبر باعث برگشت به کل فایل نمی‌شود', () => {
    write('o.py', ['def a():', '    if 1:', '        pass', '', 'def b():', '    pass', ''].join('\n'));

    // endLine برابر line — یعنی «نمی‌دانم»
    const got = complexities(
      [file('f1', 'o.py', 'python')],
      [symbol('s1', 'f1', 'b', 5, 5)]
    );

    // فقط خط خودش دیده می‌شود، نه ifِ تابع دیگر
    expect(got['b']).toBe(1);
  });
});

describe('SE-METRIC-02 — الگوهای Python دیگر دوباره نمی‌شمارند', () => {
  const python = createPythonComplexityCalculator();

  it.each([
    ['با if/else یکبار شمرده می‌شود', 'if x:\n    return 1\nelse:\n    return 2\n', 2],
    ['comprehension یکبار', 'return [y for y in xs]\n', 2],
    ['comprehension با شرط دوبار', 'return [y for y in xs if y]\n', 3],
    ['with نقطهٔ تصمیم نیست', 'with open("a") as h:\n    pass\n', 1],
    ['assert نقطهٔ تصمیم نیست', 'assert True\n', 1],
    ['elif شمرده می‌شود', 'if a:\n    pass\nelif b:\n    pass\n', 3],
  ])('%s', (_name, source, expected) => {
    expect(python.calculate(source)).toBe(expected);
  });

  it('and/or داخل رشته شمرده نمی‌شود', () => {
    expect(python.calculate('return "salt and pepper or sugar"\n')).toBe(1);
    expect(python.calculate('return a and b or c\n')).toBe(3);
  });

  it('یک if در یک تابع با یک else در تابع دیگر جفت نمی‌شود', () => {
    /*
    | الگوی ternary قدیمی `\bif\b[\s\S]*?\belse\b` بود — `[\s\S]` یعنی
    | خط جدید هم شامل می‌شود، پس یک `if` می‌توانست با `else`ای ده‌ها
    | خط پایین‌تر و در تابع دیگری جفت شود.
    */
    const source = 'def a(x):\n    if x:\n        return 1\n    return 0\n\ndef b(y):\n    for i in y:\n        pass\n    else:\n        pass\n';
    // if + for + (for/else یک تصمیم است ولی الگوی ما نمی‌شناسدش) → دست‌کم دوباره‌شماری نباشد
    expect(python.calculate(source)).toBeLessThanOrEqual(3);
  });
});

describe('SE-METRIC-03 — کامنت‌زدایی زبان‌آگاه است', () => {
  const python = createPythonComplexityCalculator();

  it('`//` در Python تقسیم صحیح است، نه کامنت', () => {
    expect(python.calculate('return (a // b) or 0\n')).toBe(2);
    expect(python.calculate('n = 7 // 2\nif n:\n    pass\n')).toBe(2);
  });

  it('`#` داخل رشته کامنت نیست', () => {
    expect(python.calculate('return "a # b" or c\n')).toBe(2);
  });

  it('`#` واقعی هنوز کامنت است', () => {
    expect(python.calculate('# if a and b\nreturn 1\n')).toBe(1);
  });

  it('در Go و TypeScript همچنان `//` کامنت است', () => {
    write('g.go', ['package m', '', 'func F(a bool) int {', '\t// if a && a', '\treturn 1', '}', ''].join('\n'));
    const got = complexities([file('f1', 'g.go', 'go')], [symbol('s1', 'f1', 'F', 3, 6)]);
    expect(got['F']).toBe(1);
  });
});

describe('SE-METRIC-04 — کش‌ها سقف و dispose دارند', () => {
  it('dispose کش‌ها را خالی می‌کند', () => {
    write('a.py', 'def f():\n    pass\n');
    const calculator = new SymbolMetricsCalculator();
    calculator.compute({
      workspaceRoot: workspace,
      files: [file('f1', 'a.py', 'python')],
      symbols: [symbol('s1', 'f1', 'f', 1, 2)],
      callGraph: [],
    });

    expect(calculator.cacheSize()).toBeGreaterThan(0);
    calculator.dispose();
    expect(calculator.cacheSize()).toBe(0);
  });

  it('کش از سقف پیکربندی‌شده عبور نمی‌کند', () => {
    const files: FileEntry[] = [];
    const symbols: SymbolEntry[] = [];
    for (let index = 0; index < 12; index++) {
      write(`f${index}.py`, 'def f():\n    pass\n');
      files.push(file(`f${index}`, `f${index}.py`, 'python'));
      symbols.push(symbol(`s${index}`, `f${index}`, 'f', 1, 2));
    }

    const calculator = new SymbolMetricsCalculator({ maxCachedFiles: 4 });
    calculator.compute({ workspaceRoot: workspace, files, symbols, callGraph: [] });

    expect(calculator.cacheSize()).toBeLessThanOrEqual(4);
    calculator.dispose();
  });
});

describe('SE-METRIC-05 — تطبیق گرهٔ تابع فراتر از شماره خط', () => {
  it('متد دکوره‌شده هم complexity می‌گیرد', () => {
    write(
      's.ts',
      [
        'const log = (..._a: unknown[]) => (..._b: unknown[]) => undefined;', // 1
        '',                                                                   // 2
        'export class Svc {',                                                 // 3
        '  @log()',                                                           // 4
        '  handle(x: number): number {',                                      // 5
        '    if (x > 0) { return 1; }',                                       // 6
        '    return 0;',                                                      // 7
        '  }',                                                                // 8
        '}',                                                                  // 9
        '',
      ].join('\n')
    );

    const got = complexities(
      [file('f1', 's.ts', 'typescript')],
      [symbol('s1', 'f1', 'handle', 5, 8, 'method')]
    );

    expect(got['handle']).toBe(2);
  });

  it('دو تابع روی یک خط، هرکدام عدد خودشان را می‌گیرند', () => {
    write(
      'p.ts',
      'export function a1(): number { return 1; } export function a2(x: number): number { return x > 0 ? 1 : 0; }\n'
    );

    const calculator = new SymbolMetricsCalculator();
    const out = calculator.compute({
      workspaceRoot: workspace,
      files: [file('f1', 'p.ts', 'typescript')],
      symbols: [symbol('s1', 'f1', 'a1', 1, 1), symbol('s2', 'f1', 'a2', 1, 1)],
      callGraph: [],
    });
    calculator.dispose();

    const byName = Object.fromEntries(out.map(s => [s.name, s.complexity]));
    expect(byName['a1']).toBe(1);
    expect(byName['a2']).toBe(2);
  });

  it('نام، بر شماره خط اولویت دارد وقتی هر دو در دسترس‌اند', () => {
    write(
      'q.ts',
      [
        'export function alpha(a: boolean): number {', // 1
        '  return a ? 1 : 0;',                          // 2
        '}',                                            // 3
        'export function beta(): number {',             // 4
        '  return 1;',                                  // 5
        '}',                                            // 6
        '',
      ].join('\n')
    );

    // شماره خط عمداً یکی جابه‌جا داده شده — نام باید نجاتش دهد
    const got = complexities(
      [file('f1', 'q.ts', 'typescript')],
      [symbol('s1', 'f1', 'beta', 3, 6)]
    );

    expect(got['beta']).toBe(1);
  });
});
