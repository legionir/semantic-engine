/**
 * معیارهای پذیرش فاز ۱۹ — روی گراف واقعیِ ساخته‌شده، نه روی داده‌ی بدلی.
 *
 * این فاز پیش‌نیاز کل بلوک F است. آن بلوک روی همین یال‌ها مسیر پیدا
 * می‌کند و برای آدم توضیح می‌سازد؛ گرافی که نتواند بگوید کدام یالش
 * حدس است، مسیرِ **مطمئنِ غلط** تولید می‌کند.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CallGraphBuilder, TypeGraphBuilder, DependencyGraphBuilder } from './index';
import { ReverseDependencyIndex } from './ReverseDependencyIndex';
import { TreeSitterParserManager } from '../symbols/tree-sitter/TreeSitterParserManager';
import { TreeSitterSymbolExtractor } from '../symbols/tree-sitter/TreeSitterSymbolExtractor';
import { FileEntry, SymbolEntry, ImportEntry } from '../core/types/project-index.types';
import { isHighConfidence, isPackageRef } from './EdgeProvenance';

const GRAMMARS = path.join(__dirname, '..', '..', 'tree-sitter-grammars');

let root: string;
let parserManager: TreeSitterParserManager;
let extractor: TreeSitterSymbolExtractor;

/** یک فایل با فراخوانی‌های داخل‌فایلی و یک ارث‌بری. */
const SOURCE = `export class Base {
  run(): number { return 1; }
}

export class Child extends Base {
  run(): number { return super.run() + this.helper(); }
  helper(): number { return 2; }
}

export function orchestrate(): number {
  const child = new Child();
  return child.run();
}
`;

beforeAll(() => {
  parserManager = new TreeSitterParserManager({ grammarDir: GRAMMARS });
  extractor = new TreeSitterSymbolExtractor({ parserManager });
});

afterAll(async () => {
  await parserManager.dispose();
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-graph-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), SOURCE);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function buildGraphs(imports: ImportEntry[] = []) {
  const result = await extractor.extract('f1', 'src/a.ts', SOURCE, 'typescript');
  if (!result.ok) throw result.error;
  const symbols = result.value.symbols as SymbolEntry[];

  const files: FileEntry[] = [{
    id: 'f1',
    path: 'src/a.ts',
    language: 'typescript',
    encoding: 'utf8',
    size: SOURCE.length,
    lines: SOURCE.split('\n').length,
    hash: 'h',
    modified: '2026-08-18T00:00:00.000Z',
    binary: false,
    testFile: false,
    generated: false,
    imports,
    exports: [],
  }];

  const callGraph = new CallGraphBuilder({ workspaceRoot: root, files, symbols }).build();
  const typeGraph = new TypeGraphBuilder(symbols).build();
  const dependencyGraph = new DependencyGraphBuilder(files).build();
  const reverseDependencyGraph = new ReverseDependencyIndex({ includeSymbolLevel: true })
    .build({ callGraph, typeGraph, dependencyGraph });

  return { symbols, callGraph, typeGraph, dependencyGraph, reverseDependencyGraph };
}

describe('معیار پذیرش ۱ — هر یال confidence دارد', () => {

  it('every call edge carries provenance', async () => {
    const { callGraph } = await buildGraphs();

    expect(callGraph.length).toBeGreaterThan(0);
    for (const edge of callGraph) {
      expect(typeof edge.provenance.confidence).toBe('number');
      expect(edge.provenance.basis).toBeDefined();
      expect(edge.provenance.extractor).toBeDefined();
    }
  });

  it('every type edge carries provenance', async () => {
    const { typeGraph } = await buildGraphs();

    expect(typeGraph.length).toBeGreaterThan(0);
    expect(typeGraph.every(e => typeof e.provenance.confidence === 'number')).toBe(true);
  });

  it('every dependency edge carries provenance', async () => {
    const { dependencyGraph } = await buildGraphs([
      { from: 'lodash', type: 'package' } as ImportEntry,
    ]);

    expect(dependencyGraph.length).toBeGreaterThan(0);
    expect(dependencyGraph.every(e => typeof e.provenance.confidence === 'number')).toBe(true);
  });

  it('every reverse edge keeps the provenance of the edge it reverses', async () => {
    const { reverseDependencyGraph } = await buildGraphs();

    expect(reverseDependencyGraph.length).toBeGreaterThan(0);
    expect(reverseDependencyGraph.every(e => e.provenance !== undefined)).toBe(true);
  });

  it('keeps every confidence inside 0 to 100', async () => {
    const { callGraph, typeGraph, dependencyGraph } = await buildGraphs();

    for (const edge of [...callGraph, ...typeGraph, ...dependencyGraph]) {
      expect(edge.provenance.confidence).toBeGreaterThanOrEqual(0);
      expect(edge.provenance.confidence).toBeLessThanOrEqual(100);
    }
  });
});

