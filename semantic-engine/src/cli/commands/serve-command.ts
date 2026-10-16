/**
 * `semantic-engine serve` — MIG-54، SE-SEC-03.
 *
 * `--stdio` پیش‌فرض است چون کلاینت MCP همان را می‌خواهد و هیچ سطح
 * حمله‌ای باز نمی‌کند. `--http` وجود دارد چون گاهی لازم است، ولی با
 * چهار مهاری که نسخهٔ قبلی هیچ‌کدام را نداشت.
 */

import * as fs from 'fs';
import * as http from 'http';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { ProjectIndex } from '../../core/types/project-index.types';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { runIndex } from './index-command';
import { INDEX_FILE_NAME } from '../../pipeline/OutputWriter';
import {
  normalizeWorkspaceRoot,
  resolveProjectIndexPath,
  workspaceRootFromIndex,
} from '../../core/config/ProjectPaths';
import { loadBlueprintBeside } from '../../ai/discovery/loadBlueprint';
import { migrateLegacyArtifacts } from '../../core/config/migrateLegacyArtifacts';
import { resolveDataRoot } from '../../core/config/DataRootResolver';
import { globalConfigPath } from '../../core/config/GlobalConfig';
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
function validateHttpOptions(args: ParsedArgs): CommandResult | null {
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

/** Resolve the output selected by `index --out`, without guessing another root. */
function startIndexPath(args: ParsedArgs, root: string): string {
  const explicit = stringOption(args.options, 'index');
  if (explicit) return path.resolve(explicit);

  const output = stringOption(args.options, 'out');
  return output
    ? path.resolve(root, output, INDEX_FILE_NAME)
    : resolveProjectIndexPath(root, undefined, indexLookupFromArgs(args, root));
}

function validatePort(value: string | undefined, flag: string): CommandResult | null {
  if (value === undefined) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { code: EXIT.usage, error: `${flag} must be a number between 0 and 65535` };
  }
  return null;
}

export interface StartedChild {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly output: () => string;
}

/** Start one child and mirror its stderr so both services remain observable. */
export function spawnService(
  args: readonly string[],
  marker: RegExp,
  root: string
): StartedChild {
  const cli = path.resolve(__dirname, '../../..', 'bin', 'semantic-engine.js');
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let settled = false;
  let output = '';
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  child.stderr?.on('data', chunk => {
    const text = String(chunk);
    output += text;
    process.stderr.write(text);
    if (!settled && marker.test(output)) {
      settled = true;
      resolveReady();
    }
  });

  /*
  | A child that neither prints its ready marker nor exits (a port that
  | accepts but never answers, a watcher stuck on a lock) would leave `start`
  | waiting forever with no message. Fail with what the child said.
  */
  const startupMs = Number(process.env['SEMANTIC_ENGINE_START_TIMEOUT_MS'] ?? 180_000);
  const startupTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(
      `semantic-engine service did not become ready within ${Math.round(startupMs / 1000)}s ` +
      `(${args[0] ?? 'service'}); last output:\n${output.split('\n').slice(-8).join('\n')}`
    ));
  }, startupMs);
  startupTimer.unref?.();
  void ready.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));

  child.once('error', error => {
    if (!settled) {
      settled = true;
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  });

  child.once('exit', code => {
    if (!settled) {
      settled = true;
      rejectReady(new Error(`semantic-engine service exited before ready (code ${code})`));
    }
  });

  return { child, ready, output: () => output };
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>(resolve => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      finish();
    }, 5000);

    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}

/**
 * `semantic-engine start` — launch the Web UI and MCP HTTP server together.
 *
 * It deliberately supervises the two existing entry points instead of
 * duplicating their HTTP implementations. A missing canonical index is
 * created before either service starts, so one command is enough for a new
 * workspace as well as an already indexed one.
 */
