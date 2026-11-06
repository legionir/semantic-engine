import { HttpServer } from './HttpServer';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

/*
| `import-bundle` فایل‌های مجازی را زیر cwd می‌نویسد، و این تست تا
| حالا آن‌ها را جا می‌گذاشت: بعد از هر بار `npm test` یک پوشهٔ
| `virtual-proj-1/` در working tree می‌ماند که نه ignore شده بود نه
| tracked — یعنی نویز دائمی در `git status` همه.
*/
const IMPORTED_PROJECT_ID = 'virtual-proj-1';

describe('V2 REST Endpoints E2E', () => {
  let server: HttpServer;
  let serverUrl: string;
  let adminToken: string;

  beforeAll(async () => {
    adminToken = 'test-admin-secret-token';
    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: adminToken,
      allowRemote: false,
    });

    const info = await server.start();
    serverUrl = info.url;
  });

  afterAll(async () => {
    await server.stop();

    fs.rmSync(path.resolve(process.cwd(), IMPORTED_PROJECT_ID), {
      recursive: true,
      force: true,
    });
  });

  const request = (path: string, options: http.RequestOptions = {}, body?: unknown): Promise<{ status: number; json: any }> => {
    return new Promise((resolve, reject) => {
      const u = new URL(path, serverUrl);
      const req = http.request(
        u,
        {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
            ...(options.headers || {}),
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode || 200, json: data ? JSON.parse(data) : {} });
            } catch {
              resolve({ status: res.statusCode || 200, json: data });
            }
          });
        }
      );
      req.on('error', reject);
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  };

  it('GET /api/v2/auth/roles returns platform roles and permissions', async () => {
    const res = await request('/api/v2/auth/roles', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.json.roles).toContain('Admin');
    expect(res.json.roles).toContain('Agent');
  });

  it('POST /api/v2/auth/keys creates a new scoped API Key', async () => {
    const res = await request('/api/v2/auth/keys', { method: 'POST' }, {
      name: 'Agent Key Alpha',
      role: 'Agent',
      resourceScope: 'project:p1',
    });

    expect(res.status).toBe(201);
    expect(res.json.rawToken).toMatch(/^sk_plat_/);
    expect(res.json.key.role).toBe('Agent');
    expect(res.json.key.resourceScope).toBe('project:p1');
  });

  it('denies auth management to a ReadOnly API key', async () => {
    const readOnly = server.apiKeyStore.createKey({
      name: 'read-only-test',
      role: 'ReadOnly',
    });

    const res = await request('/api/v2/auth/keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${readOnly.rawToken}` },
    }, {
      name: 'escalation-attempt',
      role: 'Admin',
    });

    expect(res.status).toBe(403);
  });

  it('POST /api/v2/projects/import-bundle imports virtual source files', async () => {
    const res = await request('/api/v2/projects/import-bundle', { method: 'POST' }, {
      projectId: IMPORTED_PROJECT_ID,
      name: 'Virtual Project',
      files: {
        'src/main.ts': 'export const app = "online";',
        'src/utils.ts': 'export function helper() { return 42; }',
      },
    });

    expect(res.status).toBe(201);
    expect(res.json.syncResult.filesSynced).toBe(2);
  });
});

describe('import-bundle input handling (F-07)', () => {
  let server: HttpServer;
  let serverUrl: string;
  const token = 'bundle-token';

  beforeAll(async () => {
    server = new HttpServer({ port: 0, host: '127.0.0.1', token, allowRemote: false });
    serverUrl = (await server.start()).url;
  });
  afterAll(async () => {
    await server.stop();
  });

  async function post(route: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${serverUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it.each(['../escape', '/etc', 'a/b', '..', 'x y'])('refuses projectId %j as a folder name', async projectId => {
    const res = await post('/api/v2/projects/import-bundle', { projectId, files: { 'a.ts': 'x' } });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/projectId/);
  });

  it('does not leave a folder or a registered project behind when the bundle is rejected', async () => {
    const id = 'rejected-bundle-proj';
    const res = await post('/api/v2/projects/import-bundle', {
      projectId: id,
      files: { '../outside.ts': 'x' },
    });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.resolve(id))).toBe(false);
    const list = await fetch(`${serverUrl}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}` } });
    const projects = (await list.json()) as { projects?: Array<{ id: string }> };
    expect((projects.projects ?? []).some(p => p.id === id)).toBe(false);
  });

  it('PUT files/:path without content is a 400 and leaves the file as it was', async () => {
    const id = 'put-guard-proj';
    const made = await post('/api/v2/projects/import-bundle', { projectId: id, files: { 'keep.ts': 'export const keep = 1;' } });
    expect(made.status).toBe(201);
    try {
      const res = await fetch(`${serverUrl}/api/v1/projects/${id}/files/keep.ts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(fs.readFileSync(path.join(path.resolve(id), 'keep.ts'), 'utf8')).toBe('export const keep = 1;');
    } finally {
      fs.rmSync(path.resolve(id), { recursive: true, force: true });
    }
  });
});
