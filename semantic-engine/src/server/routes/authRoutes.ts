/**
 * authRoutes — REST Endpoints for IAM, API Key management, and Scoped RBAC (Domain 03).
 */

import { RouteDefinition, HttpRequestContext } from '../types';
import { ApiKeyStore } from '../../security/rbac/ApiKeyStore';
import { ROLE_DEFAULT_PERMISSIONS, PlatformRole } from '../../security/rbac/types';
import { RateLimiter } from '../RateLimiter';

export function createAuthRoutes(
  apiKeyStore: ApiKeyStore,
  verifyLimiter: RateLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 })
): RouteDefinition[] {
  const getRolesHandler = async () => ({
    status: 200,
    json: {
      roles: Object.keys(ROLE_DEFAULT_PERMISSIONS),
      permissionsByRole: ROLE_DEFAULT_PERMISSIONS,
    },
  });

  const createKeyHandler = async (ctx: HttpRequestContext) => {
    const body = (ctx.body || {}) as {
      name?: string;
      role?: PlatformRole;
      resourceScope?: string;
      expiresInMs?: number;
    };

    if (!body.name) {
      return { status: 400, json: { error: 'Key name is required' } };
    }

    const role = body.role || 'Developer';
    if (!Object.prototype.hasOwnProperty.call(ROLE_DEFAULT_PERMISSIONS, role)) {
      return { status: 400, json: { error: `Unknown role '${String(role)}'` } };
    }

    if (body.expiresInMs !== undefined &&
        (!Number.isFinite(body.expiresInMs) || body.expiresInMs <= 0)) {
      return { status: 400, json: { error: 'expiresInMs must be a positive finite number' } };
    }

    const created = apiKeyStore.createKey({
      name: body.name,
      role,
      resourceScope: body.resourceScope,
      expiresInMs: body.expiresInMs,
    });

    return {
      status: 201,
      json: {
        rawToken: created.rawToken,
        key: created.key,
      },
    };
  };

  const verifyHandler = async (ctx: HttpRequestContext) => {
    /*
    | F-0009 — این مسیر `requireAuth: false` است و پاسخ معتبر/نامعتبر را
    | متمایز می‌کند، پس یک اوراکل شمارشِ توکن است. با rate-limit per-client
    | (429) غیرمعمول‌سازی خودکار بی‌فایده می‌شود. کلید = آدرس peer; روی
    | UDS که undefined است، یک bucket مشترک (ترکیب socketPath در limiter).
    */
    const clientIp = ctx.req?.socket?.remoteAddress ?? 'uds';
    const budget = verifyLimiter.check(clientIp);
    if (!budget.allowed) {
      return {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(budget.retryAfterMs / 1000)) },
        json: { error: 'Too many verification attempts; try again later' },
      };
    }

    const body = (ctx.body || {}) as { token?: string };
    const token = body.token || ctx.token || '';
    const record = apiKeyStore.verifyToken(token);
    if (!record) {
      return { status: 401, json: { valid: false, error: 'Invalid or expired token' } };
    }
    return {
      status: 200,
      json: {
        valid: true,
        keyId: record.id,
        name: record.name,
        role: record.role,
        permissions: record.permissions,
        resourceScope: record.resourceScope,
      },
    };
  };

  return [
    { method: 'GET', pattern: '/api/v1/roles', requireAuth: false, handler: getRolesHandler },
    { method: 'GET', pattern: '/api/v2/auth/roles', requireAuth: false, handler: getRolesHandler },
    { method: 'GET', pattern: '/api/v1/auth/api-keys', requireAuth: true, permission: 'auth:manage', handler: async () => ({ status: 200, json: { keys: apiKeyStore.listKeys() } }) },
    { method: 'GET', pattern: '/api/v2/auth/keys', requireAuth: true, permission: 'auth:manage', handler: async () => ({ status: 200, json: { keys: apiKeyStore.listKeys() } }) },
    { method: 'POST', pattern: '/api/v1/auth/api-keys', requireAuth: true, permission: 'auth:manage', handler: createKeyHandler },
    { method: 'POST', pattern: '/api/v2/auth/keys', requireAuth: true, permission: 'auth:manage', handler: createKeyHandler },
    {
      method: 'POST',
      pattern: '/api/v1/users',
      requireAuth: true,
      permission: 'auth:manage',
      // F-0023 — no user store exists; a 201 was a fake success with no side
      // effect. Answer 501 until persistence lands.
      handler: async () => ({
        status: 501,
        json: { error: 'User management is not implemented; no store persists these records' },
      }),
    },
    {
      method: 'POST',
      pattern: '/api/v1/roles',
      requireAuth: true,
      permission: 'auth:manage',
      // F-0023 — roles are a fixed enum in code; nothing to persist. 501, not 201.
      handler: async () => ({
        status: 501,
        json: { error: 'Role creation is not implemented; roles are a fixed set' },
      }),
    },
    {
      method: 'POST',
      pattern: '/api/v1/permissions',
      requireAuth: true,
      permission: 'auth:manage',
      // F-0023 — permissions are a fixed enum in code; nothing to persist. 501, not 201.
      handler: async () => ({
        status: 501,
        json: { error: 'Permission creation is not implemented; permissions are a fixed set' },
      }),
    },
    {
      method: 'DELETE',
      pattern: '/api/v1/auth/api-keys/:keyId',
      requireAuth: true,
      permission: 'auth:manage',
      handler: async ctx => {
        const keyId = ctx.params.keyId;
        const success = apiKeyStore.revokeKey(keyId);
        if (!success) return { status: 404, json: { error: `Key '${keyId}' not found` } };
        return { status: 200, json: { revoked: true, keyId } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/v2/auth/keys/:keyId',
      requireAuth: true,
      permission: 'auth:manage',
      handler: async ctx => {
        const keyId = ctx.params.keyId;
        const success = apiKeyStore.revokeKey(keyId);
        if (!success) return { status: 404, json: { error: `Key '${keyId}' not found` } };
        return { status: 200, json: { revoked: true, keyId } };
      },
    },
    { method: 'POST', pattern: '/api/v1/auth/verify', requireAuth: false, handler: verifyHandler },
    { method: 'POST', pattern: '/api/v2/auth/verify', requireAuth: false, handler: verifyHandler },
  ];
}
