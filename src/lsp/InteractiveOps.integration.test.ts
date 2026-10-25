/**
 * فاز ۳۵ — پذیرش روی زبان‌سرور واقعی.
 *
 * «`rename` یک `WorkspaceEdit` معتبر بدهد و در حالت `dry_run` هیچ
 * فایلی را تغییر ندهد.»
 *
 * سرور ساختگی فقط قرارداد را می‌سنجد. آنچه اینجا سنجیده می‌شود
 * چیزی است که هیچ بدلی نمی‌تواند بسازد: تغییر نامی که **چند فایل** را
 * درست می‌کند، چون کامپایلر می‌داند کدام `calculatePrice` همان
 * `calculatePrice` است.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from './LspClient';
import { InteractiveOps } from './InteractiveOps';
import { resolveTypeScriptLspCommand, describeMissingTypeScriptLsp } from './typescriptServer';

const resolved = resolveTypeScriptLspCommand();

const MATH = [
  "import { helper } from './util';", //                                  1
  '', //                                                                  2
  'export function calculatePrice(base: number): number {', //            3
  '    return helper(base) * 2;', //                                      4
  '}', //                                                                 5
  '', //                                                                  6
  'export function total(items: number[]): number {', //                  7
  '    return items.reduce((sum, item) => sum + calculatePrice(item), 0);', // 8
  '}', //                                                                 9
  '',
].join('\n');

const MAIN = [
  "import { calculatePrice } from './math';", //  1
  '', //                                          2
  'console.log(calculatePrice(10));', //          3
  '',
].join('\n');

const UTIL = ['export function helper(value: number): number {', '    return value + 1;', '}', ''].join(
  '\n'
);

let workspace: string;
let client: LspClient;
let ops: InteractiveOps;

beforeAll(async () => {
  if (!resolved) throw new Error(describeMissingTypeScriptLsp());

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-ops-e2e-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'math.ts'), MATH, 'utf8');
  fs.writeFileSync(path.join(workspace, 'src', 'main.ts'), MAIN, 'utf8');
  fs.writeFileSync(path.join(workspace, 'src', 'util.ts'), UTIL, 'utf8');
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
  ops = new InteractiveOps({ acquire: async () => client, rootPath: workspace });
}, 90_000);

afterAll(async () => {
  ops?.dispose();
  await client?.stop();
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
}, 30_000);

function restore(): void {
  fs.writeFileSync(path.join(workspace, 'src', 'math.ts'), MATH, 'utf8');
  fs.writeFileSync(path.join(workspace, 'src', 'main.ts'), MAIN, 'utf8');
}

/** جای اعلان `calculatePrice` در `src/math.ts` — یک‌مبنا. */
const DECLARATION = { line: 3, column: 17 };

