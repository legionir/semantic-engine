/**
 * Per-project health detail and request proxying: authorise the token for the
 * project, find its live worker and either report its health or forward the
 * request unrewritten.
 */

import * as http from 'http';
import { GatewayAuth } from './GatewayAuth';
import { proxyRequest } from './GatewayProxy';
import { ProjectRegistry } from '../core/config/ProjectRegistry';
import { WorkerSupervisor } from './WorkerSupervisor';
import type { WorkerHealthSnapshot } from './WorkerProcess';

export interface ProxyDeps {
  readonly registry: ProjectRegistry;
  readonly supervisor: WorkerSupervisor;
  readonly auth: GatewayAuth;
  send(res: http.ServerResponse, status: number, body: unknown): void;
  projectEntry(id: string): Record<string, unknown>;
  requestStarted(): void;
  requestFinished(): void;
  proxyErrored(): void;
}

/**
 * health detail یک پروژه (فاز ۱۳): وضعیت خود worker از `/internal/health`
 * به‌علاوهٔ آنچه فقط Gateway می‌داند — تعداد restart، آخرین خطا و اینکه
 * degraded شده یا نه. خرابی یک پروژه اینجا هم فقط همان پروژه را قرمز
 * می‌کند، نه بقیه را.
 */
export async function handleProjectHealth(
  deps: ProxyDeps,
  res: http.ServerResponse,
  projectId: string,
  record: NonNullable<ReturnType<GatewayAuth['verify']>['record']>
): Promise<void> {
  if (!deps.registry.get(projectId)) {
    deps.send(res, 404, { error: `unknown project: ${projectId}` });
    return;
  }
  if (!deps.auth.canAccessProject(record, projectId)) {
    deps.send(res, 403, { error: `token cannot access project ${projectId}` });
    return;
  }

  const diagnostics = deps.supervisor.diagnostics(projectId);
  const worker = deps.supervisor.get(projectId);

  let workerHealth: Record<string, unknown> | null = null;
  if (worker && worker.exitCode === null) {
    try {
      const reply = await worker.request('GET', '/internal/health');
      workerHealth = reply.json;
    } catch {
      workerHealth = null;
    }
  }

  /*
  | SE-F-058: the snapshot fetched just below IS the freshest possible
  | source for the stats block — record it before building the entry so
  | this route makes exactly one health request and its `stats` mirror
  | the `health` payload instead of fabricated zeros.
  */
  deps.supervisor.recordStats(
    projectId,
    (workerHealth ?? undefined) as WorkerHealthSnapshot | undefined
  );
  const summary = deps.projectEntry(projectId);

  deps.send(res, 200, {
    projectId,
    ...summary,
    health: workerHealth,
    ...diagnostics,
  });
}

export async function proxyToProject(
  deps: ProxyDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectId: string,
  record: NonNullable<ReturnType<GatewayAuth['verify']>['record']>,
  options: { targetPath?: string } = {}
): Promise<void> {
  if (!deps.registry.get(projectId)) {
    deps.send(res, 404, { error: `unknown project: ${projectId}` });
    return;
  }
  if (!deps.auth.canAccessProject(record, projectId)) {
    deps.send(res, 403, { error: `token cannot access project ${projectId}` });
    return;
  }

  const worker = deps.supervisor.get(projectId);
  if (!worker || worker.pid === null || worker.exitCode !== null) {
    deps.send(res, 502, { error: `worker ${projectId} is not running` });
    return;
  }

  /*
  | توکن داخلی worker از خودِ supervisor پرسیده می‌شود؛ هرگز از کلاینت
  | گرفته نمی‌شود و هرگز در لاگ نمی‌آید.
  */
  const target = {
    worker: worker.target,
    token: deps.supervisor.workerToken(projectId) ?? '',
  };

  deps.requestStarted();
  try {
    await proxyRequest(target, req, res, {
      projectId,
      ...(options.targetPath !== undefined ? { targetPath: options.targetPath } : {}),
      onUpstream: () => undefined,
      onError: () => {
        deps.proxyErrored();
      },
    });
  } finally {
    deps.requestFinished();
  }
}
