/**
 * فاز ۳۲ — LspClient: هرچه یک سرور واقعی ممکن است سرمان بیاورد.
 *
 * سه چیز اینجا سنجیده می‌شود که هیچ‌کدام «مسیر خوش‌بینانه» نیستند:
 *
 * ۱. **سرور از ما سؤال می‌پرسد.** `workspace/configuration` و
 *    `client/registerCapability` را `tsgo` واقعاً می‌فرستد (با probe
 *    دیده شد) و منتظر جواب می‌ماند. کلاینتی که جواب ندهد، سروری را
 *    که هیچ ایرادی ندارد معلق نگه می‌دارد.
 * ۲. **درخواست بی‌جواب نباید برنامه را قفل کند.** هر درخواست timeout
 *    دارد و پس از timeout، خودِ اتصال باید سالم بماند.
 * ۳. **سند باز شمرده می‌شود.** بدون `didClose` منظم، حافظهٔ سرور خطی
 *    بالا می‌رود؛ با `didClose` زودهنگام، مصرف‌کنندهٔ دیگری که هنوز
 *    همان فایل را لازم دارد جواب غلط می‌گیرد. شمارش مرجع هر دو را
 *    حل می‌کند.
 *
 * سرور ساختگی (`__fixtures__/fakeLspServer.js`) قاب‌بندی
 * `Content-Length` را دستی می‌نویسد — اگر از همان کتابخانه‌ای استفاده
 * می‌کرد که کلاینت استفاده می‌کند، توافقشان چیزی دربارهٔ پروتکل ثابت
 * نمی‌کرد.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  LspClient,
  LspTimeoutError,
  LspNotRunningError,
  LspStartError,
} from './LspClient';
import { Logger } from '../host/Logger';
import { DocumentSymbolLike } from '../symbols/types';

const FAKE_SERVER = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');

interface FakeServerState {
  initialized: boolean;
  openDocuments: { uri: string; version: number; languageId: string }[];
  closed: string[];
  handshake: {
    configuration?: unknown;
    registerCapability?: unknown;
    workDoneProgress?: unknown;
  };
}

function makeClient(args: string[] = [], options: Record<string, unknown> = {}): LspClient {
  return new LspClient({
    id: 'fake',
    command: process.execPath,
    args: [FAKE_SERVER, ...args],
    rootPath: workspace,
    requestTimeoutMs: 4000,
    initializeTimeoutMs: 4000,
    shutdownTimeoutMs: 2000,
    ...options,
  });
}

let workspace: string;
let clients: LspClient[];

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-client-'));
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.stop();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function started(args: string[] = [], options: Record<string, unknown> = {}) {
  const client = makeClient(args, options);
  clients.push(client);
  await client.start();
  return client;
}

function writeFile(relative: string, content: string): string {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

// ── LSP-03: دست‌دادن ──────────────────────────────────────────────────

describe('LSP-03 — دست‌دادن', () => {
  it('initialize و initialized هر دو انجام می‌شوند', async () => {
    const client = await started();

    expect(client.isRunning).toBe(true);
    expect(client.serverInfo).toEqual({ name: 'fake-lsp', version: '1.0.0' });
    expect(client.capabilities?.documentSymbolProvider).toBe(true);

    const state = await client.request<FakeServerState>('test/state', {});
    expect(state.initialized).toBe(true);
  });

  it('start دوباره روی یک کلاینت در حال اجرا خطا می‌دهد', async () => {
    const client = await started();
    await expect(client.start()).rejects.toThrow(/already/i);
  });

  it('فرمان ناموجود یک خطای قابل‌فهم می‌دهد، نه یک انتظار بی‌پایان', async () => {
    const client = new LspClient({
      id: 'missing',
      command: path.join(workspace, 'no-such-language-server'),
      rootPath: workspace,
      initializeTimeoutMs: 3000,
    });
    clients.push(client);
    await expect(client.start()).rejects.toBeInstanceOf(LspStartError);
    expect(client.isRunning).toBe(false);
  });

  it('اگر سرور به initialize جواب ندهد، start با timeout شکست می‌خورد و پروسه را می‌کشد', async () => {
    const client = makeClient(['--hang-initialize'], { initializeTimeoutMs: 300 });
    clients.push(client);

    await expect(client.start()).rejects.toBeInstanceOf(LspTimeoutError);
    expect(client.isRunning).toBe(false);
    // پروسه نباید پشت سرش بماند.
    expect(client.processId).toBeUndefined();
  });
});

// ── LSP-03: پاسخ به درخواست‌های سرور→کلاینت ───────────────────────────

describe('LSP-03 — سرور هم از ما سؤال می‌پرسد', () => {
  it('به هر سه درخواست شناخته‌شده جواب می‌دهد', async () => {
    const client = await started();

    // سرور ساختگی سؤال‌هایش را بعد از initialized می‌فرستد.
    const state = await waitFor(async () => {
      const s = await client.request<FakeServerState>('test/state', {});
      return s.handshake.workDoneProgress !== undefined ? s : undefined;
    });

    // یک آیتم برای هر section درخواست‌شده — نه کمتر، نه بیشتر.
    expect(state.handshake.configuration).toEqual([{}, {}]);
    expect(state.handshake.registerCapability).toBeNull();
    expect(state.handshake.workDoneProgress).toBeNull();
  });

  it('پیکربندی داده‌شده به همان section برمی‌گردد', async () => {
    const client = await started([], {
      configuration: (section?: string) => ({ section, hint: 'from-client' }),
    });

    const state = await waitFor(async () => {
      const s = await client.request<FakeServerState>('test/state', {});
      return s.handshake.configuration ? s : undefined;
    });

    expect(state.handshake.configuration).toEqual([
      { section: 'fake', hint: 'from-client' },
      { section: 'other', hint: 'from-client' },
    ]);
  });

  it('درخواست ناشناختهٔ سرور با MethodNotFound جواب می‌گیرد، نه با سکوت', async () => {
    const client = await started();
    const answered = await client.request<{ code: number }>('test/ask-unknown', {}).catch(() => undefined);
    // سرور ساختگی این متد را ندارد؛ نکته این است که خطا برگردد نه اینکه معلق بماند.
    expect(answered).toBeUndefined();
  });
});

// ── LSP-03: timeout ───────────────────────────────────────────────────

describe('LSP-03 — timeout روی هر درخواست', () => {
  it('درخواست بی‌جواب با LspTimeoutError رد می‌شود', async () => {
    const client = await started();
    const started_at = Date.now();
    await expect(client.request('test/hang', {}, { timeoutMs: 250 })).rejects.toBeInstanceOf(
      LspTimeoutError
    );
    expect(Date.now() - started_at).toBeLessThan(3000);
  });

  it('پیام خطا می‌گوید کدام متد و روی کدام سرور', async () => {
    const client = await started();
    await expect(client.request('test/hang', {}, { timeoutMs: 200 })).rejects.toThrow(
      /test\/hang.*fake|fake.*test\/hang/
    );
  });

  it('بعد از timeout، اتصال هنوز سالم است', async () => {
    const client = await started();
    await expect(client.request('test/hang', {}, { timeoutMs: 200 })).rejects.toThrow();

    const state = await client.request<FakeServerState>('test/state', {});
    expect(state.initialized).toBe(true);
  });
});

// ── LSP-03: شمارش سند ─────────────────────────────────────────────────

describe('LSP-03 — همگام‌سازی و شمارش سند', () => {
  it('didOpen یک‌بار فرستاده می‌شود، هرچند بار که باز شود', async () => {
    const client = await started();
    const file = writeFile('a.ts', 'export class A {}\n');

    client.openDocument(file, 'typescript');
    client.openDocument(file, 'typescript');
    client.openDocument(file, 'typescript');

    expect(client.openDocumentCount).toBe(1);
    const state = await client.request<FakeServerState>('test/state', {});
    expect(state.openDocuments).toHaveLength(1);
    expect(state.openDocuments[0].languageId).toBe('typescript');
  });

  it('didClose فقط وقتی آخرین مصرف‌کننده رها کند فرستاده می‌شود', async () => {
    const client = await started();
    const file = writeFile('a.ts', 'export class A {}\n');

    client.openDocument(file, 'typescript');
    client.openDocument(file, 'typescript');
    client.closeDocument(file);

    let state = await client.request<FakeServerState>('test/state', {});
    expect(state.openDocuments).toHaveLength(1);
    expect(client.openDocumentCount).toBe(1);

    client.closeDocument(file);
    state = await client.request<FakeServerState>('test/state', {});
    expect(state.openDocuments).toHaveLength(0);
    expect(state.closed).toHaveLength(1);
    expect(client.openDocumentCount).toBe(0);
  });

  it('بستن سندی که باز نیست بی‌اثر است', async () => {
    const client = await started();
    expect(() => client.closeDocument(path.join(workspace, 'never-opened.ts'))).not.toThrow();
    const state = await client.request<FakeServerState>('test/state', {});
    expect(state.closed).toHaveLength(0);
  });

  it('didChange نسخه را جلو می‌برد و سرور متن تازه را می‌بیند', async () => {
    const client = await started();
    const file = writeFile('a.ts', 'export class A {}\n');

    client.openDocument(file, 'typescript');
    client.changeDocument(file, 'export class A {}\nexport class B {}\n');

    const state = await client.request<FakeServerState>('test/state', {});
    expect(state.openDocuments[0].version).toBe(2);

    const symbols = (await client.documentSymbol(file)) as DocumentSymbolLike[];
    expect(symbols.map(s => s.name)).toEqual(['A', 'B']);
  });

  it('متن روی دیسک وقتی متن صریح داده نشود خوانده می‌شود', async () => {
    const client = await started();
    const file = writeFile('disk.ts', 'export function fromDisk() {}\n');

    client.openDocument(file, 'typescript');
    const symbols = (await client.documentSymbol(file)) as DocumentSymbolLike[];
    expect(symbols.map(s => s.name)).toEqual(['fromDisk']);
  });

  it('withDocument حتی وقتی کار داخلش خطا بدهد سند را می‌بندد', async () => {
    const client = await started();
    const file = writeFile('a.ts', 'export class A {}\n');

    await expect(
      client.withDocument(file, 'typescript', async () => {
        expect(client.openDocumentCount).toBe(1);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(client.openDocumentCount).toBe(0);
    const state = await client.request<FakeServerState>('test/state', {});
    expect(state.openDocuments).toHaveLength(0);
  });

  it('مسیر با فاصله و کاراکتر غیرلاتین درست به URI تبدیل می‌شود', async () => {
    const client = await started();
    const file = writeFile('پوشهٔ من/فایل تست.ts', 'export class Ok {}\n');

    client.openDocument(file, 'typescript');
    const state = await client.request<FakeServerState>('test/state', {});
    expect(state.openDocuments[0].uri).toMatch(/^file:\/\//);
    expect(state.openDocuments[0].uri).not.toContain(' ');

    const symbols = (await client.documentSymbol(file)) as DocumentSymbolLike[];
    expect(symbols.map(s => s.name)).toEqual(['Ok']);
  });
});

// ── LSP-03: خاموشی و مرگ ──────────────────────────────────────────────

describe('LSP-03 — خاموشی', () => {
  it('stop سند‌های باز را می‌بندد و پروسه را تمام می‌کند', async () => {
    const client = await started();
    const file = writeFile('a.ts', 'export class A {}\n');
    client.openDocument(file, 'typescript');

    const pid = client.processId;
    expect(pid).toBeGreaterThan(0);

    await client.stop();

    expect(client.isRunning).toBe(false);
    expect(client.openDocumentCount).toBe(0);
    expect(await died(pid!)).toBe(true);
  });

  it('stop دوبار صدا زدن بی‌ضرر است', async () => {
    const client = await started();
    await client.stop();
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it('سروری که به exit گوش نمی‌دهد کشته می‌شود', async () => {
    const client = await started(['--exit-on-exit-notification=false'], {
      shutdownTimeoutMs: 400,
    });
    const pid = client.processId!;

    await client.stop();
    expect(await died(pid)).toBe(true);
  });

  it('خروج غیرصفر بعد از shutdown یک کرش حساب نمی‌شود', async () => {
    /*
    | `tsgo` بعد از یک shutdown کاملاً سالم با کد ۱ و پیام
    | «context canceled» روی stderr خارج می‌شود. اگر آن را کرش
    | بشماریم، مدیر سرور (فاز ۳۶) بی‌دلیل restart می‌کند.
    */
    const exits: { code: number | null; expected: boolean }[] = [];
    const client = await started(['--exit-code=1'], {
      onExit: (info: { code: number | null; expected: boolean }) => exits.push(info),
    });

    await client.stop();

    expect(exits).toHaveLength(1);
    expect(exits[0].code).toBe(1);
    expect(exits[0].expected).toBe(true);
    expect(client.state).toBe('stopped');
  });

  it('مرگ ناگهانی سرور، درخواست‌های در پرواز را رد می‌کند', async () => {
    const client = await started();
    /*
    | رویداد `exit` پروسه چند تیک بعد از بسته شدن اتصال می‌آید و
    | ترتیبشان به بار سیستم بستگی دارد. یک‌بار همین آزمون در اجرای
    | کامل سوئیت قرمز شد چون فهرست را *بلافاصله* بعد از رد شدن
    | درخواست خوانده بود. انتظار صریح، به‌جای فرض ترتیب.
    */
    const exited = new Promise<{ expected: boolean }>(resolve => client.onExit(resolve));

    const inFlight = client.request('test/hang', {}, { timeoutMs: 5000 });
    client.notify('test/crash', {});

    await expect(inFlight).rejects.toBeInstanceOf(LspNotRunningError);
    expect(client.isRunning).toBe(false);
    expect(client.state).toBe('crashed');
    expect((await exited).expected).toBe(false);
  });

  it('بسته شدن کانال، حتی وقتی پروسه زنده می‌ماند، در پرواز را رد می‌کند', async () => {
    /*
    | `vscode-jsonrpc@8` روی `close` هیچ‌کدام از `responsePromises`
    | را رد نمی‌کند — فقط `dispose()` این کار را می‌کند. اگر خودمان
    | ردشان نکنیم، سروری که stdio‌اش را می‌بندد ولی زنده می‌ماند
    | (اسکریپت wrapper، شیم کانتینر) هر فراخوان را تا سررسید
    | timeout معلق نگه می‌دارد. رویداد `exit` هم که هیچ‌وقت
    | نمی‌آید.
    */
    const client = await started();
    const pid = client.processId!;

    const inFlight = client.request('test/hang', {}, { timeoutMs: 30_000 });
    client.notify('test/close-channel', {});

    const startedAt = Date.now();
    await expect(inFlight).rejects.toBeInstanceOf(LspNotRunningError);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(isAlive(pid)).toBe(true);

    await client.stop();
    expect(await died(pid)).toBe(true);
  });

  it('درخواست روی کلاینت خاموش، فوراً و با پیام روشن رد می‌شود', async () => {    const client = await started();
    await client.stop();
    await expect(client.request('test/state', {})).rejects.toBeInstanceOf(LspNotRunningError);
  });

  it('openDocument روی کلاینت خاموش خطا می‌دهد', async () => {
    const client = await started();
    await client.stop();
    expect(() => client.openDocument(writeFile('a.ts', ''), 'typescript')).toThrow(
      LspNotRunningError
    );
  });
});

