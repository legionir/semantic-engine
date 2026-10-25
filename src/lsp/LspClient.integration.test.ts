/**
 * فاز ۳۲ — معیار پذیرش: اتصال به زبان‌سرور *واقعی*.
 *
 * سرور ساختگی ثابت می‌کند کلاینت با یک همتای مؤدب چه می‌کند. این فایل
 * ثابت می‌کند با همتای واقعی چه می‌کند — همان که رفتارهای غیرمنتظره‌اش
 * (سؤال پرسیدن حین راه‌اندازی، خروج با کد ۱، کد خطای ‎-32600) اصلاً
 * دلیل شکل گرفتن این طراحی بودند.
 *
 * اگر سرور نصب نباشد سوئیت **skip نمی‌شود**، شکست می‌خورد. فاز ۲۱
 * نشان داد یک سوئیت خاموش، بدترین حالت است: عدد تست‌ها بالا می‌رود و
 * پوششی وجود ندارد. `@typescript/native-preview` در
 * `devDependencies` است، پس نبودنش یعنی محیط ناقص است، نه اینکه
 * آزمون بی‌ربط است.
 */

import * as path from 'path';
import * as fs from 'fs';
import { LspClient } from './LspClient';
import { isHierarchical } from './protocol';
import { DocumentSymbolLike, LspSymbolKind } from '../symbols/types';
import {
  describeMissingTypeScriptLsp,
  resolveTypeScriptLspCommand,
  supportsLsp,
} from './typescriptServer';

const FIXTURE = path.join(__dirname, '..', '..', 'test-fixture');
const resolved = resolveTypeScriptLspCommand();

describe('LSP-01 — پیدا کردن زبان‌سرور TypeScript', () => {
  it('در این محیط پیدا می‌شود', () => {
    if (!resolved) throw new Error(describeMissingTypeScriptLsp());
    expect(resolved.command).toBeTruthy();
    expect(resolved.args).toEqual(['--lsp', '--stdio']);
    expect(fs.existsSync(resolved.command)).toBe(true);
  });

  it('نسخهٔ پیداشده واقعاً `--lsp` دارد', () => {
    expect(supportsLsp(resolved?.version ?? null)).toBe(true);
  });

  it('باینریِ typescript@5 خودمان انتخاب نمی‌شود', () => {
    /*
    | ستون فقرات LSP-01. `typescript@5.9.3` که وابستگی خود پکیج است
    | به `--lsp` می‌گوید «Unknown compiler option» و آن پیام را روی
    | stdout می‌نویسد — یعنی درست وسط کانال پروتکل.
    */
    const bundled = require.resolve('typescript/package.json');
    const bundledMajor = Number.parseInt(
      (JSON.parse(fs.readFileSync(bundled, 'utf8')).version as string).split('.')[0],
      10
    );
    expect(bundledMajor).toBeLessThan(7);
    expect(resolved!.command).not.toContain(`${path.sep}typescript${path.sep}bin${path.sep}`);
  });
});

