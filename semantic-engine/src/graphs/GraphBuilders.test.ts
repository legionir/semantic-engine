import * as path from 'path';
import * as fs from 'fs';
import { CallGraphBuilder } from './CallGraphBuilder';
import { TypeGraphBuilder } from './TypeGraphBuilder';
import { DependencyGraphBuilder } from './DependencyGraphBuilder';
import { FileEntry, SymbolEntry, ImportEntry } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';

function createFile(id: string, filePath: string, language: string): FileEntry {
  return {
    id,
    path: filePath,
    language,
    encoding: 'utf8',
    size: 100,
    lines: 10,
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

function createSymbol(
  id: string,
  fileId: string,
  kind: any,
  name: string,
  line: number,
  parentId: string | null = null
): SymbolEntry {
  return {
    id,
    fileId,
    parentId,
    kind,
    name,
    line,
    endLine: line + 5,
    source: 'lsp',
    confidence: makeConfidence(85),
  } as SymbolEntry;
}

const workspaceRoot = path.join(__dirname, '..', '..', 'tmp-graph-test');

describe('Graph builders', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'caller.ts'),
      `import { helper } from './helper';\nexport function main() { helper(); }`
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'helper.ts'),
      `export function helper() { return 1; }`
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'recursive.ts'),
      `export function recurse(n: number) { if (n > 0) recurse(n - 1); }`
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'service.ts'),
      `export class UserService {\n  getUsers(): number[] { return []; }\n}\nexport function helper() { return 1; }`
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'consumer.ts'),
      `import { UserService, helper } from './service';\nexport function main() {\n  UserService.getUsers();\n  helper();\n  if (true) { helper(); }\n  await helperAsync();\n}\nasync function helperAsync() { return helper(); }`
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'this-call.ts'),
      `export class Foo {\n  bar() { this.baz(); }\n  baz() {}\n}`
    );
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('CallGraphBuilder should create direct edges', () => {
    const file = createFile('f1', 'src/caller.ts', 'typescript');
    const caller = createSymbol('s1', 'f1', 'function', 'main', 2);
    const callee = createSymbol('s2', 'f2', 'function', 'helper', 1);

    const builder = new CallGraphBuilder({
      workspaceRoot,
      files: [file],
      symbols: [caller, callee],
    });

    const edges = builder.build();

    expect(edges.length).toBeGreaterThan(0);
    expect(edges.some(e => e.callee === 's2' || e.callee === 'helper')).toBe(true);
  });

  it('CallGraphBuilder should detect recursive calls', () => {
    const file = createFile('f1', 'src/recursive.ts', 'typescript');
    const sym = createSymbol('s1', 'f1', 'function', 'recurse', 1);

    const builder = new CallGraphBuilder({
      workspaceRoot,
      files: [file],
      symbols: [sym],
    });

    const edges = builder.build();

    const recursiveEdge = edges.find(e => e.kind === 'recursive');
    expect(recursiveEdge).toBeDefined();
  });

  it('CallGraphBuilder should resolve cross-file calls via named imports', () => {
    const serviceFile = createFile('f-service', 'src/service.ts', 'typescript');
    const serviceFileWithExports: FileEntry = {
      ...serviceFile,
      exports: [
        { name: 'UserService', kind: 'named' },
        { name: 'helper', kind: 'named' },
      ],
    };

    const consumerFile = createFile('f-consumer', 'src/consumer.ts', 'typescript');
    const consumerFileWithImports: FileEntry = {
      ...consumerFile,
      imports: [
        {
          from: './service',
          type: 'local',
          resolvedFileId: 'f-service',
          specifiers: [
            { imported: 'UserService', local: 'UserService' },
            { imported: 'helper', local: 'helper' },
          ],
        } as ImportEntry,
      ],
    };

    const serviceClass = createSymbol('s-class', 'f-service', 'class', 'UserService', 1);
    const serviceGetUsers = createSymbol('s-getUsers', 'f-service', 'method', 'getUsers', 2, 's-class');
    const serviceHelper = createSymbol('s-helper', 'f-service', 'function', 'helper', 4);
    const consumerMain = createSymbol('s-main', 'f-consumer', 'function', 'main', 2);

    const builder = new CallGraphBuilder({
      workspaceRoot,
      files: [serviceFileWithExports, consumerFileWithImports],
      symbols: [serviceClass, serviceGetUsers, serviceHelper, consumerMain],
    });

    const edges = builder.build();

    expect(edges.some(e => e.caller === 's-main' && e.callee === 's-getUsers' && e.kind === 'direct')).toBe(true);
    expect(edges.some(e => e.caller === 's-main' && e.callee === 's-helper' && e.kind === 'direct')).toBe(true);
    expect(edges.some(e => e.caller === 's-main' && e.callee === 's-helper' && e.kind === 'conditional')).toBe(true);
  });

  it('CallGraphBuilder should resolve this-method calls inside a class', () => {
    const file = createFile('f-this', 'src/this-call.ts', 'typescript');
    const fooClass = createSymbol('s-foo', 'f-this', 'class', 'Foo', 1);
    const barMethod = createSymbol('s-bar', 'f-this', 'method', 'bar', 2, 's-foo');
    const bazMethod = createSymbol('s-baz', 'f-this', 'method', 'baz', 3, 's-foo');

    const builder = new CallGraphBuilder({
      workspaceRoot,
      files: [file],
      symbols: [fooClass, barMethod, bazMethod],
    });

    const edges = builder.build();

    expect(edges.some(e => e.caller === 's-bar' && e.callee === 's-baz' && e.kind === 'direct')).toBe(true);
  });

  it('CallGraphBuilder should mark awaited calls as async', () => {
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'async-call.ts'),
      `async function main() {\n  await helper();\n}\nfunction helper() { return 1; }`
    );

    const file = createFile('f-async', 'src/async-call.ts', 'typescript');
    const main = createSymbol('s-main', 'f-async', 'function', 'main', 1);
    const helper = createSymbol('s-helper', 'f-async', 'function', 'helper', 4);

    const builder = new CallGraphBuilder({
      workspaceRoot,
      files: [file],
      symbols: [main, helper],
    });

    const edges = builder.build();

    expect(edges.some(e => e.caller === 's-main' && e.callee === 's-helper' && e.kind === 'async')).toBe(true);
  });

  it('CallGraphBuilder records `new Foo()` as a call edge (SE-GRAPH-13)', () => {
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'new-instance.ts'),
      `export class Widget {}\nexport function build() { return new Widget(); }`
    );

    const file = createFile('f-new', 'src/new-instance.ts', 'typescript');
    const widget = createSymbol('s-widget', 'f-new', 'class', 'Widget', 1);
    const build = createSymbol('s-build', 'f-new', 'function', 'build', 2);

    const builder = new CallGraphBuilder({
      workspaceRoot,
      files: [file],
      symbols: [widget, build],
    });

    const edges = builder.build();

    // `new Widget()` is not a CallExpression, yet it must link build → Widget
    // so impact/mutation stop claiming a constructed class has no callers.
    expect(edges.some(e => e.callee === 's-widget' && e.kind === 'direct')).toBe(true);
  });

  it('CallGraphBuilder resolves `this.field = new X(); this.field.m()` (SE-GRAPH-14)', () => {
    /*
    | این همان حالتی است که در `SemanticSearchTool` دیده شد:
    |     private readonly ranker = new ContextRanker();
    |     … this.ranker.rank(candidates, …)
    | زنجیره با `this` شروع می‌شود ولی متد روی **کلاسِ فیلد** است، نه روی
    | کلاس جاری. پیش از این، نامِ آخر داخل کلاس جاری گشته و یا به هیچ‌جا
    | نمی‌رسید یا به یک سمبل بی‌ربطِ هم‌نام در همان فایل وصل می‌شد؛ پس
    | `impact_analysis` caller واقعی را کم گزارش می‌کرد.
    */
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'ranker.ts'),
      `export class Ranker { rank(items: number[]): number[] { return items; } }\n`
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'search.ts'),
      `import { Ranker } from './ranker';\n` +
      `export class Search {\n` +
      `  private readonly ranker = new Ranker();\n` +
      `  search(items: number[]): number[] { return this.ranker.rank(items); }\n` +
      `}\n`
    );

    const rankerFile: FileEntry = {
      ...createFile('f-ranker', 'src/ranker.ts', 'typescript'),
      exports: [{ name: 'Ranker', kind: 'named' }],
    };
    const searchFile: FileEntry = {
      ...createFile('f-search', 'src/search.ts', 'typescript'),
      imports: [{
        from: './ranker',
        type: 'local',
        resolvedFileId: 'f-ranker',
        specifiers: [{ imported: 'Ranker', local: 'Ranker' }],
      } as ImportEntry],
    };

    const builder = new CallGraphBuilder({
      workspaceRoot,
      files: [rankerFile, searchFile],
      symbols: [
        createSymbol('s-ranker', 'f-ranker', 'class', 'Ranker', 1),
        createSymbol('s-rank', 'f-ranker', 'method', 'rank', 1, 's-ranker'),
        createSymbol('s-search-cls', 'f-search', 'class', 'Search', 2),
        createSymbol('s-ranker-field', 'f-search', 'property', 'ranker', 3, 's-search-cls'),
        createSymbol('s-search', 'f-search', 'method', 'search', 4, 's-search-cls'),
      ],
    });

    const edges = builder.build();
    const hit = edges.find(e => e.callee === 's-rank');
    expect(hit?.caller).toBe('s-search');
    // مبنای یال حدس نیست: از importِ resolve‌شده و AST همان فایل آمده
    expect(hit?.provenance.basis).not.toBe('name-match');
    expect(hit?.provenance.basis).not.toBe('unresolved');
  });

  it('a factory-initialized field does not invent a confident call edge (SE-GRAPH-14)', () => {
    /*
    | اگر فیلد با `new X()` مقدار نگرفته باشد (`makeRanker()`)، نوعش را
    | حدس نمی‌زنیم. fallbackِ موجودِ «اولین سمبل هم‌نام در کل فایل‌ها»
    | ممکن است همچنان یالی با مبنای `name-match` بسازد — رفتارِ قبلی که
    | آگاهانه نگه داشته شده — پس چیزی که این تست قفل می‌کند این است:
    | **هیچ یالِ مطمئنی** از این حدس ساخته نمی‌شود.
    */
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'factory.ts'),
      `export class Ranker { rank(items: number[]): number[] { return items; } }\n` +
      `export function makeRanker(): Ranker { return new Ranker(); }\n`
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'src', 'via-factory.ts'),
      `import { makeRanker } from './factory';\n` +
      `export class Search {\n` +
      `  private readonly ranker = makeRanker();\n` +
      `  search(items: number[]): number[] { return this.ranker.rank(items); }\n` +
      `}\n`
    );

    const factoryFile: FileEntry = {
      ...createFile('f-factory', 'src/factory.ts', 'typescript'),
      exports: [
        { name: 'Ranker', kind: 'named' },
        { name: 'makeRanker', kind: 'named' },
      ],
    };
    const viaFile: FileEntry = {
      ...createFile('f-via', 'src/via-factory.ts', 'typescript'),
      imports: [{
        from: './factory',
        type: 'local',
        resolvedFileId: 'f-factory',
        specifiers: [{ imported: 'makeRanker', local: 'makeRanker' }],
      } as ImportEntry],
    };

    const builder = new CallGraphBuilder({
      workspaceRoot,
      files: [factoryFile, viaFile],
      symbols: [
        createSymbol('s2-ranker', 'f-factory', 'class', 'Ranker', 1),
        createSymbol('s2-rank', 'f-factory', 'method', 'rank', 1, 's2-ranker'),
        createSymbol('s2-make', 'f-factory', 'function', 'makeRanker', 2),
        createSymbol('s2-search-cls', 'f-via', 'class', 'Search', 2),
        createSymbol('s2-ranker-field', 'f-via', 'property', 'ranker', 3, 's2-search-cls'),
        createSymbol('s2-search', 'f-via', 'method', 'search', 4, 's2-search-cls'),
      ],
    });

    const edges = builder.build();
    expect(
      edges.filter(e => e.callee === 's2-rank' && e.provenance.basis !== 'name-match')
    ).toHaveLength(0);
  });

  it('TypeGraphBuilder should create extends edges', () => {
    const base = createSymbol('s1', 'f1', 'class', 'Base', 1);
    const child: SymbolEntry = {
      ...createSymbol('s2', 'f1', 'class', 'Child', 2),
      extends: ['Base'],
    };

    const builder = new TypeGraphBuilder([base, child]);
    const edges = builder.build();

    expect(edges).toHaveLength(1);
    expect(edges[0]!).toMatchObject({ parent: 's1', child: 's2', kind: 'extends' });
  });

  it('DependencyGraphBuilder should build edges from imports', () => {
    const file1 = createFile('f1', 'src/a.ts', 'typescript');
    const file2 = createFile('f2', 'src/b.ts', 'typescript');
    const file1WithImports: FileEntry = {
      ...file1,
      imports: [
        { from: './b', type: 'local', resolvedFileId: 'f2' } as ImportEntry,
        { from: 'express', type: 'package' } as ImportEntry,
      ],
    };

    const builder = new DependencyGraphBuilder([file1WithImports, file2]);
    const edges = builder.build();

    expect(edges).toHaveLength(2);
    expect(edges.some(e => e.to === 'f2' && e.kind === 'import')).toBe(true);
    /*
    | SE-GRAPH-01 — تا فاز ۱۹ اینجا `'express'` بود، یعنی همان
    | آمیختنِ fileId و نام خام ماژول را به‌عنوان قرارداد ثبت کرده
    | بود. حالا هرچه فایل این پروژه نیست پیشوند `pkg:` می‌گیرد.
    */
    expect(edges.some(e => e.to === 'pkg:express' && e.kind === 'package')).toBe(true);
  });
});
