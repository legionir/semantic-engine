/**
 * PermissionChecker — Evaluates permissions and resource scoping for Platform V2.
 */

import { AuthContext, PermissionScope } from './types';

export class PermissionChecker {
  static hasPermission(
    auth: AuthContext,
    requiredPermission: PermissionScope,
    targetProjectId?: string
  ): { allowed: boolean; reason?: string } {
    if (!auth.authenticated) {
      return { allowed: false, reason: 'Unauthenticated' };
    }

    if (!auth.permissions.includes(requiredPermission) && !auth.permissions.includes('system:admin')) {
      return {
        allowed: false,
        reason: `Missing required permission: ${requiredPermission}`,
      };
    }

    if (targetProjectId) {
      // F-0010 — parity با `GatewayAuth.canAccessProject`: اگر فهرست صریح
      // allowedProjects وجود دارد، همان منبع حقیقت است؛ در غیر این صورت
      // resourceScope قدیمی (`project:<id>` یا `*`) بررسی می‌شود.
      const allowed = auth.allowedProjects;
      if (allowed) {
        if (!allowed.includes('*') && !allowed.includes(targetProjectId)) {
          return {
            allowed: false,
            reason: `Key is not allowed to access 'project:${targetProjectId}' (allowedProjects enforced on the platform path)`,
          };
        }
      } else if (auth.resourceScope !== '*') {
        const allowedScope = `project:${targetProjectId}`;
        if (auth.resourceScope !== allowedScope) {
          return {
            allowed: false,
            reason: `Resource scope mismatch: key is scoped to '${auth.resourceScope}', but request targets 'project:${targetProjectId}'`,
          };
        }
      }
    }

    return { allowed: true };
  }
}
