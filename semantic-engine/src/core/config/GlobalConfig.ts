/**
 * The user-level configuration file — one place for every default.
 *
 * Location: `<dataRoot>/config.json`, i.e. next to the generated data
 * (`%LOCALAPPDATA%\SemanticEngine`, `~/Library/Application Support/SemanticEngine`,
 * `$XDG_DATA_HOME/semantic-engine`). The CLI, the platform server and the UI
 * all read the same file, so a port, a model or a scan option has exactly one
 * home.
 *
 * Precedence for every value, highest first:
 *
 * ```text
 * command-line flag  >  environment variable  >  config.json  >  built-in default
 * ```
 *
 * The file is forgiving on purpose. A hand-edited value of the wrong type is
 * ignored with a warning and the default is used — a typo must never stop the
 * engine from starting. Secrets are never written here: API keys are read from
 * the environment variable *named* by `apiKeyEnvVar`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ArtifactLocation } from './DataRootResolver';

export const GLOBAL_CONFIG_FILE = 'config.json';
export const MODELS_DIR_NAME = 'models';
export const GLOBAL_CONFIG_VERSION = 1;

export type EmbeddingProviderKind = 'local' | 'ollama' | 'openai-compatible';

export interface GlobalConfig {
  readonly version: number;
  readonly server: {
    readonly host: string;
    readonly uiPort: number;
    readonly mcpPort: number;
  };
  /** What `semantic-engine start` turns on. */
  readonly start: {
    /** Run the file watcher so artifacts follow source changes. */
    readonly watch: boolean;
  };
  readonly artifacts: {
    readonly location: ArtifactLocation;
  };
  readonly scan: {
    readonly treeSitter: boolean;
    readonly useGitignore: boolean;
    readonly skipHiddenDirectories: boolean;
    readonly maxDepth: number;
    readonly maxFileSizeMb: number;
    readonly additionalIgnorePatterns: readonly string[];
    readonly git: boolean;
    readonly blueprint: boolean;
    /** Compiler diagnostics from a language server (the "deep scan"). */
    readonly lspDiagnostics: boolean;
    readonly diagnosticsBudgetMs: number;
  };
  readonly embedding: {
    /** Build vector chunks / embeddings for semantic search. */
    readonly enabled: boolean;
    readonly provider: EmbeddingProviderKind;
    /** Model id; for `local` either `hashing-256` or a downloaded catalog model. */
    readonly model: string;
    readonly useDefaultModel: boolean;
    readonly baseUrl: string;
    /** Name of the environment variable that holds the API key. */
    readonly apiKeyEnvVar: string;
    readonly normalize: boolean;
  };
  readonly chat: {
    readonly baseUrl: string;
    readonly model: string;
    readonly temperature: number;
    readonly apiKeyEnvVar: string;
  };
  readonly models: {
    /** Where downloaded embedding models live. Empty = `<dataRoot>/models`. */
    readonly dir: string;
    /** Hugging Face mirror for networks that cannot reach huggingface.co. Empty = the official host. */
    readonly hubUrl: string;
  };
}

export type GlobalConfigPatch = {
  [K in keyof GlobalConfig]?: GlobalConfig[K] extends object ? Partial<GlobalConfig[K]> : GlobalConfig[K];
};

export const LOCAL_DEFAULT_EMBEDDING_MODEL = 'hashing-256';

export function defaultGlobalConfig(): GlobalConfig {
  return {
    version: GLOBAL_CONFIG_VERSION,
    server: { host: '127.0.0.1', uiPort: 4000, mcpPort: 3000 },
    start: { watch: true },
    artifacts: { location: 'external' },
    scan: {
      treeSitter: true,
      useGitignore: true,
      skipHiddenDirectories: true,
      maxDepth: 0,
      maxFileSizeMb: 5,
      additionalIgnorePatterns: [],
      git: true,
      blueprint: true,
      lspDiagnostics: true,
      diagnosticsBudgetMs: 60000,
    },
    embedding: {
      enabled: true,
      provider: 'local',
      model: LOCAL_DEFAULT_EMBEDDING_MODEL,
      useDefaultModel: true,
      baseUrl: '',
      apiKeyEnvVar: '',
      normalize: true,
    },
    chat: {
      baseUrl: '',
      model: '',
      temperature: 0.2,
      apiKeyEnvVar: 'SEMANTIC_ENGINE_LLM_API_KEY',
    },
    models: { dir: '', hubUrl: '' },
  };
}