describe('LSP-16 — پذیرش: rename', () => {
  afterEach(restore);

  it('WorkspaceEdit معتبر است و هر دو فایل را می‌شناسد', async () => {
    const result = await ops.rename('src/math.ts', 'typescript', DECLARATION, 'computePrice');

    expect(result.ok).toBe(true);
    expect(result.files.map(file => file.path).sort()).toEqual([
      path.join('src', 'main.ts'),
      path.join('src', 'math.ts'),
    ]);
    // دو ارجاع در math.ts (اعلان و استفاده) و دو تا در main.ts (import و فراخوانی).
    expect(result.totalEdits).toBe(4);
  }, 60_000);

  it('dry_run هیچ فایلی را تغییر نمی‌دهد', async () => {
    const before = {
      math: fs.readFileSync(path.join(workspace, 'src', 'math.ts'), 'utf8'),
      main: fs.readFileSync(path.join(workspace, 'src', 'main.ts'), 'utf8'),
    };

    const result = await ops.rename('src/math.ts', 'typescript', DECLARATION, 'computePrice', {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual([]);
    expect(fs.readFileSync(path.join(workspace, 'src', 'math.ts'), 'utf8')).toBe(before.math);
    expect(fs.readFileSync(path.join(workspace, 'src', 'main.ts'), 'utf8')).toBe(before.main);
  }, 60_000);

  it('اعمال واقعی، دقیقاً همان پیش‌نمایش را می‌نویسد', async () => {
    const preview = await ops.rename('src/math.ts', 'typescript', DECLARATION, 'computePrice');
    const applied = await ops.rename('src/math.ts', 'typescript', DECLARATION, 'computePrice', {
      dryRun: false,
    });

    expect([...applied.written].sort()).toEqual([
      path.join('src', 'main.ts'),
      path.join('src', 'math.ts'),
    ]);

    for (const file of preview.files) {
      expect(fs.readFileSync(path.join(workspace, file.path), 'utf8')).toBe(file.after);
    }

    // و کد بعد از تغییر، همچنان همان چیزی است که انتظار می‌رود.
    const math = fs.readFileSync(path.join(workspace, 'src', 'math.ts'), 'utf8');
    expect(math).toContain('export function computePrice(base: number): number {');
    expect(math).toContain('sum + computePrice(item)');
    expect(math).not.toContain('calculatePrice');

    const main = fs.readFileSync(path.join(workspace, 'src', 'main.ts'), 'utf8');
    expect(main).toContain("import { computePrice } from './math';");
    expect(main).toContain('console.log(computePrice(10));');
  }, 60_000);

  it('پس از تغییر نام، پروژه هیچ خطای تازه‌ای ندارد', async () => {
    /*
    | معیار واقعیِ «معتبر بودن» یک WorkspaceEdit این نیست که شکلش
    | درست باشد؛ این است که کد بعدش هنوز کامپایل شود. جایگزینی
    | متنی با `sed` همین‌جا شکست می‌خورد.
    */
    await ops.rename('src/math.ts', 'typescript', DECLARATION, 'computePrice', { dryRun: false });

    for (const relative of ['src/math.ts', 'src/main.ts']) {
      const found = await ops.diagnostics(relative, 'typescript');
      expect(found.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    }
  }, 90_000);
});

describe('LSP-16 — پذیرش: بقیهٔ عملیات', () => {
  afterEach(restore);

  it('incomingCalls همان چیزی را می‌گوید که گراف حدسی نمی‌داند', async () => {
    /*
    | `calculatePrice` از دو جا صدا زده می‌شود: `total` در همان
    | فایل، و سطح ماژول در `main.ts`. `CallGraphBuilder` امروز
    | دومی را با حدس نام پیدا می‌کند (SE-GRAPH-03).
    */
    const calls = await ops.incomingCalls('src/math.ts', 'typescript', DECLARATION);

    const callers = calls.map(call => call.caller).sort();
    expect(callers).toContain('total');
    expect(callers.some(caller => caller.endsWith('main.ts'))).toBe(true);

    const fromTotal = calls.find(call => call.caller === 'total')!;
    expect(fromTotal.from.path).toBe(path.join('src', 'math.ts'));
    expect(fromTotal.callSites[0].line).toBe(8);

    // و هیچ مسیر مطلقی بیرون نمی‌رود.
    for (const call of calls) expect(path.isAbsolute(call.caller)).toBe(false);
  }, 60_000);

  it('definition به فایل دیگر می‌رسد', async () => {
    const found = await ops.definition('src/math.ts', 'typescript', { line: 4, column: 12 });

    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(path.join('src', 'util.ts'));
    expect(found[0].line).toBe(1);
  }, 60_000);

  it('organizeImports importهای بلااستفاده را برمی‌دارد', async () => {
    const messy = [
      "import { helper } from './util';",
      "import { calculatePrice } from './math';",
      '',
      'console.log(calculatePrice(10));',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(workspace, 'src', 'main.ts'), messy, 'utf8');

    const result = await ops.organizeImports('src/main.ts', 'typescript', { dryRun: false });

    expect(result.ok).toBe(true);
    const after = fs.readFileSync(path.join(workspace, 'src', 'main.ts'), 'utf8');
    expect(after).toContain("import { calculatePrice } from './math';");
    expect(after).not.toContain('helper');
  }, 60_000);

  it('diagnostics بدون بودجه، همان خطاها را می‌دهد', async () => {
    fs.writeFileSync(
      path.join(workspace, 'src', 'main.ts'),
      'export const broken: string = 42;\n',
      'utf8'
    );

    const found = await ops.diagnostics('src/main.ts', 'typescript');
    expect(found.filter(diagnostic => diagnostic.severity === 'error').map(d => d.line)).toEqual([1]);
  }, 60_000);
});
