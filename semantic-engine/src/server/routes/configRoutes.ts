/**
 * ConfigRoutes — Runtime configuration inspection & update endpoints (Domain 02).
 */

import { RouteDefinition, PlatformConfig } from '../types';

export function createConfigRoutes(platformConfig: PlatformConfig): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: '/api/v1/config',
      requireAuth: true,
      permission: 'config:read',
      handler: async () => {
        return {
          status: 200,
          json: {
            port: platformConfig.port,
            host: platformConfig.host,
            allowRemote: platformConfig.allowRemote,
            maxBodyBytes: platformConfig.maxBodyBytes,
            projectsRoot: platformConfig.projectsRoot,
            tokenConfigured: Boolean(platformConfig.token),
            embedding: {
              /*
              | F-0021 — دیگر یک مدل ثابتِ حدسی (`Qwen3-Embedding-0.6B`) نیست.
              | مدلِ واقعاً پیکربندی‌شده از PlatformConfig خوانده می‌شود؛ اگر
              | هیچ مدلی داده نشده، `null` صادقانه گزارش می‌شود به‌جای جعل یک
              | مقدار.
              */
              model: platformConfig.embeddingModel ?? null,
            },
            database: {
              password: '***',
            },
          },
        };
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/v1/config',
      requireAuth: true,
      permission: 'config:write',
      handler: async ctx => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;

        /*
        | فقط تنظیماتی که در runtime واقعاً خوانده می‌شوند قابل تغییرند.
        | `HttpServer` مقدار `maxBodyBytes` را در هر درخواست از همین شیء
        | می‌خواند، پس تغییر آن بلافاصله اثر می‌کند. بقیه (port/host/...)
        | فقط هنگام start اعمال می‌شوند؛ رد صریح بهتر از موفقیت دروغین است.
        | `0` مقدار معتبر nullish نیست: با `??` حفظ می‌شود و اعتبارسنجی
        | آن را رد می‌کند، نه اینکه بی‌صدا به default برگردد.
        */
        const MUTABLE = ['maxBodyBytes'];
        const READ_ONLY = ['port', 'host', 'allowRemote', 'projectsRoot', 'token', 'staticDir', 'dataRoot'];
        for (const key of Object.keys(body)) {
          if (MUTABLE.includes(key)) continue;
          return {
            status: READ_ONLY.includes(key) ? 409 : 400,
            json: {
              error: READ_ONLY.includes(key)
                ? `${key} cannot be changed at runtime; restart the server with the new value`
                : `Unknown config key: ${key}`,
            },
          };
        }

        if (body['maxBodyBytes'] !== undefined) {
          const value = body['maxBodyBytes'];
          if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
            return { status: 400, json: { error: 'maxBodyBytes must be a positive integer' } };
          }
          (platformConfig as { maxBodyBytes?: number }).maxBodyBytes = value;
        }

        return {
          status: 200,
          json: {
            updated: true,
            persisted: false,
            config: {
              port: platformConfig.port,
              host: platformConfig.host,
              allowRemote: platformConfig.allowRemote,
              maxBodyBytes: platformConfig.maxBodyBytes,
              projectsRoot: platformConfig.projectsRoot,
            },
          },
        };
      },
    },
  ];
}
