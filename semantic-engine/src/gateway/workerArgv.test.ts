/**
 * config → argv — فاز ۵.
 *
 * The acceptance criterion is a *table*: every operational option in the
 * reference plan (گام ۴) must have a config field and an argv flag, and nothing
 * else may reach the argument vector. A secret must never be an argument.
 */

import { commandPreview, workerArgv } from './workerArgv';
import { createWorkerConfig } from './WorkerConfigSchema';
import { ProjectWorkerConfig } from './types';

const ROOT = '/srv/projects/app';

/**
 * پچِ آزاد: بخش‌های تودرتو (indexing/service/…) ناقص داده می‌شوند و
 * `createWorkerConfig` پیش‌فرض‌ها را پر می‌کند — دقیقاً همان کاری که یک فرم
 * UI یا یک بدنهٔ JSON ناقص انجام می‌دهد.
 */
type Patch = Record<string, unknown>;

function config(patch: Patch = {}): ProjectWorkerConfig {
  return createWorkerConfig({
    projectId: 'prj-app-12345678',
    name: 'App',
    rootPath: ROOT,
    ...patch,
  } as never);
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe('workerArgv — deterministic, whitelisted, secret-free', () => {
  const table: { name: string; patch: Patch; check: (argv: string[]) => void }[] = [
    {
      name: 'rootPath → --root',
      patch: {},
      check: argv => expect(flagValue(argv, '--root')).toBe(ROOT),
    },
    {
      name: 'projectId → --project-id',
      patch: {},
      check: argv => expect(flagValue(argv, '--project-id')).toBe('prj-app-12345678'),
    },
    {
      name: 'dataDir → --data-dir',
      patch: { dataDir: '/srv/data' },
      check: argv => expect(flagValue(argv, '--data-dir')).toBe('/srv/data'),
    },
    {
      name: 'outOverride → --out',
      patch: { outOverride: '/srv/out' },
      check: argv => expect(flagValue(argv, '--out')).toBe('/srv/out'),
    },
    {
      name: 'indexing.vectors → --vectors / --no-vectors',
      patch: { indexing: { vectors: true } },
      check: argv => {
        expect(hasFlag(argv, '--vectors')).toBe(true);
        expect(hasFlag(argv, '--no-vectors')).toBe(false);
      },
    },
    {
      name: 'indexing.vectors=false → --no-vectors',
      patch: {},
      check: argv => expect(hasFlag(argv, '--no-vectors')).toBe(true),
    },
    {
      name: 'indexing.blueprint=false → --no-blueprint',
      patch: { indexing: { blueprint: false } },
      check: argv => expect(hasFlag(argv, '--no-blueprint')).toBe(true),
    },
    {
      name: 'indexing.git=false → --no-git',
      patch: { indexing: { git: false } },
      check: argv => expect(hasFlag(argv, '--no-git')).toBe(true),
    },
    {
      name: 'indexing.treeSitter=false → --no-tree-sitter',
      patch: { indexing: { treeSitter: false } },
      check: argv => expect(hasFlag(argv, '--no-tree-sitter')).toBe(true),
    },
    {
      name: 'indexing.pretty → --pretty / --no-pretty',
      patch: { indexing: { pretty: false } },
      check: argv => expect(hasFlag(argv, '--no-pretty')).toBe(true),
    },
    {
      name: 'watch=false → --no-watch',
      patch: { watch: false },
      check: argv => expect(hasFlag(argv, '--no-watch')).toBe(true),
    },
    {
      name: 'watchOptions.debounceMs → --debounce',
      patch: { watchOptions: { debounceMs: 250 } },
      check: argv => expect(flagValue(argv, '--debounce')).toBe('250'),
    },
    {
      name: 'watchOptions.blueprintMode → --blueprint-mode',
      patch: { watchOptions: { blueprintMode: 'threshold' } },
      check: argv => expect(flagValue(argv, '--blueprint-mode')).toBe('threshold'),
    },
    {
      name: 'watchOptions.skipInitialIndex → --skip-initial-index',
      patch: { watchOptions: { skipInitialIndex: true } },
      check: argv => expect(hasFlag(argv, '--skip-initial-index')).toBe(true),
    },
    {
      name: 'service.host → --host',
      patch: { service: { host: '127.0.0.1' } },
      check: argv => expect(flagValue(argv, '--host')).toBe('127.0.0.1'),
    },
    {
      name: 'service.port/uiPort/mcpPort → --port/--ui-port/--mcp-port',
      patch: { service: { port: 41001, uiPort: 41002, mcpPort: 41003 } },
      check: argv => {
        expect(flagValue(argv, '--port')).toBe('41001');
        expect(flagValue(argv, '--ui-port')).toBe('41002');
        expect(flagValue(argv, '--mcp-port')).toBe('41003');
      },
    },
    {
      name: 'service.transport=socket → --socket',
      patch: { service: { transport: 'socket', socketPath: '/run/semantic-engine/app.sock' } },
      check: argv => expect(flagValue(argv, '--socket')).toBe('/run/semantic-engine/app.sock'),
    },
    {
      name: 'service.http/stdio/web → --http/--stdio/--web',
      patch: { service: { http: true, stdio: true, web: true } },
      check: argv => {
        expect(hasFlag(argv, '--http')).toBe(true);
        expect(hasFlag(argv, '--stdio')).toBe(true);
        expect(hasFlag(argv, '--web')).toBe(true);
      },
    },
    {
      name: 'security.gatewayManaged → --gateway-managed',
      patch: { security: { gatewayManaged: true, tokenEnvVar: 'SE_WORKER_TOKEN' } },
      check: argv => expect(hasFlag(argv, '--gateway-managed')).toBe(true),
    },
    {
      name: 'security.allowRemote → --allow-remote',
      patch: { security: { allowRemote: true } },
      check: argv => expect(hasFlag(argv, '--allow-remote')).toBe(true),
    },
    {
      name: 'embedding → --embedding-*',
      patch: {
        embedding: {
          enabled: true,
          provider: 'openai-compatible',
          model: 'text-embedding-3-small',
          baseUrl: 'http://127.0.0.1:11434',
          apiKeyEnvVar: 'OPENAI_API_KEY',
          normalize: false,
        },
      },
      check: argv => {
        expect(flagValue(argv, '--embedding-provider')).toBe('openai-compatible');
        expect(flagValue(argv, '--embedding-model')).toBe('text-embedding-3-small');
        expect(flagValue(argv, '--embedding-base-url')).toBe('http://127.0.0.1:11434');
        expect(flagValue(argv, '--embedding-api-key-env')).toBe('OPENAI_API_KEY');
        expect(hasFlag(argv, '--no-embedding-normalize')).toBe(true);
      },
    },
  ];

  it.each(table.map(entry => [entry.name, entry] as const))('%s', (_name, entry) => {
    entry.check(workerArgv(config(entry.patch)));
  });

  it('is deterministic: same config, same vector, in the same order', () => {
    const first = workerArgv(config({ indexing: { vectors: true } }));
    const second = workerArgv(config({ indexing: { vectors: true } }));
    expect(second).toEqual(first);
  });

  it('never emits CLI-only flags', () => {
    const argv = workerArgv(config());
    for (const flag of ['--json', '--help', '--version']) {
      expect(argv).not.toContain(flag);
    }
  });

  it('never emits a secret, only the variable name', () => {
    const argv = workerArgv(
      config({
        security: { gatewayManaged: true, tokenEnvVar: 'SE_WORKER_TOKEN' },
        embedding: { enabled: true, provider: 'ollama', baseUrl: 'http://x', model: 'm', apiKeyEnvVar: 'K' },
      })
    );

    expect(argv).not.toContain('hunter2');
    /*
    | The worker token is not an argument at all — not even the variable name.
    | The supervisor sets the variable in the child's environment (فاز ۶), so a
    | process listing can never reveal which secret a worker uses.
    */
    expect(argv).not.toContain('SE_WORKER_TOKEN');
    expect(argv.some(part => part.startsWith('--token'))).toBe(false);

    /* An embedding key travels the same way: only the variable *name* is passed. */
    expect(argv).toContain('--embedding-api-key-env');
    expect(argv).toContain('K');
    expect(argv.every(part => !part.startsWith('sk-'))).toBe(true);
  });

  it('contains no shell metacharacters in the flags themselves', () => {
    const argv = workerArgv(config({ name: 'a; rm -rf / && b' }));
    for (const part of argv) {
      if (part.startsWith('--')) {
        expect(part).toMatch(/^--[a-z0-9-]+$/);
      }
    }
  });

  it('refuses to build a vector for an unusable config', () => {
    expect(() => workerArgv(config({ projectId: '../evil' }))).toThrow(/Invalid project id/);
    expect(() => workerArgv(config({ rootPath: '' }))).toThrow(/rootPath/);
  });

  it('previews the same vector, quoted for display only', () => {
    const preview = commandPreview(config({ name: 'My App' }));
    expect(preview.startsWith('semantic-engine worker --project-id prj-app-12345678')).toBe(true);
    expect(preview).toContain(`--root ${ROOT}`);
    /* a value with a space is quoted so the preview stays readable */
    expect(commandPreview(config({ outOverride: '/srv/my out' }))).toContain(`--out '/srv/my out'`);
  });
});
