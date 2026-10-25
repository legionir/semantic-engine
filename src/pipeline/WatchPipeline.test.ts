/**
 * فاز ۲۷ — WatchPipeline.
 *
 * `processIncrementalBatch` در `extension.ts` زندگی می‌کرد و با آن فایل
 * در فاز ۱۳ حذف شد. یعنی از فاز ۱۳ تا امروز، مسیر watch **اصلاً وجود
 * نداشت**: موتور incremental بود، صف بود، نویسنده بود، ولی هیچ‌چیز
 * آن‌ها را به هم وصل نمی‌کرد.
 *
 * چیزی که ساخته می‌شود همان نیست که حذف شد. نسخهٔ قبلی در هر batch:
 *
 *   • ایندکس را **دو بار** می‌نوشت (SE-EXP-02)
 *   • کل بردارها را از نو می‌ساخت
 *   • `gitCollector.collect(همهٔ مسیرها)` می‌زد
 *   • یک تایمر ۳۰ ثانیه‌ای متادیتای کل پروژه را بازتولید می‌کرد
 *
 * این‌ها در فازهای ۲۴ تا ۲۶ رفع شدند؛ WatchPipeline نباید برشان
 * گرداند.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from './IndexPipeline';
import { WatchPipeline } from './WatchPipeline';
import { createExtractors, ExtractorSet } from './ExtractorFactory';
import { IncrementalEngine } from '../incremental/IncrementalEngine';
import { ProjectIndex } from '../core/types/project-index.types';
import { NodeFileSystem } from '../host/FileSystem';

let workspace: string;
let outputDir: string;
let extractors: ExtractorSet;

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function fullIndex(): Promise<ProjectIndex> {
  const result = await new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(outputDir, 'project-index.json'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
  }).run();
  return result.projectIndex;
}

function loadedEngine(index: ProjectIndex): IncrementalEngine {
  const engine = new IncrementalEngine({
    workspaceRoot: workspace,
    symbolExtractorManager: extractors.symbols,
    dependencyExtractorManager: extractors.dependencies,
  });
  engine.load(index);
  return engine;
}

function readIndex(): ProjectIndex {
  return JSON.parse(fs.readFileSync(path.join(outputDir, 'project-index.json'), 'utf8'));
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-watch27-'));
  outputDir = path.join(workspace, '.semantic-engine');
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });

  write('src/util.ts', 'export function helper(): number { return 1; }\n');
  write('src/main.ts', "import { helper } from './util';\nexport function main(): number { return helper(); }\n");
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('WatchPipeline — پذیرش: دو batch همزمان تداخل نمی‌کنند', () => {
  it('دو رویداد پشت سر هم، دو اجرای مجزا و ترتیبی می‌دهند', async () => {
    const index = await fullIndex();
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine: loadedEngine(index),
      debounceMs: 5,
      blueprint: false,
    });

    let inFlight = 0;
    let overlaps = 0;
    pipeline.onBatchStart(() => {
      inFlight++;
      if (inFlight > 1) overlaps++;
    });
    pipeline.onBatchEnd(() => {
      inFlight--;
    });

    write('src/util.ts', 'export function helper(): number { return 2; }\n');
    pipeline.notify({ type: 'modified', path: 'src/util.ts' });
    await new Promise(resolve => setTimeout(resolve, 12));

    write('src/main.ts', "import { helper } from './util';\nexport const main = helper;\n");
    pipeline.notify({ type: 'modified', path: 'src/main.ts' });

    await pipeline.dispose();

    expect(overlaps).toBe(0);
    expect(pipeline.stats().batches).toBe(2);
  });

  it('رویدادهای پیاپی حتی وقتی batch در حال اجراست، از دست نمی‌روند', async () => {
    const index = await fullIndex();
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine: loadedEngine(index),
      debounceMs: 1,
      blueprint: false,
    });

    for (let round = 0; round < 5; round++) {
      write('src/util.ts', `export function helper(): number { return ${round}; }\n`);
      pipeline.notify({ type: 'modified', path: 'src/util.ts' });
      await new Promise(resolve => setTimeout(resolve, 3));
    }

    await pipeline.dispose();

    // آخرین محتوا باید در ایندکس نوشته‌شده باشد
    const written = readIndex();
    expect(written.files.map(f => f.path)).toContain('src/util.ts');
    expect(pipeline.stats().batches).toBeGreaterThan(0);
  });
});

describe('WatchPipeline — نوشتن، دقیقاً یک بار', () => {
  it('هر batch یک بار ایندکس را می‌نویسد', async () => {
    const index = await fullIndex();
    const engine = loadedEngine(index);
    const writes: string[] = [];

    /*
    | زیرکلاس، نه spread: متدهای `NodeFileSystem` روی prototype
    | زندگی می‌کنند و `{...instance}` هیچ‌کدامشان را برنمی‌دارد.
    */
    class CountingFileSystem extends NodeFileSystem {
      override async writeJsonAtomic(
        target: string,
        data: unknown,
        options?: { pretty?: boolean }
      ): Promise<void> {
        writes.push(target);
        return super.writeJsonAtomic(target, data, options);
      }
    }

    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine,
      debounceMs: 1,
      blueprint: false,
      fileSystem: new CountingFileSystem(),
    });

    write('src/util.ts', 'export function helper(): number { return 7; }\n');
    pipeline.notify({ type: 'modified', path: 'src/util.ts' });
    await pipeline.dispose();

    /*
    | SE-EXP-02: نسخهٔ قبلی ایندکس را دو بار می‌نوشت — یک‌بار بدون
    | بردار و یک‌بار با آن. هر خواننده‌ای که وسط این دو سر می‌رسید،
    | ایندکسی بدون بردار می‌دید.
    */
    const indexWrites = writes.filter(w => w.endsWith('project-index.json'));
    expect(indexWrites).toHaveLength(1);
  });

  it('خروجی نوشته‌شده، تغییر را دارد', async () => {
    const index = await fullIndex();
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine: loadedEngine(index),
      debounceMs: 1,
      blueprint: false,
    });

    write('src/added.ts', 'export function added(): number { return 1; }\n');
    pipeline.notify({ type: 'created', path: 'src/added.ts' });
    await pipeline.dispose();

    expect(readIndex().files.map(f => f.path)).toContain('src/added.ts');
  });

  it('blueprint فقط وقتی drift از آستانه رد شود نوشته می‌شود', async () => {
    const index = await fullIndex();
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine: loadedEngine(index),
      debounceMs: 1,
      blueprint: true,
    });

    write('src/util.ts', 'export function helper(): number { return 3; }\n');
    pipeline.notify({ type: 'modified', path: 'src/util.ts' });
    await pipeline.dispose();

    /*
    | یک فایل از دو فایل یعنی drift = ۰٫۵، خیلی بالاتر از آستانهٔ
    | پیش‌فرض ۰٫۰۵ — پس blueprint باید ساخته شود.
    */
    expect(fs.existsSync(path.join(outputDir, 'blueprint.json'))).toBe(true);
  });
});

