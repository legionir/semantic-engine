/**
 * Platform Core V1 — JobManager Unit Tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobManager } from './JobManager';

describe('JobManager — Background Async Task Engine', () => {
  it('starts a job and updates progress until completion', async () => {
    const jobManager = new JobManager();

    const job = jobManager.startJob('prj-1', 'index', async (token, updateProgress) => {
      updateProgress('parsing', 20);
      await new Promise(r => setTimeout(r, 10));
      updateProgress('symbols', 60);
      await new Promise(r => setTimeout(r, 10));
      updateProgress('done', 100);
      return { success: true, count: 42 };
    });

    expect(job.status).toBe('running');
    expect(job.projectId).toBe('prj-1');

    await new Promise(r => setTimeout(r, 50));

    const completed = jobManager.getJob(job.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.progress).toBe(100);
    expect(completed?.result).toEqual({ success: true, count: 42 });
  });

  it('rejects a concurrent job for the same project', async () => {
    const jobManager = new JobManager();
    const first = jobManager.startJob('prj-lock', 'index', async () => {
      await new Promise(r => setTimeout(r, 40));
      return { done: true };
    });

    expect(() => jobManager.startJob('prj-lock', 'index', async () => ({ done: true }))).toThrow(
      /already running/
    );
    await new Promise(r => setTimeout(r, 60));
    expect(jobManager.getJob(first.id)?.status).toBe('completed');
  });

  it('persists completed job metadata and restores it after restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-jobs-'));
    const stateFile = path.join(root, 'jobs.json');
    try {
      const manager = new JobManager(undefined, stateFile);
      const job = manager.startJob('prj-persist', 'index', async () => ({ ok: true }));
      await new Promise(resolve => setTimeout(resolve, 30));

      const restored = new JobManager(undefined, stateFile).getJob(job.id);
      expect(restored?.status).toBe('completed');
      expect(restored?.result).toEqual({ ok: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resumes an interrupted job through its registered recovery runner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-resume-'));
    const stateFile = path.join(root, 'jobs.json');
    fs.writeFileSync(stateFile, JSON.stringify([{
      id: 'job-old',
      projectId: 'prj-resume',
      type: 'index',
      status: 'running',
      phase: 'symbols',
      progress: 40,
      startedAt: Date.now() - 1000,
      data: { scan: { maxDepth: 2 } },
    }]));

    try {
      const manager = new JobManager(undefined, stateFile);
      let executed = false;
      manager.registerRecovery('index', async job => {
        executed = job.data !== undefined;
        manager.startJob(job.projectId, job.type, async () => ({ resumed: true }), job.data);
      });

      expect(await manager.resumeInterruptedJobs()).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(executed).toBe(true);
      expect(manager.getJobsForProject('prj-resume').some(job => (job.result as { resumed?: boolean } | undefined)?.resumed === true)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels a running job when requested', async () => {
    const jobManager = new JobManager();

    const job = jobManager.startJob('prj-2', 'reindex', async (token, updateProgress) => {
      for (let i = 0; i < 10; i++) {
        if (token.isCancellationRequested) {
          throw new Error('Cancelled');
        }
        updateProgress(`step-${i}`, i * 10);
        await new Promise(r => setTimeout(r, 20));
      }
      return { done: true };
    });

    await new Promise(r => setTimeout(r, 25));
    const cancelled = jobManager.cancelJob(job.id);
    expect(cancelled).toBe(true);

    await new Promise(r => setTimeout(r, 50));
    const finalState = jobManager.getJob(job.id);
    expect(finalState?.status).toBe('cancelled');
  });
});
