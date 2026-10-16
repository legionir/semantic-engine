/**
 * SE-INC-11 — مسیر افزایشی، فایل را «نیمه» می‌نوشت.
 *
 * `FileProcessor` عمداً `symbolIds`، `outline` و `diagnostics` را خالی
 * می‌گذارد؛ پر کردنشان کار `JsonExporter.attachSymbolIdsToFiles` در مسیر
 * *کامل* است. watcher آن مرحله را ندارد، پس فایلی که تازه اضافه یا
 * بازنویسی می‌شد در ایندکس بدون لینک سمبل می‌نشست — با اینکه سمبل‌هایش در
 * `symbols[] بودند — و هر مصرف‌کننده‌ای که از فایل به سمبل می‌رفت تا یک
 * full re-index چیزی نمی‌دید.
 *
 * آزمون اصلی همین parity است: نتیجهٔ incrementals باید برای فایل دست‌خورده
 * با نتیجهٔ یک build کامل روی همان محتوا یکی باشد.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from '../pipeline/IndexPipeline';
import { createExtractors, ExtractorSet } from '../pipeline/ExtractorFactory';
import { IncrementalEngine } from './IncrementalEngine';
import type { FileEntry, ProjectIndex } from '../core/types/project-index.types';

let workspace: string;
let extractors: ExtractorSet;

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function read(relative: string): string {
  return fs.readFileSync(path.join(workspace, relative), 'utf8');
}

async function fullIndex(): Promise<ProjectIndex> {
  const { projectIndex } = await new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(workspace, '.semantic-engine', 'project-index.json'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
  }).run();
  return projectIndex;
}

const idsOf = (file: FileEntry): readonly string[] => file.symbolIds ?? [];
const outlineOf = (file: FileEntry): readonly string[] => file.outline ?? [];

function fileAt(index: ProjectIndex, relative: string): FileEntry {
  const found = index.files.find(entry => entry.path === relative);
  if (!found) throw new Error(`no ${relative} in index`);
  return found;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-incshape-'));
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });
  write('src/widget.ts', 'export function makeWidget(): number { return 1; }\n');
  write('src/page.ts', 'import { makeWidget } from "./widget";\nexport const total = makeWidget();\n');
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('IncrementalEngine — شکل رکورد فایل در مسیر افزایشی', () => {
  it('فایل بازنویسی‌شده همان symbolIds را دارد که یک build کامل می‌دهد', async () => {
    const base = await fullIndex();
    expect(idsOf(fileAt(base, 'src/widget.ts'))).not.toHaveLength(0);

    write('src/widget.ts', read('src/widget.ts') + 'export function resizeWidget(): void {}\n');

    const engine = new IncrementalEngine({
      workspaceRoot: workspace,
      symbolExtractorManager: extractors.symbols,
      dependencyExtractorManager: extractors.dependencies,
    });
    engine.load(base);
    const incremental = (await engine.applyChanges([{ type: 'modified', path: 'src/widget.ts' }])).projectIndex;

    const refreshed = await fullIndex();

    const fromWatch = fileAt(incremental, 'src/widget.ts');
    const fromFull = fileAt(refreshed, 'src/widget.ts');

    expect(idsOf(fromWatch)).toEqual(expect.arrayContaining(idsOf(fromFull)));
    expect(idsOf(fromWatch)).toHaveLength(idsOf(fromFull).length);
    expect(outlineOf(fromWatch)).toEqual(outlineOf(fromFull));
  });

  it('outline همان «نوع نام» است، نه کپیِ شناسه‌ها (SE-EXP-04)', async () => {
    const base = await fullIndex();
    write('src/widget.ts', 'export class Widget {}\nexport function polishWidget(): void {}\n');

    const engine = new IncrementalEngine({
      workspaceRoot: workspace,
      symbolExtractorManager: extractors.symbols,
      dependencyExtractorManager: extractors.dependencies,
    });
    engine.load(base);
    const updated = (await engine.applyChanges([{ type: 'modified', path: 'src/widget.ts' }])).projectIndex;

    const widget = fileAt(updated, 'src/widget.ts');
    const outline = outlineOf(widget);
    expect(outline).toHaveLength(idsOf(widget).length);
    expect(outline).not.toHaveLength(0);
    for (const entry of outline) {
      expect(entry).toMatch(/^[a-z]+ /);
      expect(entry).not.toMatch(/^[0-9a-f]{16}$/);   // شناسه نیست
    }

    // همان چیزی که در `symbols[]` این فایل هست، در outline هم نوشته شده.
    const names = updated.symbols
      .filter(sym => sym.fileId === widget.id)
      .map(sym => `${sym.kind} ${sym.name}`);
    expect([...outline].sort()).toEqual([...names].sort());
  });

  it('فایل تازه‌ای که watcher می‌بیند هم لینک سمبلش را می‌گیرد', async () => {
    const base = await fullIndex();
    write('src/brand-new.ts', 'export function brandNew(): void {}\n');

    const engine = new IncrementalEngine({
      workspaceRoot: workspace,
      symbolExtractorManager: extractors.symbols,
      dependencyExtractorManager: extractors.dependencies,
    });
    engine.load(base);
    const updated = (await engine.applyChanges([{ type: 'created', path: 'src/brand-new.ts' }])).projectIndex;

    const created = fileAt(updated, 'src/brand-new.ts');
    expect(idsOf(created)).toHaveLength(1);
    expect(outlineOf(created)).toEqual(['function brandNew']);
  });

  it('diagnostics کهنه با بازنویسی فایل پاک می‌شود، نه اینکه به محتوای جدید نسبت داده شود', async () => {
    const base = await fullIndex();
    const stale: ProjectIndex = {
      ...base,
      files: base.files.map(f =>
        f.path === 'src/widget.ts'
          ? { ...f, diagnostics: [{ severity: 'error', line: 99, message: 'from the old content', source: 'typescript' }] }
          : f
      ),
    };
    expect(fileAt(stale, 'src/widget.ts').diagnostics).toHaveLength(1);

    write('src/widget.ts', 'export function makeWidget(): number { return 2; }\n');

    const engine = new IncrementalEngine({
      workspaceRoot: workspace,
      symbolExtractorManager: extractors.symbols,
      dependencyExtractorManager: extractors.dependencies,
    });
    engine.load(stale);
    const updated = (await engine.applyChanges([{ type: 'modified', path: 'src/widget.ts' }])).projectIndex;

    expect(fileAt(updated, 'src/widget.ts').diagnostics ?? []).toEqual([]);
  });
});