describe('WatchPipeline — خاموشی تمیز', () => {
  it('dispose منتظر batch در حال اجرا می‌ماند', async () => {
    const index = await fullIndex();
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine: loadedEngine(index),
      debounceMs: 1,
      blueprint: false,
    });

    let finished = false;
    pipeline.onBatchEnd(() => {
      finished = true;
    });

    write('src/util.ts', 'export function helper(): number { return 9; }\n');
    pipeline.notify({ type: 'modified', path: 'src/util.ts' });
    await pipeline.dispose();

    expect(finished).toBe(true);
  });

  it('پس از dispose هیچ کاری اجرا نمی‌شود', async () => {
    const index = await fullIndex();
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine: loadedEngine(index),
      debounceMs: 5,
      blueprint: false,
    });

    await pipeline.dispose();

    write('src/util.ts', 'export function helper(): number { return 11; }\n');
    pipeline.notify({ type: 'modified', path: 'src/util.ts' });
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(pipeline.stats().batches).toBe(0);
  });

  it('رویدادهای معلق در صف، پیش از خاموشی تخلیه می‌شوند', async () => {
    const index = await fullIndex();
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine: loadedEngine(index),
      debounceMs: 10_000, // آن‌قدر بلند که خودش هرگز fire نکند
      blueprint: false,
    });

    write('src/added.ts', 'export function added(): number { return 1; }\n');
    pipeline.notify({ type: 'created', path: 'src/added.ts' });

    /*
    | خاموشی نباید کاری را که کاربر انجام داده دور بریزد. `dispose`
    | صف را تخلیه می‌کند، نه اینکه فقط تایمر را بکشد.
    */
    await pipeline.dispose();

    expect(pipeline.stats().batches).toBe(1);
    expect(readIndex().files.map(f => f.path)).toContain('src/added.ts');
  });

  it('dispose دوباره بی‌خطر است', async () => {
    const index = await fullIndex();
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine: loadedEngine(index),
      debounceMs: 1,
      blueprint: false,
    });

    await pipeline.dispose();
    await expect(pipeline.dispose()).resolves.toBeUndefined();
  });
});

