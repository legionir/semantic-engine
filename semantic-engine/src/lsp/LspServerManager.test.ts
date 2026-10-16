/**
 * LSP-05 / LSP-06 — چرخهٔ عمر و آمادگی.
 *
 * چیزی که اینجا سنجیده می‌شود، مسیر خوش‌بینانه نیست. سرور ساختگی
 * می‌تواند بمیرد، دیر آماده شود، و حافظه بخورد؛ و در هر سه حالت
 * پاسخ درست یکی است: `acquire` مقدار `null` بدهد و زنجیرهٔ استخراج
 * با tree-sitter ادامه پیدا کند. هیچ‌کدام نباید استثنا بالا بیاورد.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from './LspClient';
import { LspServerManager } from './LspServerManager';
import { LspServerRegistry, LspServerSpec } from './registry';
import { ReadinessTracker } from './readiness';

const FAKE_SERVER = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');

let workspace: string;
let managers: LspServerManager[];
let clock: number;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-manager-'));
  fs.writeFileSync(path.join(workspace, 'probe.ts'), 'export class Probe {}\n', 'utf8');
  managers = [];
  clock = 1_000_000;
});

afterEach(async () => {
  for (const manager of managers) await manager.disposeAll();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** یک جدول تک‌سروری که به سرور ساختگی اشاره می‌کند. */
const FAKE_SPEC: LspServerSpec = {
  id: 'fake',
  languages: ['typescript'],
  binaries: ['fake-lsp'],
  args: [],
  install: 'nothing to install; this one is imaginary',
  rootMarkers: [],
  needsWarmup: false,
};

function managerWith(
  over: Record<string, unknown> = {},
  serverArgs: string[] = [],
  spec: LspServerSpec = FAKE_SPEC
): LspServerManager {
  const manager = new LspServerManager({
    workspaceRoot: workspace,
    registry: new LspServerRegistry({
      specs: [spec],
      // باینری ساختگی «همیشه پیدا می‌شود» تا resolve از سر راه برداشته شود.
      exists: () => true,
      env: { PATH: '/nowhere' },
    }),
    maintenanceIntervalMs: 0,
    now: () => clock,
    createClient: () =>
      new LspClient({
        id: spec.id,
        command: process.execPath,
        args: [FAKE_SERVER, ...serverArgs],
        rootPath: workspace,
        requestTimeoutMs: 4000,
        initializeTimeoutMs: 4000,
        shutdownTimeoutMs: 2000,
      }),
    ...over,
  });
  managers.push(manager);
  return manager;
}

describe('LSP-05 — spawn تنبل و اشتراک', () => {
  it('سرور فقط با اولین درخواست بالا می‌آید', async () => {
    const manager = managerWith();
    expect(manager.status()).toEqual([]);

    const client = await manager.acquire('typescript');
    expect(client).not.toBeNull();
    expect(client!.isRunning).toBe(true);
    expect(manager.status()[0].state).toBe('running');
  });

  it('درخواست دوم همان سرور را می‌دهد، نه یکی تازه', async () => {
    const manager = managerWith();
    const first = await manager.acquire('typescript');
    const second = await manager.acquire('typescript');

    expect(second).toBe(first);
    expect(manager.status()).toHaveLength(1);
  });

  it('درخواست‌های هم‌زمان یک سرور می‌سازند', async () => {
    /*
    | اولین موج فایل‌ها با هم می‌رسند. بدون این، هرکدام یک پروسه
    | بالا می‌آورند و ۸۰۰ مگابایت می‌شود چند گیگابایت.
    */
    const manager = managerWith();
    const clients = await Promise.all(
      Array.from({ length: 5 }, () => manager.acquire('typescript'))
    );

    expect(new Set(clients).size).toBe(1);
    expect(manager.status()).toHaveLength(1);
  });

  it('زبان بی‌سرور، null می‌دهد — نه خطا', async () => {
    const manager = managerWith();
    await expect(manager.acquire('cobol')).resolves.toBeNull();
  });

  it('پیام نبودِ سرور فقط یک بار لاگ می‌شود', async () => {
    const lines: string[] = [];
    const manager = managerWith({
      logger: {
        info: (message: string) => lines.push(message),
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        child: () => ({
          info: (message: string) => lines.push(message),
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
          child: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => undefined }),
        }),
      },
    });

    await manager.acquire('go');
    await manager.acquire('go');
    await manager.acquire('go');

    expect(lines.filter(line => line.includes('No language server'))).toHaveLength(1);
  });

  it('disposeAll همه را می‌بندد', async () => {
    const manager = managerWith();
    const client = await manager.acquire('typescript');
    const pid = client!.processId!;

    await manager.disposeAll();

    expect(manager.status()).toEqual([]);
    expect(await died(pid)).toBe(true);
    // و بعد از dispose دیگر چیزی بالا نمی‌آید.
    await expect(manager.acquire('typescript')).resolves.toBeNull();
  });
});

