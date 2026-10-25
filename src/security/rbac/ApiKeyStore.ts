/**
 * ApiKeyStore — In-memory & persisted API Key store for Platform V2.
 */

import * as crypto from 'crypto';
import { ApiKeyRecord, PlatformRole, PermissionScope, ROLE_DEFAULT_PERMISSIONS } from './types';

export class ApiKeyStore {
  private readonly keys = new Map<string, ApiKeyRecord>();
  private readonly tokenLookup = new Map<string, string>(); // tokenHash -> keyId

  constructor(defaultAdminToken?: string) {
    if (defaultAdminToken) {
      this.registerBootstrapKey(defaultAdminToken);
    }
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  registerBootstrapKey(rawToken: string): ApiKeyRecord {
    const keyHash = this.hashToken(rawToken);
    const id = 'key_bootstrap_admin';
    const record: ApiKeyRecord = {
      id,
      name: 'Bootstrap Admin',
      keyHash,
      role: 'Admin',
      permissions: ROLE_DEFAULT_PERMISSIONS.Admin,
      resourceScope: '*',
      createdAt: Date.now(),
    };
    this.keys.set(id, record);
    this.tokenLookup.set(keyHash, id);
    return record;
  }

  createKey(params: {
    name: string;
    role: PlatformRole;
    permissions?: readonly PermissionScope[];
    resourceScope?: string;
    allowedProjects?: readonly string[];
    expiresInMs?: number;
  }): { rawToken: string; key: ApiKeyRecord } {
    const id = `key_${crypto.randomBytes(8).toString('hex')}`;
    const rawToken = `sk_plat_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = this.hashToken(rawToken);

    const permissions = params.permissions && params.permissions.length > 0
      ? params.permissions
      : ROLE_DEFAULT_PERMISSIONS[params.role] || ROLE_DEFAULT_PERMISSIONS.ReadOnly;

    const record: ApiKeyRecord = {
      id,
      name: params.name,
      keyHash,
      role: params.role,
      permissions,
      resourceScope: params.resourceScope || '*',
      ...(params.allowedProjects ? { allowedProjects: params.allowedProjects } : {}),
      createdAt: Date.now(),
      expiresAt: params.expiresInMs ? Date.now() + params.expiresInMs : undefined,
    };

    this.keys.set(id, record);
    this.tokenLookup.set(keyHash, id);
    return { rawToken, key: record };
  }

  verifyToken(rawToken: string): ApiKeyRecord | null {
    if (!rawToken) return null;
    const keyHash = this.hashToken(rawToken);
    const keyId = this.tokenLookup.get(keyHash);
    if (!keyId) return null;

    const record = this.keys.get(keyId);
    if (!record || record.revoked) return null;

    if (record.expiresAt && Date.now() > record.expiresAt) {
      return null;
    }

    const updated: ApiKeyRecord = {
      ...record,
      lastUsedAt: Date.now(),
    };
    this.keys.set(keyId, updated);
    return updated;
  }

  revokeKey(keyId: string): boolean {
    const record = this.keys.get(keyId);
    if (!record) return false;

    this.keys.set(keyId, { ...record, revoked: true });
    this.tokenLookup.delete(record.keyHash);
    return true;
  }

  listKeys(): readonly ApiKeyRecord[] {
    return Array.from(this.keys.values()).map(k => ({
      ...k,
      keyHash: '***',
    }));
  }

  getKey(keyId: string): ApiKeyRecord | null {
    const record = this.keys.get(keyId);
    if (!record) return null;
    return { ...record, keyHash: '***' };
  }
}
