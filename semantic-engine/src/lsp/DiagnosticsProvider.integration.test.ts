/**
 * فاز ۳۴ — معیار پذیرش: «فایل با خطای نوع عمدی، همان خطاها را با
 * شماره خط درست در ایندکس تولید کند.»
 *
 * این آزمون از سرِ زنجیره تا ته آن می‌رود: یک workspace واقعی با
 * خطاهای عمدی، زبان‌سرور واقعی، و `IndexPipeline` — نه یک بدل.
 * چیزی که سنجیده می‌شود دقیقاً همان ادعای `SE-DATA-04` است که تا
 * فاز ۲۲ `[]` بود و تا فاز ۳۳ فقط هشدارهای استخراج را داشت.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from '../pipeline/IndexPipeline';
import { createExtractors, ExtractorSet } from '../pipeline/ExtractorFactory';
import { LspClient } from './LspClient';
import { DiagnosticsProvider } from './DiagnosticsProvider';
import { resolveTypeScriptLspCommand, describeMissingTypeScriptLsp } from './typescriptServer';
import { Diagnostic } from '../core/types/project-index.types';

const resolved = resolveTypeScriptLspCommand();

/*
| خطاها عمدی‌اند و هرکدام یک نوع متفاوت‌اند: نام ناشناخته، نوع
| ناسازگار، و مقداردهی غلط یک فیلد. شماره خط هرکدام در نام ثابت
| نوشته شده تا آزمون دربارهٔ «خط درست» صریح باشد.
*/
const BROKEN_FILE = [
  'export function add(a: number, b: number): number {', // 1
  '    return a + unknownName;', //                          2 ← error 2304
  '}', //                                                    3
  '', //                                                     4
  "export const wrong: string = 42;", //                     5 ← error 2322
  '', //                                                     6
  'export class Holder {', //                                7
  '    value: number = "not a number";', //                  8 ← error 2322
  '}', //                                                    9
  '',
].join('\n');

const CLEAN_FILE = ['export function twice(a: number): number {', '    return a * 2;', '}', ''].join(
  '\n'
);

let workspace: string;
let client: LspClient;
let extractors: ExtractorSet;

beforeAll(async () => {
  if (!resolved) throw new Error(describeMissingTypeScriptLsp());

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-e2e-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'broken.ts'), BROKEN_FILE, 'utf8');
  fs.writeFileSync(path.join(workspace, 'src', 'clean.ts'), CLEAN_FILE, 'utf8');
  fs.writeFileSync(
    path.join(workspace, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' } }),
    'utf8'
  );

  client = new LspClient({
    id: 'typescript',
    command: resolved.command,
    args: resolved.args,
    rootPath: workspace,
    initializeTimeoutMs: 60_000,
    requestTimeoutMs: 30_000,
  });
  await client.start();
  extractors = createExtractors({ workspaceRoot: workspace, treeSitter: false });
}, 90_000);

afterAll(async () => {
  extractors?.dispose();
  await client?.stop();
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
}, 30_000);

async function runPipeline(over: Record<string, unknown> = {}) {
  const pipeline = new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(workspace, '.semantic-engine'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    gitCollector: null,
    vectorIndexer: null,
    ...over,
  });
  return pipeline.run();
}

function ofFile(diagnostics: readonly Diagnostic[], fileId: string): Diagnostic[] {
  return diagnostics.filter(diagnostic => diagnostic.fileId === fileId);
}

