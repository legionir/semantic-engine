/**
 * OpenAILlmClient — کلاینت LLM سازگار با OpenAI API.
 *
 * پشتیبانی از:
 * - OpenAI (https://api.openai.com/v1)
 * - OpenRouter (https://openrouter.ai/api/v1)
 * - Ollama OpenAI-compatible endpoint (http://localhost:11434/v1)
 * - هر سرور دیگری که endpoint/chat/completions را داشته باشد
 */

import {
  ILlmClient,
  LlmClientConfig,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from './LlmClient';

export class OpenAILlmClient implements ILlmClient {
  constructor(public readonly config: LlmClientConfig) {}

  async complete(
    messages: readonly LlmMessage[],
    options: LlmCompletionOptions = {}
  ): Promise<LlmCompletionResult> {
    const baseUrl = (this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const url = `${baseUrl}/chat/completions`;

    /*
    | F-0030 — یک provider که پاسخ نمی‌دهد نباید اجرای index/watch را
    | بخواباند. سه لایه: (۱) تایم‌اوت داخلی با `AbortSignal.timeout`،
    | (۲) سیگنال caller اگر داده شود، (۳) ترکیب هر دو. مسیر قبلی هیچ
    | signalی نداشت؛ generator فقط *بین* درخواست‌ها signal را چک می‌کرد،
    | پس یک درخواست آویزان تا ابد نگهش می‌داشت.
    */
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs ?? 60000);
    const signal = options.signal
      ? AbortSignal.any([timeoutSignal, options.signal])
      : timeoutSignal;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model ?? this.config.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: options.temperature ?? this.config.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? this.config.maxTokens ?? 1024,
        top_p: options.topP ?? 1,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${text}`);
    }

    const json = await response.json() as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = json.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) {
      throw new Error('LLM returned empty content');
    }

    return {
      content,
      model: json.model ?? this.config.model,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }

  async dispose(): Promise<void> {
    // nothing to dispose for HTTP client
  }
}
