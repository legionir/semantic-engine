/**
 * EmbeddingProviderService — کشف و لیست‌کردن مدل‌های embedding از
 * provider های مختلف (SE-UI-03).
 *
 * سه نوع provider پشتیبانی می‌شود:
 *   • `local`            — embedding هش‌شده‌ی deterministic (بدون سرویس بیرونی یا دانلود مدل).
 *   • `ollama`           — اندپوینت Ollama، لیست از `/api/tags`.
 *   • `openai-compatible`— هر اندپوینت سازگار با OpenAI (vLLM/LMStudio/OpenAI/OpenRouter)
 *                          از `/v1/models` یا `/models`.
 *
 * هدف: UI بتواند provider را وصل کند، مدل‌ها را «خودکار» بگیرد و
 * یکی را به‌عنوان مدل embedding انتخاب کند — یا از مدل پیش‌فرض استفاده کند.
 */

import * as dns from 'dns';
import * as net from 'net';

export type ProviderKind = 'local' | 'ollama' | 'openai-compatible';

export interface ProviderModel {
  /** شناسهٔ مدل که به pipeline embedding داده می‌شود. */
  readonly id: string;
  /** نام نمایشی. */
  readonly name: string;
  /** آیا مدل پیش‌فرض این provider است؟ */
  readonly isDefault?: boolean;
  /** ابعاد بردار در صورت معلوم‌بودن. */
  readonly dimensions?: number;
  /** توضیح کوتاه (برای مدل‌های لوکال شناخته‌شده). */
  readonly description?: string;
}

export interface ProviderDescriptor {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly description: string;
  /** آیا برای این provider نیاز به baseUrl است؟ */
  readonly needsBaseUrl: boolean;
  /** پیش‌فرض baseUrl (برای پرکردن فرم). */
  readonly defaultBaseUrl?: string;
  /** آیا API key می‌پذیرد؟ */
  readonly acceptsApiKey: boolean;
  /** مدل پیش‌فرض پیشنهادی. */
  readonly defaultModel: string;
}

export interface FetchModelsRequest {
  readonly provider: ProviderKind;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** میلی‌ثانیه؛ پیش‌فرض ۵۰۰۰. */
  readonly timeoutMs?: number;
}

export interface FetchModelsResult {
  readonly provider: ProviderKind;
  readonly baseUrl?: string;
  readonly connected: boolean;
  readonly models: ProviderModel[];
  readonly defaultModel: string;
  readonly error?: string;
}

/**
 * مدل‌های embedding محلی شناخته‌شدهٔ @xenova/transformers. این‌ها بدون
 * هیچ سرویس بیرونی و بدون API key کار می‌کنند.
 */
const LOCAL_EMBEDDING_MODELS: ProviderModel[] = [
  {
    id: 'hashing-256',
    name: 'Deterministic hashing (256 dimensions)',
    isDefault: true,
    dimensions: 256,
    description: 'offline, deterministic, no model download or API key',
  },
];

export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  {
    kind: 'local',
    label: 'Local (deterministic hashing)',
    description: 'Deterministic local hashing; offline, no API key or model download.',
    needsBaseUrl: false,
    acceptsApiKey: false,
    defaultModel: 'hashing-256',
  },
  {
    kind: 'ollama',
    label: 'Ollama',
    description: 'Local Ollama service; models are read from /api/tags.',
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434',
    acceptsApiKey: false,
    defaultModel: 'nomic-embed-text',
  },
  {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible (vLLM / LMStudio / OpenAI / OpenRouter)',
    description: 'Any OpenAI-compatible endpoint; models from /v1/models.',
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:1234/v1',
    acceptsApiKey: true,
    defaultModel: 'text-embedding-3-small',
  },
];

export class EmbeddingProviderService {
  listProviders(): ProviderDescriptor[] {
    return PROVIDER_CATALOG;
  }

  /** لیست مدل‌های لوکال، بدون هیچ درخواست شبکه‌ای. */
  listLocalModels(): ProviderModel[] {
    return LOCAL_EMBEDDING_MODELS;
  }

