/**
 * SystemRoutes — System info, health, readiness, and metrics endpoints.
 */

import { RouteDefinition } from '../types';

/*
| مسیرهای زنده‌بودن عمداً باز می‌مانند: یک load balancer یا systemd
| توکن ندارد، و چیزی که برمی‌گردانند دربارهٔ کد پروژه حرفی نمی‌زند.
| `/api/v1/system` هم فقط قابلیت‌های ساخت را می‌گوید، نه محتوا را.
*/
export interface ReadinessSnapshot {
  readonly ready: boolean;
  readonly checks: Record<string, boolean>;
}

export function createSystemRoutes(
  getReadiness: () => ReadinessSnapshot = () => ({
    ready: true,
    checks: { process: true },
  })
): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: '/api/v1/system',
      requireAuth: false,
      handler: async () => {
        return {
          status: 200,
          json: {
            name: '@aicoder/semantic-engine',
            version: '1.0.0',
            apiVersion: 'v1',
            status: 'operational',
            capabilities: {
              semanticSearch: true,
              graphQuery: true,
              lspLiveDiagnostics: true,
              multiLanguageWasm: true,
              layeredGraph: true,
              contextAssembly: true,
              sseEvents: true,
            },
            supportedLanguages: ['typescript', 'javascript', 'python', 'go', 'java', 'rust', 'html', 'css', 'json'],
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/health',
      requireAuth: false,
      handler: async () => {
        return {
          status: 200,
          json: {
            status: 'healthy',
            uptimeSeconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/ready',
      requireAuth: false,
      handler: async () => {
        const readiness = getReadiness();
        return {
          status: readiness.ready ? 200 : 503,
          json: {
            ready: readiness.ready,
            checks: readiness.checks,
            memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/metrics',
      requireAuth: false,
      handler: async () => {
        const memory = process.memoryUsage();
        return {
          status: 200,
          json: {
            uptimeSeconds: process.uptime(),
            memory: {
              rssMb: Math.round(memory.rss / (1024 * 1024)),
              heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
              heapTotalMb: Math.round(memory.heapTotal / (1024 * 1024)),
            },
          },
        };
      },
    },
  ];
}
