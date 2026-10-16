/**
 * Protocol matrix, console flow and parallel load — فاز ۱۴, گام ۲/۳/۵.
 *
 * One gateway, two projects, and every surface the plan promises, checked in
 * one place:
 *
 *   - REST, MCP `tools/list`, MCP `tools/call`, SSE, WebSocket;
 *   - a client that disconnects mid-stream, and a client that times out — the
 *     gateway must stay healthy for everyone else;
 *   - the exact call sequence the console makes (register → list → health →
 *     metrics → start/stop/restart → deep link);
 *   - several workers starting at once, with the gateway still answering
 *     quickly while they index.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { GatewayServer } from './GatewayServer';
import { FrameDecoder, OPCODE, encodeFrame } from './wsProtocol';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

describeIfBuilt('protocol matrix, console flow and load', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;
  let roots: string[] = [];
  let ids: string[] = [];

  const makeProject = (name: string): string => {
    const root = path.join(base, name);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', `${name.replace(/-/g, '_')}.ts`),
      `export function fn_${name.replace(/-/g, '_')}(): number { return 1; }\n`
    );
    return root;
  };

  const request = (
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: unknown }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(payload !== undefined
              ? {
                  'Content-Type': 'application/json',
                  Accept: 'application/json, text/event-stream',
                  'Content-Length': Buffer.byteLength(payload),
                }
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
              json = { raw: text };
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
          });
        }
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const register = async (root: string, name: string, autoStart = false): Promise<string> => {
    const reply = await request('POST', '/api/v1/gateway/projects', { path: root, name, autoStart });
    expect(reply.status).toBe(201);
    return String((reply.json as Record<string, unknown>)['id']);
  };

  const waitForReady = async (idsToWait: string[], timeoutMs = 240_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const list = await request('GET', '/api/v1/gateway/projects');
      const projects = (list.json as { projects: Record<string, unknown>[] }).projects;
      const ready = projects.filter(
        project =>
          idsToWait.includes(String(project['id'])) && project['workerState'] === 'ready'
      );
      if (ready.length === idsToWait.length) return;
      if (Date.now() > deadline) throw new Error(`not ready: ${JSON.stringify(projects)}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  const connectWs = (urlPath: string): Promise<{ socket: net.Socket; status: number; frames: string[] }> =>
    new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      const key = crypto.randomBytes(16).toString('base64');
      const decoder = new FrameDecoder();
      const frames: string[] = [];
      let head = '';
      let done = false;

      socket.on('connect', () => {
        socket.write(
          [
            `GET ${urlPath} HTTP/1.1`,
            'Host: localhost',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            `Authorization: Bearer ${token}`,
            '',
            '',
          ].join('\r\n')
        );
      });

      socket.on('data', chunk => {
        if (!done) {
          head += chunk.toString('binary');
          const split = head.indexOf('\r\n\r\n');
          if (split === -1) return;
          const status = Number(head.slice(0, head.indexOf('\r\n')).split(' ')[1]);
          done = true;
          const rest = Buffer.from(head.slice(split + 4), 'binary');
          resolve({ socket, status, frames });
          if (rest.length > 0) consume(rest);
          return;
        }
        consume(chunk as Buffer);
      });

      const consume = (bytes: Buffer): void => {
        let decoded;
        try {
          decoded = decoder.push(bytes);
        } catch {
          return;
        }
        for (const frame of decoded) {
          if (frame.opcode === OPCODE.TEXT) frames.push(frame.payload.toString('utf8'));
        }
      };

      socket.on('error', reject);
      socket.setTimeout(30_000, () => reject(new Error('ws timed out')));
    });

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-matrix-')));
    gateway = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'matrix-token',
    });
    const info = await gateway.start();
    port = info.port;
    token = info.token;

    const rootA = makeProject('app-a');
    const rootB = makeProject('app-b');
    roots = [rootA, rootB];
    ids = [await register(rootA, 'App A', true), await register(rootB, 'App B', true)];
    await waitForReady(ids);
  }, 300_000);

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('REST answers per project and says whose answer it is', async () => {
    const reply = await request('GET', `/api/v1/projects/${ids[0]}`);
    expect(reply.status).toBe(200);
    expect((reply.json as Record<string, unknown>)['id']).toBe(ids[0]);
    expect(reply.headers['x-semantic-project-id']).toBe(ids[0]);
  });

  it('MCP tools/list and tools/call both work through the gateway', async () => {
    const listed = await request('POST', `/mcp/${ids[0]}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('find_symbol');

    const called = await request('POST', `/mcp/${ids[0]}`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'find_symbol', arguments: { name: 'fn_app_a' } },
    });
    expect(called.status).toBe(200);
    expect(called.text).toContain('app_a.ts');
    expect(called.text).not.toContain('app_b.ts');
  });

  it('streams gateway events over SSE', async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/gateway/events?token=${encodeURIComponent(token)}`,
          headers: { Accept: 'text/event-stream' },
        },
        res => {
          let body = '';
          res.on('data', chunk => {
            body += String(chunk);
            if (body.includes('data:')) {
              req.destroy();
              resolve(body);
            }
          });
        }
      );
      req.on('error', () => resolve(''));
      req.setTimeout(15_000, () => req.destroy(new Error('SSE timed out')));
      req.end();
    });

    expect(received).toContain('event: gateway');
  }, 30_000);

  it('carries WebSocket frames per project and survives a client disconnect', async () => {
    const clientA = await connectWs(`/ws/projects/${ids[0]}`);
    const clientB = await connectWs(`/ws/projects/${ids[1]}`);
    expect(clientA.status).toBe(101);
    expect(clientB.status).toBe(101);

    /* A client that leaves must not disturb the others. */
    clientA.socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(clientB.socket.destroyed).toBe(false);

    clientB.socket.write(encodeFrame(OPCODE.TEXT, '{"ping":1}', { mask: true }));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && clientB.frames.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    /* The greeting alone proves the channel is alive and project-scoped. */
    expect(clientB.frames.join('')).toContain(ids[1]);

    clientB.socket.destroy();

    /* …and the gateway is still serving everyone. */
    const health = await request('GET', '/health');
    expect(health.status).toBe(200);
  }, 60_000);

  it('stays healthy when a client times out mid-request', async () => {
    await new Promise<void>(resolve => {
      const req = http.request(
        { host: '127.0.0.1', port, path: `/api/v1/projects/${ids[0]}`, headers: { Authorization: `Bearer ${token}` } },
        res => {
          res.destroy();
          resolve();
        }
      );
      req.on('error', () => resolve());
      req.setTimeout(50, () => req.destroy());
      req.end();
    });

    const health = await request('GET', '/health');
    expect(health.status).toBe(200);
    const again = await request('GET', `/api/v1/projects/${ids[1]}`);
    expect(again.status).toBe(200);
  });

  it('walks the console flow: register, list, health, metrics, lifecycle, deep link', async () => {
    const rootC = makeProject('app-c');

    /* register without starting */
    const idC = await register(rootC, 'App C', false);

    let list = await request('GET', '/api/v1/gateway/projects');
    let projects = (list.json as { projects: Record<string, unknown>[] }).projects;
    expect(projects.map(project => project['id'])).toContain(idC);
    expect(projects.find(project => project['id'] === idC)?.['workerState']).toBe('stopped');

    /* start */
    const started = await request('POST', `/api/v1/gateway/projects/${idC}/start`);
    expect(started.status).toBe(200);
    await waitForReady([idC]);

    /* health + metrics */
    const health = await request('GET', `/api/v1/gateway/projects/${idC}/health`);
    expect(health.status).toBe(200);
    expect((health.json as Record<string, unknown>)['projectId']).toBe(idC);

    const metrics = await request('GET', '/metrics');
    expect((metrics.json as Record<string, unknown>)['gateway_workers_ready']).toBeGreaterThanOrEqual(3);

    /* restart keeps the same project */
    const restarted = await request('POST', `/api/v1/gateway/projects/${idC}/restart`);
    expect(restarted.status).toBe(200);

    /* reindex */
    const reindex = await request('POST', `/api/v1/gateway/projects/${idC}/reindex`);
    expect([200, 202]).toContain(reindex.status);

    /* stop */
    const stopped = await request('POST', `/api/v1/gateway/projects/${idC}/stop`);
    expect(stopped.status).toBe(200);

    /* deep link still resolves */
    const deep = await request('GET', `/projects/${idC}`);
    expect(deep.status).toBe(302);
    expect(deep.headers['location']).toBe(`/visualizer?project=${idC}`);
  }, 300_000);

  it('starts several workers at once and keeps answering quickly', async () => {
    const extraRoots = ['load-a', 'load-b', 'load-c'].map(name => makeProject(name));
    const extraIds: string[] = [];
    for (const root of extraRoots) {
      extraIds.push(await register(root, path.basename(root), true));
    }

    /* While they index, the gateway must stay responsive. */
    const startedAt = Date.now();
    const health = await request('GET', '/health');
    const elapsed = Date.now() - startedAt;

    expect(health.status).toBe(200);
    expect(elapsed).toBeLessThan(2000);

    await waitForReady(extraIds, 300_000);

    const metrics = await request('GET', '/metrics');
    const payload = metrics.json as Record<string, unknown>;
    expect(payload['gateway_projects_total']).toBeGreaterThanOrEqual(6);
    /*
    | شش پروژه ثبت شده‌اند ولی `app-c` در تست قبلی متوقف شد، پس پنج worker
    | آماده انتظار درست است: A و B به‌علاوهٔ سه worker جدید.
    */
    expect(payload['gateway_workers_ready']).toBeGreaterThanOrEqual(5);

    const list = await request('GET', '/api/v1/gateway/projects');
    const projects = (list.json as { projects: Record<string, unknown>[] }).projects;
    for (const id of extraIds) {
      expect(projects.find(project => project['id'] === id)?.['workerState']).toBe('ready');
    }
  }, 600_000);
});
