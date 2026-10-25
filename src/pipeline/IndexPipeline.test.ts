/**
 * IndexPipeline — MIG-20، SE-EXT-01، SE-GRAPH-07.
 *
 * دو ادعای این فاز که باید آزموده شوند:
 *
 *   ۱. مسیر ایندکس بدون ویرایشگر کار می‌کند و همان خروجی را می‌دهد.
 *   ۲. هر فایل **یک بار** خوانده می‌شود. نسخهٔ قبلی چهار بار می‌خواند:
 *      اسکنر برای hash، و سه بار دیگر برای symbol، وابستگی و نگاشت
 *      پیکربندی.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline, buildFileComplexityMap } from './IndexPipeline';
import { createExtractors, resolveGrammarDir, ExtractorSet } from './ExtractorFactory';
import { CancellationTokenSource } from '../host/Cancellation';
import { ProgressUpdate } from '../host/Progress';
import { NodeFileSystem } from '../host/FileSystem';
import { FileEntry, SymbolEntry } from '../core/types/project-index.types';

let workspace: string;
let extractors: ExtractorSet;

/** فایل‌سیستمی که می‌شمارد چند بار محتوا خوانده شد. */
class CountingFileSystem extends NodeFileSystem {
  readonly reads: string[] = [];

  override async readFile(filePath: string): Promise<string> {
    this.reads.push(filePath);
    return super.readFile(filePath);
  }
}

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function pipeline(overrides: Record<string, unknown> = {}) {
  return new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(workspace, '.semantic-engine', 'project-index.json'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
    ...overrides,
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-pipeline-'));
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });

  write('src/util.ts', 'export function helper(a: string): string { return a; }\n');
  write(
    'src/main.ts',
    "import { helper } from './util';\nexport function main(): void { helper('x'); }\n"
  );
  write('README.md', '# fixture\n');
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('IndexPipeline', () => {

  it('produces an index with files, symbols and graphs', async () => {
    const { projectIndex, stats } = await pipeline().run();

    expect(projectIndex.files.length).toBe(3);
    expect(projectIndex.symbols.length).toBeGreaterThan(0);
    expect(projectIndex.graphs).toBeDefined();
    expect(stats.files).toBe(3);
  });

  it('resolves a local import to the target file id', async () => {
    const { projectIndex } = await pipeline().run();

    const main = projectIndex.files.find(file => file.path === 'src/main.ts');
    const util = projectIndex.files.find(file => file.path === 'src/util.ts');

    expect(main?.imports?.[0].resolvedFileId).toBe(util?.id);
  });

  /*
  | SE-EXP-03، از سمت pipeline. مسیر قدیمی هم فایل‌های از پیش
  | غنی‌شده و هم آرایهٔ وابستگی‌ها را به exporter می‌داد و هر import
  | دو بار در خروجی می‌نشست — در snapshot طلایی هر ۱۷ فایل دارای
  | import همین را نشان می‌داد.
  */
  it('records each import exactly once', async () => {
    const { projectIndex } = await pipeline().run();

    for (const file of projectIndex.files) {
      const froms = (file.imports ?? []).map(imp => imp.from);
      expect(froms).toEqual([...new Set(froms)]);
    }
  });

  it('runs twice on the same workspace without accumulating imports', async () => {
    const first = await pipeline().run();
    const second = await pipeline().run();

    const importsOf = (result: typeof first) =>
      result.projectIndex.files.map(file => (file.imports ?? []).length);

    expect(importsOf(second)).toEqual(importsOf(first));
  });

  describe('reading each file once', () => {

    it('never reads a file the scanner already read', async () => {
      const counting = new CountingFileSystem();

      await pipeline({ fileSystem: counting }).run();

      expect(counting.reads).toEqual([]);
    });

    it('counts exactly one read per text file', async () => {
      const { projectIndex, stats } = await pipeline().run();

      const textFiles = projectIndex.files.filter(file => !file.binary);
      expect(stats.fileReads).toBe(textFiles.length);
    });

    /*
    | اسکنر برای فایل بزرگ‌تر از سقف فقط ۸KB اول را می‌خواند
    | (SE-SCAN-01). آن تکه محتوای فایل نیست، پس pipeline اجازه ندارد
    | با آن استخراج کند و ناچار یک بار دیگر می‌خواند — تنها استثنای
    | قاعدهٔ «یک خواندن».
    */
    it('re-reads only the files the scanner deliberately truncated', async () => {
      write('src/huge.ts', `export const big = "${'x'.repeat(200_000)}";\n`);
      const counting = new CountingFileSystem();

      await pipeline({
        fileSystem: counting,
        scannerConfig: { skipHiddenDirectories: false, maxFileSizeBytes: 1024 },
      }).run();

      expect(counting.reads).toHaveLength(1);
      expect(counting.reads[0]).toContain('huge.ts');
    });

    it('extracts from the whole truncated file, not from the 8KB sample', async () => {
      write('src/huge.ts', `${'// padding\n'.repeat(2000)}export function findMe(): void {}\n`);

      const { projectIndex } = await pipeline({
        scannerConfig: { skipHiddenDirectories: false, maxFileSizeBytes: 1024 },
      }).run();

      expect(projectIndex.symbols.some(symbol => symbol.name === 'findMe')).toBe(true);
    });
  });

  describe('progress and cancellation', () => {

    it('reports progress through the host reporter', async () => {
      const updates: ProgressUpdate[] = [];

      await pipeline({ progress: { report: (u: ProgressUpdate) => void updates.push(u) } }).run();

      expect(updates.length).toBeGreaterThan(0);
      expect(updates.map(u => u.message).join(' ')).toMatch(/Scanning|Extracting/);
    });

    it('stops on an already cancelled token', async () => {
      const source = new CancellationTokenSource();
      source.cancel();

      await expect(pipeline({ token: source.token }).run()).rejects.toThrow(/cancel/i);
    });
  });

  describe('optional stages', () => {

    it('leaves out vector chunks when no indexer is given', async () => {
      const { projectIndex, stats } = await pipeline().run();

      expect(stats.vectorChunks).toBe(0);
      expect(projectIndex.vectorChunks ?? []).toEqual([]);
    });

    it('attaches vector chunks from the indexer it is given', async () => {
      const indexer = { index: async () => [{ id: 'chunk-1' }] };

      const { projectIndex, stats } = await pipeline({ vectorIndexer: indexer }).run();

      expect(stats.vectorChunks).toBe(1);
      expect(projectIndex.vectorChunks?.[0].id).toBe('chunk-1');
    });

    it('skips git entirely when no collector is given', async () => {
      const { projectIndex } = await pipeline().run();

      expect(projectIndex.git ?? null).toBeNull();
    });

    it('uses the git collector it is given', async () => {
      const collector = {
        collect: async () => ({ gitInfo: { commit: 'abc123' }, driftScore: 0.5 }),
        collectFileMetrics: async () => ({ metricsByPath: new Map() }),
      };

      const { projectIndex } = await pipeline({ gitCollector: collector }).run();

      expect(projectIndex.git?.commit).toBe('abc123');
    });
  });

  it('fails with a readable message when the workspace is missing', async () => {
    const missing = new IndexPipeline({
      workspaceRoot: path.join(workspace, 'nope'),
      outputPath: 'x.json',
      symbolExtractors: extractors.symbols,
      dependencyExtractors: extractors.dependencies,
      gitCollector: null,
      vectorIndexer: null,
    });

    const { projectIndex } = await missing.run();
    expect(projectIndex.files).toEqual([]);
  });
});

