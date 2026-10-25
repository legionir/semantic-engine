/**
 * Phase 2 / step 1: persisted `autoStart` and startup hydration.
 *
 * Uses a stub supervisor (no worker processes, no Unix sockets) so the test is
 * platform independent; the supervisor contract is only `start/stop/...`.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { GatewayServer } from './GatewayServer';
import { ProjectRegistry } from '../core/config/ProjectRegistry';

function makeRoot(base: string, name: string): string {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return fs.realpathSync(root);
}

function makeStub() {
  const started: string[] = [];
  const stopped: string[] = [];
  const failFor = new Set<string>();
  const stub = {
    started,
    stopped,
    failFor,
    startHealthLoop() {},
    async stopAll() {},
    async start(config: { projectId: string }) {
      if (failFor.has(config.projectId)) throw new Error(`boom ${config.projectId}`);
      started.push(config.projectId);
      return {};
    },
    async stop(projectId: string) {
      stopped.push(projectId);
      return true;
    },
    list: () => [],
    get: () => undefined,
    isRunning: () => false,
    restartCount: () => 0,
    isDegraded: () => false,
    workerToken: () => undefined,
    diagnostics: () => ({}),
    /* SE-F-058 — the stats surface: no live worker in this stub, so no
       snapshot is ever available and refreshes are inert. */
    lastStatsObservedAt: () => undefined,
    recordStats: () => undefined,
    refreshStats: async () => undefined,
  };
  return stub;
}

function call(
  port: number,
  token: string,
  method: string,
  urlPath: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
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
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('Gateway startup hydration and durable autoStart', () => {
  let base: string;
  let dataRoot: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gw-hydrate-')));
    dataRoot = path.join(base, 'data');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('restores only enabled autoStart projects after a restart and isolates failures', async () => {
    const registry = new ProjectRegistry({ dataRoot });
    registry.register({ rootPath: makeRoot(base, 'a'), name: 'a', id: 'proj-a', autoStart: true });
    registry.register({ rootPath: makeRoot(base, 'b'), name: 'b', id: 'proj-b', autoStart: true });
    registry.register({ rootPath: makeRoot(base, 'c'), name: 'c', id: 'proj-c', autoStart: false });
    registry.register({ rootPath: makeRoot(base, 'd'), name: 'd', id: 'proj-d', autoStart: true, enabled: false });

    // "restart": a brand-new registry and gateway over the same data root.
    const stub = makeStub();
    stub.failFor.add('proj-b');
    const gateway = new GatewayServer({
      port: 0,
      dataRoot,
      registry: new ProjectRegistry({ dataRoot }),
      supervisor: stub as never,
      hydrateOnStart: false,
    });

    const result = await gateway.hydrateProjects();
    expect(result.started).toEqual(['proj-a']);
    expect(result.failed).toEqual([{ projectId: 'proj-b', error: 'boom proj-b' }]);
    expect(stub.started).toEqual(['proj-a']);
  });

  it('start() hydrates by default and honours hydrateOnStart:false', async () => {
    const registry = new ProjectRegistry({ dataRoot });
    registry.register({ rootPath: makeRoot(base, 'a'), name: 'a', id: 'proj-a', autoStart: true });

    const stubOn = makeStub();
    const on = new GatewayServer({ port: 0, dataRoot, registry, supervisor: stubOn as never });
    await on.start();
    expect(stubOn.started).toEqual(['proj-a']);
    await on.stop();

    const stubOff = makeStub();
    const off = new GatewayServer({ port: 0, dataRoot, registry, supervisor: stubOff as never, hydrateOnStart: false });
    await off.start();
    expect(stubOff.started).toEqual([]);
    await off.stop();
  });

  it('persists autoStart/enabled/name through the HTTP API and DELETE removes the record', async () => {
    const stub = makeStub();
    const gateway = new GatewayServer({ port: 0, dataRoot, supervisor: stub as never, hydrateOnStart: false });
    const info = await gateway.start();
    try {
      const created = await call(info.port, info.token, 'POST', '/api/v1/gateway/projects', {
        path: makeRoot(base, 'x'),
        name: 'x',
        id: 'proj-x',
        autoStart: true,
      });
      expect(created.status).toBe(201);
      expect(new ProjectRegistry({ dataRoot }).get('proj-x')?.autoStart).toBe(true);
      expect(stub.started).toEqual(['proj-x']);

      const bad = await call(info.port, info.token, 'PATCH', '/api/v1/gateway/projects/proj-x', { autoStart: 'yes' });
      expect(bad.status).toBe(400);

      const patched = await call(info.port, info.token, 'PATCH', '/api/v1/gateway/projects/proj-x', {
        name: 'renamed',
        autoStart: false,
        enabled: false,
      });
      expect(patched.status).toBe(200);
      expect(stub.stopped).toContain('proj-x'); // enabled:false stops the worker
      expect(new ProjectRegistry({ dataRoot }).get('proj-x')).toMatchObject({
        name: 'renamed',
        autoStart: false,
        enabled: false,
      });

      const removed = await call(info.port, info.token, 'DELETE', '/api/v1/gateway/projects/proj-x');
      expect(removed.status).toBe(200);
      expect(stub.stopped).toContain('proj-x');
      expect(new ProjectRegistry({ dataRoot }).get('proj-x')).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });
});
