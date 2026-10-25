/**
 * تست SymbolMetricsCalculator: complexity و referenceCount.
 */

import * as path from 'path';
import * as fs from 'fs';
import { SymbolMetricsCalculator } from './SymbolMetricsCalculator';
import { FileEntry, SymbolEntry, CallEdge } from '../types/project-index.types';
import { makeConfidence } from '../types/common.types';

const tmpDir = path.join(__dirname, '..', '..', '..', 'tmp-metrics-test');

function createFile(id: string, filePath: string, language: string): FileEntry {
  return {
    id,
    path: filePath,
    language,
    encoding: 'utf8',
    size: 100,
    lines: 20,
    hash: 'abc',
    modified: new Date().toISOString(),
    binary: false,
    testFile: false,
    generated: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  };
}

function createSymbol(id: string, fileId: string, kind: any, name: string, line: number): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    line,
    endLine: line + 5,
    source: 'lsp',
    confidence: makeConfidence(85),
  } as SymbolEntry;
}

describe('SymbolMetricsCalculator', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'utils.ts'),
      `export function simple() { return 1; }\n` +
      `export function branch(x: number) {\n` +
      `  if (x > 0) { return 1; }\n` +
      `  else if (x < 0) { return -1; }\n` +
      `  return 0;\n` +
      `}\n` +
      `export function loop(items: number[]) {\n` +
      `  for (const i of items) {\n` +
      `    if (i % 2 === 0) { console.log(i); }\n` +
      `  }\n` +
      `}`
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should calculate cyclomatic complexity for functions', () => {
    const file = createFile('f1', 'src/utils.ts', 'typescript');
    const simple = createSymbol('s1', 'f1', 'function', 'simple', 1);
    const branch = createSymbol('s2', 'f1', 'function', 'branch', 2);
    const loop = createSymbol('s3', 'f1', 'function', 'loop', 7);

    const calculator = new SymbolMetricsCalculator();
    const result = calculator.compute({
      workspaceRoot: tmpDir,
      files: [file],
      symbols: [simple, branch, loop],
      callGraph: [],
    });

    const byId = new Map(result.map(s => [s.id, s]));
    expect(byId.get('s1')!.complexity).toBe(1);
    expect(byId.get('s2')!.complexity).toBe(3); // 2 if/else-if + 1
    expect(byId.get('s3')!.complexity).toBe(3); // for + if + 1
  });

  it('should not calculate complexity for non-function symbols', () => {
    const file = createFile('f1', 'src/utils.ts', 'typescript');
    const cls = createSymbol('s1', 'f1', 'class', 'MyClass', 1);

    const calculator = new SymbolMetricsCalculator();
    const result = calculator.compute({
      workspaceRoot: tmpDir,
      files: [file],
      symbols: [cls],
      callGraph: [],
    });

    expect(result[0]!.complexity).toBeNull();
  });

  it('should count cross-file references from callGraph', () => {
    const fileA = createFile('fa', 'src/a.ts', 'typescript');
    const fileB = createFile('fb', 'src/b.ts', 'typescript');

    const fnA = createSymbol('sa', 'fa', 'function', 'fnA', 1);
    const fnB = createSymbol('sb', 'fb', 'function', 'fnB', 1);

    const callGraph: CallEdge[] = [
      { id: 'e1', caller: 'sb', callee: 'sa', kind: 'direct', line: 1, provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
    ];

    const calculator = new SymbolMetricsCalculator();
    const result = calculator.compute({
      workspaceRoot: tmpDir,
      files: [fileA, fileB],
      symbols: [fnA, fnB],
      callGraph,
    });

    const byId = new Map(result.map(s => [s.id, s]));
    expect(byId.get('sa')!.referenceCount).toBe(1);
    expect(byId.get('sb')!.referenceCount).toBeUndefined();
  });

  it('should ignore same-file references in referenceCount', () => {
    const file = createFile('f1', 'src/utils.ts', 'typescript');
    const a = createSymbol('sa', 'f1', 'function', 'a', 1);
    const b = createSymbol('sb', 'f1', 'function', 'b', 2);

    const callGraph: CallEdge[] = [
      { id: 'e1', caller: 'sb', callee: 'sa', kind: 'direct', line: 1, provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
    ];

    const calculator = new SymbolMetricsCalculator();
    const result = calculator.compute({
      workspaceRoot: tmpDir,
      files: [file],
      symbols: [a, b],
      callGraph,
    });

    expect(result[0]!.referenceCount).toBeUndefined();
  });
});

describe('SE-GRAPH-02 — فراخوانی سطح ماژول هم یک ارجاع است', () => {
  /*
  | یالی که فراخوانی‌اش داخل هیچ symbolای نمی‌افتد (بدنهٔ ماژول،
  | یا یک callback بی‌نام) `caller` را برابر **fileId** می‌گذارد.
  | شمارش قدیمی `symbolById.get(edge.caller)` را می‌گرفت،
  | `undefined` می‌دید و رد می‌شد — روی خودِ این مخزن یعنی ۹٬۹۰۶
  | یال از ۱۷٬۴۸۵ بی‌صدا دور ریخته می‌شد و `referenceCount` فقط
  | برای ۵۱۴ symbol از ۷٬۲۹۳ عدد داشت.
  |
  | تا فاز ۳۷ هیچ آزمون واحدی این را نمی‌گرفت؛ فقط snapshot طلایی
  | تغییر می‌کرد. این‌جا همان شکاف بسته می‌شود.
  */
  const caller = createFile('caller-file', 'src/main.ts', 'typescript');
  const callee = createFile('callee-file', 'src/lib.ts', 'typescript');
  const target = createSymbol('target', 'callee-file', 'function', 'target', 1);

  const edge = (from: string, callerKind: 'symbol' | 'file'): CallEdge => ({
    id: `e-${from}-${callerKind}`,
    caller: from,
    callerKind,
    callee: 'target',
    kind: 'direct',
    line: 3,
    provenance: {
      extractor: 'typescript-api',
      confidence: 95,
      basis: 'ast',
      location: { file: 'src/main.ts', line: 3 },
    },
  });

  it('شمرده می‌شود وقتی فراخوان یک فایل دیگر است', () => {
    const result = new SymbolMetricsCalculator().compute({
      workspaceRoot: tmpDir,
      files: [caller, callee],
      symbols: [target, createSymbol('other', 'caller-file', 'function', 'other', 9)],
      callGraph: [edge('caller-file', 'file')],
    });

    expect(result.find(symbol => symbol.id === 'target')!.referenceCount).toBe(1);
  });

  it('فراخوانی از خودِ همان فایل، ارجاع بین‌فایلی نیست', () => {
    const result = new SymbolMetricsCalculator().compute({
      workspaceRoot: tmpDir,
      files: [callee],
      symbols: [target],
      callGraph: [edge('callee-file', 'file')],
    });

    expect(result.find(symbol => symbol.id === 'target')!.referenceCount ?? 0).toBe(0);
  });

  it('شناسه‌ای که نه symbol است نه فایل، شمرده نمی‌شود', () => {
    const result = new SymbolMetricsCalculator().compute({
      workspaceRoot: tmpDir,
      files: [caller, callee],
      symbols: [target, createSymbol('other', 'caller-file', 'function', 'other', 9)],
      callGraph: [edge('a-ghost-id', 'file')],
    });

    expect(result.find(symbol => symbol.id === 'target')!.referenceCount ?? 0).toBe(0);
  });
});