describe('LSP-14 — پذیرش: خطاهای نوع در ایندکس', () => {
  it('بدون منبع diagnostic، هیچ خطای نوعی در ایندکس نیست', async () => {
    /*
    | نقطهٔ شروع، و همان چیزی که تا امروز بود: ایندکس فقط هشدارهای
    | اسکنر و استخراج را دارد. اگر این آزمون روزی خطای نوع ببیند،
    | یعنی چیزی بی‌سروصدا روشن شده است.
    */
    const { projectIndex } = await runPipeline();
    const typeErrors = projectIndex.diagnostics.filter(d => d.source === 'ts');
    expect(typeErrors).toEqual([]);
  }, 60_000);

  it('با منبع LSP، هر سه خطا با شماره خط درست می‌آیند', async () => {
    const provider = new DiagnosticsProvider({ acquire: async () => client });
    const { projectIndex } = await runPipeline({ diagnosticsSource: provider });

    const broken = projectIndex.files.find(file => file.path.endsWith('broken.ts'))!;
    const errors = ofFile(projectIndex.diagnostics, broken.id).filter(d => d.severity === 'error');

    expect(errors.map(error => error.line).sort((a, b) => a - b)).toEqual([2, 5, 8]);
    expect(errors.map(error => error.code).sort()).toEqual(['2304', '2322', '2322']);
    expect(errors.every(error => error.source === 'ts')).toBe(true);
    expect(errors.find(error => error.line === 2)!.message).toMatch(/unknownName/);

    provider.dispose();
  }, 90_000);

  it('همان diagnosticها روی خودِ FileEntry هم هستند', async () => {
    /*
    | قرارداد دو جا دارد: `files[].diagnostics` و آرایهٔ تجمیعیِ
    | سطح پروژه. فاز ۲۲ لوله‌کشی‌اش را ساخت؛ اینجا سنجیده می‌شود
    | که منبع تازه هم از همان مسیر رد شده باشد.
    */
    const provider = new DiagnosticsProvider({ acquire: async () => client });
    const { projectIndex } = await runPipeline({ diagnosticsSource: provider });

    const broken = projectIndex.files.find(file => file.path.endsWith('broken.ts'))!;
    const onFile = (broken.diagnostics ?? []).filter(
      d => d.source === 'ts' && d.severity === 'error'
    );
    expect(onFile.map(d => d.line).sort((a, b) => a - b)).toEqual([2, 5, 8]);

    /*
    | و چیزی که فقط از این مسیر معلوم می‌شود: سرور برای همین فایل
    | یک `hint` هم می‌فرستد («'b' is declared but its value is never
    | read»). شدت‌ها دست‌نخورده منتقل می‌شوند، نه اینکه همه‌چیز
    | خطا شود.
    */
    const severities = new Set((broken.diagnostics ?? []).map(d => d.severity));
    expect(severities.has('error')).toBe(true);
    expect(severities.has('hint')).toBe(true);

    provider.dispose();
  }, 90_000);

  it('فایل سالم هیچ خطایی نمی‌گیرد', async () => {
    const provider = new DiagnosticsProvider({ acquire: async () => client });
    const { projectIndex } = await runPipeline({ diagnosticsSource: provider });

    const clean = projectIndex.files.find(file => file.path.endsWith('clean.ts'))!;
    expect(ofFile(projectIndex.diagnostics, clean.id).filter(d => d.source === 'ts')).toEqual([]);

    provider.dispose();
  }, 90_000);

  it('خروجی همچنان با قرارداد سازگار است', async () => {
    /*
    | `code` از سرور عدد می‌آید و schema رشته می‌خواهد. بدون تبدیل،
    | اعتبارسنجی فاز ۲۴ اینجا کل نوشتن را متوقف می‌کرد — و این
    | آزمون همان دروازه را روی مسیر واقعی می‌گذارد.
    */
    const provider = new DiagnosticsProvider({ acquire: async () => client });
    const { projectIndex } = await runPipeline({ diagnosticsSource: provider });

    const { JsonExporter } = require('../export/JsonExporter');
    expect(new JsonExporter().validate(projectIndex)).toEqual([]);

    provider.dispose();
  }, 90_000);

  it('بودجهٔ تمام‌شده، ایندکس را نمی‌شکند', async () => {
    const provider = new DiagnosticsProvider({ acquire: async () => client });
    const { projectIndex } = await runPipeline({
      diagnosticsSource: provider,
      diagnosticsBudgetMs: 0,
    });

    expect(projectIndex.files.length).toBeGreaterThan(0);
    expect(projectIndex.diagnostics.filter(d => d.source === 'ts')).toEqual([]);

    provider.dispose();
  }, 90_000);
});
