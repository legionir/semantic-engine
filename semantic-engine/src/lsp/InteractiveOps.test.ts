/**
 * LSP-16 — عملیات تک‌درخواستی، آن‌طور که یک عامل مصرفشان می‌کند.
 *
 * دو چیز اینجا بیش از بقیه اهمیت دارد:
 *
 * ۱. **`dry_run` باید واقعاً هیچ‌کاری نکند** — و پیش‌نمایشش باید
 *    دقیقاً همان چیزی باشد که اعمال می‌شود.
 * ۲. **سرور طرفِ قابل‌اعتماد نیست.** یک `WorkspaceEdit` که به
 *    `/etc/passwd` اشاره کند باید رد شود، نه اینکه اجرا شود.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from './LspClient';
import { InteractiveOps, LspOperationError, isPlausibleIdentifier } from './InteractiveOps';

const FAKE_SERVER = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');

let workspace: string;
let clients: LspClient[];

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-ops-'));
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.stop();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function startFake(args: string[] = []): Promise<LspClient> {
  const client = new LspClient({
    id: 'fake',
    command: process.execPath,
    args: [FAKE_SERVER, ...args],
    rootPath: workspace,
    requestTimeoutMs: 4000,
    initializeTimeoutMs: 4000,
    shutdownTimeoutMs: 2000,
  });
  clients.push(client);
  await client.start();
  return client;
}

function write(relative: string, content: string): string {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function opsFor(client: LspClient | null, over: Record<string, unknown> = {}) {
  return new InteractiveOps({
    acquire: async () => client,
    rootPath: workspace,
    ...over,
  });
}

const SOURCE = [
  'export function calculatePrice(base: number): number {',
  '    return base * 2;',
  '}',
  '',
  'export function total(): number {',
  '    return calculatePrice(1);',
  '}',
  '',
].join('\n');

describe('LSP-16 — rename', () => {
  it('پذیرش: یک WorkspaceEdit معتبر می‌دهد', async () => {
    const client = await startFake();
    write('src/a.ts', SOURCE);

    const result = await opsFor(client).rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'computePrice');

    expect(result.ok).toBe(true);
    expect(result.totalEdits).toBe(2);
    expect(result.files.map(file => file.path)).toEqual([path.join('src', 'a.ts')]);
    expect(result.files[0].after).toContain('export function computePrice');
    expect(result.files[0].after).toContain('return computePrice(1);');
  });

  it('پذیرش: در حالت dry_run هیچ فایلی عوض نمی‌شود', async () => {
    const client = await startFake();
    const file = write('src/a.ts', SOURCE);

    const result = await opsFor(client).rename(
      'src/a.ts',
      'typescript',
      { line: 1, column: 17 },
      'computePrice',
      { dryRun: true }
    );

    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(SOURCE);
  });

  it('dry_run پیش‌فرض است — نوشتن باید صریح خواسته شود', async () => {
    const client = await startFake();
    const file = write('src/a.ts', SOURCE);

    const result = await opsFor(client).rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'computePrice');

    expect(result.dryRun).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(SOURCE);
  });

  it('با dryRun: false واقعاً می‌نویسد، و همان چیزی که پیش‌نمایش داده بود', async () => {
    const client = await startFake();
    const file = write('src/a.ts', SOURCE);
    const ops = opsFor(client);

    const preview = await ops.rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'computePrice');
    const applied = await ops.rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'computePrice', {
      dryRun: false,
    });

    expect(applied.written).toEqual([path.join('src', 'a.ts')]);
    expect(fs.readFileSync(file, 'utf8')).toBe(preview.files[0].after);
  });

  it('پیش‌نمایش، متن کامل بعدی را دارد؛ نتیجهٔ واقعی ندارد', async () => {
    /*
    | برگرداندن متن کامل فایل در حالت اعمال‌شده فقط حجم است: فایل
    | همین حالا روی دیسک است.
    */
    const client = await startFake();
    write('src/a.ts', SOURCE);
    const ops = opsFor(client);

    const preview = await ops.rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'x1');
    const applied = await ops.rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'x2', {
      dryRun: false,
    });

    expect(preview.files[0].after).toBeDefined();
    expect(applied.files[0].after).toBeUndefined();
  });

  it('ویرایشی که بیرون از workspace اشاره کند رد می‌شود', async () => {
    /*
    | سرور طرفِ قابل‌اعتماد نیست. این همان خانوادهٔ SE-SEC-01 است
    | که فاز ۰۴ برای تزریق فرمان بست، از دریچهٔ دیگر.
    */
    const client = await startFake(['--rename-outside']);
    write('src/a.ts', SOURCE);

    const result = await opsFor(client).rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'x', {
      dryRun: false,
    });

    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.message).toMatch(/outside the workspace root/);
  });

  it('نام نامعتبر پیش از تماس با سرور رد می‌شود', async () => {
    const client = await startFake();
    write('src/a.ts', SOURCE);

    await expect(
      opsFor(client).rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'not an identifier')
    ).rejects.toBeInstanceOf(LspOperationError);

    const state = await client.request<{ counts: Record<string, number> }>('test/state', {});
    expect(state.counts['textDocument/rename']).toBeUndefined();
  });

  it('پاسخ null یعنی «تغییری نیست»، نه خطا', async () => {
    const client = await startFake(['--rename-null']);
    write('src/a.ts', SOURCE);

    const result = await opsFor(client).rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'x');
    expect(result.ok).toBe(true);
    expect(result.totalEdits).toBe(0);
    expect(result.message).toMatch(/no changes/);
  });

  it('بدون سرور، خطای روشن می‌دهد', async () => {
    await expect(
      opsFor(null).rename('src/a.ts', 'typescript', { line: 1, column: 1 }, 'x')
    ).rejects.toThrow(/no language server/);
  });

  it('سند بعد از عملیات باز نمی‌ماند', async () => {
    const client = await startFake();
    write('src/a.ts', SOURCE);
    await opsFor(client).rename('src/a.ts', 'typescript', { line: 1, column: 17 }, 'x');
    expect(client.openDocumentCount).toBe(0);
  });
});