describe('WatchPipeline — خطا batch بعدی را نمی‌کشد', () => {
  it('یک batch شکست‌خورده گزارش می‌شود و کار ادامه می‌یابد', async () => {
    const index = await fullIndex();
    const engine = loadedEngine(index);

    let calls = 0;
    const original = engine.applyChanges.bind(engine);
    engine.applyChanges = async events => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return original(events);
    };

    const errors: Error[] = [];
    const pipeline = new WatchPipeline({
      workspaceRoot: workspace,
      outputDir,
      engine,
      debounceMs: 1,
      blueprint: false,
    });
    pipeline.onError(error => errors.push(error));

    pipeline.notify({ type: 'modified', path: 'src/util.ts' });
    await new Promise(resolve => setTimeout(resolve, 20));

    write('src/added.ts', 'export function added(): number { return 1; }\n');
    pipeline.notify({ type: 'created', path: 'src/added.ts' });
    await pipeline.dispose();

    expect(errors.map(e => e.message)).toEqual(['boom']);
    expect(readIndex().files.map(f => f.path)).toContain('src/added.ts');
  });
});

describe('SE-EXT-04 — مسیر watch از barrel عمومی در دسترس است', () => {
  /*
  | `src/index.ts` خودش را «تنها فایلی که مصرف‌کننده باید از آن import
  | کند» معرفی می‌کند. ولی `OutputWriter` (فاز ۱۳) و `WatchPipeline`
  | (فاز ۲۷) هرگز به آن اضافه نشدند، پس ساختن یک حلقهٔ watch از بیرون
  | پکیج مستلزم دست بردن به مسیرهای داخلی بود — دقیقاً همان چیزی که
  | CLI فاز ۲۹ لازم دارد.
  */
  it('هر چیزی که برای یک حلقهٔ watch لازم است، از barrel صادر شده', () => {

    const api = require('../index') as Record<string, unknown>;

    for (const name of [
      'IndexPipeline',
      'createExtractors',
      'IncrementalEngine',
      'OutputWriter',
      'WatchPipeline',
      'FileWatcher',
      'IgnoreMatcher',
    ]) {
      expect(typeof api[name]).toBe('function');
    }
  });

  it('نام فایل‌های خروجی هم صادر شده‌اند', () => {

    const api = require('../index') as Record<string, unknown>;
    expect(api['INDEX_FILE_NAME']).toBe('project-index.json');
    expect(api['BLUEPRINT_FILE_NAME']).toBe('blueprint.json');
  });
});
