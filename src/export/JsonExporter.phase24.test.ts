/**
 * فاز ۲۴ — خروجی JSON.
 *
 *   SE-EXP-04  `outline` دقیقاً کپی `symbolIds` بود — حجم بیشتر، صفر اطلاعات
 *   SE-EXP-05  `root` مسیر مطلق را به `basename` تقلیل می‌داد و مسیر واقعی گم می‌شد
 *   SE-EXP-06  خروجی هنگام export با schema سنجیده نمی‌شد
 *   SE-EXT-03  کل محتوای کارگاه تا مرحلهٔ ساخت ایندکس در حافظه می‌ماند
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from '../pipeline/IndexPipeline';
import { createExtractors, ExtractorSet } from '../pipeline/ExtractorFactory';
import { JsonExporter } from './JsonExporter';
import { ProjectIndex } from '../core/types/project-index.types';

let workspace: string;
let extractors: ExtractorSet;

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
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-exp24-'));
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });

  write(
    'src/controller.ts',
    [
      'export class UserController {',
      '  private readonly name = "x";',
      '',
      '  get(id: string): string {',
      '    return id + this.name;',
      '  }',
      '}',
      '',
      'export function helper(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n')
  );
  write('README.md', '# fixture\n');
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('SE-EXP-04 — outline چیزی می‌گوید که symbolIds نمی‌گوید', () => {
  it('outline دیگر کپی symbolIds نیست', async () => {
    const { projectIndex } = await pipeline().run();
    const controller = projectIndex.files.find(f => f.path === 'src/controller.ts')!;

    expect(controller.symbolIds!.length).toBeGreaterThan(0);
    expect(controller.outline).not.toEqual(controller.symbolIds);
  });

  it('outline نام و نوع هر symbol را به ترتیب ظاهر شدن می‌دهد', async () => {
    const { projectIndex } = await pipeline().run();
    const controller = projectIndex.files.find(f => f.path === 'src/controller.ts')!;

    /*
    | استخراج‌گر heuristic (tree-sitter در این تست خاموش است) اعضای
    | کلاس را جدا نمی‌دهد؛ آنچه می‌دهد باید «نوع نام» باشد و هم‌ترتیب
    | با symbolIds.
    */
    expect(controller.outline).toEqual(['class UserController', 'function helper']);
    expect(controller.outline!.length).toBe(controller.symbolIds!.length);
  });

  it('ترتیب outline دقیقاً همان ترتیب symbolIds است', async () => {
    const { projectIndex } = await pipeline().run();
    const byId = new Map(projectIndex.symbols.map(sym => [sym.id, sym]));

    for (const file of projectIndex.files) {
      const expected = (file.symbolIds ?? []).map(id => {
        const sym = byId.get(id)!;
        return `${sym.kind} ${sym.name}`;
      });
      expect(file.outline).toEqual(expected);
    }
  });

  it('فایل بدون symbol، outline خالی دارد', async () => {
    const { projectIndex } = await pipeline().run();
    const readme = projectIndex.files.find(f => f.path === 'README.md')!;
    expect(readme.outline).toEqual([]);
  });

  it('هیچ ورودی outline شبیه یک شناسهٔ خام نیست', async () => {
    const { projectIndex } = await pipeline().run();
    const everyEntry = projectIndex.files.flatMap(f => f.outline ?? []);
    expect(everyEntry.length).toBeGreaterThan(0);
    for (const entry of everyEntry) {
      expect(entry).toMatch(/ /); // «نوع نام» — شناسهٔ hex فاصله ندارد
      expect(entry).not.toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe('SE-EXP-05 — مسیر کامل ریشه گم نمی‌شود', () => {
  it('root نام کوتاه می‌ماند و rootPath مسیر واقعی را نگه می‌دارد', async () => {
    const { projectIndex } = await pipeline().run();

    expect(projectIndex.root).toBe(path.basename(workspace));
    expect(projectIndex.rootPath).toBe(workspace);
    expect(path.isAbsolute(projectIndex.rootPath!)).toBe(true);
  });

  it('rootPath یک مسیر واقعاً موجود است — چیزی که root نیست', async () => {
    const { projectIndex } = await pipeline().run();

    expect(fs.existsSync(projectIndex.rootPath!)).toBe(true);
    /*
    | همین ادعا دربارهٔ `root` تنها به‌طور تصادفی برقرار می‌شود (اگر
    | فرایند در والدِ کارگاه اجرا شود). `cli.ts` همین مقدار را
    | به‌عنوان workspaceRoot به سرور MCP می‌داد.
    */
    expect(path.resolve(projectIndex.rootPath!, 'src/controller.ts')).toBe(
      path.join(workspace, 'src/controller.ts')
    );
  });
});

describe('SE-EXP-06 — خروجی پیش از نوشتن با schema سنجیده می‌شود', () => {
  it('ایندکس سالم از اعتبارسنجی رد می‌شود', () => {
    const exporter = new JsonExporter();
    const index = minimalIndex();
    expect(exporter.validate(index)).toEqual([]);
  });

  it('ایندکس ناقص، خطای دقیق با مسیر می‌دهد', () => {
    const exporter = new JsonExporter();
    const broken = { ...minimalIndex(), schemaVersion: undefined } as unknown as ProjectIndex;

    const errors = exporter.validate(broken);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/schemaVersion/);
  });

  it('نوع اشتباه در یک فایل، با مسیر همان فایل گزارش می‌شود', () => {
    const index = minimalIndex();
    const broken = {
      ...index,
      files: [{ ...index.files[0], lines: 'many' }],
    } as unknown as ProjectIndex;

    const errors = new JsonExporter().validate(broken);
    expect(errors.join(' ')).toMatch(/files\/0\/lines/);
  });

  it('نوشتن با validate روشن، روی ایندکس نامعتبر شکست می‌خورد', async () => {
    const exporter = new JsonExporter();
    const broken = { ...minimalIndex(), schemaVersion: undefined } as unknown as ProjectIndex;
    const target = path.join(workspace, 'out', 'broken.json');

    await expect(
      exporter.writeProjectIndex(broken, { outputPath: target, workspaceRoot: workspace, validate: true })
    ).rejects.toThrow(/schema/i);

    expect(fs.existsSync(target)).toBe(false);
  });

  it('export() has the same contract as writeProjectIndex(): validates first, creates the parent, writes atomically', async () => {
    const exporter = new JsonExporter();
    const scan = { files: [], diagnostics: [], root: workspace } as never;

    const spy = jest.spyOn(exporter, 'buildProjectIndex');
    const brokenTarget = path.join(workspace, 'deep', 'missing', 'parent', 'broken.json');
    spy.mockResolvedValueOnce({ ...minimalIndex(), schemaVersion: undefined } as unknown as ProjectIndex);
    await expect(
      exporter.export(scan, [], { outputPath: brokenTarget, workspaceRoot: workspace, validate: true })
    ).rejects.toThrow(/schema/i);
    expect(fs.existsSync(brokenTarget)).toBe(false);

    const okTarget = path.join(workspace, 'deep', 'missing', 'parent', 'ok.json');
    spy.mockResolvedValueOnce(minimalIndex());
    await exporter.export(scan, [], { outputPath: okTarget, workspaceRoot: workspace, validate: true });
    expect(JSON.parse(fs.readFileSync(okTarget, 'utf8')).schemaVersion).toBe('2.0.0');
    expect(fs.readdirSync(path.dirname(okTarget)).filter(n => n.includes('.tmp-'))).toEqual([]);
    spy.mockRestore();
  });

  it('خروجی واقعی pipeline از اعتبارسنجی عبور می‌کند', async () => {
    const { projectIndex } = await pipeline().run();
    expect(new JsonExporter().validate(projectIndex)).toEqual([]);
  });
});

describe('SE-EXT-03 — ساخت ایندکس دیگر به محتوای کل کارگاه نیاز ندارد', () => {
  it('buildProjectIndex بدون fileContents همان configUsages را می‌دهد', async () => {
    write('src/env.ts', 'const port = process.env.PORT;\nconst host = process.env.HOST;\n');

    const { projectIndex } = await pipeline().run();
    const env = projectIndex.files.find(f => f.path === 'src/env.ts')!;

    expect((env.configUsages ?? []).map(u => u.key).sort()).toEqual(['HOST', 'PORT']);
  });

  it('پس از ساخت ایندکس، محتوا رها می‌شود', async () => {
    const engine = pipeline();
    const { stats } = await engine.run();

    /*
    | آمار خوانده‌شدن‌ها باید همان بماند — هدف این نبود که فایل‌ها
    | دوباره خوانده شوند، بلکه این بود که محتوا تا مرحلهٔ آخر زنده
    | نماند.
    */
    expect(stats.fileReads).toBeGreaterThan(0);
    expect(engine.releasedContent).toBe(true);
  });

  it('SE-EXT-09 — اندازه‌گیریِ اوج، عددِ واقعی است نه صفرِ همیشگی', async () => {
    /*
    | نسخهٔ قبلی این آزمون `expect(engine.retainedContentBytes()).toBe(0)`
    | بود و همیشه سبز می‌ماند — نه چون حافظه آزاد شده بود، بلکه چون
    | خودِ اندازه‌گیری **بعد** از `contents.clear()` اجرا می‌شد و روی
    | یک map خالی می‌چرخید. یعنی آزمون، پاک شدنِ مپ را با آزاد شدنِ
    | حافظه اشتباه گرفته بود و هر رگرسیونی را هم سبز نشان می‌داد.
    |
    | حالا عدد، اوجِ واقعیِ متنِ زنده است و باید مثبت باشد؛ رها شدن
    | را `releasedContent` می‌گوید.
    */
    write('src/big.ts', 'export const x = 1;\n'.repeat(200));

    const engine = pipeline();
    await engine.run();

    expect(engine.retainedContentBytes).toBeGreaterThan(0);
    expect(engine.releasedContent).toBe(true);
  });
});

function minimalIndex(): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    rootPath: '/tmp/fixture',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files: [
      {
        id: 'f1',
        path: 'a.ts',
        language: 'typescript',
        encoding: 'utf8',
        size: 10,
        lines: 2,
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
      },
    ],
    symbols: [],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: 1,
      totalLoc: 2,
      totalSymbols: 0,
      avgCyclomaticComplexity: 0,
      languageBreakdown: { typescript: 1 },
    },
  } as ProjectIndex;
}

