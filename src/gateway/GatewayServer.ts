/**
 * Semantic Gateway — فاز ۹.
 *
 * One public port, many single-project workers. The Gateway analyses nothing;
 * it registers projects, supervises workers and routes:
 *
 * ```text
 * /api/v1/gateway/...            administration (registry, lifecycle, metrics)
 * /api/v1/projects               the shape public/open.js already speaks
 * /api/v1/projects/:id/...       proxied to that project's worker, unrewritten
 * ```
 *
 * Two compatibility promises are kept on purpose:
 *
 *   - `GET|POST /api/v1/projects` answers exactly like the platform server did,
 *     so `public/open.js` works against the Gateway without a change;
 *   - proxied paths are **not** rewritten, so `visualizer.js` URLs such as
 *     `/api/v1/projects/<id>/visualization/architecture` reach the worker as
 *     they are.
 */

import * as http from 'http';
import * as path from 'path';
import { DurationSummary } from './metrics';
import { GatewayAuth } from './GatewayAuth';
import { ProjectRegistry } from '../core/config/ProjectRegistry';
import { CapacityError, LockHeldError, WorkerSupervisor, WorkerSummary } from './WorkerSupervisor';
import { handleProjectHealth, proxyToProject, ProxyDeps } from './GatewayProxyRoutes';
import { handleGatewayProjectRoute, handleRegisterProject, ProjectRouteDeps } from './GatewayProjectRoute';
import { handleGatewayUpgrade } from './GatewayUpgrade';
import { serveGatewayUi } from './GatewayUi';
import { WorkerConfigStore } from './WorkerConfigStore';
import { ProjectWorkerConfig } from './types';
import { ApiKeyRecord, PermissionScope } from '../security/rbac/types';
import { generateToken } from '../cli/HttpGuard';
import { readBody } from './gatewayHttp';
import { healthPayload, metricsPayload, projectEntry } from './gatewayPayloads';

export const DEFAULT_GATEWAY_PORT = 4000;

export interface GatewayServerOptions {
  readonly dataRoot: string;
  /** پوشهٔ assetهای UI؛ پیش‌فرض `public/` کنار dist. */
  readonly staticDir?: string;
  readonly port?: number;
  readonly host?: string;
  /** توکن bootstrap با دسترسی کامل؛ در نبودش ساخته می‌شود. */
  readonly token?: string;
  readonly registry?: ProjectRegistry;
  /** Restore autoStart projects on `start()`. Default true. */
  readonly hydrateOnStart?: boolean;
  readonly supervisor?: WorkerSupervisor;
  readonly now?: () => Date;
}

export interface GatewayStartInfo {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly token: string;
}

interface SseClient {
  readonly res: http.ServerResponse;
}

export class GatewayServer {
  readonly auth: GatewayAuth;
  private readonly bootstrapToken: string;
  readonly registry: ProjectRegistry;
  readonly supervisor: WorkerSupervisor;
  private server?: http.Server;
  private readonly sseClients = new Set<SseClient>();
  private activeRequests = 0;
  private requestsTotal = 0;
  private proxyErrorsTotal = 0;
  private readonly durations = new DurationSummary();
  private readonly configs: WorkerConfigStore;
  private readonly startedAt: number;

  constructor(private readonly options: GatewayServerOptions) {
    this.bootstrapToken = options.token ?? generateToken();
    this.auth = new GatewayAuth(this.bootstrapToken);
    this.registry = options.registry ?? new ProjectRegistry({ dataRoot: options.dataRoot });
    this.supervisor =
      options.supervisor ??
      new WorkerSupervisor({
        dataRoot: options.dataRoot,
        onEvent: event => this.broadcast({ type: 'worker', ...event }),
      });
    this.configs = new WorkerConfigStore(this.registry);
    this.startedAt = Date.now();
  }

