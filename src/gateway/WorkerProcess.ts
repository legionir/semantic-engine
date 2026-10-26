/**
 * One worker process — فاز ۸.
 *
 * The only place that turns a validated `ProjectWorkerConfig` into a running
 * process. Three rules:
 *
 *   - **no shell.** `spawn(..., { shell: false })` with an argument vector from
 *     `workerArgv`, so no value can reach a shell interpretation;
 *   - **the token travels through the environment**, never the command line
 *     (فاز ۶);
 *   - **readiness is observed, not assumed**: `start()` resolves only after
 *     `/internal/ready` answers 200, or rejects after `startupTimeoutMs`.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { ProjectWorkerConfig } from './types';
import { workerArgv } from './workerArgv';
import { socketEndpoint, isNamedPipe } from '../server/socketEndpoint';
import { targetConnectOptions, WorkerTarget } from './workerTarget';

export type WorkerState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'crashed' | 'degraded';

export interface WorkerHealthSnapshot {
  readonly ok: boolean;
  readonly projectId: string;
  readonly pid?: number;
  readonly state?: string;
  readonly indexState?: string;
  readonly watcher?: string;
  readonly files?: number;
  readonly symbols?: number;
  readonly dependencies?: number;
  readonly vectorChunks?: number;
  readonly blueprint?: boolean;
  readonly memoryMb?: number;
  readonly queueSize?: number;
  readonly lastIndexedAt?: string;
  readonly lsp?: {
    readonly enabled: boolean;
    readonly run?: {
      readonly filesWithFindings: number;
      readonly filesSkippedByBudget: number;
      readonly budgetMs: number;
      readonly completedAt?: string;
    };
  };
}

export type WorkerEventKind =
  | 'spawned'
  | 'ready'
  | 'exit'
  | 'crash'
  | 'restart'
  | 'degraded'
  | 'stopped';

export interface WorkerEvent {
  readonly kind: WorkerEventKind;
  readonly projectId: string;
  readonly at: string;
  readonly detail?: string;
  readonly exitCode?: number | null;
  readonly restartCount?: number;
}

export interface WorkerProcessOptions {
  readonly config: ProjectWorkerConfig;
  readonly socketPath: string;
  /*
  | F-0007 — وقتی transport واقعاً `loopback` است، worker روی یک پورتِ
  | رزروشدهٔ supervisor گوش می‌دهد و `socketPath` بی‌مصرف می‌ماند.
  | دادهٔ اختیاری است تا صدها فراخوانِ موجود (و تست‌ها) دست‌نخورده
  | کار کنند: نبودنش یعنی همان رفتارِ سوکت.
  */
  readonly target?: WorkerTarget;
  readonly token: string;
  readonly logFile?: string;
  /** مسیر باینری CLI؛ پیش‌فرض `bin/semantic-engine.js` کنار dist. */
  readonly binary?: string;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly shutdownGraceMs?: number;
  readonly killAfterMs?: number;
  readonly now?: () => Date;
  readonly onEvent?: (event: WorkerEvent) => void;
}

export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
export const DEFAULT_KILL_AFTER_MS = 5_000;

export function defaultBinaryPath(): string {
  return path.resolve(__dirname, '..', '..', 'bin', 'semantic-engine.js');
}

export class WorkerProcess {
  private child: ChildProcess | null = null;
  private stateValue: WorkerState = 'stopped';
  private exitCodeValue: number | null = null;
  private logFd: number | null = null;

  constructor(private readonly options: WorkerProcessOptions) {}

  get projectId(): string {
    return this.options.config.projectId;
  }

  get state(): WorkerState {
    return this.stateValue;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  /** چیزی که worker روی آن گوش می‌دهد — F-0007. */
  get target(): WorkerTarget {
    return this.options.target ?? { transport: 'socket', socketPath: this.options.socketPath };
  }

  get logFile(): string | undefined {
    return this.options.logFile;
  }

  /** آرگومان‌هایی که واقعاً اجرا می‌شوند — برای لاگ و تست. */
  argv(): readonly string[] {
    if (this.options.argv) return this.options.argv;

    const target = this.target;
    if (target.transport === 'loopback') {
      // `workerArgv` خودش `--host/--port` را می‌فرستد و `--socket` را نمی‌زند
      const config: ProjectWorkerConfig = {
        ...this.options.config,
        service: {
          ...this.options.config.service,
          transport: 'loopback',
          host: target.host,
          port: target.port,
        },
      };
      return ['worker', ...workerArgv(config)];
    }

    return ['worker', ...workerArgv(this.options.config), '--socket', this.options.socketPath];
  }

  private emit(kind: WorkerEventKind, detail?: string, extra?: Partial<WorkerEvent>): void {
    const now = this.options.now ?? (() => new Date());
    this.options.onEvent?.({
      kind,
      projectId: this.projectId,
      at: now().toISOString(),
      ...(detail !== undefined ? { detail } : {}),
      ...extra,
    });
  }

  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;

    const binary = this.options.binary ?? defaultBinaryPath();
    const env: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      /* توکن از محیط می‌رود، نه از خط فرمان (فاز ۶). */
      SEMANTIC_ENGINE_WORKER_TOKEN: this.options.token,
    };

