/**
 * ExtractionCache — ایندکس با کش باید با ایندکس کامل یکی باشد، و هر تغییر
 * مربوط (محتوا، حذف، اثر انگشت، فایل خراب) باید کش را باطل کند.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from './IndexPipeline';
import { createExtractors, ExtractorSet } from './ExtractorFactory';
import { ExtractionCache } from './ExtractionCache';
import { ProjectIndex } from '../core/types/project-index.types';

let workspace: string;
let cacheFile: string;
let extractors: ExtractorSet;

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function run(options: { cache?: ExtractionCache | null } = {}) {
  return new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(workspace, '.semantic-engine', 'project-index.json'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
    extractionCache: options.cache ?? null,
  }).run();
}

/** ایندکس بدون فیلدهای زمانی، برای مقایسهٔ معنایی. */
function comparable(index: ProjectIndex): string {
  return JSON.stringify(index, (key, value) =>
    /generatedAt|timestamp|durationMs|createdAt|updatedAt/i.test(key) ? undefined : value
  );
}

const cache = (fingerprint = 'fp-1', reuse = true) =>
  new ExtractionCache(cacheFile, fingerprint, { reuse });

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-extcache-'));
  cacheFile = path.join(workspace, '.semantic-engine', 'cache', 'extraction.json');
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });
  write('src/util.ts', 'export function helper(a: string): string { return a; }\n');
  write('src/main.ts', "import { helper } from './util';\nexport function main(): void { helper('x'); }\n");
  write('config/app.json', '{"name":"demo"}\n');
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('ExtractionCache', () => {
  it('اجرای دوم همه‌ی فایل‌ها را از کش می‌گیرد و خروجی با ایندکس کامل یکی است', async () => {
    const first = await run({ cache: cache() });
    expect(first.stats.extractionCache?.hits).toBe(0);
    expect(fs.existsSync(cacheFile)).toBe(true);

    const second = await run({ cache: cache() });
    expect(second.stats.extractionCache).toEqual({
      hits: first.stats.extractionCache!.misses,
      misses: 0,
    });

    const full = await run({ cache: null });
    expect(comparable(second.projectIndex)).toBe(comparable(full.projectIndex));
  });

  it('فایل تغییرکرده دوباره استخراج می‌شود و importهای وابسته درست resolve می‌مانند', async () => {
    await run({ cache: cache() });
    write('src/util.ts', 'export function helper(a: string): string { return a; }\nexport function extra(): number { return 1; }\n');

    const warm = await run({ cache: cache() });
    expect(warm.stats.extractionCache?.misses).toBe(1);

    const full = await run({ cache: null });
    expect(comparable(warm.projectIndex)).toBe(comparable(full.projectIndex));
    expect(warm.projectIndex.symbols.some(symbol => symbol.name === 'extra')).toBe(true);
  });

  it('فایل حذف‌شده از کش و ایندکس می‌رود', async () => {
    await run({ cache: cache() });
    fs.rmSync(path.join(workspace, 'src', 'util.ts'));

    const warm = await run({ cache: cache() });
    expect(warm.projectIndex.files.some(file => file.path === 'src/util.ts')).toBe(false);
    expect(comparable(warm.projectIndex)).toBe(comparable((await run({ cache: null })).projectIndex));

    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { files: Record<string, unknown> };
    expect(Object.keys(saved.files)).not.toContain('src/util.ts');
  });

  it('اثر انگشت دیگر، کش را نادیده می‌گیرد', async () => {
    await run({ cache: cache('fp-1') });
    const other = await run({ cache: cache('fp-2') });
    expect(other.stats.extractionCache?.hits).toBe(0);
  });

  it('reuse=false (پرچم --full) کش را نمی‌خواند ولی دوباره می‌سازد', async () => {
    await run({ cache: cache() });
    const forced = await run({ cache: cache('fp-1', false) });
    expect(forced.stats.extractionCache?.hits).toBe(0);
    const after = await run({ cache: cache() });
    expect(after.stats.extractionCache?.misses).toBe(0);
  });

  it('فایل کش خراب نادیده گرفته می‌شود و ایندکس خراب نمی‌شود', async () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, '{not json');
    const result = await run({ cache: cache() });
    expect(result.stats.extractionCache?.hits).toBe(0);
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).schema).toBe(1);
  });

  it('تغییر زبان یا هش یک فایل (مثلاً rename با همان محتوا) از کش استفاده نمی‌کند', () => {
    const subject = cache();
    subject.set('a.ts', {
      fileId: 'f1', hash: 'h1', language: 'typescript', usages: [], symbols: null, dependencies: null,
    });
    subject.save();
    const reloaded = cache();
    reloaded.load();
    expect(reloaded.get('a.ts', 'f1', 'h1', 'typescript')).not.toBeNull();
    expect(reloaded.get('a.ts', 'f1', 'h2', 'typescript')).toBeNull();
    expect(reloaded.get('a.ts', 'f2', 'h1', 'typescript')).toBeNull();
    expect(reloaded.get('a.ts', 'f1', 'h1', 'javascript')).toBeNull();
  });
});
