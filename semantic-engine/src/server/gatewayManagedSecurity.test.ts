/**
 * فاز ۶ — the managed-worker security profile, measured.
 *
 * Every case here was a real gap before this phase:
 *
 *   - a Unix-socket request was refused with 403 because
 *     `socket.remoteAddress` is `undefined` on a socket, so the transport the
 *     architecture depends on could not carry a single request;
 *   - a proxied request was refused with 403 because the browser `Origin` is
 *     not loopback, and the worker judged it as if it faced the internet;
 *   - `POST /api/v1/projects` accepted any path, and `/api/v1/fs/browse`
 *     listed any directory on the machine;
 *   - `/health`, `/ready`, `/metrics`, `/api/v1/roles` and
 *     `/api/v1/auth/verify` were reachable with no token at all.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';
import { SecurityPipeline } from './SecurityPipeline';
import { socketEndpoint } from './socketEndpoint';

const TOKEN = 'internal-worker-token';

function makeWorkspace(): { base: string; workspace: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-managed-')));
  const workspace = path.join(base, 'app');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  return { base, workspace };
}

interface Response {
  status: number;
  json: unknown;
  text: string;
}

function requestViaSocket(
  socketPath: string,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: unknown
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: socketEndpoint(socketPath),
        path: urlPath,
        method,
        headers: {
          ...headers,
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
          let json: unknown = null;
          try {
            json = text === '' ? null : JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function requestViaTcp(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: null, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fakeRequest(options: {
  remoteAddress?: string;
  origin?: string;
  forwarded?: boolean;
}): http.IncomingMessage {
  const headers: Record<string, string> = {};
  if (options.origin) headers['origin'] = options.origin;
  if (options.forwarded) headers['x-forwarded-for'] = '203.0.113.7';
  return {
    socket: { remoteAddress: options.remoteAddress },
    headers,
  } as unknown as http.IncomingMessage;
}

describe('SecurityPipeline — transport and origin rules', () => {
  it('accepts a Unix-socket connection only when the server listens on a socket', () => {
    const onSocket = new SecurityPipeline({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      socketPath: '/run/semantic-engine/app.sock',
    });
    expect(onSocket.checkConnection(fakeRequest({ remoteAddress: undefined })).ok).toBe(true);

    const onTcp = new SecurityPipeline({ port: 0, host: '127.0.0.1', token: TOKEN });
    const refused = onTcp.checkConnection(fakeRequest({ remoteAddress: undefined }));
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(403);
  });

  it('keeps the TCP rules exactly as they were', () => {
    const pipeline = new SecurityPipeline({ port: 0, host: '127.0.0.1', token: TOKEN });

    expect(pipeline.checkConnection(fakeRequest({ remoteAddress: '127.0.0.1' })).ok).toBe(true);
    expect(pipeline.checkConnection(fakeRequest({ remoteAddress: '::1' })).ok).toBe(true);

    const remote = pipeline.checkConnection(fakeRequest({ remoteAddress: '203.0.113.9' }));
    expect(remote.ok).toBe(false);
    expect(remote.status).toBe(403);
  });

  it('trusts the Gateway only when the request actually came through it', () => {
    const managed = new SecurityPipeline({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      gatewayManaged: true,
    });

    /* A proxied request: the Gateway stripped Origin and set X-Forwarded-*. */
    expect(
      managed.checkOrigin(fakeRequest({ origin: 'https://gateway.example', forwarded: true })).ok
    ).toBe(true);

    /* A direct request from a browser page: no forwarding headers. */
    const direct = managed.checkOrigin(
      fakeRequest({ origin: 'https://attacker.example', forwarded: false })
    );
    expect(direct.ok).toBe(false);
    expect(direct.status).toBe(403);
  });

  it('leaves the standalone origin rule untouched', () => {
    const standalone = new SecurityPipeline({ port: 0, host: '127.0.0.1', token: TOKEN });

    expect(standalone.checkOrigin(fakeRequest({ origin: 'http://127.0.0.1:4000' })).ok).toBe(true);
    expect(standalone.checkOrigin(fakeRequest({ origin: 'https://attacker.example' })).ok).toBe(false);
    /* No Origin at all means a non-browser client, judged by its token. */
    expect(standalone.checkOrigin(fakeRequest({})).ok).toBe(true);
  });
});

