/**
 * Gateway authorization — فاز ۹.
 *
 * The public token of the Gateway is not the internal token of a worker, and
 * neither is a capability to reach every project. A token here carries:
 *
 *   - `permissions` — the same `PermissionScope` names the platform already
 *     uses (`project:read`, `semantic:query`, `semantic:index`, `auth:manage`),
 *     so the Gateway does not invent a second vocabulary;
 *   - `allowedProjects` — the projects this token may reach. `'*'` means all.
 *
 * Storage is the existing `ApiKeyStore`: tokens are kept as SHA-256 hashes, so
 * a memory dump or a log line cannot leak one.
 */

import { ApiKeyStore } from '../security/rbac/ApiKeyStore';
import { ApiKeyRecord, PermissionScope, ROLE_DEFAULT_PERMISSIONS } from '../security/rbac/types';
import * as http from 'http';

export const ALL_PROJECTS = '*';

export interface GatewayAuthResult {
  readonly authenticated: boolean;
  readonly record?: ApiKeyRecord;
}

export class GatewayAuth {
  readonly keys: ApiKeyStore;

  constructor(bootstrapToken?: string) {
    this.keys = new ApiKeyStore(bootstrapToken);
  }

  /** توکن از `Authorization: Bearer …`، `x-api-key` یا `?token=`. */
  extractToken(req: http.IncomingMessage, queryToken?: string): string | undefined {
    const header = req.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.trim() !== '') return apiKey.trim();
    if (queryToken && queryToken.trim() !== '') return queryToken.trim();
    return undefined;
  }

  verify(req: http.IncomingMessage, queryToken?: string): GatewayAuthResult {
    const token = this.extractToken(req, queryToken);
    if (!token) return { authenticated: false };

    const record = this.keys.verifyToken(token);
    if (!record) return { authenticated: false };
    return { authenticated: true, record };
  }

  hasPermission(record: ApiKeyRecord, permission: PermissionScope): boolean {
    return record.permissions.includes(permission);
  }

  /** آیا این توکن به این پروژه می‌رسد؟ */
  canAccessProject(record: ApiKeyRecord, projectId: string): boolean {
    if (record.resourceScope === ALL_PROJECTS && !record.allowedProjects) return true;
    const allowed = record.allowedProjects;
    if (!allowed) return record.resourceScope === `project:${projectId}`;
    return allowed.includes(ALL_PROJECTS) || allowed.includes(projectId);
  }

  listKeys(): { id: string; name: string; permissions: readonly string[]; allowedProjects: readonly string[] }[] {
    return this.keys.listKeys().map(record => ({
      id: record.id,
      name: record.name,
      permissions: record.permissions,
      allowedProjects: record.allowedProjects ?? [record.resourceScope],
    }));
  }

  /**
   * ساخت توکن محدود به چند پروژه. مقدار خام فقط یک بار برگردانده می‌شود؛
   * store فقط hash را نگه می‌دارد.
   */
  issueToken(options: {
    name: string;
    allowedProjects: readonly string[];
    permissions: readonly PermissionScope[];
  }): { id: string; token: string } {
    const projects = options.allowedProjects;
    const { rawToken, key } = this.keys.createKey({
      name: options.name,
      role: 'Agent',
      permissions: options.permissions,
      resourceScope:
        projects.includes(ALL_PROJECTS) || projects.length === 0
          ? ALL_PROJECTS
          : `project:${projects[0]}`,
      ...(projects.length > 0 ? { allowedProjects: projects } : {}),
    });
    return { id: key.id, token: rawToken };
  }

  static adminPermissions(): readonly PermissionScope[] {
    return ROLE_DEFAULT_PERMISSIONS.Admin;
  }
}
