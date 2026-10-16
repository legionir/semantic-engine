/**
 * فاز ۲۸ — watcher مستقل.
 *
 *   MIG-40      جایگزینی `createFileSystemWatcher` با chokidar
 *   MIG-41      بازسازی rename از `unlink` + `add`
 *   MIG-42      یکی‌کردن منطق ignore با `ScannerConfig`
 *   SE-SCAN-03  watcher فهرست ignore خودش را داشت — `dist/` رصد می‌شد
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher } from './FileWatcher';
import { IgnoreMatcher } from '../core/config/IgnoreMatcher';
import { createScannerConfig } from '../core/config/ScannerConfig';
import { FileChangeEvent } from '../core/types/common.types';

let workspace: string;
let watcher: FileWatcher | null = null;

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const settle = (ms = 320): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-watch28-'));
  write('src/a.ts', 'export const a = 1;\n');
  write('dist/out.js', 'module.exports = 1;\n');
  write('node_modules/pkg/index.js', 'module.exports = 2;\n');
});

afterEach(async () => {
  await watcher?.close();
  watcher = null;
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function start(
  options: Partial<ConstructorParameters<typeof FileWatcher>[0]> = {}
): Promise<FileChangeEvent[]> {
  const seen: FileChangeEvent[] = [];
  watcher = new FileWatcher({
    workspaceRoot: workspace,
    onEvent: event => seen.push(event),
    // پنجرهٔ کوتاه، تا تست‌ها معطل نمانند
    renameWindowMs: 200,
    stabilityThresholdMs: 30,
    ...options,
  });
  await watcher.start();
  return seen;
}

describe('MIG-42 / SE-SCAN-03 — watcher همان ignore اسکنر را دارد', () => {
  it('ویرایش فایل در dist/ هیچ رویدادی تولید نمی‌کند', async () => {
    const seen = await start();

    write('dist/out.js', 'module.exports = 99;\n');
    write('node_modules/pkg/index.js', 'module.exports = 99;\n');
    await settle();

    expect(seen).toEqual([]);
  });

  it('ویرایش فایل واقعی رویداد می‌دهد', async () => {
    const seen = await start();

    write('src/a.ts', 'export const a = 2;\n');
    await settle();

    expect(seen.map(e => `${e.type}:${e.path}`)).toEqual(['modified:src/a.ts']);
  });

  it('پوشهٔ خروجی هم رصد نمی‌شود', async () => {
    const seen = await start({ outputDir: path.join(workspace, 'index-out') });

    write('index-out/project-index.json', '{}\n');
    await settle();

    expect(seen).toEqual([]);
  });

  it('همان تصمیمی را می‌گیرد که اسکنر می‌گیرد', () => {
    /*
    | SE-SCAN-03: `shouldWatch` در `extension.ts` فهرست خودش را داشت —
    | فقط `node_modules`, `.git`, `.semantic-engine`, `.vscode`. یعنی
    | watcher فایل‌های `dist/` و `build/` و `coverage/` را می‌دید و
    | incremental آن‌ها را به ایندکس اضافه می‌کرد، در حالی که اسکن
    | کامل هرگز نمی‌دیدشان. ایندکس به‌مرور با خروجی build آلوده
    | می‌شد و اسکن کامل بعدی ناگهان همه را حذف می‌کرد.
    */
    const matcher = new IgnoreMatcher({
      workspaceRoot: workspace,
      config: createScannerConfig(),
    });

    expect(matcher.ignoresPath('dist/out.js')).toBe(true);
    expect(matcher.ignoresPath('build/x.js')).toBe(true);
    expect(matcher.ignoresPath('coverage/lcov.info')).toBe(true);
    expect(matcher.ignoresPath('node_modules/pkg/index.js')).toBe(true);
    expect(matcher.ignoresPath('.git/config')).toBe(true);
    expect(matcher.ignoresPath('src/a.ts')).toBe(false);
  });

  it('gitignore کارگاه هم رعایت می‌شود', () => {
    write('.gitignore', 'secret/\n*.log\n');
    const matcher = new IgnoreMatcher({
      workspaceRoot: workspace,
      config: createScannerConfig(),
    });

    expect(matcher.ignoresPath('secret/keys.ts')).toBe(true);
    expect(matcher.ignoresPath('app.log')).toBe(true);
    expect(matcher.ignoresPath('src/a.ts')).toBe(false);
  });
});

