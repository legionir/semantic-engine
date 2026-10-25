/**
 * Worker supervisor — فاز ۸.
 *
 * Owns the set of running workers: who may start, where their socket and log
 * live, how many may run at once, and what happens when one dies.
 *
 * Concurrency is decided in two places, deliberately:
 *
 *   - an in-process map, so two `start()` calls in the same Gateway share one
 *     promise instead of spawning twice;
 *   - a `worker.lock` file (فاز ۸, گام ۳), so a *second Gateway* or a hand-run
 *     worker cannot join the same project either.
 *
 * Capacity is refused loudly rather than queued silently: `CapacityError` is
 * what the Gateway turns into 503/429 in فاز ۹.
 */

import * as path from 'path';
import { generateToken } from '../cli/HttpGuard';
import { validateWorkerConfig } from './WorkerConfigSchema';
import { ProjectWorkerConfig } from './types';
import {
  WorkerEvent,
  WorkerHealthSnapshot,
  WorkerProcess,
  WorkerProcessOptions,
  WorkerState,
  defaultBinaryPath,
} from './WorkerProcess';
import {
  DEFAULT_RESTART_POLICY,
  HealthCheckResult,
  RestartPolicy,
  WorkerHealthMonitor,
} from './WorkerHealthMonitor';
import { acquireLock, LockInfo, WORKER_LOCK_FILE } from './ProjectLock';
import { allocateLoopbackPort, normalizeTransport, WorkerTarget } from './workerTarget';

export const DEFAULT_MAX_WORKERS = 8;
export const DEFAULT_MAX_CONCURRENT_INDEX_JOBS = 2;
export const DEFAULT_HEALTH_INTERVAL_MS = 10_000;

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

export class LockHeldError extends Error {
  readonly holder: LockInfo | null;
  constructor(projectId: string, holder: LockInfo | null) {
    super(
      holder
        ? `project ${projectId} is already served by pid ${holder.pid}`
        : `project ${projectId} is locked by another process`
    );
    this.name = 'LockHeldError';
    this.holder = holder;
  }
}

export class WorkerStartError extends Error {
  constructor(projectId: string, message: string) {
    super(`worker ${projectId} did not start: ${message}`);
    this.name = 'WorkerStartError';
  }
}

export interface WorkerDiagnostics {
  readonly lastError?: string;
  readonly restartHistory: readonly { at: string; reason: string }[];
}

export interface WorkerSummary {
  readonly projectId: string;
  readonly name: string;
  readonly rootPath: string;
  readonly state: WorkerState;
  readonly pid: number | null;
  readonly socketPath: string;
  /** F-0007 — چیزی که worker واقعاً روی آن گوش می‌دهد. */
  readonly target: WorkerTarget;
  readonly restartCount: number;
  readonly degraded: boolean;
  readonly health?: WorkerHealthSnapshot;
  /*
  | SE-F-058 — آخرین snapshot که حلقهٔ periodic health جمع کرده. بر خلاف
  | `health` (که در این مسیر هرگز مقدار نمی‌گیرد)، این واقعاً پر می‌شود.
  */
  readonly lastHealthSnapshot?: WorkerHealthSnapshot;
}

export interface WorkerSupervisorOptions {
  readonly dataRoot: string;
  readonly binary?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxWorkers?: number;
  readonly maxConcurrentIndexJobs?: number;
  readonly workerStartupTimeoutMs?: number;
  readonly workerHealthIntervalMs?: number;
  readonly workerIdleTimeoutMs?: number;
  readonly maxProjectArtifactBytes?: number;
  readonly maxGatewayMemoryMb?: number;
  readonly restartPolicy?: RestartPolicy;
  readonly pollIntervalMs?: number;
  readonly shutdownGraceMs?: number;
  readonly killAfterMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onEvent?: (event: WorkerEvent) => void;
}

interface RunningWorker {
  readonly config: ProjectWorkerConfig;
  readonly process: WorkerProcess;
  readonly releaseLock: () => void;
  readonly token: string;
}

export class WorkerSupervisor {
  private readonly workers = new Map<string, RunningWorker>();
  private readonly starting = new Map<string, Promise<WorkerProcess>>();
  private readonly monitor: WorkerHealthMonitor;
  private healthTimer: NodeJS.Timeout | null = null;
  private activeIndexJobs = 0;
  /** آخرین خطا و تاریخچهٔ restart هر پروژه — برای health detail در UI. */
  private readonly diagnosticsByProject = new Map<
    string,
    { lastError?: string; restartHistory: { at: string; reason: string }[] }
  >();

