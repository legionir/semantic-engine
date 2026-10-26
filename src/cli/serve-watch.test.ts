/**
 * فاز ۳۰ — پذیرش `serve` و `watch`، در پروسهٔ واقعی.
 *
 * پذیرش فاز: «`serve --http` بدون توکن `401` بدهد. `curl` از یک IP
 * دیگر به آن نرسد.» هر دو فقط با یک پروسهٔ واقعی و یک سوکت واقعی
 * قابل سنجش‌اند.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, ChildProcess } from 'child_process';
import { EXIT } from './args';
import { claimPidFile, releasePidFile, isProcessAlive, PID_FILE_NAME } from './commands/watch-command';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(PACKAGE_ROOT, 'bin', 'semantic-engine.js');
const FIXTURE = path.join(PACKAGE_ROOT, 'test-fixture');

const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

interface Reply {
  readonly status: number;
  readonly body: string;
}

function request(
  options: { port: number; host?: string; token?: string; origin?: string; body?: string }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (options.origin) headers['origin'] = options.origin;

    const req = http.request(
      {
        host: options.host ?? '127.0.0.1',
        port: options.port,
        method: 'POST',
        path: '/mcp',
        headers,
        timeout: 4000,
      },
      response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(options.body ?? '{}');
  });
}

/** اجرای CLI و برگرداندن کد خروج — برای مسیرهایی که فوراً تمام می‌شوند. */
function runOnce(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** بالا آوردن یک پروسهٔ CLI و انتظار تا یک خط خاص روی stderr. */
function spawnUntil(
  args: readonly string[],
  marker: RegExp,
  timeoutMs = 60_000
): Promise<{ child: ChildProcess; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for ${marker}\n${stderr}`));
    }, timeoutMs);

    child.stderr!.on('data', chunk => {
      stderr += String(chunk);
      if (marker.test(stderr)) {
        clearTimeout(timer);
        resolve({ child, stderr });
      }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`exited early with ${code}\n${stderr}`));
    });
  });
}

/**
 * مهلت خاموشی.
 *
 * ۸ ثانیه بود و در اجرای کامل سوئیت یک‌بار قرمز شد: خاموشیِ watch
 * شامل نوشتن ایندکس است و روی ماشینی که هم‌زمان صد سوئیت دیگر را
 * می‌برد، هشت ثانیه کم می‌آید. آزمون خودش ۱۲۰ ثانیه بودجه دارد،
 * پس سخت‌گیری اینجا هیچ چیزی را زودتر پیدا نمی‌کرد — فقط گاهی
 * دروغ می‌گفت (SE-BUILD-16).
 *
 * سی ثانیه هنوز خیلی کمتر از بودجهٔ آزمون است، پس یک خاموشیِ
 * واقعاً معلق همچنان قرمز می‌شود — و حالا با پیامی که می‌گوید چه
 * شد، نه با یک `null` بی‌صدا.
 */
const SHUTDOWN_GRACE_MS = 30_000;

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT'): Promise<number | null> {
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  child.kill(signal);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), SHUTDOWN_GRACE_MS);
  });

  const result = await Promise.race([exited, timeout]);
  if (timer) clearTimeout(timer);

  if (result === null && child.exitCode === null) {
    child.kill('SIGKILL');
    throw new Error(
      `the watcher did not exit within ${SHUTDOWN_GRACE_MS}ms of ${signal}; killed it instead`
    );
  }
  return result;
}

// ── قفل PID، بدون پروسه ───────────────────────────────────────────

describe('MIG-52 — قفل PID', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'se-pid-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('اولین ادعا موفق است و فایل را می‌نویسد', () => {
    const pidPath = path.join(directory, PID_FILE_NAME);
    expect(claimPidFile(pidPath)).toEqual({ ok: true });
    expect(Number(fs.readFileSync(pidPath, 'utf8').trim())).toBe(process.pid);
  });

  it('فایل PID یک پروسهٔ مرده، قفل نمی‌کند', () => {
    /*
    | یک کرش نباید watch را تا ابد قفل کند. شناسهٔ ۹۹٬۹۹۹٬۹۹۹ روی
    | لینوکس بالاتر از `pid_max` پیش‌فرض است، پس مطمئناً زنده نیست.
    */
    const pidPath = path.join(directory, PID_FILE_NAME);
    fs.writeFileSync(pidPath, '99999999\n');

    expect(claimPidFile(pidPath)).toEqual({ ok: true });
    expect(Number(fs.readFileSync(pidPath, 'utf8').trim())).toBe(process.pid);
  });

  it('فایل PID یک پروسهٔ زنده، قفل می‌کند', () => {
    const pidPath = path.join(directory, PID_FILE_NAME);
    fs.writeFileSync(pidPath, `${process.pid}\n`);

    const claim = claimPidFile(pidPath);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.pid).toBe(process.pid);
  });

  it('آزادسازی فقط مالِ خودمان را برمی‌دارد', () => {
    const pidPath = path.join(directory, PID_FILE_NAME);
    fs.writeFileSync(pidPath, '12345\n');

    releasePidFile(pidPath);
    expect(fs.existsSync(pidPath)).toBe(true); // مال ما نبود

    fs.writeFileSync(pidPath, `${process.pid}\n`);
    releasePidFile(pidPath);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('پروسهٔ خودمان زنده تشخیص داده می‌شود', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

// ── serve، با سوکت واقعی ──────────────────────────────────────────

describeIfBuilt('MIG-54 / SE-SEC-03 — پذیرش serve --http', () => {
  let outputDir: string;
  let child: ChildProcess | null = null;
  let port = 0;
  let token = '';
  let serverUrl = '';

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-serve-'));
    runOnce(['index', '--root', FIXTURE, '--out', outputDir, '--no-git']);

    const started = await spawnUntil(
      [
        'serve',
        '--http',
        '--port',
        '0',
        '--index',
        path.join(outputDir, 'project-index.json'),
        '--token',
        'test-token-value',
      ],
      /MCP\s+http:\/\/[^\s]+/
    );
    child = started.child;

    serverUrl = /MCP\s+(http:\/\/[^\s?]+)/.exec(started.stderr)![1]!;
    port = Number(/http:\/\/[^:]+:(\d+)\/mcp/.exec(started.stderr)![1]);
    token = 'test-token-value';
  }, 180_000);

  afterAll(async () => {
    if (child) await stop(child);
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('بدون توکن، ۴۰۱ می‌دهد', async () => {
    expect((await request({ port })).status).toBe(401);
  });

  it('با توکن اشتباه، ۴۰۱ می‌دهد', async () => {
    expect((await request({ port, token: 'nope' })).status).toBe(401);
  });

  it('با توکن درست، دیگر ۴۰۱ نمی‌دهد', async () => {
    const reply = await request({ port, token, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(reply.status).not.toBe(401);
    expect(reply.status).toBeLessThan(500);
  });

  it('Origin بیگانه، ۴۰۳ می‌دهد', async () => {
    const reply = await request({ port, token, origin: 'https://evil.example.com' });
    expect(reply.status).toBe(403);
  });

  it('بدنهٔ غول‌آسا، ۴۱۳ می‌دهد', async () => {
    const reply = await request({ port, token, body: 'x'.repeat(8 * 1024 * 1024) });
    expect(reply.status).toBe(413);
  });

  it('روی loopback بسته می‌شود، نه روی همهٔ رابط‌ها', () => {
    /*
    | پذیرش فاز: «`curl` از یک IP دیگر به آن نرسد».
    |
    | چیزی که این‌جا سنجیده می‌شود، *آدرسی است که پروسه به آن bind
    | کرده* — نه اینکه یک بستهٔ TCP از بیرون می‌رسد یا نه. دلیلش را
    | همین sandbox نشان داد: جدول سوکت‌ها دو listener روی همان پورت
    | داشت،
    |
    |   LISTEN  169.254.0.21:39301   (بدون کاربر — پروکسی sandbox)
    |   LISTEN  127.0.0.1:39301      users:(("node",pid=11551))
    |
    | و پورتِ بی‌استفاده از همان IP رد می‌شد. یعنی لایهٔ port-forwarding
    | خودِ محیط هر پورتی را که ببیند آینه می‌کند. آن لایه روی ماشین
    | کاربر وجود ندارد و ربطی به این کد هم ندارد؛ چیزی که به این کد
    | مربوط است این است که خودش فقط loopback را می‌گیرد.
    */
    expect(serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(serverUrl).not.toContain('0.0.0.0');
  });

  it('روی loopback واقعاً جواب می‌دهد', async () => {
    expect((await request({ port, token })).status).not.toBe(0);
  });
});

describeIfBuilt('MIG-54 — نگهبان‌های خط فرمان serve', () => {
  it('bind غیرلوکال بدون --allow-remote رد می‌شود', () => {
    const result = runOnce(['serve', '--http', '--host', '0.0.0.0', '--index', '/nope.json']);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/refusing to bind/i);
  });

  it('پورت نامعتبر، خطای استفاده می‌دهد', () => {
    const result = runOnce(['serve', '--http', '--port', 'abc', '--index', '/nope.json']);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/--port/);
  });

  it('ایندکس ناموجود، خطای خوانا می‌دهد', () => {
    const result = runOnce(['serve', '--index', '/definitely/not/here.json']);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toMatch(/index not found/i);
    expect(result.stderr).not.toMatch(/at Object\.|at Module\./);
  });
});

// ── ui، بدون ایندکس قبلی (SE-UI-01) ───────────────────────────────

/** یک درخواست ساده GET که فقط status و بدنه را برمی‌گرداند. */
function get(port: number, urlPath: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: urlPath, timeout: 4000 },
      response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

describeIfBuilt('SE-UI-01 — دستور ui بدون ایندکس هم بالا می‌آید', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-ui-cli-'));
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('روی ورک‌اسپیس بدون ایندکس، سرور را بالا می‌آورد و «index not found» نمی‌دهد', async () => {
    // پورت ۰ = پورت آزاد از سیستم؛ ولی چون آدرس چاپ‌شده را می‌خوانیم،
    // یک پورت ثابت بالا انتخاب می‌کنیم که در تست کم‌برخورد باشد.
    const port = 4137;
    const started = await spawnUntil(
      ['ui', '--root', workspace, '--host', '127.0.0.1', '--port', String(port), '--token', 'test-token'],
      /Semantic Engine v\S+ · web UI/
    );

    try {
      expect(started.stderr).not.toMatch(/index not found/i);
      expect(started.stderr).toMatch(/open a project and run indexing from the UI/i);

      const health = await get(port, '/health');
      expect(health.status).toBe(200);

      const landing = await get(port, '/');
      expect(landing.status).toBe(200);
      expect(landing.body).toContain('Project location');
    } finally {
      await stop(started.child);
    }
  }, 60_000);
});

// ── watch، با پروسهٔ واقعی ────────────────────────────────────────

describeIfBuilt('MIG-52 — پذیرش watch', () => {
  let workspace: string;
  let dataDir: string;
  /**
   * artifactها از فاز ۴ در data directory نوشته می‌شوند، نه داخل workspace.
   * `--project-id` و `--data-dir` صریح داده می‌شوند تا مسیر در تست قطعی باشد.
   */
  const projectId = 'prj-watch-cli-00000000';
  let artifactRoot: string;
  const watchArgs = (extra: string[] = []) => [
    'watch',
    '--root',
    workspace,
    '--no-git',
    '--project-id',
    projectId,
    '--data-dir',
    dataDir,
    ...extra,
  ];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-watch-cli-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-watch-data-'));
    artifactRoot = path.join(dataDir, 'projects', projectId);
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('ایندکس می‌گیرد، رصد می‌کند، و روی SIGINT تمیز خاموش می‌شود', async () => {
    const started = await spawnUntil(watchArgs(), /press Ctrl\+C/);

    const pidPath = path.join(artifactRoot, PID_FILE_NAME);
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(Number(fs.readFileSync(pidPath, 'utf8').trim())).toBe(started.child.pid);

    // یک تغییر واقعی
    fs.writeFileSync(path.join(workspace, 'src', 'b.ts'), 'export const b = 2;\n');
    await new Promise(resolve => setTimeout(resolve, 2500));

    const code = await stop(started.child, 'SIGINT');
    expect(code).toBe(EXIT.ok);

    // فایل PID پاک شده است
    expect(fs.existsSync(pidPath)).toBe(false);

    const written = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, 'project-index.json'), 'utf8')
    ) as { files: { path: string }[] };
    expect(written.files.map(f => f.path)).toContain('src/b.ts');

    /* watch هیچ چیز داخل source root نمی‌نویسد. */
    expect(fs.existsSync(path.join(workspace, '.semantic-engine'))).toBe(false);
  }, 120_000);

  it('SIGTERM هم خاموشی تمیز می‌دهد', async () => {
    const started = await spawnUntil(watchArgs(), /press Ctrl\+C/);
    const code = await stop(started.child, 'SIGTERM');

    expect(code).toBe(EXIT.ok);
    expect(fs.existsSync(path.join(artifactRoot, PID_FILE_NAME))).toBe(false);
  }, 120_000);

  it('دو watcher هم‌زمان روی یک کارگاه راه نمی‌افتند', async () => {
    const started = await spawnUntil(watchArgs(), /press Ctrl\+C/);

    try {
      const second = runOnce(watchArgs());
      expect(second.code).toBe(EXIT.failure);
      expect(second.stderr).toMatch(/already running/i);
    } finally {
      await stop(started.child);
    }
  }, 120_000);
});
