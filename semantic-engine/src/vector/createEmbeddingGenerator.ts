/**
 * One factory for every embedding provider — فاز ۵.
 *
 * Until now the "which generator do I build" decision lived inside
 * `server/routes/jobRoutes.ts`, so the platform server could use Ollama or an
 * OpenAI-compatible endpoint while the CLI could only ever build
 * `HashingEmbeddingGenerator`. Two code paths that must agree are how a user
 * ends up with a UI-configured model and a silently different index.
 *
 * This module is that single decision point; `jobRoutes` and the CLI both call
 * it.
 *
 * Secrets: the caller resolves the API key from the environment and passes the
 * value in. Nothing here reads a config file or logs the key.
 */

import { IEmbeddingGenerator } from './EmbeddingGenerator';
import { HashingEmbeddingGenerator } from './HashingEmbeddingGenerator';
import { LocalEmbeddingGenerator } from './LocalEmbeddingGenerator';
import { RemoteEmbeddingGenerator, RemoteEmbeddingProvider } from './RemoteEmbeddingGenerator';
import { resolveDataRoot } from '../core/config/DataRootResolver';
import {
  LOCAL_DEFAULT_EMBEDDING_MODEL,
  loadGlobalConfig,
  modelsDirFor,
} from '../core/config/GlobalConfig';
import { LocalModelStore } from '../services/providers/LocalModelStore';

export type EmbeddingProviderName = 'local' | RemoteEmbeddingProvider;

export const EMBEDDING_PROVIDER_NAMES: readonly EmbeddingProviderName[] = [
  'local',
  'ollama',
  'openai-compatible',
];

export function isEmbeddingProviderName(value: unknown): value is EmbeddingProviderName {
  return (
    typeof value === 'string' && (EMBEDDING_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

export interface EmbeddingGeneratorSpec {
  readonly enabled: boolean;
  readonly provider?: EmbeddingProviderName;
  readonly model?: string;
  readonly baseUrl?: string;
  /** مقدار کلید (از محیط خوانده شده)، نه نام متغیر. */
  readonly apiKey?: string;
  readonly useDefaultModel?: boolean;
  readonly normalize?: boolean;
  /** Folder of downloaded local models; defaults to `<dataRoot>/models`. */
  readonly modelsDir?: string;
}

/**
 * Where downloaded models live: explicit value, then the
 * `SEMANTIC_ENGINE_MODELS_DIR` variable, then `models.dir` of the user config,
 * then `<dataRoot>/models`.
 */
export function resolveModelsDir(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit;
  const fromEnv = (process.env['SEMANTIC_ENGINE_MODELS_DIR'] ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  const dataRoot = resolveDataRoot();
  return modelsDirFor(dataRoot, loadGlobalConfig(dataRoot).config);
}

/**
 * ساخت generator مطابق spec.
 *
 * `enabled: false` → `null` (بدون vector). `local` → hashing قطعی و بدون
 * وابستگی native؛ بقیه → `RemoteEmbeddingGenerator` که به `baseUrl` و `model`
 * نیاز دارد و در نبودشان **بلند** خطا می‌دهد، چون یک index بی‌embedding که
 * بی‌صدا ساخته شود بعداً قابل تشخیص نیست.
 */
export function createEmbeddingGenerator(spec: EmbeddingGeneratorSpec): IEmbeddingGenerator | null {
  if (!spec.enabled) return null;

  const provider: EmbeddingProviderName = spec.provider ?? 'local';

  if (provider === 'local') {
    /*
    | The production-safe local provider is deterministic hashing. The
    | transformer/native stack is intentionally not bundled by default because its
    | transitive audit contained critical/high vulnerabilities and its model
    | download is not suitable for an unisolated worker.
    |
    | اما وقتی کاربر صراحتاً یک پوشهٔ مدل محلی می‌دهد
    | (`SEMANTIC_ENGINE_LOCAL_MODEL_PATH`)، همان مدل ONNX آفلاین بارگذاری
    | می‌شود و embedding معناییِ واقعی (نه hashing) تولید می‌کند. این مسیر
    | opt-in است؛ نبودِ env دقیقاً همان رفتار قبلی را می‌دهد.
    */
    const localModelPath = process.env.SEMANTIC_ENGINE_LOCAL_MODEL_PATH;
    if (localModelPath) {
      return new LocalEmbeddingGenerator({
        ...(spec.model && spec.model.length > 0 ? { model: spec.model } : {}),
        localModelPath,
        normalize: spec.normalize ?? true,
      });
    }
    /*
    | A catalogue model the user downloaded from the panel. It must be
    | complete on disk: silently hashing instead would store vectors from a
    | different model than the one the index claims.
    */
    const requested = spec.useDefaultModel ? '' : (spec.model ?? '');
    if (requested !== '' && requested !== LOCAL_DEFAULT_EMBEDDING_MODEL) {
      const modelsDir = resolveModelsDir(spec.modelsDir);
      const store = new LocalModelStore({ modelsDir });
      if (store.catalogEntry(requested) && !store.catalogEntry(requested)!.builtIn) {
        if (!store.isReady(requested)) {
          throw new Error(
            `local embedding model "${requested}" is not downloaded. ` +
              `Download it from the Embeddings panel (it is stored in ${modelsDir}).`
          );
        }
        return new LocalEmbeddingGenerator({
          model: requested,
          localModelPath: modelsDir,
          normalize: spec.normalize ?? true,
        });
      }
    }
    return new HashingEmbeddingGenerator();
  }

  if (!spec.baseUrl) {
    throw new Error(`embedding provider "${provider}" needs a baseUrl`);
  }
  if (!spec.model && !spec.useDefaultModel) {
    throw new Error(`embedding provider "${provider}" needs a model`);
  }

  return new RemoteEmbeddingGenerator({
    provider,
    baseUrl: spec.baseUrl,
    model: spec.model || '',
    ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
    normalize: spec.normalize ?? true,
  });
}
