import { ALL_PROJECTS, GatewayAuth } from './GatewayAuth';

describe('GatewayAuth.issueToken scope (F-08)', () => {
  it('refuses an empty project list instead of granting every project', () => {
    const auth = new GatewayAuth('boot');
    expect(() => auth.issueToken({ name: 'x', allowedProjects: [], permissions: ['project:read'] })).toThrow(/at least one project/);
  });

  it('a token for one project reaches that project only', () => {
    const auth = new GatewayAuth('boot');
    const { token } = auth.issueToken({ name: 'x', allowedProjects: ['prj-a'], permissions: ['project:read'] });
    const record = auth.keys.verifyToken(token)!;
    expect(auth.canAccessProject(record, 'prj-a')).toBe(true);
    expect(auth.canAccessProject(record, 'prj-b')).toBe(false);
  });

  it("'*' must be asked for explicitly", () => {
    const auth = new GatewayAuth('boot');
    const { token } = auth.issueToken({ name: 'x', allowedProjects: [ALL_PROJECTS], permissions: ['project:read'] });
    expect(auth.canAccessProject(auth.keys.verifyToken(token)!, 'anything')).toBe(true);
  });
});
