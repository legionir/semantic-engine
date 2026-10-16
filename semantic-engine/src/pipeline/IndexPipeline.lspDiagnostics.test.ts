/**
 * فاز ۳۴ تا این اصلاح، **از هیچ مسیری اجرا نمی‌شد**.
 *
 * `IndexPipeline` گزینهٔ `diagnosticsSource` را می‌پذیرفت و مرحلهٔ جدا را
 * داشت، ولی نه CLI آن را پاس می‌داد، نه watcher، نه job route — هر سه
 * `createExtractors({...})` را بدون LSP صدا می‌زدند. نتیجه اینکه
 * `FileEntry.diagnostics` هرگز از زبان‌سرور پر نشد، و `explain_symbol`
 * آرایهٔ خالی را به‌عنوان «این فایل تمیز است» نشان می‌داد درحالی‌که معنای
 * واقعی‌اش «به آن نگاه نشده» بود.
 *
 * این فایل هر دو نیمه را می‌بندد: وصل‌شدنِ منبع، و جدا ماندنِ
 * «بررسی‌نشده» از «چیزی پیدا نشد» — با `diagnosticsRun` روی ایندکس.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from './IndexPipeline';
import { createExtractors, ExtractorSet } from './ExtractorFactory';
import { Diagnostic, FileEntry } from '../core/types/project-index.types';
import type { FileDiagnosticsSource } from '../lsp/DiagnosticsProvider';

let workspace: string;
let extractors: ExtractorSet;

function write(relative: string, content: string): void {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function pipeline(extra: Record<string, unknown> = {}) {
  return new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(workspace, '.semantic-engine', 'project-index.json'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
    ...extra,
  });
}

/** منبع ساختگی، به‌جای زبان‌سرور: هر فایل `.ts` یک خطا می‌گیرد. */
function fakeSource(report: { calls: string[] }): FileDiagnosticsSource {
  return {
    async diagnosticsFor(filePath, _languageId, _content, fileId): Promise<readonly Diagnostic[]> {
      report.calls.push(path.basename(filePath));
      if (!filePath.endsWith('.ts')) return [];
      return [
        {
          severity: 'error',
          line: 1,
          column: 0,
          message: `TS2304: cannot find name 'x' in ${path.basename(filePath)}`,
          source: 'ts',
          code: '2304',
          fileId,
        },
      ];
    },
  };
}

/** لاگر ثبت‌کننده، تا «بریده شد» واقعاً قابل ادعا باشد. */
function fakeLogger(sink: unknown[]) {
  const logger = {
    error: (message: string, data?: unknown) => sink.push({ level: 'error', message, data }),
    warn: (message: string, data?: unknown) => sink.push({ level: 'warn', message, data }),
    info: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return logger;
}

function fileAt(files: readonly FileEntry[], relative: string): FileEntry {
  const found = files.find(entry => entry.path === relative);
  if (!found) throw new Error(`no file ${relative} in the index`);
  return found;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-lspdiag-'));
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });
  write('src/a.ts', 'export const value = 1;\n');
  write('src/b.ts', 'export const other = 2;\n');
  write('notes.md', '# notes\n');
  /* یک فایل واقعاً باینری — نباید اصلاً به زبان‌سرور برود. */
  fs.writeFileSync(path.join(workspace, 'blob.dat'), Buffer.from([0, 1, 2, 0, 3]));
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('مرحلهٔ diagnostics زبان‌سرور — وصل بودن و صادق بودن', () => {
  it('بدون منبع، ایندکس هیچ ادعایی نمی‌کند: diagnosticsRun نوشته نمی‌شود', async () => {
    const { projectIndex } = await pipeline().run();

    expect(projectIndex.diagnosticsRun).toBeUndefined();
    expect(projectIndex.files.every(f => (f.diagnostics ?? []).length === 0)).toBe(true);
  });

  it('با منبع، diagnostics روی فایل می‌نشیند و ایندکس می‌گوید مرحله اجرا شده', async () => {
    const report = { calls: [] as string[] };
    const { projectIndex } = await pipeline({ diagnosticsSource: fakeSource(report) }).run();

    const a = fileAt(projectIndex.files, 'src/a.ts');
    const diagnostics = a.diagnostics ?? [];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe('error');
    expect(diagnostics[0]!.source).toBe('ts');
    expect(diagnostics[0]!.message).toContain('a.ts');

    expect(projectIndex.files.flatMap(f => f.diagnostics ?? [])).toHaveLength(2);

    expect(projectIndex.diagnosticsRun).toMatchObject({
      filesWithFindings: 2,
      filesSkippedByBudget: 0,
    });
    expect(typeof projectIndex.diagnosticsRun?.budgetMs).toBe('number');
    expect(typeof projectIndex.diagnosticsRun?.completedAt).toBe('string');
  });

  it('فایل باینری به زبان‌سرور فرستاده نمی‌شود، ولی و فایل غیرباینری فرستاده می‌شود', async () => {
    const report = { calls: [] as string[] };
    const { projectIndex } = await pipeline({ diagnosticsSource: fakeSource(report) }).run();

    expect(projectIndex.files.find(f => f.path === 'blob.dat')?.binary).toBe(true);
    expect(report.calls).not.toContain('blob.dat');
    expect(report.calls.sort()).toEqual(['a.ts', 'b.ts', 'notes.md']);
  });

  it('بودجهٔ صفر یعنی «نگاه نشد» — و این در ایندکس ثبت می‌شود، نه در سکوت', async () => {
    const warnings: unknown[] = [];
    const { projectIndex } = await pipeline({
      diagnosticsSource: fakeSource({ calls: [] }),
      diagnosticsBudgetMs: 0,
      logger: fakeLogger(warnings),
    }).run();

    expect(projectIndex.diagnosticsRun?.filesWithFindings).toBe(0);
    expect((projectIndex.diagnosticsRun?.filesSkippedByBudget ?? 0)).toBeGreaterThan(0);
    expect(
      warnings.some(entry => (entry as { message: string; level: string }).message === 'diagnostics budget exhausted')
    ).toBe(true);
  });

  it('diagnostics سطح پروژه هم تجمیع می‌شود، نه فقط روی فایل', async () => {
    const { projectIndex } = await pipeline({ diagnosticsSource: fakeSource({ calls: [] }) }).run();

    expect(projectIndex.diagnostics.filter(d => d.source === 'ts')).toHaveLength(2);
  });
});

describe('createExtractors — درز منبع diagnostics', () => {
  it('پیش‌فرض هیچ منبعی نمی‌سازد (هزینهٔ زبان‌سرور باید خواسته شود)', () => {
    const plain = createExtractors({ workspaceRoot: workspace, treeSitter: false });
    try {
      expect(plain.diagnosticsSource).toBeNull();
    } finally {
      plain.dispose();
    }
  });

  it('dispose بدون منبع هم امن است', () => {
    const plain = createExtractors({ workspaceRoot: workspace, treeSitter: false });
    expect(() => plain.dispose()).not.toThrow();
  });
});
