/**
 * chatRoutes — گفت‌وگوی زبانی دربارهٔ پروژه (SE-CHAT-01).
 *
 *   GET  /api/v1/chat/llm         — پیکربندی فعلی LLM (بدون کلید).
 *   PUT  /api/v1/chat/llm         — تنظیم/به‌روزرسانی پیکربندی LLM.
 *   POST /api/v1/chat/llm/test    — تست اتصال و دریافت مدل‌ها.
 *   POST /api/v1/projects/:id/chat — یک پیام و دریافت پاسخ مدل.
 *
 * مدل فقط از طریق ابزارهای رجیستریِ همان پروژه به کد دسترسی دارد.
 */

import { RouteDefinition } from '../types';
import { ProjectService } from '../../services/ProjectService';
import { ProjectChatService, ChatMessage, ChatLlmConfig } from '../../services/chat/ProjectChatService';
import { EmbeddingProviderService } from '../../services/providers/EmbeddingProviderService';

/** نگه‌دارندهٔ پیکربندی LLM در حافظه (طول عمر پروسهٔ سرور). */
export class LlmConfigStore {
  private config: ChatLlmConfig | null = null;

  get(): ChatLlmConfig | null {
    return this.config;
  }

  set(cfg: ChatLlmConfig): void {
    this.config = cfg;
  }

  /** نسخهٔ امن برای نمایش (بدون کلید). */
  publicView(): Record<string, unknown> {
    if (!this.config) return { configured: false };
    return {
      configured: true,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      hasApiKey: Boolean(this.config.apiKey),
      temperature: this.config.temperature ?? 0.2,
    };
  }
}

export function createChatRoutes(
  projectService: ProjectService,
  chatService: ProjectChatService,
  llmStore: LlmConfigStore,
  providers: EmbeddingProviderService
): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: '/api/v1/chat/llm',
      permission: 'config:read',
      handler: async () => ({ status: 200, json: llmStore.publicView() }),
    },
    {
      method: 'PUT',
      pattern: '/api/v1/chat/llm',
      requireAuth: true,
      permission: 'config:write',
      schema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          model: { type: 'string' },
          temperature: { type: 'number' },
        },
        required: ['baseUrl', 'model'],
      },
      handler: async ctx => {
        const body = (ctx.body || {}) as Partial<ChatLlmConfig>;
        if (!body.baseUrl || !body.model) {
          return { status: 400, json: { error: 'baseUrl and model are required' } };
        }
        llmStore.set({
          baseUrl: body.baseUrl,
          model: body.model,
          ...(body.apiKey ? { apiKey: body.apiKey } : {}),
          ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        });
        return { status: 200, json: llmStore.publicView() };
      },
    },
    {
      // اتصال به provider چت و دریافت مدل‌ها (از همان مسیر OpenAI-compatible).
      method: 'POST',
      pattern: '/api/v1/chat/llm/test',
      requireAuth: true,
      permission: 'config:read',
      handler: async ctx => {
        const body = (ctx.body || {}) as { baseUrl?: string; apiKey?: string };
        if (!body.baseUrl) return { status: 400, json: { error: 'baseUrl is required' } };
        const result = await providers.fetchModels({
          provider: 'openai-compatible',
          baseUrl: body.baseUrl,
          ...(body.apiKey ? { apiKey: body.apiKey } : {}),
        });
        return { status: result.connected ? 200 : 502, json: result };
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/projects/:id/chat',
      requireAuth: true,
      permission: 'semantic:context',
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          history: { type: 'array' },
        },
        required: ['message'],
      },
      handler: async ctx => {
        const project = projectService.getProject(ctx.params.id);
        if (!project) return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        if (!project.registry) {
          return {
            status: 409,
            json: { error: 'This project has no index yet. Run indexing before chatting about it.' },
          };
        }

        const llm = llmStore.get();
        if (!llm) {
          return {
            status: 409,
            json: { error: 'No LLM configured. Set one in Settings → LLM (Chat) first.' },
          };
        }

        const body = (ctx.body || {}) as { message: string; history?: ChatMessage[] };
        const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
        const messages: ChatMessage[] = [
          ...history.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: String(m.content ?? '') })),
          { role: 'user', content: body.message },
        ];

        try {
          const result = await chatService.chat(project.registry, llm, messages);
          return { status: 200, json: result };
        } catch (error) {
          return {
            status: 502,
            json: { error: error instanceof Error ? error.message : String(error) },
          };
        }
      },
    },
  ];
}
