/**
 * RemoteEmbeddingGenerator — تولید embedding از یک provider شبکه‌ای
 * (Ollama یا اندپوینت سازگار با OpenAI) — SE-UI-05.
 *
 * برخلاف `LocalEmbeddingGenerator` که به `@xenova/transformers` و
 * `sharp` وابسته است، این نسخه فقط از `fetch` استفاده می‌کند و هیچ
 * ماژول native نمی‌خواهد.
 */

import {
  IEmbeddingGenerator,
  EmbeddingResult,
} from './EmbeddingGenerator';

export type RemoteEmbeddingProvider = 'ollama' | 'openai-compatible';

export interface RemoteEmbeddingOptions {
  readonly provider: RemoteEmbeddingProvider;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly normalize?: boolean;
  readonly timeoutMs?: number;
}

export class RemoteEmbeddingGenerator implements IEmbeddingGenerator {
  readonly modelName: string;

  constructor(private readonly options: RemoteEmbeddingOptions) {
    this.modelName = options.model;
  }

  async isReady(): Promise<boolean> {
    return Boolean(this.options.baseUrl && this.options.model);
  }

  async generate(text: string): Promise<EmbeddingResult> {
    const [result] = await this.generateBatch([text]);
    if (!result) throw new Error('remote embedding returned no vector');
    return result;
  }

  async generateBatch(texts: readonly string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    if (this.options.provider === 'ollama') {
      return this.batchOllama(texts);
    }
    return this.batchOpenAi(texts);
  }

  async dispose(): Promise<void> {
    /* بدون منبع نگه‌داشتنی. */
  }

  private async batchOpenAi(texts: readonly string[]): Promise<EmbeddingResult[]> {
    const url = joinUrl(this.options.baseUrl, '/v1/embeddings');
    const fallback = joinUrl(this.options.baseUrl, '/embeddings');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiKey) headers['Authorization'] = `Bearer ${this.options.apiKey}`;

    const payload = JSON.stringify({ model: this.options.model, input: texts });

    const data = (await this.postJson([url, fallback], headers, payload)) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const rows = Array.isArray(data.data) ? data.data : [];
    return this.validateBatch(rows.map(row => row.embedding ?? []), texts.length, 'OpenAI-compatible');
  }

  private async batchOllama(texts: readonly string[]): Promise<EmbeddingResult[]> {
    // Ollama یک ورودی در هر درخواست می‌گیرد (نسخه‌های قدیمی)؛ نسخه‌های
    // جدید /api/embed با input آرایه‌ای دارند. اول آرایه‌ای، بعد تکی.
    const embedUrl = joinUrl(this.options.baseUrl, '/api/embed');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let data: { embeddings?: number[][] };
    try {
      data = (await this.postJson(
        [embedUrl],
        headers,
        JSON.stringify({ model: this.options.model, input: texts })
      )) as { embeddings?: number[][] };
    } catch {
      /* فقط خطای transport به اندپوینت قدیمی fallback می‌کند. */
      data = {};
    }
    const batch = data && typeof data === 'object' ? data.embeddings : undefined;
    if (Array.isArray(batch)) {
      // A present batch response with the wrong shape is a provider error,
      // not a signal to silently retry one item at a time.
      return this.validateBatch(batch, texts.length, 'Ollama');
    }

    const legacyUrl = joinUrl(this.options.baseUrl, '/api/embeddings');
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      const data = (await this.postJson(
        [legacyUrl],
        headers,
        JSON.stringify({ model: this.options.model, prompt: text })
      )) as { embedding?: number[] };
      results.push(this.validateBatch([data.embedding ?? []], 1, 'Ollama legacy')[0]!);
    }
    return results;
  }

  private validateBatch(rawVectors: readonly number[][], expected: number, provider: string): EmbeddingResult[] {
    if (rawVectors.length !== expected) {
      throw new Error(`${provider} embedding cardinality mismatch: expected ${expected}, received ${rawVectors.length}`);
    }
    const dimensions = rawVectors[0]?.length ?? 0;
    if (dimensions === 0 || rawVectors.some(vector => vector.length !== dimensions || vector.some(value => !Number.isFinite(value)))) {
      throw new Error(`${provider} returned an empty, non-finite, or inconsistent embedding vector`);
    }
    return rawVectors.map(vector => this.toResult(vector));
  }

  private toResult(raw: readonly number[]): EmbeddingResult {
    const embedding = this.options.normalize ? normalize(raw) : [...raw];
    return {
      embedding,
      model: this.options.model,
      dimensions: embedding.length,
    };
  }

  private async postJson(
    urls: string[],
    headers: Record<string, string>,
    body: string
  ): Promise<unknown> {
    const timeoutMs = this.options.timeoutMs ?? 30000;
    let lastError: unknown;
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText} from ${url}`);
        }
        return await res.json();
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('embedding request failed');
  }
}

function normalize(vec: readonly number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map(v => v / norm);
}

function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '');
  // اگر baseUrl خودش به /v1 ختم شده و suffix هم /v1/... است، تکرار نکن.
  if (suffix.startsWith('/v1/') && /\/v1$/.test(b)) {
    return `${b}${suffix.slice(3)}`;
  }
  const s = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${b}${s}`;
}
