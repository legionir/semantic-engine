/**
 * فاز ۲۶ — هزینهٔ مسیر incremental.
 *
 *   SE-INC-02  هر ذخیره، کار به‌اندازهٔ کل پروژه انجام می‌دهد
 *   SE-INC-04  متادیتای AI برای کل پروژه در هر batch بازتولید می‌شود
 *   SE-INC-07  دو `applyChanges` هم‌زمان روی یک store
 *   SE-INC-08  debounce بدون سقف انتظار — starvation
 *   SE-AI-04   LLM: ترتیبی، بدون batching/کش/سقف هزینه/لغو
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from '../pipeline/IndexPipeline';
import { createExtractors, ExtractorSet } from '../pipeline/ExtractorFactory';
import { IncrementalEngine } from './IncrementalEngine';
import { FileChangeQueue } from './FileChangeQueue';
import { SymbolMetricsCalculator } from '../core/metrics/SymbolMetricsCalculator';
import { AiMetadataGenerator } from '../ai/AiMetadataGenerator';
import { LlmAiMetadataGenerator } from '../ai/llm/LlmAiMetadataGenerator';
import {
  ILlmClient,
  LlmMessage,
  LlmClientConfig,
  LlmCompletionResult,
} from '../ai/llm/LlmClient';
import { ProjectIndex } from '../core/types/project-index.types';

let workspace: string;
let extractors: ExtractorSet;

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** پروژه‌ای با `count` ماژول، هر کدام وابسته به قبلی. */
function makeProject(count: number): void {
  for (let i = 0; i < count; i++) {
    const dep = i > 0 ? `import { fn${i - 1} } from './mod${i - 1}';\n` : '';
    const call = i > 0 ? `  const p = fn${i - 1}(a);\n` : '  const p = 0;\n';
    write(
      `src/mod${i}.ts`,
      `${dep}export class Svc${i} {\n  handle(a: number): number {\n${call}    if (a > 0) { return a + p; }\n    return p;\n  }\n}\nexport function fn${i}(a: number): number { return new Svc${i}().handle(a); }\n`
    );
  }
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
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-inc26-'));
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('SE-INC-02 — کار هر ذخیره به اندازهٔ دلتا است، نه پروژه', () => {
  it('محاسبهٔ complexity فقط فایل‌های تغییرکرده را دوباره می‌خواند', async () => {
    makeProject(30);
    const index = await fullIndex();

    /*
    | `SymbolMetricsCalculator` برای هر symbolِ نامزد، فایلش را از
    | دیسک می‌خواند. اگر دامنه داده نشود، هر ذخیره کل پروژه را
    | دوباره می‌خواند و parse می‌کند — ۷۵٪ زمان یک ذخیره روی مخزن
    | ۱۰۰۰ فایلی همین بود.
    */
    const changed = new Set([index.files.find(f => f.path === 'src/mod29.ts')!.id]);

    const calculator = new SymbolMetricsCalculator();
    const scoped = calculator.compute({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      callGraph: index.graphs.callGraph,
      changedFileIds: changed,
    });

    expect(calculator.cacheSize()).toBeLessThanOrEqual(changed.size);
    calculator.dispose();

    // و نتیجه برای فایل‌های دست‌نخورده همان می‌ماند
    const before = new Map(index.symbols.map(s => [s.id, s.complexity]));
    for (const symbol of scoped) {
      if (changed.has(symbol.fileId)) continue;
      expect(symbol.complexity).toBe(before.get(symbol.id));
    }
  });

  it('نتیجهٔ دامنه‌دار با نتیجهٔ کامل یکی است', async () => {
    makeProject(12);
    const index = await fullIndex();
    const changed = new Set(index.files.map(f => f.id));

    const full = new SymbolMetricsCalculator();
    const fullResult = full.compute({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      callGraph: index.graphs.callGraph,
    });
    full.dispose();

    const scopedCalc = new SymbolMetricsCalculator();
    const scopedResult = scopedCalc.compute({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      callGraph: index.graphs.callGraph,
      changedFileIds: changed,
    });
    scopedCalc.dispose();

    expect(scopedResult.map(s => s.complexity)).toEqual(fullResult.map(s => s.complexity));
  });

  it('هزینهٔ یک ذخیره با بزرگ‌تر شدن پروژه دو برابر نمی‌شود', async () => {
    const measure = async (count: number): Promise<number> => {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.mkdirSync(workspace, { recursive: true });
      makeProject(count);

      const index = await fullIndex();
      const incremental = engine();
      incremental.load(index);

      const leaf = `src/mod${count - 1}.ts`;
      const body = fs.readFileSync(path.join(workspace, leaf), 'utf8');
      await incremental.applyChanges([{ type: 'modified', path: leaf }]);

      const samples: number[] = [];
      for (let k = 0; k < 3; k++) {
        write(leaf, body.replace('return p;', `return p + ${k};`));
        const started = Date.now();
        await incremental.applyChanges([{ type: 'modified', path: leaf }]);
        samples.push(Date.now() - started);
      }
      return samples.sort((a, b) => a - b)[1]!;
    };

    const small = await measure(60);
    const large = await measure(240);

    /*
    | چهار برابر شدن پروژه نباید زمان را چهار برابر کند. آستانه
    | سخاوتمندانه است چون بخشی از کار (ساخت گراف) ذاتاً سراسری است؛
    | چیزی که اندازه‌گیری می‌شود، *نبودِ* رشد خطی است.
    */
    expect(large).toBeLessThan(Math.max(small * 2.5, small + 60));
  }, 120_000);
});

describe('SE-INC-04 — متادیتای AI فقط برای فایل‌های تغییرکرده', () => {
  it('generate با دامنه، متادیتای قبلی را برای بقیه نگه می‌دارد', async () => {
    makeProject(10);
    const index = await fullIndex();

    const generator = new AiMetadataGenerator();
    const baseline = generator.generate({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      dependencyGraph: index.graphs.dependencyGraph,
    });

    const changedId = index.files.find(f => f.path === 'src/mod9.ts')!.id;
    let analysed = 0;
    const counting = new (class extends AiMetadataGenerator {
      protected onFileAnalysed(): void {
        analysed++;
      }
    })();

    const scoped = counting.generate({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      dependencyGraph: index.graphs.dependencyGraph,
      changedFileIds: new Set([changedId]),
      previous: baseline,
    });

    expect(analysed).toBe(1);
    expect(scoped.size).toBe(baseline.size);
    for (const [fileId, metadata] of baseline) {
      if (fileId === changedId) continue;
      expect(scoped.get(fileId)).toBe(metadata);
    }
  });

  it('بدون متادیتای قبلی، فایل بدون دامنه هم ساخته می‌شود', async () => {
    makeProject(4);
    const index = await fullIndex();

    const scoped = new AiMetadataGenerator().generate({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      dependencyGraph: index.graphs.dependencyGraph,
      changedFileIds: new Set<string>(),
      previous: new Map(),
    });

    expect(scoped.size).toBe(index.files.filter(f => !f.binary).length);
  });
});

describe('SE-INC-07 — دو batch هم‌زمان روی هم نمی‌افتند', () => {
  it('applyChanges ترتیبی اجرا می‌شود', async () => {
    makeProject(3);
    const index = await fullIndex();
    const incremental = engine();
    incremental.load(index);

    write('src/mod0.ts', 'export function fn0(a: number): number { return a + 1; }\n');
    write('src/mod1.ts', 'export function fn1(a: number): number { return a + 2; }\n');

    const [first, second] = await Promise.all([
      incremental.applyChanges([{ type: 'modified', path: 'src/mod0.ts' }]),
      incremental.applyChanges([{ type: 'modified', path: 'src/mod1.ts' }]),
    ]);

    // هر دو کامل شدند و ایندکس هر دو، هر سه فایل را دارد
    expect(first.projectIndex.files.length).toBe(3);
    expect(second.projectIndex.files.length).toBe(3);

    const ids = second.projectIndex.files.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('هیچ‌وقت دو اجرا هم‌پوشانی ندارند', async () => {
    makeProject(4);
    const index = await fullIndex();
    const incremental = engine();
    incremental.load(index);

    /*
    | `reprocessFile` تنها نقطهٔ await داخل بدنه است که به‌ازای هر
    | batch حتماً اجرا می‌شود. با شمردن ورود/خروج در آن، هم‌پوشانی
    | دو `applyChanges` مستقیم دیده می‌شود.
    */
    let inFlight = 0;
    let overlaps = 0;
    const original = (incremental as unknown as {
      reprocessFile: (p: string) => Promise<unknown>;
    }).reprocessFile.bind(incremental);

    (incremental as unknown as { reprocessFile: unknown }).reprocessFile = async (p: string) => {
      inFlight++;
      if (inFlight > 1) overlaps++;
      await new Promise(resolve => setTimeout(resolve, 5));
      const result = await original(p);
      inFlight--;
      return result;
    };

    write('src/mod0.ts', 'export function fn0(a: number): number { return a + 1; }\n');
    write('src/mod1.ts', 'export function fn1(a: number): number { return a + 2; }\n');
    write('src/mod2.ts', 'export function fn2(a: number): number { return a + 3; }\n');

    await Promise.all([
      incremental.applyChanges([{ type: 'modified', path: 'src/mod0.ts' }]),
      incremental.applyChanges([{ type: 'modified', path: 'src/mod1.ts' }]),
      incremental.applyChanges([{ type: 'modified', path: 'src/mod2.ts' }]),
    ]);

    expect(overlaps).toBe(0);
  });

  it('batch دوم نتیجهٔ batch اول را می‌بیند', async () => {
    makeProject(2);
    const index = await fullIndex();
    const incremental = engine();
    incremental.load(index);

    write('src/added.ts', 'export function added(): number { return 1; }\n');
    write('src/mod0.ts', 'export function fn0(a: number): number { return a; }\n');

    const results = await Promise.all([
      incremental.applyChanges([{ type: 'created', path: 'src/added.ts' }]),
      incremental.applyChanges([{ type: 'modified', path: 'src/mod0.ts' }]),
    ]);

    const last = results[1]!;
    expect(last.projectIndex.files.map(f => f.path)).toContain('src/added.ts');
  });
});

describe('SE-INC-08 — debounce سقف انتظار دارد', () => {
  /*
  | تایمر ساختگی فقط برای همین بلوک. اعلامش در سطح describe، همهٔ
  | تست‌های بعدی فایل را هم می‌گیرد — که در اولین اجرا دقیقاً همین
  | شد و چهار تست LLM با timeout شکستند.
  */
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('جریان پیوسته رویداد، batch را گرسنه نمی‌گذارد', () => {
    const queue = new FileChangeQueue({ debounceMs: 50, maxWaitMs: 200 });
    const batches: number[] = [];

    /*
    | `git checkout` یا `npm install` رویداد را پیوسته می‌فرستند.
    | با ریست شدن تایمر در هر رویداد، batch هرگز اجرا نمی‌شود.
    */
    for (let tick = 0; tick < 20; tick++) {
      queue.enqueue({ type: 'modified', path: `src/f${tick}.ts` }, events =>
        batches.push(events.length)
      );
      jest.advanceTimersByTime(40); // همیشه کمتر از debounce
    }

    expect(batches.length).toBeGreaterThan(0);
    queue.dispose();
  });

  it('در حالت آرام، همان debounce معمول کار می‌کند', () => {
    const queue = new FileChangeQueue({ debounceMs: 50, maxWaitMs: 200 });
    const batches: number[] = [];

    queue.enqueue({ type: 'modified', path: 'a.ts' }, e => batches.push(e.length));
    jest.advanceTimersByTime(20);
    expect(batches).toEqual([]);

    queue.enqueue({ type: 'modified', path: 'b.ts' }, e => batches.push(e.length));
    jest.advanceTimersByTime(60);

    expect(batches).toEqual([2]);
    queue.dispose();
  });

  it('پس از تخلیه با maxWait، تایمر برای دور بعد تازه می‌شود', () => {
    const queue = new FileChangeQueue({ debounceMs: 50, maxWaitMs: 100 });
    const batches: number[] = [];
    const push = (events: unknown[]): void => {
      batches.push(events.length);
    };

    for (let tick = 0; tick < 6; tick++) {
      queue.enqueue({ type: 'modified', path: `x${tick}.ts` }, push);
      jest.advanceTimersByTime(40);
    }
    const afterFirst = batches.length;
    expect(afterFirst).toBeGreaterThan(0);

    for (let tick = 0; tick < 6; tick++) {
      queue.enqueue({ type: 'modified', path: `y${tick}.ts` }, push);
      jest.advanceTimersByTime(40);
    }
    expect(batches.length).toBeGreaterThan(afterFirst);
    queue.dispose();
  });
});

describe('SE-AI-04 — LLM محدود، کش‌دار و قابل لغو', () => {
  class RecordingClient implements ILlmClient {
    calls = 0;
    inFlight = 0;
    peakInFlight = 0;
    readonly config: LlmClientConfig = { apiKey: 'x', model: 'test-model' };

    async dispose(): Promise<void> {
      /* nothing to release */
    }

    async complete(_messages: readonly LlmMessage[]): Promise<LlmCompletionResult> {
      this.calls++;
      this.inFlight++;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      this.inFlight--;
      return {
        content: JSON.stringify({
          summary: 'a summary',
          keywords: ['k'],
          businessDomains: [],
          frameworks: [],
          designPatterns: [],
        }),
        model: 'test-model',
      };
    }
  }

  async function smallIndex(count: number): Promise<ProjectIndex> {
    makeProject(count);
    return fullIndex();
  }

  it('درخواست‌ها هم‌زمان می‌روند، نه یکی‌یکی', async () => {
    const index = await smallIndex(8);
    const client = new RecordingClient();

    await new LlmAiMetadataGenerator({ llmClient: client, concurrency: 4 }).generate({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      dependencyGraph: index.graphs.dependencyGraph,
    });

    expect(client.calls).toBe(index.files.filter(f => !f.binary).length);
    expect(client.peakInFlight).toBeGreaterThan(1);
    expect(client.peakInFlight).toBeLessThanOrEqual(4);
  });

  it('فایل با hash تکراری دوباره از LLM پرسیده نمی‌شود', async () => {
    const index = await smallIndex(5);
    const client = new RecordingClient();
    const generator = new LlmAiMetadataGenerator({ llmClient: client, concurrency: 2 });

    const input = {
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      dependencyGraph: index.graphs.dependencyGraph,
    };

    await generator.generate(input);
    const afterFirst = client.calls;
    await generator.generate(input);

    expect(client.calls).toBe(afterFirst);
  });

  it('سقف تعداد درخواست رعایت می‌شود', async () => {
    const index = await smallIndex(10);
    const client = new RecordingClient();

    const result = await new LlmAiMetadataGenerator({
      llmClient: client,
      concurrency: 4,
      maxRequests: 3,
    }).generate({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      dependencyGraph: index.graphs.dependencyGraph,
    });

    expect(client.calls).toBeLessThanOrEqual(3);
    // فایل‌هایی که بودجه به آن‌ها نرسید، متادیتای heuristic می‌گیرند نه هیچ
    expect(result.size).toBe(index.files.filter(f => !f.binary).length);
  });

  it('لغو، درخواست‌های باقی‌مانده را متوقف می‌کند', async () => {
    const index = await smallIndex(12);
    const client = new RecordingClient();
    const controller = new AbortController();

    const generator = new LlmAiMetadataGenerator({
      llmClient: client,
      concurrency: 2,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 12);
    const result = await generator.generate({
      workspaceRoot: workspace,
      files: index.files,
      symbols: index.symbols,
      dependencyGraph: index.graphs.dependencyGraph,
    });

    expect(client.calls).toBeLessThan(index.files.length);
    expect(result.size).toBe(index.files.filter(f => !f.binary).length);
  });
});