describe('SE-SCAN-17 — موتور خروجی خودش را ایندکس نمی‌کند', () => {
  /*
  | فهرست پیش‌فرض ignore نام `.semantic-engine` را هاردکد داشت. با هر
  | مسیر خروجی دیگری، اسکن دوم خروجی اسکن اول را برمی‌داشت و ایندکس،
  | نسخهٔ قبلی خودش را در بر می‌گرفت.
  */
  it('پوشهٔ خروجیِ غیرمخفی هم نادیده گرفته می‌شود', async () => {
    const outputDir = path.join(workspace, 'index-out');
    const engine = () =>
      new IndexPipeline({
        workspaceRoot: workspace,
        outputPath: path.join(outputDir, 'project-index.json'),
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        scannerConfig: { skipHiddenDirectories: false },
        gitCollector: null,
        vectorIndexer: null,
      });

    const first = await engine().run();
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'project-index.json'),
      JSON.stringify(first.projectIndex)
    );

    const second = await engine().run();
    const paths = second.projectIndex.files.map(f => f.path);

    expect(paths).not.toContain('index-out/project-index.json');
    expect(paths).toContain('src/controller.ts');
  });

  it('an output nested under a source directory ignores only that directory, not its siblings (audit F-16)', async () => {
    const outputDir = path.join(workspace, 'src', 'generated-index');
    const run = () =>
      new IndexPipeline({
        workspaceRoot: workspace,
        outputPath: path.join(outputDir, 'project-index.json'),
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        scannerConfig: { skipHiddenDirectories: false },
        gitCollector: null,
        vectorIndexer: null,
      }).run();

    const first = await run();
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'project-index.json'), JSON.stringify(first.projectIndex));
    fs.writeFileSync(path.join(outputDir, 'note.ts'), 'export const inOutput = 1;\n');

    const second = await run();
    const paths = second.projectIndex.files.map(f => f.path);

    expect(paths).toContain('src/controller.ts'); // sibling of the output dir is still indexed
    expect(paths.filter(f => f.startsWith('src/generated-index/'))).toEqual([]);
    expect(paths.length).toBe(first.projectIndex.files.length);
  });

  it('خروجی بیرون از کارگاه، چیزی را از اسکن حذف نمی‌کند', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'se-out24-'));
    try {
      const { projectIndex } = await new IndexPipeline({
        workspaceRoot: workspace,
        outputPath: path.join(outside, 'project-index.json'),
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        scannerConfig: { skipHiddenDirectories: false },
        gitCollector: null,
        vectorIndexer: null,
      }).run();

      expect(projectIndex.files.map(f => f.path)).toContain('src/controller.ts');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
