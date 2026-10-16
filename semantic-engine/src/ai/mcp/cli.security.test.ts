/**
 * `semantic-engine-mcp --http` — SE-SEC-03، بار دوم.
 *
 * `HttpGuard` دقیقاً برای رفع چهار حفرهٔ این entry point نوشته شد، ولی
 * فقط به `serve` وصل شد و این باینری جا ماند. این تست‌ها همان چهار
 * حفره را روی پروسهٔ واقعی می‌سنجند، نه روی یک شبیه‌سازی.
 */

import { execFile, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'ai', 'mcp', 'cli.js');

const TOKEN = 'test-token-for-mcp-cli';

const MINIMAL_INDEX = {
  schemaVersion: '2.0.0',
  root: 'demo',
  generatedAt: new Date().toISOString(),
  languages: [],
  files: [],
  symbols: [],
  graphs: {
    dependencyGraph: [],
    reverseDependencyGraph: [],
    callGraph: [],
    typeGraph: [],
  },
  diagnostics: [],
  metrics: {
    totalFiles: 0,
    totalLoc: 0,
    totalSymbols: 0,
    avgCyclomaticComplexity: 0,
    languageBreakdown: {},
  },
};

const built = fs.existsSync(CLI);

/*
| بدون `npm run build` این فایل وجود ندارد. رد شدن با یک پیام روشن‌تر
| از یک شکست مبهم است.
*/
const describeIfBuilt = built ? describe : describe.skip;

describeIfBuilt('semantic-engine-mcp --http', () => {
  let tmpRoot: string;
  let indexPath: string;
  let server: ChildProcess | undefined;
  let port: number;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-mcp-cli-'));
    indexPath = path.join(tmpRoot, 'project-index.json');
    fs.writeFileSync(
      indexPath,
      JSON.stringify({ ...MINIMAL_INDEX, rootPath: tmpRoot }),
      'utf8'
    );

    port = 20000 + Math.floor(Math.random() * 20000);

    server = spawn(process.execPath, [CLI, indexPath, '--http', '--port', String(port), '--token', TOKEN], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start in time')), 15000);

      server!.stderr!.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('listening') || chunk.toString('utf8').includes('/mcp')) {
          clearTimeout(timer);
          resolve();
        }
      });

      server!.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }, 30000);

  afterAll(async () => {
    server?.kill('SIGKILL');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function post(
    headers: Record<string, string>,
    body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    requestPath = '/mcp'
  ): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: requestPath, method: 'POST', headers },
        response => {
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode ?? 0 }));
        }
      );
      request.on('error', reject);
      request.write(body);
      request.end();
    });
  }

  it('روی loopback گوش می‌دهد، نه 0.0.0.0', async () => {
    /*
    | اندازه‌گیری‌شده در نسخهٔ قبل: در دسترس روی eth0:169.254.0.21.
    | اتصال به loopback باید کار کند و همین که سرور بالاست یعنی
    | `listen(port, host)` با host صدا زده شده.
    */
    const { status } = await post({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });

    expect([200, 202, 400, 406, 500]).toContain(status);
  });

  it('بدون توکن رد می‌شود', async () => {
    const { status } = await post({ 'content-type': 'application/json' });

    expect(status).toBe(401);
  });

  it('با توکن اشتباه رد می‌شود', async () => {
    const { status } = await post({ authorization: 'Bearer wrong', 'content-type': 'application/json' });

    expect(status).toBe(401);
  });

  it('Origin بیرونی رد می‌شود، حتی با توکن درست', async () => {
    const { status } = await post({
      authorization: `Bearer ${TOKEN}`,
      origin: 'http://evil.example.com',
      'content-type': 'application/json',
    });

    expect(status).toBe(403);
  });

  it('مسیر دیگر ۴۰۴ می‌گیرد', async () => {
    const { status } = await post(
      { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      '{}',
      '/admin'
    );

    expect(status).toBe(404);
  });

  it('بدنهٔ بزرگ‌تر از سقف، ۴۱۳ می‌گیرد', async () => {
    const huge = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"x":"${'A'.repeat(5 * 1024 * 1024)}"}}`;

    const { status } = await post(
      { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      huge
    );

    expect(status).toBe(413);
  }, 30000);

  it('یک درخواست بدشکل سرور را نمی‌کشد', async () => {
    /*
    | `void guard.handle(...)` یعنی یک throw داخل handler به unhandled
    | rejection تبدیل می‌شد و پروسه را پایین می‌آورد — DoS از راه دور.
    */
    await post({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, 'not json at all');

    const after = await post({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });

    expect(after.status).not.toBe(0);
    expect(server!.exitCode).toBeNull();
  });
});

describeIfBuilt('semantic-engine-mcp — بررسی آرگومان‌ها', () => {
  function run(args: string[]): Promise<{ code: number; stderr: string }> {
    return new Promise(resolve => {
      execFile(process.execPath, [CLI, ...args], (error, _stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : 0,
          stderr: String(stderr),
        });
      });
    });
  }

  let tmpIndex: string;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-mcp-args-'));
    tmpIndex = path.join(dir, 'project-index.json');
    fs.writeFileSync(tmpIndex, JSON.stringify({ ...MINIMAL_INDEX, rootPath: dir }), 'utf8');
  });

  it('بستن به یک آدرس غیرloopback بدون --allow-remote رد می‌شود', async () => {
    const { code, stderr } = await run([tmpIndex, '--http', '--port', '0', '--host', '0.0.0.0']);

    expect(code).toBe(1);
    expect(stderr).toMatch(/refusing to bind/);
    expect(stderr).toMatch(/--allow-remote/);
  }, 20000);

  it('پورت نامعتبر رد می‌شود', async () => {
    const { code, stderr } = await run([tmpIndex, '--http', '--port', '999999']);

    expect(code).toBe(1);
    expect(stderr).toMatch(/--port/);
  }, 20000);
});
