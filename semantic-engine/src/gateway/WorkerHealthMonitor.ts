/**
 * Crash detection and restart policy — فاز ۸.
 *
 * A worker that dies must not take the Gateway down, and a worker that dies in
 * a loop must not be restarted forever. The policy is the one the plan fixed:
 *
 * ```text
 * restart 1 → 1s
 * restart 2 → 3s
 * restart 3 → 10s
 * more than 5 crashes → degraded, and a human has to intervene
 * ```
 *
 * The monitor decides; the supervisor acts. `check()` is called by the
 * supervisor's interval, and it is also callable directly, which is how the
 * tests drive five crashes without waiting five real intervals.
 */

import { WorkerEvent, WorkerHealthSnapshot, WorkerProcess } from './WorkerProcess';

export interface RestartPolicy {
  /** تأخیر هر restart؛ از آخرین مقدار به بعد ثابت می‌ماند. */
  readonly delaysMs: readonly number[];
  /** بیش از این تعداد crash پشت‌سرهم → `degraded`. */
  readonly maxRestarts: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  delaysMs: [1_000, 3_000, 10_000],
  maxRestarts: 5,
};

export type HealthCheckAction = 'none' | 'restart' | 'degraded';

export interface HealthCheckResult {
  readonly projectId: string;
  readonly action: HealthCheckAction;
  readonly healthy: boolean;
  readonly restartCount: number;
  readonly reason: string;
}

