/**
 * Worker configuration — MULTI_PROJECT_GATEWAY_EXECUTION_PLAN فاز ۵.
 *
 * One typed description of "how this project's worker should run". The CLI
 * builds it from flags, the Gateway stores it, the UI form (فاز ۱۲) edits it,
 * and `workerArgv` turns it into a process argument vector. Nothing else is
 * allowed to invent command lines, which is the rule that keeps a user-supplied
 * string from ever reaching a shell.
 *
 * Two deliberate omissions:
 *
 *   - `--json`, `--help` and `--version` are CLI concerns, not configuration;
 *   - a token is never part of this object. Only the *name* of the environment
 *     variable holding it (`tokenEnvVar`) is, so a config can be logged,
 *     persisted and shown in a UI without leaking a secret.
 */

import type { EmbeddingProviderName } from '../vector/createEmbeddingGenerator';
import { EMBEDDING_PROVIDER_NAMES } from '../vector/createEmbeddingGenerator';

/** همان union که لایهٔ vector می‌شناسد؛ یک منبع، نه دو. */
export type EmbeddingProvider = EmbeddingProviderName;

export const EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = EMBEDDING_PROVIDER_NAMES;

export type BlueprintMode = 'always' | 'threshold';

export const BLUEPRINT_MODES: readonly BlueprintMode[] = ['always', 'threshold'];

/**
 * How the Gateway reaches the worker (D5): loopback TCP on an allocated port,
 * or a Unix domain socket where the platform supports it.
 */
export type WorkerTransport = 'loopback' | 'socket';

export const WORKER_TRANSPORTS: readonly WorkerTransport[] = ['loopback', 'socket'];

export interface WorkerIndexingConfig {
  readonly vectors: boolean;
  readonly sqlite: boolean;
  readonly blueprint: boolean;
  readonly git: boolean;
  readonly treeSitter: boolean;
  readonly pretty: boolean;
}

export interface WorkerWatchConfig {
  readonly debounceMs: number;
  readonly blueprintMode: BlueprintMode;
  readonly skipInitialIndex: boolean;
}

export interface WorkerServiceConfig {
  readonly transport: WorkerTransport;
  readonly host: string;
  /** پورت تخصیص‌یافته توسط Gateway؛ `undefined` یعنی خودش انتخاب کند. */
  readonly port?: number;
  readonly uiPort?: number;
  readonly mcpPort?: number;
  readonly socketPath?: string;
  readonly http: boolean;
  readonly stdio: boolean;
  readonly web: boolean;
}

export interface WorkerSecurityConfig {
  /** worker فقط از طریق Gateway در دسترس است (فاز ۶). */
  readonly gatewayManaged: boolean;
  readonly allowRemote: boolean;
  /** نام متغیر محیطیِ توکن — هرگز خودِ توکن. */
  readonly tokenEnvVar?: string;
}

export interface WorkerEmbeddingConfig {
  readonly enabled: boolean;
  readonly provider: EmbeddingProvider;
  readonly model?: string;
  readonly baseUrl?: string;
  /** نام متغیر محیطیِ کلید API — هرگز خودِ کلید. */
  readonly apiKeyEnvVar?: string;
  readonly normalize: boolean;
  /** مدل پیش‌فرض provider کافی است و `model` لازم نیست. */
  readonly useDefaultModel?: boolean;
}

export interface ProjectWorkerConfig {
  readonly projectId: string;
  readonly name: string;
  readonly rootPath: string;
  readonly dataDir?: string;
  /** `--out`؛ فقط برای سازگاری با گذشته (D10). */
  readonly outOverride?: string;
  readonly autoStart: boolean;
  readonly watch: boolean;
  readonly indexing: WorkerIndexingConfig;
  readonly watchOptions: WorkerWatchConfig;
  readonly service: WorkerServiceConfig;
  readonly security: WorkerSecurityConfig;
  readonly embedding: WorkerEmbeddingConfig;
}

/** نوعِ ورودیِ آزاد (JSON/UI/CLI) که پیش از اعتبارسنجی پذیرفته می‌شود. */
export type WorkerConfigInput = {
  readonly [K in keyof ProjectWorkerConfig]?: ProjectWorkerConfig[K] extends object
    ? Partial<ProjectWorkerConfig[K]> | ProjectWorkerConfig[K]
    : ProjectWorkerConfig[K];
};
