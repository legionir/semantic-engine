/**
 * config → argv — فاز ۵.
 *
 * The only place in the codebase that turns a worker configuration into
 * process arguments. Two rules:
 *
 *   1. **No shell.** The result is an argument vector for `spawn(..., { shell:
 *      false })`. Nothing is concatenated into a command line, so no value can
 *      escape into a shell interpretation.
 *   2. **No secrets.** A token or an API key is never an argument; only the
 *      *name* of the environment variable is passed, and the supervisor sets
 *      the value in the child's environment.
 *
 * `commandPreview` exists so the UI can show what will run. It is derived from
 * the same vector and is for display only — the Gateway must never execute it.
 */

import { ProjectWorkerConfig } from './types';
import { assertPathSafeProjectId } from '../core/config/ProjectIdentity';

export interface WorkerArgvOptions {
  /** نام باینری در preview؛ روی argv اثر ندارد. */
  readonly binary?: string;
  /** دستور worker؛ پیش‌فرض `worker` (فاز ۷). */
  readonly command?: string;
}

/** پرچم‌های boolean که به‌صورت `--x` / `--no-x` بیان می‌شوند. */
function booleanFlag(flags: string[], name: string, value: boolean): void {
  flags.push(value ? `--${name}` : `--no-${name}`);
}

function optionalValue(flags: string[], name: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return;
  flags.push(`--${name}`, String(value));
}

export function workerArgv(config: ProjectWorkerConfig): string[] {
  const projectId = assertPathSafeProjectId(config.projectId);
  if (config.rootPath.trim() === '') {
    throw new Error('workerArgv requires a rootPath; validate the config first');
  }

  const argv: string[] = ['--project-id', projectId, '--root', config.rootPath];

  optionalValue(argv, 'data-dir', config.dataDir);
  optionalValue(argv, 'out', config.outOverride);

  const { indexing } = config;
  booleanFlag(argv, 'vectors', indexing.vectors);
  booleanFlag(argv, 'sqlite', indexing.sqlite);
  booleanFlag(argv, 'blueprint', indexing.blueprint);
  booleanFlag(argv, 'git', indexing.git);
  booleanFlag(argv, 'tree-sitter', indexing.treeSitter);
  booleanFlag(argv, 'pretty', indexing.pretty);

  if (!config.watch) argv.push('--no-watch');
  optionalValue(argv, 'debounce', config.watchOptions.debounceMs);
  optionalValue(argv, 'blueprint-mode', config.watchOptions.blueprintMode);
  if (config.watchOptions.skipInitialIndex) argv.push('--skip-initial-index');

  const { service } = config;
  optionalValue(argv, 'host', service.host);
  optionalValue(argv, 'port', service.port);
  optionalValue(argv, 'ui-port', service.uiPort);
  optionalValue(argv, 'mcp-port', service.mcpPort);
  if (service.transport === 'socket') {
    optionalValue(argv, 'socket', service.socketPath);
  }
  if (service.http) argv.push('--http');
  if (service.stdio) argv.push('--stdio');
  if (service.web) argv.push('--web');

  if (config.security.gatewayManaged) argv.push('--gateway-managed');
  if (config.security.allowRemote) argv.push('--allow-remote');

  const { embedding } = config;
  if (embedding.enabled) {
    optionalValue(argv, 'embedding-provider', embedding.provider);
    optionalValue(argv, 'embedding-model', embedding.model);
    optionalValue(argv, 'embedding-base-url', embedding.baseUrl);
    optionalValue(argv, 'embedding-api-key-env', embedding.apiKeyEnvVar);
    booleanFlag(argv, 'embedding-normalize', embedding.normalize);
  }

  return argv;
}

/** نقل‌قول فقط برای نمایش؛ هرگز اجرا نمی‌شود. */
function quoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandPreview(
  config: ProjectWorkerConfig,
  options: WorkerArgvOptions = {}
): string {
  const binary = options.binary ?? 'semantic-engine';
  const command = options.command ?? 'worker';
  return [binary, command, ...workerArgv(config).map(quoteForDisplay)].join(' ');
}
