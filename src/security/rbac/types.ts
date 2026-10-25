/**
 * RBAC and Scoped Access Control Types for Platform V2.
 */

export type PlatformRole =
  | 'Admin'
  | 'Architect'
  | 'Developer'
  | 'Agent'
  | 'ReadOnly';

export type PermissionScope =
  | 'project:read'
  | 'project:write'
  | 'project:admin'
  | 'semantic:query'
  | 'semantic:context'
  | 'semantic:index'
  | 'semantic:mutate'
  | 'config:read'
  | 'config:write'
  | 'auth:manage'
  | 'audit:read'
  | 'system:admin';

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly keyHash: string;
  readonly role: PlatformRole;
  readonly permissions: readonly PermissionScope[];
  readonly resourceScope: string; // '*' for all projects, or 'project:<id>'
  /**
   * فهرست صریح پروژه‌هایی که این کلید به آن‌ها می‌رسد (فاز ۹). نبودِ فیلد
   * یعنی همان `resourceScope` قدیمی معتبر است، پس کلیدهای موجود نمی‌شکنند.
   */
  readonly allowedProjects?: readonly string[];
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly lastUsedAt?: number;
  readonly revoked?: boolean;
}

export interface AuthContext {
  readonly authenticated: boolean;
  readonly keyId?: string;
  readonly name?: string;
  readonly role?: PlatformRole;
  readonly permissions: readonly PermissionScope[];
  readonly resourceScope: string;
  /**
   * F-0010 — فهرست صریح پروژه‌های مجاز. gateway با `canAccessProject` این را
   * رعایت می‌کرد ولی مسیر platform آن را دور می‌زد؛ حالا در AuthContext حمل
   * می‌شود تا `PermissionChecker` همان مجموعه را اعمال کند و دو مسیر هم‌رفتار
   * بمانند. نبودش یعنی فقط `resourceScope` معتبر است.
   */
  readonly allowedProjects?: readonly string[];
}

export const ROLE_DEFAULT_PERMISSIONS: Record<PlatformRole, readonly PermissionScope[]> = {
  Admin: [
    'project:read',
    'project:write',
    'project:admin',
    'semantic:query',
    'semantic:context',
    'semantic:index',
    'semantic:mutate',
    'config:read',
    'config:write',
    'auth:manage',
    'audit:read',
    'system:admin',
  ],
  Architect: [
    'project:read',
    'project:write',
    'semantic:query',
    'semantic:context',
    'semantic:index',
    'semantic:mutate',
    'config:read',
    'audit:read',
  ],
  Developer: [
    'project:read',
    'project:write',
    'semantic:query',
    'semantic:context',
    'semantic:index',
    'config:read',
  ],
  Agent: [
    'project:read',
    'semantic:query',
    'semantic:context',
    'semantic:mutate',
  ],
  ReadOnly: [
    'project:read',
    'semantic:query',
    'config:read',
  ],
};