export interface WorkerHealthMonitorOptions {
  readonly policy?: RestartPolicy;
  /**
   * چه مدت سلامتِ پیوسته لازم است تا شمارندهٔ crash صفر شود. بدون این،
   * یک worker که یک بار crash کرده برای همیشه با آن یک crash زندگی می‌کند؛
   * و بدون فاصلهٔ زمانی، یک crash loop هرگز به حد نمی‌رسد.
   */
  readonly healthyResetMs?: number;
  readonly now?: () => Date;
  readonly onEvent?: (event: WorkerEvent) => void;
  /**
   * اجرای خودِ restart. مانیتور تصمیم می‌گیرد، supervisor انجام می‌دهد —
   * وگرنه دو جا هم‌زمان پروسه می‌ساختند.
   */
  readonly restart: (projectId: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_HEALTHY_RESET_MS = 60_000;

interface RestartState {
  crashes: number;
  degraded: boolean;
  lastCrashAt: number;
  /*
  | SE-F-058: the last snapshot the periodic health check collected. The
  | gateway answers `/projects` synchronously; without a cache it had
  | nothing real to report and printed fabricated zeros. The health loop
  | (`startHealthLoop` → `checkAll` → `check`) already fetches this exact
  | snapshot on every cycle — storing it here makes the true counts
  | available where the list payload is built, with no extra requests.
  */
  lastSnapshot?: WorkerHealthSnapshot;
  /** SE-F-058 — زمان برداشت snapshot (برای اعلام staleness). */
  lastSnapshotAt?: number;
}

export class WorkerHealthMonitor {
  private readonly states = new Map<string, RestartState>();
  private readonly policy: RestartPolicy;

  constructor(private readonly options: WorkerHealthMonitorOptions) {
    this.policy = options.policy ?? DEFAULT_RESTART_POLICY;
  }

  /**
   * شروع *تازه* = شمارنده صفر. restart صدا نمی‌زند، وگرنه حدِ crash loop
   * هرگز reachable نیست: هر restart شمارنده را صفر می‌کرد و worker تا ابد
   * دوباره بالا می‌آمد.
   */
  track(projectId: string): void {
    this.states.set(projectId, { crashes: 0, degraded: false, lastCrashAt: 0 });
  }

  untrack(projectId: string): void {
    this.states.delete(projectId);
  }

  restartCount(projectId: string): number {
    return this.states.get(projectId)?.crashes ?? 0;
  }

  isDegraded(projectId: string): boolean {
    return this.states.get(projectId)?.degraded ?? false;
  }

  /** SE-F-058 — آخرین snapshot جمع‌آوری‌شده توسط حلقهٔ سلامت (یا undefined). */
  lastSnapshot(projectId: string): WorkerHealthSnapshot | undefined {
    return this.states.get(projectId)?.lastSnapshot;
  }

  /** SE-F-058 — زمان برداشت آخرین snapshot (ms epoch؛ undefined اگر هیچ). */
  lastSnapshotAt(projectId: string): number | undefined {
    const state = this.states.get(projectId);
    return state?.lastSnapshot ? state.lastSnapshotAt : undefined;
  }

  /** SE-F-058 — ثبت snapshot گرفته‌شده بیرون از حلقه (مثلاً درخواست list). */
  recordSnapshot(projectId: string, snapshot: WorkerHealthSnapshot | undefined): void {
    const state = this.states.get(projectId);
    if (!state) return;
    state.lastSnapshot = snapshot;
    state.lastSnapshotAt = (this.options.now ?? (() => new Date()))().getTime();
  }

  delayFor(restartNumber: number): number {
    const delays = this.policy.delaysMs;
    if (delays.length === 0) return 0;
    const index = Math.min(Math.max(restartNumber - 1, 0), delays.length - 1);
    return delays[index] ?? 0;
  }

  private emit(kind: WorkerEvent['kind'], projectId: string, detail: string, extra?: Partial<WorkerEvent>): void {
    const now = this.options.now ?? (() => new Date());
    this.options.onEvent?.({ kind, projectId, at: now().toISOString(), detail, ...extra });
  }

  async check(worker: WorkerProcess): Promise<HealthCheckResult> {
    const projectId = worker.projectId;
    const state = this.states.get(projectId) ?? { crashes: 0, degraded: false, lastCrashAt: 0 };
    this.states.set(projectId, state);

    if (state.degraded) {
      state.lastSnapshot = undefined;
      return {
        projectId,
        action: 'none',
        healthy: false,
        restartCount: state.crashes,
        reason: 'degraded: restart limit reached, waiting for an operator',
      };
    }

    /*
    | دو نشانهٔ خرابی: پروسه مرده است، یا زنده است ولی به health جواب
    | نمی‌دهد. دومی مهم‌تر است — یک worker قفل‌شده هیچ exit‌ای ندارد.
    */
    const alive = worker.pid !== null && worker.exitCode === null;
    const snapshot = alive ? await worker.health() : null;
    const healthy = alive && snapshot !== null;

    if (healthy) {
      const now = this.options.now ?? (() => new Date());
      const healthyResetMs = this.options.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS;
      if (state.crashes !== 0 && now().getTime() - state.lastCrashAt >= healthyResetMs) {
        state.crashes = 0;
      }
      state.lastSnapshot = snapshot ?? undefined;
      state.lastSnapshotAt = now().getTime();
      return {
        projectId,
        action: 'none',
        healthy: true,
        restartCount: state.crashes,
        reason: 'healthy',
      };
    }

    /*
    | SE-F-058: a worker that stopped answering is not healthy — the
    | snapshot behind it is stale, and a stale count shown as current is
    | exactly the "old cache read as fresh" failure. Drop it so consumers
    | see `available: false` instead of last-known numbers.
    */
    state.lastSnapshot = undefined;
    state.crashes += 1;
    state.lastCrashAt = (this.options.now ?? (() => new Date()))().getTime();

    if (state.crashes > this.policy.maxRestarts) {
      state.degraded = true;
      this.emit('degraded', projectId, `${state.crashes} crashes; giving up`, {
        restartCount: state.crashes,
      });
      return {
        projectId,
        action: 'degraded',
        healthy: false,
        restartCount: state.crashes,
        reason: `${state.crashes} crashes in a row; marked degraded`,
      };
    }

    const delayMs = this.delayFor(state.crashes);
    this.emit('restart', projectId, `crash ${state.crashes}; restarting in ${delayMs}ms`, {
      restartCount: state.crashes,
    });

    await (this.options.sleep ?? defaultSleep)(delayMs);

    try {
      await this.options.restart(projectId);
    } catch (error) {
      /*
      | شکستِ خودِ restart هم یک crash حساب می‌شود؛ وگرنه یک worker که
      | بالا نمی‌آید تا ابد در حلقهٔ «restart ناموفق بدون شمارش» می‌ماند.
      */
      this.emit(
        'crash',
        projectId,
        `restart failed: ${error instanceof Error ? error.message : String(error)}`,
        { restartCount: state.crashes }
      );
    }

    return {
      projectId,
      action: 'restart',
      healthy: false,
      restartCount: state.crashes,
      reason: `restarted after ${delayMs}ms`,
    };
  }
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}
