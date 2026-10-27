/**
 * `semantic-engine worker` — فاز ۷.
 *
 * One process, one project. This is the unit the Gateway supervises (فاز ۸),
 * and it is also useful on its own: a worker started by hand serves the same
 * REST surface plus the `/internal/*` endpoints, with no Gateway involved.
 *
 * What it owns:
 *
 *   - the artifact paths, through `projectPathsFromArgs` (never re-derived);
 *   - the platform HTTP server, on a Unix socket or a loopback port;
 *   - an optional `watch` child, so the index stays fresh;
 *   - the internal lifecycle surface: health, ready, metrics, status,
 *     reindex, reload, shutdown.
 *
 * Readiness is honest: until an index is loaded, `/internal/ready` answers 503,
 * which is what lets the Gateway wait for a worker instead of guessing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { runIndex } from './index-command';
import { artifactLocationFromArgs, projectPathsFromArgs } from '../projectPathsFromArgs';
import { DEFAULT_HOST, generateToken } from '../HttpGuard';
import { spawnService, stopChild, StartedChild } from './serviceSupervisor';
import type { HttpServer } from '../../server/HttpServer';
import { SemanticEngineMcpServer } from '../../ai/mcp/SemanticEngineMcpServer';
import { loadBlueprintBeside } from '../../ai/discovery/loadBlueprint';
import type { RouteDefinition } from '../../server/types';
import { ProjectWebSocketChannel } from '../../server/wsProjectChannel';
import { cpuPercent } from '../../gateway/metrics';

interface WorkerStatus {
  readonly ok: boolean;
  readonly projectId: string;
  readonly pid: number;
  readonly state: 'starting' | 'ready' | 'degraded';
  readonly indexState: 'fresh' | 'missing' | 'stale';
  readonly watcher: 'running' | 'stopped';
  readonly files: number;
  readonly symbols: number;
  readonly dependencies: number;
  readonly vectorChunks: number;
  readonly blueprint: boolean;
  readonly memoryMb: number;
  readonly queueSize: number;
  readonly lastIndexedAt?: string;
  /** Why the index is `stale`: the real load error, so a 503 is never unexplained. */
  readonly indexError?: string;
  /**
   * Language-server diagnostics: whether the pass is switched on for this
   * worker, and what the last run found. `run` is absent when the index has
   * never been through the pass.
   */
  readonly lsp: {
    readonly enabled: boolean;
    readonly run?: { filesWithFindings: number; filesSkippedByBudget: number; budgetMs: number; completedAt?: string };
  };
}

/*
| The watch child used to get only root/project-id/data-dir/out, so every indexing option of the
| worker (vectors, git, blueprint mode, debounce, scan and embedding flags, …) was silently
| dropped for the part of the worker that keeps the index fresh. These are passed through.
*/
const FORWARDED_BOOLEAN_OPTIONS = [
  'vectors', 'blueprint', 'git', 'treeSitter', 'pretty', 'lspDiagnostics', 'gitignore',
  'skipHidden', 'embeddingNormalize',
] as const;
const FORWARDED_VALUE_OPTIONS = [
  'debounce', 'blueprintMode', 'diagnosticsBudget', 'embeddingProvider', 'embeddingModel',
  'embeddingBaseUrl', 'embeddingApiKeyEnv', 'maxDepth', 'maxFileSizeMb', 'ignore', 'artifactLocation',
] as const;

const kebab = (name: string): string => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

export function forwardedWatchFlags(options: ParsedArgs['options']): string[] {
  const flags: string[] = [];
  for (const name of FORWARDED_BOOLEAN_OPTIONS) {
    if (name in options) flags.push(boolOption(options, name, true) ? `--${kebab(name)}` : `--no-${kebab(name)}`);
  }
  for (const name of FORWARDED_VALUE_OPTIONS) {
    const value = stringOption(options, name);
    if (value !== undefined) flags.push(`--${kebab(name)}`, value);
  }
  return flags;
}