  /**
   * Startup hydration: every persisted project that is `enabled` and has
   * `autoStart` gets its worker back after a Gateway restart. One failing
   * project (capacity, lock, bad root) never blocks the others; the failure is
   * broadcast and returned so callers/tests can see it.
   */
  async hydrateProjects(): Promise<{ started: string[]; failed: { projectId: string; error: string }[] }> {
    const started: string[] = [];
    const failed: { projectId: string; error: string }[] = [];
    for (const record of this.registry.list()) {
      if (!record.enabled || !record.autoStart) continue;
      try {
        await this.startWorkerFor(record.id, record.rootPath, record.name);
        started.push(record.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ projectId: record.id, error: message });
        this.broadcast({ type: 'project-hydration-failed', projectId: record.id, error: message });
      }
    }
    return { started, failed };
  }

  async start(): Promise<GatewayStartInfo> {
    this.supervisor.startHealthLoop();

    const info = await this.listen();
    if (this.options.hydrateOnStart !== false) {
      await this.hydrateProjects();
    }
    return info;
  }

  private listen(): Promise<GatewayStartInfo> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch(error => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          );
        });
      });

      this.server.once('error', reject);
      this.server.on('upgrade', (req, socket, head) =>
        handleGatewayUpgrade(
          { auth: this.auth, registry: this.registry, supervisor: this.supervisor },
          req,
          socket,
          head as Buffer
        )
      );
      const port = this.options.port ?? DEFAULT_GATEWAY_PORT;
      const host = this.options.host ?? '127.0.0.1';
      this.server.listen(port, host, () => {
        const address = this.server?.address();
        const boundPort = typeof address === 'object' && address ? address.port : port;
        resolve({
          port: boundPort,
          host,
          url: `http://${host}:${boundPort}`,
          token: this.bootstrapToken,
        });
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of [...this.sseClients]) client.res.end();
    this.sseClients.clear();
    await this.supervisor.stopAll();
    if (this.server) {
      await new Promise<void>(resolve => this.server?.close(() => resolve()));
      this.server = undefined;
    }
  }

  private broadcast(event: Record<string, unknown>): void {
    const now = this.options.now ?? (() => new Date());
    const payload = `event: gateway\ndata: ${JSON.stringify({ ...event, at: now().toISOString() })}\n\n`;
    for (const client of [...this.sseClients]) {
      if (!client.res.writableEnded) client.res.write(payload);
    }
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /** نگاشت روش/مسیر به permission، با همان واژگان platform. */
  private requiredPermission(method: string, pathname: string): PermissionScope {
    if (/^\/api\/v1\/gateway\/projects(\/|$)/.test(pathname)) {
      if (method === 'GET') return 'project:read';
      if (/\/reindex$/.test(pathname)) return 'semantic:index';
      return 'project:admin';
    }
    if (/\/index$|\/reindex$/.test(pathname)) return 'semantic:index';
    return method === 'GET' ? 'project:read' : 'project:write';
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    const startedAt = Date.now();

    this.requestsTotal += 1;
    res.on('finish', () => this.durations.record(Date.now() - startedAt));

    /* سلامت خودِ Gateway هیچ دادهٔ پروژه‌ای ندارد، پس باز است. */
    if (pathname === '/health' || pathname === '/api/v1/gateway/health') {
      this.send(res, 200, healthPayload(this.supervisor, this.registry, this.activeRequests, this.startedAt));
      return;
    }
    if (pathname === '/ready' || pathname === '/api/v1/gateway/ready') {
      const payload = healthPayload(this.supervisor, this.registry, this.activeRequests, this.startedAt);
      this.send(res, payload.ok ? 200 : 503, payload);
      return;
    }
    if (pathname === '/metrics' || pathname === '/api/v1/gateway/metrics') {
      this.send(res, 200, metricsPayload(this.supervisor, this.registry, { requestsTotal: this.requestsTotal, durations: this.durations, activeRequests: this.activeRequests, proxyErrorsTotal: this.proxyErrorsTotal }));
      return;
    }

    /*
    | ── کنسول Gateway (فاز ۱۲) ───────────────────────────────────────────
    |
    | assetها و خودِ صفحه هیچ دادهٔ پروژه‌ای ندارند، پس بدون توکن سرو
    | می‌شوند (دقیقاً مثل سرور پلتفرم)؛ همهٔ داده‌ها از همان APIهای
    | توکن‌دار می‌آیند.
    */
    if (method === 'GET' && serveGatewayUi(this.uiDir, pathname, res)) return;

    const auth = this.auth.verify(req, url.searchParams.get('token') ?? undefined);
    if (!auth.authenticated || !auth.record) {
      this.send(res, 401, { error: 'Unauthorized: a valid gateway token is required' });
      return;
    }
    const record = auth.record;

    if (pathname === '/api/v1/gateway/events' && method === 'GET') {
      this.openSse(req, res);
      return;
    }

    /*
    | ── MCP (فاز ۱۰) ────────────────────────────────────────────────────
    |
    | `POST /mcp/:projectId` به `/mcp` روی worker همان پروژه می‌رود. session
    | از لحظهٔ ایجاد به همان پروژه bound است، چون هر پروژه socket خودش را
    | دارد و مسیر هرگز بازنویسی نمی‌شود.
    */
    const mcp = /^\/mcp\/([^/]+)$/.exec(pathname);
    if (mcp) {
      if (!this.auth.hasPermission(record, 'semantic:query')) {
        this.send(res, 403, { error: 'token lacks permission semantic:query' });
        return;
      }
      await proxyToProject(this.proxyDeps(), req, res, mcp[1]!, record, { targetPath: '/mcp' });
      return;
    }

    const permission = this.requiredPermission(method, pathname);
    if (!this.auth.hasPermission(record, permission)) {
      this.send(res, 403, { error: `token lacks permission ${permission}` });
      return;
    }

    /* ── مدیریت پروژه‌ها ─────────────────────────────────────────────── */
    if (pathname === '/api/v1/gateway/projects' || pathname === '/api/v1/projects') {
      if (method === 'GET') {
        this.send(res, 200, await this.projectListPayload(record));
        return;
      }
      if (method === 'POST') {
        await handleRegisterProject(this.projectRouteDeps(), req, res);
        return;
      }
      this.send(res, 405, { error: `method ${method} not allowed` });
      return;
    }

    const healthRoute = /^\/api\/v1\/gateway\/projects\/([^/]+)\/health$/.exec(pathname);
    if (healthRoute && method === 'GET') {
      await handleProjectHealth(this.proxyDeps(), res, healthRoute[1]!, record);
      return;
    }

    const gatewayProject = /^\/api\/v1\/gateway\/projects\/([^/]+)(?:\/(start|stop|restart|reindex))?$/.exec(
      pathname
    );
    if (gatewayProject) {
      await handleGatewayProjectRoute(this.projectRouteDeps(), req, res, gatewayProject[1]!, gatewayProject[2], record);
      return;
    }

    /* ── proxy پروژه‌محور ─────────────────────────────────────────────── */
    /*
    | هر `/api/v1/projects/<id>/…` — با هر method — به worker همان پروژه
    | می‌رود و مسیر بازنویسی نمی‌شود، پس URLهای `visualizer.js` دست‌نخورده
    | کار می‌کنند.
    */
    const proxied = /^\/api\/v1\/projects\/([^/]+)(\/.*)?$/.exec(pathname);
    if (proxied) {
      await proxyToProject(this.proxyDeps(), req, res, proxied[1]!, record);
      return;
    }

    this.send(res, 404, { error: `route not found: ${method} ${pathname}` });
  }

  private get uiDir(): string {
    return this.options.staticDir ?? path.resolve(__dirname, '..', '..', 'public');
  }

  private openSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(`event: gateway\ndata: ${JSON.stringify({ type: 'hello' })}\n\n`);

    const client: SseClient = { res };
    this.sseClients.add(client);
    req.on('close', () => this.sseClients.delete(client));
  }



  private summarize(recordId: string): WorkerSummary | undefined {
    return this.supervisor.list().find(worker => worker.projectId === recordId);
  }


  /**
   * SE-F-058: a list built synchronously would claim stale (or zero) stats,
   * so every project with a live worker is refreshed (one internal health
   * request) before the payload is assembled.
   */

  private async projectListPayload(record: ApiKeyRecord) {
    const projects = this.registry
      .list()
      .filter(entry => this.auth.canAccessProject(record, entry.id));

    /*
    | SE-F-058: refresh the projects that actually have a live worker —
    | the same internal health request the periodic monitor makes. A
    | cold list must not claim zero counts for ready projects.
    */
    await Promise.all(
      projects
        .filter(entry => this.summarize(entry.id) !== undefined)
        .map(entry => this.supervisor.refreshStats(entry.id))
    );

    return {
      total: projects.length,
      projects: projects.map(entry => projectEntry(this.supervisor, this.registry, id => this.summarize(id), entry.id)),
    };
  }

  /** ساخت config معتبر یک پروژه؛ عمومی است چون `gateway` CLI هم لازم دارد. */
  configForProject(projectId: string, rootPath: string, name: string): ProjectWorkerConfig {
    return this.configs.configFor(projectId, rootPath, name);
  }

  /** مسیر فایل config پایدار یک پروژه (خارج از source root). */
  workerConfigPath(projectId: string): string {
    return this.configs.workerConfigPath(projectId);
  }

  /** config پایدار یک پروژه؛ `undefined` یعنی هیچ config سفارشی ثبت نشده. */
  loadStoredWorkerConfig(projectId: string): ProjectWorkerConfig | undefined {
    return this.configs.loadStoredWorkerConfig(projectId);
  }

  /** پاسخ پروژه + config مؤثر فعلی؛ برای hydration فرم دَش‌بُرد (SE-F-057). */
  private projectEntryWithConfig(id: string): Record<string, unknown> {
    const record = this.registry.get(id);
    const config =
      this.loadStoredWorkerConfig(id) ??
      (record ? this.configs.configFor(id, record.rootPath, record.name) : undefined);
    return {
      ...projectEntry(this.supervisor, this.registry, id => this.summarize(id), id),
      ...(config !== undefined ? { config } : {}),
    };
  }

  private async startWorkerFor(projectId: string, rootPath: string, name: string) {
    return this.supervisor.start(this.configs.configFor(projectId, rootPath, name));
  }

  private proxyDeps(): ProxyDeps {
    return {
      registry: this.registry,
      supervisor: this.supervisor,
      auth: this.auth,
      send: (res, status, body) => this.send(res, status, body),
      projectEntry: id => projectEntry(this.supervisor, this.registry, id => this.summarize(id), id),
      requestStarted: () => {
        this.activeRequests += 1;
      },
      requestFinished: () => {
        this.activeRequests -= 1;
      },
      proxyErrored: () => {
        this.proxyErrorsTotal += 1;
      },
    };
  }

  private projectRouteDeps(): ProjectRouteDeps {
    return {
      registry: this.registry,
      supervisor: this.supervisor,
      auth: this.auth,
      configs: this.configs,
      send: (res, status, body) => this.send(res, status, body),
      broadcast: event => this.broadcast(event),
      readBody: req => readBody(req),
      projectEntry: id => projectEntry(this.supervisor, this.registry, id => this.summarize(id), id),
      projectEntryWithConfig: id => this.projectEntryWithConfig(id),
      startWorkerFor: (projectId, rootPath, name) => this.startWorkerFor(projectId, rootPath, name),
      errorStatus: error => this.errorStatus(error),
    };
  }

  private errorStatus(error: unknown): number {
    if (error instanceof CapacityError) return 503;
    if (error instanceof LockHeldError) return 409;
    return 500;
  }

}
