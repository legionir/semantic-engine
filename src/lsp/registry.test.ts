/**
 * LSP-04 — جدول سرورها، و مهم‌تر: کِی سراغشان نرویم.
 *
 * بیشتر این آزمون‌ها دربارهٔ *نه گفتن*‌اند: سروری که نصب نیست،
 * سروری که هست ولی به این پروژه نمی‌خورد، و سروری که کاربر صریحاً
 * خاموشش کرده. هر سهٔ این‌ها باید به «ادامه با tree-sitter» ختم
 * شوند، نه به یک استک‌تریس.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_LSP_SERVERS,
  LspServerRegistry,
  describeMissingServers,
} from './registry';

let workspace: string;
let binDir: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-registry-'));
  binDir = path.join(workspace, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** یک باینری ساختگی روی PATH. */
function fakeBinary(name: string): string {
  const full = path.join(binDir, name);
  fs.writeFileSync(full, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  return full;
}

/*
| جدول آزمون: همان جدول واقعی، منهای resolve مخصوصِ TypeScript.
|
| آن یکی عمداً به `node_modules` سر می‌زند تا `tsgo` را بدون PATH
| پیدا کند (فاز ۳۲). داخل یک آزمون واحد یعنی نتیجه به نصب بودن یک
| پکیج وابسته می‌شود — و دقیقاً همین باعث شد این فایل روی محیط
| بدون زبان‌سرور بشکند (SE-LSP-15). این‌جا همان spec می‌ماند ولی از
| راه PATH resolve می‌شود، مثل بقیه.
*/
const TEST_SPECS = DEFAULT_LSP_SERVERS.map(spec =>
  spec.id === 'typescript' ? { ...spec, resolveCommand: undefined } : spec
);

function registry(over: Record<string, unknown> = {}) {
  return new LspServerRegistry({ specs: TEST_SPECS, env: { PATH: binDir }, ...over });
}

describe('LSP-04 — جدول', () => {
  it('نه سرور، همان‌هایی که سند طراحی فهرست کرده', () => {
    expect(DEFAULT_LSP_SERVERS).toHaveLength(9);
    expect(DEFAULT_LSP_SERVERS.map(spec => spec.id)).toEqual([
      'typescript',
      'typescript-language-server',
      'pyright',
      'gopls',
      'rust-analyzer',
      'clangd',
      'intelephense',
      'solargraph',
      'jdtls',
    ]);
  });

  it('هر سرور دستور نصب دارد — چون هیچ‌وقت خودکار نصب نمی‌کنیم', () => {
    for (const spec of DEFAULT_LSP_SERVERS) {
      expect(spec.install.length).toBeGreaterThan(5);
      expect(spec.binaries.length).toBeGreaterThan(0);
      expect(spec.languages.length).toBeGreaterThan(0);
    }
  });

  it('هر زبان به سرورهای خودش می‌رسد', () => {
    const table = registry();
    expect(table.forLanguage('go').map(s => s.id)).toEqual(['gopls']);
    expect(table.forLanguage('python').map(s => s.id)).toEqual(['pyright']);
    expect(table.forLanguage('typescript').map(s => s.id)).toEqual([
      'typescript',
      'typescript-language-server',
    ]);
    expect(table.forLanguage('cobol')).toEqual([]);
  });

  it('نام زبان بدون توجه به بزرگی حروف', () => {
    expect(registry().forLanguage('TypeScript').map(s => s.id)).toContain('typescript');
  });
});

describe('LSP-04 — پیدا کردن باینری روی PATH', () => {
  it('باینری موجود پیدا می‌شود', () => {
    fakeBinary('gopls');
    const resolved = registry().resolveSpec(DEFAULT_LSP_SERVERS.find(s => s.id === 'gopls')!);

    expect(resolved).not.toBeNull();
    expect(resolved!.command).toBe(path.join(binDir, 'gopls'));
    expect(resolved!.args).toEqual(['serve']);
    expect(resolved!.source).toBe('path');
  });

  it('باینری ناموجود، null می‌دهد — نه خطا', () => {
    expect(registry().resolveSpec(DEFAULT_LSP_SERVERS.find(s => s.id === 'gopls')!)).toBeNull();
  });

  it('PATH خالی هم فقط null است', () => {
    const table = new LspServerRegistry({ specs: TEST_SPECS, env: {} });
    expect(table.resolveSpec(DEFAULT_LSP_SERVERS.find(s => s.id === 'pyright')!)).toBeNull();
  });

  it('اولین نام باینری ترجیح دارد', () => {
    /*
    | برای TypeScript دو نام هست (`tsgo` و `tsc`) و ترتیبشان مهم
    | است: `tsc` روی PATH معمولاً نسخهٔ ۵ است که `--lsp` ندارد.
    */
    const spec = DEFAULT_LSP_SERVERS.find(s => s.id === 'typescript')!;
    expect(spec.binaries[0]).toBe('tsgo');
  });
});

describe('LSP-04 — rootMarkers', () => {
  const gopls = DEFAULT_LSP_SERVERS.find(s => s.id === 'gopls')!;

  it('سرور بدون نشانه، همیشه مناسب است', () => {
    const typescript = DEFAULT_LSP_SERVERS.find(s => s.id === 'typescript')!;
    expect(typescript.rootMarkers).toEqual([]);
    expect(registry().isSuitable(typescript, workspace)).toBe(true);
  });

  it('gopls بدون go.mod مناسب نیست', () => {
    expect(registry().isSuitable(gopls, workspace)).toBe(false);
  });

  it('با go.mod مناسب می‌شود', () => {
    fs.writeFileSync(path.join(workspace, 'go.mod'), 'module x\n');
    expect(registry().isSuitable(gopls, workspace)).toBe(true);
  });

  it('یکی از نشانه‌ها کافی است', () => {
    fs.writeFileSync(path.join(workspace, 'go.work'), 'go 1.22\n');
    expect(registry().isSuitable(gopls, workspace)).toBe(true);
  });

  it('سرور نامناسب حتی وقتی نصب است هم انتخاب نمی‌شود', () => {
    fakeBinary('gopls');
    expect(registry().resolveForLanguage('go', workspace)).toBeNull();

    fs.writeFileSync(path.join(workspace, 'go.mod'), 'module x\n');
    expect(registry().resolveForLanguage('go', workspace)).not.toBeNull();
  });

  it('نشانه فقط برای سرورهایی است که بدونش کار نمی‌کنند', () => {
    /*
    | وسوسه این است که برای هر سرور نشانه بگذاریم. ولی `pyright` و
    | `typescript-go` روی یک پوشهٔ بی‌کانفیگ هم کار می‌کنند، و
    | نشانه گذاشتن یعنی روی پروژه‌های واقعی بی‌دلیل خاموش می‌شوند.
    */
    const withMarkers = DEFAULT_LSP_SERVERS.filter(s => s.rootMarkers.length > 0).map(s => s.id);
    expect(withMarkers.sort()).toEqual(['clangd', 'gopls', 'jdtls', 'rust-analyzer']);
  });
});

describe('LSP-04 — override از پیکربندی', () => {
  const pyright = DEFAULT_LSP_SERVERS.find(s => s.id === 'pyright')!;

  it('مسیر صریح بر PATH مقدم است', () => {
    fakeBinary('pyright-langserver');
    const custom = fakeBinary('my-pyright');

    const resolved = registry({
      overrides: { pyright: { command: custom, args: ['--custom'] } },
    }).resolveSpec(pyright);

    expect(resolved!.command).toBe(custom);
    expect(resolved!.args).toEqual(['--custom']);
    expect(resolved!.source).toBe('config');
  });

  it('مسیر صریحِ ناموجود، سکوت نمی‌کند و سراغ PATH هم نمی‌رود', () => {
    /*
    | همان قاعدهٔ فاز ۳۲ برای متغیر محیطی: اگر کسی مسیری داده،
    | برگرداندن یک سرور *دیگر* یعنی ساعت‌ها فکر می‌کند تنظیمش اثر
    | کرده است.
    */
    fakeBinary('pyright-langserver');
    const resolved = registry({
      overrides: { pyright: { command: path.join(workspace, 'gone') } },
    }).resolveSpec(pyright);

    expect(resolved).toBeNull();
  });

  it('نام ساده (بدون جداکنندهٔ مسیر) به PATH سپرده می‌شود', () => {
    const resolved = registry({
      overrides: { pyright: { command: 'my-server-on-path' } },
    }).resolveSpec(pyright);
    expect(resolved!.command).toBe('my-server-on-path');
  });

  it('سرور خاموش‌شده انتخاب نمی‌شود', () => {
    fakeBinary('pyright-langserver');
    expect(registry({ overrides: { pyright: { disabled: true } } }).resolveSpec(pyright)).toBeNull();
  });

  it('SE-F-027 — override بدون command، فقط args را اعمال می‌کند (نه دور ریختن)', () => {
    fakeBinary('pyright-langserver');
    const resolved = registry({
      overrides: { pyright: { args: ['--stdio', '--verbose'] } },
    }).resolveSpec(pyright);

    /*
    | قبلاً `override.args` فقط داخل شاخهٔ `override.command` خوانده
    | می‌شد؛ این شکلِ مستندِ ServerOverride بود که بی‌صدا نادیده
    | گرفته می‌شد: کاربر args را تنظیم می‌کرد و سرور با args پیش‌فرض
    | بالا می‌آمد.
    */
    expect(resolved).not.toBeNull();
    expect(resolved!.command).toContain('pyright-langserver');
    expect(resolved!.args).toEqual(['--stdio', '--verbose']);
  });

  it('SE-F-027 — args-only override روی مسیر resolveCommand هم اعمال می‌شود', () => {
    /*
    | همان نقص روی specهایی با resolver اختصاصی: خروجی resolver دیگر
    | آخرین کلمه نیست؛ overrideِ args پس از resolve اعمال می‌شود و
    | سرور عوض نمی‌شود.
    */
    const spec = {
      id: 'custom-resolved',
      languages: ['text'],
      binaries: ['never-on-path'],
      args: ['--default'],
      install: 'n/a (test fixture)',
      rootMarkers: [],
      needsWarmup: false,
      resolveCommand: () => ({
        id: 'custom-resolved',
        command: '/opt/bin/custom-lsp',
        args: ['--from-resolver'],
        source: 'bundled' as const,
      }),
    };
    const resolved =
      new LspServerRegistry({
        specs: [spec],
        env: { PATH: binDir },
        overrides: { 'custom-resolved': { args: ['--override'] } },
      }).resolveSpec(spec);

    expect(resolved!.command).toBe('/opt/bin/custom-lsp');
    expect(resolved!.args).toEqual(['--override']);
  });
});

describe('LSP-04 — گزارش برای doctor', () => {
  it('همهٔ سرورها با دلیل گزارش می‌شوند', () => {
    fakeBinary('gopls');
    fs.writeFileSync(path.join(workspace, 'go.mod'), 'module x\n');

    const detections = registry().detectAll(workspace);
    expect(detections).toHaveLength(9);

    const go = detections.find(d => d.id === 'gopls')!;
    expect(go.resolved).not.toBeNull();
    expect(go.suitable).toBe(true);

    const rust = detections.find(d => d.id === 'rust-analyzer')!;
    expect(rust.resolved).toBeNull();
    expect(rust.reason).toContain('rustup component add');
  });

  it('سروری که هست ولی نمی‌خورد، دلیلش را می‌گوید', () => {
    fakeBinary('clangd');
    const clangd = registry().detectAll(workspace).find(d => d.id === 'clangd')!;

    expect(clangd.resolved).not.toBeNull();
    expect(clangd.suitable).toBe(false);
    expect(clangd.reason).toContain('compile_commands.json');
  });

  it('ترتیب گزارش بین اجراها ثابت است', () => {
    const first = registry().detectAll(workspace).map(d => d.id);
    const second = registry().detectAll(workspace).map(d => d.id);
    expect(first).toEqual(second);
  });
});

describe('LSP-04 — پیام نبودِ سرور', () => {
  it('برای زبان شناخته‌شده، دستور نصب می‌دهد — نه استک‌تریس', () => {
    const message = describeMissingServers(registry(), 'go');
    expect(message).toContain('go install golang.org/x/tools/gopls@latest');
    expect(message).toMatch(/keeps working without it/);
  });

  it('برای زبان ناشناخته، صادقانه می‌گوید سروری نمی‌شناسد', () => {
    const message = describeMissingServers(registry(), 'cobol');
    expect(message).toContain('cobol');
    expect(message).toMatch(/tree-sitter|heuristics/);
  });

  it('برای TypeScript، همان راهنمای فاز ۳۲ را می‌دهد', () => {
    const message = describeMissingServers(registry(), 'typescript');
    expect(message).toContain('@typescript/native-preview');
  });
});