export async function runWorker(
  args: ParsedArgs,
  context: CommandContext
): Promise<CommandResult> {
  const root = stringOption(args.options, 'root') ?? context.cwd;
  const paths = projectPathsFromArgs(args, root);

  if (!fs.existsSync(paths.workspaceRoot) || !fs.statSync(paths.workspaceRoot).isDirectory()) {
    return {
      code: EXIT.failure,
      error: `--root does not exist or is not a directory: ${paths.workspaceRoot}`,
    };
  }

  const socketPath = stringOption(args.options, 'socket');
  const rawPort = stringOption(args.options, 'port');
  const port = rawPort === undefined ? 0 : Number(rawPort);
  if (rawPort !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    return { code: EXIT.usage, error: '--port must be a number between 0 and 65535' };
  }

  const host = stringOption(args.options, 'host') ?? DEFAULT_HOST;
  const gatewayManaged = boolOption(args.options, 'gatewayManaged', false);
  /*
  | ترتیب منبع توکن: flag صریح، بعد متغیری که supervisor ست می‌کند
  | (`SEMANTIC_ENGINE_WORKER_TOKEN`)، بعد متغیر عمومی، و در نهایت یک توکن
  | تصادفی. توکن هرگز از خط فرمانِ supervisor نمی‌آید (فاز ۶).
  */
  const token =
    stringOption(args.options, 'token') ??
    process.env['SEMANTIC_ENGINE_WORKER_TOKEN'] ??
    process.env['SEMANTIC_ENGINE_TOKEN'] ??
    generateToken();

  /* Index on start unless told not to: a worker with no index is not ready,
     and the Gateway would just wait for a 503 forever. */
  if (!fs.existsSync(paths.indexPath) && !boolOption(args.options, 'skipInitialIndex', false)) {
    const indexed = await runIndex(args, context);
    if (indexed.code !== EXIT.ok) return indexed;
  }

  /*
  | ── WebSocket روی مسیر `/ws` (فاز ۱۱) ─────────────────────────────────
  |
  | worker تک‌پروژه است، پس binding ساختاری است: یک کانال، یک projectId، و
  | هر فریم همان id را با خود می‌برد. توکن از هدر `Authorization` یا
  | `?token=` می‌آید — مرورگر روی WebSocket نمی‌تواند هدر ست کند.
  */
  const wsChannel = new ProjectWebSocketChannel({
    projectId: paths.projectId,
    onEvent: event => context.logger.debug('worker ws', event),
  });

  const upgradeHandler = (
    req: import('http').IncomingMessage,
    socket: import('stream').Duplex,
    head: Buffer
  ): void => {
    const url = new URL(req.url ?? '/', 'http://worker.local');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const header = req.headers['authorization'];
    const fromHeader =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const candidate = fromHeader !== '' ? fromHeader : url.searchParams.get('token') ?? '';
    if (candidate !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wsChannel.handleUpgrade(req, socket, head);
  };

  const { HttpServer: PlatformServer } = require('../../server/HttpServer') as typeof import('../../server/HttpServer');
  const server: HttpServer = new PlatformServer({
    port,
    host,
    token,
    projectsRoot: paths.workspaceRoot,
    projectId: paths.projectId,
    dataRoot: paths.dataRoot,
    artifactLocation: artifactLocationFromArgs(args, process.env),
    upgradeHandler,
    ...(socketPath !== undefined ? { socketPath } : {}),
    ...(gatewayManaged ? { gatewayManaged: true } : {}),
  });

  const project = server.projects.registerProject(
    paths.workspaceRoot,
    paths.projectId,
    path.basename(paths.workspaceRoot)
  );

  const startedAt = Date.now();
  let watcher: StartedChild | null = null;
  let reindexing = false;
  /* سنجه‌های فاز ۱۳ — چیزی که فقط این پروسه می‌داند. */
  let activeRequests = 0;
  let indexDurationMs = 0;
  let indexFailures = 0;
  const restartCount = Number(process.env['SEMANTIC_ENGINE_WORKER_RESTART_COUNT'] ?? 0);

  const lspEnabled = boolOption(args.options, 'lspDiagnostics', false);
  const status = (): WorkerStatus => {
    const current = server.projects.getProject(paths.projectId);
    const stats = current?.stats;
    const indexState: WorkerStatus['indexState'] = !current || current.status === 'missing'
      ? 'missing'
      : current.status === 'stale'
        ? 'stale'
        : 'fresh';

    return {
      ok: indexState === 'fresh',
      projectId: paths.projectId,
      pid: process.pid,
      state: indexState === 'fresh' ? 'ready' : indexState === 'stale' ? 'degraded' : 'starting',
      indexState,
      watcher: watcher && watcher.child.exitCode === null ? 'running' : 'stopped',
      files: stats?.filesCount ?? 0,
      symbols: stats?.symbolsCount ?? 0,
      dependencies: stats?.dependenciesCount ?? 0,
      vectorChunks: current?.index?.vectorChunks?.length ?? 0,
      blueprint: Boolean(current?.blueprint),
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      queueSize: reindexing ? 1 : 0,
      lsp: {
        enabled: lspEnabled,
        ...(current?.index?.diagnosticsRun ? { run: { ...current.index.diagnosticsRun } } : {}),
      },
      ...(stats?.lastIndexedAt !== undefined ? { lastIndexedAt: stats.lastIndexedAt } : {}),
      ...(current?.loadError !== undefined ? { indexError: current.loadError } : {}),
    };
  };

  let requestShutdown: (result: CommandResult) => void = () => undefined;

  const internalRoutes: RouteDefinition[] = [
    {
      method: 'GET',
      pattern: '/internal/health',
      permission: 'project:read',
      handler: async () => {
        const snapshot = status();
        return { status: snapshot.ok ? 200 : 503, json: snapshot };
      },
    },
    {
      method: 'GET',
      pattern: '/internal/status',
      permission: 'project:read',
      handler: async () => {
        const snapshot = status();
        return { status: snapshot.ok ? 200 : 503, json: snapshot };
      },
    },
    {
      method: 'GET',
      pattern: '/internal/ready',
      permission: 'project:read',
      handler: async () => {
        const snapshot = status();
        /* تا وقتی ایندکس load نشده، «آماده» یعنی دروغ. */
        return {
          status: snapshot.indexState === 'fresh' ? 200 : 503,
          json: { ready: snapshot.indexState === 'fresh', ...snapshot },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/internal/metrics',
      permission: 'project:read',
      handler: async () => {
        const snapshot = status();
        return {
          status: 200,
          json: {
            worker_uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
            worker_memory_bytes: process.memoryUsage().rss,
            worker_cpu_percent: cpuPercent(process.cpuUsage(), Date.now() - startedAt),
            worker_active_requests: activeRequests,
            worker_queue_size: snapshot.queueSize,
            worker_index_duration_ms: indexDurationMs,
            worker_index_failures_total: indexFailures,
            worker_files_total: snapshot.files,
            worker_symbols_total: snapshot.symbols,
            worker_dependencies_total: snapshot.dependencies,
            worker_vector_chunks_total: snapshot.vectorChunks,
            worker_restart_count: Number.isFinite(restartCount) ? restartCount : 0,
            worker_index_state: snapshot.indexState,
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/internal/reindex',
      permission: 'semantic:index',
      handler: async () => {
        if (reindexing) {
          return { status: 409, json: { ok: false, error: 'an index run is already in progress' } };
        }
        reindexing = true;
        const reindexStartedAt = Date.now();
        void runIndex(args, context)
          .then(result => {
            indexDurationMs = Date.now() - reindexStartedAt;
            if (result.code !== EXIT.ok) indexFailures += 1;
            return server.projects.reloadProject(paths.projectId);
          })
          .catch(() => {
            indexDurationMs = Date.now() - reindexStartedAt;
            indexFailures += 1;
          })
          .finally(() => {
            reindexing = false;
          });
        return { status: 202, json: { ok: true, started: true, projectId: paths.projectId } };
      },
    },
    {
      method: 'POST',
      pattern: '/internal/reload',
      permission: 'semantic:index',
      handler: async () => {
        const reloaded = server.projects.reloadProject(paths.projectId);
        return {
          status: reloaded ? 200 : 404,
          json: { ok: Boolean(reloaded), projectId: paths.projectId, state: status().state },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/internal/shutdown',
      permission: 'project:write',
      handler: async () => {
        /* پاسخ اول، خاموشی بعد: کلاینت باید بداند دستور رسیده است. */
        setImmediate(() =>
          requestShutdown({
            code: EXIT.ok,
            json: { ok: true, shutdown: true, projectId: paths.projectId },
            text: 'worker stopped',
          })
        );
        return { status: 200, json: { ok: true, shuttingDown: true } };
      },
    },
  ];

  for (const route of internalRoutes) server.addRoute(route);

  /*
  | ── MCP روی همان socket (فاز ۱۰) ─────────────────────────────────────
  |
  | یک transport به ازای هر درخواست، همان الگویی که `ai/mcp/cli.ts` دارد:
  | اشتراک گذاشتن یک transport بین درخواست‌ها یعنی مسابقه روی یک شیء.
  | `projectId` و `indexPath` داده می‌شوند تا پاسخ‌ها `structuredContent`
  | با `projectId` و `indexGeneration` داشته باشند (فاز ۷).
  */
  server.addRoute({
    method: 'POST',
    pattern: '/mcp',
    permission: 'semantic:query',
    handler: async ctx => {
      const { StreamableHTTPServerTransport } = await import(
        '@modelcontextprotocol/sdk/server/streamableHttp.js'
      );

      const projectIndex = JSON.parse(fs.readFileSync(paths.indexPath, 'utf8')) as import(
        '../../core/types/project-index.types'
      ).ProjectIndex;
      const blueprint = loadBlueprintBeside(paths.indexPath).index;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      /*
       | فاز ۳ (D-0021): پرچم‌های آزمایشی host صریح‌اند — یا از `--experimental`
       | (مثل entry point مستقل MCP) یا از محیط `SEMANTIC_ENGINE_EXPERIMENTAL`
       | برای workerهایی که Gateway بالا می‌آورد و argvشان را کنترل نمی‌کند.
       | نام ناشناخته همان‌جا دور انداخته می‌شود تا typo چیزی را بی‌صدا روشن نکند.
       */
      const knownExperimental = new Set(['semantic-graph', 'controlled-expansion']);
      const experimentalNames = [
        ...(stringOption(args.options, 'experimental') ?? '').split(','),
        ...(process.env['SEMANTIC_ENGINE_EXPERIMENTAL'] ?? '').split(','),
      ].map(name => name.trim()).filter(name => knownExperimental.has(name));
      const experimental: Record<string, boolean> | undefined = experimentalNames.length
        ? Object.fromEntries(experimentalNames.map(name => [name, true]))
        : undefined;
      const mcpServer = new SemanticEngineMcpServer({
        projectIndex,
        workspaceRoot: paths.workspaceRoot,
        projectId: paths.projectId,
        indexPath: paths.indexPath,
        ...(blueprint ? { blueprint } : {}),
        ...(experimental ? { experimental } : {}),
      });
      await mcpServer.connectTransport(transport);

      activeRequests += 1;
      try {
        await transport.handleRequest(ctx.req, ctx.res, ctx.body);
      } finally {
        activeRequests -= 1;
        await transport.close?.();
        await mcpServer.close();
      }
    },
  });

  const info = await server.start();
  context.logger.info('worker listening', {
    url: info.url,
    projectId: project.id,
    artifactRoot: paths.artifactRoot,
    indexState: status().indexState,
  });

  /* Watcher اختیاری است؛ `--no-watch` دقیقاً همان معنای `serve` را دارد. */
  if (boolOption(args.options, 'watch', true)) {
    try {
      watcher = spawnService(
        [
          'watch',
          '--root',
          paths.workspaceRoot,
          '--project-id',
          paths.projectId,
          '--data-dir',
          paths.dataRoot,
          '--out',
          paths.artifactRoot,
          '--skip-initial-index',
          ...forwardedWatchFlags(args.options),
        ],
        /press Ctrl\+C/,
        paths.workspaceRoot
      );
      await watcher.ready;
    } catch {
      /* نبود watcher نباید worker را از سرویس دادن بیندازد. */
      watcher = null;
    }
  }

  const onSignal = (signal: NodeJS.Signals): void => {
    requestShutdown({
      code: EXIT.ok,
      json: { ok: true, shutdown: true, signal, projectId: paths.projectId },
      text: `worker stopped (${signal})`,
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const result = await new Promise<CommandResult>(resolve => {
    requestShutdown = resolve;
  });

  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  if (watcher) await stopChild(watcher.child);
  wsChannel.close();
  await server.stop();
  if (socketPath) {
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      /* فایل socket ممکن است از قبل برداشته شده باشد. */
    }
  }

  context.logger.info('worker stopped', { projectId: paths.projectId, url: info.url });
  return result;
}
