/**
 * LSP-14 — diagnostics واقعی، از مسیر pull.
 *
 * سرور ساختگی diagnosticها را از **متن سند** می‌سازد (هر خط با
 * `ERROR:` یا `WARN:`)، پس می‌شود خطا را روی یک خط مشخص گذاشت و
 * سنجید که همان شماره خط از آن سر در بیاید. سه تفاوت شکل داده — خط
 * صفرمبنا، `code` عددی، شدت عددی — هرکدام یک خروجی نامعتبر می‌سازند
 * و هرکدام آزمون خودشان را دارند.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from './LspClient';
import { DiagnosticsProvider, severityOf, toSchemaDiagnostic } from './DiagnosticsProvider';
import { contractsDir } from '../export/schemaValidation';

const FAKE_SERVER = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');

let workspace: string;
let clients: LspClient[];

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-diagnostics-'));
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

function providerFor(client: LspClient | null, over: Record<string, unknown> = {}) {
  return new DiagnosticsProvider({ acquire: async () => client, ...over });
}

const BROKEN = ['const ok = 1;', '// ERROR: cannot find name', '// WARN: unused local'].join('\n');

describe('LSP-14 — مسیر pull', () => {
  it('خطاها با شمارهٔ خط درست برمی‌گردند', async () => {
    const client = await startFake();
    const file = write('a.ts', BROKEN);

    const found = await providerFor(client).diagnosticsFor(file, 'typescript', BROKEN, 'file-1');

    expect(found.map(d => [d.severity, d.line, d.message])).toEqual([
      ['error', 2, 'cannot find name'],
      ['warning', 3, 'unused local'],
    ]);
  });

  it('`code` عددی سرور به رشته تبدیل می‌شود', async () => {
    /*
    | `contracts/project-index.schema.json` می‌گوید `code` رشته یا
    | `null` است و `tsgo` عدد می‌فرستد (۶۱۳۳، ۲۵۹۱). بدون تبدیل،
    | اعتبارسنجی فاز ۲۴ کل نوشتن را متوقف می‌کند.
    */
    const client = await startFake();
    const file = write('a.ts', BROKEN);

    const found = await providerFor(client).diagnosticsFor(file, 'typescript', BROKEN, 'file-1');
    expect(found.every(d => typeof d.code === 'string')).toBe(true);
  });

  it('خروجی با تعریف diagnostic در قرارداد سازگار است', async () => {
    /*
    | مستقیم روی `$defs/diagnostic` از `contracts/`، نه روی یک
    | ProjectIndex دست‌ساز: چیزی که سنجیده می‌شود شکل خودِ
    | diagnostic است.
    */
    const client = await startFake();
    const file = write('a.ts', BROKEN);
    const found = await providerFor(client).diagnosticsFor(file, 'typescript', BROKEN, 'file-1');

    const Ajv = require('ajv/dist/2020');
    const schema = JSON.parse(
      fs.readFileSync(path.join(contractsDir(), 'project-index.schema.json'), 'utf8')
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/diagnostic' });

    expect(found.length).toBeGreaterThan(0);
    for (const diagnostic of found) {
      const valid = validate(diagnostic);
      if (!valid) throw new Error(JSON.stringify(validate.errors));
      expect(valid).toBe(true);
    }
  });

  it('متنِ در حافظه سنجیده می‌شود، نه فایل روی دیسک', async () => {
    /*
    | در حالت watch، آنچه روی دیسک است یک ذخیره عقب‌تر است.
    | diagnostic مربوط به نسخهٔ قدیمی بدتر از نبودنش است: کاربر
    | خطایی می‌بیند که همین حالا رفعش کرده.
    */
    const client = await startFake();
    const file = write('a.ts', '// ERROR: this is on disk');

    const found = await providerFor(client).diagnosticsFor(
      file,
      'typescript',
      '// ERROR: this is in memory',
      'file-1'
    );
    expect(found.map(d => d.message)).toEqual(['this is in memory']);
  });

  it('فایل سالم، فهرست خالی می‌دهد', async () => {
    const client = await startFake();
    const file = write('a.ts', 'const fine = 1;\n');
    const found = await providerFor(client).diagnosticsFor(file, 'typescript', 'const fine = 1;\n', 'f');
    expect(found).toEqual([]);
  });

  it('سند بعد از گرفتن diagnostics باز نمی‌ماند', async () => {
    const client = await startFake();
    const file = write('a.ts', BROKEN);
    await providerFor(client).diagnosticsFor(file, 'typescript', BROKEN, 'f');
    expect(client.openDocumentCount).toBe(0);
  });

  it('زبان‌های خارج از فهرست اصلاً پرسیده نمی‌شوند', async () => {
    const client = await startFake();
    const file = write('a.py', '# ERROR: nope');
    const found = await providerFor(client).diagnosticsFor(file, 'python', '# ERROR: nope', 'f');
    expect(found).toEqual([]);

    const state = await client.request<{ counts: Record<string, number> }>('test/state', {});
    expect(state.counts['textDocument/diagnostic']).toBeUndefined();
  });
});

