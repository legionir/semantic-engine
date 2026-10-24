/**
 * MCP Server CLI entry point.
 *
 * Usage:
 *   node dist/ai/mcp/cli.js <path-to-project-index.json>
 *   node dist/ai/mcp/cli.js <path-to-project-index.json> --http --port 3000
 *   node dist/ai/mcp/cli.js <path-to-project-index.json> --allow-edits --experimental semantic-graph,controlled-expansion
 *
 * Mutation (`edit_*`) and experimental Phase 3/4 tools stay disabled unless
 * the host explicitly passes --allow-edits / --experimental.
 *
 * This is intended to be used by MCP clients (e.g., Claude Desktop, Claude Code).
 */

import * as fs from 'fs';
import * as http from 'http';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { SemanticEngineMcpServer } from './SemanticEngineMcpServer';
import { ProjectIndex } from '../../core/types/project-index.types';
import { loadBlueprintBeside } from '../discovery/loadBlueprint';
import type { BlueprintIndex } from '../discovery/BlueprintIndex';
import {
  normalizeWorkspaceRoot,
  resolveProjectIndexPath,
  workspaceRootFromIndex,
} from '../../core/config/ProjectPaths';
import type { IndexLookupOptions } from '../../core/config/ProjectPaths';
import { artifactLocationOrDefault, DATA_DIR_ENV_VAR } from '../../core/config/DataRootResolver';
import { readCommittedIndexBytes } from '../../core/config/artifactManifest';
import { canonicalizeRoot, projectIdFor } from '../../core/config/ProjectIdentity';
import { migrateLegacyArtifacts } from '../../core/config/migrateLegacyArtifacts';
import { ARTIFACT_LOCATION_ENV_VAR } from '../../cli/projectPathsFromArgs';
import {
  HttpGuard,
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  generateToken,
  isLoopbackHost,
} from '../../cli/HttpGuard';

interface ParsedCliArgs {
  readonly projectIndexPath: string;
  readonly rootPath: string | undefined;
  readonly http: boolean;
  readonly port: number;
  readonly host: string;
  readonly token: string | undefined;
  readonly allowRemote: boolean;
  readonly maxBodyBytes: number;
  readonly watch: boolean;
  readonly allowEdits: boolean;
  readonly experimental: readonly string[];
}

/**
 * همان قراردادی که CLI دارد، بدون `ParsedArgs`: نقطهٔ ورود MCP آرگومان‌های
 * خودش را می‌پارسد، ولی مسیر artifact نباید جای دیگری تصمیم گرفته شود.
 */
function indexLookupFor(workspaceRoot: string): IndexLookupOptions {
  const location = artifactLocationOrDefault(process.env[ARTIFACT_LOCATION_ENV_VAR]);
  const dataDir = process.env[DATA_DIR_ENV_VAR];
  return {
    location,
    projectId: projectIdFor(path.basename(workspaceRoot), canonicalizeRoot(workspaceRoot)),
    ...(dataDir !== undefined && dataDir.trim() !== '' ? { dataRoot: dataDir } : {}),
  };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const inline = argv.find(token => token.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);

  const at = argv.indexOf(flag);
  const value = at !== -1 && at + 1 < argv.length ? argv[at + 1] : undefined;
  return value && !value.startsWith('-') ? value : undefined;
}

function positionalArgument(argv: string[]): string | undefined {
  const valueFlags = new Set(['--root', '--index', '--port', '--host', '--token', '--max-body', '--experimental']);

  for (let index = 2; index < argv.length; index++) {
    const token = argv[index]!;
    if (valueFlags.has(token)) {
      index++;
      continue;
    }
    if (!token.startsWith('-')) return token;
  }

  return undefined;
}

function parseArgs(argv: string[]): ParsedCliArgs {
  const positional = positionalArgument(argv);
  const rootPath = valueAfter(argv, '--root');
  const explicitIndex = valueAfter(argv, '--index') ?? positional;
  const workspaceRoot = rootPath ? normalizeWorkspaceRoot(rootPath) : undefined;
  const lookup = workspaceRoot ? indexLookupFor(workspaceRoot) : undefined;
  if (workspaceRoot && lookup) {
    migrateLegacyArtifacts({
      workspaceRoot,
      projectId: lookup.projectId ?? '',
      location: lookup.location,
      ...(lookup.dataRoot !== undefined ? { dataRoot: lookup.dataRoot } : {}),
    });
  }
  const projectIndexPath = explicitIndex
    ?? (workspaceRoot && lookup
      ? resolveProjectIndexPath(workspaceRoot, undefined, lookup)
      : '');
  const rawPort = valueAfter(argv, '--port');
  const rawMaxBody = valueAfter(argv, '--max-body');
  const rawExperimental = valueAfter(argv, '--experimental');
  const experimental = rawExperimental === undefined
    ? []
    : rawExperimental.split(',').map(name => name.trim()).filter(name => name.length > 0);

  return {
    projectIndexPath,
    rootPath: rootPath ? normalizeWorkspaceRoot(rootPath) : undefined,
    http: argv.includes('--http'),
    port: rawPort !== undefined ? parseInt(rawPort, 10) : 3000,
    host: valueAfter(argv, '--host') ?? DEFAULT_HOST,
    token: valueAfter(argv, '--token') ?? process.env['SEMANTIC_ENGINE_TOKEN'],
    allowRemote: argv.includes('--allow-remote'),
    maxBodyBytes:
      rawMaxBody !== undefined ? parseInt(rawMaxBody, 10) : DEFAULT_MAX_BODY_BYTES,
    watch: !argv.includes('--no-watch'),
    allowEdits: argv.includes('--allow-edits'),
    experimental,
  };
}