export async function runStart(
  rawArgs: ParsedArgs,
  context: CommandContext
): Promise<CommandResult> {
  /*
  | `start` is the "everything on" entry point: deep scan (vector chunks +
  | language-server diagnostics), UI, MCP over HTTP and the file watcher.
  | Each can still be switched off explicitly (`--no-vectors`,
  | `--no-lsp-diagnostics`, `--no-watch`); only the defaults differ from
  | `index`/`watch`, where both heavy passes stay opt-in.
  */
  const args: ParsedArgs = {
    ...rawArgs,
    options: {
      ...rawArgs.options,
      vectors: boolOption(rawArgs.options, 'vectors', true),
      lspDiagnostics: boolOption(rawArgs.options, 'lspDiagnostics', true),
    },
  };

  const invalid = validateHttpOptions(args);
  if (invalid) return invalid;

  const invalidUiPort = validatePort(
    stringOption(args.options, 'uiPort'),
    '--ui-port'
  );
  if (invalidUiPort) return invalidUiPort;

  const invalidMcpPort = validatePort(
    stringOption(args.options, 'mcpPort'),
    '--mcp-port'
  );
  if (invalidMcpPort) return invalidMcpPort;

  const root = normalizeWorkspaceRoot(stringOption(args.options, 'root') ?? context.cwd);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { code: EXIT.failure, error: `--root does not exist or is not a directory: ${root}` };
  }

  let indexPath = startIndexPath(args, root);
  const explicitIndex = stringOption(args.options, 'index');
  const wantsVectors = boolOption(args.options, 'vectors', true);
  const existingIndex = loadIndex(indexPath);
  const needsRequestedArtifacts =
    !('error' in existingIndex) &&
    wantsVectors && !(existingIndex as ProjectIndex).vectorChunks;

  const indexUnreadable = 'error' in existingIndex;
  if (!fs.existsSync(indexPath) || (indexUnreadable && !explicitIndex) || (needsRequestedArtifacts && !explicitIndex)) {
    if (explicitIndex && indexUnreadable) {
      return { code: EXIT.failure, error: existingIndex.error };
    }
    if (explicitIndex && !fs.existsSync(indexPath)) {
      return {
        code: EXIT.failure,
        error:
          `index not found: ${indexPath}\n` +
          `run "semantic-engine index --root ${root}" first, or omit --index to let start create it`,
      };
    }

    const indexed = await runIndex(args, context);
    if (indexed.code !== EXIT.ok) return indexed;
    indexPath = startIndexPath(args, root);
  }

  if (!fs.existsSync(indexPath)) {
    return {
      code: EXIT.failure,
      error: `index was not created at the expected path: ${indexPath}`,
    };
  }

  const host = stringOption(args.options, 'host') ?? DEFAULT_HOST;
  const provided = stringOption(args.options, 'token') ?? process.env['SEMANTIC_ENGINE_TOKEN'];
  if (boolOption(args.options, 'allowRemote', false) && !provided) {
    return {
      code: EXIT.usage,
      error: 'remote start mode requires --token or SEMANTIC_ENGINE_TOKEN',
    };
  }
  const token = provided ?? generateToken();

  const sharedPort = stringOption(args.options, 'port');
  const uiPort = stringOption(args.options, 'uiPort') ?? sharedPort ?? '4000';
  const mcpPort = stringOption(args.options, 'mcpPort') ?? '3000';

  if (uiPort === mcpPort) {
    return { code: EXIT.usage, error: '--ui-port and --mcp-port must be different' };
  }

  const common = [
    '--root', root,
    '--index', indexPath,
    '--host', host,
    '--token', token,
    /* start owns one watcher for both services. */
    '--no-watch',
  ];
  /* Every child must resolve artifacts exactly as `start` itself did. */
  for (const [flag, name] of [
    ['--data-dir', 'dataDir'],
    ['--artifact-location', 'artifactLocation'],
    ['--project-id', 'projectId'],
  ] as const) {
    const value = stringOption(args.options, name);
    if (value !== undefined) common.push(flag, value);
  }

  const ui = spawnService(
    ['ui', ...common, '--port', uiPort],
    /Semantic Engine Standalone Web & Platform Server/,
    root
  );
  const mcp = spawnService(
    ['serve', '--http', ...common, '--port', mcpPort],
    /MCP server on http:\/\/[^\s]+/,
    root
  );

  /*
  | `start` now supervises the watcher as well. UI و MCP فقط یک
  | snapshot اولیه می‌دیدند و بعد از تغییر سورس stale می‌ماندند؛
  | ProjectService/MCP در کنار این child خودشان artifactها را reload
  | می‌کنند.
  */
  const watchArgs = [
    'watch',
    '--root', root,
    '--out', path.dirname(indexPath),
    '--skip-initial-index',
  ];
  if (wantsVectors) watchArgs.push('--vectors');
  if (boolOption(args.options, 'lspDiagnostics', false)) watchArgs.push('--lsp-diagnostics');
  const diagnosticsBudget = stringOption(args.options, 'diagnosticsBudget');
  if (diagnosticsBudget) watchArgs.push('--diagnostics-budget', diagnosticsBudget);
  if (!boolOption(args.options, 'blueprint', true)) watchArgs.push('--no-blueprint');
  const requestedBlueprintMode = stringOption(args.options, 'blueprintMode');
  if (requestedBlueprintMode) watchArgs.push('--blueprint-mode', requestedBlueprintMode);

  const watcher = boolOption(args.options, 'watch', true)
    ? spawnService(watchArgs, /press Ctrl\+C to stop/, root)
    : null;
  const children = [ui.child, mcp.child, ...(watcher ? [watcher.child] : [])];
  let stopping = false;

  const cleanup = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await Promise.all(children.map(stopChild));
  };

  /* Install signal handlers before waiting for either service to start. */
  const shutdown = waitForShutdown(cleanup);

  try {
    await Promise.all([
      ui.ready,
      mcp.ready,
      ...(watcher ? [watcher.ready] : []),
    ]);
  } catch (error) {
    await cleanup();
    return {
      code: EXIT.failure,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const uiUrl = /Web Visualizer UI:\s+(http:\/\/\S+)/.exec(ui.output())?.[1]
    ?? `http://${host}:${uiPort}/`;
  const mcpUrl = /MCP server on\s+(http:\/\/\S+)/.exec(mcp.output())?.[1]
    ?? `http://${host}:${mcpPort}/mcp`;

  process.stderr.write(
    `\n🚀 Semantic Engine UI + MCP\n` +
      `   • UI:  ${uiUrl}\n` +
      `   • MCP: ${mcpUrl}\n` +
      `   • Root: ${root}\n` +
      `   • Index: ${indexPath}\n` +
      `   • Watcher: ${watcher ? 'enabled' : 'disabled'}\n` +
      `   • Deep scan: vectors ${wantsVectors ? 'on' : 'off'}, LSP diagnostics ${
        boolOption(args.options, 'lspDiagnostics', true) ? 'on' : 'off'
      }\n` +
      `   • Config: ${globalConfigPath(resolveDataRoot({
        ...(stringOption(args.options, 'dataDir') ? { dataDir: stringOption(args.options, 'dataDir')! } : {}),
        env: process.env,
      }))}\n` +
      `   • Token: ${token}\n`
  );

  await shutdown;
  return { code: EXIT.ok };
}

/**
 * ماندن تا SIGINT/SIGTERM، بعد خاموشی تمیز.
 *
 * بدون این، `Ctrl+C` پروسه را وسط کار می‌کشد و سوکت‌های باز و — در
 * حالت watch — یک batch نیمه‌نوشته جا می‌ماند.
 */
export function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  return new Promise<void>(resolve => {
    let closing = false;

    const stop = (signal: string): void => {
      if (closing) return;
      closing = true;
      process.stderr.write(`\nreceived ${signal}, shutting down…\n`);
      void cleanup().then(
        () => resolve(),
        () => resolve()
      );
    };

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
}
