/**
 * ProjectChatService — گفت‌وگوی زبانی دربارهٔ پروژه با یک LLM سازگار
 * با OpenAI، که **فقط از طریق ابزارهای ایندکس** (همان ابزارهای MCP:
 * find_symbol, semantic_search, impact_analysis, ...) به پروژه دسترسی
 * دارد — نه به دیتابیس یا فایل‌سیستم به‌طور مستقیم (SE-CHAT-01).
 *
 * حلقهٔ کار:
 *   ۱. ابزارهای رجیستری پروژه را به‌صورت OpenAI function tools توصیف کن.
 *   ۲. پیام‌ها را به `<baseUrl>/chat/completions` بفرست.
 *   ۳. تا وقتی مدل `tool_calls` می‌خواهد، هر ابزار را با
 *      `registry.execute` اجرا کن و نتیجه را برگردان.
 *   ۴. پاسخ متنی نهایی را برگردان، همراه با ردِ ابزارهای استفاده‌شده.
 */

import { AiToolRegistry } from '../../ai/AiToolRegistry';
import { assertFetchableUrl, assertResolvedFetchableUrl } from '../providers/EmbeddingProviderService';

export interface ChatLlmConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly temperature?: number;
  /** میلی‌ثانیه؛ پیش‌فرض ۶۰٬۰۰۰. */
  readonly timeoutMs?: number;
  /** حداکثر دورِ فراخوانی ابزار پیش از توقف. پیش‌فرض ۶. */
  readonly maxToolRounds?: number;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_call_id?: string;
  readonly name?: string;
  readonly tool_calls?: unknown;
}

export interface ChatToolTrace {
  readonly tool: string;
  readonly input: unknown;
  readonly ok: boolean;
  readonly summary: string;
}

export interface ChatResult {
  readonly reply: string;
  readonly toolTrace: ChatToolTrace[];
  readonly model: string;
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const SYSTEM_PROMPT = `You are a senior code-intelligence assistant embedded in the Semantic Engine.
Your job is to answer questions about THIS specific project accurately and honestly.

# Hard rules (non-negotiable)
1. Your ONLY source of truth about the code is the tools listed below. You have
   NO direct access to the file system, the database, or the network. NEVER
   claim to have "opened", "read", or "looked at" a file directly — you read the
   pre-built semantic index THROUGH tools.
2. You MUST call a tool before making any concrete claim about the code
   (names, signatures, dependencies, call relationships, tests, git history,
   architecture). Do NOT guess, and do NOT rely on prior/general knowledge of
   similarly-named libraries.
3. If the tools return no result for something, say so explicitly
   ("the index has no symbol matching X"). NEVER invent files, symbols, line
   numbers, signatures, or relationships. Fabrication is a critical failure.
4. Every concrete statement in your answer must be traceable to a tool result
   you actually received in this conversation.

# How the tools work (READ THIS)
- Most detail tools identify code by an **id** (symbolId or fileId), NOT by a
  raw name. The correct workflow is almost always TWO steps:
    (a) discover the id with 'semantic_search' or 'find_symbol', THEN
    (b) act on that id with 'explain_symbol', 'impact_analysis',
        'get_dependencies', 'find_tests', etc.
  Do not pass a human name where an id is required — resolve it first.
- 'get_dependencies' requires a 'direction' ("forward" = what this depends on;
  "backward" = what depends on this) and 'depth' is capped at 3.
- 'impact_analysis' needs an 'id' and an optional 'level' (file|symbol|any).
- Every tool returns JSON shaped like:
      { "success": boolean, "items": [ ... ], "context"?: string, "error"?: string }
  Read 'items' for the results and 'context' for a prose summary. If
  "success" is false, read "error" and adapt (e.g. resolve an id first) instead
  of repeating the same call.

# Workflow you MUST follow
1. Decide which tool answers the question. Chain tools when needed
   (e.g. semantic_search -> explain_symbol -> impact_analysis).
2. Call tools with precise arguments. Prefer narrow queries and reasonable
   limits over dumping everything.
3. Base the answer strictly on what came back. Cite the file paths / symbol
   names from the tool results so the user can verify.
4. If a tool call fails or returns nothing, either try a better tool/argument
   or tell the user plainly — never paper over a gap with a guess.

# Style
- Answer in the user's language. Be concise, precise, and technical.
- When you name a symbol or file, use the exact path/name from the tool output.
- Prefer a short direct answer followed by supporting detail, not a wall of text.`;

/**
 * هیچ ابزاری از چت پنهان نیست؛ سیاست امنیتی روی *ورودی هر ابزار* است، نه روی
 * نامش. ابزاری که آرگومان مسیر یا SQL خام می‌گرفت (`query_index`) از رجیستری
 * حذف شده، پس این‌جا هم چیزی برای رد کردن نیست.
 */
const CHAT_TOOL_DENYLIST = new Set<string>();

export class ProjectChatService {
  async chat(
    registry: AiToolRegistry,
    llm: ChatLlmConfig,
    userMessages: ChatMessage[]
  ): Promise<ChatResult> {
    const tools = this.describeTools(registry);
    const maxRounds = llm.maxToolRounds ?? 6;

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...userMessages,
    ];
    const toolTrace: ChatToolTrace[] = [];

