/**
 * `/api/v1/gateway/projects/:id[/action]` — detail, patch, delete and lifecycle
 * of one registered project. Split from `GatewayServer` so the routing shell and
 * the per-project rules read separately; everything it needs arrives in `deps`.
 */

import * as http from 'http';
import * as path from 'path';
import { isPathSafeProjectId } from '../core/config/ProjectIdentity';
import { GatewayAuth } from './GatewayAuth';
import { ProjectRegistry } from '../core/config/ProjectRegistry';
import { WorkerSupervisor } from './WorkerSupervisor';
import { WorkerConfigStore } from './WorkerConfigStore';

export interface ProjectRouteDeps {
  readonly registry: ProjectRegistry;
  readonly supervisor: WorkerSupervisor;
  readonly auth: GatewayAuth;
  readonly configs: WorkerConfigStore;
  send(res: http.ServerResponse, status: number, body: unknown): void;
  broadcast(event: Record<string, unknown>): void;
  readBody(req: http.IncomingMessage): Promise<Record<string, unknown>>;
  projectEntry(id: string): Record<string, unknown>;
  projectEntryWithConfig(id: string): Record<string, unknown>;
  startWorkerFor(projectId: string, rootPath: string, name: string): ReturnType<WorkerSupervisor['start']>;
  errorStatus(error: unknown): number;
}

