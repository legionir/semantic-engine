import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ARTIFACT_LOCATION_CONFIG_KEY,
  ARTIFACT_LOCATIONS,
  DATA_DIR_CONFIG_KEY,
  DATA_DIR_ENV_VAR,
  DEFAULT_ARTIFACT_LOCATION,
  artifactLocationOrDefault,
  ensureDataRoot,
  isArtifactLocation,
  platformDataRoot,
  resolveDataRoot,
} from './DataRootResolver';
import { envVarNameFor } from '../../host/Config';

const HOME = path.join(path.sep, 'home', 'tester');
const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'contracts', 'config.schema.json');

describe('DataRootResolver — one platform-aware data directory', () => {

  it('follows XDG on Linux and falls back to ~/.local/share', () => {
    expect(resolveDataRoot({ platform: 'linux', homeDir: HOME, env: {} })).toBe(
      path.join(HOME, '.local', 'share', 'semantic-engine')
    );

    expect(
      resolveDataRoot({ platform: 'linux', homeDir: HOME, env: { XDG_DATA_HOME: '/srv/data' } })
    ).toBe(path.join('/srv', 'data', 'semantic-engine'));

    /* A relative XDG_DATA_HOME is invalid per spec and must not scatter data
       directories across whatever cwd a command ran in. */
    expect(
      resolveDataRoot({ platform: 'linux', homeDir: HOME, env: { XDG_DATA_HOME: 'relative/dir' } })
    ).toBe(path.join(HOME, '.local', 'share', 'semantic-engine'));
  });

  it('uses the macOS and Windows conventions', () => {
    expect(resolveDataRoot({ platform: 'darwin', homeDir: HOME, env: {} })).toBe(
      path.join(HOME, 'Library', 'Application Support', 'SemanticEngine')
    );

    const windowsHome = 'C:\\Users\\tester';
    expect(
      resolveDataRoot({
        platform: 'win32',
        homeDir: windowsHome,
        env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      })
    ).toBe('C:\\Users\\tester\\AppData\\Local\\SemanticEngine');

    expect(resolveDataRoot({ platform: 'win32', homeDir: windowsHome, env: {} })).toBe(
      'C:\\Users\\tester\\AppData\\Local\\SemanticEngine'
    );
  });

  it('never nests .semantic-engine inside the platform data directory', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const resolved = platformDataRoot({ platform, homeDir: HOME, env: {} });
      const segments = resolved.split(/[\\/]/);
      expect(segments).not.toContain('.semantic-engine');
      expect(segments.length).toBeGreaterThan(2);
    }
  });

  it('applies the documented precedence: dataDir > env > platform default', () => {
    const platformDefault = resolveDataRoot({ platform: 'linux', homeDir: HOME, env: {} });

    expect(
      resolveDataRoot({
        platform: 'linux',
        homeDir: HOME,
        env: { [DATA_DIR_ENV_VAR]: '/from/env' },
      })
    ).toBe(path.join(path.sep, 'from', 'env'));

    expect(
      resolveDataRoot({
        dataDir: '/explicit',
        platform: 'linux',
        homeDir: HOME,
        env: { [DATA_DIR_ENV_VAR]: '/from/env' },
      })
    ).toBe(path.join(path.sep, 'explicit'));

    /* An empty value is not a value — an unset config key must behave exactly
       like an absent one. */
    expect(
      resolveDataRoot({ dataDir: '   ', platform: 'linux', homeDir: HOME, env: { [DATA_DIR_ENV_VAR]: '' } })
    ).toBe(platformDefault);
  });

  it('expands a leading ~ against the home directory', () => {
    expect(
      resolveDataRoot({ dataDir: '~/engine-data', platform: 'linux', homeDir: HOME, env: {} })
    ).toBe(path.join(HOME, 'engine-data'));
  });

  it('validates artifact locations instead of guessing', () => {
    expect(isArtifactLocation('in-root')).toBe(true);
    expect(isArtifactLocation('external')).toBe(true);
    expect(isArtifactLocation('somewhere')).toBe(false);
    expect(isArtifactLocation(undefined)).toBe(false);

    expect(artifactLocationOrDefault('external')).toBe('external');
    expect(artifactLocationOrDefault('nonsense')).toBe(DEFAULT_ARTIFACT_LOCATION);
    expect(artifactLocationOrDefault('nonsense', 'in-root')).toBe('in-root');
    /* فاز ۴: the data directory is the default now; `in-root` stays opt-in. */
    expect(DEFAULT_ARTIFACT_LOCATION).toBe('external');
    expect([...ARTIFACT_LOCATIONS]).toEqual(['in-root', 'external']);
  });

  it('creates the data root privately and refuses a file in its place', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'se-data-root-'));
    try {
      const target = path.join(base, 'nested', 'data');
      const created = ensureDataRoot({
        dataDir: target,
        platform: 'linux',
        homeDir: base,
        env: {},
      });

      expect(created).toBe(target);
      expect(fs.statSync(created).isDirectory()).toBe(true);
      /* 0700 — indexes, SQLite databases and logs are not world-readable. */
      expect(fs.statSync(created).mode & 0o777).toBe(0o700);

      /* Idempotent: a second call must not throw. */
      expect(ensureDataRoot({ dataDir: target, platform: 'linux', homeDir: base, env: {} })).toBe(target);

      const blocked = path.join(base, 'a-file');
      fs.writeFileSync(blocked, 'not a directory');
      expect(() =>
        ensureDataRoot({ dataDir: blocked, platform: 'linux', homeDir: base, env: {} })
      ).toThrow(/not a directory/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps the environment names tied to the config keys', () => {
    expect(envVarNameFor(DATA_DIR_CONFIG_KEY)).toBe('SEMANTIC_ENGINE_DATA_DIR');
    expect(envVarNameFor(DATA_DIR_CONFIG_KEY)).toBe(DATA_DIR_ENV_VAR);
    expect(envVarNameFor(ARTIFACT_LOCATION_CONFIG_KEY)).toBe('SEMANTIC_ENGINE_ARTIFACT_LOCATION');
  });

  it('declares both keys in contracts/config.schema.json with a default', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as {
      properties: Record<string, { default?: unknown; enum?: string[] }>;
    };

    const dataDir = schema.properties[DATA_DIR_CONFIG_KEY];
    expect(dataDir).toBeDefined();
    expect(dataDir).toHaveProperty('default');
    expect(dataDir!.default).toBeNull();

    const location = schema.properties[ARTIFACT_LOCATION_CONFIG_KEY];
    expect(location).toBeDefined();
    expect(location!.default).toBe(DEFAULT_ARTIFACT_LOCATION);
    expect(location!.enum).toEqual([...ARTIFACT_LOCATIONS]);
  });
});