    for (let round = 0; round < maxRounds; round++) {
      const completion = await this.callLlm(llm, messages, tools);
      const choice = completion?.choices?.[0]?.message;
      if (!choice) {
        return { reply: 'مدل پاسخی برنگرداند.', toolTrace, model: llm.model };
      }

      const toolCalls: OpenAiToolCall[] = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];

      if (toolCalls.length === 0) {
        return { reply: choice.content ?? '', toolTrace, model: llm.model };
      }

      // ثبت پیام assistant که ابزار خواسته، سپس اجرای هر ابزار.
      messages.push({ role: 'assistant', content: choice.content ?? '', tool_calls: choice.tool_calls });

      for (const call of toolCalls) {
        const name = call.function?.name;
        let input: Record<string, unknown> = {};
        try {
          input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          input = {};
        }

        let resultText: string;
        let ok = false;
        try {
          const output = await registry.execute(name, input);
          ok = output.success;
          resultText = this.summarizeToolOutput(output);
        } catch (error) {
          resultText = `tool error: ${error instanceof Error ? error.message : String(error)}`;
        }

        toolTrace.push({ tool: name, input, ok, summary: truncate(resultText, 160) });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: truncate(resultText, 6000),
        });
      }
    }

    // به سقف دور رسیدیم؛ یک درخواست پایانی بدون ابزار برای جمع‌بندی.
    const finalCompletion = await this.callLlm(llm, messages, undefined);
    const finalMsg = finalCompletion?.choices?.[0]?.message?.content;
    return {
      reply: finalMsg ?? 'به سقف فراخوانی ابزار رسیدم و نتوانستم جمع‌بندی کنم.',
      toolTrace,
      model: llm.model,
    };
  }

  /**
   * ابزارهای رجیستری را به schema ابزار OpenAI تبدیل می‌کند.
   *
   * - به هر توضیح یک یادآوریِ کوتاهِ شکلِ خروجی اضافه می‌شود تا مدل پیش از
   *   فراخوانی بداند چه انتظاری داشته باشد.
   */
  private describeTools(registry: AiToolRegistry): unknown[] {
    const OUTPUT_HINT =
      ' Returns { success, items[], context?, error? }; on success read items/context, on failure read error.';
    return registry
      .list()
      .filter(t => !CHAT_TOOL_DENYLIST.has(t.name))
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: (t.description || t.name) + OUTPUT_HINT,
          parameters:
            t.inputSchema && typeof t.inputSchema === 'object'
              ? t.inputSchema
              : { type: 'object', properties: {} },
        },
      }));
  }

  private summarizeToolOutput(output: {
    success: boolean;
    error?: string;
    items: readonly unknown[];
    context?: string;
  }): string {
    if (!output.success) return `failed: ${output.error ?? 'unknown error'}`;
    const parts: string[] = [];
    if (output.context) parts.push(output.context);
    if (output.items && output.items.length > 0) {
      parts.push(JSON.stringify(output.items.slice(0, 20)));
    }
    if (parts.length === 0) return 'no results';
    return parts.join('\n');
  }

  private async callLlm(
    llm: ChatLlmConfig,
    messages: ChatMessage[],
    tools: unknown[] | undefined
  ): Promise<{ choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }> }> {
    const url = chatCompletionsUrl(llm.baseUrl);
    if (process.env.NODE_ENV === 'test') {
      assertFetchableUrl(url);
    } else {
      await assertResolvedFetchableUrl(url);
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (llm.apiKey) headers['Authorization'] = `Bearer ${llm.apiKey}`;

    const body: Record<string, unknown> = {
      model: llm.model,
      messages,
      temperature: llm.temperature ?? 0.2,
    };
    if (tools && tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), llm.timeoutMs ?? 60000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status} ${res.statusText}: ${truncate(text, 300)}`);
      }
      return (await res.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }> };
    } finally {
      clearTimeout(timer);
    }
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * مسیر chat/completions را هوشمندانه از baseUrl می‌سازد تا با هر شکلِ
 * ورودی کار کند و هرگز `/v1/v1/...` نسازد (SE-CHAT-02):
 *   - .../chat/completions           → همان‌طور
 *   - http://host/v1                 → http://host/v1/chat/completions
 *   - http://host  (بدون /v1)        → http://host/v1/chat/completions
 *   - http://host/openai (گیت‌وی)    → http://host/openai/v1/chat/completions
 */
function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v1$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}
