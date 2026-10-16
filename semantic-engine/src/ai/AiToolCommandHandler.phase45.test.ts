/**
 * SE-AI-02 — رجیستری هرگز بی‌اعتبار نمی‌شد.
 *
 * ```ts
 * private async ensureRegistry(): Promise<void> {
 *   if (this.registry) return;      // ← برای همیشه
 *   ...
 * ```
 *
 * بعد از اولین بارگذاری، `this.registry` تا پایان عمر پروسه کش
 * می‌شد. یعنی پس از هر اسکن مجدد یا هر به‌روزرسانی incremental،
 * ابزارهای AI همچنان **ایندکس قدیمی** را سرو می‌کردند — بدون هیچ
 * نشانه‌ای که چیزی کهنه شده.
 *
 * روی یک ویرایشگر که همیشه باز است، این یعنی مدل روی تصویری از کد
 * کار می‌کند که ساعت‌ها پیش گرفته شده.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AiToolCommandHandler } from './AiToolCommandHandler';
import { ProjectIndex } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';

function indexWith(symbolName: string, generatedAt: string): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    rootPath: '/tmp/fixture',
    generatedAt,
    languages: ['typescript'],
    files: [
      {
        id: 'f1',
        path: 'src/a.ts',
        language: 'typescript',
        size: 10,
        lines: 5,
        hash: 'h',
        binary: false,
        testFile: false,
        symbolIds: [],
        imports: [],
        exports: [],
        diagnostics: [],
        outline: [],
      },
    ],
    symbols: [
      {
        id: 's1',
        fileId: 'f1',
        parentId: null,
        kind: 'function',
        name: symbolName,
        fullyQualifiedName: symbolName,
        signature: `${symbolName}()`,
        visibility: 'public',
        line: 1,
        endLine: 2,
        documentation: null,
        deprecated: false,
        exported: true,
        source: 'tree-sitter',
        confidence: makeConfidence(90),
      },
    ],
    graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: 1,
      totalLoc: 5,
      totalSymbols: 1,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: 1 },
    },
  } as unknown as ProjectIndex;
}

describe('AiToolCommandHandler — ایندکس کهنه سرو نمی‌شود (SE-AI-02)', () => {
  let root: string;
  let indexPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-handler-'));
    fs.mkdirSync(path.join(root, '.semantic-engine'), { recursive: true });
    indexPath = path.join(root, '.semantic-engine', 'project-index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexWith('oldSymbol', '2026-08-19T00:00:00.000Z')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /*
  | نوشتنِ دوباره با زمانِ صریح. تکیه بر ساعتِ سیستم برای اینکه دو
  | نوشتنِ پشت‌سرهم mtime متفاوت بگیرند، آزمون را به سرعتِ ماشین گره
  | می‌زند — همان جنس بی‌ثباتی که SE-BUILD-16/17 قبلاً تولید کرد.
  */
  function rewrite(symbolName: string): void {
    fs.writeFileSync(indexPath, JSON.stringify(indexWith(symbolName, '2026-08-20T00:00:00.000Z')));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(indexPath, later, later);
  }

  async function findNames(handler: AiToolCommandHandler): Promise<string[]> {
    const result = (await handler.executeTool('find_symbol', { name: '' })) as {
      items: { name: string }[];
    };
    return result.items.map(i => i.name);
  }

  it('ایندکسِ بازنوشته‌شده روی دیسک، دیده می‌شود', async () => {
    const handler = new AiToolCommandHandler(root);

    expect(await findNames(handler)).toContain('oldSymbol');

    rewrite('newSymbol');

    const after = await findNames(handler);
    expect(after).toContain('newSymbol');
    expect(after).not.toContain('oldSymbol');
  });

  it('ایندکس دست‌نخورده، دوباره از دیسک خوانده نمی‌شود', async () => {
    const handler = new AiToolCommandHandler(root);
    await findNames(handler);
    const before = handler.indexLoadCount;

    await findNames(handler);
    await findNames(handler);

    expect(handler.indexLoadCount).toBe(before);
  });

  it('حذف شدن ایندکس، خطای روشن می‌دهد نه نتیجهٔ کهنه', async () => {
    const handler = new AiToolCommandHandler(root);
    await findNames(handler);

    fs.rmSync(indexPath);

    const result = (await handler.executeTool('find_symbol', { name: '' })) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('listTools هم ایندکس تازه را می‌بیند', async () => {
    const handler = new AiToolCommandHandler(root);
    await handler.listTools();

    rewrite('newSymbol');

    const tools = await handler.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(await findNames(handler)).toContain('newSymbol');
  });

  it('حتی وقتی اندازهٔ فایل عوض نشود، تغییر دیده می‌شود', () => {
    /*
    | دو ایندکس با نامِ هم‌طول، بایتِ هم‌اندازه می‌دهند. اگر امضای
    | کهنگی فقط اندازه بود، تغییر نامرئی می‌ماند؛ و اگر فقط
    | `mtimeMs` بود، دو نوشتن در یک میلی‌ثانیه هم نامرئی می‌شد.
    */
    const a = JSON.stringify(indexWith('oldSymbol', '2026-08-19T00:00:00.000Z'));
    const b = JSON.stringify(indexWith('newSymbol', '2026-08-19T00:00:00.000Z'));

    expect(a.length).toBe(b.length);
    expect(a).not.toBe(b);
  });
});
