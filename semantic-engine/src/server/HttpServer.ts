/**
 * HttpServer — Platform Core V1 Main Modular HTTP Server.
 */

import { matchPattern, readBody } from './httpRequestUtils';
import { StaticAssetServer } from './StaticAssetServer';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { RouteDefinition, HttpRequestContext, PlatformConfig } from './types';
import { AuthContext, PermissionScope, ROLE_DEFAULT_PERMISSIONS } from '../security/rbac/types';
import { PermissionChecker } from '../security/rbac/PermissionChecker';
import { SecurityPipeline } from './SecurityPipeline';
import { socketEndpoint, isNamedPipe } from './socketEndpoint';
import { SseManager } from './SseManager';
import { WebSocketManager } from './WebSocketManager';
import { JobManager } from '../runtime/JobManager';
import { ApiKeyStore } from '../security/rbac/ApiKeyStore';
import { AuditLogger } from '../security/audit/AuditLogger';
import { MetricsCollector } from '../observability/MetricsCollector';
import { OpenTelemetryTracer } from '../observability/OpenTelemetryTracer';
import { ProjectService } from '../services/ProjectService';
import { ProjectRegistry } from '../core/config/ProjectRegistry';
import { RUNTIME_DIR } from '../core/config/ProjectPaths';
import { SearchService } from '../services/SearchService';
import { CodeIntelligenceService } from '../services/CodeIntelligenceService';
import { ContextService } from '../services/ContextService';
import { LodService } from '../services/visualization/LodService';
import { SourceSyncService } from '../services/source/SourceSyncService';
import { ImpactAnalysisEngine } from '../services/analysis/ImpactAnalysisEngine';
import { ArchitectureRuleEngine } from '../services/analysis/ArchitectureRuleEngine';
import { MutationSimulator } from '../services/analysis/MutationSimulator';
import { GitHistoryMiner } from '../services/history/GitHistoryMiner';
import { RerankerService } from '../services/context/RerankerService';
import { ContextCompressor } from '../services/context/ContextCompressor';
import { EmbeddingProviderService } from '../services/providers/EmbeddingProviderService';
import { ProjectChatService } from '../services/chat/ProjectChatService';

import { createSystemRoutes } from './routes/systemRoutes';
import { createConfigRoutes } from './routes/configRoutes';
import { createProjectRoutes } from './routes/projectRoutes';
import { createJobRoutes } from './routes/jobRoutes';
import { createSearchRoutes } from './routes/searchRoutes';
import { createCodeRoutes } from './routes/codeRoutes';
import { createVisualizationRoutes } from './routes/visualizationRoutes';
import { createAuthRoutes } from './routes/authRoutes';
import { createSourceRoutes } from './routes/sourceRoutes';
import { createAnalysisRoutes } from './routes/analysisRoutes';
import { createHistoryRoutes } from './routes/historyRoutes';
import { createProviderRoutes } from './routes/providerRoutes';
import { createFsRoutes } from './routes/fsRoutes';
import { createChatRoutes, LlmConfigStore } from './routes/chatRoutes';
import { createSettingsRoutes } from './routes/settingsRoutes';
import { resolveModelsDir } from '../vector/createEmbeddingGenerator';
import { LocalModelStore } from '../services/providers/LocalModelStore';
import { loadGlobalConfig, modelsDirFor } from '../core/config/GlobalConfig';

