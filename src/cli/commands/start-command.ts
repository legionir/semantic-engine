import { networkFilesystemOf, networkFilesystemWarning } from '../../host/networkFilesystem';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectIndex } from '../../core/types/project-index.types';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { runIndex } from './index-command';
import { INDEX_FILE_NAME } from '../../pipeline/OutputWriter';
import { resolveDataRoot } from '../../core/config/DataRootResolver';
import { globalConfigPath } from '../../core/config/GlobalConfig';
import { normalizeWorkspaceRoot, resolveProjectIndexPath } from '../../core/config/ProjectPaths';
import { indexLookupFromArgs } from '../projectPathsFromArgs';
import { generateToken, DEFAULT_HOST } from '../HttpGuard';
import { loadIndex, validateHttpOptions } from './serve-command';
import { spawnService, stopChild, waitForShutdown } from './serviceSupervisor';

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
  /* The watcher re-reads config.json; pass the choices `start` resolved (incl. its fallback). */
  for (const [flag, name] of [
    ['--embedding-provider', 'embeddingProvider'],
    ['--embedding-model', 'embeddingModel'],
    ['--embedding-base-url', 'embeddingBaseUrl'],
    ['--embedding-api-key-env', 'embeddingApiKeyEnv'],
  ] as const) {
    const value = stringOption(args.options, name);
    if (wantsVectors && value !== undefined) watchArgs.push(flag, value);
  }
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

  const dataRootDir = resolveDataRoot({
    ...(stringOption(args.options, 'dataDir') ? { dataDir: stringOption(args.options, 'dataDir')! } : {}),
    env: process.env,
  });
  const networkFs = networkFilesystemOf(dataRootDir);
  if (networkFs) process.stderr.write(`⚠ ${networkFilesystemWarning(dataRootDir, networkFs)}\n`);

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
