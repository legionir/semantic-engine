/**
 * LSP-06 — «initialize برگشت» یعنی «سرور زنده است»، نه «آماده است».
 *
 * سرور ساختگی اینجا هر دو رفتار واقعی را بازی می‌کند: `$/progress`
 * استاندارد که `gopls` می‌فرستد، و `experimental/serverStatus` که
 * افزونهٔ `rust-analyzer` است. در هر دو حالت، تا وقتی گرم نشده
 * `documentSymbol` آرایهٔ خالی می‌دهد — همان چیزی که اگر جدی گرفته
 * نشود، ایندکس را پر از فایل‌های «بدون symbol» می‌کند.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from './LspClient';
import { ReadinessTracker } from './readiness';
import { residentMemoryMb } from './processMemory';

const FAKE_SERVER = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');

let workspace: string;
let clients: LspClient[];
let probeFile: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-readiness-'));
  probeFile = path.join(workspace, 'probe.ts');
  fs.writeFileSync(probeFile, 'export class Probe {}\n', 'utf8');
  clients = [];
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
  return client;
}

const probe = () => ({ filePath: probeFile, languageId: 'typescript' });

describe('LSP-06 — لایهٔ ۱: $/progress', () => {
  it('سروری که کار اعلام‌شده دارد، مشغول است', async () => {
    const client = await started(['--warmup=400']);
    const tracker = new ReadinessTracker({ pollIntervalMs: 20, maxPollIntervalMs: 50 });
    tracker.attach(client);
    await client.start();

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(tracker.isBusy(client)).toBe(true);

    const verdict = await tracker.waitUntilReady(client, 5_000, probe());
    expect(verdict).toBe('ready');
    expect(tracker.isBusy(client)).toBe(false);
  }, 15_000);

  it('صبر کردن، تا پایان گرم شدن طول می‌کشد — نه بیشتر', async () => {
    const client = await started(['--warmup=300']);
    const tracker = new ReadinessTracker({ pollIntervalMs: 20, maxPollIntervalMs: 50 });
    tracker.attach(client);
    await client.start();

    const startedAt = Date.now();
    expect(await tracker.waitUntilReady(client, 5_000, probe())).toBe('ready');
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3_000);
  }, 15_000);

  it('سرور بدون هیچ progress، فوراً آماده است', async () => {
    /*
    | `tsgo` هیچ progressای نمی‌فرستد چون واقعاً فوراً آماده است.
    | این لایه به‌تنهایی کافی نیست و همین آزمون نشانش می‌دهد:
    | «هیچ خبری نیست» و «آماده است» از یک جنس‌اند.
    */
    const client = await started();
    const tracker = new ReadinessTracker();
    tracker.attach(client);
    await client.start();

    expect(tracker.isBusy(client)).toBe(false);
    expect(await tracker.waitUntilReady(client, 2_000, probe())).toBe('ready');
  }, 15_000);
});

describe('LSP-06 — لایهٔ ۲: افزونهٔ مخصوص سرور', () => {
  it('quiescent: false یعنی هنوز مشغول', async () => {
    const client = await started(['--quiescent=300', '--warmup=300']);
    const tracker = new ReadinessTracker({ pollIntervalMs: 20, maxPollIntervalMs: 50 });
    tracker.attach(client);
    await client.start();

    await new Promise(resolve => setTimeout(resolve, 80));
    expect(tracker.isBusy(client)).toBe(true);

    expect(await tracker.waitUntilReady(client, 5_000, probe())).toBe('ready');
  }, 15_000);

  it('سروری که این افزونه را ندارد، از نبودش بی‌اثر می‌ماند', async () => {
    const client = await started();
    const tracker = new ReadinessTracker();
    tracker.attach(client);
    await client.start();
    expect(tracker.isBusy(client)).toBe(false);
  }, 15_000);
});

describe('LSP-06 — لایهٔ ۳: کاوش فعال', () => {
  it('سروری که جواب خالی می‌دهد، آماده حساب نمی‌شود', async () => {
    const client = await started(['--empty-symbols']);
    const tracker = new ReadinessTracker({ pollIntervalMs: 20, maxPollIntervalMs: 40 });
    tracker.attach(client);
    await client.start();

    expect(await tracker.waitUntilReady(client, 300, probe())).toBe('degraded');
  }, 15_000);

  it('بدون فایل نمونه، فقط به دو لایهٔ اول اعتماد می‌شود', async () => {
    const client = await started(['--empty-symbols']);
    const tracker = new ReadinessTracker();
    tracker.attach(client);
    await client.start();

    expect(await tracker.waitUntilReady(client, 500)).toBe('ready');
  }, 15_000);

  it('کاوش، سند را باز نمی‌گذارد', async () => {
    const client = await started();
    const tracker = new ReadinessTracker();
    tracker.attach(client);
    await client.start();

    await tracker.waitUntilReady(client, 2_000, probe());
    expect(client.openDocumentCount).toBe(0);
  }, 15_000);

  it('سرور مرده، فوراً degraded است — نه بعد از سررسید', async () => {
    const client = await started();
    const tracker = new ReadinessTracker();
    tracker.attach(client);
    await client.start();
    await client.stop();

    const startedAt = Date.now();
    expect(await tracker.waitUntilReady(client, 5_000, probe())).toBe('degraded');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  }, 15_000);

  it('attach دوباره، شنوندهٔ تکراری نمی‌سازد', async () => {
    const client = await started(['--warmup=200']);
    const tracker = new ReadinessTracker({ pollIntervalMs: 20 });
    tracker.attach(client);
    tracker.attach(client);
    tracker.attach(client);
    await client.start();

    expect(await tracker.waitUntilReady(client, 5_000, probe())).toBe('ready');
  }, 15_000);
});

describe('LSP-05 — اندازه‌گیری حافظه', () => {
  it('حافظهٔ یک پروسهٔ زنده خوانده می‌شود', async () => {
    const client = await started();
    await client.start();

    const mb = residentMemoryMb(client.processId);
    expect(mb).not.toBeNull();
    expect(mb!).toBeGreaterThan(1);
    expect(mb!).toBeLessThan(4_096);
  }, 15_000);

  it('pid ناموجود، null می‌دهد نه استثنا', () => {
    expect(residentMemoryMb(2_147_483_600)).toBeNull();
    expect(residentMemoryMb(0)).toBeNull();
    expect(residentMemoryMb(undefined)).toBeNull();
  });

  it('پس از مرگ پروسه، null می‌شود', async () => {
    const client = await started();
    await client.start();
    const pid = client.processId!;
    await client.stop();

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(residentMemoryMb(pid)).toBeNull();
  }, 15_000);
});
