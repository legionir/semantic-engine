/**
 * `semantic-engine serve` — MIG-54، SE-SEC-03.
 *
 * `--stdio` پیش‌فرض است چون کلاینت MCP همان را می‌خواهد و هیچ سطح
 * حمله‌ای باز نمی‌کند. `--http` وجود دارد چون گاهی لازم است، ولی با
 * چهار مهاری که نسخهٔ قبلی هیچ‌کدام را نداشت.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { ProjectIndex } from '../../core/types/project-index.types';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import {
  normalizeWorkspaceRoot,
  resolveProjectIndexPath,
  workspaceRootFromIndex,
} from '../../core/config/ProjectPaths';
import { spawnService, stopChild, waitForShutdown } from './serviceSupervisor';
import { loadBlueprintBeside } from '../../ai/discovery/loadBlueprint';
import { migrateLegacyArtifacts } from '../../core/config/migrateLegacyArtifacts';
import { resolveDataRoot } from '../../core/config/DataRootResolver';
import { artifactLocationFromArgs, indexLookupFromArgs, projectIdFromArgs } from '../projectPathsFromArgs';
import {
  HttpGuard,
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  generateToken,
  isLoopbackHost,
} from '../HttpGuard';

export function resolveIndexPath(args: ParsedArgs, cwd: string): string {
  const root = normalizeWorkspaceRoot(stringOption(args.options, 'root') ?? cwd);
  const lookup = indexLookupFromArgs(args, root);

  /*
  | وقتی artifact بیرون از root نگه داشته می‌شود، ایندکس قدیمیِ داخل root یک
  | بار کپی می‌شود تا از دست نرود؛ در حالت پیش‌فرض `in-root` این فراخوانی
  | عمداً هیچ کاری نمی‌کند.
  */
  migrateLegacyArtifacts({
    workspaceRoot: root,
    projectId: lookup.projectId ?? '',
    location: lookup.location,
    ...(lookup.dataRoot !== undefined ? { dataRoot: lookup.dataRoot } : {}),
  });

  return resolveProjectIndexPath(root, stringOption(args.options, 'index'), lookup);
}

