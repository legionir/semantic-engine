/**
 * F-0009 — the public `POST /api/v1/auth/verify` token oracle is throttled.
 *
 * The endpoint answers with `valid: true/false` and requires no token, so it
 * can be used to enumerate valid API keys. This test drives the real route
 * handler directly (with a small fixed window limiter) and proves that once a
 * client exhausts its budget, further attempts get 429 with a Retry-After —
 * so automated enumeration is no longer viable within a window.
 */

import type { HttpRequestContext } from '../server/types';
import { createAuthRoutes } from '../server/routes/authRoutes';
import { ApiKeyStore } from '../security/rbac/ApiKeyStore';
import { RateLimiter } from '../server/RateLimiter';

function makeCtx(token: string): HttpRequestContext {
  return {
    req: { socket: { remoteAddress: '203.0.113.9' } },
    method: 'POST',
    path: '/api/v1/auth/verify',
    params: {},
    query: {},
    body: { token },
    authenticated: false,
    auth: { authenticated: false, permissions: [], resourceScope: '*' },
  } as unknown as HttpRequestContext;
}

describe('F-0009 — auth/verify enumeration oracle is rate-limited', () => {
  it('returns 429 after the per-client window budget is exhausted', async () => {
    const store = new ApiKeyStore();
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
    const routes = createAuthRoutes(store, limiter);
    const verify = routes.find(r => r.method === 'POST' && r.pattern === '/api/v1/auth/verify');
    expect(verify).toBeDefined();

    // First 3 attempts allowed (they legitimately 401 — bad token — not 429).
    for (let i = 0; i < 3; i++) {
      const res = await verify!.handler(makeCtx('sk_plat_nope'));
      expect(res?.status).toBe(401);
    }

    // 4th attempt in the same window is throttled.
    const throttled = await verify!.handler(makeCtx('sk_plat_nope'));
    expect(throttled?.status).toBe(429);
    expect(throttled?.headers?.['Retry-After']).toBeDefined();
  });

  it('still lets a valid token verify within budget (oracle usable, just slow)', async () => {
    const store = new ApiKeyStore();
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000 });
    const routes = createAuthRoutes(store, limiter);
    const verify = routes.find(r => r.method === 'POST' && r.pattern === '/api/v1/auth/verify')!;

    const created = store.createKey({ name: 'n', role: 'ReadOnly' });
    const res = await verify.handler(makeCtx(created.rawToken));
    expect(res?.status).toBe(200);
    expect((res?.json as { valid?: boolean }).valid).toBe(true);
  });
});

/**
 * F-0023 — the IAM `POST /users`, `/roles`, `/permissions` handlers were no-op
 * stubs that returned 201 with fabricated bodies but persisted nothing. A
 * success without a side effect is a lie; they must answer 501.
 */
describe('F-0023 — IAM stub routes never report a fake success', () => {
  const handlerFor = (pattern: string) => {
    const store = new ApiKeyStore();
    const route = createAuthRoutes(store).find(r => r.method === 'POST' && r.pattern === pattern);
    if (!route) throw new Error(`route not found: ${pattern}`);
    return route;
  };

  const ctx = {
    req: { socket: {} },
    method: 'POST',
    params: {},
    query: {},
    body: { username: 'u', roleName: 'r', permission: 'p' },
    authenticated: true,
    auth: { authenticated: true, permissions: ['auth:manage'], resourceScope: '*' },
  } as unknown as HttpRequestContext;

  it.each(['/api/v1/users', '/api/v1/roles', '/api/v1/permissions'])(
    '%s answers 501 (no fake 201)',
    async pattern => {
      const res = await handlerFor(pattern).handler(ctx);
      expect(res?.status).toBe(501);
    }
  );
});