describe('معیار پذیرش ۲ — دو اجرای متوالی، id یال یکسان', () => {

  it('produces identical edge ids for the same input', async () => {
    const first = await buildGraphs();
    const second = await buildGraphs();

    expect(second.callGraph.map(e => e.id)).toEqual(first.callGraph.map(e => e.id));
  });

  /*
  | شناسهٔ قبلی `hash('call-edge-' + counter)` بود. اندازه‌گیری‌شده:
  | دو پروژهٔ کاملاً بی‌ربط همان فهرست شناسه را می‌دادند، چون شناسه
  | فقط جایگاه را کد می‌کرد.
  */
  it('gives an edge an id that depends on the edge itself', async () => {
    const { callGraph } = await buildGraphs();
    const ids = new Set(callGraph.map(e => e.id));

    expect(ids.size).toBe(callGraph.length);
    for (const edge of callGraph) {
      expect(edge.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe('معیار پذیرش ۳ — فیلتر confidence ≥ ۷۰ تعداد را کم می‌کند', () => {

  /*
  | اگر همه‌چیز بالای آستانه باشد، provenance فقط تزیین است. نکته این
  | است که یال‌های ضعیف *واقعاً* پایین‌تر علامت بخورند و فیلتر
  | کردنشان ممکن باشد.
  */
  it('a global name match falls below the threshold', async () => {
    const { symbols } = await buildGraphs();

    // ارث‌بری از تایپی که در همین فایل نیست → تطبیق نام سراسری
    const orphan: SymbolEntry = {
      ...symbols[0],
      id: 'orphan',
      name: 'Orphan',
      fileId: 'other-file',
      extends: ['Base'],
    };
    const typeGraph = new TypeGraphBuilder([...symbols, orphan]).build();
    const weak = typeGraph.find(e => e.child === 'orphan');

    expect(weak).toBeDefined();
    expect(weak!.provenance.basis).toBe('name-match');
    expect(isHighConfidence(weak!.provenance)).toBe(false);
  });

  it('an unresolved callee falls below the threshold', async () => {
    const { callGraph } = await buildGraphs();
    const unresolved = callGraph.filter(e => e.provenance.basis === 'unresolved');

    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every(e => !isHighConfidence(e.provenance))).toBe(true);
  });

  it('filtering at 70 removes edges without removing all of them', async () => {
    const { callGraph } = await buildGraphs();
    const trusted = callGraph.filter(e => isHighConfidence(e.provenance));

    expect(trusted.length).toBeGreaterThan(0);
    expect(trusted.length).toBeLessThan(callGraph.length);
  });

  it('an in-file resolution stays above the threshold', async () => {
    const { callGraph } = await buildGraphs();
    const astEdges = callGraph.filter(e => e.provenance.basis === 'ast');

    expect(astEdges.length).toBeGreaterThan(0);
    expect(astEdges.every(e => isHighConfidence(e.provenance))).toBe(true);
  });
});

describe('فضای نام مقصد وابستگی (SE-GRAPH-01)', () => {

  it('marks a package target and leaves a file target as an id', async () => {
    const { dependencyGraph } = await buildGraphs([
      { from: 'lodash', type: 'package' } as ImportEntry,
      { from: './b', type: 'local', resolvedFileId: 'f2' } as ImportEntry,
    ]);

    const toPackage = dependencyGraph.find(e => isPackageRef(e.to));
    const toFile = dependencyGraph.find(e => !isPackageRef(e.to));

    expect(toPackage?.to).toBe('pkg:lodash');
    expect(toFile?.to).toBe('f2');
  });

  it('marks a builtin as a package reference too', async () => {
    const { dependencyGraph } = await buildGraphs([
      { from: 'node:fs', type: 'builtin' } as ImportEntry,
    ]);

    expect(dependencyGraph[0].to).toBe('pkg:node:fs');
  });

  /*
  | وارداتی که local اعلام شده ولی resolve نشده، یک *حدس* است — نه
  | فایل شناخته‌شده و نه پکیج اعلام‌شده. باید پایین‌ترین اعتماد را
  | بگیرد.
  */
  it('gives an unresolved local import the lowest confidence', async () => {
    const { dependencyGraph } = await buildGraphs([
      { from: './missing', type: 'local' } as ImportEntry,
    ]);

    expect(dependencyGraph[0].provenance.basis).toBe('unresolved');
    expect(isHighConfidence(dependencyGraph[0].provenance)).toBe(false);
  });
});

describe('جهت یال معکوس typeGraph (SE-GRAPH-09)', () => {

  /*
  | حلقهٔ قبلی `from: parent, to: child` می‌گذاشت — یعنی دقیقاً همان
  | جهت یال اصلی. یک ایندکس معکوس که همان جهت را تکرار کند، به سؤالی
  | که برای آن ساخته شده جواب نمی‌دهد.
  */
  it('reverses the direction instead of repeating it', async () => {
    const { typeGraph, reverseDependencyGraph } = await buildGraphs();
    const forward = typeGraph.find(e => e.kind === 'extends');
    const reverse = reverseDependencyGraph.find(e => e.kind === 'extends');

    expect(forward).toBeDefined();
    expect(reverse).toBeDefined();
    expect(reverse!.from).toBe(forward!.child);
    expect(reverse!.to).toBe(forward!.parent);
  });
});

describe('isConditional در مرز تابع می‌ایستد (SE-GRAPH-06)', () => {

  it('does not call an unconditional call conditional', async () => {
    const source = `export function target(): number { return 1; }
if (process.env.X) {
  const run = function (): number {
    return target();
  };
  void run;
}
`;
    const result = await extractor.extract('f1', 'src/c.ts', source, 'typescript');
    if (!result.ok) throw result.error;
    fs.writeFileSync(path.join(root, 'src', 'c.ts'), source);

    const files: FileEntry[] = [{
      id: 'f1', path: 'src/c.ts', language: 'typescript', encoding: 'utf8',
      size: source.length, lines: source.split('\n').length, hash: 'h',
      modified: '2026-08-18T00:00:00.000Z', binary: false, testFile: false,
      generated: false, imports: [], exports: [],
    }];

    const edges = new CallGraphBuilder({
      workspaceRoot: root,
      files,
      symbols: result.value.symbols as SymbolEntry[],
    }).build();

    const call = edges.find(e => e.line === 4);
    expect(call?.kind).toBe('direct');
  });

  it('still marks a call that really is inside an if', async () => {
    const source = `export function target(): number { return 1; }
export function caller(): number {
  if (process.env.X) {
    return target();
  }
  return 0;
}
`;
    const result = await extractor.extract('f1', 'src/d.ts', source, 'typescript');
    if (!result.ok) throw result.error;
    fs.writeFileSync(path.join(root, 'src', 'd.ts'), source);

    const files: FileEntry[] = [{
      id: 'f1', path: 'src/d.ts', language: 'typescript', encoding: 'utf8',
      size: source.length, lines: source.split('\n').length, hash: 'h',
      modified: '2026-08-18T00:00:00.000Z', binary: false, testFile: false,
      generated: false, imports: [], exports: [],
    }];

    const edges = new CallGraphBuilder({
      workspaceRoot: root,
      files,
      symbols: result.value.symbols as SymbolEntry[],
    }).build();

    expect(edges.find(e => e.line === 4)?.kind).toBe('conditional');
  });
});

describe('SE-GRAPH-05 — عضوی که با نام سراسری پیدا شده، «قطعی» نیست', () => {
  /*
  | `findMemberSymbol` وقتی عضو را در فرزندان ریشه پیدا نمی‌کرد،
  | به `findByName(prop)` **سراسری** می‌افتاد — همان fallbackی که
  | SE-GRAPH-03 محکومش کرده بود — و فراخوان یال را با
  | `basis: 'ast'` و اعتماد ۹۵ ثبت می‌کرد.
  |
  | روی ایندکس خودِ این مخزن، این ۲٬۹۵۲ یال از ۶٬۱۲۶ یالِ «قطعی»
  | را می‌ساخت. روی fixture، یک فایل TypeScript به متدی در یک فایل
  | **جاوا** وصل شده بود، با اعتماد ۹۵.
  */
  const CALLER = `import { Helper } from './helper';

export class Service {
  private readonly items: string[] = [];

  run(): void {
    this.items.push('x');
    Helper.assist();
  }
}
`;

  const OTHER = `export class Unrelated {
  push(value: string): void { void value; }
}
`;

  async function buildWithNeighbour() {
    const callerResult = await extractor.extract('f-caller', 'src/service.ts', CALLER, 'typescript');
    const otherResult = await extractor.extract('f-other', 'src/other.ts', OTHER, 'typescript');
    if (!callerResult.ok || !otherResult.ok) throw new Error('extraction failed');

    const symbols = [
      ...(callerResult.value.symbols as SymbolEntry[]),
      ...(otherResult.value.symbols as SymbolEntry[]),
    ];

    fs.writeFileSync(path.join(root, 'src', 'service.ts'), CALLER);
    fs.writeFileSync(path.join(root, 'src', 'other.ts'), OTHER);

    const files: FileEntry[] = [
      {
        id: 'f-caller',
        path: 'src/service.ts',
        language: 'typescript',
        encoding: 'utf8',
        size: CALLER.length,
        lines: CALLER.split('\n').length,
        hash: 'h',
        modified: '2026-08-19T00:00:00.000Z',
        binary: false,
        testFile: false,
        generated: false,
        imports: [],
        exports: [],
      },
      {
        id: 'f-other',
        path: 'src/other.ts',
        language: 'typescript',
        encoding: 'utf8',
        size: OTHER.length,
        lines: OTHER.split('\n').length,
        hash: 'h',
        modified: '2026-08-19T00:00:00.000Z',
        binary: false,
        testFile: false,
        generated: false,
        imports: [],
        exports: [],
      },
    ];

    return {
      edges: new CallGraphBuilder({ workspaceRoot: root, files, symbols }).build(),
      symbols,
    };
  }

  it('یالی که از نام سراسری آمده، `name-match` است نه `ast`', async () => {
    /*
    | ⚠ نسخهٔ اول این آزمون روی `edge.callee` الگو می‌گرفت — که یک
    | **شناسه** است، نه نام. پس هیچ‌وقت با /push/ نمی‌خورد و
    | آزمون با برگرداندن اصلاح هم سبز می‌ماند. حالا مقصد به symbol
    | ترجمه می‌شود و روی *نامش* قضاوت می‌شود.
    */
    const { edges, symbols } = await buildWithNeighbour();
    const byId = new Map(symbols.map(symbol => [symbol.id, symbol]));

    const crossFile = edges.filter(edge => {
      const callee = byId.get(edge.callee);
      return callee?.name === 'push' && callee.fileId !== 'f-caller';
    });

    expect(crossFile.length).toBeGreaterThan(0);
    for (const edge of crossFile) {
      expect(edge.provenance.basis).toBe('name-match');
      expect(edge.provenance.confidence).toBeLessThan(70);
    }
  });

  it('عضو واقعیِ همان کلاس همچنان `ast` می‌ماند', async () => {
    /*
    | اصلاح نباید به افراط برود: `this.helper()` داخل `Child` یک
    | عضو واقعی است و باید قطعی بماند.
    */
    const { callGraph, symbols } = await buildGraphs();
    const helper = symbols.find(symbol => symbol.name === 'helper')!;
    const toHelper = callGraph.filter(edge => edge.callee === helper.id);

    expect(toHelper.length).toBeGreaterThan(0);
    expect(toHelper.every(edge => edge.provenance.basis === 'ast')).toBe(true);
  });
});
