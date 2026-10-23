/**
 * Health, metrics and project payload builders of the gateway server
 * (split from GatewayServer.ts, behavior unchanged).
 */

import { DurationSummary } from './metrics';
import { ProjectRegistry } from '../core/config/ProjectRegistry';
import { WorkerSupervisor, WorkerSummary } from './WorkerSupervisor';

export function healthPayload(
  supervisor: WorkerSupervisor,
  registry: ProjectRegistry,
  activeRequests: number,
  startedAt: number
): Record<string, unknown> {
  const workers = supervisor.list();
  const ready = workers.filter(worker => worker.state === 'ready').length;
  const degraded = workers.filter(worker => worker.degraded).length;

  return {
    ok: degraded === 0,
    gateway: 'semantic-gateway',
    projects: registry.list().length,
    workers: workers.length,
    workersReady: ready,
    workersDegraded: degraded,
    activeRequests: activeRequests,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

export function metricsPayload(
  supervisor: WorkerSupervisor,
  registry: ProjectRegistry,
  counters: { requestsTotal: number; durations: DurationSummary; activeRequests: number; proxyErrorsTotal: number }
): Record<string, unknown> {
  const workers = supervisor.list();
  return {
    gateway_projects_total: registry.list().length,
    gateway_workers_ready: workers.filter(w => w.state === 'ready').length,
    gateway_workers_unhealthy: workers.filter(w => w.degraded || w.state === 'crashed').length,
    gateway_requests_total: counters.requestsTotal,
    gateway_request_duration_ms: counters.durations.snapshot(),
    gateway_active_requests: counters.activeRequests,
    gateway_proxy_errors_total: counters.proxyErrorsTotal,
    gateway_worker_restarts_total: workers.reduce((sum, w) => sum + w.restartCount, 0),
    gateway_index_jobs_active: supervisor.activeIndexJobsCount,
  };
}

export function projectEntry(
  supervisor: WorkerSupervisor,
  registry: ProjectRegistry,
  summarize: (id: string) => WorkerSummary | undefined,
  id: string
): Record<string, unknown> {
  const registered = registry.get(id);
  const worker = summarize(id);
  const running = worker?.state === 'ready';

  /*
  | SE-F-058: the old code emitted hard-coded zeros here — a `ready`
  | project claiming 0 files / 0 symbols is information that makes an
  | AI (or a human) decide the index is empty when it is not. Now the
  | payload carries the worker's real health snapshot when one has been
  | collected, and declares `available: false` when it has not, so
  | "we have no measurement" can never read as "the measurement is 0".
  */
  const snapshot = worker?.lastHealthSnapshot;
  const observedAt = supervisor.lastStatsObservedAt(id);

  return {
    id,
    name: registered?.name ?? id,
    rootPath: registered?.rootPath ?? '',
    status: running ? 'ready' : worker ? 'indexing' : 'missing',
    workerState: worker?.state ?? 'stopped',
    restartCount: worker?.restartCount ?? 0,
    degraded: worker?.degraded ?? false,
    stats: {
      available: snapshot !== undefined,
      filesCount: snapshot?.files ?? null,
      symbolsCount: snapshot?.symbols ?? null,
      dependenciesCount: snapshot?.dependencies ?? null,
      ...(snapshot && observedAt !== undefined
        ? { observedAt: new Date(observedAt).toISOString() }
        : {
            note:
              'no worker health snapshot collected yet — counts are NOT measurements of an empty index',
          }),
    },
  };
}