export class HttpServer {
  private readonly assets: StaticAssetServer;
  private server?: http.Server;
  private readonly routes: RouteDefinition[] = [];
  /** `<dataRoot>/runtime` — state پروسه، بیرون از source root. */
  private readonly runtimeDir?: string;
  readonly security: SecurityPipeline;
  readonly sse: SseManager;
  readonly ws: WebSocketManager;
  readonly apiKeyStore: ApiKeyStore;
  readonly auditLogger: AuditLogger;
  readonly metricsCollector: MetricsCollector;
  readonly tracer: OpenTelemetryTracer;
  // F-0012 — removed dead `jobQueue` (InMemoryQueueAdapter) and
  // `indexingWorker` (IndexingWorker): they were constructed but never
  // started or enqueued into, and `/ready` advertised a subsystem that did
  // not exist. The real job engine is `jobs` (JobManager).
  readonly jobs: JobManager;
  readonly projects: ProjectService;
  readonly searchService: SearchService;
  readonly codeService: CodeIntelligenceService;
  readonly contextService: ContextService;
  readonly lodService: LodService;
  readonly sourceSyncService: SourceSyncService;
  readonly impactEngine: ImpactAnalysisEngine;
  readonly archEngine: ArchitectureRuleEngine;
  readonly mutationSimulator: MutationSimulator;
  readonly historyMiner: GitHistoryMiner;
  readonly rerankerService: RerankerService;
  readonly contextCompressor: ContextCompressor;
  readonly embeddingProviders: EmbeddingProviderService;
  readonly localModels: LocalModelStore;
  readonly chatService: ProjectChatService;
  readonly llmConfig: LlmConfigStore;

  constructor(private readonly config: PlatformConfig) {
    this.security = new SecurityPipeline(config);
    this.assets = new StaticAssetServer(config.staticDir);
    this.sse = new SseManager();
    this.ws = new WebSocketManager();
    this.apiKeyStore = new ApiKeyStore(config.token);
    this.auditLogger = new AuditLogger();
    this.metricsCollector = new MetricsCollector();
    this.tracer = new OpenTelemetryTracer();
    /*
    | state پروسه هرگز داخل checkout نوشته نمی‌شود (قبلاً
    | `<projectsRoot>/.agent/jobs.json` بود و ریپو را dirty می‌کرد). جای آن
    | `<dataRoot>/runtime/` است؛ وقتی dataRoot داده نشده، اصلاً persist
    | نمی‌شود — که برای تست‌ها رفتار درست است.
    */
    this.runtimeDir = config.dataRoot
      ? path.join(config.dataRoot, RUNTIME_DIR)
      : undefined;
    this.jobs = new JobManager(
      this.sse,
      this.runtimeDir ? path.join(this.runtimeDir, 'jobs.json') : undefined
    );
    this.projects = new ProjectService(
      config.projectsRoot,
      {
        ...(config.dataRoot ? { registry: new ProjectRegistry({ dataRoot: config.dataRoot }) } : {}),
        ...(config.dataRoot ? { dataRoot: config.dataRoot } : {}),
        ...(config.projectId ? { artifactProjectId: config.projectId } : {}),
        ...(config.artifactLocation ? { artifactLocation: config.artifactLocation } : {}),
      }
    );
    this.searchService = new SearchService();
    this.codeService = new CodeIntelligenceService();
    this.contextService = new ContextService();
    this.lodService = new LodService();
    this.sourceSyncService = new SourceSyncService();
    this.impactEngine = new ImpactAnalysisEngine();
    this.archEngine = new ArchitectureRuleEngine();
    this.mutationSimulator = new MutationSimulator();
    this.historyMiner = new GitHistoryMiner();
    this.rerankerService = new RerankerService();
    this.contextCompressor = new ContextCompressor();
    this.embeddingProviders = new EmbeddingProviderService();
    this.chatService = new ProjectChatService();
    this.llmConfig = new LlmConfigStore();

    /*
    | Models and the saved chat endpoint live next to the other generated data.
    | Without a dataRoot (unit tests) nothing is read from or written to disk.
    */
    const userConfig = config.dataRoot ? loadGlobalConfig(config.dataRoot).config : undefined;
    this.localModels = new LocalModelStore({
      /* env > config, the same order the CLI uses (resolveModelsDir). */
      modelsDir: (process.env['SEMANTIC_ENGINE_MODELS_DIR'] ?? '').trim() !== ''
        ? process.env['SEMANTIC_ENGINE_MODELS_DIR']!.trim()
        : config.dataRoot
          ? modelsDirFor(config.dataRoot, userConfig)
          : resolveModelsDir(),
      /* A mirror for networks that cannot reach huggingface.co. */
      ...((process.env['SEMANTIC_ENGINE_MODEL_HUB_URL'] || userConfig?.models.hubUrl)
        ? { baseUrl: (process.env['SEMANTIC_ENGINE_MODEL_HUB_URL'] || userConfig!.models.hubUrl).replace(/\/+$/, '') }
        : {}),
    });
    if (userConfig?.chat.baseUrl && userConfig.chat.model) {
      const keyVar = userConfig.chat.apiKeyEnvVar;
      const apiKey = keyVar ? (process.env[keyVar] ?? '').trim() : '';
      this.llmConfig.set({
        baseUrl: userConfig.chat.baseUrl,
        model: userConfig.chat.model,
        temperature: userConfig.chat.temperature,
        ...(apiKey ? { apiKey } : {}),
      });
    }

    this.registerAllRoutes();
  }

