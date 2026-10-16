/**
 * LSP-07 — استخراج‌گر symbol روی زبان‌سرور.
 *
 * سرور ساختگی اینجا فقط `class`/`function`/`const` را می‌شناسد، ولی
 * همان کافی است: چیزی که سنجیده می‌شود قرارداد استخراج‌گر است — سند
 * را باز و بسته می‌کند، نتیجهٔ خالی را «کامل» جا نمی‌زند، اتصال‌های
 * import را حذف می‌کند، و وقتی سرور نیست سر راه بقیه نمی‌ایستد.
 *
 * درستیِ خروجی روی زبان واقعی، در
 * `LspSymbolExtractor.integration.test.ts` سنجیده می‌شود.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from '../../lsp/LspClient';
import { CapabilityProbe } from '../../lsp/CapabilityProbe';
import { LspSymbolExtractor, isImportBinding, refineKind } from './LspSymbolExtractor';
import { SymbolEntry } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';

const FAKE_SERVER = path.join(__dirname, '..', '..', 'lsp', '__fixtures__', 'fakeLspServer.js');

let workspace: string;
let clients: LspClient[];

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-extractor-'));
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

function extractorFor(client: LspClient | null, over: Record<string, unknown> = {}) {
  return new LspSymbolExtractor({
    acquire: async () => client,
    probe: new CapabilityProbe(),
    ...over,
  });
}

describe('LSP-07 — قرارداد استخراج‌گر', () => {
  it('اولویتش ۹۰ است و نامش lsp', () => {
    expect(extractorFor(null).name).toBe('lsp');
    expect(extractorFor(null).priority).toBe(90);
  });

  it('فقط زبان‌های خانوادهٔ TS/JS را ادعا می‌کند', async () => {
    const client = await startFake();
    const extractor = extractorFor(client);

    expect(await extractor.isAvailable('typescript')).toBe(true);
    expect(await extractor.isAvailable('javascript')).toBe(true);
    expect(await extractor.isAvailable('go')).toBe(false);
    expect(await extractor.isAvailable('css')).toBe(false);
  });

  it('بدون سرور، در دسترس نیست — و پرسیدن دوباره سرور نمی‌سازد', async () => {
    let calls = 0;
    const extractor = new LspSymbolExtractor({
      acquire: async () => {
        calls++;
        return null;
      },
    });

    expect(await extractor.isAvailable('typescript')).toBe(false);
    expect(await extractor.isAvailable('typescript')).toBe(false);
    expect(calls).toBe(1);
  });

  it('symbolها با source برابر lsp برمی‌گردند', async () => {
    const client = await startFake();
    const file = write('a.ts', 'export class Alpha {}\nexport function beta() {}\n');
    const content = fs.readFileSync(file, 'utf8');

    const result = await extractorFor(client).extract('f1', file, content, 'typescript');
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.source).toBe('lsp');
    expect(result.value.partial).toBe(false);
    expect(result.value.symbols.map(s => [s.name, s.kind, s.source])).toEqual([
      ['Alpha', 'class', 'lsp'],
      ['beta', 'function', 'lsp'],
    ]);
  });

  it('شماره خط یک‌مبنا می‌شود', async () => {
    const client = await startFake();
    const file = write('a.ts', '\n\nexport class OnThirdLine {}\n');
    const content = fs.readFileSync(file, 'utf8');

    const result = await extractorFor(client).extract('f1', file, content, 'typescript');
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.symbols[0].line).toBe(3);
  });

  it('سند بعد از استخراج باز نمی‌ماند', async () => {
    const client = await startFake();
    const file = write('a.ts', 'export class A {}\n');
    await extractorFor(client).extract('f1', file, 'export class A {}\n', 'typescript');
    expect(client.openDocumentCount).toBe(0);
  });

  it('متنِ داده‌شده به سرور می‌رود، نه متن روی دیسک', async () => {
    /*
    | در حالت watch، محتوای در حافظه از دیسک جلوتر است. اگر
    | استخراج‌گر فایل را خودش بخواند، نتیجه یک نسخه عقب است.
    */
    const client = await startFake();
    const file = write('a.ts', 'export class OnDisk {}\n');

    const result = await extractorFor(client).extract(
      'f1',
      file,
      'export class InMemory {}\n',
      'typescript'
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.symbols.map(s => s.name)).toEqual(['InMemory']);
  });

  it('SE-LSP-02 — اتصال‌های import حذف می‌شوند و هشدارش ثبت می‌شود', async () => {
    const client = await startFake();
    const content = [
      "import { Imported } from './other';",
      "const alsoImported = require('./other');",
      'export class Real {}',
    ].join('\n');
    const file = write('a.ts', content);

    const result = await extractorFor(client).extract('f1', file, content, 'typescript');
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.symbols.map(s => s.name)).toEqual(['Real']);
    expect(result.value.warnings.join(' ')).toMatch(/import binding/);
  });
});

