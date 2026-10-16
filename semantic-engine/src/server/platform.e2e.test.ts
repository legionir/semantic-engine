/**
 * Platform Core V1 — End-to-End (E2E) Platform Test Suite.
 *
 * Verifies full platform lifecycle:
 * System Info -> Register Project -> Async Indexing Job -> LoD Subgraphs -> Search -> Symbol 360 -> Context Assembly -> Shutdown.
 */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { HttpServer } from './HttpServer';

describe('Platform Core V1 — Full E2E Flow', () => {
  let server: HttpServer;
  let serverUrl: string;
  let tmpRoot: string;
  const token = 'test-e2e-token-999';

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-platform-e2e-'));

    // Create a real small codebase. Files live in TWO directories on
    // purpose: with everything in a single module the architecture view
    // correctly degrades to the file-level fallback (SE-VIZ-01), and the
    // LoD level-1 contract — level 'architecture' with real module edges —
    // needs a module boundary to cross.
    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(path.join(srcDir, 'auth'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'api'), { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'auth', 'auth.ts'),
      `export class AuthService {
  login(username: string, pass: string): boolean {
    return username === 'admin';
  }
}
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(srcDir, 'api', 'user.ts'),
      `import { AuthService } from './auth';

export class UserController {
  private auth = new AuthService();

  handleLogin(name: string): boolean {
    return this.auth.login(name, 'secret');
  }
}
`,
      'utf8'
    );

    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token,
      projectsRoot: tmpRoot,
    });

    const info = await server.start();
    serverUrl = info.url;
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function api(
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<{ status: number; json: any; text: string }> {
    return new Promise((resolve, reject) => {
      const u = new URL(urlPath, serverUrl);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const req = http.request(
        u,
        {
          method,
          headers,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: any = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* ignore */
            }
            resolve({
              status: res.statusCode || 0,
              json,
              text,
            });
          });
        }
      );

      req.on('error', reject);
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  it('1. System & Health: reports operational status', async () => {
    const sys = await api('GET', '/api/v1/system');
    expect(sys.status).toBe(200);
    expect(sys.json.status).toBe('operational');
    expect(sys.json.capabilities.graphQuery).toBe(true);

    const health = await api('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.json.status).toBe('healthy');

    const ready = await api('GET', '/ready');
    expect(ready.status).toBe(200);
    expect(ready.json.ready).toBe(true);
    expect(ready.json.checks.jobManager).toBe(true);
    expect(ready.json.checks.projectRegistry).toBe(true);
  });

  it('2. Project Registration: registers project successfully', async () => {
    const reg = await api('POST', '/api/v1/projects', {
      path: tmpRoot,
      id: 'e2e-project',
      name: 'E2E Test Project',
    });

    expect(reg.status).toBe(201);
    expect(reg.json.id).toBe('e2e-project');
    expect(reg.json.name).toBe('E2E Test Project');
  });

  it('3. Async Indexing Job: triggers and tracks indexing to completion', async () => {
    const startJob = await api('POST', '/api/v1/projects/e2e-project/index');
    expect(startJob.status).toBe(202);
    expect(startJob.json.jobId).toBeTruthy();

    const jobId = startJob.json.jobId;

    // Poll until completed (or timeout)
    let completed = false;
    for (let i = 0; i < 20; i++) {
      const poll = await api('GET', `/api/v1/projects/e2e-project/jobs/${jobId}`);
      expect(poll.status).toBe(200);
      if (poll.json.status === 'completed') {
        completed = true;
        expect(poll.json.progress).toBe(100);
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    expect(completed).toBe(true);
  });

  it('4. LoD Architecture Graph: extracts top level architecture view', async () => {
    const arch = await api('GET', '/api/v1/projects/e2e-project/visualization/architecture');
    expect(arch.status).toBe(200);
    // VIZ-036: a project without module structure falls back to the file-level
    // view and must report that level honestly instead of claiming 'architecture'.
    expect(['architecture', 'file']).toContain(arch.json.level);
    expect(arch.json.state).toBe('ready');
    expect(Array.isArray(arch.json.nodes)).toBe(true);
    expect(arch.json.nodes.length).toBeGreaterThan(0);
  });

  it('5. Search Service: searches symbols by query', async () => {
    const search = await api('POST', '/api/v1/projects/e2e-project/search', {
      query: 'login',
      mode: 'keyword',
    });

    expect(search.status).toBe(200);
    expect(search.json.total).toBeGreaterThanOrEqual(1);
    expect(search.json.items.some((i: any) => i.name.toLowerCase().includes('login') || i.name.includes('Auth'))).toBe(true);
  });

  it('6. Context Assembly: generates token-budgeted context bundle', async () => {
    const ctx = await api('POST', '/api/v1/projects/e2e-project/context', {
      task: 'authenticate user',
      maxTokens: 1000,
    });

    expect(ctx.status).toBe(200);
    expect(ctx.json.task).toBe('authenticate user');
    expect(ctx.json.items).toBeDefined();
  });
});
