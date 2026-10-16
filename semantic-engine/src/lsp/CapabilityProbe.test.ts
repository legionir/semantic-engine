/**
 * LSP-15 — «اعلام‌شده» را باور نکن، امتحانش کن.
 *
 * سرور ساختگی اینجا دقیقاً همان دروغی را می‌گوید که `tsgo` واقعاً
 * می‌گوید: `codeActionProvider` را اعلام می‌کند و همیشه آرایهٔ خالی
 * می‌دهد. اگر کاوش فقط `capabilities` را بخواند، این را «کار می‌کند»
 * گزارش می‌کند و ابزاری به مدل اعلام می‌شود که همیشه هیچ برمی‌گرداند.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from './LspClient';
import { CapabilityProbe, anchorsFrom, isEmptyResult, isUsable } from './CapabilityProbe';

const FAKE_SERVER = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');

let workspace: string;
let clients: LspClient[];
let probeFile: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-probe-'));
  clients = [];
  probeFile = path.join(workspace, 'probe.ts');
  fs.writeFileSync(probeFile, 'export class Probe {}\nexport function go() {}\n', 'utf8');
});

afterEach(async () => {
  for (const client of clients) await client.stop();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function started(args: string[] = []): Promise<LspClient> {
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

describe('LSP-15 — حکم هر قابلیت', () => {
  it('قابلیتی که واقعاً جواب می‌دهد `works` است', async () => {
    const client = await started();
    const report = await new CapabilityProbe().probe(client, 'typescript', probeFile);

    expect(report.verdicts.documentSymbol).toBe('works');
    expect(report.verdicts.hover).toBe('works');
    expect(report.verdicts.references).toBe('works');
    expect(report.verdicts.definition).toBe('works');
    expect(report.verdicts.rename).toBe('works');
    expect(report.verdicts.callHierarchy).toBe('works');
  });

  it('قابلیت اعلام‌شده‌ای که همیشه خالی برمی‌گرداند `empty` است', async () => {
    /*
    | همان چیزی که روی `tsgo` اندازه گرفته شد:
    |   only=source.organizeImports → ۱ اقدام
    |   only=quickfix               → ۰ اقدام، با اینکه اعلام شده
    | سرور ساختگی نسخهٔ بدترش را بازی می‌کند: همیشه خالی.
    */
    const client = await started();
    const report = await new CapabilityProbe().probe(client, 'typescript', probeFile);
    expect(report.verdicts.organizeImports).toBe('empty');
  });

  it('`{"kind":"full","items":[]}` هم خالی است، نه یک نتیجه', async () => {
    const client = await started();
    const report = await new CapabilityProbe().probe(client, 'typescript', probeFile);
    expect(report.verdicts.diagnostic).toBe('empty');
  });

  it('قابلیت اعلام‌نشده اصلاً پرسیده نمی‌شود', async () => {
    const client = await started(['--declare-nothing']);
    const report = await new CapabilityProbe().probe(client, 'typescript', probeFile);

    for (const verdict of Object.values(report.verdicts)) {
      expect(verdict).toBe('not-declared');
    }

    const state = await client.request<{ counts: Record<string, number> }>('test/state', {});
    expect(state.counts['textDocument/hover']).toBeUndefined();
  });

  it('درخواستی که خطا می‌دهد `failed` است، نه `empty`', async () => {
    const client = await started(['--fail-references']);
    const report = await new CapabilityProbe().probe(client, 'typescript', probeFile);
    expect(report.verdicts.references).toBe('failed');
    // و بقیه دست‌نخورده می‌مانند.
    expect(report.verdicts.documentSymbol).toBe('works');
  });

  it('کاوش، سند را باز نمی‌گذارد', async () => {
    const client = await started();
    await new CapabilityProbe().probe(client, 'typescript', probeFile);
    expect(client.openDocumentCount).toBe(0);
  });

  it('کاوش، فایل را تغییر نمی‌دهد — از prepareRename استفاده می‌کند نه rename', async () => {
    const client = await started();
    await new CapabilityProbe().probe(client, 'typescript', probeFile);
    const state = await client.request<{ counts: Record<string, number> }>('test/state', {});
    expect(state.counts['textDocument/rename']).toBeUndefined();
    expect(state.counts['textDocument/prepareRename']).toBe(1);
  });
});

