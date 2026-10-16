/**
 * فاز ۲۵ — صحت مسیر incremental.
 *
 *   SE-INC-01  شناسهٔ فایل پس از rename + restart دوتا می‌شد
 *   SE-INC-03  یال‌های مرده در call graph
 *   SE-INC-05  بردارهای فایل حذف‌شده باقی می‌ماندند
 *   SE-INC-06  فقط وابستهٔ مستقیم — و آن هم فقط اگر import می‌کرد، نه re-export
 *   SE-INC-09  نوشتن روی شیء readonly با cast
 *   SE-INC-11  `removeFile` آرایهٔ symbols را همگام نمی‌کرد
 *   SE-INC-12  `reverseDependencyGraph` در هر به‌روزرسانی گم می‌شد
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from '../pipeline/IndexPipeline';
import { createExtractors, ExtractorSet } from '../pipeline/ExtractorFactory';
import { IncrementalEngine } from './IncrementalEngine';
import { ProjectIndexStore } from './ProjectIndexStore';
import { ProjectIndex } from '../core/types/project-index.types';

let workspace: string;
let extractors: ExtractorSet;

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function fullIndex(): Promise<ProjectIndex> {
  const result = await new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(workspace, '.semantic-engine', 'project-index.json'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
  }).run();
  return result.projectIndex;
}

function engine(): IncrementalEngine {
  return new IncrementalEngine({
    workspaceRoot: workspace,
    symbolExtractorManager: extractors.symbols,
    dependencyExtractorManager: extractors.dependencies,
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-inc25-'));
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('SE-INC-01 — شناسهٔ فایل پس از rename پایدار می‌ماند', () => {
  it('یک restart بعد از rename، فایل را دوتا نمی‌کند', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    write('src/keep.ts', 'export const k = 2;\n');

    const index = await fullIndex();
    const originalId = index.files.find(f => f.path === 'src/a.ts')!.id;

    const first = engine();
    first.load(index);
    fs.renameSync(path.join(workspace, 'src/a.ts'), path.join(workspace, 'src/b.ts'));
    const renamed = await first.applyChanges([
      { type: 'renamed', path: 'src/b.ts', oldPath: 'src/a.ts' },
    ]);

    expect(renamed.projectIndex.files.find(f => f.path === 'src/b.ts')!.id).toBe(originalId);

    /*
    | «restart»: یک engine تازه که همان ایندکس ذخیره‌شده را می‌خواند.
    | `load()` کش شناسه را با `getId(path)` می‌ساخت، که دوباره hash
    | مسیر را حساب می‌کند و به شناسهٔ ذخیره‌شده نگاه نمی‌کند.
    */
    const second = engine();
    second.load(renamed.projectIndex);
    write('src/b.ts', 'export const a = 99;\n');
    const edited = await second.applyChanges([{ type: 'modified', path: 'src/b.ts' }]);

    const entries = edited.projectIndex.files.filter(f => f.path === 'src/b.ts');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(originalId);
  });

  it('شناسه‌ها در ایندکس یکتا می‌مانند', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    const index = await fullIndex();

    const first = engine();
    first.load(index);
    fs.renameSync(path.join(workspace, 'src/a.ts'), path.join(workspace, 'src/b.ts'));
    const renamed = await first.applyChanges([
      { type: 'renamed', path: 'src/b.ts', oldPath: 'src/a.ts' },
    ]);

    const second = engine();
    second.load(renamed.projectIndex);
    write('src/b.ts', 'export const a = 2;\n');
    const edited = await second.applyChanges([{ type: 'modified', path: 'src/b.ts' }]);

    const ids = edited.projectIndex.files.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('SE-F-028 — rename هم‌محتوا symbolها را زنده نگه می‌دارد (parity با rebuild)', async () => {
    write('src/a.ts', 'export const a = 1;\nexport function fn() { return a; }\n');
    write('src/keep.ts', 'export const k = 2;\n');

    const index = await fullIndex();
    const aSymbols = index.symbols.filter(s => s.fileId === index.files.find(f => f.path === 'src/a.ts')!.id);
    expect(aSymbols.length).toBeGreaterThan(0);

    const first = engine();
    first.load(index);
    fs.renameSync(path.join(workspace, 'src/a.ts'), path.join(workspace, 'src/b.ts'));
    const renamed = await first.applyChanges([
      { type: 'renamed', path: 'src/b.ts', oldPath: 'src/a.ts' },
    ]);

    /*
    | مسیر هم‌محتوا قبلاً `removeFile` + `upsertFile` می‌کرد؛
    | `removeFile` symbolها را پاک می‌کرد و هیچ re-extract نداشت، پس
    | فایل در index می‌ماند ولی بی‌symbol — برخلاف rebuild کامل.
    | `renameFile` باید مسیر را عوض کند و symbolها را نگه دارد.
    */
    const renamedFile = renamed.projectIndex.files.find(f => f.path === 'src/b.ts')!;
    const surviving = renamed.projectIndex.symbols.filter(s => s.fileId === renamedFile.id);
    expect(surviving.map(s => s.id).sort()).toEqual(aSymbols.map(s => s.id).sort());
    expect((renamedFile.symbolIds ?? []).length).toBe(aSymbols.length);

    /* parity: incremental-after-rename == full rebuild of the renamed tree */
    const rebuilt = await fullIndex();
    const rebuiltIds = rebuilt.symbols
      .filter(s => s.fileId === rebuilt.files.find(f => f.path === 'src/b.ts')!.id)
      .map(s => s.name)
      .sort();
    expect(surviving.map(s => s.name).sort()).toEqual(rebuiltIds);
  });
});