export function globalConfigPath(dataRoot: string): string {
  return path.join(dataRoot, GLOBAL_CONFIG_FILE);
}

/** Directory for downloaded embedding models. */
export function modelsDirFor(dataRoot: string, config?: GlobalConfig): string {
  const configured = (config?.models.dir ?? '').trim();
  return configured !== '' ? path.resolve(dataRoot, configured) : path.join(dataRoot, MODELS_DIR_NAME);
}

// ── validation ────────────────────────────────────────────────────────────

type Rule = (value: unknown) => boolean;

const isString: Rule = v => typeof v === 'string';
const isBool: Rule = v => typeof v === 'boolean';
const isPort: Rule = v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
const nonNegInt: Rule = v => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const positive: Rule = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const oneOf = (...allowed: string[]): Rule => v => typeof v === 'string' && allowed.includes(v);
const stringArray: Rule = v => Array.isArray(v) && v.every(item => typeof item === 'string');
const temperature: Rule = v => typeof v === 'number' && v >= 0 && v <= 2;

const RULES: Record<string, Record<string, Rule>> = {
  server: { host: isString, uiPort: isPort, mcpPort: isPort },
  start: { watch: isBool },
  artifacts: { location: oneOf('external', 'in-root') },
  scan: {
    treeSitter: isBool,
    useGitignore: isBool,
    skipHiddenDirectories: isBool,
    maxDepth: nonNegInt,
    maxFileSizeMb: positive,
    additionalIgnorePatterns: stringArray,
    git: isBool,
    blueprint: isBool,
    lspDiagnostics: isBool,
    diagnosticsBudgetMs: positive,
  },
  embedding: {
    enabled: isBool,
    provider: oneOf('local', 'ollama', 'openai-compatible'),
    model: isString,
    useDefaultModel: isBool,
    baseUrl: isString,
    apiKeyEnvVar: isString,
    normalize: isBool,
  },
  chat: { baseUrl: isString, model: isString, temperature, apiKeyEnvVar: isString },
  models: { dir: isString, hubUrl: isString },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Overlay `raw` onto `base`, keeping only known keys of the right type.
 * Everything rejected is reported in `warnings`; nothing throws.
 */
export function mergeGlobalConfig(
  base: GlobalConfig,
  raw: unknown,
  warnings: string[] = []
): GlobalConfig {
  if (!isRecord(raw)) {
    if (raw !== undefined) warnings.push('config root must be a JSON object; ignored');
    return base;
  }

  const result: Record<string, Record<string, unknown> | number> = {
    version: base.version,
  };

  for (const [section, rules] of Object.entries(RULES)) {
    const current = { ...(base as unknown as Record<string, Record<string, unknown>>)[section] };
    const incoming = raw[section];

    if (incoming !== undefined) {
      if (!isRecord(incoming)) {
        warnings.push(`"${section}" must be an object; ignored`);
      } else {
        for (const [key, value] of Object.entries(incoming)) {
          const rule = rules[key];
          if (!rule) {
            warnings.push(`unknown key "${section}.${key}"; ignored`);
          } else if (!rule(value)) {
            warnings.push(`invalid value for "${section}.${key}"; using ${JSON.stringify(current[key])}`);
          } else {
            current[key] = typeof value === 'string' ? value.trim() : value;
          }
        }
      }
    }
    result[section] = current;
  }

  return result as unknown as GlobalConfig;
}

export interface LoadedGlobalConfig {
  readonly config: GlobalConfig;
  readonly path: string;
  /** The file existed (or was just written). */
  readonly exists: boolean;
  readonly warnings: readonly string[];
}

/** Read `<dataRoot>/config.json`. A missing or broken file yields the defaults. */
export function loadGlobalConfig(dataRoot: string): LoadedGlobalConfig {
  const file = globalConfigPath(dataRoot);
  const warnings: string[] = [];
  const defaults = defaultGlobalConfig();

  if (!fs.existsSync(file)) {
    return { config: defaults, path: file, exists: false, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    warnings.push(`${file} is not valid JSON (${(error as Error).message}); using defaults`);
    return { config: defaults, path: file, exists: true, warnings };
  }

  return { config: mergeGlobalConfig(defaults, parsed, warnings), path: file, exists: true, warnings };
}

/** Atomic write: a reader never sees half a file. */
function writeConfigFile(file: string, config: GlobalConfig, document: unknown = config): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Like `loadGlobalConfig`, but writes the file with every default when it does
 * not exist yet, so the user has something to edit.
 */
export function ensureGlobalConfig(dataRoot: string): LoadedGlobalConfig {
  const loaded = loadGlobalConfig(dataRoot);
  if (loaded.exists) return loaded;

  try {
    writeConfigFile(loaded.path, loaded.config);
    return { ...loaded, exists: true };
  } catch (error) {
    return {
      ...loaded,
      warnings: [...loaded.warnings, `could not write ${loaded.path}: ${(error as Error).message}`],
    };
  }
}

/**
 * Serialise read-modify-write across processes (UI server, CLI children).
 * Exclusive-create lock file; a lock older than `STALE_MS` is taken over.
 */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

function withFileLock<T>(file: string, run: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        /* released between the two calls */
      }
      if (Date.now() > deadline) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return run();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Keys this version does not know are kept verbatim so a save never deletes them. */
function withUnknownKeys(file: string, config: GlobalConfig): Record<string, unknown> {
  let existing: unknown;
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return config as unknown as Record<string, unknown>;
  }
  if (!isRecord(existing)) return config as unknown as Record<string, unknown>;

  const out: Record<string, unknown> = { ...existing, ...(config as unknown as Record<string, unknown>) };
  for (const [section, value] of Object.entries(config as unknown as Record<string, unknown>)) {
    const previous = existing[section];
    if (isRecord(value) && isRecord(previous)) out[section] = { ...previous, ...value };
  }
  return out;
}

/** Merge a validated patch into the stored file and return the result. */
export function saveGlobalConfig(
  dataRoot: string,
  patch: unknown
): { readonly config: GlobalConfig; readonly warnings: readonly string[] } {
  const file = globalConfigPath(dataRoot);
  return withFileLock(file, () => {
    const loaded = loadGlobalConfig(dataRoot);
    const warnings: string[] = [];
    const config = mergeGlobalConfig(loaded.config, patch, warnings);
    writeConfigFile(loaded.path, config, withUnknownKeys(loaded.path, config));
    return { config, warnings };
  });
}

/**
 * The `scan.*` file/ignore settings in the shape the scanner takes. Empty when
 * nothing differs from the scanner's own defaults, so an untouched config
 * never changes what `index` produces.
 */
export function scannerOverridesFrom(config: GlobalConfig): {
  useGitignore?: boolean;
  skipHiddenDirectories?: boolean;
  maxDepth?: number;
  maxFileSizeBytes?: number;
  additionalIgnorePatterns?: readonly string[];
} {
  const defaults = defaultGlobalConfig().scan;
  const scan = config.scan;
  return {
    ...(scan.useGitignore !== defaults.useGitignore ? { useGitignore: scan.useGitignore } : {}),
    ...(scan.skipHiddenDirectories !== defaults.skipHiddenDirectories
      ? { skipHiddenDirectories: scan.skipHiddenDirectories }
      : {}),
    ...(scan.maxDepth !== defaults.maxDepth ? { maxDepth: scan.maxDepth } : {}),
    ...(scan.maxFileSizeMb !== defaults.maxFileSizeMb
      ? { maxFileSizeBytes: Math.round(scan.maxFileSizeMb * 1024 * 1024) }
      : {}),
    ...(scan.additionalIgnorePatterns.length > 0
      ? { additionalIgnorePatterns: scan.additionalIgnorePatterns }
      : {}),
  };
}