  private readiness(): { ready: boolean; checks: Record<string, boolean> } {
    const checks = {
      process: true,
      projectsRoot: !this.config.projectsRoot || fs.existsSync(this.config.projectsRoot),
      /*
      | F-0012 — honest readiness. The old key was `jobQueue` backed by a
      | dead InMemoryQueueAdapter that nothing ever started; it always read
      | `true` while advertising a subsystem that did not process work. The
      | real job subsystem is the JobManager, so report that.
      */
      jobManager: Boolean(this.jobs),
      projectRegistry: Boolean(this.projects),
      sseManager: Boolean(this.sse),
    };

    return {
      ready: Object.values(checks).every(Boolean),
      checks,
    };
  }

  private registerAllRoutes(): void {
    this.routes.push(...createSystemRoutes(() => this.readiness()));
    this.routes.push(...createConfigRoutes(this.config));
    this.routes.push(...createProjectRoutes(this.projects));
    this.routes.push(...createJobRoutes(this.projects, this.jobs, this.sse, this.localModels.modelsDir));
    this.routes.push(...createSearchRoutes(this.projects, this.searchService));
    this.routes.push(...createCodeRoutes(this.projects, this.codeService, this.contextService));
    this.routes.push(...createVisualizationRoutes(this.projects, this.lodService));
    this.routes.push(...createAuthRoutes(this.apiKeyStore));
    this.routes.push(...createSourceRoutes(this.projects, this.sourceSyncService));
    this.routes.push(...createAnalysisRoutes(this.projects, this.impactEngine, this.archEngine, this.mutationSimulator));
    this.routes.push(...createHistoryRoutes(this.projects, this.historyMiner));
    this.routes.push(...createProviderRoutes(this.embeddingProviders, this.localModels));
    this.routes.push(...createSettingsRoutes(this.config));
    this.routes.push(
      ...createFsRoutes(this.config.projectsRoot ?? process.cwd(), {
        /*
        | در حالت managed، worker به یک پروژه bound است و مرور فایل فقط داخل
        | همان پروژه معنا دارد. در حالت standalone، انتخابگر «باز کردن
        | پروژه» در UI عمداً بیرون از root هم مرور می‌کند، پس آن حالت دست
        | نخورده می‌ماند.
        */
        confineToRoot: Boolean(this.config.gatewayManaged),
      })
    );
    this.routes.push(
      ...createChatRoutes(this.projects, this.chatService, this.llmConfig, this.embeddingProviders)
    );
  }

  addRoute(route: RouteDefinition): void {
    this.routes.push(route);
  }

  /**
   * F-0011 — surface the registered routes for the repo-wide security scan
   * test (asserting every mutating/admin route declares an explicit
   * permission). Read-only; not a runtime endpoint.
   */
  getRegisteredRoutes(): readonly RouteDefinition[] {
    return [...this.routes];
  }

