/**
 * فاز ۲۹ — رابط خط فرمان.
 *
 *   MIG-50  `bin/semantic-engine.js`: تجزیهٔ آرگومان، `--help`،
 *           کد خروج معنادار، `--json` برای خروجی ماشین‌خوان
 *   MIG-51  `index`
 *   MIG-53  `query` روی همان `AiToolRegistry`
 *   MIG-55  `doctor`
 *
 * تست‌ها CLI را در یک **پروسهٔ جدا** اجرا می‌کنند. هر چیز کمتری —
 * صدا زدن مستقیم تابع `main` — کد خروج، نوشتن روی stdout/stderr و
 * جداسازی آن دو را نمی‌سنجد، که دقیقاً چیزهایی‌اند که یک CLI را
 * قابل استفاده می‌کنند.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { parseArgs, EXIT } from './args';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(PACKAGE_ROOT, 'bin', 'semantic-engine.js');
const FIXTURE = path.join(PACKAGE_ROOT, 'test-fixture');

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], cwd = PACKAGE_ROOT): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

const built = fs.existsSync(BIN) && fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

// ── تجزیهٔ آرگومان، بدون پروسه ────────────────────────────────────

describe('MIG-50 — کدهای خروج یک قرارداد بیرونی‌اند', () => {
  /*
  | اسکریپت‌نویس روی عدد تکیه می‌کند، نه روی نام ثابت. اگر تست‌ها هم
  | از همان ثابت استفاده کنند، عوض کردن مقدار هیچ‌جا قرمز نمی‌شود —
  | که در اولین اثباتِ برگرداندن همین اتفاق افتاد.
  */
  it('اعداد همان چیزی‌اند که راهنما اعلام می‌کند', () => {
    expect(EXIT.ok).toBe(0);
    expect(EXIT.failure).toBe(1);
    expect(EXIT.usage).toBe(2);
    expect(EXIT.unhealthy).toBe(3);
  });
});

describe('MIG-50 — تجزیهٔ آرگومان', () => {
  it('دستور و پرچم‌ها را جدا می‌کند', () => {
    const parsed = parseArgs(['index', '--root', '/tmp/x', '--json']);
    expect(parsed.command).toBe('index');
    expect(parsed.options['root']).toBe('/tmp/x');
    expect(parsed.options['json']).toBe(true);
  });

  it('`--key=value` را هم می‌فهمد', () => {
    const parsed = parseArgs(['index', '--root=/tmp/y']);
    expect(parsed.options['root']).toBe('/tmp/y');
  });

  it('`--no-x` را به `false` تبدیل می‌کند', () => {
    const parsed = parseArgs(['index', '--no-blueprint']);
    expect(parsed.options['blueprint']).toBe(false);
  });

  it('کلیدهای مرحلهٔ diagnostics زبان‌سرور را می‌شناسد', () => {
    const parsed = parseArgs(['index', '--lsp-diagnostics', '--diagnostics-budget', '1500']);
    expect(parsed.options['lspDiagnostics']).toBe(true);
    expect(parsed.options['diagnosticsBudget']).toBe('1500');

    /*
    | هر دو پیش‌فرض خاموش‌اند — زبان‌سرور روی ۱۶۴ فایل همین مخزن ~۷٫۷ ثانیه
    | می‌برد، پس روشن‌کردنش باید تصمیم باشد، نه حالت پیش‌فرض.
    */
    expect(parseArgs(['index']).options['lspDiagnostics']).toBeUndefined();
  });

  it('آرگومان‌های موضعی را نگه می‌دارد', () => {
    const parsed = parseArgs(['query', 'find_symbol', '--name', 'Foo']);
    expect(parsed.command).toBe('query');
    expect(parsed.positional).toEqual(['find_symbol']);
    expect(parsed.options['name']).toBe('Foo');
  });

  it('نبود دستور، یک خطای استفاده است', () => {
    expect(parseArgs([]).command).toBeNull();
  });

  it('پرچمی که مقدارش پرچم بعدی است، boolean می‌شود', () => {
    const parsed = parseArgs(['index', '--pretty', '--root', '/tmp/z']);
    expect(parsed.options['pretty']).toBe(true);
    expect(parsed.options['root']).toBe('/tmp/z');
  });
});

// ── رفتار واقعی، در پروسهٔ جدا ────────────────────────────────────