export async function handleGatewayProjectRoute(
  deps: ProjectRouteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectId: string,
  action: string | undefined,
  record: NonNullable<ReturnType<GatewayAuth['verify']>['record']>
): Promise<void> {
  const registered = deps.registry.get(projectId);
  if (!registered) {
    deps.send(res, 404, { error: `unknown project: ${projectId}` });
    return;
  }
  if (!deps.auth.canAccessProject(record, projectId)) {
    deps.send(res, 403, { error: `token cannot access project ${projectId}` });
    return;
  }

  const method = req.method ?? 'GET';

  if (!action) {
    if (method === 'GET') {
      /* SE-F-058 — یک تازه‌سازی هدفمند: همان درخواستی که حلقهٔ health
         هر ۱۰ ثانیه می‌زند؛ این‌جا در لحظهٔ پرسش تکرار می‌شود تا
         آمارِ پاسخ، آخرین اندازه‌گیری باشد نه قدیمی‌ترین.
         SE-F-057 — the detail answer also carries the effective worker
         config so the dashboard form hydrates EVERY field, not just the
         three the old save path could send. */
      await deps.supervisor.refreshStats(projectId);
      deps.send(res, 200, deps.projectEntryWithConfig(projectId));
      return;
    }
    if (method === 'DELETE') {
      await deps.supervisor.stop(projectId);
      deps.registry.remove(projectId);
      deps.broadcast({ type: 'project-removed', projectId });
      deps.send(res, 200, { ok: true, removed: projectId });
      return;
    }
    if (method === 'PATCH') {
      let body: Record<string, unknown>;
      try {
        body = await deps.readBody(req);
      } catch (error) {
        deps.send(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const patch: { name?: string; enabled?: boolean; autoStart?: boolean } = {};
      /*
      | SE-F-057 — identity is registry-owned: a PATCH body that tries to
      | move the project (`path`/`rootPath`/`id`) is refused with a real
      | error rather than silently ignored — a 200 that quietly dropped an
      | attempted root change is exactly the misleading success §2 forbids.
      */
      for (const forbidden of ['path', 'rootPath', 'id'] as const) {
        if (body[forbidden] !== undefined) {
          deps.send(res, 400, {
            error:
              `project identity (${forbidden}) is not patchable; it comes from the registry — ` +
              'remove the key (or relocate via the registry API) and resend',
          });
          return;
        }
      }
      if (body['name'] !== undefined) {
        if (typeof body['name'] !== 'string' || body['name'].trim() === '') {
          deps.send(res, 400, { error: 'name must be a non-empty string' });
          return;
        }
        patch.name = body['name'];
      }
      for (const key of ['enabled', 'autoStart'] as const) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== 'boolean') {
            deps.send(res, 400, { error: `${key} must be a boolean` });
            return;
          }
          patch[key] = body[key] as boolean;
        }
      }

      /*
      | SE-F-057 — the dashboard edits the WHOLE worker config, so PATCH
      | accepts the same config keys as POST. Everything is validated
      | BEFORE anything is written: a rejected edit leaves both the
      | registry record and the stored config exactly as they were
      | (all-or-nothing).
      */
      const prospective = {
        id: registered.id,
        name: patch.name ?? registered.name,
        rootPath: registered.rootPath,
        autoStart: patch.autoStart ?? registered.autoStart,
      };
      const incoming = deps.configs.validateIncomingWorkerConfig(prospective, body);
      if (incoming.changed && 'error' in incoming) {
        deps.send(res, 400, {
          error: incoming.error,
          project: deps.projectEntryWithConfig(projectId),
        });
        return;
      }

      const updatedRecord = deps.registry.update(projectId, patch);
      if (incoming.changed) {
        deps.configs.storeWorkerConfig(incoming.config);
      }

      // Decision D-2: disabling a project must not leave its worker running.
      if (patch.enabled === false) {
        await deps.supervisor.stop(projectId);
      } else if (incoming.changed && deps.supervisor.isRunning(projectId)) {
        /*
        | The edit is not real until the worker runs the new config:
        | a live worker keeps its old argv, so restart it with the freshly
        | stored configuration. (Restart failure is reported truthfully —
        | the config IS stored and applies on the next start.)
        */
        try {
          await deps.supervisor.stop(projectId);
          await deps.startWorkerFor(projectId, updatedRecord.rootPath, updatedRecord.name);
        } catch (error) {
          deps.broadcast({
            type: 'project-update-restart-failed',
            projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          deps.send(res, 500, {
            error: `configuration stored but the worker could not be restarted: ${
              error instanceof Error ? error.message : String(error)
            }`,
            project: deps.projectEntryWithConfig(projectId),
          });
          return;
        }
      }

      deps.broadcast({ type: 'project-updated', projectId: updatedRecord.id });
      deps.send(res, 200, deps.projectEntryWithConfig(updatedRecord.id));
      return;
    }
    deps.send(res, 405, { error: `method ${method} not allowed` });
    return;
  }

  try {
    switch (action) {
      case 'start': {
        await deps.startWorkerFor(projectId, registered.rootPath, registered.name);
        deps.send(res, 200, deps.projectEntry(projectId));
        return;
      }
      case 'stop': {
        const stopped = await deps.supervisor.stop(projectId);
        deps.send(res, 200, { ok: stopped, ...deps.projectEntry(projectId) });
        return;
      }
      case 'restart': {
        await deps.supervisor.restart(projectId);
        deps.send(res, 200, deps.projectEntry(projectId));
        return;
      }
      case 'reindex': {
        const result = await deps.supervisor.reindex(projectId);
        deps.send(res, result.status, result.json);
        return;
      }
      default:
        deps.send(res, 404, { error: `unknown action: ${action}` });
    }
  } catch (error) {
    deps.send(res, deps.errorStatus(error), {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleRegisterProject(
  deps: ProjectRouteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await deps.readBody(req);
  } catch (error) {
    deps.send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const rootPath = String(body['path'] ?? body['rootPath'] ?? '');
  if (rootPath.trim() === '') {
    deps.send(res, 400, { error: 'path is required' });
    return;
  }

  const name = String(body['name'] ?? path.basename(rootPath));
  const requestedId = body['id'] !== undefined ? String(body['id']) : undefined;

  /* SE-F-057 — did this root already exist? If not, and the config in the
  | same payload turns out invalid, the half-created registration is rolled
  | back: a rejected create must not leave a project behind. */
  const preexisting = deps.registry.getByRoot(rootPath);

  let registered: ReturnType<ProjectRegistry['register']>;
  try {
    registered = deps.registry.register({
      rootPath,
      name,
      ...(requestedId && isPathSafeProjectId(requestedId) ? { id: requestedId } : {}),
    });
  } catch (error) {
    deps.send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (typeof body['autoStart'] === 'boolean' && registered.autoStart !== body['autoStart']) {
    registered = deps.registry.update(registered.id, { autoStart: body['autoStart'] });
  }

  /*
  | SE-F-057 — if the payload carried real worker-config keys, validate
  | them BEFORE any write and store only on success. A body with only
  | registration keys (a legacy POST) stores nothing and the project keeps
  | its default config — backwards compatible.
  */
  const incoming = deps.configs.validateIncomingWorkerConfig(registered, body);
  if (incoming.changed) {
    if ('error' in incoming) {
      /* rollback: an invalid-config create leaves nothing behind */
      if (!preexisting) deps.registry.remove(registered.id);
      deps.send(res, 400, {
        error: incoming.error,
        ...(preexisting ? { project: deps.projectEntry(registered.id) } : {}),
      });
      return;
    }
    deps.configs.storeWorkerConfig(incoming.config);
  }

  const autoStart = body['autoStart'] === true;
  if (autoStart) {
    try {
      await deps.startWorkerFor(registered.id, registered.rootPath, registered.name);
    } catch (error) {
      deps.send(res, deps.errorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
        project: deps.projectEntry(registered.id),
      });
      return;
    }
  }

  deps.broadcast({ type: 'project-registered', projectId: registered.id });
  deps.send(res, 201, deps.projectEntryWithConfig(registered.id));
}