describe('SE-INC-11 — removeFile آرایهٔ symbols را هم همگام می‌کند', () => {
  it('symbol فایل حذف‌شده بلافاصله از آرایه می‌رود', () => {
    const store = new ProjectIndexStore(handmadeIndex());

    expect(store.projectIndex.symbols.map(s => s.id)).toEqual(['sA', 'sB']);
    store.removeFile('fA');

    /*
    | `removeFile` فقط `symbolsByFileId` و `syncFilesArray` را
    | می‌زد. آرایهٔ `symbols` دست‌نخورده می‌ماند، پس store در یک حالت
    | ناسازگار بود: فایلی که نیست، symbol دارد.
    */
    expect(store.projectIndex.files.map(f => f.id)).toEqual(['fB']);
    expect(store.projectIndex.symbols.map(s => s.id)).toEqual(['sB']);
    expect(store.getAllSymbols().map(s => s.id)).toEqual(['sB']);
  });

  it('هیچ symbolی بدون فایلِ متناظر باقی نمی‌ماند', () => {
    const store = new ProjectIndexStore(handmadeIndex());
    store.removeFile('fA');

    const fileIds = new Set(store.projectIndex.files.map(f => f.id));
    const orphans = store.projectIndex.symbols.filter(s => !fileIds.has(s.fileId));
    expect(orphans).toEqual([]);
  });
});

describe('SE-INC-03 — یال مرده باقی نمی‌ماند', () => {
  it('حذف فایل، هیچ یال معلقی در call graph نمی‌گذارد', async () => {
    write('src/globals.ts', 'export function globalHelper(): number { return 1; }\n');
    write('src/user.ts', 'export function useIt(): number {\n  return globalHelper();\n}\n');

    const index = await fullIndex();
    expect(index.graphs.callGraph.length).toBeGreaterThan(0);

    const incremental = engine();
    incremental.load(index);
    fs.rmSync(path.join(workspace, 'src/globals.ts'));
    const { projectIndex } = await incremental.applyChanges([
      { type: 'deleted', path: 'src/globals.ts' },
    ]);

    const symbolIds = new Set(projectIndex.symbols.map(s => s.id));
    const dangling = projectIndex.graphs.callGraph.filter(
      edge => edge.provenance.basis !== 'unresolved' && !symbolIds.has(edge.callee)
    );
    expect(dangling).toEqual([]);
  });

  it('یال type graph هم به symbol ناموجود اشاره نمی‌کند', async () => {
    write('src/base.ts', 'export interface Base { a: number; }\n');
    write('src/impl.ts', "import { Base } from './base';\nexport class Impl implements Base { a = 1; }\n");

    const index = await fullIndex();
    const incremental = engine();
    incremental.load(index);
    fs.rmSync(path.join(workspace, 'src/base.ts'));
    const { projectIndex } = await incremental.applyChanges([
      { type: 'deleted', path: 'src/base.ts' },
    ]);

    const symbolIds = new Set(projectIndex.symbols.map(s => s.id));
    const dangling = projectIndex.graphs.typeGraph.filter(
      edge => !symbolIds.has(edge.parent) || !symbolIds.has(edge.child)
    );
    expect(dangling).toEqual([]);
  });
});

