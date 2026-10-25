/**
 * Where generated data lives — MULTI_PROJECT_GATEWAY_EXECUTION_PLAN فاز ۱ (D1/D2).
 *
 * Until now every artifact was written inside the workspace root
 * (`<root>/.semantic-engine`, see `ProjectPaths.PROJECT_OUTPUT_DIR`). The
 * multi-project work moves generated data to a per-user data directory so a
 * workspace never becomes dirty because of an index, and so several projects
 * can be served side by side from one Gateway.
 *
 * This module owns *only* the question "which directory is that". It is
 * deliberately side-effect free — `resolveDataRoot` never touches the disk —
 * and every input (`env`, `platform`, `homeDir`) is injectable so the three
 * supported platforms can be tested on any machine.
 *
 * Two rules from the plan are enforced here rather than left to callers:
 *
 *   - one single naming convention per platform, never a doubled
 *     `.semantic-engine` inside the platform data directory (the reference
 *     plan mixed `{{USER_DATA}}/.semantic-engine` with
 *     `$XDG_DATA_HOME/semantic-engine`; D1 resolves that to the latter);
 *   - the override arrives through the ordinary configuration layer, so
 *     `SEMANTIC_ENGINE_DATA_DIR` is simply `envVarNameFor(DATA_DIR_CONFIG_KEY)`
 *     and not a second, hand-rolled environment variable.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Configuration key for an explicit data directory override. */
export const DATA_DIR_CONFIG_KEY = 'semanticEngine.dataDir';

/** Configuration key selecting where artifacts are written. */
export const ARTIFACT_LOCATION_CONFIG_KEY = 'semanticEngine.artifactLocation';

/**
 * `envVarNameFor(DATA_DIR_CONFIG_KEY)` — asserted by `DataRootResolver.test.ts`
 * so the env name can never drift away from the schema key.
 */
export const DATA_DIR_ENV_VAR = 'SEMANTIC_ENGINE_DATA_DIR';

/**
 * Where artifacts live:
 *
 *   - `in-root`  — legacy and still the default in فاز ۱: `<root>/.semantic-engine`
 *   - `external` — the data directory resolved here
 *
 * فاز ۴ flips the default; until then both must behave identically to today.
 */
export type ArtifactLocation = 'in-root' | 'external';

export const ARTIFACT_LOCATIONS: readonly ArtifactLocation[] = ['in-root', 'external'];

/**
 * فاز ۴: the default is now the data directory.
 *
 * `in-root` stays fully supported (D10) — `--artifact-location in-root` or
 * `SEMANTIC_ENGINE_ARTIFACT_LOCATION=in-root` restores the old layout, and
 * `--out` overrides either mode.
 */
export const DEFAULT_ARTIFACT_LOCATION: ArtifactLocation = 'external';

/** Directory name used under the platform data directory. */
export const DATA_DIR_NAME_POSIX = 'semantic-engine';
export const DATA_DIR_NAME_WINDOWS = 'SemanticEngine';

export interface DataRootOptions {
  /** Explicit override (config `semanticEngine.dataDir` or `--data-dir`). */
  readonly dataDir?: string;
  /** Environment to read; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Target platform; defaults to `process.platform`. */
  readonly platform?: string;
  /** Home directory; defaults to `os.homedir()`. */
  readonly homeDir?: string;
}

export function isArtifactLocation(value: unknown): value is ArtifactLocation {
  return typeof value === 'string' && (ARTIFACT_LOCATIONS as readonly string[]).includes(value);
}

/**
 * Coerce a configured value, falling back instead of throwing: an unknown
 * value in a config file must not stop an index run, it only has to be
 * visible. Callers that need strictness (CLI validation, the Gateway config
 * schema) use `isArtifactLocation` directly.
 */
export function artifactLocationOrDefault(
  value: unknown,
  fallback: ArtifactLocation = DEFAULT_ARTIFACT_LOCATION
): ArtifactLocation {
  return isArtifactLocation(value) ? value : fallback;
}

/**
 * Windows paths must be built with the Windows separator even when this code
 * runs elsewhere (tests, config previews). On Windows `path` already *is*
 * `path.win32`, so this is a no-op there.
 */
function pathFor(platform: string): typeof path {
  return platform === 'win32' ? path.win32 : path;
}

function expandHome(value: string, homeDir: string, platformPath: typeof path): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return platformPath.join(homeDir, value.slice(2));
  }
  return value;
}

/**
 * Platform default, following the usual OS conventions:
 *
 * ```text
 * linux    $XDG_DATA_HOME/semantic-engine   (or ~/.local/share/semantic-engine)
 * macOS    ~/Library/Application Support/SemanticEngine
 * Windows  %LOCALAPPDATA%/SemanticEngine
 * ```
 *
 * A relative `XDG_DATA_HOME` is ignored on purpose: the XDG spec says a
 * relative value is invalid, and joining it onto the cwd would scatter data
 * directories across whatever directory a command happened to run in.
 */
export function platformDataRoot(options: DataRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const platformPath = pathFor(platform);
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();

  if (platform === 'darwin') {
    return platformPath.join(homeDir, 'Library', 'Application Support', DATA_DIR_NAME_WINDOWS);
  }

  if (platform === 'win32') {
    const localAppData = (env['LOCALAPPDATA'] ?? '').trim();
    const base = localAppData !== ''
      ? localAppData
      : platformPath.join(homeDir, 'AppData', 'Local');
    return platformPath.join(base, DATA_DIR_NAME_WINDOWS);
  }

  const xdg = (env['XDG_DATA_HOME'] ?? '').trim();
  const base = xdg !== '' && platformPath.isAbsolute(xdg)
    ? xdg
    : platformPath.join(homeDir, '.local', 'share');
  return platformPath.join(base, DATA_DIR_NAME_POSIX);
}

/**
 * The data directory to use, without touching the disk.
 *
 * Precedence: explicit `dataDir` → `SEMANTIC_ENGINE_DATA_DIR` → platform
 * default. An empty string never counts as a value, so an unset config key
 * behaves exactly like an absent one.
 */
export function resolveDataRoot(options: DataRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const platformPath = pathFor(platform);
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();

  const explicit = (options.dataDir ?? '').trim();
  if (explicit !== '') {
    return platformPath.resolve(expandHome(explicit, homeDir, platformPath));
  }

  const fromEnv = (env[DATA_DIR_ENV_VAR] ?? '').trim();
  if (fromEnv !== '') {
    return platformPath.resolve(expandHome(fromEnv, homeDir, platformPath));
  }

  return platformDataRoot({ ...options, platform, env, homeDir });
}

/**
 * `resolveDataRoot` plus the guarantee that the directory exists and is
 * writable by this user, created with `0700`: indexes, blueprints and
 * logs are not world-readable material.
 *
 * The mode is applied with an explicit `chmod` after creation because
 * `mkdirSync({ mode })` is masked by the process umask.
 */
export function ensureDataRoot(options: DataRootOptions = {}): string {
  const dataRoot = resolveDataRoot(options);

  try {
    const stats = fs.statSync(dataRoot);
    if (!stats.isDirectory()) {
      throw new Error(
        `semantic-engine data directory path exists and is not a directory: ${dataRoot}`
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
    fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  }

  fs.chmodSync(dataRoot, 0o700);

  try {
    fs.accessSync(dataRoot, fs.constants.W_OK);
  } catch {
    throw new Error(`semantic-engine data directory is not writable: ${dataRoot}`);
  }

  return dataRoot;
}
