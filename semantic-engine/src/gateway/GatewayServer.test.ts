/**
 * Semantic Gateway — فاز ۹, measured end to end.
 *
 * Real HTTP clients, real worker processes, real Unix sockets. The criteria
 * that only this setup can prove:
 *
 *   - a request for project A never reaches worker B;
 *   - `public/open.js`'s two calls work against the Gateway unchanged;
 *   - an unknown project is 404, a token without the project is 403, a dead
 *     worker is 502 while its neighbour keeps serving;
 *   - every proxied answer says whose it is.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { GatewayServer } from './GatewayServer';
import { PROJECT_ID_HEADER } from './GatewayProxy';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
  text: string;
}

function request(
  port: number,
  method: string,
  urlPath: string,
  options: { token?: string; body?: unknown } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown> = {};
          try {
            body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
          } catch {
            body = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describeIfBuilt('Semantic Gateway', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;
  let rootA: string;
  let rootB: string;
  let idA: string;
  let idB: string;

  const makeProject = (name: string, marker: string): string => {
    const root = path.join(base, name);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'a.ts'),
      `export function ${marker}(): number { return 1; }\n`
    );
    return root;
  };

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gateway-')));
    rootA = makeProject('app-a', 'alpha');
    rootB = makeProject('app-b', 'beta');

    gateway = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'gateway-test-token',
    });

    const info = await gateway.start();
    port = info.port;
    token = info.token;

    const createdA = await request(port, 'POST', '/api/v1/gateway/projects', {
      token,
      body: { path: rootA, name: 'App A', autoStart: true },
    });
    const createdB = await request(port, 'POST', '/api/v1/gateway/projects', {
      token,
      body: { path: rootB, name: 'App B', autoStart: true },
    });

    idA = String(createdA.body['id']);
    idB = String(createdB.body['id']);
  }, 300_000);

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('answers /health without a token and /metrics with gateway counters', async () => {
    const health = await request(port, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body['projects']).toBe(2);

    const metrics = await request(port, 'GET', '/metrics', { token });
    expect(metrics.status).toBe(200);
    for (const key of [
      'gateway_projects_total',
      'gateway_workers_ready',
      'gateway_requests_total',
      'gateway_proxy_errors_total',
    ]) {
      expect(metrics.body).toHaveProperty(key);
    }
    expect(metrics.body['gateway_projects_total']).toBe(2);
  });

  it('keeps the two calls public/open.js makes', async () => {
    /* POST /api/v1/projects { path } — exactly what open.js:195 sends. */
    const created = await request(port, 'POST', '/api/v1/projects', {
      token,
      body: { path: rootA },
    });
    expect(created.status).toBe(201);
    for (const field of ['id', 'name', 'rootPath', 'status', 'stats']) {
      expect(created.body).toHaveProperty(field);
    }

    /* GET /api/v1/projects — the list shape open.js renders. */
    const list = await request(port, 'GET', '/api/v1/projects', { token });
    expect(list.status).toBe(200);
    expect(list.body['total']).toBe(2);
    const projects = list.body['projects'] as Record<string, unknown>[];
    expect(projects).toHaveLength(2);
    for (const project of projects) {
      for (const field of ['id', 'name', 'rootPath', 'status', 'stats']) {
        expect(project).toHaveProperty(field);
      }
    }
  });

  it('SE-F-058 — the gateway project LIST reports real counts, not fabricated zeros', async () => {
    /* `/api/v1/gateway/projects` is built by the gateway itself (not
       proxied), so this is where the old hard-coded zeros appeared.
       A ready worker has indexed its project, so its list entry must
       carry `available:true` with real counts and an observedAt. */
    const deadline = Date.now() + 60_000;
    let entry: Record<string, unknown> | undefined;
    let stats: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const reply = await request(port, 'GET', '/api/v1/gateway/projects', { token });
      expect(reply.status).toBe(200);
      const projects = reply.body['projects'] as Record<string, unknown>[];
      entry = projects.find(p => p['id'] === idA);
      stats = entry?.['stats'] as Record<string, unknown> | undefined;
      if (stats?.['available'] === true && (stats['filesCount'] as number) >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    expect(stats).toBeDefined();
    if (!(stats?.['available'] === true && (stats?.['filesCount'] as number) >= 1)) {
      throw new Error(`list stats never became real: ${JSON.stringify(stats)}`);
    }
    expect(stats?.['symbolsCount']).toBeGreaterThanOrEqual(1);
    expect(typeof stats?.['observedAt']).toBe('string');
  }, 120_000);

  it('routes each project to its own worker and says whose answer it is', async () => {
    const answerA = await request(port, 'GET', `/api/v1/projects/${idA}`, { token });
    const answerB = await request(port, 'GET', `/api/v1/projects/${idB}`, { token });

    expect(answerA.status).toBe(200);
    expect(answerB.status).toBe(200);

    /* The worker answers with its own project, never its neighbour's. */
    expect(answerA.body['id']).toBe(idA);
    expect(answerA.body['rootPath']).toBe(fs.realpathSync(rootA));
    expect(answerB.body['id']).toBe(idB);
    expect(answerB.body['rootPath']).toBe(fs.realpathSync(rootB));

    expect(answerA.headers[PROJECT_ID_HEADER]).toBe(idA);
    expect(answerB.headers[PROJECT_ID_HEADER]).toBe(idB);
  });

  it('never leaks a worker token to a client', async () => {
    const internal = gateway.supervisor.workerToken(idA);
    expect(internal).toBeTruthy();
    expect(internal).not.toBe(token);

    const reply = await request(port, 'GET', `/api/v1/projects/${idA}`, { token });
    expect(reply.status).toBe(200);
    expect(reply.text).not.toContain(internal as string);

    /* The public token is not what the worker authenticates with either. */
    const directList = await request(port, 'GET', '/api/v1/projects', { token });
    expect(directList.text).not.toContain(internal as string);
  });

  it('proxies the visualizer URLs unrewritten', async () => {
    const reply = await request(port, 'GET', `/api/v1/projects/${idA}/visualization/architecture`, {
      token,
    });
    /* 200 with a body, or a worker-level 4xx — but never a gateway 404. */
    expect(reply.status).not.toBe(404);
    expect(reply.headers[PROJECT_ID_HEADER]).toBe(idA);
  });

  it('refuses an unknown project, a missing token and a token without the project', async () => {
    const unknown = await request(port, 'GET', '/api/v1/projects/prj-nope-00000000', { token });
    expect(unknown.status).toBe(404);

    const anonymous = await request(port, 'GET', `/api/v1/projects/${idA}`);
    expect(anonymous.status).toBe(401);

    /* A token scoped to A only. */
    const scoped = gateway.auth.issueToken({
      name: 'only-a',
      allowedProjects: [idA],
      permissions: ['project:read', 'project:write'],
    });

    const allowed = await request(port, 'GET', `/api/v1/projects/${idA}`, { token: scoped.token });
    expect(allowed.status).toBe(200);

    const denied = await request(port, 'GET', `/api/v1/projects/${idB}`, { token: scoped.token });
    expect(denied.status).toBe(403);

    /* …and the scoped list shows only its own project. */
    const list = await request(port, 'GET', '/api/v1/projects', { token: scoped.token });
    expect(list.body['total']).toBe(1);
  });

  it('reports 502 for a stopped worker while its neighbour keeps serving', async () => {
    const stopped = await request(port, 'POST', `/api/v1/gateway/projects/${idB}/stop`, { token });
    expect(stopped.status).toBe(200);

    const dead = await request(port, 'GET', `/api/v1/projects/${idB}`, { token });
    expect(dead.status).toBe(502);

    const alive = await request(port, 'GET', `/api/v1/projects/${idA}`, { token });
    expect(alive.status).toBe(200);
    expect(alive.body['id']).toBe(idA);

    /* Bring B back so the remaining tests see two healthy workers. */
    const started = await request(port, 'POST', `/api/v1/gateway/projects/${idB}/start`, { token });
    expect(started.status).toBe(200);

    const back = await request(port, 'GET', `/api/v1/projects/${idB}`, { token });
    expect(back.status).toBe(200);
  }, 300_000);

  it('streams gateway events over SSE', async () => {
    const events = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/gateway/events',
          headers: { Authorization: `Bearer ${token}` },
        },
        res => {
          let received = '';
          res.on('data', chunk => {
            received += String(chunk);
            if (received.includes('data:')) {
              req.destroy();
              resolve(received);
            }
          });
        }
      );
      req.on('error', () => resolve(''));
      req.setTimeout(15_000, () => {
        req.destroy(new Error('SSE timed out'));
      });
      req.end();
    });

    expect(events).toContain('event: gateway');
    expect(events).toContain('"type":"hello"');
  }, 30_000);

  it('runs the lifecycle routes', async () => {
    const reindex = await request(port, 'POST', `/api/v1/gateway/projects/${idA}/reindex`, { token });
    expect([200, 202]).toContain(reindex.status);

    const detail = await request(port, 'GET', `/api/v1/gateway/projects/${idA}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.body['id']).toBe(idA);

    const renamed = await request(port, 'PATCH', `/api/v1/gateway/projects/${idA}`, {
      token,
      body: { name: 'App A renamed' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body['name']).toBe('App A renamed');
  }, 300_000);

  /*
  | SE-F-057 — editing an existing worker must persist the WHOLE config and
  | reload truthfully. The dashboard used to POST only path/name/id/autoStart
  | to the collection, so every indexing/watch/service/security/embedding
  | value was dropped and the worker could not be updated at all.
  */
  it('SE-F-057: PATCH stores, returns and re-reads the full worker config', async () => {
    const edit = await request(port, 'PATCH', `/api/v1/gateway/projects/${idA}`, {
      token,
      body: {
        watch: false,
        indexing: { pretty: false, blueprint: true },
        watchOptions: { debounceMs: 900, blueprintMode: 'threshold' },
      },
    });
    expect(edit.status).toBe(200);
    const stored = edit.body['config'] as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect(stored['watch']).toBe(false);
    expect(stored['indexing']).toMatchObject({ pretty: false, blueprint: true });
    expect(stored['watchOptions']).toMatchObject({ debounceMs: 900, blueprintMode: 'threshold' });

    /* the reload reproduces the updated state from the detail route */
    const detail = await request(port, 'GET', `/api/v1/gateway/projects/${idA}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.body['config']).toMatchObject({
      watch: false,
      watchOptions: { debounceMs: 900 },
      indexing: { pretty: false },
    });

    /* a single-field edit preserves the unrelated fields already stored —
       the old payload silently reset them to defaults */
    const single = await request(port, 'PATCH', `/api/v1/gateway/projects/${idA}`, {
      token,
      body: { watchOptions: { debounceMs: 1500 } },
    });
    expect(single.status).toBe(200);
    const afterSingle = single.body['config'] as Record<string, unknown>;
    expect(afterSingle['watchOptions']).toMatchObject({ debounceMs: 1500 });
    expect(afterSingle['watch']).toBe(false); // unrelated watch must be preserved
    expect(afterSingle['indexing']).toMatchObject({ pretty: false, blueprint: true });

    /*
    | persistence is on DISK, not in memory: a fresh GatewayServer over the
    | same data root — exactly what hydration does after a restart — must
    | reproduce the stored config.
    */
    const reopened = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'second-instance',
      hydrateOnStart: false,
    });
    const durable = reopened.loadStoredWorkerConfig(idA);
    expect(durable).toBeDefined();
    expect(durable!.watch).toBe(false);
    expect(durable!.watchOptions.debounceMs).toBe(1500);
    expect(durable!.indexing.pretty).toBe(false);
  }, 300_000);

  it('SE-F-057: an invalid config edit is rejected and leaves the stored config intact', async () => {
    const before = await request(port, 'GET', `/api/v1/gateway/projects/${idA}`, { token });
    const goodConfig = before.body['config'];

    const rejected = await request(port, 'PATCH', `/api/v1/gateway/projects/${idA}`, {
      token,
      body: { watchOptions: { debounceMs: 5 } }, // below the 25ms floor
    });
    expect(rejected.status).toBe(400);
    expect(String(rejected.body['error'])).toMatch(/debounceMs/);

    const after = await request(port, 'GET', `/api/v1/gateway/projects/${idA}`, { token });
    expect(after.body['config']).toEqual(goodConfig);
  }, 300_000);

  it('SE-F-057: a secret in the body is refused, never stored', async () => {
    const rejected = await request(port, 'PATCH', `/api/v1/gateway/projects/${idA}`, {
      token,
      body: { apiKey: 'sk-live-123' },
    });
    expect(rejected.status).toBe(400);
    expect(String(rejected.body['error'])).toMatch(/secret/);
  }, 300_000);

  it('SE-F-057: an attempted identity change (path/id) is refused, not silently dropped', async () => {
    const rejected = await request(port, 'PATCH', `/api/v1/gateway/projects/${idA}`, {
      token,
      body: { path: '/somewhere/else' },
    });
    expect(rejected.status).toBe(400);
    expect(String(rejected.body['error'])).toMatch(/not patchable/);

    /* the refusal must be side-effect-free: the project is still itself */
    const detail = await request(port, 'GET', `/api/v1/gateway/projects/${idA}`, { token });
    expect(detail.body['rootPath']).toBe(rootA);
  }, 300_000);

  it('SE-F-057: an invalid-config CREATE rolls back — no half-created project', async () => {
    const rootC = makeProject('app-c', 'gamma');
    const rejected = await request(port, 'POST', '/api/v1/gateway/projects', {
      token,
      body: { path: rootC, name: 'App C', watchOptions: { debounceMs: 5 } },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body['project']).toBeUndefined();

    /* the root must not be registered as a side effect of the rejected create */
    const list = await request(port, 'GET', '/api/v1/gateway/projects', { token });
    const ids = (list.body['projects'] as { id: string; rootPath: string }[]).map(p => p.rootPath);
    expect(ids).not.toContain(rootC);
  }, 300_000);
});