  async fetchModels(request: FetchModelsRequest): Promise<FetchModelsResult> {
    const timeoutMs = request.timeoutMs ?? 5000;

    if (request.provider === 'local') {
      return {
        provider: 'local',
        connected: true,
        models: LOCAL_EMBEDDING_MODELS,
        defaultModel: 'hashing-256',
      };
    }

    if (!request.baseUrl) {
      return {
        provider: request.provider,
        connected: false,
        models: [],
        defaultModel: this.defaultFor(request.provider),
        error: 'baseUrl is required for this provider',
      };
    }

    try {
      if (request.provider === 'ollama') {
        return await this.fetchOllama(request.baseUrl, timeoutMs);
      }
      return await this.fetchOpenAiCompatible(request.baseUrl, request.apiKey, timeoutMs);
    } catch (error) {
      return {
        provider: request.provider,
        baseUrl: request.baseUrl,
        connected: false,
        models: [],
        defaultModel: this.defaultFor(request.provider),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private defaultFor(provider: ProviderKind): string {
    return PROVIDER_CATALOG.find(p => p.kind === provider)?.defaultModel ?? '';
  }

  private async fetchOllama(baseUrl: string, timeoutMs: number): Promise<FetchModelsResult> {
    const url = joinUrl(baseUrl, '/api/tags');
    const data = (await this.getJson(url, undefined, timeoutMs)) as {
      models?: Array<{ name?: string; model?: string; details?: { parameter_size?: string } }>;
    };

    const raw = Array.isArray(data.models) ? data.models : [];
    const models: ProviderModel[] = raw
      .map(m => {
        const id = m.name || m.model || '';
        return id
          ? {
              id,
              name: id,
              ...(m.details?.parameter_size ? { description: m.details.parameter_size } : {}),
            }
          : null;
      })
      .filter((m): m is ProviderModel => Boolean(m));

    // مدل‌های embedding را جلوتر نشان بده (نام‌هایی که «embed» دارند).
    models.sort((a, b) => scoreEmbed(b.id) - scoreEmbed(a.id));
    const defaultModel = models.find(m => scoreEmbed(m.id) > 0)?.id || models[0]?.id || this.defaultFor('ollama');

    return {
      provider: 'ollama',
      baseUrl,
      connected: true,
      models,
      defaultModel,
    };
  }

  private async fetchOpenAiCompatible(
    baseUrl: string,
    apiKey: string | undefined,
    timeoutMs: number
  ): Promise<FetchModelsResult> {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // بعضی endpointها /v1 را در baseUrl دارند، بعضی نه. هر دو را امتحان کن.
    // اگر baseUrl خودش به /v1 ختم شده، «/v1/models» را دوباره اضافه نکن
    // (باگ /v1/v1/models). فهرست candidate بدون تکرار ساخته می‌شود.
    const endsWithV1 = /\/v1\/?$/.test(baseUrl);
    const candidates = endsWithV1
      ? [joinUrl(baseUrl, '/models')]
      : [joinUrl(baseUrl, '/v1/models'), joinUrl(baseUrl, '/models')];
    let lastError: unknown;
    for (const url of candidates) {
      try {
        const data = (await this.getJson(url, headers, timeoutMs)) as {
          data?: Array<{ id?: string }>;
        };
        const raw = Array.isArray(data.data) ? data.data : [];
        const models: ProviderModel[] = raw
          .map(m => (m.id ? { id: m.id, name: m.id } : null))
          .filter((m): m is ProviderModel => Boolean(m));
        if (models.length === 0) continue;

        models.sort((a, b) => scoreEmbed(b.id) - scoreEmbed(a.id));
        const defaultModel =
          models.find(m => scoreEmbed(m.id) > 0)?.id || models[0]?.id || this.defaultFor('openai-compatible');

        return {
          provider: 'openai-compatible',
          baseUrl,
          connected: true,
          models,
          defaultModel,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('no models endpoint responded');
  }

  private async getJson(
    url: string,
    headers: Record<string, string> | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    await assertResolvedFetchableUrl(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        /*
        | یک ریدایرکت می‌تواند از یک آدرس بی‌خطر به متادیتای ابر برود
        | و بررسی بالا را دور بزند. دنبال نکردنش ارزان‌ترین راه بستن
        | این در است؛ سرویس مدل‌ها هم ریدایرکت نمی‌خواهد.
        */
        redirect: 'error',
      });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText} from ${url}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/*
| مهار SSRF — `baseUrl` مستقیماً از بدنهٔ درخواست می‌آید.
|
| ── چه چیزی ممکن بود ─────────────────────────────────────────────
|
| `POST /api/v1/providers/models` با `baseUrl` دلخواه، سرور را وادار
| می‌کرد به هر آدرسی درخواست بزند و پاسخ را برگرداند: متادیتای ابر
| روی `169.254.169.254`، سرویس‌های داخلی شبکه، یا اسکن پورت.
|
| ── چرا لیست سیاهِ IP کافی نیست، و چرا این‌جا کافی است ────────────
|
| این سرویس عمداً باید به `localhost:11434` (Ollama) و
| `localhost:1234` (LMStudio) برسد، پس بستن کامل loopback کارکرد را
| می‌شکند. چیزی که بسته می‌شود دقیقاً همان چیزی است که هیچ سرویس
| مدلِ محلی‌ای روی آن نمی‌نشیند: آدرس‌های link-local و متادیتای ابر.
|
| این یک مهار است، نه یک دیوار: کسی که توکن سرور را دارد، از قبل
| هم می‌توانست کارهای بدتری بکند. هدف، بستن مسیرِ ارزانِ رسیدن به
| متادیتای ابر از یک درخواست است.
*/
const BLOCKED_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^169\.254\./, // link-local، شامل متادیتای AWS/GCP/Azure روی 169.254.169.254
  /^metadata\./i, // metadata.google.internal
  /^\[?fd00:ec2::254\]?$/i, // متادیتای AWS روی IPv6
];

export function assertFetchableUrl(raw: string): void {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`only http and https are allowed, received ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(host))) {
    throw new Error(`refusing to reach ${host}: link-local and cloud metadata addresses are blocked`);
  }
}


function blockedAddress(address: string): string | null {
  const ip = address.toLowerCase().split('%')[0];
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const value = (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
    const ranges: Array<[number, number, string]> = [
      [0x00000000, 0xff000000, 'unspecified'],
      [0x0a000000, 0xff000000, 'private'],
      [0x7f000000, 0xff000000, 'loopback'],
      [0xa9fe0000, 0xffff0000, 'link-local'],
      [0xac100000, 0xfff00000, 'private'],
      [0xc0a80000, 0xffff0000, 'private'],
    ];
    for (const [base, mask, label] of ranges) {
      if ((value & mask) === (base & mask)) return label;
    }
    return null;
  }
  if (net.isIP(ip) === 6) {
    if (ip === '::1' || ip === '::') return 'loopback';
    if (ip.startsWith('fc') || ip.startsWith('fd')) return 'unique-local';
    if (ip.startsWith('fe80:')) return 'link-local';
  }
  return null;
}

export async function assertResolvedFetchableUrl(raw: string): Promise<void> {
  assertFetchableUrl(raw);
  const parsed = new URL(raw);
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return;

  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.promises.lookup(host, { all: true });
  for (const entry of addresses) {
    const label = blockedAddress(entry.address);
    if (label) {
      throw new Error(`refusing to reach ${host}: resolved address ${entry.address} is ${label}`);
    }
  }
}

function scoreEmbed(id: string): number {
  const low = id.toLowerCase();
  if (low.includes('embed')) return 2;
  if (low.includes('bge') || low.includes('gte') || low.includes('minilm') || low.includes('e5')) return 1;
  return 0;
}

function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${b}${s}`;
}
