import { workerArgv } from './workerArgv';
import { createWorkerConfig, validateWorkerConfig, WORKER_CONFIG_JSON_SCHEMA } from './WorkerConfigSchema';
import { forwardedWatchFlags } from '../cli/commands/worker-command';
import { parseArgs } from '../cli/args';

const base = { projectId: 'p1', name: 'P', rootPath: '/srv/p' };
const argvOf = (extra: Record<string, unknown>) => workerArgv(createWorkerConfig({ ...base, ...extra } as never));
const valid = (extra: Record<string, unknown>) =>
  validateWorkerConfig({ ...base, ...extra } as never, { checkFileSystem: false });

describe('worker scan / diagnostics / cache options', () => {
  it('defaults add no scan, diagnostics or cache flag', () => {
    const argv = argvOf({}).join(' ');
    for (const flag of ['--no-gitignore', '--no-skip-hidden', '--max-depth', '--max-file-size-mb', '--ignore',
      '--lsp-diagnostics', '--diagnostics-budget', '--full', '--no-cache', '--artifact-location']) {
      expect(argv).not.toContain(flag);
    }
  });

  it('turns every option into its CLI flag', () => {
    const argv = argvOf({
      artifactLocation: 'in-root',
      scan: { useGitignore: false, skipHiddenDirectories: false, maxDepth: 6, maxFileSizeMb: 2, ignore: 'a,b' },
      diagnostics: { lsp: true, budgetMs: 30000 },
      cache: { mode: 'full' },
    });
    expect(argv).toEqual(expect.arrayContaining([
      '--no-gitignore', '--no-skip-hidden', '--max-depth', '6', '--max-file-size-mb', '2', '--ignore', 'a,b',
      '--lsp-diagnostics', '--diagnostics-budget', '30000', '--full', '--artifact-location', 'in-root',
    ]));
    expect(argvOf({ cache: { mode: 'off' } })).toContain('--no-cache');
  });

  it('validates the new fields', () => {
    expect(valid({}).ok).toBe(true);
    for (const bad of [
      { scan: { maxDepth: -1 } },
      { scan: { maxDepth: 1.5 } },
      { scan: { maxFileSizeMb: 0 } },
      { diagnostics: { budgetMs: -5 } },
      { cache: { mode: 'sometimes' } },
      { artifactLocation: 'cloud' },
    ]) {
      expect(valid(bad).ok).toBe(false);
    }
  });

  it('the JSON schema knows the new sections', () => {
    expect(Object.keys(WORKER_CONFIG_JSON_SCHEMA.properties)).toEqual(
      expect.arrayContaining(['scan', 'diagnostics', 'cache', 'artifactLocation'])
    );
  });
});

describe('worker → watch flag forwarding', () => {
  const forwarded = (...argv: string[]) => forwardedWatchFlags(parseArgs(['worker', ...argv]).options);

  it('forwards indexing, scan, diagnostics and embedding options to the watcher', () => {
    expect(forwarded(
      '--no-vectors', '--no-git', '--debounce', '900', '--blueprint-mode', 'threshold', '--max-depth', '3',
      '--ignore', 'x', '--lsp-diagnostics', '--diagnostics-budget', '1000', '--embedding-provider', 'local',
      '--no-gitignore'
    )).toEqual(expect.arrayContaining([
      '--no-vectors', '--no-git', '--debounce', '900', '--blueprint-mode', 'threshold', '--max-depth', '3',
      '--ignore', 'x', '--lsp-diagnostics', '--diagnostics-budget', '1000', '--embedding-provider', 'local',
      '--no-gitignore',
    ]));
  });

  it('forwards nothing the worker was not given, and never process options', () => {
    expect(forwarded('--root', '/r', '--port', '1234', '--token', 'secret')).toEqual([]);
  });
});