    /*
    | لاگ با fd باز می‌شود، نه با WriteStream: یک stream هنوز باز‌نشده به
    | `spawn` داده نمی‌شود (`ERR_INVALID_ARG_VALUE`) و اگر هم داده شود،
    | باز شدنش async است و خطایش دیر و بی‌صاحب بیرون می‌زند.
    */
    let stdio: ('ignore' | 'pipe' | number)[] = ['ignore', 'pipe', 'pipe'];
    if (this.options.logFile) {
      fs.mkdirSync(path.dirname(this.options.logFile), { recursive: true });
      this.logFd = fs.openSync(this.options.logFile, 'a');
      stdio = ['ignore', this.logFd, this.logFd];
    }

    this.exitCodeValue = null;
    this.stateValue = 'starting';

    /*
    | یک فایل socket باقی‌مانده از crash قبلی یعنی `EADDRINUSE`. این فایل مال
    | ماست (مسیرش را supervisor می‌سازد)، پس پیش از spawn برداشته می‌شود.
    | لولهٔ نام‌دار ویندوز فایلی نیست که بماند؛ نشانش هم نبودِ worker است،
    | پس این پاک‌سازی مخصوص UDS است.
    */
    if (this.target.transport === 'socket' && !isNamedPipe(socketEndpoint(this.options.socketPath))) {
      try {
        fs.rmSync(this.options.socketPath, { force: true });
      } catch {
        /* نبود فایل یعنی کاری نیست. */
      }
    }

    const child = spawn(process.execPath, [binary, ...this.argv()], {
      cwd: process.cwd(),
      env,
      stdio,
      shell: false,
    });
    this.child = child;
    this.emit('spawned', `pid ${child.pid ?? '?'}`);

    child.once('exit', (code, signal) => {
      this.closeLog();
      this.exitCodeValue = code;
      const wasRunning = this.stateValue === 'ready' || this.stateValue === 'starting';
      this.stateValue = this.stateValue === 'stopping' ? 'stopped' : 'crashed';
      this.emit(
        this.stateValue === 'stopped' ? 'stopped' : 'crash',
        `exit code ${code ?? 'null'} signal ${signal ?? 'none'}`,
        { exitCode: code }
      );
      if (!wasRunning) return;
    });

    if (!this.options.logFile) {
      /* وقتی لاگ فایل نداریم، خروجی کودک باید جایی برود تا pipe پر نشود. */
      child.stdout?.resume();
      child.stderr?.resume();
    }

    await this.waitForReady();
  }

  private async waitForReady(): Promise<void> {
    const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const pollIntervalMs = this.options.pollIntervalMs ?? 200;
    const deadline = Date.now() + timeoutMs;
    let lastError = 'not reachable yet';

    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) {
        this.stateValue = 'crashed';
        throw new Error(
          `worker ${this.projectId} exited with code ${this.child.exitCode} before becoming ready`
        );
      }

      try {
        const reply = await this.request('GET', '/internal/ready');
        if (reply.status === 200) {
          this.stateValue = 'ready';
          this.emit('ready');
          return;
        }
        lastError = `readiness answered ${reply.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    this.stateValue = 'crashed';
    throw new Error(`worker ${this.projectId} did not become ready in ${timeoutMs}ms: ${lastError}`);
  }

  /** یک درخواست به worker؛ روی Unix socket. */
  request(
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          ...targetConnectOptions(this.target),
          path: urlPath,
          method,
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            'X-Forwarded-For': '127.0.0.1',
            'X-Forwarded-Proto': 'http',
            ...(payload !== undefined
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': String(Buffer.byteLength(payload)),
                }
              : {}),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: Record<string, unknown> = {};
            try {
              json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
            } catch {
              json = { raw: text };
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        }
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async health(): Promise<WorkerHealthSnapshot | null> {
    if (!this.child || this.child.exitCode !== null) return null;
    try {
      const reply = await this.request('GET', '/internal/health');
      if (reply.status !== 200 && reply.status !== 503) return null;
      return reply.json as unknown as WorkerHealthSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * خاموشی graceful: اول `POST /internal/shutdown`، بعد SIGTERM، در نهایت
   * SIGKILL. هیچ‌کدام نباید تا ابد طول بکشد.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.stateValue = 'stopped';
      this.closeLog();
      return;
    }

    this.stateValue = 'stopping';

    const exited = new Promise<void>(resolve => {
      child.once('exit', () => resolve());
    });

    try {
      await this.request('POST', '/internal/shutdown');
    } catch {
      /* worker ممکن است از قبل در حال مردن باشد. */
    }

    const graceMs = this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    const finished = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), graceMs)),
    ]);

    if (!finished) {
      child.kill('SIGTERM');
      const killed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>(resolve =>
          setTimeout(() => resolve(false), this.options.killAfterMs ?? DEFAULT_KILL_AFTER_MS)
        ),
      ]);
      if (!killed) child.kill('SIGKILL');
      await Promise.race([
        exited,
        new Promise<void>(resolve => setTimeout(resolve, 1000)),
      ]);
    }

    this.stateValue = 'stopped';
    this.emit('stopped');
    this.closeLog();
  }

  private closeLog(): void {
    if (this.logFd !== null) {
      try {
        fs.closeSync(this.logFd);
      } catch {
        /* بسته بودن fd خطا نیست. */
      }
      this.logFd = null;
    }
  }
}