describe('gateway-managed worker — no unauthenticated or cross-project surface', () => {
  let server: HttpServer;
  let socketPath: string;
  let workspace: string;
  let base: string;

  beforeEach(async () => {
    ({ base, workspace } = makeWorkspace());
    socketPath = path.join(base, 'run', 'app.sock');

    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      projectsRoot: workspace,
      dataRoot: path.join(base, 'data'),
      gatewayManaged: true,
      socketPath,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('serves a request that arrives over the Unix socket with the internal token', async () => {
    const res = await requestViaSocket(socketPath, 'GET', '/api/v1/projects', {
      Authorization: `Bearer ${TOKEN}`,
      'X-Forwarded-For': '203.0.113.7',
      'X-Forwarded-Proto': 'https',
    });

    expect(res.status).toBe(200);
  });

  it('refuses the same socket request without the token', async () => {
    const res = await requestViaSocket(socketPath, 'GET', '/api/v1/projects', {
      'X-Forwarded-For': '203.0.113.7',
    });

    expect(res.status).toBe(401);
  });

  it('has no unauthenticated route left', async () => {
    /* These five are `requireAuth: false` in standalone mode. */
    const openRoutes: { method: string; path: string; body?: unknown }[] = [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/ready' },
      { method: 'GET', path: '/metrics' },
      { method: 'GET', path: '/api/v1/roles' },
      { method: 'POST', path: '/api/v1/auth/verify', body: { token: 'whatever' } },
    ];

    for (const route of openRoutes) {
      const res = await requestViaSocket(
        socketPath,
        route.method,
        route.path,
        {
          'X-Forwarded-For': '203.0.113.7',
          ...(route.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        route.body
      );
      expect(`${route.method} ${route.path} -> ${res.status}`).toBe(
        `${route.method} ${route.path} -> 401`
      );
    }

    /* …and they still work for the Gateway, which carries the token. */
    const health = await requestViaSocket(socketPath, 'GET', '/health', {
      Authorization: `Bearer ${TOKEN}`,
      'X-Forwarded-For': '203.0.113.7',
    });
    expect(health.status).toBe(200);
  });

  it('closes the registry routes', async () => {
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'X-Forwarded-For': '203.0.113.7',
      'Content-Type': 'application/json',
    };

    const created = await requestViaSocket(
      socketPath,
      'POST',
      '/api/v1/projects',
      headers,
      { path: base, name: 'Other' }
    );
    expect(created.status).toBe(403);
    expect(created.text).toMatch(/gateway-managed worker/);

    const deleted = await requestViaSocket(
      socketPath,
      'DELETE',
      '/api/v1/projects/prj-app-00000000',
      headers
    );
    expect(deleted.status).toBe(403);

    /* Reading the list stays available: the Gateway needs it. */
    const list = await requestViaSocket(socketPath, 'GET', '/api/v1/projects', {
      Authorization: `Bearer ${TOKEN}`,
      'X-Forwarded-For': '203.0.113.7',
    });
    expect(list.status).toBe(200);
  });

  it('confines fs/browse to the workspace subtree', async () => {
    const headers = { Authorization: `Bearer ${TOKEN}`, 'X-Forwarded-For': '203.0.113.7' };

    const inside = await requestViaSocket(
      socketPath,
      'GET',
      `/api/v1/fs/browse?path=${encodeURIComponent(path.join(workspace, 'src'))}`,
      headers
    );
    expect(inside.status).toBe(200);

    /*
    | «بیرون از workspace» باید رد شود. `/etc` روی ویندوز وجود ندارد،
    | پس 404 می‌دهد و چیزی اثبات نمی‌کند؛ اینجا از پوشهٔ موقتِ سیستم
    | استفاده می‌شود که روی هر دو پلتفرم هست و از workspace بیرون است.
    */
    const outside = await requestViaSocket(
      socketPath,
      'GET',
      `/api/v1/fs/browse?path=${encodeURIComponent(fs.realpathSync(os.tmpdir()))}`,
      headers
    );
    expect(outside.status).toBe(403);

    /*
    | SE-SEC-08 — پاسخِ «پیدا نشد» نباید ریشهٔ سرور یا home کاربر را
    | لو بدهد. پیش از این رفع، مسیرِ بیرونِ workspace که وجود هم نداشت
    | 404 با `cwd` و `home` برمی‌گرداند — یعنی یک پرس‌وجوی ساده،
    | نامِ کاربر و محلِ نصب را افشا می‌کرد.
    */
    expect(String(outside.text)).not.toContain(os.homedir());

    const missingInside = await requestViaSocket(
      socketPath,
      'GET',
      `/api/v1/fs/browse?path=${encodeURIComponent(path.join(workspace, 'nope'))}`,
      headers
    );
    expect(missingInside.status).toBe(404);
    expect(String(missingInside.text)).not.toContain(os.homedir());

    /*
    | یک symlink که از subtree بیرون می‌زند هم گرفته می‌شود.
    | هدفِ `/etc` روی ویندوز وجود ندارد، پس چکِ presence اول کار
    | 404 می‌داد و مسیرِ realpath تست نمی‌شد؛ اینجا پوشه‌ای واقعی
    | بیرونِ workspace انتخاب می‌شود که روی هر دو پلتفرم هست.
    */
    const link = path.join(workspace, 'escape');
    fs.symlinkSync(fs.realpathSync(os.tmpdir()), link, 'dir');
    const viaLink = await requestViaSocket(
      socketPath,
      'GET',
      `/api/v1/fs/browse?path=${encodeURIComponent(link)}`,
      headers
    );
    expect(viaLink.status).toBe(403);
  });

  it('rejects a body that carries a foreign path', async () => {
    server.addRoute({
      method: 'POST',
      pattern: '/api/v1/test/echo',
      handler: async ctx => ({ status: 200, json: ctx.body }),
    });

    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'X-Forwarded-For': '203.0.113.7',
      'Content-Type': 'application/json',
    };

    const foreign = await requestViaSocket(socketPath, 'POST', '/api/v1/test/echo', headers, {
      rootPath: '/etc',
    });
    expect(foreign.status).toBe(403);
    expect(foreign.text).toMatch(/workspace root/);

    const own = await requestViaSocket(socketPath, 'POST', '/api/v1/test/echo', headers, {
      rootPath: workspace,
    });
    expect(own.status).toBe(200);
  });

  it('refuses a direct browser request that did not come through the Gateway', async () => {
    /* Standalone rules still judge the Origin when nothing claims a proxy. */
    const standalone = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      projectsRoot: workspace,
    });
    const info = await standalone.start();
    try {
      const res = await requestViaTcp(info.port, 'GET', '/health', {
        Origin: 'https://attacker.example',
      });
      expect(res.status).toBe(403);

      const clean = await requestViaTcp(info.port, 'GET', '/health', {});
      expect(clean.status).toBe(200);
    } finally {
      await standalone.stop();
    }
  });
});

describe('standalone worker — behaviour is unchanged', () => {
  let server: HttpServer;
  let port: number;
  let base: string;
  let workspace: string;

  beforeEach(async () => {
    ({ base, workspace } = makeWorkspace());
    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      projectsRoot: workspace,
      dataRoot: path.join(base, 'data'),
    });
    port = (await server.start()).port;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps /health open and fs/browse free to roam', async () => {
    const health = await requestViaTcp(port, 'GET', '/health');
    expect(health.status).toBe(200);

    const outside = await requestViaTcp(
      port,
      'GET',
      `/api/v1/fs/browse?path=${encodeURIComponent(os.tmpdir())}`,
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(outside.status).toBe(200);
  });

  it('still registers a project through POST /api/v1/projects', async () => {
    const res = await new Promise<Response>((resolve, reject) => {
      const payload = JSON.stringify({ path: workspace, name: 'App' });
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/projects',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk as Buffer));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              json: null,
              text: Buffer.concat(chunks).toString('utf8'),
            })
          );
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    expect(res.status).toBe(201);
  });
});
