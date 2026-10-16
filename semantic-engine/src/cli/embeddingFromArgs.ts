/**
 * `--embedding-*` flags → an embedding generator — فاز ۵.
 *
 * Before this, `index` and `watch` could only build `HashingEmbeddingGenerator`,
 * while the platform server could talk to Ollama or an OpenAI-compatible
 * endpoint. The UI therefore offered options the CLI could not honour. Both now
 * go through `vector/createEmbeddingGenerator`.
 *
 * Secrets stay in the environment: `--embedding-api-key-env NAME` names the
 * variable, and the value is read here, at the last moment, and never logged.
 */

import { ParsedArgs, boolOption, stringOption } from './args';
import {
  createEmbeddingGenerator,
  isEmbeddingProviderName,
} from '../vector/createEmbeddingGenerator';
import { IEmbeddingGenerator } from '../vector/EmbeddingGenerator';
import { HashingEmbeddingGenerator } from '../vector/HashingEmbeddingGenerator';

export interface EmbeddingArgs {
  readonly enabled: boolean;
  readonly provider: 'local' | 'ollama' | 'openai-compatible';
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKeyEnvVar?: string;
  readonly normalize: boolean;
}

/** آیا کاربر اصلاً provider خواسته است؟ (یعنی vectorها هم implied هستند) */
export function embeddingRequested(args: ParsedArgs): boolean {
  return stringOption(args.options, 'embeddingProvider') !== undefined;
}

/**
 * خواندن flagها.
 *
 * `--embedding-provider` ناشناخته خطا می‌دهد، چون یک provider غلط یعنی یک
 * index بی‌embedding که بی‌صدا ساخته شده است.
 */
export function embeddingFromArgs(args: ParsedArgs): EmbeddingArgs {
  const rawProvider = stringOption(args.options, 'embeddingProvider');
  const model = stringOption(args.options, 'embeddingModel');
  const baseUrl = stringOption(args.options, 'embeddingBaseUrl');
  const apiKeyEnvVar = stringOption(args.options, 'embeddingApiKeyEnv');
  const normalize = boolOption(args.options, 'embeddingNormalize', true);

  if (rawProvider === undefined) {
    return { enabled: false, provider: 'local', normalize };
  }

  if (!isEmbeddingProviderName(rawProvider)) {
    throw new Error(
      `--embedding-provider must be one of: local, ollama, openai-compatible (got "${rawProvider}")`
    );
  }

  return {
    enabled: true,
    provider: rawProvider,
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKeyEnvVar !== undefined ? { apiKeyEnvVar } : {}),
    normalize,
  };
}

/**
 * ساخت generator از flagها.
 *
 * `--embedding-api-key-env` که داده شده ولی متغیرش خالی است، خطای واضح
 * می‌دهد: بدون آن درخواست‌ها ۴۰۱ می‌شوند و علتش در لاگ index پیدا نیست.
 */
export function createEmbeddingGeneratorFromArgs(
  args: ParsedArgs,
  env: Readonly<Record<string, string | undefined>> = process.env
): IEmbeddingGenerator | null {
  const parsed = embeddingFromArgs(args);
  if (!parsed.enabled) return null;

  let apiKey: string | undefined;
  if (parsed.apiKeyEnvVar !== undefined) {
    const value = (env[parsed.apiKeyEnvVar] ?? '').trim();
    if (value === '') {
      throw new Error(
        `--embedding-api-key-env ${parsed.apiKeyEnvVar} was given but the environment variable is empty or unset`
      );
    }
    apiKey = value;
  }

  return createEmbeddingGenerator({
    enabled: true,
    provider: parsed.provider,
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    normalize: parsed.normalize,
  });
}

/**
 * The single rule that `index` and `watch` share for vectors + embedding provider
 * (audit F-07: `watch` used to hard-code the hashing generator and ignore the provider
 * that built the index).
 *
 *   - vectors are wanted when `--vectors` is given, when the previous index had vector
 *     chunks, or when `--embedding-provider` is requested (unless `--vectors=false`);
 *   - the generator comes from the `--embedding-*` flags, falling back to the local
 *     hashing generator only when no provider was requested.
 */
export function resolveVectorPlan(
  args: ParsedArgs,
  previousIndexHadVectors: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env
): { readonly wantsVectors: boolean; readonly embeddingGenerator: IEmbeddingGenerator | undefined } {
  const wantsVectors =
    boolOption(args.options, 'vectors', previousIndexHadVectors) ||
    (embeddingRequested(args) && boolOption(args.options, 'vectors', true));

  return {
    wantsVectors,
    embeddingGenerator: wantsVectors
      ? createEmbeddingGeneratorFromArgs(args, env) ?? new HashingEmbeddingGenerator()
      : undefined,
  };
}