describe('MIG-41 — rename از unlink + add بازسازی می‌شود', () => {
  /*
  | فایلِ رفته دیگر روی دیسک نیست، پس نمی‌شود hashش کرد. تطبیق تنها
  | وقتی ممکن است که hash *ذخیره‌شده* در دسترس باشد — که در عمل از
  | ایندکس می‌آید. این‌جا از یک عکس فوری قبل از شروع ساخته می‌شود.
  */
  function hashSnapshot(): (relativePath: string) => string | undefined {

    const { sha256 } = require('../core/utils/hash') as { sha256: (b: Buffer) => string };
    const table = new Map<string, string>();

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else table.set(path.relative(workspace, full).split(path.sep).join('/'),
                       sha256(fs.readFileSync(full)));
      }
    };
    walk(workspace);

    return relativePath => table.get(relativePath);
  }

  it('جابه‌جایی فایل، یک رویداد renamed می‌دهد', async () => {
    const seen = await start({ previousHash: hashSnapshot() });

    fs.renameSync(path.join(workspace, 'src/a.ts'), path.join(workspace, 'src/b.ts'));
    await settle(500);

    expect(seen.map(e => `${e.type}:${e.oldPath ?? ''}→${e.path}`)).toEqual([
      'renamed:src/a.ts→src/b.ts',
    ]);
  });

  it('حذف واقعی، renamed گزارش نمی‌شود', async () => {
    const seen = await start({ previousHash: hashSnapshot() });

    fs.rmSync(path.join(workspace, 'src/a.ts'));
    await settle(500);

    expect(seen.map(e => e.type)).toEqual(['deleted']);
  });

  it('ساخت واقعی هم renamed گزارش نمی‌شود', async () => {
    const seen = await start();

    write('src/new.ts', 'export const n = 1;\n');
    await settle(500);

    expect(seen.map(e => `${e.type}:${e.path}`)).toEqual(['created:src/new.ts']);
  });

  it('two files with identical content: both deletions are reported (none overwritten)', async () => {
    write('src/twin1.ts', 'export const same = 1;\n');
    write('src/twin2.ts', 'export const same = 1;\n');
    const seen = await start({ previousHash: hashSnapshot() });

    fs.rmSync(path.join(workspace, 'src/twin1.ts'));
    fs.rmSync(path.join(workspace, 'src/twin2.ts'));
    await settle(600);

    expect(seen.map(e => `${e.type}:${e.path}`).sort()).toEqual(['deleted:src/twin1.ts', 'deleted:src/twin2.ts']);
  });

  it('two identical-content files renamed at once: two rename events, no lost file', async () => {
    write('src/twin1.ts', 'export const same = 1;\n');
    write('src/twin2.ts', 'export const same = 1;\n');
    const seen = await start({ previousHash: hashSnapshot() });

    fs.renameSync(path.join(workspace, 'src/twin1.ts'), path.join(workspace, 'src/moved1.ts'));
    fs.renameSync(path.join(workspace, 'src/twin2.ts'), path.join(workspace, 'src/moved2.ts'));
    await settle(700);

    const renamed = seen.filter(e => e.type === 'renamed');
    expect(renamed).toHaveLength(2);
    expect(renamed.map(e => e.path).sort()).toEqual(['src/moved1.ts', 'src/moved2.ts']);
    expect(renamed.map(e => e.oldPath).sort()).toEqual(['src/twin1.ts', 'src/twin2.ts']);
    expect(seen.filter(e => e.type !== 'renamed')).toEqual([]);
  });

  it('two identical-content files created at once: both creations are reported', async () => {
    const seen = await start();
    write('src/new1.ts', 'export const n = 1;\n');
    write('src/new2.ts', 'export const n = 1;\n');
    await settle(700);
    expect(seen.map(e => `${e.type}:${e.path}`).sort()).toEqual(['created:src/new1.ts', 'created:src/new2.ts']);
  });

  it('فایلی که با محتوای متفاوت جایگزین شود، rename نیست', async () => {
    const seen = await start({ previousHash: hashSnapshot() });

    fs.rmSync(path.join(workspace, 'src/a.ts'));
    write('src/other.ts', 'export const totally = "different";\n');
    await settle(500);

    const kinds = seen.map(e => e.type).sort();
    expect(kinds).toEqual(['created', 'deleted']);
  });

  it('بدون hash قبلی، صریحاً به delete+create تنزل می‌کند', async () => {
    /*
    | MIGRATION هشدار داده بود: «رفتار قابل پیش‌بینی بهتر از رفتار
    | نصفه‌کاره است». بدون hash ذخیره‌شده هیچ راهی برای تطبیق نیست،
    | پس حدس زده نمی‌شود.
    */
    const seen = await start(); // بدون previousHash

    fs.renameSync(path.join(workspace, 'src/a.ts'), path.join(workspace, 'src/b.ts'));
    await settle(500);

    expect(seen.map(e => e.type).sort()).toEqual(['created', 'deleted']);
    expect(seen.some(e => e.type === 'renamed')).toBe(false);
  });

  it('خارج از پنجره، جفت نمی‌شوند', async () => {
    const seen = await start({ renameWindowMs: 30, previousHash: hashSnapshot() });

    const body = fs.readFileSync(path.join(workspace, 'src/a.ts'));
    fs.rmSync(path.join(workspace, 'src/a.ts'));
    await settle(300);
    fs.writeFileSync(path.join(workspace, 'src/late.ts'), body);
    await settle(400);

    const kinds = seen.map(e => e.type).sort();
    expect(kinds).toEqual(['created', 'deleted']);
  });
});

