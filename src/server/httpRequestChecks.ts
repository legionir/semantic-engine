/**
 * Auth context and managed-worker request checks of the HTTP server
 * (split from HttpServer.ts, behavior unchanged).
 */

import * as fs from 'fs';
import * as path from 'path';
import { PlatformConfig } from './types';
import { AuthContext, ROLE_DEFAULT_PERMISSIONS } from '../security/rbac/types';
import { ApiKeyStore } from '../security/rbac/ApiKeyStore';

export function authContext(
  apiKeyStore: ApiKeyStore,
  config: PlatformConfig,
  auth: { authenticated: boolean; token?: string }): AuthContext {
  if (!auth.authenticated) {
    return {
      authenticated: false,
      permissions: [],
      resourceScope: '*',
    };
  }

  if (auth.token) {
    const record = apiKeyStore.verifyToken(auth.token);
    if (record) {
      return {
        authenticated: true,
        keyId: record.id,
        name: record.name,
        role: record.role,
        permissions: record.permissions,
        resourceScope: record.resourceScope,
        // F-0010 — فهرست صریح پروژه‌ها باید از gateway به پلتفرم هم برسد،
        // وگرنه پلتفرم فقط resourceScope تک‌پروژه را می‌بیند.
        ...(record.allowedProjects ? { allowedProjects: record.allowedProjects } : {}),
      };
    }
  }

  /* A locally constructed server without a token is an explicit local
     profile. The CLI always supplies a bootstrap token.

     F-0004 — ACCEPTED RISK (documented, not silently bypassed): when no
     `token` is configured the server grants a local Admin profile with
     `resourceScope:'*'`. This is deliberate and safe *because* of how the
     surface is bounded: the loopback guard (`SecurityPipeline` + `allowRemote
     = false` default) means only a process already on this machine can reach
     it, and the CLI/Gateway path always passes a real token so it never takes
     this branch. A `gatewayManaged` worker is explicitly denied the tokenless
     profile (see `requiresAuthentication` — every route needs the token).
     Owner has accepted this as a local-dev convenience; do NOT relax the
     loopback/managed bounds that make it safe.
  */
  if (config.gatewayManaged) {
    // Belt-and-braces: a managed worker must never fall back to Admin.
    return { authenticated: false, permissions: [], resourceScope: '*' };
  }
  return {
    authenticated: true,
    role: 'Admin',
    permissions: ROLE_DEFAULT_PERMISSIONS.Admin,
    resourceScope: '*',
  };
}

/** روت‌های مدیریتی/مسیرپذیر که یک worker تک‌پروژه نباید داشته باشد. */
export function isManagedBlockedRoute(config: PlatformConfig, method: string, pathname: string): boolean {
  if (!config.gatewayManaged) return false;

  const blocked: readonly { method: string; pattern: RegExp }[] = [
    { method: 'POST', pattern: /^\/api\/v1\/projects$/ },
    { method: 'PATCH', pattern: /^\/api\/v1\/projects\/[^/]+$/ },
    { method: 'DELETE', pattern: /^\/api\/v1\/projects\/[^/]+$/ },
    { method: 'POST', pattern: /^\/api\/v1\/projects\/import-bundle$/ },
    { method: 'POST', pattern: /^\/api\/v1\/projects\/[^/]+\/source\/upload$/ },
  ];

  return blocked.some(entry => entry.method === method && entry.pattern.test(pathname));
}

/** کلیدهایی که مسیر می‌برند و در حالت managed بررسی می‌شوند. */
export function findForeignRoot(config: PlatformConfig, body: unknown): { key: string; value: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const workspaceRoot = config.projectsRoot;
  if (!workspaceRoot) return null;

  const keys = ['path', 'rootPath', 'root', 'workspaceRoot', 'projectPath'] as const;
  const record = body as Record<string, unknown>;
  let allowedRoot: string;
  try {
    allowedRoot = fs.realpathSync(workspaceRoot);
  } catch {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') continue;

    let resolved: string;
    try {
      resolved = fs.realpathSync(path.resolve(value));
    } catch {
      /* مسیر ناموجود: نمی‌تواند به پروژهٔ دیگری برسد، ولی در حالت managed
         اساساً پذیرفتنی نیست. */
      return { key, value };
    }

    if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) {
      return { key, value };
    }
  }

  return null;
}