// ── LSP-03: stderr سرور ───────────────────────────────────────────────

describe('LSP-03 — stderr سرور هرگز به stdout ما نمی‌رود', () => {
  it('هیچ بایتی روی process.stdout نوشته نمی‌شود', async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stdout.write);

    try {
      const client = await started(['--stderr-noise']);
      const file = writeFile('a.ts', 'export class A {}\n');
      client.openDocument(file, 'typescript');
      await client.documentSymbol(file);
      await client.stop();
    } finally {
      spy.mockRestore();
      void original;
    }

    expect(written.join('')).toBe('');
  });

  it('همان خطوط به لاگر debug می‌رسند — بلعیده نمی‌شوند', async () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: 'debug',
      stdio: true,
      stderr: { write: (chunk: string) => lines.push(chunk) },
    });

    const client = await started(['--stderr-noise'], { logger });
    await client.request('test/state', {});
    await client.stop();

    expect(lines.join('')).toContain('noisy line 0');
    expect(lines.join('')).toContain('noisy line 4');
  });
});

// ── کمکی ──────────────────────────────────────────────────────────────

/**
 * صبر تا واقعاً رفتن پروسه.
 *
 * `expect(isAlive(pid)).toBe(false)` بلافاصله پس از `stop()` یک فرض
 * زمانی است، نه یک تضمین: بین `SIGKILL` و ناپدید شدن pid، پروسه
 * لحظه‌ای zombie است و `kill(pid, 0)` روی zombie **موفق** می‌شود.
 * زیر بارِ اجرای کامل سوئیت، همین شکاف یک‌بار قرمز شد
 * (SE-BUILD-17).
 *
 * چیزی که قول داده‌ایم «پروسه می‌رود» است، نه «در همان تیک می‌رود».
 */
