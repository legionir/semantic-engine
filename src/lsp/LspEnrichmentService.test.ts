/**
 * LSP-08 / LSP-17 — غنی‌سازی بودجه‌دار.
 *
 * سه چیز اینجا مهم است: بودجه واقعاً ببندد، اولویت‌دهی واقعاً کار
 * کند، و نبودِ سرور هیچ‌چیز را نشکند. عددهای واقعی این فاز
 * (اندازه‌گیری روی همین مخزن) پشت هر سه‌اند:
 *
 * ```
 * ۷٬۲۹۳ symbol × ۳۷ms برای هر references  ≈  ۴٫۵ دقیقه
 * referenceCount ناتهی، پیش از این فاز    :  ۵۱۴ از ۷٬۲۹۳
 * یال‌های name-match (حدس با نام)          :  ۷۷۲
 * ```
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from './LspClient';
import {
  BATCH_BUDGET,
  LspEnrichmentService,
  WATCH_BUDGET,
  columnOfName,
  findEnclosing,
  prioritize,
} from './LspEnrichmentService';
import { FileEntry, SymbolEntry } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';

const FAKE_SERVER = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');

let workspace: string;
let clients: LspClient[];

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-enrich-'));
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

function file(over: Partial<FileEntry> & { id: string; path: string }): FileEntry {
  return {
    hash: 'h',
    size: 10,
    lines: 10,
    language: 'typescript',
    binary: false,
    lastModified: new Date().toISOString(),
    symbolIds: [],
    imports: [],
    exports: [],
    ...over,
  } as FileEntry;
}

function symbol(
  over: Partial<SymbolEntry> & { id: string; name: string; line: number; fileId: string }
): SymbolEntry {
  return {
    parentId: null,
    kind: 'function',
    fullyQualifiedName: over.name,
    signature: over.name,
    visibility: 'public',
    endLine: over.line,
    documentation: null,
    deprecated: false,
    exported: false,
    source: 'tree-sitter',
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
    ...over,
  } as SymbolEntry;
}

const CONTENT = [
  'export function alpha() {}', //      1
  'export function beta() {}', //       2
  'REF alpha()', //                     3
  'REF alpha()', //                     4
  '', //                                5
  'function caller() {', //             6
  '  alpha();', //                      7
  '}', //                               8
].join('\n');

function fixtureInput() {
  fs.writeFileSync(path.join(workspace, 'a.ts'), CONTENT, 'utf8');
  const files = [file({ id: 'f1', path: 'a.ts' })];
  const symbols = [
    symbol({ id: 's-alpha', name: 'alpha', line: 1, endLine: 1, fileId: 'f1', exported: true }),
    symbol({ id: 's-beta', name: 'beta', line: 2, endLine: 2, fileId: 'f1', exported: true }),
    symbol({ id: 's-caller', name: 'caller', line: 6, endLine: 8, fileId: 'f1' }),
  ];
  return {
    symbols,
    files,
    workspaceRoot: workspace,
    contentOf: () => CONTENT,
  };
}

describe('LSP-08 — پر کردن referenceCount', () => {
  it('عدد از سرور می‌آید، نه از گراف حدسی', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });

    const result = await service.enrich(fixtureInput());
    const alpha = result.symbols.find(s => s.id === 's-alpha')!;

    // دو خط `REF` در متن هست.
    expect(alpha.referenceCount).toBe(2);
    expect(result.stats.enrichedSymbols).toBeGreaterThan(0);
  });

  it('symbolهایی که غنی نشدند، دست‌نخورده می‌مانند', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({
      acquire: async () => client,
      budget: { ...BATCH_BUDGET, maxReferenceQueries: 1 },
    });

    const input = fixtureInput();
    const result = await service.enrich(input);

    const untouched = result.symbols.filter(s => s.referenceCount === null);
    expect(untouched.length).toBe(input.symbols.length - 1);
  });

  it('نبود سرور، ورودی را دست‌نخورده برمی‌گرداند', async () => {
    const service = new LspEnrichmentService({ acquire: async () => null });
    const input = fixtureInput();

    const result = await service.enrich(input);
    expect(result.symbols).toBe(input.symbols);
    expect(result.callEdges).toEqual([]);
    expect(result.stats.referenceQueries).toBe(0);
  });

  it('سند بعد از غنی‌سازی بسته می‌شود', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });
    await service.enrich(fixtureInput());
    expect(client.openDocumentCount).toBe(0);
  });
});

describe('LSP-08 — دامنهٔ زبان', () => {
  it('فایل‌های زبان دیگر اصلاً پرسیده نمی‌شوند — SE-LSP-16', async () => {
    /*
    | با سرور TypeScript روشن، نامزدها از *همهٔ* فایل‌ها می‌آمدند —
    | از جمله کلیدهای `tsconfig.json`. سرور هم جواب می‌داد:
    | `strict = 3` یعنی «سه بار این کلمه در فایل هست»، نه «سه
    | ارجاع کد». هم بودجه هدر می‌رفت، هم عددی بی‌معنی وارد ایندکس
    | می‌شد.
    */
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });

    fs.writeFileSync(path.join(workspace, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const input = fixtureInput();
    const withJson = {
      ...input,
      files: [...input.files, file({ id: 'f-json', path: 'tsconfig.json', language: 'json' })],
      symbols: [
        ...input.symbols,
        symbol({ id: 's-strict', name: 'strict', line: 1, fileId: 'f-json', kind: 'property' }),
      ],
    };

    const result = await service.enrich(withJson);

    expect(result.symbols.find(s => s.id === 's-strict')!.referenceCount).toBeNull();
    expect(result.stats.consideredSymbols).toBe(input.symbols.length);
  });

  it('فهرست زبان‌ها قابل تنظیم است', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({
      acquire: async () => client,
      languages: ['json'],
    });

    const input = fixtureInput();
    const result = await service.enrich(input);
    // هیچ فایل typescriptای در دامنه نیست.
    expect(result.stats.consideredSymbols).toBe(0);
    expect(result.stats.referenceQueries).toBe(0);
  });
});