  constructor(private readonly options: WorkerSupervisorOptions) {
    const forward = options.onEvent;
    this.monitor = new WorkerHealthMonitor({
      policy: options.restartPolicy ?? DEFAULT_RESTART_POLICY,
      ...(options.now ? { now: options.now } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      /* رویدادها هم به بیرون می‌روند هم در تاریخچهٔ خود پروژه می‌نشینند. */
      onEvent: event => {
        this.recordEvent(event);
        forward?.(event);
      },
      restart: async projectId => {
        await this.restart(projectId);
      },
    });
  }

  private recordEvent(event: WorkerEvent): void {
    if (event.kind !== 'crash' && event.kind !== 'restart' && event.kind !== 'degraded') return;

    const entry = this.diagnosticsByProject.get(event.projectId) ?? { restartHistory: [] };
    const reason = event.detail ?? event.kind;
    entry.restartHistory = [...entry.restartHistory, { at: event.at, reason }].slice(-20);
    if (event.kind !== 'restart') entry.lastError = reason;
    this.diagnosticsByProject.set(event.projectId, entry);
  }

  diagnostics(projectId: string): WorkerDiagnostics {
    const entry = this.diagnosticsByProject.get(projectId);
    return {
      ...(entry?.lastError !== undefined ? { lastError: entry.lastError } : {}),
      restartHistory: entry?.restartHistory ?? [],
    };
  }

  /** تعداد jobهای ایندکس در حال اجرا — برای `gateway_index_jobs_active`. */
  get activeIndexJobsCount(): number {
    return this.activeIndexJobs;
  }

  get maxWorkers(): number {
    return this.options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  }

  get maxConcurrentIndexJobs(): number {
    return this.options.maxConcurrentIndexJobs ?? DEFAULT_MAX_CONCURRENT_INDEX_JOBS;
  }

  socketPathFor(projectId: string): string {
    /*
    | F-0001 — روی Windows یک «socket path» فقط به شکلِ لولهٔ نام‌دار
    | پذیرفته می‌شود؛ `…/sockets/<id>.sock` آن‌جا یک فایل است و `listen`
    | می‌افتد، پس کل gateway روی ویندوز بی‌کارکرد بود و سه suite‌اش تا
    | timeout جلو می‌رفتند.
    |
    | فقط نشانی عوض می‌شود: `net.connect(path)` و
    | `http.request({ socketPath })` هر دو لولهٔ نام‌دار را دقیقاً مثل UDS
    | کار می‌دهند، پس نه قراردادِ worker و نه proxy نیاز به شاخهٔ تازه ندارد.
    */
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\semantic-engine-${projectId}`;
    }
    return path.join(this.options.dataRoot, 'gateway', 'sockets', `${projectId}.sock`);
  }

  logFileFor(projectId: string): string {
    return path.join(this.options.dataRoot, 'gateway', 'logs', `${projectId}.log`);
  }

  private lockPathFor(projectId: string): string {
    return path.join(this.options.dataRoot, 'projects', projectId, 'locks', WORKER_LOCK_FILE);
  }

  list(): WorkerSummary[] {
    return [...this.workers.values()].map(entry => this.summarize(entry));
  }

  get(projectId: string): WorkerProcess | undefined {
    return this.workers.get(projectId)?.process;
  }

  /**
   * توکن داخلی یک worker. فقط Gateway آن را می‌گیرد تا در هدر
   * `Authorization` پروکسی بگذارد؛ هرگز به کلاینت داده نمی‌شود.
   */
  workerToken(projectId: string): string | undefined {
    return this.workers.get(projectId)?.token;
  }

  isRunning(projectId: string): boolean {
    const entry = this.workers.get(projectId);
    return Boolean(entry && entry.process.pid !== null && entry.process.exitCode === null);
  }

  restartCount(projectId: string): number {
    return this.monitor.restartCount(projectId);
  }

  isDegraded(projectId: string): boolean {
    return this.monitor.isDegraded(projectId);
  }

  private summarize(entry: RunningWorker): WorkerSummary {
    return {
      projectId: entry.config.projectId,
      name: entry.config.name,
      rootPath: entry.config.rootPath,
      state: entry.process.state,
      pid: entry.process.pid,
      socketPath: entry.process.socketPath,
      target: entry.process.target,
      restartCount: this.monitor.restartCount(entry.config.projectId),
      degraded: this.monitor.isDegraded(entry.config.projectId),
      lastHealthSnapshot: this.monitor.lastSnapshot(entry.config.projectId),
    };
  }

  /**
   * بالا آوردن یک worker. هم‌زمان (idempotent) برای یک projectId: دو
   * فراخوانی موازی یک پروسه می‌سازند، نه دو تا.
   */
  async start(config: ProjectWorkerConfig): Promise<WorkerProcess> {
    const validation = validateWorkerConfig(config as never, { checkFileSystem: false });
    if (!validation.ok) {
      throw new WorkerStartError(config.projectId, validation.errors.join('; '));
    }
    const projectId = validation.config.projectId;

    const existing = this.workers.get(projectId);
    if (existing && existing.process.exitCode === null) return existing.process;

    const inFlight = this.starting.get(projectId);
    if (inFlight) return inFlight;

    if (this.workers.size >= this.maxWorkers && !this.workers.has(projectId)) {
      throw new CapacityError(
        `cannot start ${projectId}: ${this.workers.size} of ${this.maxWorkers} workers are already running`
      );
    }

    const promise = this.spawn(config, true).finally(() => {
      this.starting.delete(projectId);
    });
    this.starting.set(projectId, promise);
    return promise;
  }

  private async spawn(config: ProjectWorkerConfig, fresh: boolean): Promise<WorkerProcess> {
    const projectId = config.projectId;
    const socketPath = this.socketPathFor(projectId);

    /*
    | F-0007 — transport واقعاً خوانده می‌شود. `loopback` یعنی supervisor
    | یک پورتِ آزادِ loopback رزرو می‌کند و همان شماره را به worker
    | می‌دهد؛ worker روی آن listen می‌کند و gateway همان‌جا وصل می‌شود.
    | (پیش از این این شاخه وجود نداشت و هر پیکربندیِ loopback بی‌صدا روی
    | سوکت می‌افتاد.)
    */
    const service = config.service;
    const target: WorkerTarget = normalizeTransport(service.transport) === 'loopback'
      ? { transport: 'loopback', host: service.host ?? '127.0.0.1', port: service.port ?? await allocateLoopbackPort(service.host ?? '127.0.0.1') }
      : { transport: 'socket', socketPath };

    const lock = acquireLock(this.lockPathFor(projectId), projectId, 'worker', {
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    if (!lock.ok) {
      if (lock.reason === 'held') throw new LockHeldError(projectId, lock.holder);
      throw new WorkerStartError(projectId, `cannot take the worker lock (${lock.reason})`);
    }

    const token = generateToken();
    /*
    | data root از راه محیط به worker می‌رسد. پیش از این worker هیچ
    | `--data-dir` نمی‌گرفت و `projectPathsFromArgs` او را به data root
    | پیش‌فرض پلتفرم می‌فرستاد — یعنی artifactهای پروژه‌ای که Gateway
    | مدیریت می‌کرد جای دیگری نوشته می‌شد، نه کنار socket و lock و لاگش.
    | اندازه‌گیری‌شده: manifest پروژه‌ها در `~/.local/share/…` ظاهر می‌شد
    | در حالی که socket زیر `<dataRoot>/gateway/sockets/` بود.
    */
    const childEnv: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      SEMANTIC_ENGINE_DATA_DIR: this.options.dataRoot,
      /* worker خودش نمی‌داند چند بار بالا آمده؛ supervisor می‌داند. */
      SEMANTIC_ENGINE_WORKER_RESTART_COUNT: String(this.monitor.restartCount(projectId)),
    };

    const forward = this.options.onEvent;
    const processOptions: WorkerProcessOptions = {
      config,
      socketPath,
      target,
      token,
      logFile: this.logFileFor(projectId),
      binary: this.options.binary ?? defaultBinaryPath(),
      env: childEnv,
      /*
      | رویدادهای خودِ پروسه (crash/exit) هم در تاریخچهٔ پروژه می‌نشینند،
      | وگرنه «آخرین خطا» فقط از رویدادهای مانیتور پر می‌شد و crash واقعی
      | دیده نمی‌شد.
      */
      onEvent: event => {
        this.recordEvent(event);
        forward?.(event);
      },
      ...(this.options.workerStartupTimeoutMs
        ? { startupTimeoutMs: this.options.workerStartupTimeoutMs }
        : {}),
      ...(this.options.pollIntervalMs ? { pollIntervalMs: this.options.pollIntervalMs } : {}),
      ...(this.options.shutdownGraceMs ? { shutdownGraceMs: this.options.shutdownGraceMs } : {}),
      ...(this.options.killAfterMs ? { killAfterMs: this.options.killAfterMs } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
    };

    const worker = new WorkerProcess(processOptions);

    try {
      await worker.start();
    } catch (error) {
      lock.release();
      await worker.stop().catch(() => undefined);
      throw new WorkerStartError(
        projectId,
        error instanceof Error ? error.message : String(error)
      );
    }

    /* lock را نگه می‌داریم و heartbeat می‌دهیم تا پروسهٔ زندهٔ ما را
       «رها شده» نبیند. */
    const heartbeat = setInterval(() => lock.heartbeat(), 10_000);
    heartbeat.unref?.();

    this.workers.set(projectId, {
      config,
      process: worker,
      token,
      releaseLock: () => {
        clearInterval(heartbeat);
        lock.release();
      },
    });
    /* فقط شروع تازه شمارندهٔ crash را صفر می‌کند؛ restart نه. */
    if (fresh) this.monitor.track(projectId);

    return worker;
  }

  async stop(projectId: string): Promise<boolean> {
    const entry = this.workers.get(projectId);
    if (!entry) return false;

    await entry.process.stop();
    entry.releaseLock();
    this.workers.delete(projectId);
    this.monitor.untrack(projectId);
    return true;
  }

  async restart(projectId: string): Promise<WorkerProcess> {
    const entry = this.workers.get(projectId);
    if (!entry) throw new WorkerStartError(projectId, 'not running');

    const config = entry.config;
    await entry.process.stop();
    entry.releaseLock();
    this.workers.delete(projectId);

    return this.spawn(config, false);
  }

  /**
   * reindex با سقف هم‌زمانی. `CapacityError` همان چیزی است که Gateway به
   * ۴۲۹ ترجمه می‌کند.
   */
  async reindex(projectId: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const entry = this.workers.get(projectId);
    if (!entry) throw new WorkerStartError(projectId, 'not running');

    if (this.activeIndexJobs >= this.maxConcurrentIndexJobs) {
      throw new CapacityError(
        `${this.activeIndexJobs} of ${this.maxConcurrentIndexJobs} index jobs are already running`
      );
    }

    this.activeIndexJobs += 1;
    try {
      const reply = await entry.process.request('POST', '/internal/reindex');
      return { status: reply.status, json: reply.json };
    } finally {
      this.activeIndexJobs -= 1;
    }
  }

  async health(projectId: string): Promise<WorkerHealthSnapshot | null> {
    const entry = this.workers.get(projectId);
    return entry ? entry.process.health() : null;
  }

  /**
   * SE-F-058 — آمار واقعی را تازه کن و در حافظهٔ monitor بنشان، تا
   * `projectEntry` (که synchronous است) عدد ساختگی لازم نسازد. اگر
   * worker نبود یا جواب نداد، snapshot پاک می‌شود: نبودِ داده با دادهٔ
   * صفر اشتباه گرفته نشود.
   */
  async refreshStats(projectId: string): Promise<WorkerHealthSnapshot | undefined> {
    const entry = this.workers.get(projectId);
    if (!entry) {
      this.monitor.recordSnapshot(projectId, undefined);
      return undefined;
    }
    const snapshot = await entry.process.health();
    this.monitor.recordSnapshot(projectId, snapshot ?? undefined);
    return snapshot ?? undefined;
  }

  /** SE-F-058 — زمان برداشت آخرین آمار (برای staleness در payload). */
  lastStatsObservedAt(projectId: string): number | undefined {
    return this.monitor.lastSnapshotAt(projectId);
  }

  /** SE-F-058 — ثبت snapshot گرفته‌شده در مسیر دیگر (health detail). */
  recordStats(projectId: string, snapshot: WorkerHealthSnapshot | undefined): void {
    this.monitor.recordSnapshot(projectId, snapshot);
  }

  /** یک دور بررسی سلامت؛ هم تایمر صدا می‌زند هم تست. */
  async checkAll(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    for (const entry of [...this.workers.values()]) {
      results.push(await this.monitor.check(entry.process));
    }
    return results;
  }

  startHealthLoop(): void {
    if (this.healthTimer) return;
    const intervalMs = this.options.workerHealthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.healthTimer = setInterval(() => {
      void this.checkAll();
    }, intervalMs);
    this.healthTimer.unref?.();
  }

  stopHealthLoop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** خاموشی کل Gateway: همهٔ workerها و همهٔ lockها. */
  async stopAll(): Promise<void> {
    this.stopHealthLoop();
    const entries = [...this.workers.values()];
    await Promise.all(
      entries.map(async entry => {
        await entry.process.stop().catch(() => undefined);
        entry.releaseLock();
      })
    );
    this.workers.clear();
  }
}
