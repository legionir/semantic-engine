/**
 * SE-EXP-14 — مسیر diagnostics قطع بود.
 *
 * `ProjectIndex.diagnostics` و `FileEntry.diagnostics` هر دو در قرارداد
 * و در schema وجود داشتند، ولی هیچ‌کس پرشان نمی‌کرد:
 *
 *   • `WorkspaceScanner` diagnostics تولید می‌کرد (فایل ناخوانا، حلقهٔ
 *     symlink، فایل بریده‌شده) و `JsonExporter` آن‌ها را دور می‌ریخت و
 *     `diagnostics: []` می‌نوشت.
 *   • `IndexPipeline` نتیجهٔ استخراج را می‌گرفت، `symbols` را برمی‌داشت
 *     و `warnings` و پرچم `partial` را دور می‌ریخت.
 *
 * نتیجه: یک فایل می‌توانست کاملاً در تجزیه شکست بخورد، صفر symbol بدهد،
 * و در خروجی *هیچ* ردی از آن نماند. دقیقاً همین بود که SE-SCAN-12 را
 * تا فاز ۲۲ پنهان نگه داشت — هر `tsconfig.json` دارای کامنت بی‌صدا صفر
 * symbol می‌داد.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from './IndexPipeline';
import { createExtractors, ExtractorSet } from './ExtractorFactory';
import { Diagnostic } from '../core/types/project-index.types';

let workspace: string;
let extractors: ExtractorSet;

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function pipeline() {
  return new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(workspace, '.semantic-engine', 'project-index.json'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-diag-'));
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('SE-EXP-14 — هشدارهای استخراج به خروجی می‌رسند', () => {
  it('فایلی که تجزیه نمی‌شود یک diagnostic می‌گیرد، نه سکوت', async () => {
    write('broken.json', '{\n  "a": 1,\n  oops\n}\n');
    write('src/ok.ts', 'export const value = 1;\n');

    const { projectIndex } = await pipeline().run();

    const broken = projectIndex.files.find(f => f.path === 'broken.json');
    expect(broken).toBeDefined();
    expect(broken!.symbolIds ?? []).toEqual([]);

    const diagnostics = broken!.diagnostics ?? [];
    expect(diagnostics.length).toBeGreaterThan(0);

    const [first] = diagnostics as readonly Diagnostic[];
    expect(first!.severity).toBe('warning');
    expect(first!.source).toBe('symbol-extraction');
    expect(first!.fileId).toBe(broken!.id);
    expect(first!.message).toMatch(/parse error/i);
  });

  it('فایل سالم هیچ diagnostic اضافه‌ای نمی‌گیرد', async () => {
    write('good.json', '{\n  "a": 1\n}\n');

    const { projectIndex } = await pipeline().run();

    const good = projectIndex.files.find(f => f.path === 'good.json');
    expect(good!.diagnostics ?? []).toEqual([]);
  });

  it('diagnostics سطح پروژه تجمیع فایل‌هاست، نه یک آرایهٔ خالی ثابت', async () => {
    write('broken.json', '{\n  "a": 1,\n  oops\n}\n');
    write('also-broken.json', '{ nope }\n');

    const { projectIndex } = await pipeline().run();

    const fromFiles = projectIndex.files.flatMap(f => f.diagnostics ?? []);
    expect(fromFiles.length).toBe(2);
    expect(projectIndex.diagnostics.length).toBe(fromFiles.length);
    expect(projectIndex.diagnostics.map(d => d.fileId).sort()).toEqual(
      fromFiles.map(d => d.fileId).sort()
    );
  });

  it('diagnostics خودِ اسکنر هم دور ریخته نمی‌شود', async () => {
    write('src/ok.ts', 'export const value = 1;\n');
    /*
    | symlink معلق: اسکنر نمی‌تواند stat کند و یک diagnostic می‌سازد.
    | تا امروز آن diagnostic ساخته می‌شد و بعد در exporter گم می‌شد.
    */
    fs.symlinkSync(path.join(workspace, 'nowhere.ts'), path.join(workspace, 'dangling.ts'));

    const { projectIndex } = await pipeline().run();

    const scanner = projectIndex.diagnostics.filter(d => d.source === 'scanner');
    expect(scanner.length).toBeGreaterThan(0);
  });

  it('ترتیب diagnostics قطعی است', async () => {
    write('a-broken.json', '{ nope }\n');
    write('b-broken.json', '{ nope }\n');

    const first = await pipeline().run();
    const second = await pipeline().run();

    expect(first.projectIndex.diagnostics.map(d => `${d.fileId}:${d.message}`)).toEqual(
      second.projectIndex.diagnostics.map(d => `${d.fileId}:${d.message}`)
    );
  });
});