describe('LSP-08 — بودجه', () => {
  it('سقف تعداد درخواست رعایت می‌شود', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({
      acquire: async () => client,
      budget: { ...BATCH_BUDGET, maxReferenceQueries: 2, maxCallHierarchyQueries: 1 },
    });

    const result = await service.enrich(fixtureInput());
    expect(result.stats.referenceQueries).toBe(2);
    expect(result.stats.callHierarchyQueries).toBe(1);
    expect(result.stats.budgetExhausted).toBe(true);
  });

  it('سقف تعداد symbol، قبل از هر درخواستی می‌بندد', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({
      acquire: async () => client,
      budget: { ...BATCH_BUDGET, maxSymbols: 1 },
    });

    const result = await service.enrich(fixtureInput());
    expect(result.stats.consideredSymbols).toBe(1);
    expect(result.stats.referenceQueries).toBe(1);
  });

  it('سقف زمان دیواری، وسط کار می‌بندد', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({
      acquire: async () => client,
      budget: { ...BATCH_BUDGET, maxWallClockMs: 0 },
    });

    const result = await service.enrich(fixtureInput());
    expect(result.stats.referenceQueries).toBe(0);
    expect(result.stats.budgetExhausted).toBe(true);
    // و هیچ symbolای خراب نشده است.
    expect(result.symbols).toHaveLength(3);
  });

  it('hover پیش‌فرض خاموش است — SE-SYM-07', async () => {
    /*
    | نسخهٔ حذف‌شدهٔ `enrichWithHoverData` به‌ازای هر symbol یک
    | hover ترتیبی می‌فرستاد. اینجا پیش‌فرض صفر است و روشن کردنش
    | یک تصمیم صریح با سقف خودش است.
    */
    expect(BATCH_BUDGET.maxHoverQueries).toBe(0);
    expect(WATCH_BUDGET.maxHoverQueries).toBe(0);

    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });
    const result = await service.enrich(fixtureInput());

    expect(result.stats.hoverQueries).toBe(0);
    const state = await client.request<{ counts: Record<string, number> }>('test/state', {});
    expect(state.counts['textDocument/hover']).toBeUndefined();
  });

  it('با سقف صریح، hover مستندسازی را پر می‌کند', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({
      acquire: async () => client,
      budget: { ...BATCH_BUDGET, maxHoverQueries: 2 },
    });

    const result = await service.enrich(fixtureInput());
    expect(result.stats.hoverQueries).toBe(2);
    expect(result.symbols.filter(s => s.documentation !== null)).toHaveLength(2);
  });

  it('بودجهٔ watch سخاوتمندتر از یک اسکن کامل نیست، فقط متفاوت است', () => {
    /*
    | LSP-10: در watch سرور گرم است و فقط چند فایل عوض شده‌اند، پس
    | سقف زمانی کوتاه‌تر است (یک ذخیره نباید یک دقیقه طول بکشد) و
    | سقف symbol کمتر — چون دامنه هم کمتر است.
    */
    expect(WATCH_BUDGET.maxWallClockMs).toBeLessThan(BATCH_BUDGET.maxWallClockMs);
    expect(WATCH_BUDGET.maxSymbols).toBeLessThan(BATCH_BUDGET.maxSymbols);
  });

  it('P-05/continuation-9-P-3 — برخورد سقف callHierarchy بدون سقف references هم flag می‌زند', async () => {
    /*
    | محاسبهٔ قبلی `budgetExhausted` فقط `references >= max` را می‌دید؛
    | بودجهٔ سفارشی‌ای که call-hierarchy را ببندد و references را باز
    | بگذارد، «کامل» گزارش می‌شد درحالی‌که یک بودجه تمام شده بود (§16).
    */
    const client = await startFake();
    const service = new LspEnrichmentService({
      acquire: async () => client,
      budget: { ...BATCH_BUDGET, maxReferenceQueries: 500, maxCallHierarchyQueries: 1 },
    });

    const result = await service.enrich(fixtureInput());
    expect(result.stats.callHierarchyQueries).toBe(1);
    expect(result.stats.referenceQueries).toBeLessThan(500);
    expect(result.stats.budgetExhausted).toBe(true);
  });

  it('P-05/continuation-9-P-3 — سقف hover هم flag می‌زند (بودجهٔ صفر hover عمداً خاموش است)', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({
      acquire: async () => client,
      budget: { ...BATCH_BUDGET, maxHoverQueries: 1 },
    });

    const result = await service.enrich(fixtureInput());
    expect(result.stats.hoverQueries).toBe(1);
    expect(result.stats.budgetExhausted).toBe(true);
  });
});