export function loadIndex(indexPath: string): ProjectIndex | { error: string } {
  if (!fs.existsSync(indexPath)) {
    return {
      error:
        `index not found: ${indexPath}\n` +
        `run "semantic-engine index" first, or pass --index <path>`,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex;
  } catch (error) {
    return {
      error: `index is not readable JSON: ${indexPath}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function runServe(args: ParsedArgs, context: CommandContext): Promise<CommandResult> {
  const wantsWeb = boolOption(args.options, 'web', false) || boolOption(args.options, 'ui', false);
  const wantsPlatform = boolOption(args.options, 'platform', false) || boolOption(args.options, 'api', false) || wantsWeb;
  const wantsHttp = boolOption(args.options, 'http', false);

  if (wantsHttp || wantsPlatform) {
    const invalid = validateHttpOptions(args);
    if (invalid) return invalid;
  }

  const indexPath = resolveIndexPath(args, context.cwd);
  const loaded = loadIndex(indexPath);
  if ('error' in loaded) return { code: EXIT.failure, error: loaded.error };

  /* An explicit --root is authoritative. The embedded rootPath belongs to
     the machine that created the index and may be stale after a project is
     moved or checked out elsewhere. */
  const requestedRoot = stringOption(args.options, 'root');
  const workspaceRoot = requestedRoot
    ? normalizeWorkspaceRoot(requestedRoot)
    : workspaceRootFromIndex(loaded, indexPath);

  if (wantsPlatform) return runPlatform(loaded, workspaceRoot, args, context, indexPath);
  if (wantsHttp) return runHttp(loaded, workspaceRoot, args, context, indexPath);
  return runStdio(loaded, workspaceRoot, indexPath, args);
}

export async function runUi(args: ParsedArgs, context: CommandContext): Promise<CommandResult> {
  const invalid = validateHttpOptions(args);
  if (invalid) return invalid;

  /*
  | SE-UI-01: نسخهٔ قبلی این‌جا `loadIndex` را اجباری می‌کرد و اگر
  | `project-index.json` نبود با «run semantic-engine index first»
  | خارج می‌شد — یعنی UI هیچ‌وقت بالا نمی‌آمد تا کاربر بتواند از
  | داخلش پروژه باز کند و ایندکس بگیرد. حالا UI همیشه بالا می‌آید:
  | اگر ایندکس بود بارگذاری می‌شود، وگرنه با یک حالت خالی شروع
  | می‌کند و کاربر از خود UI پروژه را باز/ایندکس می‌کند.
  */
  const indexPath = resolveIndexPath(args, context.cwd);
  const loaded = loadIndex(indexPath);
  const hasIndex = !('error' in loaded);

  const rootOption = stringOption(args.options, 'root');
  const rootRoot = normalizeWorkspaceRoot(rootOption ?? context.cwd);
  const workspaceRoot = hasIndex
    ? rootOption
      ? rootRoot
      : workspaceRootFromIndex(loaded as ProjectIndex, indexPath)
    : rootRoot;

  return runPlatform(hasIndex ? (loaded as ProjectIndex) : null, workspaceRoot, args, context, indexPath);
}

/** بررسی‌های ارزانِ خط فرمان — هیچ‌کدام به دیسک دست نمی‌زنند. */
export function validateHttpOptions(args: ParsedArgs): CommandResult | null {
  const rawPort = stringOption(args.options, 'port');
  if (rawPort !== undefined) {
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { code: EXIT.usage, error: `--port must be a number between 0 and 65535` };
    }
  }

  const host = stringOption(args.options, 'host') ?? DEFAULT_HOST;
  if (!isLoopbackHost(host) && !boolOption(args.options, 'allowRemote', false)) {
    return {
      code: EXIT.usage,
      error:
        `refusing to bind ${host}: that exposes the whole index to the network.\n` +
        `pass --allow-remote if you really mean it, and set a strong --token.`,
    };
  }

  return null;
}

async function runPlatform(
  projectIndex: ProjectIndex | null,
  workspaceRoot: string,
  args: ParsedArgs,
  context: CommandContext,
  indexPath: string
): Promise<CommandResult> {
  const port = Number(stringOption(args.options, 'port') ?? 4000);
  const host = stringOption(args.options, 'host') ?? DEFAULT_HOST;
  const provided = stringOption(args.options, 'token') ?? process.env['SEMANTIC_ENGINE_TOKEN'];
  if (boolOption(args.options, 'allowRemote', false) && !provided) {
    return {
      code: EXIT.usage,
      error: 'remote platform mode requires --token or SEMANTIC_ENGINE_TOKEN',
    };
  }
  const token = provided ?? generateToken();

  /*
  | F-0021 — مدل embedding واقعی که این پروسه استفاده می‌کند را از flag
  | `--embedding-model` می‌خوانیم تا `/config` همان را گزارش دهد. هیچ
  | generator نمی‌سازیم (ساختن potentialاً مدل دانلود می‌کند). اگر کاربر مدلی
  | نداده باشد null است و `/config` صادقانه null نشان می‌دهد — دیگر مقدار
  | ثابتِ حدسی (`Qwen3-Embedding-0.6B`) در سرور نوشته نمی‌شود.
  */
  const embeddingModel = stringOption(args.options, 'embeddingModel') ?? null;


  const artifactProjectId = projectIdFromArgs(args, workspaceRoot);
  const { HttpServer } = require('../../server/HttpServer') as typeof import('../../server/HttpServer');
  const server = new HttpServer({
    port,
    host,
    token,
    allowRemote: boolOption(args.options, 'allowRemote', false),
    projectsRoot: workspaceRoot,
    projectId: artifactProjectId,
    embeddingModel,
    /*
    | state پروسه (صف jobها و telemetry) دیگر داخل checkout نوشته نمی‌شود؛
    | جای آن data directory کاربر است. `resolveDataRoot` چیزی روی دیسک
    | نمی‌سازد، پس اگر هرگز job اجرا نشود فایلی هم ساخته نمی‌شود.
    */
    dataRoot: resolveDataRoot({
      ...(stringOption(args.options, 'dataDir') ? { dataDir: stringOption(args.options, 'dataDir')! } : {}),
      env: process.env,
    }),
    artifactLocation: artifactLocationFromArgs(args, process.env),
  });

  const started = await server.start();

  /*
  | همیشه پروژهٔ ریشه را ثبت می‌کنیم تا از UI قابل باز/ایندکس‌شدن
  | باشد. `registerProject` خودش تشخیص می‌دهد که ایندکس هست یا نه و
  | status را روی `ready` یا `missing` می‌گذارد؛ پس چه ایندکس داشته
  | باشیم چه نه، پروژه در لیست UI ظاهر می‌شود.
  */
  const projName = path.basename(workspaceRoot);
  const projId = projName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  /* The artifact id comes first so the registry's per-project folder is the
     same folder the index is written to; the display ids are aliases. */
  server.projects.registerProject(workspaceRoot, artifactProjectId, projName);
  /*
  | The display aliases are a convenience. Two checkouts that share a folder
  | name (`client-a/app`, `client-b/app`) would collide on `app`, and that
  | collision used to abort startup — the UI never came up. A refused alias is
  | skipped; the project stays reachable by its artifact id and `current`.
  */
  for (const alias of [projId, `prj-${projId}`]) {
    try {
      server.projects.registerProject(workspaceRoot, alias, projName);
    } catch (error) {
      context.logger.warn('project alias skipped', {
        alias,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const current = server.projects.registerProject(workspaceRoot, 'current', projName);
  const resumedJobs = await server.jobs.resumeInterruptedJobs();

  const watcher = projectIndex && boolOption(args.options, 'watch', true)
    ? spawnService(
        ['watch', '--root', workspaceRoot, '--out', path.dirname(indexPath), '--skip-initial-index'],
        /press Ctrl\+C to stop/,
        workspaceRoot
      )
    : null;
  try {
    if (watcher) await watcher.ready;
  } catch (error) {
    if (watcher) await stopChild(watcher.child);
    await server.stop();
    return {
      code: EXIT.failure,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  context.logger.info('platform http server listening', {
    url: started.url,
    tokenSource: provided ? 'provided' : 'generated',
    indexPresent: Boolean(projectIndex) || current.status === 'ready',
    resumedJobs,
  });

  const shutdown = waitForShutdown(async () => {
    await server.stop();
    if (watcher) await stopChild(watcher.child);
  });

  const indexHint =
    current.status === 'ready'
      ? `   • Loaded index:       ${current.stats.filesCount} files, ${current.stats.symbolsCount} symbols\n`
      : `   • No index yet:       open a project and run indexing from the UI\n`;

  process.stderr.write(
    `\n🚀 Semantic Engine Standalone Web & Platform Server\n` +
      `   • Web Visualizer UI:  ${started.url}/\n` +
      `   • Open / Configure:   ${started.url}/open.html\n` +
      `   • REST & LoD APIs:    ${started.url}/api/v1/...\n` +
      `   • V2 Enterprise APIs: ${started.url}/api/v2/...\n` +
      `   • Health & Metrics:   ${started.url}/health, ${started.url}/metrics\n` +
      indexHint +
      `   • Active Token:       ${token}\n` +
      (provided ? '' : '     (pass --token or SEMANTIC_ENGINE_TOKEN to configure static token)\n\n')
  );

  await shutdown;
  return { code: EXIT.ok };
}

async function runStdio(
  projectIndex: ProjectIndex,
  workspaceRoot: string,
  indexPath: string,
  args: ParsedArgs
): Promise<CommandResult> {
  /*
    | بارگذاری تنبل — همان دلیل transformers: کسی که فقط
    | `index` می‌زند نباید SDK مربوط به MCP را بار کند.
  */

  const { SemanticEngineMcpServer } = require('../../ai/mcp/SemanticEngineMcpServer') as {
    SemanticEngineMcpServer: new (options: {
      projectIndex: ProjectIndex;
      workspaceRoot: string;
      blueprint?: import('../../ai/discovery/BlueprintIndex').BlueprintIndex;
    }) => {
      start(): Promise<void>;
      watchIndexFile(indexPath: string): void;
      close(): Promise<void>;
    };
  };

  const loadedBlueprint = loadBlueprintBeside(indexPath).index;
  const server = new SemanticEngineMcpServer({
    projectIndex,
    workspaceRoot,
    ...(loadedBlueprint ? { blueprint: loadedBlueprint } : {}),
  });
  server.watchIndexFile(indexPath);

  const watcher = boolOption(args.options, 'watch', true)
    ? spawnService(
        ['watch', '--root', workspaceRoot, '--out', path.dirname(indexPath), '--skip-initial-index'],
        /press Ctrl\+C to stop/,
        workspaceRoot
      )
    : null;

  try {
    if (watcher) await watcher.ready;
    await server.start();
  } finally {
    if (watcher) await stopChild(watcher.child);
    await server.close();
  }
  /*
  | `start()` تا وقتی stdin باز است برنمی‌گردد. رسیدن به این‌جا یعنی
  | کلاینت قطع کرده — یک خاموشی عادی.
  */
  return { code: EXIT.ok };
}

async function runHttp(
  projectIndex: ProjectIndex,
  workspaceRoot: string,
  args: ParsedArgs,
  context: CommandContext,
  indexPath: string
): Promise<CommandResult> {
  /*
  | SE-SEC-03: نسخهٔ قبلی `listen(port)` بدون host می‌زد، یعنی روی
  | `0.0.0.0`. اندازه‌گیری‌شده در همین sandbox: در دسترس روی
  | `eth0:169.254.0.21`. حالا پیش‌فرض loopback است و `validateHttpOptions`
  | خروج از آن را یک تصمیم صریح کرده.
  */
  const port = Number(stringOption(args.options, 'port') ?? 3000);
  const host = stringOption(args.options, 'host') ?? DEFAULT_HOST;

  /*
  | توکن اجباری است. اگر داده نشود ساخته و چاپ می‌شود — «فراموش
  | کردم توکن بدهم» نباید به «سرور بی‌محافظ» ترجمه شود.
  */
  const provided = stringOption(args.options, 'token') ?? process.env['SEMANTIC_ENGINE_TOKEN'];
  if (boolOption(args.options, 'allowRemote', false) && !provided) {
    return {
      code: EXIT.usage,
      error: 'remote MCP HTTP mode requires --token or SEMANTIC_ENGINE_TOKEN',
    };
  }
  const token = provided ?? generateToken();

  const maxBodyBytes = Number(
    stringOption(args.options, 'maxBody') ?? DEFAULT_MAX_BODY_BYTES
  );
  const guard = new HttpGuard({ token, maxBodyBytes, path: '/mcp' });


  const { SemanticEngineMcpServer } = require('../../ai/mcp/SemanticEngineMcpServer') as {
    SemanticEngineMcpServer: new (options: {
      projectIndex: ProjectIndex;
      workspaceRoot: string;
      blueprint?: import('../../ai/discovery/BlueprintIndex').BlueprintIndex;
    }) => {
      connectTransport(transport: unknown): Promise<void>;
      close(): Promise<void>;
    };
  };
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  const watcher = boolOption(args.options, 'watch', true)
    ? spawnService(
        ['watch', '--root', workspaceRoot, '--out', path.dirname(indexPath), '--skip-initial-index'],
        /press Ctrl\+C to stop/,
        workspaceRoot
      )
    : null;

  const server = http.createServer((request, response) => {
    void guard.handle(request, response, async body => {
      /*
      | SE-SEC-03: نسخهٔ قبلی یک `transport` مشترک بین همهٔ
      | درخواست‌ها نگه می‌داشت و «stateless» می‌نامیدش. دو درخواست
      | هم‌زمان روی همان شیء مسابقه می‌دادند. یک transport به ازای
      | هر درخواست، همان چیزی است که «stateless» یعنی.
      |
      | index را در هر request از روی دیسک می‌خوانیم تا watcherِ جداگانه
      | بتواند بدون restart دادهٔ MCP را تازه کند. اگر write اتمیک هنوز
      | در حال تعویض فایل باشد، snapshot قبلی امن‌تر از خطای موقت است.
      */
      const loadedCurrent = loadIndex(indexPath);
      const currentIndex = 'error' in loadedCurrent ? projectIndex : loadedCurrent;
      const currentBlueprint = loadBlueprintBeside(indexPath).index;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcp = new SemanticEngineMcpServer({
        projectIndex: currentIndex,
        workspaceRoot,
        ...(currentBlueprint ? { blueprint: currentBlueprint } : {}),
      });
      await mcp.connectTransport(transport);

      try {
        await transport.handleRequest(request, response, JSON.parse(body));
      } finally {
        await transport.close?.();
        await mcp.close();
      }
    });
  });

  try {
    if (watcher) await watcher.ready;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    if (watcher) await stopChild(watcher.child);
    throw error;
  }

  const actual = server.address();
  const boundPort = typeof actual === 'object' && actual ? actual.port : port;

  /*
  | آدرس و توکن روی stderr می‌روند، نه stdout: در حالت `--json` هم
  | باید بشود این‌ها را دید بدون اینکه خروجی داده خراب شود.
  */
  context.logger.info('mcp http server listening', {
    url: `http://${host}:${boundPort}/mcp`,
    tokenSource: provided ? 'provided' : 'generated',
  });
  /*
  | همان ترتیبی که فاز ۴۹ در `watch` اصلاح کرد: handler پیش از
  | اعلام آمادگی. سروری که آدرسش را چاپ کرده ولی هنوز Ctrl+C را
  | نمی‌فهمد، به کاربر دروغ گفته است.
  */
  const shutdown = waitForShutdown(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (watcher) await stopChild(watcher.child);
  });

  process.stderr.write(
    `MCP server on http://${host}:${boundPort}/mcp\n` +
      `token: ${token}\n` +
      (provided ? '' : '(generated — pass --token or SEMANTIC_ENGINE_TOKEN to pin it)\n')
  );

  await shutdown;
  return { code: EXIT.ok };
}