describe('LSP-16 — organizeImports', () => {
  it('ویرایش سرور را اعمال می‌کند', async () => {
    const client = await startFake(['--organize-imports']);
    const file = write('src/a.ts', "import { b } from './b';\nexport const x = 1;\n");

    const result = await opsFor(client).organizeImports('src/a.ts', 'typescript', { dryRun: false });

    expect(result.written).toEqual([path.join('src', 'a.ts')]);
    expect(fs.readFileSync(file, 'utf8')).toBe("import { b } from './b'; // organized\nexport const x = 1;\n");
  });

  it('سروری که اقدامی ندارد، خطا نمی‌دهد', async () => {
    const client = await startFake();
    write('src/a.ts', 'export const x = 1;\n');

    const result = await opsFor(client).organizeImports('src/a.ts', 'typescript');
    expect(result.ok).toBe(true);
    expect(result.totalEdits).toBe(0);
    expect(result.message).toMatch(/no organize-imports action/);
  });

  it('dry_run هیچ‌چیز نمی‌نویسد', async () => {
    const client = await startFake(['--organize-imports']);
    const original = "import { b } from './b';\nexport const x = 1;\n";
    const file = write('src/a.ts', original);

    const result = await opsFor(client).organizeImports('src/a.ts', 'typescript', { dryRun: true });

    expect(result.totalEdits).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('LSP-16 — incomingCalls', () => {
  it('فراخوان‌ها با مسیر نسبی و خط یک‌مبنا برمی‌گردند', async () => {
    const client = await startFake();
    write('src/a.ts', SOURCE);

    const calls = await opsFor(client).incomingCalls('src/a.ts', 'typescript', { line: 1, column: 17 });

    expect(calls[0].caller).toBe('caller');
    expect(calls[0].kind).toBe('function');
    expect(calls[0].from.path).toBe(path.join('src', 'a.ts'));
    expect(calls[0].from.line).toBe(6);
    expect(calls[0].callSites[0].line).toBe(7);
  });

  it('SE-LSP-13 — فراخوانِ سطح ماژول، مسیر مطلق را لو نمی‌دهد', async () => {
    /*
    | برای یک فراخوانی در سطح فایل، سرور نام آیتم را **مسیر مطلق**
    | می‌گذارد (`kind: 2`). آن رشته نه قابل حمل است و نه چیزی است
    | که بخواهیم به مدل یا داخل ایندکس بفرستیم.
    */
    const client = await startFake();
    write('src/a.ts', SOURCE);

    const calls = await opsFor(client).incomingCalls('src/a.ts', 'typescript', { line: 1, column: 17 });
    const moduleCall = calls.find(call => call.kind === 'module')!;

    expect(moduleCall.caller).toBe(path.join('src', 'a.ts'));
    expect(path.isAbsolute(moduleCall.caller)).toBe(false);
    expect(moduleCall.caller).not.toContain(os.tmpdir());
  });

  it('جایی که هیچ‌چیز صدا زده نمی‌شود، فهرست خالی است نه خطا', async () => {
    const client = await startFake();
    write('src/a.ts', SOURCE);
    jest.spyOn(client, 'request').mockImplementation(async (method: string) => {
      if (method === 'textDocument/prepareCallHierarchy') return [] as never;
      return null as never;
    });

    const calls = await opsFor(client).incomingCalls('src/a.ts', 'typescript', { line: 1, column: 1 });
    expect(calls).toEqual([]);
  });
});

describe('LSP-16 — definition', () => {
  it('مکان تعریف با مسیر نسبی و خط یک‌مبنا', async () => {
    const client = await startFake();
    write('src/a.ts', SOURCE);

    const found = await opsFor(client).definition('src/a.ts', 'typescript', { line: 6, column: 12 });

    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(path.join('src', 'a.ts'));
    expect(found[0].line).toBe(1);
    expect(found[0].column).toBe(1);
  });

  it('شکل LocationLink هم خوانده می‌شود', async () => {
    const client = await startFake();
    const file = write('src/a.ts', SOURCE);
    jest.spyOn(client, 'request').mockResolvedValue([
      {
        targetUri: client.uriFor(file),
        targetSelectionRange: {
          start: { line: 4, character: 16 },
          end: { line: 4, character: 21 },
        },
      },
    ] as never);

    const found = await opsFor(client).definition('src/a.ts', 'typescript', { line: 6, column: 12 });
    expect(found[0].line).toBe(5);
    expect(found[0].column).toBe(17);
  });

  it('پاسخ خالی یعنی فهرست خالی', async () => {
    const client = await startFake();
    write('src/a.ts', SOURCE);
    jest.spyOn(client, 'request').mockResolvedValue(null as never);

    expect(await opsFor(client).definition('src/a.ts', 'typescript', { line: 1, column: 1 })).toEqual(
      []
    );
  });
});

describe('LSP-16 — diagnostics', () => {
  it('همان مسیر فاز ۳۴، بدون بودجه', async () => {
    const client = await startFake();
    write('src/a.ts', '// ERROR: broken here\n');

    const found = await opsFor(client).diagnostics('src/a.ts', 'typescript');
    expect(found.map(d => [d.severity, d.line])).toEqual([['error', 1]]);
  });
});

describe('isPlausibleIdentifier', () => {
  it.each(['name', '_private', '$dollar', 'مقدار', 'a1', 'A_b$c9'])('«%s» معتبر است', name => {
    expect(isPlausibleIdentifier(name)).toBe(true);
  });

  it.each(['', ' ', '1abc', 'two words', 'end);drop()', 'with\nnewline', 'a-b', 'x.y'])(
    '«%s» رد می‌شود',
    name => {
      expect(isPlausibleIdentifier(name)).toBe(false);
    }
  );
});
