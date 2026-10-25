import { ApiKeyStore } from './ApiKeyStore';

describe('ApiKeyStore (V2 RBAC)', () => {
  it('registers and verifies bootstrap admin key', () => {
    const store = new ApiKeyStore('admin-secret-token');
    const verified = store.verifyToken('admin-secret-token');

    expect(verified).not.toBeNull();
    expect(verified?.role).toBe('Admin');
    expect(verified?.permissions).toContain('system:admin');
    expect(verified?.permissions).toContain('project:admin');
  });

  it('creates scoped developer and agent keys', () => {
    const store = new ApiKeyStore();
    const { rawToken, key } = store.createKey({
      name: 'Agent Key 1',
      role: 'Agent',
      resourceScope: 'project:project-123',
    });

    expect(key.role).toBe('Agent');
    expect(key.resourceScope).toBe('project:project-123');

    const verified = store.verifyToken(rawToken);
    expect(verified).not.toBeNull();
    expect(verified?.name).toBe('Agent Key 1');
  });

  it('revokes an API key successfully', () => {
    const store = new ApiKeyStore();
    const { rawToken, key } = store.createKey({
      name: 'Temp Key',
      role: 'ReadOnly',
    });

    expect(store.verifyToken(rawToken)).not.toBeNull();
    expect(store.revokeKey(key.id)).toBe(true);
    expect(store.verifyToken(rawToken)).toBeNull();
  });
});
