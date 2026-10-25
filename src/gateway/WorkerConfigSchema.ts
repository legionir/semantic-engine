/**
 * WorkerConfig defaults, schema and validation — فاز ۵.
 *
 * Everything that can be wrong with a worker configuration is caught here,
 * before a process is spawned: a bad root, a data directory inside the
 * checkout, a debounce outside the sane range, a socket path that is not
 * absolute, an embedding provider without a base URL, or — the one that
 * matters most — a secret written into the config instead of an environment
 * variable name.
 *
 * `validateWorkerConfig` returns every problem at once rather than the first
 * one, because a form that reports one error per submit teaches the user to
 * guess.
 */

import * as path from 'path';
import {
  BLUEPRINT_MODES,
  EMBEDDING_PROVIDERS,
  EmbeddingProvider,
  ProjectWorkerConfig,
  WORKER_TRANSPORTS,
  WorkerConfigInput,
  ARTIFACT_LOCATIONS,
  CACHE_MODES,
} from './types';
import { apiKeyEnvVarProblem } from '../core/security/apiKeyEnvPolicy';
import { assertProjectRoot, isPathSafeProjectId } from '../core/config/ProjectIdentity';

export const DEBOUNCE_MS_MIN = 25;
export const DEBOUNCE_MS_MAX = 60_000;

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface WorkerConfigValidationOptions {
  /**
   * بررسی وجود root روی دیسک. در تست‌های واحد و در مسیرهایی که root بعداً
   * ساخته می‌شود، `false` داده می‌شود.
   */
  readonly checkFileSystem?: boolean;
  /** تشخیص پروژهٔ تکراری؛ معمولاً `registry.getByRoot` است. */
  readonly isRootRegistered?: (canonicalRoot: string) => boolean;
  /**
   * data directory داخل source root مجاز نیست، مگر اینکه صریحاً خواسته شود
   * (مثلاً یک استقرار تک‌پوشه‌ای که عمداً همه‌چیز را یک‌جا می‌خواهد).
   */
  readonly allowDataDirInsideRoot?: boolean;
}