describe('LSP-07 — وقتی سرور کمکی نمی‌کند', () => {
  it('پاسخ خالی، «کامل» اعلام نمی‌شود', async () => {
    /*
    | این همان چیزی است که استخراج‌گر را از «ابزار بی‌اثر» جدا
    | می‌کند: نتیجهٔ خالی با `partial: false` یعنی مدیر همان‌جا
    | می‌ایستد و فایل بدون symbol می‌ماند.
    */
    const client = await startFake(['--empty-symbols']);
    const file = write('a.ts', 'export class A {}\n');

    const result = await extractorFor(client).extract('f1', file, 'export class A {}\n', 'typescript');
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.symbols).toEqual([]);
    expect(result.value.partial).toBe(true);
    expect(result.value.warnings.join(' ')).toMatch(/documentSymbol/);
  });

  it('سروری که documentSymbol بی‌اثر دارد، دیگر در دسترس اعلام نمی‌شود', async () => {
    const client = await startFake(['--empty-symbols']);
    const extractor = extractorFor(client);

    expect(await extractor.isAvailable('typescript')).toBe(true);   // هنوز کاوش نشده
    await extractor.extract('f1', write('a.ts', 'export class A {}\n'), 'export class A {}\n', 'typescript');
    expect(await extractor.isAvailable('typescript')).toBe(false);
  });

  it('مرگ سرور وسط کار، استخراج را نمی‌ترکاند', async () => {
    const client = await startFake();
    const file = write('a.ts', 'export class A {}\n');

    client.notify('test/crash', {});
    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await extractorFor(client).extract('f1', file, 'export class A {}\n', 'typescript');
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.symbols).toEqual([]);
    expect(result.value.partial).toBe(true);
  });

  it('درخواست کند با سررسید رد می‌شود، نه اینکه اسکن را نگه دارد', async () => {
    const client = await startFake();
    const file = write('a.ts', 'export class A {}\n');
    /*
    | SE-SYM-02: نه `isAvailable` و نه `extract` هیچ محدودیت زمانی
    | نداشتند و یک سرور کندشده کل اسکن را برای همیشه نگه می‌داشت.
    */
    jest.spyOn(client, 'documentSymbol').mockImplementation(
      () => new Promise(() => undefined)
    );

    const startedAt = Date.now();
    const result = await extractorFor(client, { requestTimeoutMs: 300 }).extract(
      'f1',
      file,
      'export class A {}\n',
      'typescript'
    );
    if (!result.ok) throw new Error('expected ok');
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.value.partial).toBe(true);
  });
});

// ── واحدهای خالص ──────────────────────────────────────────────────────

describe('isImportBinding', () => {
  const spans = [{ startLine: 0, endLine: 2 }];
  const at = (startLine: number, endLine: number) => ({
    name: 'X',
    kind: 13,
    range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 5 } },
    selectionRange: { start: { line: startLine, character: 0 }, end: { line: startLine, character: 1 } },
  });

  it('symbol کاملاً داخل import، اتصال است', () => {
    expect(isImportBinding(at(1, 1), spans)).toBe(true);
  });

  it('symbol بیرون از import، اتصال نیست', () => {
    expect(isImportBinding(at(5, 9), spans)).toBe(false);
  });

  it('symbolای که از import بیرون می‌زند حذف نمی‌شود', () => {
    expect(isImportBinding(at(2, 8), spans)).toBe(false);
  });

  it('فایل بدون import هیچ‌چیز از دست نمی‌دهد', () => {
    expect(isImportBinding(at(0, 0), [])).toBe(false);
  });
});

describe('SE-LSP-08 — refineKind', () => {
  const base: SymbolEntry = {
    id: 's1',
    fileId: 'f1',
    parentId: null,
    kind: 'class',
    name: 'Alias',
    fullyQualifiedName: 'Alias',
    signature: 'Alias',
    visibility: 'public',
    line: 1,
    endLine: 1,
    documentation: null,
    deprecated: false,
    exported: false,
    source: 'lsp',
    confidence: makeConfidence(90),
    async: false,
    generator: false,
    abstract: false,
    static: false,
    readonly: false,
    parameters: [],
    returnType: null,
    generics: [],
    extends: [],
    implements: [],
    complexity: null,
    referenceCount: null,
    calls: [],
    calledBy: [],
  };

  it('`type X = …` که Class آمده، type-alias می‌شود', () => {
    expect(refineKind(base, ['export type Alias = string;']).kind).toBe('type-alias');
  });

  it('`declare type X` هم', () => {
    expect(refineKind(base, ['declare type Alias = string;']).kind).toBe('type-alias');
  });

  it('کلاس واقعی دست‌نخورده می‌ماند', () => {
    expect(refineKind({ ...base, name: 'Klass' }, ['export class Klass {}']).kind).toBe('class');
  });

  it('`const X` که variable آمده، constant می‌شود', () => {
    const variable = { ...base, kind: 'variable' as const, name: 'VERSION' };
    expect(refineKind(variable, ["export const VERSION = '1';"]).kind).toBe('constant');
  });

  it('`let X` همان variable می‌ماند', () => {
    const variable = { ...base, kind: 'variable' as const, name: 'counter' };
    expect(refineKind(variable, ['export let counter = 0;']).kind).toBe('variable');
  });

  it('نامی که در خط نیست، چیزی را عوض نمی‌کند', () => {
    const variable = { ...base, kind: 'variable' as const, name: 'other' };
    expect(refineKind(variable, ['export const VERSION = 1;']).kind).toBe('variable');
  });

  it('نام با کاراکتر ویژه، regex را نمی‌شکند', () => {
    const variable = { ...base, kind: 'variable' as const, name: 'a.b[c]' };
    expect(() => refineKind(variable, ['const a.b[c] = 1;'])).not.toThrow();
  });

  it('خط ناموجود بی‌خطر است', () => {
    expect(refineKind({ ...base, line: 99 }, ['one line']).kind).toBe('class');
  });
});