describe('P-05/SE-P-002 — occurrence روی یال‌های LSP', () => {
  it('دو fromRanges روی یک خط، دو شناسهٔ یالِ متمایز می‌گیرند', async () => {
    /*
    | `f(g(), g())`: سرور دو range با یک خطِ یکسان گزارش می‌کند. نسخهٔ
    | اول برای هر دو `occurrence: 0` می‌داد و `makeEdgeId` صفر را مثلِ
    | غایب encode می‌کرد → یک شناسه، و هر نگاشتی کلیدش شناسه باشد یکی
    | را روی دیگری می‌نوشت. حالا شمارندهٔ محلی، هر occurrence را متمایز
    | می‌کند.
    */
    const client = await startFake(['--dup-ranges']);
    const service = new LspEnrichmentService({ acquire: async () => client });

    const result = await service.enrich(fixtureInput());
    const onLine7 = result.callEdges.filter(e => e.line === 7 && e.caller === 's-caller');
    // هر سه تابعِ نامزد، دو range تکراری از caller می‌گیرند.
    expect(onLine7).toHaveLength(6);
    // بدون شمارش occurrence، دو یالِ هم‌سمتِ هر callee یک شناسه می‌گرفتند.
    expect(new Set(onLine7.map(e => e.id)).size).toBe(6);
    for (const callee of ['s-alpha', 's-beta', 's-caller']) {
      const pair = onLine7.filter(e => e.callee === callee);
      expect(pair).toHaveLength(2);
      expect(new Set(pair.map(e => e.id)).size).toBe(2);
    }
  });
});