describeIfBuilt('MIG-50 — راهنما و کد خروج', () => {
  it('`--help` روی stdout می‌رود و با ۰ تمام می‌شود', () => {
    const result = run(['--help']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain('semantic-engine');
    expect(result.stdout).toContain('index');
    expect(result.stdout).toContain('query');
    expect(result.stdout).toContain('doctor');
    /*
    | کلیدهای تازه‌ای که بیرون از راهنما بمانند، عملاً وجود ندارند —
    | مخصوصاً این دو، که هزینه‌شان را کاربر باید قبل از روشن‌کردن ببیند.
    */
    expect(result.stdout).toContain('--lsp-diagnostics');
    expect(result.stdout).toContain('--diagnostics-budget');
    expect(result.stderr).toBe('');
  });

  it('بدون دستور، راهنما روی stderr و کد استفاده', () => {
    const result = run([]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain('usage');
  });

  it('دستور ناشناخته، کد استفاده می‌دهد نه کرش', () => {
    const result = run(['fly-me-to-the-moon']);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/unknown command/i);
    expect(result.stderr).not.toMatch(/at Object|at Module/); // نه استک‌تریس
  });

  it('`--version` نسخهٔ پکیج را می‌دهد', () => {
    const result = run(['--version']);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
    ) as { version: string };
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});

describeIfBuilt('MIG-51 — دستور index', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cli-index-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('روی fixture همان چیزی می‌دهد که snapshot ثبت کرده', () => {
    const result = run(['index', '--root', FIXTURE, '--out', outputDir,]);
    expect(result.code).toBe(EXIT.ok);

    const written = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'project-index.json'), 'utf8')
    ) as { files: unknown[]; symbols: unknown[] };
    const golden = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'test', 'golden', 'project-index.golden.json'), 'utf8')
    ) as { files: unknown[]; symbols: unknown[] };

    expect(written.files.length).toBe(golden.files.length);
    expect(written.symbols.length).toBe(golden.symbols.length);
  }, 120_000);

  it('blueprint را هم می‌نویسد', () => {
    run(['index', '--root', FIXTURE, '--out', outputDir,]);
    expect(fs.existsSync(path.join(outputDir, 'blueprint.json'))).toBe(true);
  }, 120_000);

  it('`--json` یک خط JSON ماشین‌خوان می‌دهد', () => {
    const result = run(['index', '--root', FIXTURE, '--out', outputDir, '--json']);
    expect(result.code).toBe(EXIT.ok);

    const summary = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      files: number;
      symbols: number;
      indexPath: string;
    };
    expect(summary.ok).toBe(true);
    expect(summary.files).toBeGreaterThan(0);
    expect(summary.symbols).toBeGreaterThan(0);
    expect(summary.indexPath).toContain('project-index.json');
  }, 120_000);

  it('در حالت --json، stdout فقط JSON است', () => {
    /*
    | SE-EXT-06: `Logger` سطح `info` را روی **stdout** می‌نویسد. برای
    | یک کتابخانه بی‌ضرر است؛ برای یک CLI یعنی اولین خطِ
    | `--json` یک لاگ است و `JSON.parse` روی خروجی می‌ترکد.
    */
    const result = run(['index', '--root', FIXTURE, '--out', outputDir, '--json']);

    expect(result.code).toBe(EXIT.ok);
    expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  }, 120_000);

  it('حتی بدون --json، پیشرفت روی stderr می‌رود نه stdout', () => {
    const result = run(['index', '--root', FIXTURE, '--out', outputDir,]);

    // stdout فقط خلاصهٔ دستور است
    expect(result.stdout).toMatch(/^indexed \d+ files/);
    expect(result.stdout).not.toMatch(/\binfo\b/);
  }, 120_000);

  it('ریشهٔ ناموجود، خطای خوانا می‌دهد نه استک‌تریس', () => {
    const result = run(['index', '--root', path.join(outputDir, 'nope')]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toMatch(/not a directory|does not exist/i);
    expect(result.stderr).not.toMatch(/at Object\.|at Module\./);
  });

  it('خروجی پیش‌فرض در data directory است، نه داخل ریشه', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cli-ws-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cli-data-'));
    const projectId = 'prj-cli-index-00000000';
    try {
      fs.mkdirSync(path.join(workspace, 'src'));
      fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');

      const result = run([
        'index',
        '--root',
        workspace,
        '--project-id',
        projectId,
        '--data-dir',
        dataDir,
      ]);
      expect(result.code).toBe(EXIT.ok);
      expect(
        fs.existsSync(path.join(dataDir, 'projects', projectId, 'project-index.json'))
      ).toBe(true);
      /* هیچ artifactی داخل checkout ساخته نمی‌شود. */
      expect(fs.existsSync(path.join(workspace, '.semantic-engine'))).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('--artifact-location in-root همان خروجی قدیمی را می‌دهد', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cli-ws-'));
    try {
      fs.mkdirSync(path.join(workspace, 'src'));
      fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');

      /*
      | Phase 0: the flag the test is named for was missing from the
      | invocation — since فاز ۴ the default is `external`, so the test
      | asserted the *legacy* layout while running the new default and had
      | been red under `npm test` ever since. The flag is what makes the
      | expectation true.
      */
      const result = run(['index', '--root', workspace, '--artifact-location', 'in-root']);
      expect(result.code).toBe(EXIT.ok);
      expect(
        fs.existsSync(path.join(workspace, '.semantic-engine', 'project-index.json'))
      ).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});

describeIfBuilt('MIG-53 — دستور query', () => {
  let outputDir: string;

  beforeAll(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cli-query-'));
    run(['index', '--root', FIXTURE, '--out', outputDir,]);
  }, 180_000);

  afterAll(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('بدون نام ابزار، فهرست ابزارها را می‌دهد', () => {
    const result = run(['query', '--index', path.join(outputDir, 'project-index.json')]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain('find_symbol');
  });

  it('`find_symbol` روی ایندکس واقعی جواب می‌دهد', () => {
    const result = run([
      'query',
      'find_symbol',
      '--index',
      path.join(outputDir, 'project-index.json'),
      '--name',
      'UserController',
      '--json',
    ]);

    expect(result.code).toBe(EXIT.ok);
    const payload = JSON.parse(result.stdout.trim()) as { ok: boolean; result: unknown };
    expect(payload.ok).toBe(true);
    expect(JSON.stringify(payload.result)).toContain('UserController');
  });

  it('ابزار ناشناخته، کد استفاده می‌دهد', () => {
    const result = run([
      'query',
      'no_such_tool',
      '--index',
      path.join(outputDir, 'project-index.json'),
    ]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/unknown tool/i);
  });

  it('ایندکس ناموجود، خطای خوانا می‌دهد', () => {
    const result = run(['query', 'find_symbol', '--index', '/nope/project-index.json']);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toMatch(/index/i);
    expect(result.stderr).not.toMatch(/at Object\.|at Module\./);
  });
});

describeIfBuilt('MIG-55 — دستور doctor', () => {
  it('روی این محیط اجرا می‌شود و گزارش می‌دهد', () => {
    const result = run(['doctor']);
    // ۰ یا ۳ — بسته به اینکه ماژول اختیاری نصب باشد یا نه
    expect([EXIT.ok, EXIT.unhealthy]).toContain(result.code);
    expect(result.stdout).toMatch(/node/i);
    expect(result.stdout).toMatch(/git/i);
  }, 60_000);

  it('`--json` گزارش ساخت‌یافته می‌دهد', () => {
    const result = run(['doctor', '--json']);
    const report = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string; optional?: boolean }[];
    };

    expect(Array.isArray(report.checks)).toBe(true);
    const names = report.checks.map(check => check.name);
    for (const expected of ['node', 'git', 'tree-sitter-grammars', 'write-access']) {
      expect(names).toContain(expected);
    }
    for (const check of report.checks) {
      expect(typeof check.ok).toBe('boolean');
      expect(typeof check.detail).toBe('string');
    }
  }, 60_000);

  it('LSP-11 — زبان‌سرورها گزارش می‌شوند', () => {
    const result = run(['doctor', '--json']);
    const report = JSON.parse(result.stdout.trim()) as {
      checks: { name: string; ok: boolean; detail: string; optional?: boolean }[];
    };

    const summary = report.checks.find(check => check.name === 'language-servers')!;
    expect(summary).toBeDefined();
    expect(summary.optional).toBe(true);
    expect(summary.detail).toMatch(/available|tree-sitter/);
  }, 60_000);

  it('LSP-11 — نبود سرور، دستور نصب می‌دهد نه استک‌تریس', () => {
    /*
    | معیار پذیرش فاز ۳۶. هیچ سروری جز TypeScript روی این ماشین
    | نیست، پس خروجی باید دستور نصب داشته باشد و هیچ استک‌تریسی
    | نداشته باشد.
    */
    const result = run(['doctor']);
    expect(result.stdout).toMatch(/npm install -g|go install|rustup component/);
    expect(result.stdout).not.toMatch(/at Object\.|node_modules|Error:/);
  }, 60_000);

  it('LSP-11 — نبود زبان‌سرور، doctor را ناسالم نمی‌کند', () => {
    const result = run(['doctor', '--json']);
    const report = JSON.parse(result.stdout.trim()) as {
      checks: { name: string; ok: boolean; optional?: boolean }[];
    };

    for (const check of report.checks.filter(entry => entry.name.includes('lsp'))) {
      expect(check.optional).toBe(true);
    }
  }, 60_000);

  it('یک ماژول اختیاری غایب، doctor را ناسالم نمی‌کند', () => {
    const result = run(['doctor', '--json']);
    const report = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      checks: { name: string; ok: boolean; optional?: boolean }[];
    };

    /*
    | `usearch` باینری دانلودی دارد و در محیط بدون شبکه نصب نمی‌شود
    | (SE-BUILD-10). نبودنش یک *گزارش* است، نه خرابی —
    | وگرنه `doctor` در همان محیطی که بیشترین کاربرد را دارد همیشه
    | قرمز است.
    */
    const requiredFailures = report.checks.filter(check => !check.ok && !check.optional);
    expect(report.ok).toBe(requiredFailures.length === 0);
  }, 60_000);
});
