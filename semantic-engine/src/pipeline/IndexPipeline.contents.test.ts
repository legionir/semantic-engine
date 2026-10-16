/**
 * SE-EXT-09 — `contents.clear()` پیش از مصرف‌کننده‌هایش اجرا می‌شد.
 *
 * فاز ۲۹ برای مهار حافظه (SE-EXT-03) این را اضافه کرده بود:
 *
 * ```ts
 * | SE-EXT-03: از این نقطه به بعد هیچ‌کس به متن فایل‌ها نیاز ندارد —
 * | symbolها، وابستگی‌ها و `configUsages` همه بیرون کشیده شده‌اند.
 * contents.clear();
 * ```
 *
 * ادعای «هیچ‌کس نیاز ندارد» **همان موقع هم غلط بود**. دو مرحله بعد
 * از این خط اجرا می‌شوند و هر دو `contents` می‌گیرند:
 *
 * ۱. `enrich()` (فاز ۳۷) که `contentOf: fileId => contents.get(fileId)`
 *    را پاس می‌دهد. `LspEnrichmentService` وقتی `undefined` بگیرد به
 *    `readFileOrNull` برمی‌گردد، پس نتیجه درست می‌ماند ولی **هر فایل
 *    دوباره از دیسک خوانده می‌شود** — دقیقاً همان کاری که این کش
 *    قرار بود جلویش را بگیرد.
 *
 * ۲. `buildVectors()` که از فاز ۴۴ سورس واقعی می‌خواهد (SE-VEC-01) و
 *    **هیچ fallbackی ندارد**. اندازه‌گیری روی fixture: از ۲٬۱۷۶
 *    chunk، فقط **۱** تا سورس داشت.
 *
 * و خودِ اندازه‌گیریِ SE-EXT-03 هم بعد از `clear()` اجرا می‌شد:
 *
 * ```ts
 * this.retainedBytes = 0;
 * for (const text of contents.values()) this.retainedBytes += text.length;
 * ```
 *
 * روی یک map که همیشه خالی است، پس همیشه صفر گزارش می‌کرد. هیچ
 * آزمونی هم آن را نمی‌خواند، پس صفرِ همیشگی‌اش دیده نشد.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { IndexPipeline } from './IndexPipeline';
import { VectorIndexer } from '../vector/VectorIndexer';
import { HashingEmbeddingGenerator } from '../vector/HashingEmbeddingGenerator';
import { createExtractors } from './ExtractorFactory';

describe('IndexPipeline — متن فایل تا آخرین مصرف‌کننده زنده می‌ماند (SE-EXT-09)', () => {
  let root: string;
  let out: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-contents-'));
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'se-contents-out-'));

    fs.writeFileSync(
      path.join(root, 'recovery.ts'),
      `export async function beginRecovery(userId: string): Promise<void> {\n` +
        `  const token = await issueToken(userId);\n` +
        `  await mailer.sendEmail(userId, token);\n` +
        `}\n\n` +
        `export function issueToken(userId: string): string {\n` +
        `  return userId + Date.now();\n` +
        `}\n`
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  async function run(vectors: boolean) {
    const extractors = createExtractors({ workspaceRoot: root, treeSitter: false });
    try {
      return await new IndexPipeline({
        workspaceRoot: root,
        outputPath: path.join(out, 'project-index.json'),
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        gitCollector: null,
        vectorIndexer: vectors
          ? new VectorIndexer({ embeddingGenerator: new HashingEmbeddingGenerator() })
          : null,
        scannerConfig: { skipHiddenDirectories: false },
      }).run();
    } finally {
      extractors.dispose();
    }
  }

  it('chunkهای برداری سورس واقعی دارند، نه فقط برچسب', async () => {
    const { projectIndex } = await run(true);
    const chunks = projectIndex.vectorChunks ?? [];

    expect(chunks.length).toBeGreaterThan(0);

    const withSource = chunks.filter(c => c.content.includes('Source:'));
    expect(withSource.length).toBe(chunks.length);
  });

  it('بدنهٔ واقعی تابع داخل chunk هست', async () => {
    const { projectIndex } = await run(true);
    const chunks = projectIndex.vectorChunks ?? [];

    const all = chunks.map(c => c.content).join('\n');
    expect(all).toContain('mailer.sendEmail');
  });

  it('هر chunk، contentHash و مدل دارد', async () => {
    const { projectIndex } = await run(true);
    const chunks = projectIndex.vectorChunks ?? [];

    for (const c of chunks) {
      expect(typeof c.contentHash).toBe('string');
      expect(typeof c.embeddingModel).toBe('string');
      expect((c.embedding ?? []).length).toBeGreaterThan(0);
    }
  });

  it('اندازه‌گیریِ SE-EXT-03 روی مقدارِ واقعی است، نه روی مپِ پاک‌شده', async () => {
    const extractors = createExtractors({ workspaceRoot: root, treeSitter: false });
    let pipeline: IndexPipeline;
    try {
      pipeline = new IndexPipeline({
        workspaceRoot: root,
        outputPath: path.join(out, 'project-index.json'),
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        gitCollector: null,
        vectorIndexer: null,
        scannerConfig: { skipHiddenDirectories: false },
      });
      await pipeline.run();
    } finally {
      extractors.dispose();
    }

    // فایل واقعی خوانده شده، پس عدد باید مثبت باشد. صفرِ همیشگی یعنی
    // اندازه‌گیری بعد از پاک‌سازی انجام شده و چیزی را نمی‌سنجد.
    expect(pipeline!.retainedContentBytes).toBeGreaterThan(0);
  });

  it('متن پس از آخرین مصرف‌کننده رها می‌شود', async () => {
    const extractors = createExtractors({ workspaceRoot: root, treeSitter: false });
    let pipeline: IndexPipeline;
    try {
      pipeline = new IndexPipeline({
        workspaceRoot: root,
        outputPath: path.join(out, 'project-index.json'),
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        gitCollector: null,
        vectorIndexer: null,
        scannerConfig: { skipHiddenDirectories: false },
      });
      await pipeline.run();
    } finally {
      extractors.dispose();
    }

    expect(pipeline!.releasedContent).toBe(true);
  });
});
