/**
 * `semantic-engine` — نقطهٔ ورود CLI — MIG-50.
 *
 * چاپ کردن فقط این‌جا اتفاق می‌افتد. دستورها یک `CommandResult`
 * برمی‌گردانند و این تابع تصمیم می‌گیرد چه چیزی کجا برود — وگرنه
 * `--json` در هر دستور نصفه‌کاره پیاده می‌شود و stderr و stdout قاطی
 * می‌شوند.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EXIT, ParsedArgs, boolOption, parseArgs } from './args';
import { CommandResult } from './commands/types';
import { runIndex } from './commands/index-command';
import { runQuery } from './commands/query-command';
import { runDoctor } from './commands/doctor-command';
import { runServe, runUi, runStart } from './commands/serve-command';
import { applyGlobalConfig } from './globalConfigDefaults';
import { runWatch } from './commands/watch-command';
import { runWorker } from './commands/worker-command';
import { runCache } from './commands/cache-command';
import { runGateway } from './commands/gateway-command';
import { createLoggerFromEnv } from '../host/Logger';

const COMMANDS: Record<
  string,
  (args: ParsedArgs, context: { cwd: string; logger: ReturnType<typeof createLoggerFromEnv> }) => Promise<CommandResult>
> = {
  index: runIndex,
  query: runQuery,
  doctor: runDoctor,
  serve: runServe,
  watch: runWatch,
  worker: runWorker,
  gateway: runGateway,
  cache: runCache,
  ui: runUi,
  start: runStart,
};

const HELP = `semantic-engine — standalone code intelligence platform and visualizer

usage:
  semantic-engine <command> [options]

commands:
  index                 scan a project and write project-index.json
  ui                    launch standalone web visualizer and platform server
  start                 index if needed, launch UI/MCP, and keep artifacts updated
  serve                 expose index over MCP or standalone HTTP server
  watch                 index, then keep it up to date until Ctrl+C
  worker                serve one project (REST + /internal/*) until shutdown
  gateway               serve many projects on one port, one worker each
  query [tool] [params] run an AI tool against an existing index
  doctor                check this environment
  cache                 inspect or clean generated data (list|clean|export|import)

ui & serve options:
  --web / --ui          launch full Web Visualizer UI and REST/LoD APIs (default for 'ui')
  --http                MCP protocol over HTTP
  --stdio               MCP protocol over stdin/stdout (default for 'serve')
  --port <n>            HTTP port                  (default: 4000 for ui, 3000 for http)
  --ui-port <n>          UI port for 'start'         (default: 4000)
  --mcp-port <n>         MCP port for 'start'        (default: 3000)
  --no-watch             start UI/MCP without the file watcher
  --no-vectors           'start' only: skip vector chunks (on by default)
  --no-lsp-diagnostics   'start' only: skip language-server diagnostics (on by default)
  --host <addr>         bind address               (default: 127.0.0.1)
  --token <secret>      required bearer token      (generated if omitted)
  --allow-remote        permit a non-loopback bind (needs a strong token)

index options:
  --root <dir>          project to scan            (default: cwd)
  --project-id <id>     stable project id          (default: derived from the root path)
  --data-dir <dir>      data directory             (default: platform data dir)
  --artifact-location <m>  external (default) or in-root
  --out <dir>           output directory           (overrides the two above)
  --no-blueprint        skip blueprint.json
  --vectors             build vector chunks for semantic search (off by default)
  --lsp-diagnostics     collect compiler diagnostics via a language server (off)
  --diagnostics-budget <ms>  time budget for that pass     (default: 60000)
  --no-git              skip git metrics
  --no-tree-sitter      heuristic extractors only

watch options:
  --root <dir>          project to watch           (default: cwd)
  --project-id <id>     stable project id          (default: derived from the root path)
  --data-dir <dir>      data directory             (default: platform data dir)
  --artifact-location <m>  external (default) or in-root
  --out <dir>           output directory           (overrides the two above)
  --debounce <ms>       batch window               (default: 500)
  --vectors             build/update vector chunks and embeddings
  --lsp-diagnostics     collect language-server diagnostics on the initial index
  --diagnostics-budget <ms>  time budget for that pass      (default: 60000)
  --no-blueprint        skip blueprint.json updates
  --blueprint-mode <m>  always (default) or threshold
  --skip-initial-index  internal: watch an existing index without rebuilding it

query options:
  --index <file>        path to project-index.json (default: <root>/.semantic-engine/…)
  --<name> <value>      passed through to the tool
  (no tool name)        list the available tools

embedding:
  --embedding-provider implies --vectors. "local" is deterministic hashing with
  no native dependency; "ollama" and "openai-compatible" need
  --embedding-base-url and --embedding-model. The API key is read from the
  environment variable named by --embedding-api-key-env, never from the command
  line, so it cannot end up in a process listing or a log.

cache options:
  list                  what is cached, and how big (default subcommand)
  clean --project <id>  delete one project's artifacts (never the source tree)
  clean --older-than <n[s|m|h|d]> [--force]   dry run unless --force
  export --project <id> --to <dir>
  import --project <id> --from <dir>
  --data-dir <dir>      data directory to operate on (default: platform data dir)

artifact location:
  generated data is written to the user data directory
  ($XDG_DATA_HOME/semantic-engine, ~/Library/Application Support/SemanticEngine,
  %LOCALAPPDATA%\\SemanticEngine) under projects/<projectId>/, never into the
  workspace. SEMANTIC_ENGINE_DATA_DIR overrides the location; an index left in
  <root>/.semantic-engine, <root>/.agent/semantic or <root>/semantic is copied
  (not moved) on first use.

worker options:
  --project-id <id>     stable project id          (default: derived from the root path)
  --root <dir>          the one project this worker serves
  --data-dir <dir>      data directory             (default: platform data dir)
  --socket <path>       listen on a Unix socket instead of TCP
  --port <n>            loopback port              (default: an ephemeral port)
  --host <addr>         bind address               (default: 127.0.0.1)
  --token <secret>      internal token             (default: $SEMANTIC_ENGINE_TOKEN or generated)
  --gateway-managed     worker is only reachable through the Gateway
  --no-watch            do not start the watch child
  --skip-initial-index  serve an existing index without indexing first

  internal endpoints (all require the token):
    GET  /internal/health    GET /internal/ready   GET /internal/metrics
    GET  /internal/status    POST /internal/reindex
    POST /internal/reload    POST /internal/shutdown

gateway options:
  --port <n>            public port                (default: 4000)
  --host <addr>         bind address               (default: 127.0.0.1)
  --token <secret>      gateway token              (default: $SEMANTIC_ENGINE_GATEWAY_TOKEN or generated)
  --data-dir <dir>      data directory             (default: platform data dir)
  --project <dir>       register one project at startup (others via the API)
  --project-id <id>     id for --project
  --name <name>         display name for --project
  --no-auto-start       register --project without starting its worker

  routes:
    GET|POST /api/v1/gateway/projects        registry
    POST     /api/v1/gateway/projects/:id/start|stop|restart|reindex
    GET      /api/v1/gateway/health|ready|metrics|events
    ANY      /api/v1/projects/:id/...        proxied to that project's worker
    POST     /mcp/:id                        MCP for that project

global options:
  --json                machine-readable output on stdout
  --help                this text
  --version             package version

exit codes:
  0  success
  1  the command ran and failed
  2  the command line was wrong
  3  doctor found a broken requirement
`;

function packageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  /*
  | `<dataRoot>/config.json` supplies the defaults flags do not set. Only
  | real commands read it; help/version must work on a broken home dir.
  */
  const applied = COMMANDS[parsed.command ?? ''] ? applyGlobalConfig(parsed) : null;
  const args = applied?.args ?? parsed;
  for (const warning of applied?.loaded.warnings ?? []) {
    process.stderr.write(`config: ${warning}\n`);
  }
  for (const notice of applied?.notices ?? []) {
    process.stderr.write(`notice: ${notice}\n`);
  }
  const wantsJson = boolOption(args.options, 'json', false);

  if (boolOption(args.options, 'help', false) || args.command === 'help') {
    process.stdout.write(HELP);
    return EXIT.ok;
  }

  if (boolOption(args.options, 'version', false) || args.command === 'version') {
    process.stdout.write(`${packageVersion()}\n`);
    return EXIT.ok;
  }

  if (!args.command) {
    process.stderr.write(HELP.replace(/^semantic-engine — .*\n\n/, 'usage:\n').trimStart());
    return EXIT.usage;
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    process.stderr.write(
      `unknown command: ${args.command}\n` +
        `available: ${Object.keys(COMMANDS).join(', ')}\n` +
        `try "semantic-engine --help"\n`
    );
    return EXIT.usage;
  }

  /*
  | SE-EXT-06: `Logger` سطح `info` و `debug` را روی **stdout**
  | می‌نویسد و فقط `warn`/`error` را روی stderr. برای یک کتابخانه
  | انتخاب معقولی است؛ برای یک CLI فاجعه است — اولین خطِ خروجیِ
  | `--json` یک لاگ می‌شود و `JSON.parse` می‌ترکد.
  |
  | حالت `stdio` که از فاز ۰۷ برای سرور MCP وجود دارد دقیقاً همین را
  | حل می‌کند: همه‌چیز به stderr. برای CLI همیشه روشن است، نه فقط با
  | `--json` — چون کاربر به‌هرحال ممکن است stdout را pipe کند، و
  | قرارداد یونیکس هم همین است: داده روی stdout، پیشرفت روی stderr.
  */
  const logger = createLoggerFromEnv(process.env, { stdio: true });

  let result: CommandResult;
  try {
    result = await handler(args, { cwd: process.cwd(), logger });
  } catch (error) {
    /*
    | استک‌تریس روی صفحهٔ کاربر، یک باگ رابط است. پیام می‌رود روی
    | stderr و جزئیات به لاگر — که اگر کسی بخواهد با
    | SEMANTIC_ENGINE_LOG_LEVEL=debug ببیندش.
    */
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.debug('command threw', { stack: failure.stack });
    process.stderr.write(`${failure.message}\n`);
    return EXIT.failure;
  }

  if (result.error) process.stderr.write(`${result.error}\n`);

  if (wantsJson) {
    if (result.json !== undefined) process.stdout.write(`${JSON.stringify(result.json)}\n`);
  } else if (result.text) {
    process.stdout.write(`${result.text}\n`);
  }

  return result.code;
}

export { EXIT };
