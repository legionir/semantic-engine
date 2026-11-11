/**
 * F-0011 — repo-wide scan: no authenticating mutating (POST/PUT/PATCH/DELETE)
 * route may fall through to `HttpServer.defaultPermission`.
 *
 * Before this fix, destructive/admin routes (project create/patch/delete)
 * relied on the method-based default
 * (`GET -> project:read`, everything else -> `project:write`). That meant a
 * plain `project:write` token could delete a whole project, and the intent of
 * each route was invisible in its declaration. Every mutating route now names
 * its least-privilege permission explicitly; this test locks that in so a new
 * route cannot quietly reintroduce the fall-through.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';
import { RouteDefinition } from './types';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

describe('F-0011 — destructive/admin routes never use the method default', () => {
  let server: HttpServer;
  let base: string;

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-route-scan-')));
    const workspace = path.join(base, 'app');
    fs.mkdirSync(workspace, { recursive: true });
    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: 'scan-token',
      projectsRoot: workspace,
      dataRoot: path.join(base, 'data'),
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('every authenticating mutating route declares an explicit permission', () => {
    const offenders = server
      .getRegisteredRoutes()
      .filter(
        (route: RouteDefinition) =>
          MUTATING.has(route.method) &&
          route.requireAuth !== false && // public routes (auth/verify) are exempt
          !route.permission
      )
      .map((route: RouteDefinition) => `${route.method} ${route.pattern}`);

    expect(offenders).toEqual([]);
  });

  it('registry-mutating routes require project:admin (not the project:write default)', () => {
    const byPattern = new Map(
      server.getRegisteredRoutes().map((r: RouteDefinition) => [`${r.method} ${r.pattern}`, r])
    );

    for (const key of ['POST /api/v1/projects', 'PATCH /api/v1/projects/:id', 'DELETE /api/v1/projects/:id']) {
      expect(byPattern.get(key)?.permission).toBe('project:admin');
    }
  });

  it('auth-management routes are gated behind auth:manage', () => {
    const authManage = server
      .getRegisteredRoutes()
      .filter((r: RouteDefinition) => /\/auth\/(api-keys|keys)/.test(r.pattern) && r.method !== 'GET');
    expect(authManage.length).toBeGreaterThan(0);
    for (const route of authManage) {
      expect(route.permission).toBe('auth:manage');
    }
  });

  it('the routes nothing called are gone (source write/sync, history, dashboard, system)', () => {
    const removed = /\/source\/|\/import-bundle$|\/files\/:filePath$|\/history\/|\/dashboard\/|^\/api\/v1\/system$/;
    const left = server.getRegisteredRoutes().filter((r: RouteDefinition) => removed.test(r.pattern));
    expect(left.map(r => `${r.method} ${r.pattern}`)).toEqual([]);
  });
});