describe('LSP-05 — کرش و تنزل', () => {
  it('کرش شمرده می‌شود و سرور دوباره بالا می‌آید', async () => {
    const manager = managerWith();
    const first = await manager.acquire('typescript');
    first!.notify('test/crash', {});
    await waitFor(() => !first!.isRunning);

    // در پنجرهٔ backoff هنوز چیزی نمی‌دهد.
    expect(await manager.acquire('typescript')).toBeNull();

    clock += 5_000;
    const second = await manager.acquire('typescript');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('بعد از سه شکست، زبان تا پایان جلسه تسلیم می‌شود', async () => {
    /*
    | معیار پذیرش فاز: «کرش سرور → ادامه با tree-sitter». تنزل باید
    | صریح و پایدار باشد، وگرنه هر فایل یک پروسهٔ محکوم‌به‌مرگ
    | می‌سازد.
    */
    const manager = managerWith({ maxRestarts: 3 });

    for (let attempt = 0; attempt < 3; attempt++) {
      clock += 60_000;
      const client = await manager.acquire('typescript');
      expect(client).not.toBeNull();
      client!.notify('test/crash', {});
      await waitFor(() => !client!.isRunning);
    }

    clock += 600_000;
    expect(await manager.acquire('typescript')).toBeNull();
    expect(manager.isDegraded('typescript')).toBe(true);
    expect(manager.status()[0].state).toBe('degraded');
  });

  it('backoff نمایی است', async () => {
    const manager = managerWith({ restartBackoffMs: 1_000, maxRestarts: 5 });

    const first = await manager.acquire('typescript');
    first!.notify('test/crash', {});
    await waitFor(() => !first!.isRunning);

    clock += 999;
    expect(await manager.acquire('typescript')).toBeNull();
    clock += 2;
    const second = await manager.acquire('typescript');
    expect(second).not.toBeNull();

    second!.notify('test/crash', {});
    await waitFor(() => !second!.isRunning);
    clock += 1_500;
    // دومین شکست یعنی دو ثانیه صبر، نه یک ثانیه.
    expect(await manager.acquire('typescript')).toBeNull();
    clock += 1_000;
    expect(await manager.acquire('typescript')).not.toBeNull();
  });

  it('شکست‌های قدیمی از پنجره بیرون می‌روند', async () => {
    /*
    | SE-LSP-14: نسخهٔ اول شمارنده را با هر start موفق صفر می‌کرد،
    | پس سقف restart هرگز به دست نمی‌آمد. رفعش نباید به افراط
    | برود: سروری که یک بار در صبح مرده و از آن موقع سالم بوده،
    | نباید بعدازظهر با دومین مرگ تسلیم اعلام شود.
    */
    const manager = managerWith({ maxRestarts: 2, failureWindowMs: 60_000 });

    const first = await manager.acquire('typescript');
    first!.notify('test/crash', {});
    await waitFor(() => !first!.isRunning);
    expect(manager.status()[0].failures).toBe(1);

    clock += 120_000;
    expect(manager.status()[0].failures).toBe(0);

    const second = await manager.acquire('typescript');
    expect(second).not.toBeNull();
    second!.notify('test/crash', {});
    await waitFor(() => !second!.isRunning);

    // این تازه اولین شکستِ داخل پنجره است، پس هنوز تنزل نکرده.
    expect(manager.isDegraded('typescript')).toBe(false);
  });

  it('خاموشی عادی، شکست حساب نمی‌شود', async () => {
    const manager = managerWith();
    const client = await manager.acquire('typescript');
    await client!.stop();

    expect(manager.status()[0].failures).toBe(0);
    const again = await manager.acquire('typescript');
    expect(again).not.toBeNull();
  });

  it('سروری که اصلاً بالا نمی‌آید هم به تنزل می‌رسد', async () => {
    const manager = new LspServerManager({
      workspaceRoot: workspace,
      registry: new LspServerRegistry({ specs: [FAKE_SPEC], exists: () => true, env: { PATH: '/nowhere' } }),
      maintenanceIntervalMs: 0,
      now: () => clock,
      maxRestarts: 2,
      createClient: () =>
        new LspClient({
          id: 'fake',
          command: path.join(workspace, 'no-such-binary'),
          rootPath: workspace,
          initializeTimeoutMs: 2000,
        }),
    });
    managers.push(manager);

    expect(await manager.acquire('typescript')).toBeNull();
    clock += 60_000;
    expect(await manager.acquire('typescript')).toBeNull();
    expect(manager.isDegraded('typescript')).toBe(true);
  });
});

describe('LSP-05 — reap بیکار', () => {
  it('سرور بی‌استفاده بعد از سررسید خاموش می‌شود', async () => {
    const manager = managerWith({ idleTimeoutMs: 10_000, minLifetimeMs: 1_000 });
    const client = await manager.acquire('typescript');
    const pid = client!.processId!;

    clock += 5_000;
    expect(await manager.reapIdle()).toEqual([]);

    clock += 10_000;
    expect(await manager.reapIdle()).toEqual(['fake']);
    expect(await died(pid)).toBe(true);
    expect(manager.status()[0].state).toBe('stopped');
  });

  it('سرور تازه، حتی بی‌استفاده، reap نمی‌شود', async () => {
    /*
    | «حداقل عمر» یعنی سروری که همین حالا بالا آمده وسط اولین
    | عملیات کشته نشود — سناریویی که با ساعت جعلی راحت پیش می‌آید
    | و در واقعیت هم با یک اسکن طولانی.
    */
    const manager = managerWith({ idleTimeoutMs: 1_000, minLifetimeMs: 30_000 });
    await manager.acquire('typescript');

    clock += 5_000;
    expect(await manager.reapIdle()).toEqual([]);
  });

  it('استفادهٔ تازه، ساعت بیکاری را از نو می‌کند', async () => {
    const manager = managerWith({ idleTimeoutMs: 10_000, minLifetimeMs: 0 });
    await manager.acquire('typescript');

    clock += 9_000;
    await manager.acquire('typescript');
    clock += 9_000;
    expect(await manager.reapIdle()).toEqual([]);
  });

  it('بعد از reap، درخواست بعدی دوباره بالا می‌آورد', async () => {
    const manager = managerWith({ idleTimeoutMs: 1, minLifetimeMs: 0 });
    const first = await manager.acquire('typescript');
    clock += 10_000;
    await manager.reapIdle();

    const second = await manager.acquire('typescript');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(manager.status()[0].failures).toBe(0);
  });
});

describe('LSP-05 — سقف حافظه', () => {
  it('سرور پرمصرف restart می‌شود ولی شکست حساب نمی‌شود', async () => {
    const manager = managerWith({ memoryLimitMb: 100, rss: () => 250 });
    const client = await manager.acquire('typescript');
    const pid = client!.processId!;

    expect(await manager.enforceMemoryLimit()).toEqual(['fake']);
    expect(await died(pid)).toBe(true);
    expect(manager.status()[0].failures).toBe(0);

    const again = await manager.acquire('typescript');
    expect(again).not.toBeNull();
  });

  it('زیر سقف، دست نمی‌خورد', async () => {
    const manager = managerWith({ memoryLimitMb: 1000, rss: () => 250 });
    await manager.acquire('typescript');
    expect(await manager.enforceMemoryLimit()).toEqual([]);
  });

  it('حافظهٔ قابل اندازه‌گیری نبود، چیزی کشته نمی‌شود', async () => {
    /*
    | روی ویندوز اندازه‌گیری نداریم. «نمی‌دانم» نباید به «از سقف
    | رد شده» ترجمه شود.
    */
    const manager = managerWith({ memoryLimitMb: 1, rss: () => null });
    await manager.acquire('typescript');
    expect(await manager.enforceMemoryLimit()).toEqual([]);
  });

  it('سقف صفر یعنی بدون سقف', async () => {
    const manager = managerWith({ memoryLimitMb: 0, rss: () => 99_999 });
    await manager.acquire('typescript');
    expect(await manager.enforceMemoryLimit()).toEqual([]);
  });

  it('status حافظه را گزارش می‌کند', async () => {
    const manager = managerWith({ rss: () => 123 });
    await manager.acquire('typescript');
    expect(manager.status()[0].memoryMb).toBe(123);
  });
});

describe('LSP-06 — آمادگی', () => {
  it('سروری که فوراً جواب می‌دهد، ready است', async () => {
    const manager = managerWith({
      readinessProbe: () => ({
        filePath: path.join(workspace, 'probe.ts'),
        languageId: 'typescript',
      }),
    });

    const client = await manager.acquire('typescript');
    expect(client).not.toBeNull();
    expect(manager.status()[0].readiness).toBe('ready');
  });

  it('سروری که هیچ symbolای نمی‌دهد، degraded می‌شود و null برمی‌گردد', async () => {
    /*
    | این حالتِ «گرم نشده» است: سرور بالا آمده، جواب می‌دهد، ولی
    | جوابش تهی است. استفاده از آن یعنی ایندکس پر از فایل‌های
    | بدون symbol — بدتر از استفاده نکردن.
    */
    const manager = managerWith(
      {
        readyTimeoutMs: 300,
        readinessProbe: () => ({
          filePath: path.join(workspace, 'probe.ts'),
          languageId: 'typescript',
        }),
        readiness: new ReadinessTracker({ pollIntervalMs: 20, maxPollIntervalMs: 50 }),
      },
      ['--empty-symbols']
    );

    expect(await manager.acquire('typescript')).toBeNull();
    expect(manager.status()[0].readiness).toBe('degraded');
  });

  it('بدون فایل نمونه، فقط به سرور اعتماد می‌شود', async () => {
    const manager = managerWith({ readinessProbe: () => null }, ['--empty-symbols']);
    expect(await manager.acquire('typescript')).not.toBeNull();
    expect(manager.status()[0].readiness).toBe('ready');
  });

  it('سرورِ گرم‌نشده کشته نمی‌شود — شاید دفعهٔ بعد آماده باشد', async () => {
    const manager = managerWith(
      {
        readyTimeoutMs: 200,
        readinessProbe: () => ({
          filePath: path.join(workspace, 'probe.ts'),
          languageId: 'typescript',
        }),
        readiness: new ReadinessTracker({ pollIntervalMs: 20, maxPollIntervalMs: 40 }),
      },
      ['--empty-symbols']
    );

    await manager.acquire('typescript');
    const status = manager.status()[0];
    expect(status.state).toBe('running');
    expect(status.pid).toBeGreaterThan(0);
  });
});

// ── کمکی ──────────────────────────────────────────────────────────────

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

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
