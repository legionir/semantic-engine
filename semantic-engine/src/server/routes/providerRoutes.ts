/**
 * providerRoutes — کشف provider و مدل‌های embedding (SE-UI-03).
 *
 * از UI برای «اتصال provider»، «دریافت خودکار مدل‌ها» و انتخاب مدل
 * embedding استفاده می‌شود.
 */

import { RouteDefinition } from '../types';
import { LocalModelStore } from '../../services/providers/LocalModelStore';
import {
  EmbeddingProviderService,
  ProviderKind,
} from '../../services/providers/EmbeddingProviderService';

/** The optional runtime that executes downloaded ONNX models. */
function localRuntimeInstalled(): boolean {
  try {
    require.resolve('@xenova/transformers');
    return true;
  } catch {
    return false;
  }
}

export function createProviderRoutes(
  service: EmbeddingProviderService,
  modelStore?: LocalModelStore
): RouteDefinition[] {
  const modelRoutes: RouteDefinition[] = modelStore
    ? [
        {
          // Catalogue of local embedding models with their on-disk state.
          method: 'GET',
          pattern: '/api/v1/models/local',
          permission: 'config:read',
          handler: async () => ({
            status: 200,
            json: {
              modelsDir: modelStore.modelsDir,
              runtimeInstalled: localRuntimeInstalled(),
              models: modelStore.list(),
            },
          }),
        },
        {
          // Start downloading a catalogue model into `<dataRoot>/models`.
          method: 'POST',
          pattern: '/api/v1/models/local/download',
          requireAuth: true,
          permission: 'config:write',
          schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          handler: async ctx => {
            const { id } = (ctx.body ?? {}) as { id: string };
            if (!modelStore.catalogEntry(id)) {
              return { status: 404, json: { error: `Unknown model: ${id}` } };
            }
            return { status: 202, json: modelStore.start(id) };
          },
        },
        {
          method: 'POST',
          pattern: '/api/v1/models/local/remove',
          requireAuth: true,
          permission: 'config:write',
          schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          handler: async ctx => {
            const { id } = (ctx.body ?? {}) as { id: string };
            try {
              return modelStore.remove(id)
                ? { status: 200, json: { removed: true, id } }
                : { status: 404, json: { error: `Model cannot be removed: ${id}` } };
            } catch (error) {
              return {
                status: 409,
                json: { error: error instanceof Error ? error.message : String(error) },
              };
            }
          },
        },
      ]
    : [];

  return [
    ...modelRoutes,
    {
      // فهرست provider های پشتیبانی‌شده + مدل‌های لوکال پیش‌فرض.
      method: 'GET',
      pattern: '/api/v1/providers',
      permission: 'config:read',
      handler: async () => ({
        status: 200,
        json: {
          providers: service.listProviders(),
          localModels: service.listLocalModels(),
        },
      }),
    },
    {
      // اتصال به provider و دریافت خودکار مدل‌ها.
      method: 'POST',
      pattern: '/api/v1/providers/models',
      permission: 'config:read',
      schema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['local', 'ollama', 'openai-compatible'] },
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['provider'],
      },
      handler: async ctx => {
        const body = (ctx.body || {}) as {
          provider: ProviderKind;
          baseUrl?: string;
          apiKey?: string;
          timeoutMs?: number;
        };
        const result = await service.fetchModels(body);
        return {
          status: result.connected ? 200 : 502,
          json: result,
        };
      },
    },
  ];
}