/**
 * Only known experimental capabilities are forwarded; unknown names are
 * dropped so a typo can never silently enable something else.
 */
function experimentalMap(names: readonly string[]): Record<string, boolean> | undefined {
  const known = new Set(['semantic-graph', 'controlled-expansion']);
  const entries = [...new Set(names)].filter(name => known.has(name)).map(name => [name, true as const]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

interface StartedWatcher {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
}

function startWatcher(root: string, indexPath: string): StartedWatcher {
  const cli = path.resolve(__dirname, '../../..', 'bin', 'semantic-engine.js');
  const child = spawn(
    process.execPath,
    [cli, 'watch', '--root', root, '--out', path.dirname(indexPath), '--skip-initial-index'],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let output = '';
  let settled = false;
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
    if (!settled && /press Ctrl\+C to stop/.test(output)) {
      settled = true;
      resolveReady();
    }
  });
  child.once('error', error => {
    if (!settled) {
      settled = true;
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.once('exit', code => {
    if (!settled) {
      settled = true;
      rejectReady(new Error(`watcher exited before ready (code ${code})`));
    }
  });

  return { child, ready };
}

async function stopWatcher(watcher: StartedWatcher): Promise<void> {
  if (watcher.child.exitCode !== null || watcher.child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      if (watcher.child.exitCode === null && watcher.child.signalCode === null) {
        watcher.child.kill('SIGKILL');
      }
      resolve();
    }, 5000);
    watcher.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    watcher.child.kill('SIGTERM');
  });
}

async function runStdio(
  projectIndex: ProjectIndex,
  blueprint: BlueprintIndex | null,
  args: ParsedCliArgs
): Promise<void> {
  const server = new SemanticEngineMcpServer({
    projectIndex,
    ...(blueprint ? { blueprint } : {}),
    /*
    | SE-EXP-05: `root` فقط نام کوتاه پروژه است؛ مسیر واقعی در
    | `rootPath` نشسته (فاز ۲۴). دادنِ `root` یعنی سرور MCP یک نام
    | پوشه را به‌عنوان workspaceRoot می‌گرفت و هر ابزاری که فایل
    | می‌خواند به مسیری بی‌معنا نگاه می‌کرد.
    */
    workspaceRoot: args.rootPath ?? workspaceRootFromIndex(projectIndex, args.projectIndexPath),
    ...(args.allowEdits ? { enablePhase2Edits: true as const } : {}),
    ...(experimentalMap(args.experimental) ? { experimental: experimentalMap(args.experimental) } : {}),
  });
  server.watchIndexFile(args.projectIndexPath);
  const watcher = args.watch
    ? startWatcher(
        args.rootPath ?? workspaceRootFromIndex(projectIndex, args.projectIndexPath),
        args.projectIndexPath
      )
    : null;

  try {
    if (watcher) await watcher.ready;
    await server.start();
  } finally {
    if (watcher) await stopWatcher(watcher);
    await server.close();
  }
}

/**
 * سرور HTTP این entry point — SE-SEC-03، بار دوم.
 *
 * ── چه چیزی خراب بود ──────────────────────────────────────────────
 *
 * `HttpGuard` دقیقاً برای رفع چهار حفرهٔ همین فایل نوشته شد، ولی فقط
 * به `serve-command.ts` وصل شد و این‌جا جا ماند. یعنی باینری دوم،
 * `semantic-engine-mcp --http`، هر چهار حفره را دست‌نخورده داشت:
 *
 *   - `listen(port)` بدون host → گوش دادن روی `0.0.0.0`
 *   - بدون هیچ توکنی → هر کسی روی شبکه کل ایندکس را می‌خواند
 *   - بدون بررسی `Origin` → DNS-rebinding از مرورگر قربانی
 *   - `body += chunk` بدون سقف → یک درخواست، هر مقدار حافظه
 *
 * حالا همان نگهبانی که جلوی `serve` می‌نشیند این‌جا هم می‌نشیند، و
 * خروج از loopback مثل آن‌جا یک تصمیم صریح است، نه پیش‌فرض.
 *
 * یک transport به ازای هر درخواست ساخته می‌شود؛ نسخهٔ قبلی یکی را
 * بین همهٔ درخواست‌ها به اشتراک می‌گذاشت و «stateless» صدایش می‌کرد،
 * در حالی که دو درخواست هم‌زمان روی همان شیء مسابقه می‌دادند.
 */
async function runHttp(
  projectIndex: ProjectIndex,
  args: ParsedCliArgs,
  blueprint: BlueprintIndex | null
): Promise<void> {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const token = args.token ?? generateToken();
  const guard = new HttpGuard({
    token,
    maxBodyBytes: args.maxBodyBytes,
    path: '/mcp',
  });

  const workspaceRoot = args.rootPath ?? workspaceRootFromIndex(projectIndex, args.projectIndexPath);
  const watcher = args.watch ? startWatcher(workspaceRoot, args.projectIndexPath) : null;

  const httpServer = http.createServer((req, res) => {
    void guard.handle(req, res, async body => {
      const currentIndex = (() => {
        try {
          const rawBytes = readCommittedIndexBytes(args.projectIndexPath);
          return JSON.parse(rawBytes.toString('utf8')) as ProjectIndex;
        } catch {
          return projectIndex;
        }
      })();
      const currentBlueprint = loadBlueprintBeside(args.projectIndexPath).index;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = new SemanticEngineMcpServer({
        projectIndex: currentIndex,
        ...(currentBlueprint ? { blueprint: currentBlueprint } : blueprint ? { blueprint } : {}),
        workspaceRoot,
        ...(args.allowEdits ? { enablePhase2Edits: true as const } : {}),
        ...(experimentalMap(args.experimental) ? { experimental: experimentalMap(args.experimental) } : {}),
      });
      await mcpServer.connectTransport(transport);

      try {
        await transport.handleRequest(req, res, JSON.parse(body));
      } finally {
        await transport.close?.();
        await mcpServer.close();
      }
    });
  });

  try {
    if (watcher) await watcher.ready;
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(args.port, args.host, () => resolve());
    });
  } catch (error) {
    if (watcher) await stopWatcher(watcher);
    throw error;
  }

  const cleanup = async (): Promise<void> => {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    if (watcher) await stopWatcher(watcher);
  };
  process.once('SIGINT', () => void cleanup().then(() => process.exit(0)));
  process.once('SIGTERM', () => void cleanup().then(() => process.exit(0)));

  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : args.port;

  /*
  | توکن روی stderr می‌رود، نه stdout: در حالت stdio همان stdout کانال
  | پروتکل است، و عادت دادن این فایل به نوشتن روی stdout دیر یا زود
  | یک پیام لاگ را وسط یک پیام JSON-RPC می‌نشاند.
  */
  process.stderr.write(
    `Semantic Engine MCP HTTP server on http://${args.host}:${actualPort}/mcp\n` +
      `  token: ${token}${args.token ? '' : '  (generated; pass --token or SEMANTIC_ENGINE_TOKEN to fix it)'}\n`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!args.projectIndexPath) {
    console.error(
      'Usage: node cli.js <path-to-project-index.json> [--http] [--port 3000]\n' +
        '       node cli.js --root <project-root> [--http] [--port 3000]\n' +
        '                   [--host 127.0.0.1] [--token <token>] [--allow-remote]\n' +
        '                   [--max-body <bytes>] [--no-watch]'
    );
    process.exit(1);
  }

  if (args.http) {
    if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
      console.error('--port must be a number between 0 and 65535');
      process.exit(1);
    }

    if (!Number.isInteger(args.maxBodyBytes) || args.maxBodyBytes <= 0) {
      console.error('--max-body must be a positive number of bytes');
      process.exit(1);
    }

    /*
    | همان مهار `serve`: بستن به یک آدرس غیرloopback کل ایندکس پروژه
    | را در معرض شبکه می‌گذارد، پس باید صریح خواسته شود.
    */
    if (!isLoopbackHost(args.host) && !args.allowRemote) {
      console.error(
        `refusing to bind ${args.host}: that exposes the whole index to the network.\n` +
          `pass --allow-remote if you really mean it, and set a strong --token.`
      );
      process.exit(1);
    }
  }

  if (!fs.existsSync(args.projectIndexPath)) {
    console.error(`Project index not found: ${args.projectIndexPath}`);
    process.exit(1);
  }

  // همان دروازهٔ fail-closed مسیر HTTP/MCP — شروع با index ناسازگار ممنوع است.
  const rawBytes = readCommittedIndexBytes(args.projectIndexPath);
  const projectIndex = JSON.parse(rawBytes.toString('utf8')) as ProjectIndex;

  /*
  | SE-BP-06 — blueprint کنار project-index نوشته می‌شود و تا فاز ۴۳
  | هیچ‌کس بازش نمی‌کرد. نبودنش خطا نیست: `discover_context` بدون آن
  | هم کار می‌کند، فقط منبع دومِ دانه را از دست می‌دهد.
  */
  const loaded = loadBlueprintBeside(args.projectIndexPath);
  if (loaded.note) console.error(`blueprint: ${loaded.note}`);

  if (args.http) {
    await runHttp(projectIndex, args, loaded.index);
  } else {
    await runStdio(projectIndex, loaded.index, args);
  }
}

main().catch(error => {
  console.error('MCP server error:', error);
  process.exit(1);
});
