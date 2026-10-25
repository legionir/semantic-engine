/**
 * LSP-13 — آیا سرور ساختگی همان‌طور حرف می‌زند که سرور واقعی؟
 *
 * ده سوئیت از فاز ۳۲ به بعد روی `__fixtures__/fakeLspServer.js`
 * ساخته شده‌اند. اگر آن فایل جایی از پروتکل را غلط بازی کند، همهٔ
 * آن آزمون‌ها یک توهم مشترک را تأیید می‌کنند و هیچ‌کدام چیزی دربارهٔ
 * سرور واقعی ثابت نمی‌کنند.
 *
 * این آزمون **یک سؤال را از هر دو می‌پرسد** و شکل جواب را مقایسه
 * می‌کند — نه مقدارش. جایی که عمداً فرق دارند هم همین‌جا ثبت شده
 * است، چون تفاوتِ نانوشته همان توهم است با یک قدم فاصله.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from './LspClient';
import { resolveTypeScriptLspCommand, describeMissingTypeScriptLsp } from './typescriptServer';
import { DocumentSymbolLike } from '../symbols/types';

const FAKE_SERVER = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');
const resolved = resolveTypeScriptLspCommand();

const SOURCE = [
  'export class Widget {', //   1
  '  render(): void {}', //     2
  '}', //                       3
  '', //                        4
  'export function build() {', //5
  '  const w = new Widget();', //6
  '  w.render();', //           7
  '}', //                       8
  '',
].join('\n');

let workspace: string;
let real: LspClient;
let fake: LspClient;
let file: string;

beforeAll(async () => {
  if (!resolved) throw new Error(describeMissingTypeScriptLsp());

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-contract-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  file = path.join(workspace, 'src', 'widget.ts');
  fs.writeFileSync(file, SOURCE, 'utf8');
  fs.writeFileSync(
    path.join(workspace, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' } }),
    'utf8'
  );

  real = new LspClient({
    id: 'real',
    command: resolved.command,
    args: resolved.args,
    rootPath: workspace,
    initializeTimeoutMs: 60_000,
  });
  fake = new LspClient({
    id: 'fake',
    command: process.execPath,
    args: [FAKE_SERVER],
    rootPath: workspace,
    initializeTimeoutMs: 10_000,
  });

  await Promise.all([real.start(), fake.start()]);
}, 90_000);

afterAll(async () => {
  await Promise.all([real?.stop(), fake?.stop()]);
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
}, 30_000);

/** همان پرسش، از هر دو. */
async function fromBoth<T>(ask: (client: LspClient) => Promise<T>): Promise<{ real: T; fake: T }> {
  return { real: await ask(real), fake: await ask(fake) };
}

describe('LSP-13 — قاب‌بندی و دست‌دادن', () => {
  it('هر دو `initialize` را با همان شکل جواب می‌دهند', () => {
    for (const client of [real, fake]) {
      expect(client.isRunning).toBe(true);
      expect(typeof client.serverInfo?.name).toBe('string');
      expect(client.capabilities?.documentSymbolProvider).toBeTruthy();
      expect(client.capabilities?.textDocumentSync).toBeDefined();
    }
  });

  it('هر دو `positionEncoding` را اعلام می‌کنند یا هیچ‌کدام', () => {
    /*
    | سرور ساختگی این را از سرور واقعی کپی کرده. اگر روزی واقعی
    | عوض شود و ساختگی نه، این آزمون می‌گوید.
    */
    expect(typeof real.capabilities?.positionEncoding).toBe(
      typeof fake.capabilities?.positionEncoding
    );
  });
});

