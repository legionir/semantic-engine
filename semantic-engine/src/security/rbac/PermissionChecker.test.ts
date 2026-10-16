import { PermissionChecker } from './PermissionChecker';
import { AuthContext } from './types';

describe('PermissionChecker (V2 Scoped RBAC)', () => {
  it('allows Admin with global wildcard scope to access any project and resource', () => {
    const auth: AuthContext = {
      authenticated: true,
      role: 'Admin',
      permissions: ['project:read', 'project:write', 'system:admin'],
      resourceScope: '*',
    };

    const res = PermissionChecker.hasPermission(auth, 'project:write', 'project-any');
    expect(res.allowed).toBe(true);
  });

  it('rejects Agent scoped to project-A when attempting to access project-B', () => {
    const auth: AuthContext = {
      authenticated: true,
      role: 'Agent',
      permissions: ['semantic:query', 'semantic:context', 'project:read'],
      resourceScope: 'project:project-A',
    };

    const allowedOnA = PermissionChecker.hasPermission(auth, 'semantic:query', 'project-A');
    expect(allowedOnA.allowed).toBe(true);

    const allowedOnB = PermissionChecker.hasPermission(auth, 'semantic:query', 'project-B');
    expect(allowedOnB.allowed).toBe(false);
    expect(allowedOnB.reason).toContain('Resource scope mismatch');
  });

  it('rejects action when required permission is missing', () => {
    const auth: AuthContext = {
      authenticated: true,
      role: 'ReadOnly',
      permissions: ['project:read', 'semantic:query'],
      resourceScope: '*',
    };

    const res = PermissionChecker.hasPermission(auth, 'config:write');
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Missing required permission');
  });

  // F-0010 — allowedProjects باید روی مسیر پلتفرم هم اعمال شود (parity با gateway).
  describe('F-0010 allowedProjects enforcement', () => {
    it('allows a target listed in allowedProjects even when resourceScope is *', () => {
      const auth: AuthContext = {
        authenticated: true,
        role: 'Agent',
        permissions: ['project:read'],
        resourceScope: '*',
        allowedProjects: ['p1', 'p2'],
      };
      expect(PermissionChecker.hasPermission(auth, 'project:read', 'p2').allowed).toBe(true);
    });

    it('rejects a target NOT in allowedProjects even when resourceScope is *', () => {
      const auth: AuthContext = {
        authenticated: true,
        role: 'Agent',
        permissions: ['project:read'],
        resourceScope: '*',
        allowedProjects: ['p1', 'p2'],
      };
      const res = PermissionChecker.hasPermission(auth, 'project:read', 'p-secret');
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain('allowedProjects');
    });

    it('matches gateway canAccessProject: explicit list wins over resourceScope', () => {
      // gateway صادرکننده توکن چندپروژه‌ای: resourceScope=project:p1 ولی
      // allowedProjects=['p1','p2'] — مسیر platform باید p2 را بپذیرد.
      const auth: AuthContext = {
        authenticated: true,
        role: 'Agent',
        permissions: ['project:read'],
        resourceScope: 'project:p1',
        allowedProjects: ['p1', 'p2'],
      };
      expect(PermissionChecker.hasPermission(auth, 'project:read', 'p2').allowed).toBe(true);
      expect(PermissionChecker.hasPermission(auth, 'project:read', 'p3').allowed).toBe(false);
    });

    it('honors allowedProjects=["*"] as all projects', () => {
      const auth: AuthContext = {
        authenticated: true,
        role: 'Agent',
        permissions: ['project:read'],
        resourceScope: '*',
        allowedProjects: ['*'],
      };
      expect(PermissionChecker.hasPermission(auth, 'project:read', 'anything').allowed).toBe(true);
    });
  });
});
