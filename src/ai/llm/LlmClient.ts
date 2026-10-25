/**
 * LlmClient — abstraction برای فراخوانی مدل‌های زبانی بزرگ.
 *
 * Implementations:
 * - OpenAILlmClient: هر provider سازگار با OpenAI API (OpenAI، OpenRouter، local Llama.cpp server، Ollama با OpenAI-compatible endpoint)
 */

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmCompletionOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  /**
   * F-0030 — لغو در-flight. provider ای که answer نمی‌دهد نباید کل
   * اجرای index/watch را بخواباند؛ caller سیگنال خودش را می‌دهد و
   * client آن را با تایم‌اوت داخلی ترکیب می‌کند.
   */
  readonly signal?: AbortSignal;
}

export interface LlmCompletionResult {
  readonly content: string;
  readonly model: string;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface LlmClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** F-0030 — سقف هر درخواست کامل؛ پیش‌فرض ۶۰ ثانیه. */
  readonly timeoutMs?: number;
}

export interface ILlmClient {
  readonly config: LlmClientConfig;
  complete(messages: readonly LlmMessage[], options?: LlmCompletionOptions): Promise<LlmCompletionResult>;
  dispose(): Promise<void>;
}