describe('LSP-14 — پاسخ «عوض نشده»', () => {
  it('گزارش unchanged، همان نتیجهٔ قبلی را می‌دهد نه فهرست خالی', async () => {
    /*
    | LSP 3.17 اجازه می‌دهد سرور به‌جای فرستادن دوبارهٔ همه‌چیز
    | بگوید «از resultId قبلی چیزی عوض نشده». `tsgo` این را ندارد
    | (اصلاً `resultId` نمی‌فرستد) و همین باعث شد این شاخه تا
    | اثباتِ برگرداندن بدون آزمون بماند: برگرداندنش هیچ تستی را
    | قرمز نکرد.
    |
    | خطرش روشن است: اگر «عوض نشده» را خالی ترجمه کنیم، فایلی که
    | واقعاً خطا دارد در ایندکس سالم ثبت می‌شود.
    */
    const client = await startFake(['--unchanged-diagnostics']);
    const file = write('a.ts', BROKEN);
    const provider = providerFor(client);

    const first = await provider.diagnosticsFor(file, 'typescript', BROKEN, 'file-1');
    const second = await provider.diagnosticsFor(file, 'typescript', BROKEN, 'file-1');

    expect(first.map(d => d.line)).toEqual([2, 3]);
    expect(second.map(d => d.line)).toEqual([2, 3]);
  });

  it('unchanged بدون هیچ نتیجهٔ قبلی، دفعهٔ بعد دوباره کامل می‌پرسد', async () => {
    const client = await startFake(['--always-unchanged']);
    const file = write('a.ts', BROKEN);
    const provider = providerFor(client);

    const found = await provider.diagnosticsFor(file, 'typescript', BROKEN, 'file-1');
    expect(found).toEqual([]);

    const state = await client.request<{ counts: Record<string, number> }>('test/state', {});
    expect(state.counts['textDocument/diagnostic']).toBe(1);

    // resultId دور ریخته شده، پس درخواست بعدی دوباره کامل است.
    await provider.diagnosticsFor(file, 'typescript', BROKEN, 'file-1');
    const after = await client.request<{ counts: Record<string, number> }>('test/state', {});
    expect(after.counts['textDocument/diagnostic']).toBe(2);
  });
});