  async start(): Promise<{ port: number; host: string; url: string }> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(error => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
      });

      this.server.once('error', reject);

      /*
      | ── WebSocket (فاز ۱۱) ─────────────────────────────────────────────
      |
      | اگر هندلری داده نشده باشد upgrade رد می‌شود؛ handshake نیمه‌کاره
      | کلاینت را منتظر ۱۰۱ نگه می‌دارد.
      */
      this.server.on('upgrade', (req, socket, head) => {
        if (this.config.upgradeHandler) {
          this.config.upgradeHandler(req, socket, head as Buffer);
          return;
        }
        socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
        socket.destroy();
      });

      /*
      | ── transport داخلی (فاز ۶) ──────────────────────────────────────
      |
      | Gateway می‌تواند worker را روی یک Unix domain socket بالا بیاورد تا
      | هیچ پورت TCP دیگری روی ماشین باز نشود. روی socket،
      | `socket.remoteAddress` تعریف نشده است و `SecurityPipeline` همان‌جا
      | این را به‌عنوان اتصال local می‌شناسد.
      */
      const onListening = (): void => {
        const address = this.server?.address();
        if (typeof address === 'string') {
          resolve({ port: 0, host: address, url: `unix:${address}` });
          return;
        }
        const boundPort = address ? address.port : this.config.port;
        const boundHost = this.config.host;
        resolve({
          port: boundPort,
          host: boundHost,
          url: `http://${boundHost}:${boundPort}`,
        });
      };

      if (this.config.socketPath) {
        // SE-PORT-02 — روی Windows این به لولهٔ نام‌دار نگاشت می‌شود؛ لوله پوشه ندارد.
        const endpoint = socketEndpoint(this.config.socketPath);
        if (!isNamedPipe(endpoint)) {
          fs.mkdirSync(path.dirname(endpoint), { recursive: true });
        }
        this.server.listen(endpoint, onListening);
      } else {
        this.server.listen(this.config.port, this.config.host, onListening);
      }
    });
  }

  async stop(): Promise<void> {
    this.projects.dispose();
    this.sse.close();
    this.ws.close();
    if (this.runtimeDir) {
      await this.tracer.flush(path.join(this.runtimeDir, 'telemetry', 'spans.json'));
    }
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server?.close(() => resolve());
      });
      this.server = undefined;
    }
  }

  private authContext(auth: { authenticated: boolean; token?: string }): AuthContext {
    if (!auth.authenticated) {
      return {
        authenticated: false,
        permissions: [],
        resourceScope: '*',
      };
    }

    if (auth.token) {
      const record = this.apiKeyStore.verifyToken(auth.token);
      if (record) {
        return {
          authenticated: true,
          keyId: record.id,
          name: record.name,
          role: record.role,
          permissions: record.permissions,
          resourceScope: record.resourceScope,
          // F-0010 — فهرست صریح پروژه‌ها باید از gateway به پلتفرم هم برسد،
          // وگرنه پلتفرم فقط resourceScope تک‌پروژه را می‌بیند.
          ...(record.allowedProjects ? { allowedProjects: record.allowedProjects } : {}),
        };
      }
    }

    /* A locally constructed server without a token is an explicit local
       profile. The CLI always supplies a bootstrap token.

       F-0004 — ACCEPTED RISK (documented, not silently bypassed): when no
       `token` is configured the server grants a local Admin profile with
       `resourceScope:'*'`. This is deliberate and safe *because* of how the
       surface is bounded: the loopback guard (`SecurityPipeline` + `allowRemote
       = false` default) means only a process already on this machine can reach
       it, and the CLI/Gateway path always passes a real token so it never takes
       this branch. A `gatewayManaged` worker is explicitly denied the tokenless
       profile (see `requiresAuthentication` — every route needs the token).
       Owner has accepted this as a local-dev convenience; do NOT relax the
       loopback/managed bounds that make it safe.
    */
    if (this.config.gatewayManaged) {
      // Belt-and-braces: a managed worker must never fall back to Admin.
      return { authenticated: false, permissions: [], resourceScope: '*' };
    }
    return {
      authenticated: true,
      role: 'Admin',
      permissions: ROLE_DEFAULT_PERMISSIONS.Admin,
      resourceScope: '*',
    };
  }

  private defaultPermission(method: string): PermissionScope {
    return method === 'GET' ? 'project:read' : 'project:write';
  }

  /** در حالت managed، همهٔ روت‌ها توکن می‌خواهند. */
  private requiresAuthentication(route: RouteDefinition): boolean {
    if (this.config.gatewayManaged) return true;
    return route.requireAuth !== false;
  }

  /** روت‌های مدیریتی/مسیرپذیر که یک worker تک‌پروژه نباید داشته باشد. */
  private isManagedBlockedRoute(method: string, pathname: string): boolean {
    if (!this.config.gatewayManaged) return false;

    const blocked: readonly { method: string; pattern: RegExp }[] = [
      { method: 'POST', pattern: /^\/api\/v1\/projects$/ },
      { method: 'PATCH', pattern: /^\/api\/v1\/projects\/[^/]+$/ },
      { method: 'DELETE', pattern: /^\/api\/v1\/projects\/[^/]+$/ },
      { method: 'POST', pattern: /^\/api\/v1\/projects\/import-bundle$/ },
      { method: 'POST', pattern: /^\/api\/v1\/projects\/[^/]+\/source\/upload$/ },
    ];

    return blocked.some(entry => entry.method === method && entry.pattern.test(pathname));
  }

  /** کلیدهایی که مسیر می‌برند و در حالت managed بررسی می‌شوند. */
  private findForeignRoot(body: unknown): { key: string; value: string } | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

    const workspaceRoot = this.config.projectsRoot;
    if (!workspaceRoot) return null;

    const keys = ['path', 'rootPath', 'root', 'workspaceRoot', 'projectPath'] as const;
    const record = body as Record<string, unknown>;
    let allowedRoot: string;
    try {
      allowedRoot = fs.realpathSync(workspaceRoot);
    } catch {
      return null;
    }

    for (const key of keys) {
      const value = record[key];
      if (typeof value !== 'string' || value.trim() === '') continue;

      let resolved: string;
      try {
        resolved = fs.realpathSync(path.resolve(value));
      } catch {
        /* مسیر ناموجود: نمی‌تواند به پروژهٔ دیگری برسد، ولی در حالت managed
           اساساً پذیرفتنی نیست. */
        return { key, value };
      }

      if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) {
        return { key, value };
      }
    }

    return null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.security.applySecurityHeaders(res, req);

    /*
    | بررسی Origin پیش از preflight انجام می‌شود: یک `OPTIONS` که با
    | ۲۰۴ جواب بگیرد، به مرورگر می‌گوید ادامه بده.
    */
    const originCheck = this.security.checkOrigin(req);
    if (!originCheck.ok) {
      res.writeHead(originCheck.status || 403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: originCheck.error }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const connCheck = this.security.checkConnection(req);
    if (!connCheck.ok) {
      res.writeHead(connCheck.status || 403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: connCheck.error }));
      return;
    }

    /*
    | `url.parse` is deprecated (DEP0169). `new URL(req.url, base)` is not a
    | drop-in: it normalises `..` and treats `//host/x` as a host. The request
    | target is split by hand instead, so the pathname stays exactly as sent
    | (as before) and only the query goes through URLSearchParams.
    */
    /* Absolute-form targets (`GET http://host/x`, sent by proxies) reduce to their path. */
    const rawTarget = (req.url || '/').split('#')[0]!.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?]*/, '') || '/';
    const queryStart = rawTarget.indexOf('?');
    const pathname = (queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart)) || '/';
    const query: Record<string, string> = {};
    if (queryStart !== -1) {
      const search = new URLSearchParams(rawTarget.slice(queryStart + 1));
      for (const key of new Set(search.keys())) query[key] = search.get(key) ?? '';
    }

    const match = this.matchRoute(req.method || 'GET', pathname);
    if (!match) {
      // Attempt static file serving if GET and staticDir exists
      if (req.method === 'GET') {
        const served = await this.assets.serve(pathname, res);
        if (served) return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Route not found: ${req.method} ${pathname}` }));
      return;
    }

    const { route, params } = match;

    /*
    | ── حالت gateway-managed (فاز ۶) ───────────────────────────────────
    |
    | worker پشت Gateway یک پروژهٔ ثابت دارد، پس مدیریت پروژه‌ها کارِ
    | Gateway است نه او. روت‌هایی که می‌توانند پروژه اضافه/حذف کنند یا
    | مسیری دلخواه بپذیرند، با ۴۰۳ بسته می‌شوند.
    */
    if (this.isManagedBlockedRoute(req.method || 'GET', pathname)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `${req.method} ${pathname} is not available on a gateway-managed worker`,
        })
      );
      return;
    }

    /*
    | احراز هویت پیش‌فرض است؛ فقط مسیری که صریحاً `requireAuth: false`
    | نوشته باشد باز است. جزئیاتش در RouteDefinition. در حالت managed هیچ
    | استثنایی وجود ندارد: حتی `/health` بدون توکن داخلی جواب نمی‌گیرد.
    */
    const candidateAuth = this.security.authenticate(req, query.token);
    const apiKeyAuth =
      !candidateAuth.authenticated && candidateAuth.token
        ? this.apiKeyStore.verifyToken(candidateAuth.token)
        : null;
    const auth = apiKeyAuth
      ? { authenticated: true, token: candidateAuth.token }
      : candidateAuth;
    const authContext = this.authContext(auth);
    if (this.requiresAuthentication(route) && !auth.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: valid token is required' }));
      return;
    }

    let body: unknown = undefined;
    if (['POST', 'PUT', 'PATCH'].includes(req.method || '')) {
      try {
        body = await this.readBody(req, this.config.maxBodyBytes || 5 * 1024 * 1024);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
        return;
      }

      if (route.schema && body !== undefined) {
        const schemaValidation = this.security.validateSchema(route.schema, body);
        if (!schemaValidation.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Validation failed', details: schemaValidation.errors }));
          return;
        }
      }

      /*
      | در حالت managed، worker فقط به همان workspaceRoot که با آن بالا
      | آمده اجازه دارد؛ یک `path`/`rootPath` بیگانه در بدنهٔ درخواست یعنی
      | تلاش برای رسیدن به پروژهٔ دیگر.
      */
      if (this.config.gatewayManaged) {
        const foreign = this.findForeignRoot(body);
        if (foreign) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `${foreign.key} must stay inside this worker's workspace root`,
            })
          );
          return;
        }
      }
    }

    if (route.requireAuth !== false) {
      const permission =
        route.permission || this.defaultPermission(req.method || 'GET');
      const bodyProjectId =
        body && typeof body === 'object' && !Array.isArray(body)
          ? String((body as Record<string, unknown>).projectId || '')
          : '';
      const targetProjectId = params.id || bodyProjectId || undefined;
      const permissionCheck = PermissionChecker.hasPermission(
        authContext,
        permission,
        targetProjectId
      );

      if (!permissionCheck.allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: permissionCheck.reason || 'Forbidden' }));
        return;
      }
    }

    const context: HttpRequestContext = {
      req,
      res,
      method: req.method || 'GET',
      path: pathname,
      query,
      params,
      body,
      token: auth.token,
      authenticated: auth.authenticated,
      auth: authContext,
    };

    const responseData = await route.handler(context);

    if (responseData && !res.headersSent) {
      const status = responseData.status || 200;
      if (responseData.headers) {
        for (const [hName, hVal] of Object.entries(responseData.headers)) {
          res.setHeader(hName, hVal);
        }
      }

      if (responseData.json !== undefined) {
        const masked = this.security.maskSecrets(responseData.json);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(masked));
      } else if (responseData.text !== undefined) {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(responseData.text);
      } else {
        res.writeHead(status);
        res.end();
      }
    }
  }

  private matchRoute(method: string, pathname: string): { route: RouteDefinition; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      const params = this.matchPattern(route.pattern, pathname);
      if (params !== null) {
        return { route, params };
      }
    }
    return null;
  }

  private matchPattern(pattern: string, pathname: string): Record<string, string> | null {
    return matchPattern(pattern, pathname);
  }

  private readBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
    return readBody(req, maxBytes);
  }

  /*
  | SE-PERF-01 — این تابع برای هر دارایی ایستا (html، css، js، فونت)
  | پنج `existsSync` می‌زد تا پوشه را پیدا کند، بعد `statSync` و بعد
  | کل فایل را همگام می‌خواند. هر کدام از این‌ها event loop را نگه
  | می‌داشت، و بارگذاری یک صفحه ده‌ها بار صدایش می‌زند.
  |
  | مسیر پوشه یک بار پیدا و کش می‌شود، و خواندن فایل ناهمگام است.
  */
}
