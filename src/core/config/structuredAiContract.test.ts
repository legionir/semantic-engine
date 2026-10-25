/**
 * Cross-package contract: structured-ai must resolve the same paths we write.
 *
 * `structured-ai/agent/mcp/enginePaths.js` mirrors two rules from this
 * package — the platform data directory (D1) and the project id (D3) — because
 * its `checkStaleness` has to find an index the engine wrote. Those two
 * implementations live in different languages of the same monorepo, so nothing
 * but a test keeps them together.
 *
 * The suite skips itself when the consumer package is not checked out next to
 * the engine (a standalone engine install), the same way
 * `src/host/barrelLoad.test.ts` skips without `dist/`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDataRoot } from './DataRootResolver';
import { projectIdFor, slugify } from './ProjectIdentity';

interface EnginePathsModule {
  engineDataHome(options?: {
    override?: string;
    env?: Record<string, string | undefined>;
    platform?: string;
    homeDir?: string;
  }): string;
  slugify(name: string): string;
  engineProjectIdFor(rootPath: string, name?: string): string;
  indexPathCandidates(rootPath: string, options?: { override?: string }): string[];
}

/* `STRUCTURED_AI_ROOT` points at the consumer's `structured-ai` folder (a different repository). */
const CONSUMER_PATH = path.join(
  process.env['STRUCTURED_AI_ROOT'] || path.join(__dirname, '..', '..', '..', '..', 'structured-ai'),
  'agent',
  'mcp',
  'enginePaths.js'
);

const present = fs.existsSync(CONSUMER_PATH);
const describeIfPresent = present ? describe : describe.skip;

const consumer = (present ? require(CONSUMER_PATH) : {}) as EnginePathsModule;

describeIfPresent('structured-ai resolves the engine’s paths identically', () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-contract-')));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('agrees on the platform data directory', () => {
    const cases: { platform: string; homeDir: string; env: Record<string, string> }[] = [
      { platform: 'linux', homeDir: '/home/u', env: {} },
      { platform: 'linux', homeDir: '/home/u', env: { XDG_DATA_HOME: '/srv/data' } },
      { platform: 'linux', homeDir: '/home/u', env: { XDG_DATA_HOME: 'relative/dir' } },
      { platform: 'darwin', homeDir: '/Users/u', env: {} },
      {
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      },
      { platform: 'win32', homeDir: 'C:\\Users\\u', env: {} },
    ];

    for (const testCase of cases) {
      expect(consumer.engineDataHome(testCase)).toBe(
        resolveDataRoot({
          platform: testCase.platform,
          homeDir: testCase.homeDir,
          env: testCase.env,
        })
      );
    }
  });

  it('agrees on an explicit override', () => {
    const override = path.join(base, 'engine-data');

    expect(consumer.engineDataHome({ override, platform: 'linux', homeDir: base, env: {} })).toBe(
      resolveDataRoot({ dataDir: override, platform: 'linux', homeDir: base, env: {} })
    );
  });

  it('agrees on slugs and project ids', () => {
    const rootA = path.join(base, 'client-a', 'app');
    const rootB = path.join(base, 'client-b', 'app');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });

    for (const name of ['Engine Core', 'app', 'Weird  Name--42', '___', 'پروژه']) {
      expect(consumer.slugify(name)).toBe(slugify(name));
    }

    expect(consumer.engineProjectIdFor(rootA, 'app')).toBe(projectIdFor('app', rootA));
    expect(consumer.engineProjectIdFor(rootB, 'app')).toBe(projectIdFor('app', rootB));
    /* A shared directory name must not produce a shared id. */
    expect(consumer.engineProjectIdFor(rootA, 'app')).not.toBe(
      consumer.engineProjectIdFor(rootB, 'app')
    );
  });

  it('looks in the data directory first and keeps legacy fallbacks', () => {
    const root = path.join(base, 'app');
    fs.mkdirSync(root, { recursive: true });
    const dataRoot = path.join(base, 'data');

    const candidates = consumer.indexPathCandidates(root, { override: dataRoot });

    expect(candidates[0]).toBe(
      path.join(dataRoot, 'projects', projectIdFor('app', root), 'project-index.json')
    );
    expect(candidates[1]).toBe(path.join(root, '.semantic-engine', 'project-index.json'));
    expect(candidates[2]).toBe(path.join(root, '.agent', 'semantic', 'project-index.json'));
    expect(candidates[3]).toBe(path.join(root, 'semantic', 'project-index.json'));
  });
});
