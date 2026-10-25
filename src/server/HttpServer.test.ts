/**
 * Platform Core V1 — HttpServer, SecurityPipeline & Routes Unit & Integration Tests.
 */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { HttpServer } from './HttpServer';

describe('Platform Core V1 — HttpServer & API Gateway', () => {
  let server: HttpServer;
  let serverUrl: string;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-platform-test-'));

    // Create a fake project with index
    const prjDir = path.join(tmpRoot, 'sample-app');
    const semanticDir = path.join(prjDir, '.agent', 'semantic');
    fs.mkdirSync(semanticDir, { recursive: true });

    const fakeIndex = {
      schemaVersion: '2.0.0',
      root: 'sample-app',
      generatedAt: new Date().toISOString(),
      rootPath: prjDir,
      languages: ['typescript'],
      files: [
        { id: 'f-auth', path: 'src/auth.ts', language: 'typescript', role: 'service', size: 100, lines: 10, hash: '123', modified: new Date().toISOString(), binary: false, testFile: false, generated: false },
        { id: 'f-user', path: 'src/user.ts', language: 'typescript', role: 'entity', size: 100, lines: 10, hash: '456', modified: new Date().toISOString(), binary: false, testFile: false, generated: false },
      ],
      symbols: [
        {
          id: 'sym-login',
          name: 'login',
          kind: 'function',
          fileId: 'f-auth',
          parentId: null,
          line: 10,
          endLine: 25,
          source: 'compiler',
          confidence: 100,
          exported: true,
          complexity: 3,
        },
      ],
      graphs: {
        dependencyGraph: [
          { from: 'f-auth', to: 'f-user', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'resolved' } },
        ],
        callGraph: [],
        typeGraph: [],
        reverseDependencyGraph: [],
      },
      diagnostics: [],
      metrics: {
        totalFiles: 2,
        totalLoc: 20,
        totalSymbols: 1,
        avgCyclomaticComplexity: 3,
        languageBreakdown: { typescript: 2 },
      },
    };

    fs.writeFileSync(path.join(semanticDir, 'project-index.json'), JSON.stringify(fakeIndex, null, 2), 'utf8');

    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: 'secret-token-123',
      projectsRoot: tmpRoot,
    });

    const info = await server.start();
    serverUrl = info.url;

    // Register project
    server.projects.registerProject(prjDir, 'sample-app', 'Sample App');
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function request(
    method: string,
    urlPath: string,
    body?: unknown,
    token?: string
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any; text: string }> {
    return new Promise((resolve, reject) => {
      const u = new URL(urlPath, serverUrl);
      const headers: Record<string, string> = {};

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

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
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: any;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
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

  it('GET /api/v1/system returns operational capabilities', async () => {
    const res = await request('GET', '/api/v1/system');
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('operational');
    expect(res.json.capabilities.semanticSearch).toBe(true);
    expect(res.json.capabilities.layeredGraph).toBe(true);
  });

  it('GET /health and GET /ready return status healthy and ready', async () => {
    const health = await request('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.json.status).toBe('healthy');

    const ready = await request('GET', '/ready');
    expect(ready.status).toBe(200);
    expect(ready.json.ready).toBe(true);
  });

  it('GET /api/v1/config requires authentication', async () => {
    const unauth = await request('GET', '/api/v1/config');
    expect(unauth.status).toBe(401);

    const auth = await request('GET', '/api/v1/config', undefined, 'secret-token-123');
    expect(auth.status).toBe(200);
    expect(auth.json.tokenConfigured).toBe(true);
  });

  it('GET /api/v1/projects lists registered projects', async () => {
    const res = await request('GET', '/api/v1/projects', undefined, 'secret-token-123');
    expect(res.status).toBe(200);
    expect(res.json.total).toBeGreaterThanOrEqual(1);
    expect(res.json.projects[0].id).toBe('sample-app');
  });

  it('GET /api/v1/projects/:id returns single project details', async () => {
    const res = await request('GET', '/api/v1/projects/sample-app', undefined, 'secret-token-123');
    expect(res.status).toBe(200);
    expect(res.json.id).toBe('sample-app');
    expect(res.json.status).toBe('ready');
  });

  it('POST /api/v1/projects with schema validation checks required fields', async () => {
    const bad = await request('POST', '/api/v1/projects', {}, 'secret-token-123');
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Validation failed');
  });

  it('GET /api/v1/projects/:id/symbols/:symbolId returns symbol explanation', async () => {
    const res = await request('GET', '/api/v1/projects/sample-app/symbols/sym-login', undefined, 'secret-token-123');
    expect(res.status).toBe(200);
    expect(res.json.symbol).toBe('login');
  });

  it('GET /api/v1/projects/:id/visualization/architecture returns level 1 architecture graph', async () => {
    const res = await request('GET', '/api/v1/projects/sample-app/visualization/architecture', undefined, 'secret-token-123');
    expect(res.status).toBe(200);
    expect(res.json.level).toBe('architecture');
    expect(Array.isArray(res.json.nodes)).toBe(true);
  });

  it('SE-VIZ-01 — every architecture edge connects two existing nodes (no dangling edges)', async () => {
    const res = await request('GET', '/api/v1/projects/sample-app/visualization/architecture', undefined, 'secret-token-123');
    expect(res.status).toBe(200);

    const nodeIds = new Set(res.json.nodes.map((n: { id: string }) => n.id));
    // یال‌های dependencyGraph در fixture بین fileId ها هستند؛ view باید
    // آن‌ها را به نودهای ماژولِ موجود جمع کند، نه اینکه به fileId خام
    // اشاره کند (باگی که نودها را «بدون خط» می‌کرد).
    for (const edge of res.json.edges as Array<{ source: string; target: string }>) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }

    // fixture یک وابستگی src/auth → src/user دارد، پس باید حداقل یک یال درآید.
    expect((res.json.edges as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('SE-VIZ-01 — architecture view has no isolated non-layer nodes', async () => {
    const res = await request('GET', '/api/v1/projects/sample-app/visualization/architecture', undefined, 'secret-token-123');
    expect(res.status).toBe(200);

    const connected = new Set<string>();
    for (const e of res.json.edges as Array<{ source: string; target: string }>) {
      connected.add(e.source);
      connected.add(e.target);
    }
    const isolated = (res.json.nodes as Array<{ id: string; metadata?: { role?: string } }>).filter(
      n => n.metadata?.role !== 'layer' && !connected.has(n.id)
    );
    expect(isolated).toHaveLength(0);
  });

  it('POST /api/v1/projects/:id/visualization/neighborhood returns level 4 neighborhood graph', async () => {
    const res = await request(
      'POST',
      '/api/v1/projects/sample-app/visualization/neighborhood',
      { seedId: 'sym-login', depth: 1 },
      'secret-token-123'
    );
    expect(res.status).toBe(200);
    expect(res.json.level).toBe('neighborhood');
    expect(res.json.nodes.length).toBeGreaterThanOrEqual(1);
  });

  it('serves the Open/Configure landing page on GET / (SE-UI-07)', async () => {
    const res = await request('GET', '/');
    expect(res.status).toBe(200);
    /*
    | صفحهٔ ورود «Settings» است تا UI بدون ایندکس قبلی هم بالا بیاید.
    | متن رابط کاربری به انگلیسی و LTR منتقل شد، پس چیزی که اینجا
    | سنجیده می‌شود هم همان است.
    */
    expect(res.text).toContain('Project location');
    expect(res.text).toContain('lang="en"');
  });

  it('still serves the visualizer on GET /visualizer', async () => {
    const res = await request('GET', '/visualizer');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Project Intelligence Visualizer');
  });

  /*
  |--------------------------------------------------------------------
  | امنیت — هر کدام یک یافتهٔ واقعی که یک‌بار در حال اجرا بازتولید شد
  |--------------------------------------------------------------------
  */

  describe('احراز هویت پیش‌فرض است، نه opt-in', () => {
    /*
    | `requireAuth` قبلاً opt-in بود، پس هر مسیری که یادش می‌رفت
    | بنویسدش باز می‌ماند. شمرده شد: ۲۵ مسیر در ۷ فایل.
    */
    it.each([
      ['GET', '/api/v1/fs/browse?path=/'],
      ['GET', '/api/v1/providers'],
      ['GET', '/api/v1/projects'],
      ['GET', '/api/v1/projects/sample-app/visualization/architecture'],
      ['GET', '/api/v1/projects/sample-app/symbols/sym-login'],
    ])('%s %s بدون توکن رد می‌شود', async (method, url) => {
      const res = await request(method, url);
      expect(res.status).toBe(401);
    });

    it('fs/browse دیگر بدون توکن کل فایل‌سیستم را لیست نمی‌کند', async () => {
      const anonymous = await request('GET', '/api/v1/fs/browse?path=/');
      expect(anonymous.status).toBe(401);
      expect(anonymous.text).not.toContain('"entries"');

      const authorised = await request('GET', '/api/v1/fs/browse', undefined, 'secret-token-123');
      expect(authorised.status).toBe(200);
    });

    /*
    | مسیرهای زنده‌بودن عمداً باز می‌مانند: یک load balancer توکن ندارد.
    */
    it.each(['/health', '/ready', '/metrics', '/api/v1/system'])(
      '%s عمداً باز می‌ماند',
      async url => {
        const res = await request('GET', url);
        expect(res.status).toBe(200);
      }
    );
  });

  describe('بررسی Origin — دفاع در برابر DNS-rebinding', () => {
    function withOrigin(urlPath: string, origin: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
      return new Promise((resolve, reject) => {
        const u = new URL(urlPath, serverUrl);
        const req = http.request(
          u,
          {
            method: 'GET',
            headers: { Origin: origin, Authorization: 'Bearer secret-token-123' },
          },
          res => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
          }
        );
        req.on('error', reject);
        req.end();
      });
    }

    /*
    | `checkConnection` این را نمی‌گرفت: در این حمله IP طرف مقابل
    | واقعاً 127.0.0.1 است، چون مرورگرِ خودِ قربانی درخواست را می‌زند.
    */
    it('یک Origin بیرونی با توکن معتبر هم رد می‌شود', async () => {
      const res = await withOrigin('/api/v1/projects', 'http://evil.example.com');
      expect(res.status).toBe(403);
    });

    it('Origin محلی می‌گذرد و دقیقاً همان بازتاب داده می‌شود، نه *', async () => {
      const res = await withOrigin('/api/v1/projects', 'http://127.0.0.1:9999');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:9999');
    });

    it('نبودِ Origin یعنی درخواست از مرورگر نیامده و مانعی نیست', async () => {
      const res = await request('GET', '/api/v1/projects', undefined, 'secret-token-123');
      expect(res.status).toBe(200);
    });
  });
});