describe('LSP-15 — کش', () => {
  it('کاوش دوم هیچ درخواستی نمی‌فرستد', async () => {
    const client = await started();
    const probe = new CapabilityProbe();

    await probe.probe(client, 'typescript', probeFile);
    const first = await client.request<{ counts: Record<string, number> }>('test/state', {});
    await probe.probe(client, 'typescript', probeFile);
    const second = await client.request<{ counts: Record<string, number> }>('test/state', {});

    expect(second.counts['textDocument/hover']).toBe(first.counts['textDocument/hover']);
  });

  it('چند فراخوانی هم‌زمان، یک کاوش می‌سازد', async () => {
    /*
    | اولین موج فایل‌ها همگی با هم می‌رسند. بدون این، هرکدام یک
    | کاوش کامل راه می‌اندازند و راه‌اندازی، خودش کندترین بخش
    | می‌شود.
    */
    const client = await started();
    const probe = new CapabilityProbe();

    const reports = await Promise.all(
      Array.from({ length: 5 }, () => probe.probe(client, 'typescript', probeFile))
    );
    expect(new Set(reports).size).toBe(1);

    const state = await client.request<{ counts: Record<string, number> }>('test/state', {});
    expect(state.counts['textDocument/hover']).toBe(1);
  });

  it('`cached` پیش از کاوش چیزی ندارد و بعدش دارد', async () => {
    const client = await started();
    const probe = new CapabilityProbe();

    expect(probe.cached(client.serverKey, 'typescript')).toBeUndefined();
    await probe.probe(client, 'typescript', probeFile);
    expect(probe.cached(client.serverKey, 'typescript')).toBeDefined();

    probe.forget();
    expect(probe.cached(client.serverKey, 'typescript')).toBeUndefined();
  });

  it('P-05/SE-F-031 — forget وسط کاوشِ درحال‌پرواز، نتیجهٔ کهنه را در cache نمی‌گذارد', async () => {
    /*
    | forget قبلاً فقط cache را پاک می‌کرد؛ کاوشی که *همزمان* در حال
    | اجرا بود در پایان نتیجه‌اش را دوباره در cache می‌نوشت و forget
    | بی‌اثر می‌شد. حالا epoch عوض می‌شود و آن نتیجهٔ کهنه دور ریخته
    | می‌شود؛ پرس‌وجوی بعدی کاوش تازه می‌سازد.
    */
    const client = await started();
    const probe = new CapabilityProbe();

    const inFlight = probe.probe(client, 'typescript', probeFile);
    probe.forget();
    const report = await inFlight;

    // کاوش نتیجه داد (پromise resolve شد)…
    expect(report.verdicts).toBeDefined();
    // …اما نتیجهٔ متعلق به دنیایِ پیش از forget در cache ننشست.
    expect(probe.cached(client.serverKey, 'typescript')).toBeUndefined();
  });

  it('هر زبان کش خودش را دارد', async () => {
    const client = await started();
    const probe = new CapabilityProbe();

    await probe.probe(client, 'typescript', probeFile);
    expect(probe.cached(client.serverKey, 'javascript')).toBeUndefined();
  });
});

describe('LSP-15 — isUsable و isEmptyResult', () => {
  it('فقط `works` قابل استفاده است', () => {
    const report = {
      serverId: 's',
      languageId: 'typescript',
      probeFile: 'a.ts',
      durationMs: 1,
      verdicts: {
        documentSymbol: 'works',
        hover: 'empty',
        references: 'failed',
        definition: 'not-declared',
        diagnostic: 'empty',
        rename: 'works',
        callHierarchy: 'failed',
        organizeImports: 'empty',
      },
    } as const;

    expect(isUsable(report, 'documentSymbol')).toBe(true);
    expect(isUsable(report, 'hover')).toBe(false);
    expect(isUsable(report, 'references')).toBe(false);
    expect(isUsable(report, 'definition')).toBe(false);
    expect(isUsable(undefined, 'documentSymbol')).toBe(false);
  });

  it.each([
    [null, true],
    [undefined, true],
    [[], true],
    [{}, true],
    [{ data: [] }, true],
    [{ kind: 'full', items: [] }, true],
    [[1], false],
    [{ kind: 'full', items: [{ message: 'x' }] }, false],
    [{ contents: { kind: 'markdown', value: 'class X' } }, false],
    [{ changes: { 'file:///a': [{ newText: 'x' }] } }, false],
  ])('isEmptyResult(%j) → %s', (value, expected) => {
    expect(isEmptyResult(value)).toBe(expected);
  });
});

describe('anchorsFrom — جای کاوش را اشتباه انتخاب نکن', () => {
  const symbol = (name: string, kind: number, line: number, children: unknown[] = []) => ({
    name,
    kind,
    range: { start: { line, character: 0 }, end: { line, character: 10 } },
    selectionRange: { start: { line, character: 7 }, end: { line, character: 9 } },
    children,
  });

  it('تابع و متد بر ثابت ترجیح دارند', () => {
    /*
    | این آزمون از یک شکست واقعی آمد: کاوش روی آخرین symbol فایل
    | لنگر می‌انداخت، که در `src/app.ts` یک `const` است، و
    | `prepareCallHierarchy` روی const هیچ‌چیز نمی‌دهد. نتیجه:
    | قابلیتی که کار می‌کرد «بی‌اثر» گزارش شد.
    */
    const anchors = anchorsFrom([
      symbol('VERSION', 13, 25),
      symbol('createApplication', 12, 21),
    ]);
    expect(anchors[0]).toEqual({ line: 21, character: 7 });
  });

  it('اعضای تودرتو هم نامزد می‌شوند', () => {
    const anchors = anchorsFrom([symbol('Klass', 5, 1, [symbol('method', 6, 2)])]);
    expect(anchors[0]).toEqual({ line: 2, character: 7 });
  });

  it('بیش از چهار نامزد برنمی‌گرداند', () => {
    const many = Array.from({ length: 20 }, (_, index) => symbol(`f${index}`, 12, index));
    expect(anchorsFrom(many)).toHaveLength(4);
  });

  it('ترتیب ظاهر شدن، گره‌گشای هم‌رتبه‌هاست', () => {
    const anchors = anchorsFrom([symbol('a', 12, 3), symbol('b', 12, 1)]);
    expect(anchors.map(a => a.line)).toEqual([3, 1]);
  });

  it('شکل تخت (SymbolInformation) هم پشتیبانی می‌شود', () => {
    const flat = [
      {
        name: 'go',
        kind: 12,
        location: { uri: 'file:///a.ts', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 4 } } },
      },
    ];
    expect(anchorsFrom(flat)).toEqual([{ line: 4, character: 2 }]);
  });

  it('ورودی نامعتبر، فهرست خالی می‌دهد', () => {
    expect(anchorsFrom(null)).toEqual([]);
    expect(anchorsFrom([])).toEqual([]);
    expect(anchorsFrom([{ nonsense: true }])).toEqual([]);
  });
});