describe('SE-INC-05 — بردارهای فایل حذف‌شده پاک می‌شوند', () => {
  it('chunk فایل حذف‌شده باقی نمی‌ماند', async () => {
    write('src/util.ts', 'export function helper(): number { return 1; }\n');
    write('src/main.ts', 'export function main(): number { return 2; }\n');

    const base = await fullIndex();
    const util = base.files.find(f => f.path === 'src/util.ts')!;
    const main = base.files.find(f => f.path === 'src/main.ts')!;
    const withChunks: ProjectIndex = {
      ...base,
      vectorChunks: [
        { id: 'vc-util', fileId: util.id, unit: 'function', content: 'x', startLine: 1, endLine: 1, tokenEstimate: 1 },
        { id: 'vc-main', fileId: main.id, unit: 'function', content: 'y', startLine: 1, endLine: 1, tokenEstimate: 1 },
      ],
    } as ProjectIndex;

    const incremental = engine();
    incremental.load(withChunks);
    fs.rmSync(path.join(workspace, 'src/util.ts'));
    const { projectIndex } = await incremental.applyChanges([
      { type: 'deleted', path: 'src/util.ts' },
    ]);

    const fileIds = new Set(projectIndex.files.map(f => f.id));
    const orphans = (projectIndex.vectorChunks ?? []).filter(c => !fileIds.has(c.fileId));
    expect(orphans).toEqual([]);
    expect((projectIndex.vectorChunks ?? []).map(c => c.id)).toEqual(['vc-main']);
  });

  it('chunk فایل‌های دست‌نخورده حفظ می‌شود', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    write('src/b.ts', 'export const b = 2;\n');

    const base = await fullIndex();
    const a = base.files.find(f => f.path === 'src/a.ts')!;
    const withChunks: ProjectIndex = {
      ...base,
      vectorChunks: [
        { id: 'vc-a', fileId: a.id, unit: 'module', content: 'x', startLine: 1, endLine: 1, tokenEstimate: 1 },
      ],
    } as ProjectIndex;

    const incremental = engine();
    incremental.load(withChunks);
    write('src/b.ts', 'export const b = 3;\n');
    const { projectIndex } = await incremental.applyChanges([
      { type: 'modified', path: 'src/b.ts' },
    ]);

    expect((projectIndex.vectorChunks ?? []).map(c => c.id)).toEqual(['vc-a']);
  });
});

describe('SE-INC-06 — وابسته‌ها از گراف می‌آیند، نه فقط از imports', () => {
  it('فایل barrel که re-export می‌کند، وابسته شمرده می‌شود', async () => {
    write('src/core.ts', 'export function core(): number { return 1; }\n');
    write('src/index.ts', "export { core } from './core';\n");
    write('src/app.ts', "import { core } from './index';\nexport function app(): number { return core(); }\n");

    const index = await fullIndex();
    const store = new ProjectIndexStore(index);
    const coreId = index.files.find(f => f.path === 'src/core.ts')!.id;

    /*
    | `getDirectDependents` فقط `file.imports` را نگاه می‌کرد. یک
    | barrel با `export { x } from './y'` هیچ import ندارد — فقط یک
    | export با `reExportFrom`. پس در نگاه store، هیچ‌کس به core
    | وابسته نبود.
    */
    const direct = store.getDirectDependents(coreId).map(f => f.path);
    expect(direct).toContain('src/index.ts');
  });

  it('وابستهٔ ترانزیتیو از پشت barrel هم پیدا می‌شود', async () => {
    write('src/core.ts', 'export function core(): number { return 1; }\n');
    write('src/index.ts', "export { core } from './core';\n");
    write('src/app.ts', "import { core } from './index';\nexport function app(): number { return core(); }\n");

    const index = await fullIndex();
    const store = new ProjectIndexStore(index);
    const coreId = index.files.find(f => f.path === 'src/core.ts')!.id;

    const transitive = store.getTransitiveDependents(coreId).map(f => f.path).sort();
    expect(transitive).toEqual(['src/app.ts', 'src/index.ts']);
  });

  it('چرخهٔ وابستگی، پیمایش را بی‌نهایت نمی‌کند', async () => {
    write('src/x.ts', "import { y } from './y';\nexport const x = y;\n");
    write('src/y.ts', "import { x } from './x';\nexport const y = x;\n");

    const index = await fullIndex();
    const store = new ProjectIndexStore(index);
    const xId = index.files.find(f => f.path === 'src/x.ts')!.id;

    const transitive = store.getTransitiveDependents(xId).map(f => f.path);
    expect(transitive).toEqual(['src/y.ts']);
  });

  it('تغییر core، هم barrel و هم مصرف‌کننده را بازپردازش می‌کند', async () => {
    write('src/core.ts', 'export function core(): number { return 1; }\n');
    write('src/index.ts', "export { core } from './core';\n");
    write('src/app.ts', "import { core } from './index';\nexport function app(): number { return core(); }\n");

    const index = await fullIndex();
    const byId = new Map(index.files.map(f => [f.id, f.path]));

    const incremental = engine();
    incremental.load(index);
    write('src/core.ts', 'export function core(): number { return 2; }\n');
    const result = await incremental.applyChanges([{ type: 'modified', path: 'src/core.ts' }]);

    const reprocessed = result.dependentFileIds.map(id => byId.get(id)).sort();
    expect(reprocessed).toEqual(['src/app.ts', 'src/index.ts']);
  });
});