describe('MIG-40 — چرخهٔ عمر watcher', () => {
  it('close دوباره بی‌خطر است', async () => {
    await start();
    await watcher!.close();
    await expect(watcher!.close()).resolves.toBeUndefined();
  });

  it('پس از close هیچ رویدادی نمی‌آید', async () => {
    const seen = await start();
    await watcher!.close();

    write('src/a.ts', 'export const a = 3;\n');
    await settle();

    expect(seen).toEqual([]);
  });

  it('رویدادهای موجود در شروع دوباره گزارش نمی‌شوند', async () => {
    const seen = await start();
    await settle();
    expect(seen).toEqual([]);
  });

  it('مسیرها نسبی و با اسلش رو به جلو هستند', async () => {
    const seen = await start();

    write('src/deep/nested/file.ts', 'export const d = 1;\n');
    await settle(500);

    expect(seen.map(e => e.path)).toEqual(['src/deep/nested/file.ts']);
    for (const event of seen) {
      expect(path.isAbsolute(event.path)).toBe(false);
      expect(event.path).not.toContain('\\');
    }
  });
});

/**
 * ترکیب کامل: watcher واقعی → WatchPipeline → ایندکس روی دیسک.
 *
 * تا اینجا هر تکه جدا آزموده شده. این تست همان چیزی است که کاربر
 * واقعاً اجرا می‌کند.
 */
describe('فاز ۲۸ — watcher و pipeline با هم', () => {

  const { IndexPipeline } = require('../pipeline/IndexPipeline');

  const { WatchPipeline } = require('../pipeline/WatchPipeline');

  const { createExtractors } = require('../pipeline/ExtractorFactory');

  const { IncrementalEngine } = require('../incremental/IncrementalEngine');

  it('ویرایش یک فایل تا ایندکس روی دیسک می‌رسد، و dist/ نمی‌رسد', async () => {
    const outputDir = path.join(workspace, '.semantic-engine');
    const extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });

    try {
      const { projectIndex } = await new IndexPipeline({
        workspaceRoot: workspace,
        outputPath: path.join(outputDir, 'project-index.json'),
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        gitCollector: null,
        vectorIndexer: null,
      }).run();

      const engine = new IncrementalEngine({
        workspaceRoot: workspace,
        symbolExtractorManager: extractors.symbols,
        dependencyExtractorManager: extractors.dependencies,
      });
      engine.load(projectIndex);

      const pipeline = new WatchPipeline({
        workspaceRoot: workspace,
        outputDir,
        engine,
        debounceMs: 20,
        blueprint: false,
        renameWindowMs: 80,
      });
      await pipeline.watchFilesystem();

      write('src/fresh.ts', 'export function fresh(): number { return 1; }\n');
      write('dist/ignored.js', 'module.exports = 1;\n');
      await settle(600);

      await pipeline.dispose();

      const written = JSON.parse(
        fs.readFileSync(path.join(outputDir, 'project-index.json'), 'utf8')
      ) as { files: { path: string }[] };
      const paths = written.files.map(f => f.path);

      expect(paths).toContain('src/fresh.ts');
      expect(paths.some(p => p.startsWith('dist/'))).toBe(false);
    } finally {
      extractors.dispose();
    }
  }, 30_000);

  it('rename شناسهٔ فایل را حفظ می‌کند', async () => {
    const outputDir = path.join(workspace, '.semantic-engine');
    const extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });

    try {
      const { projectIndex } = await new IndexPipeline({
        workspaceRoot: workspace,
        outputPath: path.join(outputDir, 'project-index.json'),
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        gitCollector: null,
        vectorIndexer: null,
      }).run();

      const before = projectIndex.files.find(
        (f: { path: string }) => f.path === 'src/a.ts'
      ) as { id: string };

      const engine = new IncrementalEngine({
        workspaceRoot: workspace,
        symbolExtractorManager: extractors.symbols,
        dependencyExtractorManager: extractors.dependencies,
      });
      engine.load(projectIndex);

      const pipeline = new WatchPipeline({
        workspaceRoot: workspace,
        outputDir,
        engine,
        debounceMs: 20,
        blueprint: false,
        renameWindowMs: 150,
      });
      await pipeline.watchFilesystem();

      fs.renameSync(path.join(workspace, 'src/a.ts'), path.join(workspace, 'src/renamed.ts'));
      await settle(800);
      await pipeline.dispose();

      const written = JSON.parse(
        fs.readFileSync(path.join(outputDir, 'project-index.json'), 'utf8')
      ) as { files: { path: string; id: string }[] };

      const after = written.files.find(f => f.path === 'src/renamed.ts');
      expect(after).toBeDefined();
      // پذیرش فاز: یا id حفظ می‌شود، یا صریحاً delete+create
      expect(after!.id).toBe(before.id);
      expect(written.files.some(f => f.path === 'src/a.ts')).toBe(false);
    } finally {
      extractors.dispose();
    }
  }, 30_000);
});
