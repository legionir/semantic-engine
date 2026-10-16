/**
 * LSP-12 — بخش `lsp` در پیکربندی.
 *
 * `Config` خودش در فاز ۰۸ آزمون دارد؛ چیزی که اینجا سنجیده می‌شود
 * ترجمهٔ تنظیمات به رفتار است — به‌ویژه جاهایی که «صفر» معنی
 * متفاوتی از «صفر ثانیه» دارد.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Config } from '../host/Config';
import { lspSettingsFrom, managerOptionsFrom } from './config';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-config-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function configWith(values: Record<string, unknown>): Config {
  fs.writeFileSync(
    path.join(workspace, 'semantic-engine.config.json'),
    JSON.stringify(values),
    'utf8'
  );
  return Config.load({ cwd: workspace, argv: [], env: {} });
}

describe('LSP-12 — پیش‌فرض‌ها', () => {
  it('پیش‌فرض خاموش است', () => {
    const settings = lspSettingsFrom(Config.load({ cwd: workspace, argv: [], env: {} }));
    expect(settings.enabled).toBe(false);
  });

  it('پیش‌فرض‌های عددی همان‌هایی‌اند که سند طراحی پیشنهاد کرده', () => {
    const settings = lspSettingsFrom(Config.load({ cwd: workspace, argv: [], env: {} }));
    expect(settings.requestTimeoutMs).toBe(15_000);
    expect(settings.idleTimeoutMs).toBe(600_000);
    expect(settings.warmupTimeoutMs).toBe(120_000);
    expect(settings.maxServerMemoryMb).toBe(2048);
    expect(settings.servers).toEqual({});
  });
});

describe('LSP-12 — خواندن از فایل', () => {
  it('کلیدها از فایل پیکربندی خوانده می‌شوند', () => {
    const settings = lspSettingsFrom(
      configWith({
        'semanticEngine.lsp.enabled': true,
        'semanticEngine.lsp.requestTimeoutMs': 3_000,
        'semanticEngine.lsp.maxServerMemoryMB': 512,
      })
    );

    expect(settings.enabled).toBe(true);
    expect(settings.requestTimeoutMs).toBe(3_000);
    expect(settings.maxServerMemoryMb).toBe(512);
  });

  it('شکل تودرتو هم کار می‌کند', () => {
    const settings = lspSettingsFrom(
      configWith({ semanticEngine: { lsp: { enabled: true, idleTimeoutMs: 42 } } })
    );
    expect(settings.enabled).toBe(true);
    expect(settings.idleTimeoutMs).toBe(42);
  });

  it('متغیر محیطی هم همان کلید را می‌پوشاند', () => {
    const config = Config.load({
      cwd: workspace,
      argv: [],
      env: { SEMANTIC_ENGINE_LSP_ENABLED: 'true' },
    });
    expect(lspSettingsFrom(config).enabled).toBe(true);
  });
});

describe('LSP-12 — override سرورها', () => {
  it('مسیر و آرگومان‌ها خوانده می‌شوند', () => {
    const settings = lspSettingsFrom(
      configWith({
        'semanticEngine.lsp.servers': {
          pyright: { command: '/opt/pyright-langserver', args: ['--stdio', '--verbose'] },
        },
      })
    );
    expect(settings.servers.pyright).toEqual({
      command: '/opt/pyright-langserver',
      args: ['--stdio', '--verbose'],
      disabled: false,
    });
  });

  it('خاموش کردن یک سرور', () => {
    const settings = lspSettingsFrom(
      configWith({ 'semanticEngine.lsp.servers': { gopls: { disabled: true } } })
    );
    expect(settings.servers.gopls.disabled).toBe(true);
  });

  it('ورودی بی‌محتوا نگه داشته نمی‌شود', () => {
    const settings = lspSettingsFrom(
      configWith({ 'semanticEngine.lsp.servers': { gopls: {}, clangd: { nonsense: 1 } } })
    );
    expect(settings.servers).toEqual({});
  });

  it('ورودی نامعتبر، خطا نمی‌دهد', () => {
    /*
    | پیکربندی از دست کاربر می‌آید. یک آرایه به‌جای شیء، یا یک
    | رشته به‌جای فهرست آرگومان‌ها، نباید کل اجرا را بترکاند.
    */
    const settings = lspSettingsFrom(
      configWith({
        'semanticEngine.lsp.servers': {
          gopls: { command: 42, args: 'not-a-list' },
          pyright: { command: '/ok', args: ['--stdio', 7] },
        },
      })
    );
    expect(settings.servers.gopls).toBeUndefined();
    expect(settings.servers.pyright).toEqual({
      command: '/ok',
      args: ['--stdio'],
      disabled: false,
    });
  });
});

describe('LSP-12 — ترجمه به گزینه‌های مدیر', () => {
  it('اعداد همان‌طور رد می‌شوند', () => {
    const options = managerOptionsFrom(
      {
        enabled: true,
        requestTimeoutMs: 1_000,
        idleTimeoutMs: 2_000,
        warmupTimeoutMs: 3_000,
        maxServerMemoryMb: 128,
        servers: {},
      },
      { workspaceRoot: workspace }
    );

    expect(options.requestTimeoutMs).toBe(1_000);
    expect(options.idleTimeoutMs).toBe(2_000);
    expect(options.warmupTimeoutMs).toBe(3_000);
    expect(options.memoryLimitMb).toBe(128);
    expect(options.workspaceRoot).toBe(workspace);
  });

  it('idleTimeout صفر یعنی «هرگز خاموش نکن»، نه «فوراً خاموش کن»', () => {
    /*
    | همان دستهٔ SE-EXT-07: صفر در یک سقف زمانی دو معنی کاملاً
    | متضاد دارد. رد کردن مستقیمش به مدیر یعنی هر سرور در اولین
    | نگهداری reap می‌شود.
    */
    const options = managerOptionsFrom(
      {
        enabled: true,
        requestTimeoutMs: 1_000,
        idleTimeoutMs: 0,
        warmupTimeoutMs: 1_000,
        maxServerMemoryMb: 0,
        servers: {},
      },
      { workspaceRoot: workspace }
    );

    expect(options.idleTimeoutMs).toBe(Number.POSITIVE_INFINITY);
    // ولی سقف حافظهٔ صفر واقعاً یعنی «بدون سقف» — مدیر خودش می‌داند.
    expect(options.memoryLimitMb).toBe(0);
  });
});
