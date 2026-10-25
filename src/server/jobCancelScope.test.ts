/**
 * SE-API-001 — the cancel route is scoped to `:id` and must not be able to
 * cancel another project's job, and an unknown/foreign job must 404 rather
 * than return a 200 `cancelled:false` (which presented a miss as a considered
 * decline).
 */

import { createJobRoutes } from './routes/jobRoutes';
import { JobManager } from '../runtime/JobManager';
import type { HttpRequestContext, RouteDefinition } from './types';
import type { ProjectService } from '../services/ProjectService';
import type { SseManager } from './SseManager';

function cancelRoute(jobManager: JobManager): RouteDefinition {
  const routes = createJobRoutes(
    {} as ProjectService,
    jobManager,
    { addClient: () => undefined } as unknown as SseManager,
  );
  const route = routes.find(
    r => r.method === 'POST' && r.pattern.endsWith('/jobs/:jobId/cancel'),
  );
  if (!route) throw new Error('cancel route not found');
  return route;
}

function ctxFor(projectId: string, jobId: string): HttpRequestContext {
  return {
    params: { id: projectId, jobId },
  } as unknown as HttpRequestContext;
}

describe('SE-API-001 — job cancel is project-scoped', () => {
  it('returns 404 for a job that belongs to a different project', async () => {
    const jobManager = new JobManager();
    // a runner that stays running until its token is cancelled
    const startRunning = (projectId: string) =>
      jobManager.startJob(projectId, 'index', token =>
        new Promise<void>(resolve => {
          token.onCancellationRequested(() => resolve());
        }),
      );

    const jobB = startRunning('project-b');

    const route = cancelRoute(jobManager);
    const result = (await route.handler(ctxFor('project-a', jobB.id))) as {
      status: number;
    };

    // project A's route must NOT cancel project B's job
    expect(result.status).toBe(404);
    expect(jobManager.getJob(jobB.id)!.status).toBe('running');

    // cleanup: cancel it through its own project so the promise settles
    const own = (await route.handler(ctxFor('project-b', jobB.id))) as {
      status: number;
      json: { cancelled: boolean };
    };
    expect(own.status).toBe(200);
    expect(own.json.cancelled).toBe(true);
  });

  it('returns 404 for an unknown job id', async () => {
    const jobManager = new JobManager();
    const route = cancelRoute(jobManager);
    const result = (await route.handler(ctxFor('project-a', 'nope'))) as {
      status: number;
    };
    expect(result.status).toBe(404);
  });
});
