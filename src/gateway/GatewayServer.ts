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
import { StaticAssetServer } from '../server/StaticAssetServer';
import { GatewayMcp, resolveProject } from './GatewayMcp';
import { OperationTracker } from './OperationTracker';
import { packageVersion } from '../host/version';
import * as fs from 'fs';
import { WorkerConfigStore } from './WorkerConfigStore';
import { createWorkerConfig } from './WorkerConfigSchema';
import { commandPreview } from './workerArgv';
import { ProjectWorkerConfig } from './types';
import { ApiKeyRecord, PermissionScope } from '../security/rbac/types';
import { generateToken } from '../cli/HttpGuard';
import { readBody } from './gatewayHttp';
import { RequestLog, RequestQuery, RequestSortKey } from './RequestLog';
import { parseUrlSafely, respondInternalError, safeDecode } from '../server/httpRequestUtils';
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
  /** Where the token came from; shown by the connection guide. */
  readonly tokenSource?: string;
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

const STATS_WINDOWS: Readonly<Record<string, number>> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
};

/** Query-string filters of `GET /api/v1/gateway/requests`; unknown or malformed values are ignored. */
function requestQueryFrom(params: URLSearchParams): RequestQuery {
  const text = (key: string): string | undefined => params.get(key)?.trim() || undefined;
  const number = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const status = text('status');
  const order = text('order');
  const query: { -readonly [K in keyof RequestQuery]: RequestQuery[K] } = {};
  const assign = <K extends keyof RequestQuery>(key: K, value: RequestQuery[K] | undefined): void => {
    if (value !== undefined) query[key] = value;
  };
  assign('project', text('project'));
  assign('tool', text('tool'));
  assign('client', text('client'));
  assign('q', text('q'));
  assign('status', status === 'ok' || status === 'error' ? status : undefined);
  assign('from', number('from'));
  assign('to', number('to'));
  assign('sort', text('sort') as RequestSortKey | undefined);
  assign('order', order === 'asc' || order === 'desc' ? order : undefined);
  assign('limit', number('limit'));
  assign('offset', number('offset'));
  return query;
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
  private readonly mcp: GatewayMcp;
  /** Agent tool calls, for the console's Activity and Stats tabs. */
  readonly requestLog: RequestLog;
  private readonly operations = new OperationTracker();
  /** The last gateway events, so the dashboard can show history it did not witness. */
  private readonly recentEvents: Record<string, unknown>[] = [];

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
    this.requestLog = new RequestLog({
      filePath: path.join(options.dataRoot, 'gateway', 'requests.jsonl'),
      onRecord: entry => this.pushSse('request', entry),
    });
    this.mcp = new GatewayMcp({
      registry: this.registry,
      supervisor: this.supervisor,
      auth: this.auth,
      log: this.requestLog,
    });
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
        this.handle(req, res).catch(error => respondInternalError(res, error));
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
    const stamped = { ...event, at: now().toISOString() };
    this.recentEvents.push(stamped);
    if (this.recentEvents.length > 300) this.recentEvents.splice(0, this.recentEvents.length - 300);
    this.pushSse('gateway', stamped);
  }

  /** One server-sent event to every open console; not kept in `recentEvents`. */
  private pushSse(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
    const url = parseUrlSafely(req.url, 'http://gateway.local');
    if (!url) {
      this.send(res, 400, { error: 'request target is not a valid URL' });
      return;
    }
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    const startedAt = Date.now();

    /* same reasoning as SecurityPipeline.applySecurityHeaders: `?token=` links must not leak via Referer */
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

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
    if (method === 'GET' && (await this.assets.serve(pathname, res))) return;

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
    if (pathname === '/mcp') {
      if (method !== 'POST') {
        this.send(res, 405, { error: 'the gateway MCP endpoint accepts POST (Streamable HTTP)' });
        return;
      }
      if (!this.auth.hasPermission(record, 'semantic:query')) {
        this.send(res, 403, { error: 'token lacks permission semantic:query' });
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        this.send(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await this.mcp.handle(req, res, body, record);
      return;
    }

    /* `/mcp/<id>` also accepts a project name or its folder name. */
    const mcp = /^\/mcp\/([^/]+)$/.exec(pathname);
    if (mcp) {
      if (!this.auth.hasPermission(record, 'semantic:query')) {
        this.send(res, 403, { error: 'token lacks permission semantic:query' });
        return;
      }
      const resolved = resolveProject(this.registry.list(), safeDecode(mcp[1]!));
      if ('error' in resolved) {
        this.send(res, 404, { error: resolved.error });
        return;
      }
      /*
      | POST goes through the same handler as `/mcp` with the project pinned,
      | so calls on a per-project URL are logged and see the same tool list.
      */
      if (method === 'POST') {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (error) {
          this.send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
        await this.mcp.handle(req, res, body, record, resolved.id);
        return;
      }
      await proxyToProject(this.proxyDeps(), req, res, resolved.id, record, { targetPath: '/mcp' });
      return;
    }

    if (pathname === '/api/v1/gateway/requests' && method === 'GET') {
      this.send(res, 200, this.requestLog.query(requestQueryFrom(url.searchParams), id => this.auth.canAccessProject(record, id)));
      return;
    }
    if (pathname === '/api/v1/gateway/stats' && method === 'GET') {
      const windowMs = STATS_WINDOWS[url.searchParams.get('window') ?? '24h'] ?? STATS_WINDOWS['24h']!;
      this.send(res, 200, this.requestLog.stats(windowMs, id => this.auth.canAccessProject(record, id)));
      return;
    }

    /*
    | The command the form would run, for display. Built by the same
    | `workerArgv` the supervisor spawns with, so the console keeps no second
    | copy of the flag rules. Nothing is executed or stored.
    */
    if (pathname === '/api/v1/gateway/command-preview' && method === 'POST') {
      try {
        const config = createWorkerConfig((await readBody(req)) as never);
        this.send(res, 200, { preview: commandPreview(config) });
      } catch (error) {
        this.send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (pathname === '/api/v1/gateway/info' && method === 'GET') {
      this.send(res, 200, this.infoPayload(req));
      return;
    }

    /*
    | Settings, providers, local models, the chat LLM and the folder picker are
    | global (one config.json under the data root), not per project. Every
    | worker runs the same platform server, so the first ready one answers.
    */
    if (/^\/api\/v1\/(settings|config|providers|models|chat|fs)(\/|$)/.test(pathname)) {
      const needed: PermissionScope = method === 'GET' ? 'project:read' : 'project:admin';
      if (!this.auth.hasPermission(record, needed)) {
        this.send(res, 403, { error: `token lacks permission ${needed}` });
        return;
      }
      const ready = this.supervisor.list().find(worker => worker.state === 'ready');
      if (!ready) {
        this.send(res, 503, {
          error: 'no project worker is ready; start a project to use settings, models and providers',
        });
        return;
      }
      await proxyToProject(this.proxyDeps(), req, res, ready.projectId, record);
      return;
    }

    const logsRoute = /^\/api\/v1\/gateway\/projects\/([^/]+)\/(logs|events|operation)$/.exec(pathname);
    if (logsRoute && method === 'GET') {
      if (!this.auth.hasPermission(record, 'project:read')) {
        this.send(res, 403, { error: 'token lacks permission project:read' });
        return;
      }
      const projectId = safeDecode(logsRoute[1]!);
      if (!this.registry.get(projectId)) {
        this.send(res, 404, { error: `unknown project: ${projectId}` });
        return;
      }
      if (!this.auth.canAccessProject(record, projectId)) {
        this.send(res, 403, { error: `token cannot access project ${projectId}` });
        return;
      }
      if (logsRoute[2] === 'operation') {
        /* what the console polls while a button's work is running */
        if (this.summarize(projectId)) await this.supervisor.refreshStats(projectId);
        const entry = this.entry(projectId);
        this.send(res, 200, {
          projectId,
          phase: entry['phase'],
          indexing: entry['indexing'],
          operation: entry['operation'],
          indexProgress: entry['indexProgress'],
          state: entry['state'],
          stats: entry['stats'],
        });
        return;
      }
      if (logsRoute[2] === 'logs') {
        this.send(res, 200, this.logsPayload(projectId, Number(url.searchParams.get('lines') ?? 200)));
      } else {
        this.send(res, 200, {
          projectId,
          events: this.recentEvents.filter(event => event['projectId'] === projectId),
        });
      }
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

  /** What a client needs to wire an AI to this gateway. Holds no secret. */
  private infoPayload(req: http.IncomingMessage): Record<string, unknown> {
    const host = typeof req.headers['host'] === 'string' ? req.headers['host'] : 'gateway';
    const base = `http://${host}`;
    return {
      name: 'semantic-gateway',
      version: packageVersion(),
      url: base,
      tokenSource: this.options.tokenSource ?? 'unknown',
      mcp: { url: `${base}/mcp`, perProjectUrl: `${base}/mcp/{project}`, transport: 'streamable-http' },
      dashboard: `${base}/`,
      settings: `${base}/open.html`,
      projects: this.registry.list().map(entry => ({ id: entry.id, name: entry.name, rootPath: entry.rootPath })),
    };
  }

  /** The tail of a worker's log file; the file holds the worker's whole stdout and stderr. */
  private logsPayload(projectId: string, lines: number): Record<string, unknown> {
    const wanted = Number.isInteger(lines) && lines > 0 ? Math.min(lines, 2000) : 200;
    const file = this.supervisor.logFileFor(projectId);
    try {
      const size = fs.statSync(file).size;
      const length = Math.min(size, 512 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        const tail = buffer
          .toString('utf8')
          .split(/\r?\n/)
          .filter(line => line !== '');
        return { projectId, file, sizeBytes: size, lines: tail.slice(-wanted) };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { projectId, file, sizeBytes: 0, lines: [], note: 'no log yet: this worker has not been started' };
    }
  }

  private assetServer?: StaticAssetServer;

  /** Same file server as a worker; only the page `/` opens differs. */
  private get assets(): StaticAssetServer {
    this.assetServer ??= new StaticAssetServer(
      this.options.staticDir ?? path.resolve(__dirname, '..', '..', 'public'),
      { home: 'gateway.html', projectDeepLinks: true }
    );
    return this.assetServer;
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
      projects: projects.map(entry => this.entry(entry.id)),
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
      ...this.entry(id),
      ...(config !== undefined ? { config } : {}),
    };
  }

  /** One project's row, with whatever the gateway is doing to it right now. */
  private entry(id: string): Record<string, unknown> {
    return projectEntry(this.supervisor, this.registry, projectId => this.summarize(projectId), id, this.operations.get(id));
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
      projectEntry: id => this.entry(id),
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
      operations: this.operations,
      send: (res, status, body) => this.send(res, status, body),
      broadcast: event => this.broadcast(event),
      readBody: req => readBody(req),
      projectEntry: id => this.entry(id),
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