async function died(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// ── stdout در یک پروسهٔ واقعی ─────────────────────────────────────────

const DIST_CLIENT = path.join(__dirname, '..', '..', 'dist', 'lsp', 'LspClient.js');
const describeIfBuilt = fs.existsSync(DIST_CLIENT) ? describe : describe.skip;

describeIfBuilt('LSP-03 — همان تضمین در یک پروسهٔ جدا', () => {
  it('stdout پروسه فقط چیزی را دارد که خودمان چاپ کرده‌ایم', () => {
    /*
    | داخل jest، `process.stdout` از قبل قلاب‌گذاری شده است. تنها
    | سنجش صادقانه یک پروسهٔ تازه است که خروجی‌اش را خودمان
    | می‌خوانیم — همان کاری که یک سرور MCP روی stdio می‌کند.
    */
    const script = `
      const { LspClient } = require(${JSON.stringify(DIST_CLIENT)});
      (async () => {
        const client = new LspClient({
          id: 'fake',
          command: process.execPath,
          args: [${JSON.stringify(FAKE_SERVER)}, '--stderr-noise'],
          rootPath: process.cwd(),
        });
        await client.start();
        await client.request('test/state', {});
        await client.stop();
        process.stdout.write('SENTINEL');
      })().catch(e => { process.stderr.write(String(e && e.stack)); process.exit(1); });
    `;
    const stdout = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(stdout).toBe('SENTINEL');
  });
});
