/**
 * JobManager — Background asynchronous task queue and progress tracker.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationTokenSource } from '../host/Cancellation';
import { SseManager } from '../server/SseManager';

export interface JobRecord<TResult = unknown> {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly phase: string;
  readonly progress: number; // 0 - 100
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly result?: TResult;
  readonly data?: unknown;
  readonly tokenSource: CancellationTokenSource;
}

interface PersistedJob {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly status: JobRecord['status'];
  readonly phase: string;
  readonly progress: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly result?: unknown;
  readonly data?: unknown;
}

export class JobManager extends EventEmitter {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly activeProjects = new Set<string>();
  private readonly maxKeptJobs = 100;
  private readonly maxConcurrentJobs = 4;
  private readonly recoveries = new Map<string, (job: JobRecord) => Promise<void>>();

  constructor(
    private readonly sseManager?: SseManager,
    private readonly stateFile?: string
  ) {
    super();
    this.restore();
  }

  /**
   * ایجاد و شروع یک Background Job.
   */
  startJob<TResult>(
    projectId: string,
    type: string,
    runner: (
      token: CancellationTokenSource['token'],
      updateProgress: (phase: string, progress: number, data?: unknown) => void
    ) => Promise<TResult>,
    data?: unknown
  ): JobRecord<TResult> {
    if (this.activeProjects.has(projectId)) {
      throw Object.assign(
        new Error(`A job is already running for project '${projectId}'.`),
        { status: 409 }
      );
    }

    if (this.activeProjects.size >= this.maxConcurrentJobs) {
      throw Object.assign(
        new Error('The indexing capacity is full; retry later.'),
        { status: 429 }
      );
    }

    this.activeProjects.add(projectId);
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const tokenSource = new CancellationTokenSource();

    const record: JobRecord<TResult> = {
      id: jobId,
      projectId,
      type,
      status: 'running',
      phase: 'init',
      progress: 0,
      startedAt: Date.now(),
      ...(data !== undefined ? { data } : {}),
      tokenSource,
    };

    this.jobs.set(jobId, record as JobRecord<unknown>);
    this.trimOldJobs();
    this.persist();

    this.notify(projectId, 'job.started', record);

    const updateProgress = (phase: string, progress: number, data?: unknown) => {
      const current = this.jobs.get(jobId);
      if (!current || current.status !== 'running') return;

      const updated: JobRecord = {
        ...current,
        phase,
        progress: Math.min(100, Math.max(0, Math.round(progress))),
      };

      this.jobs.set(jobId, updated);
      this.persist();
      this.notify(projectId, 'job.progress', { ...updated, data });
    };

    // Execute asynchronously
    (async () => {
      try {
        const result = await runner(tokenSource.token, updateProgress);
        const current = this.jobs.get(jobId);
        if (current && current.status === 'running') {
          const completed: JobRecord<TResult> = {
            ...(current as JobRecord<TResult>),
            status: 'completed',
            progress: 100,
            completedAt: Date.now(),
            result,
          };
          this.jobs.set(jobId, completed as JobRecord<unknown>);
          this.persist();
          this.notify(projectId, 'job.completed', completed);
        }
      } catch (error) {
        const current = this.jobs.get(jobId);
        if (current) {
          const isCancelled = tokenSource.token.isCancellationRequested;
          const failed: JobRecord = {
            ...current,
            status: isCancelled ? 'cancelled' : 'failed',
            completedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          };
          this.jobs.set(jobId, failed);
          this.persist();
          this.notify(projectId, isCancelled ? 'job.cancelled' : 'job.failed', failed);
        }
      } finally {
        this.activeProjects.delete(projectId);
      }
    })();

    return record;
  }

  registerRecovery(type: string, recovery: (job: JobRecord) => Promise<void>): void {
    this.recoveries.set(type, recovery);
  }

  async resumeInterruptedJobs(): Promise<number> {
    const interrupted = Array.from(this.jobs.values()).filter(
      job => job.status === 'failed' && job.error === 'Job interrupted by a process restart.'
    );
    let resumed = 0;
    for (const job of interrupted) {
      const recovery = this.recoveries.get(job.type);
      if (!recovery) continue;
      try {
        await recovery(job);
        resumed++;
      } catch (error) {
        this.jobs.set(job.id, {
          ...job,
          error: `Recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.persist();
      }
    }
    return resumed;
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  getJobsForProject(projectId: string): JobRecord[] {
    return Array.from(this.jobs.values()).filter(j => j.projectId === projectId);
  }

  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') {
      return false;
    }

    job.tokenSource.cancel();
    const updated: JobRecord = {
      ...job,
      status: 'cancelled',
      completedAt: Date.now(),
      error: 'Job was cancelled by user request',
    };
    this.jobs.set(jobId, updated);
    this.persist();
    this.notify(job.projectId, 'job.cancelled', updated);
    return true;
  }

  private restore(): void {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const persisted = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as PersistedJob[];
      for (const item of persisted.slice(-this.maxKeptJobs)) {
        const interrupted = item.status === 'running' || item.status === 'queued';
        const tokenSource = new CancellationTokenSource();
        const restored: JobRecord = {
          ...item,
          status: interrupted ? 'failed' : item.status,
          completedAt: interrupted ? Date.now() : item.completedAt,
          error: interrupted ? 'Job interrupted by a process restart.' : item.error,
          tokenSource,
        };
        this.jobs.set(restored.id, restored);
      }
    } catch {
      /* Corrupt job state must not prevent the server from starting. */
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    const records: PersistedJob[] = Array.from(this.jobs.values()).map(job => ({
      id: job.id,
      projectId: job.projectId,
      type: job.type,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      startedAt: job.startedAt,
      ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.data !== undefined ? { data: job.data } : {}),
    }));
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const temp = `${this.stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(temp, `${JSON.stringify(records)}\n`, 'utf8');
      fs.renameSync(temp, this.stateFile);
    } catch {
      /* Persistence is best effort; the in-memory job remains authoritative. */
    }
  }

  private notify(projectId: string, eventType: string, job: JobRecord): void {
    this.emit(eventType, job);
    if (this.sseManager) {
      this.sseManager.broadcast(projectId, {
        type: eventType,
        data: {
          jobId: job.id,
          projectId: job.projectId,
          type: job.type,
          status: job.status,
          phase: job.phase,
          progress: job.progress,
          durationMs: (job.completedAt || Date.now()) - job.startedAt,
          error: job.error,
        },
      });
    }
  }

  private trimOldJobs(): void {
    if (this.jobs.size > this.maxKeptJobs) {
      const sorted = Array.from(this.jobs.values()).sort((a, b) => a.startedAt - b.startedAt);
      const toDelete = sorted.slice(0, sorted.length - this.maxKeptJobs);
      for (const j of toDelete) {
        if (j.status !== 'running') {
          this.jobs.delete(j.id);
        }
      }
    }
  }
}