describe('SE-INC-12 — reverseDependencyGraph گم نمی‌شود', () => {
  it('به‌روزرسانی افزایشی گراف معکوس را نگه می‌دارد', async () => {
    write('src/util.ts', 'export function helper(): number { return 1; }\n');
    write('src/main.ts', "import { helper } from './util';\nexport function main(): number { return helper(); }\n");

    const index = await fullIndex();
    expect((index.graphs.reverseDependencyGraph ?? []).length).toBeGreaterThan(0);

    const incremental = engine();
    incremental.load(index);
    write('src/main.ts', "import { helper } from './util';\nexport function main(): number { return helper() + 1; }\n");
    const { projectIndex } = await incremental.applyChanges([
      { type: 'modified', path: 'src/main.ts' },
    ]);

    expect((projectIndex.graphs.reverseDependencyGraph ?? []).length).toBeGreaterThan(0);
  });

  it('گراف معکوس با گراف مستقیم می‌خواند', async () => {
    write('src/util.ts', 'export function helper(): number { return 1; }\n');
    write('src/main.ts', "import { helper } from './util';\nexport function main(): number { return helper(); }\n");

    const index = await fullIndex();
    const incremental = engine();
    incremental.load(index);
    write('src/main.ts', "import { helper } from './util';\nexport const main = helper;\n");
    const { projectIndex } = await incremental.applyChanges([
      { type: 'modified', path: 'src/main.ts' },
    ]);

    /*
    | گراف معکوس فقط وارونهٔ dependencyGraph نیست — با
    | `includeSymbolLevel` یال‌های call و type را هم وارونه می‌کند.
    | چیزی که باید برقرار باشد این است که هر یال وابستگیِ مستقیم،
    | معکوسش را هم داشته باشد.
    */
    const forward = projectIndex.graphs.dependencyGraph.map(e => `${e.from}->${e.to}`);
    const reverse = new Set(
      (projectIndex.graphs.reverseDependencyGraph ?? []).map(e => `${e.to}->${e.from}`)
    );

    expect(forward.length).toBeGreaterThan(0);
    for (const edge of forward) expect(reverse.has(edge)).toBe(true);
  });
});

describe('SE-INC-09 — قرارداد immutability شکسته نمی‌شود', () => {
  it('store روی شیء ورودی نمی‌نویسد', () => {
    const original = handmadeIndex();
    const frozen = Object.freeze({ ...original, files: Object.freeze([...original.files]) });

    const store = new ProjectIndexStore(frozen as ProjectIndex);
    expect(() => store.removeFile('fA')).not.toThrow();

    // شیء اصلی دست‌نخورده مانده است
    expect(original.files.map(f => f.id)).toEqual(['fA', 'fB']);
    expect(store.projectIndex.files.map(f => f.id)).toEqual(['fB']);
  });

  it('هر upsert یک شیء تازه می‌سازد، نه جهش روی قبلی', () => {
    const store = new ProjectIndexStore(handmadeIndex());
    const before = store.projectIndex;

    store.upsertFile({ ...before.files[0]!, lines: 42 });

    expect(store.projectIndex).not.toBe(before);
    expect(before.files.find(f => f.id === 'fA')!.lines).not.toBe(42);
  });
});

function handmadeIndex(): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files: [
      { id: 'fA', path: 'a.ts', language: 'typescript', encoding: 'utf8', size: 1, lines: 1, hash: 'ha', modified: '', binary: false, testFile: false, generated: false, imports: [], exports: [] },
      { id: 'fB', path: 'b.ts', language: 'typescript', encoding: 'utf8', size: 1, lines: 1, hash: 'hb', modified: '', binary: false, testFile: false, generated: false, imports: [], exports: [] },
    ],
    symbols: [
      { id: 'sA', fileId: 'fA', parentId: null, kind: 'function', name: 'a', line: 1, endLine: 1 },
      { id: 'sB', fileId: 'fB', parentId: null, kind: 'function', name: 'b', line: 1, endLine: 1 },
    ],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] },
    diagnostics: [],
    metrics: { totalFiles: 2, totalLoc: 2, totalSymbols: 2, avgCyclomaticComplexity: 0, languageBreakdown: {} },
  } as unknown as ProjectIndex;
}