describe('LSP-14 — مسیر push به‌عنوان مکمل', () => {
  it('سروری که pull ندارد، از publishDiagnostics خوانده می‌شود', async () => {
    const client = await startFake(['--no-pull-diagnostics', '--push-diagnostics']);
    const file = write('a.ts', BROKEN);

    const found = await providerFor(client, { pushWaitMs: 2000 }).diagnosticsFor(
      file,
      'typescript',
      BROKEN,
      'file-1'
    );

    expect(found.map(d => [d.severity, d.line])).toEqual([
      ['error', 2],
      ['warning', 3],
    ]);
  });

  it('سروری که نه pull دارد و نه push، فقط خالی می‌دهد — نه خطا', async () => {
    const client = await startFake(['--no-pull-diagnostics']);
    const file = write('a.ts', BROKEN);

    const startedAt = Date.now();
    const found = await providerFor(client, { pushWaitMs: 200 }).diagnosticsFor(
      file,
      'typescript',
      BROKEN,
      'file-1'
    );

    expect(found).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it('P-05/SE-F-032 — یک سررسیدِ push، waiter را از map پاک می‌کند (نه انباشته)', async () => {
    /*
    | باگ: `removeWaiter(uri, resolve)` با تابعی مقایسه می‌کرد که در
    | فهرست نبود (فهرست `waiter`ها را نگه می‌داشت)، پس هیچ‌وقت حذف
    | نمی‌شد؛ هر فراخوانِ timeout‌خورده روی یک uri، یک بستهٔ مرده در
    | `pushWaiters` می‌گذاشت. حالا بعد از سررسید، فهرست آن uri خالی است.
    */
    const client = await startFake(['--no-pull-diagnostics']);
    const file = write('a.ts', BROKEN);
    const provider = providerFor(client, { pushWaitMs: 50 });

    await provider.diagnosticsFor(file, 'typescript', BROKEN, 'f1');
    await provider.diagnosticsFor(file, 'typescript', BROKEN, 'f2');

    const waiters = (provider as unknown as {
      pushWaiters: Map<string, (() => void)[]>;
    }).pushWaiters;
    const total = [...waiters.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(0);
  });

  it('وقتی pull هست، منتظر push نمی‌ماند', async () => {
    const client = await startFake(['--push-diagnostics']);
    const file = write('a.ts', BROKEN);

    const startedAt = Date.now();
    await providerFor(client, { pushWaitMs: 5000 }).diagnosticsFor(file, 'typescript', BROKEN, 'f');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe('LSP-14 — وقتی چیزی خراب می‌شود', () => {
  it('خطای سرور، ایندکس را نمی‌شکند', async () => {
    const client = await startFake(['--diagnostic-error']);
    const file = write('a.ts', BROKEN);

    const found = await providerFor(client).diagnosticsFor(file, 'typescript', BROKEN, 'f');
    expect(found).toEqual([]);
  });

  it('نبود سرور یعنی فهرست خالی', async () => {
    const found = await providerFor(null).diagnosticsFor('/tmp/a.ts', 'typescript', '', 'f');
    expect(found).toEqual([]);
  });

  it('سرور کند با سررسید رها می‌شود', async () => {
    const client = await startFake();
    const file = write('a.ts', BROKEN);
    jest.spyOn(client, 'request').mockImplementation(() => new Promise(() => undefined));

    const startedAt = Date.now();
    const found = await providerFor(client, { fileBudgetMs: 300 }).diagnosticsFor(
      file,
      'typescript',
      BROKEN,
      'f'
    );

    expect(found).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(4000);
    // و سند پشت سرش باز نمانده است.
    expect(client.openDocumentCount).toBe(0);
  });

  it('فایل با خطاهای بی‌شمار بریده می‌شود و بریدنش اعلام می‌شود', async () => {
    const client = await startFake();
    const many = Array.from({ length: 30 }, (_, index) => `// ERROR: problem ${index}`).join('\n');
    const file = write('a.ts', many);

    const found = await providerFor(client, { maxPerFile: 5 }).diagnosticsFor(
      file,
      'typescript',
      many,
      'f'
    );

    expect(found).toHaveLength(6);
    expect(found[5].severity).toBe('info');
    expect(found[5].message).toMatch(/25 more diagnostic/);
  });
});

// ── نگاشت خالص ────────────────────────────────────────────────────────

describe('toSchemaDiagnostic', () => {
  const at = (line: number, character: number) => ({
    start: { line, character },
    end: { line, character: character + 3 },
  });

  it('خط و ستون یک‌مبنا می‌شوند', () => {
    const mapped = toSchemaDiagnostic({ range: at(0, 0), message: 'x' });
    expect(mapped.line).toBe(1);
    expect(mapped.column).toBe(1);
  });

  it('code عددی رشته می‌شود و code غایب null', () => {
    expect(toSchemaDiagnostic({ range: at(1, 1), message: 'x', code: 2304 }).code).toBe('2304');
    expect(toSchemaDiagnostic({ range: at(1, 1), message: 'x' }).code).toBeNull();
    expect(toSchemaDiagnostic({ range: at(1, 1), message: 'x', code: 'no-unused' }).code).toBe(
      'no-unused'
    );
  });

  it('source خالی به lsp می‌افتد', () => {
    expect(toSchemaDiagnostic({ range: at(0, 0), message: 'x' }).source).toBe('lsp');
    expect(toSchemaDiagnostic({ range: at(0, 0), message: 'x', source: 'ts' }).source).toBe('ts');
  });

  it('fileId پاس داده می‌شود', () => {
    expect(toSchemaDiagnostic({ range: at(0, 0), message: 'x' }, 'f1').fileId).toBe('f1');
    expect(toSchemaDiagnostic({ range: at(0, 0), message: 'x' }).fileId).toBeNull();
  });
});

describe('severityOf', () => {
  it.each([
    [1, 'error'],
    [2, 'warning'],
    [3, 'info'],
    [4, 'hint'],
  ])('%i → %s', (input, expected) => {
    expect(severityOf(input)).toBe(expected);
  });

  it('نبودِ شدت، warning است نه error', () => {
    /*
    | پروتکل می‌گوید کلاینت تصمیم بگیرد. بالا بردن شدتِ چیزی که
    | سرور دربارهٔ آن نظری نداده، به فهرست خطاها مورد جعلی اضافه
    | می‌کند.
    */
    expect(severityOf(undefined)).toBe('warning');
    expect(severityOf(99)).toBe('warning');
  });
});