describe('LSP-13 — documentSymbol', () => {
  it('هر دو آرایهٔ سلسله‌مراتبی با همان کلیدها می‌دهند', async () => {
    const answers = await fromBoth(client =>
      client.withDocument(file, 'typescript', () => client.documentSymbol(file), SOURCE)
    );

    for (const [name, value] of Object.entries(answers)) {
      const symbols = value as DocumentSymbolLike[];
      expect(Array.isArray(symbols)).toBe(true);
      expect(symbols.length).toBeGreaterThan(0);

      const first = symbols[0];
      expect(typeof first.name).toBe(`string`);
      expect(typeof first.kind).toBe('number');
      expect(typeof first.range.start.line).toBe('number');
      expect(typeof first.selectionRange.start.line).toBe('number');
      // خط‌ها صفرمبنا‌اند — در هر دو.
      expect(first.range.start.line).toBeGreaterThanOrEqual(0);
      expect(name).toMatch(/real|fake/);
    }
  }, 60_000);

  it('هر دو `Widget` را روی خط اول می‌بینند', async () => {
    const answers = await fromBoth(client =>
      client.withDocument(file, 'typescript', () => client.documentSymbol(file), SOURCE)
    );

    for (const symbols of [answers.real, answers.fake] as DocumentSymbolLike[][]) {
      const widget = symbols.find(symbol => symbol.name === 'Widget');
      expect(widget).toBeDefined();
      expect(widget!.range.start.line).toBe(0);
    }
  }, 60_000);

  it('⚠ اختلاف عمدی: ساختگی سلسله‌مراتب ندارد', async () => {
    /*
    | سرور واقعی `render` را فرزند `Widget` می‌کند؛ ساختگی همه را
    | تخت می‌دهد. برای آزمون‌های قرارداد (باز/بسته شدن سند،
    | سررسید، بودجه) فرقی نمی‌کند و ساده نگه داشتنش عمدی است.
    | نوشتنش اینجا یعنی کسی که روی ساختگی آزمونی دربارهٔ
    | *سلسله‌مراتب* بنویسد، می‌داند که هیچ‌چیز را ثابت نکرده.
    */
    const answers = await fromBoth(client =>
      client.withDocument(file, 'typescript', () => client.documentSymbol(file), SOURCE)
    );

    const realTop = answers.real as DocumentSymbolLike[];
    const fakeTop = answers.fake as DocumentSymbolLike[];

    expect(realTop.some(symbol => (symbol.children ?? []).length > 0)).toBe(true);
    expect(fakeTop.every(symbol => (symbol.children ?? []).length === 0)).toBe(true);
  }, 60_000);
});

describe('LSP-13 — خطا و متد ناشناخته', () => {
  it('هر دو به متد ناشناخته *جواب* می‌دهند، نه سکوت', async () => {
    const codes: Record<string, unknown> = {};
    for (const [name, client] of [['real', real], ['fake', fake]] as const) {
      try {
        await client.request('textDocument/thisDoesNotExist', {}, { timeoutMs: 8_000 });
        throw new Error(`${name} answered a method that does not exist`);
      } catch (error) {
        codes[name] = (error as { code?: number }).code;
      }
    }

    /*
    | SE-LSP-05: کدها یکی نیستند — `tsgo` عدد ‎-32600
    | (InvalidRequest) می‌دهد و ساختگی ‎-32601 (MethodNotFound) که
    | استاندارد است. هر دو رفتار واقعی‌اند و هیچ کدی نباید مبنای
    | تصمیم باشد؛ فقط «جواب آمد» مهم است.
    */
    expect(codes.real).toBeDefined();
    expect(codes.fake).toBeDefined();
    expect([-32600, -32601]).toContain(codes.real);
    expect([-32600, -32601]).toContain(codes.fake);
  }, 30_000);
});

describe('LSP-13 — همگام‌سازی سند', () => {
  it('هر دو `didChange` را می‌بینند', async () => {
    const changed = `${SOURCE}\nexport class AddedLater {}\n`;

    for (const client of [real, fake]) {
      client.openDocument(file, 'typescript', SOURCE);
      try {
        client.changeDocument(file, changed);
        const symbols = (await client.documentSymbol(file)) as DocumentSymbolLike[];
        expect(symbols.map(symbol => symbol.name)).toContain('AddedLater');
      } finally {
        client.closeDocument(file);
      }
    }
  }, 60_000);

  it('هر دو بعد از `didClose` سند باز نگه نمی‌دارند', () => {
    expect(real.openDocumentCount).toBe(0);
    expect(fake.openDocumentCount).toBe(0);
  });
});

describe('LSP-13 — خاموشی', () => {
  it('هر دو با shutdown/exit می‌روند — با هر کد خروجی که باشد', async () => {
    /*
    | SE-LSP-04: خروج تمیزِ `tsgo` کد ۱ می‌دهد و ساختگی صفر. آنچه
    | مشترک است و مهم: پروسه می‌رود و `expected` درست است.
    */
    const clients = [
      new LspClient({
        id: 'real-2',
        command: resolved!.command,
        args: resolved!.args,
        rootPath: workspace,
        initializeTimeoutMs: 60_000,
      }),
      new LspClient({
        id: 'fake-2',
        command: process.execPath,
        args: [FAKE_SERVER],
        rootPath: workspace,
        initializeTimeoutMs: 10_000,
      }),
    ];

    for (const client of clients) {
      const exits: { expected: boolean }[] = [];
      client.onExit(info => exits.push(info));
      await client.start();
      const pid = client.processId!;

      await client.stop();

      expect(client.state).toBe('stopped');
      expect(exits[0]?.expected).toBe(true);
      expect(await died(pid)).toBe(true);
    }
  }, 90_000);
});

/** صبر تا واقعاً رفتن پروسه — SE-BUILD-17. `kill(pid,0)` روی zombie موفق است. */
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