describe('LSP-03 — پذیرش: documentSymbol روی fixture از سرور واقعی', () => {
  let client: LspClient;

  beforeAll(async () => {
    if (!resolved) throw new Error(describeMissingTypeScriptLsp());
    client = new LspClient({
      id: 'typescript',
      command: resolved.command,
      args: resolved.args,
      rootPath: FIXTURE,
      initializeTimeoutMs: 60_000,
      requestTimeoutMs: 30_000,
    });
    await client.start();
  }, 90_000);

  afterAll(async () => {
    await client?.stop();
  }, 30_000);

  it('دست‌دادن کامل می‌شود و سرور خودش را معرفی می‌کند', () => {
    expect(client.isRunning).toBe(true);
    expect(client.serverInfo?.name).toBeTruthy();
    expect(client.capabilities?.documentSymbolProvider).toBeTruthy();
  });

  it('پاسخ سلسله‌مراتبی است — چیزی که heuristic ندارد', async () => {
    const file = path.join(FIXTURE, 'src', 'app.ts');
    const result = await client.withDocument(file, 'typescript', () =>
      client.documentSymbol(file)
    );

    expect(isHierarchical(result)).toBe(true);
    const symbols = result as DocumentSymbolLike[];
    expect(symbols.length).toBeGreaterThan(0);

    const names = symbols.map(symbol => symbol.name);
    expect(names).toContain('Application');

    const application = symbols.find(symbol => symbol.name === 'Application')!;
    expect(application.kind).toBe(LspSymbolKind.Class);
    // چیزی که tree-sitter امروز اشتباه می‌گیرد: پایان واقعی بدنه.
    expect(application.range.end.line).toBeGreaterThan(application.range.start.line);
    const members = (application.children ?? []).map(child => child.name);
    expect(members).toEqual(expect.arrayContaining(['start', 'stop', 'constructor']));
  }, 60_000);

  it('⚠ نام‌های import شده هم به‌عنوان symbol سطح‌بالا برمی‌گردند', async () => {
    /*
    | یافتهٔ probe، و تلهٔ اصلی فاز ۳۳: `tsgo` هر نام import شده را یک
    | `Variable` سطح‌بالا گزارش می‌کند.
    |
    |   kind=13 Logger      L0-0     ← import { Logger } from …
    |   kind=13 UserService L1-1
    |   kind=13 CONFIG      L2-2
    |   kind=13 join        L3-3
    |
    | یعنی هر ادغام ساده‌لوحانه‌ای، به‌ازای هر import یک symbol جعلی
    | به ایندکس اضافه می‌کند. این آزمون رفتار سرور را *ثبت* می‌کند تا
    | استخراج‌گر فاز ۳۳ مجبور شود دربارهٔ آن تصمیم بگیرد.
    */
    const file = path.join(FIXTURE, 'src', 'app.ts');
    const result = (await client.withDocument(file, 'typescript', () =>
      client.documentSymbol(file)
    )) as DocumentSymbolLike[];

    const imported = result.filter(
      symbol =>
        symbol.kind === LspSymbolKind.Variable &&
        symbol.range.start.line === symbol.range.end.line &&
        symbol.range.start.line < 4
    );
    expect(imported.map(symbol => symbol.name)).toEqual([
      'Logger',
      'UserService',
      'CONFIG',
      'join',
    ]);
  }, 60_000);

  it('⚠ این سرور `detail` نمی‌دهد — امضا از LSP در نمی‌آید', async () => {
    /*
    | `LSPMappers` (فاز ۱۰) پارامترها را از `detail` بیرون می‌کشد.
    | `tsgo` این فیلد را اصلاً نمی‌فرستد، پس آن مسیر روی این سرور
    | خالی می‌ماند و امضا باید از tree-sitter بیاید.
    */
    const file = path.join(FIXTURE, 'src', 'app.ts');
    const result = (await client.withDocument(file, 'typescript', () =>
      client.documentSymbol(file)
    )) as DocumentSymbolLike[];

    expect(result.every(symbol => symbol.detail === undefined)).toBe(true);
  }, 60_000);

  it('سند بسته می‌شود و شمارش به صفر برمی‌گردد', async () => {
    const file = path.join(FIXTURE, 'src', 'config.ts');
    await client.withDocument(file, 'typescript', () => client.documentSymbol(file));
    expect(client.openDocumentCount).toBe(0);
  }, 60_000);

  it('didChange را می‌بیند بدون اینکه فایل روی دیسک عوض شود', async () => {
    const file = path.join(FIXTURE, 'src', 'util', 'strings.ts');
    const original = fs.readFileSync(file, 'utf8');

    client.openDocument(file, 'typescript', original);
    try {
      const before = (await client.documentSymbol(file)) as DocumentSymbolLike[];
      client.changeDocument(file, `${original}\nexport class AddedOnlyInMemory {}\n`);
      const after = (await client.documentSymbol(file)) as DocumentSymbolLike[];

      expect(after.map(s => s.name)).toContain('AddedOnlyInMemory');
      expect(before.map(s => s.name)).not.toContain('AddedOnlyInMemory');
      // و روی دیسک هیچ اتفاقی نیفتاده است.
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    } finally {
      client.closeDocument(file);
    }
  }, 60_000);

  it('درخواست ناشناخته معلق نمی‌ماند — با خطا برمی‌گردد', async () => {
    /*
    | probe نشان داد `tsgo` برای متد ناموجود کد ‎-32600 می‌دهد نه
    | ‎-32601. نکتهٔ آزمون کد نیست؛ این است که *جوابی* می‌آید و
    | فراخوان قفل نمی‌شود.
    */
    await expect(client.request('textDocument/nonsense', {}, { timeoutMs: 10_000 })).rejects.toThrow();
    expect(client.isRunning).toBe(true);
  }, 30_000);
});

describe('LSP-03 — خاموشی سرور واقعی', () => {
  it('کد خروج غیرصفرِ پس از shutdown کرش شمرده نمی‌شود', async () => {
    if (!resolved) throw new Error(describeMissingTypeScriptLsp());
    const exits: { code: number | null; expected: boolean }[] = [];
    const client = new LspClient({
      id: 'typescript',
      command: resolved.command,
      args: resolved.args,
      rootPath: FIXTURE,
      initializeTimeoutMs: 60_000,
      onExit: info => exits.push(info),
    });

    await client.start();
    const pid = client.processId!;
    await client.stop();

    expect(client.state).toBe('stopped');
    expect(exits).toHaveLength(1);
    expect(exits[0].expected).toBe(true);
    expect(await died(pid)).toBe(true);
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