describe('LSP-17 — یال‌های resolved به‌جای حدسِ نام', () => {
  it('یال با basis برابر resolved ساخته می‌شود', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });

    const result = await service.enrich(fixtureInput());
    expect(result.callEdges.length).toBeGreaterThan(0);
    for (const edge of result.callEdges) {
      expect(edge.provenance.basis).toBe('resolved');
      expect(edge.provenance.extractor).toBe('lsp');
      expect(edge.provenance.confidence).toBeGreaterThan(95);
    }
  });

  it('فراخوانِ داخل یک symbol، به همان symbol وصل می‌شود', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });

    const result = await service.enrich(fixtureInput());
    const fromSymbol = result.callEdges.filter(edge => edge.callerKind === 'symbol');

    expect(fromSymbol.length).toBeGreaterThan(0);
    expect(fromSymbol[0].caller).toBe('s-caller');
  });

  it('فراخوان در سطح ماژول با callerKind برابر file ثبت می‌شود — SE-LSP-13', async () => {
    /*
    | سرور برای فراخوانی سطح ماژول، خودِ فایل را فراخوان معرفی
    | می‌کند و نامش را **مسیر مطلق** می‌گذارد. آن رشته نباید وارد
    | ایندکس شود.
    */
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });

    const result = await service.enrich(fixtureInput());
    const fromFile = result.callEdges.filter(edge => edge.callerKind === 'file');

    expect(fromFile.length).toBeGreaterThan(0);
    expect(fromFile[0].caller).toBe('f1');
    for (const edge of result.callEdges) {
      expect(edge.caller).not.toContain(path.sep + 'tmp' + path.sep);
    }
  });

  it('فراخوان از فایلی که در ایندکس نیست، نادیده گرفته می‌شود', async () => {
    /*
    | `node_modules` و فایل‌های خارج از اسکن هم در پاسخ سرور
    | می‌آیند. یالی که یک سرش در ایندکس نیست، فقط نویز است.
    */
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });

    const input = fixtureInput();
    const result = await service.enrich({ ...input, files: [] });
    expect(result.callEdges).toEqual([]);
  });

  it('P-05/continuation-9-P-1 — هر سند با languageId واقعی خودش باز می‌شود', async () => {
    /*
    | دامنهٔ پیش‌فرض یک خانواده است (ts/js/tsx/jsx روی یک ts-server)،
    | ولی didOpen قبلاً برای *همه* همان `input.languageId ?? 'typescript'`
    | را اعلام می‌کرد: سند `.js` به‌عنوان typescript باز می‌شد و
    | یافته‌ها با معنای زبانِ اشتباه برمی‌گشتند. حالا per-file استخراج می‌شود.
    */
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });

    fs.writeFileSync(path.join(workspace, 'b.js'), 'function jsThing() {} jsThing();\n', 'utf8');
    const input = fixtureInput();
    const mixed = {
      ...input,
      files: [
        ...input.files,
        file({ id: 'f-js', path: 'b.js', language: 'javascript' }),
      ],
      symbols: [
        ...input.symbols,
        symbol({ id: 's-js', name: 'jsThing', line: 1, endLine: 1, fileId: 'f-js', exported: true }),
      ],
    };

    await service.enrich(mixed);
    const state = await client.request<{
      openDocuments: { uri: string; languageId: string }[];
      closedWithLanguage: { uri: string; languageId: string }[];
    }>('test/state', {});
    // سند پس از enrich بسته می‌شود؛ سرور در لحظهٔ close نیز languageId
    // اعلامی در didOpen را به‌یاد می‌سپارد (probe continuation-9-P-1).
    const byUri = new Map<string, string>();
    for (const d of [...state.openDocuments, ...state.closedWithLanguage]) {
      if (d.languageId) byUri.set(d.uri.split('/').pop()!, d.languageId);
    }
    expect(byUri.get('b.js')).toBe('javascript');
    expect(byUri.get('a.ts')).toBe('typescript');
  });

  it('فقط چیزهای فراخوان‌شدنی پرسیده می‌شوند', async () => {
    const client = await startFake();
    const service = new LspEnrichmentService({ acquire: async () => client });

    const input = fixtureInput();
    const withInterface = {
      ...input,
      symbols: [
        ...input.symbols,
        symbol({ id: 's-iface', name: 'Shape', line: 1, fileId: 'f1', kind: 'interface' }),
      ],
    };

    const result = await service.enrich(withInterface);
    // سه تابع، نه چهار symbol.
    expect(result.stats.callHierarchyQueries).toBe(3);
  });
});