export type WorkerConfigValidationResult =
  | { readonly ok: true; readonly config: ProjectWorkerConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

export const DEFAULT_WORKER_CONFIG: Omit<
  ProjectWorkerConfig,
  'projectId' | 'name' | 'rootPath'
> = {
  autoStart: false,
  watch: true,
  indexing: {
    vectors: false,
    blueprint: true,
    git: true,
    treeSitter: true,
    pretty: true,
  },
  scan: {
    useGitignore: true,
    skipHiddenDirectories: true,
    maxDepth: 0,
    maxFileSizeMb: 5,
  },
  diagnostics: {
    lsp: false,
  },
  cache: {
    mode: 'use',
  },
  watchOptions: {
    debounceMs: 500,
    blueprintMode: 'always',
    skipInitialIndex: false,
  },
  service: {
    transport: 'loopback',
    host: '127.0.0.1',
    http: false,
    stdio: false,
    web: false,
  },
  security: {
    gatewayManaged: false,
    allowRemote: false,
  },
  embedding: {
    enabled: false,
    provider: 'local',
    normalize: true,
  },
};

/** پر کردن پیش‌فرض‌ها؛ هیچ اعتبارسنجی اینجا انجام نمی‌شود. */
export function createWorkerConfig(input: WorkerConfigInput): ProjectWorkerConfig {
  const base = DEFAULT_WORKER_CONFIG;
  const indexing = input.indexing ?? {};
  const watchOptions = input.watchOptions ?? {};
  const scan = input.scan ?? {};
  const diagnostics = input.diagnostics ?? {};
  const cache = input.cache ?? {};
  const service = input.service ?? {};
  const security = input.security ?? {};
  const embedding = input.embedding ?? {};

  return {
    projectId: String(input.projectId ?? ''),
    name: String(input.name ?? ''),
    rootPath: String(input.rootPath ?? ''),
    ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
    ...(input.outOverride !== undefined ? { outOverride: input.outOverride } : {}),
    ...(input.artifactLocation !== undefined ? { artifactLocation: input.artifactLocation } : {}),
    autoStart: input.autoStart ?? base.autoStart,
    watch: input.watch ?? base.watch,
    scan: {
      useGitignore: scan.useGitignore ?? base.scan.useGitignore,
      skipHiddenDirectories: scan.skipHiddenDirectories ?? base.scan.skipHiddenDirectories,
      maxDepth: scan.maxDepth ?? base.scan.maxDepth,
      maxFileSizeMb: scan.maxFileSizeMb ?? base.scan.maxFileSizeMb,
      ...(scan.ignore !== undefined && scan.ignore !== '' ? { ignore: scan.ignore } : {}),
    },
    diagnostics: {
      lsp: diagnostics.lsp ?? base.diagnostics.lsp,
      ...(diagnostics.budgetMs !== undefined ? { budgetMs: diagnostics.budgetMs } : {}),
    },
    cache: { mode: cache.mode ?? base.cache.mode },
    indexing: {
      vectors: indexing.vectors ?? base.indexing.vectors,
      blueprint: indexing.blueprint ?? base.indexing.blueprint,
      git: indexing.git ?? base.indexing.git,
      treeSitter: indexing.treeSitter ?? base.indexing.treeSitter,
      pretty: indexing.pretty ?? base.indexing.pretty,
    },
    watchOptions: {
      debounceMs: watchOptions.debounceMs ?? base.watchOptions.debounceMs,
      blueprintMode: watchOptions.blueprintMode ?? base.watchOptions.blueprintMode,
      skipInitialIndex: watchOptions.skipInitialIndex ?? base.watchOptions.skipInitialIndex,
    },
    service: {
      transport: service.transport ?? base.service.transport,
      host: service.host ?? base.service.host,
      ...(service.port !== undefined ? { port: service.port } : {}),
      ...(service.uiPort !== undefined ? { uiPort: service.uiPort } : {}),
      ...(service.mcpPort !== undefined ? { mcpPort: service.mcpPort } : {}),
      ...(service.socketPath !== undefined ? { socketPath: service.socketPath } : {}),
      http: service.http ?? base.service.http,
      stdio: service.stdio ?? base.service.stdio,
      web: service.web ?? base.service.web,
    },
    security: {
      gatewayManaged: security.gatewayManaged ?? base.security.gatewayManaged,
      allowRemote: security.allowRemote ?? base.security.allowRemote,
      ...(security.tokenEnvVar !== undefined ? { tokenEnvVar: security.tokenEnvVar } : {}),
    },
    embedding: {
      enabled: embedding.enabled ?? base.embedding.enabled,
      provider: embedding.provider ?? base.embedding.provider,
      ...(embedding.model !== undefined ? { model: embedding.model } : {}),
      ...(embedding.baseUrl !== undefined ? { baseUrl: embedding.baseUrl } : {}),
      ...(embedding.apiKeyEnvVar !== undefined ? { apiKeyEnvVar: embedding.apiKeyEnvVar } : {}),
      normalize: embedding.normalize ?? base.embedding.normalize,
      ...(embedding.useDefaultModel !== undefined
        ? { useDefaultModel: embedding.useDefaultModel }
        : {}),
    },
  };
}

export function validateWorkerConfig(
  input: WorkerConfigInput,
  options: WorkerConfigValidationOptions = {}
): WorkerConfigValidationResult {
  const checkFileSystem = options.checkFileSystem ?? true;
  const errors: string[] = [];

  /* توکن هرگز بخشی از config نیست؛ فقط نام متغیر محیطی. */
  if ('token' in input || 'apiKey' in input) {
    errors.push(
      'a secret must not be part of the worker config; pass security.tokenEnvVar or embedding.apiKeyEnvVar instead'
    );
  }

  const config = createWorkerConfig(input);

  if (!isPathSafeProjectId(config.projectId)) {
    errors.push(
      `projectId ${JSON.stringify(config.projectId)} is not usable as a directory name; ` +
        'expected lowercase letters, digits, dot, dash or underscore, starting with a letter or digit'
    );
  }

  if (config.name.trim() === '') {
    errors.push('name must not be empty');
  }

  let canonicalRoot = config.rootPath;
  if (config.rootPath.trim() === '') {
    errors.push('rootPath must not be empty');
  } else if (checkFileSystem) {
    try {
      canonicalRoot = assertProjectRoot(config.rootPath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (options.isRootRegistered && options.isRootRegistered(canonicalRoot)) {
    errors.push(`a project is already registered for ${canonicalRoot}`);
  }

  if (config.dataDir !== undefined && config.dataDir.trim() !== '') {
    const resolvedData = path.resolve(config.dataDir);
    const insideRoot =
      resolvedData === canonicalRoot || resolvedData.startsWith(canonicalRoot + path.sep);
    if (insideRoot && !options.allowDataDirInsideRoot) {
      errors.push(
        `dataDir ${resolvedData} is inside the workspace root; generated data must live outside the checkout`
      );
    }
  }

  const { scan } = config;
  if (!Number.isInteger(scan.maxDepth) || scan.maxDepth < 0 || scan.maxDepth > 1000) {
    errors.push('scan.maxDepth must be an integer between 0 (unlimited) and 1000');
  }
  if (!Number.isFinite(scan.maxFileSizeMb) || scan.maxFileSizeMb <= 0 || scan.maxFileSizeMb > 10_240) {
    errors.push('scan.maxFileSizeMb must be greater than 0 and at most 10240');
  }
  if (config.diagnostics.budgetMs !== undefined
    && (!Number.isInteger(config.diagnostics.budgetMs) || config.diagnostics.budgetMs < 0)) {
    errors.push('diagnostics.budgetMs must be a non-negative integer (milliseconds)');
  }
  if (!(CACHE_MODES as readonly string[]).includes(config.cache.mode)) {
    errors.push(`cache.mode must be one of: ${CACHE_MODES.join(', ')}`);
  }
  if (config.artifactLocation !== undefined
    && !(ARTIFACT_LOCATIONS as readonly string[]).includes(config.artifactLocation)) {
    errors.push(`artifactLocation must be one of: ${ARTIFACT_LOCATIONS.join(', ')}`);
  }

  const { debounceMs } = config.watchOptions;
  if (!Number.isInteger(debounceMs) || debounceMs < DEBOUNCE_MS_MIN || debounceMs > DEBOUNCE_MS_MAX) {
    errors.push(
      `watchOptions.debounceMs must be an integer between ${DEBOUNCE_MS_MIN} and ${DEBOUNCE_MS_MAX}`
    );
  }

  if (!(BLUEPRINT_MODES as readonly string[]).includes(config.watchOptions.blueprintMode)) {
    errors.push(
      `watchOptions.blueprintMode must be one of: ${BLUEPRINT_MODES.join(', ')}`
    );
  }

  if (!(WORKER_TRANSPORTS as readonly string[]).includes(config.service.transport)) {
    errors.push(`service.transport must be one of: ${WORKER_TRANSPORTS.join(', ')}`);
  }

  for (const key of ['port', 'uiPort', 'mcpPort'] as const) {
    const value = config.service[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 65_535)) {
      errors.push(`service.${key} must be an integer between 0 and 65535`);
    }
  }

  if (config.service.transport === 'socket') {
    const socketPath = config.service.socketPath ?? '';
    if (socketPath.trim() === '') {
      errors.push('service.socketPath is required when service.transport is "socket"');
    } else if (!path.isAbsolute(socketPath)) {
      errors.push(`service.socketPath must be absolute: ${socketPath}`);
    } else if (
      socketPath === canonicalRoot ||
      socketPath.startsWith(canonicalRoot + path.sep)
    ) {
      errors.push('service.socketPath must not live inside the workspace root');
    }
  }

  if (config.security.gatewayManaged && config.security.allowRemote) {
    errors.push('a gateway-managed worker must not allow remote connections');
  }

  if (config.security.gatewayManaged && !config.security.tokenEnvVar) {
    errors.push('a gateway-managed worker requires security.tokenEnvVar (the internal token)');
  }

  if (config.security.tokenEnvVar !== undefined && !ENV_VAR_NAME.test(config.security.tokenEnvVar)) {
    errors.push('security.tokenEnvVar must be an environment variable name');
  }

  const { embedding } = config;
  if (!(EMBEDDING_PROVIDERS as readonly string[]).includes(embedding.provider)) {
    errors.push(`embedding.provider must be one of: ${EMBEDDING_PROVIDERS.join(', ')}`);
  }

  if (embedding.enabled && embedding.provider !== 'local') {
    const baseUrl = embedding.baseUrl ?? '';
    if (baseUrl.trim() === '') {
      errors.push(`embedding provider "${embedding.provider}" needs embedding.baseUrl`);
    } else if (!/^https?:\/\//i.test(baseUrl)) {
      errors.push(`embedding.baseUrl must be an http(s) URL: ${baseUrl}`);
    }

    if ((embedding.model ?? '').trim() === '' && !embedding.useDefaultModel) {
      errors.push(
        `embedding provider "${embedding.provider}" needs embedding.model (or embedding.useDefaultModel)`
      );
    }
  }

  const keyVarProblem =
    embedding.apiKeyEnvVar !== undefined ? apiKeyEnvVarProblem(embedding.apiKeyEnvVar) : null;
  if (keyVarProblem) {
    errors.push(`embedding.apiKeyEnvVar ${keyVarProblem}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: { ...config, rootPath: canonicalRoot },
  };
}

/**
 *_projection_ صریح برای لاگ، manifest و UI.
 *
 * امروز config هیچ فیلد محرمانه‌ای ندارد، ولی این تابع تضمین می‌کند که اگر
 * کسی بعداً فیلدی اضافه کرد، بی‌صدا وارد لاگ نشود: فقط فیلدهای شناخته‌شده
 * بیرون می‌آیند.
 */
export function redactWorkerConfig(config: ProjectWorkerConfig): ProjectWorkerConfig {
  return createWorkerConfig(config);
}

/** JSON Schema معادل، برای validation سمت سرور و ساخت فرم UI در فاز ۱۲. */
export const WORKER_CONFIG_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ai-coder.local/schemas/worker-config.schema.json',
  title: 'ProjectWorkerConfig',
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'name', 'rootPath'],
  properties: {
    projectId: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
    name: { type: 'string', minLength: 1 },
    rootPath: { type: 'string', minLength: 1 },
    dataDir: { type: 'string' },
    outOverride: { type: 'string' },
    artifactLocation: { type: 'string', enum: [...ARTIFACT_LOCATIONS] },
    autoStart: { type: 'boolean', default: false },
    watch: { type: 'boolean', default: true },
    scan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        useGitignore: { type: 'boolean', default: true },
        skipHiddenDirectories: { type: 'boolean', default: true },
        maxDepth: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
        maxFileSizeMb: { type: 'number', exclusiveMinimum: 0, maximum: 10240, default: 5 },
        ignore: { type: 'string' },
      },
    },
    diagnostics: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lsp: { type: 'boolean', default: false },
        budgetMs: { type: 'integer', minimum: 0 },
      },
    },
    cache: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: [...CACHE_MODES], default: 'use' },
      },
    },
    indexing: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vectors: { type: 'boolean', default: false },
        blueprint: { type: 'boolean', default: true },
        git: { type: 'boolean', default: true },
        treeSitter: { type: 'boolean', default: true },
        pretty: { type: 'boolean', default: true },
      },
    },
    watchOptions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        debounceMs: {
          type: 'integer',
          minimum: DEBOUNCE_MS_MIN,
          maximum: DEBOUNCE_MS_MAX,
          default: 500,
        },
        blueprintMode: { type: 'string', enum: [...BLUEPRINT_MODES], default: 'always' },
        skipInitialIndex: { type: 'boolean', default: false },
      },
    },
    service: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transport: { type: 'string', enum: [...WORKER_TRANSPORTS], default: 'loopback' },
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'integer', minimum: 0, maximum: 65535 },
        uiPort: { type: 'integer', minimum: 0, maximum: 65535 },
        mcpPort: { type: 'integer', minimum: 0, maximum: 65535 },
        socketPath: { type: 'string' },
        http: { type: 'boolean', default: false },
        stdio: { type: 'boolean', default: false },
        web: { type: 'boolean', default: false },
      },
    },
    security: {
      type: 'object',
      additionalProperties: false,
      properties: {
        gatewayManaged: { type: 'boolean', default: false },
        allowRemote: { type: 'boolean', default: false },
        tokenEnvVar: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      },
    },
    embedding: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: false },
        provider: { type: 'string', enum: [...EMBEDDING_PROVIDERS], default: 'local' },
        model: { type: 'string' },
        baseUrl: { type: 'string' },
        apiKeyEnvVar: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
        normalize: { type: 'boolean', default: true },
        useDefaultModel: { type: 'boolean' },
      },
    },
  },
} as const;

/** provider معتبر است؟ (برای مسیر CLI که خطای خودش را می‌سازد) */
export function isEmbeddingProvider(value: unknown): value is EmbeddingProvider {
  return typeof value === 'string' && (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}