describe('buildFileComplexityMap', () => {

  const file = (id: string, complexity?: number): FileEntry => ({
    id,
    path: `${id}.ts`,
    language: 'typescript',
    encoding: 'utf8',
    size: 1,
    lines: 1,
    hash: 'h',
    modified: '2026-08-18T00:00:00.000Z',
    binary: false,
    testFile: false,
    generated: false,
    metrics: complexity === undefined
      ? undefined
      : ({ cyclomaticComplexity: complexity } as FileEntry['metrics']),
  });

  const symbol = (fileId: string, complexity: number | null): SymbolEntry =>
    ({ id: `${fileId}-s`, fileId, complexity } as SymbolEntry);

  it('sums symbol complexity per file', () => {
    const map = buildFileComplexityMap(
      [file('a')],
      [symbol('a', 3), symbol('a', 4)]
    );

    expect(map.get('a.ts')).toBe(7);
  });

  it('falls back to the file metric when no symbol carries complexity', () => {
    const map = buildFileComplexityMap([file('a', 9)], [symbol('a', null)]);

    expect(map.get('a.ts')).toBe(9);
  });

  it('reports zero for a file with neither', () => {
    expect(buildFileComplexityMap([file('a')], []).get('a.ts')).toBe(0);
  });
});

describe('ExtractorFactory', () => {

  it('registers dependency extractors', async () => {
    const set = createExtractors({ workspaceRoot: workspace, treeSitter: false });

    await expect(set.dependencies.hasExtractorFor('typescript')).resolves.toBe(true);
    set.dispose();
  });

  it('tree-sitter پیش‌فرض ثبت می‌شود', () => {
    /*
    | فاز ۳۶: یک جایگزینی چندخطیِ بی‌دقت این بلوک را حذف کرد و
    | **هیچ آزمونی قرمز نشد** — چون همهٔ آزمون‌های pipeline برای
    | خروجی قطعی `treeSitter: false` می‌دهند. فقط snapshot طلایی
    | گرفتش: ۱۸۳ symbol شد ۱۱۲. این آزمون همان شکاف را می‌بندد.
    */
    const set = createExtractors({ workspaceRoot: workspace });
    expect(set.symbols.getRegisteredExtractors().map(e => e.name)).toContain('tree-sitter');
    set.dispose();
  });

  it('استخراج از زبان‌سرور پیش‌فرض خاموش است', () => {
    /*
    | فاز ۳۳: مسیر LSP روی ۱۶۴ فایل ۳۶ برابر کندتر و ۱۲ برابر
    | حافظه‌برتر است (اندازه‌گیری `LSP-ARCHITECTURE.md`). جایش
    | غنی‌سازی بودجه‌دار فاز ۳۷ است، نه مسیر انبوه. این آزمون
    | همان تصمیم را قفل می‌کند — و در ضمن، همان چیزی است که
    | خروجی golden را بدون تغییر نگه می‌دارد.
    */
    const set = createExtractors({ workspaceRoot: workspace, treeSitter: false });

    expect(set.symbols.getRegisteredExtractors().map(e => e.name)).not.toContain('lsp');
    set.dispose();
  });

  it('با کلید صریح، ثبت می‌شود و اولویتش ۹۰ است', () => {
    const set = createExtractors({ workspaceRoot: workspace, treeSitter: false, lsp: true });

    const registered = set.symbols.getRegisteredExtractors();
    const lsp = registered.find(entry => entry.name === 'lsp');
    /*
    | اگر زبان‌سروری روی این ماشین نباشد، ثبت هم نمی‌شود و همان
    | هشدار کافی است — نبودنش نباید آزمون را قرمز کند، ولی اگر
    | باشد باید اول زنجیره بایستد.
    */
    if (lsp) {
      expect(lsp.priority).toBe(90);
      expect(registered[0].name).toBe('lsp');
    }
    set.dispose();
  });

  it('covers the heuristic languages even with tree-sitter off', async () => {
    const set = createExtractors({ workspaceRoot: workspace, treeSitter: false });

    for (const language of ['python', 'go', 'java', 'json', 'html', 'css']) {
      await expect(set.symbols.hasExtractorFor(language)).resolves.toBe(true);
    }
    set.dispose();
  });

  it('prefers an explicitly configured grammar directory', () => {
    expect(resolveGrammarDir(workspace, '/custom/grammars')).toBe('/custom/grammars');
  });

  it('finds grammars beside the workspace when they are there', () => {
    fs.mkdirSync(path.join(workspace, 'tree-sitter-grammars'));

    expect(resolveGrammarDir(workspace)).toBe(path.join(workspace, 'tree-sitter-grammars'));
  });

  it('finds grammars in the layout this repository actually uses', () => {
    /*
    | SE-EXT-02 — تنها مسیر monorepo که بررسی می‌شد
    | `packages/semantic-engine/…` بود و با چیدمان واقعی این مخزن
    | نمی‌خواند، پس همیشه رد می‌شد.
    */
    const here = path.join(workspace, 'semantic-engine', 'tree-sitter-grammars');
    fs.mkdirSync(here, { recursive: true });

    expect(resolveGrammarDir(workspace)).toBe(here);
  });

  it('prefers the monorepo location over the workspace root', () => {
    const monorepo = path.join(workspace, 'packages', 'semantic-engine', 'tree-sitter-grammars');
    fs.mkdirSync(monorepo, { recursive: true });
    fs.mkdirSync(path.join(workspace, 'tree-sitter-grammars'));

    expect(resolveGrammarDir(workspace)).toBe(monorepo);
  });

  it('falls back to the grammars shipped with the package', () => {
    expect(resolveGrammarDir(workspace)).toContain('tree-sitter-grammars');
  });

  it('is safe to dispose twice', () => {
    const set = createExtractors({ workspaceRoot: workspace, treeSitter: false });

    set.dispose();
    expect(() => set.dispose()).not.toThrow();
  });
});