describe('LSP-08 — اولویت‌دهی', () => {
  const files = [
    file({ id: 'entry', path: 'index.ts', aiMetadata: { aiScore: { importance: 90 } } as never }),
    file({ id: 'plain', path: 'util.ts' }),
  ];

  it('exported در فایل مهم، اول است', () => {
    const symbols = [
      symbol({ id: 'a', name: 'a', line: 1, fileId: 'plain' }),
      symbol({ id: 'b', name: 'b', line: 1, fileId: 'entry', exported: true }),
    ];
    const order = prioritize({ symbols, files, workspaceRoot: '/' }, 10).map(s => s.id);
    expect(order[0]).toBe('b');
  });

  it('فایل تغییرکرده در watch، بالا می‌آید', () => {
    const symbols = [
      symbol({ id: 'a', name: 'a', line: 1, fileId: 'plain', exported: true }),
      symbol({ id: 'b', name: 'b', line: 1, fileId: 'plain' }),
    ];
    const order = prioritize(
      { symbols, files, workspaceRoot: '/', changedFileIds: new Set(['plain']) },
      10
    ).map(s => s.id);
    expect(order).toEqual(['a', 'b']);
  });

  it('سقف، فهرست را می‌برد ولی ترتیب را نگه می‌دارد', () => {
    const symbols = Array.from({ length: 20 }, (_, index) =>
      symbol({ id: `s${index}`, name: `s${index}`, line: index + 1, fileId: 'plain' })
    );
    const order = prioritize({ symbols, files, workspaceRoot: '/' }, 5);
    expect(order).toHaveLength(5);
    expect(order[0].id).toBe('s0');
  });

  it('ترتیب قطعی است — دو بار اجرا، یک نتیجه', () => {
    const symbols = Array.from({ length: 10 }, (_, index) =>
      symbol({
        id: `s${index}`,
        name: `s${index}`,
        line: index + 1,
        fileId: index % 2 === 0 ? 'entry' : 'plain',
        exported: index % 3 === 0,
      })
    );
    const first = prioritize({ symbols, files, workspaceRoot: '/' }, 10).map(s => s.id);
    const second = prioritize({ symbols, files, workspaceRoot: '/' }, 10).map(s => s.id);
    expect(first).toEqual(second);
  });
});

describe('کمکی‌ها', () => {
  it('columnOfName ستون نام را می‌دهد', () => {
    const lines = ['export function alpha() {}'];
    expect(columnOfName(lines, symbol({ id: 'a', name: 'alpha', line: 1, fileId: 'f' }))).toBe(16);
  });

  it('بدون متن، ستون صفر', () => {
    expect(columnOfName(undefined, symbol({ id: 'a', name: 'alpha', line: 1, fileId: 'f' }))).toBe(0);
  });

  it('نامی که در خط نیست، ستون صفر', () => {
    expect(columnOfName(['nothing here'], symbol({ id: 'a', name: 'alpha', line: 1, fileId: 'f' }))).toBe(0);
  });

  it('findEnclosing درونی‌ترین را می‌دهد', () => {
    const symbols = [
      symbol({ id: 'outer', name: 'Outer', line: 1, endLine: 20, fileId: 'f' }),
      symbol({ id: 'inner', name: 'inner', line: 5, endLine: 9, fileId: 'f' }),
    ];
    expect(findEnclosing(symbols, 7)?.id).toBe('inner');
    expect(findEnclosing(symbols, 15)?.id).toBe('outer');
    expect(findEnclosing(symbols, 99)).toBeUndefined();
  });
});
