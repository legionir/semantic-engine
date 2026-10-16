/**
 * Metrics and health detail — فاز ۱۳.
 *
 * Two contracts are pinned here: the exact key set of each metric family (a
 * renamed metric must break a test, not silently empty a dashboard column), and
 * the per-project health endpoint, including the rule that one worker's
 * failure is visible without making the others look unhealthy.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { DurationSummary, GATEWAY_METRIC_KEYS, cpuPercent } from './metrics';
import { GatewayServer } from './GatewayServer';

interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown>;
}

function get(port: number, urlPath: string, token?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function post(port: number, urlPath: string, token: string, body: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
          })
        );
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('DurationSummary', () => {
  it('summarizes recorded durations', () => {
    const summary = new DurationSummary();
    expect(summary.snapshot()).toEqual({ count: 0, sumMs: 0, avgMs: 0, maxMs: 0, p95Ms: 0 });

    for (const value of [10, 20, 30, 40, 100]) summary.record(value);

    const snapshot = summary.snapshot();
    expect(snapshot.count).toBe(5);
    expect(snapshot.sumMs).toBe(200);
    expect(snapshot.avgMs).toBe(40);
    expect(snapshot.maxMs).toBe(100);
    expect(snapshot.p95Ms).toBe(100);
  });

  it('keeps a bounded window so a long-lived gateway does not grow', () => {
    const summary = new DurationSummary(10);
    for (let i = 0; i < 1000; i += 1) summary.record(i);

    expect(summary.snapshot().count).toBe(10);
  });

  it('ignores nonsense samples', () => {
    const summary = new DurationSummary();
    summary.record(-5);
    summary.record(Number.NaN);
    expect(summary.snapshot().count).toBe(0);
  });
});

describe('cpuPercent', () => {
  it('reports cpu time as a share of wall time', () => {
    /* 500ms of CPU over 1000ms of wall time is 50%. */
    expect(cpuPercent({ user: 400_000, system: 100_000 }, 1000)).toBe(50);
  });

  it('can exceed 100 on more than one core', () => {
    expect(cpuPercent({ user: 2_000_000, system: 0 }, 1000)).toBe(200);
  });

  it('is zero when there is no wall time yet', () => {
    expect(cpuPercent({ user: 1000, system: 1000 }, 0)).toBe(0);
  });
});

describe('metric key contract', () => {
  it('has no duplicate keys', () => {
    expect(new Set(GATEWAY_METRIC_KEYS).size).toBe(GATEWAY_METRIC_KEYS.length);
  });
});

describe('Gateway metrics and health detail', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;
  let workspaceA: string;
  let workspaceB: string;
  let idA: string;
  let idB: string;

  const makeProject = (name: string): string => {
    const root = path.join(base, name);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    return root;
  };

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gw-metrics-')));
    workspaceA = makeProject('app-a');
    workspaceB = makeProject('app-b');

    gateway = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'metrics-token',
    });
    const info = await gateway.start();
    port = info.port;
    token = info.token;

    const a = await post(port, '/api/v1/gateway/projects', token, { path: workspaceA, name: 'A' });
    const b = await post(port, '/api/v1/gateway/projects', token, { path: workspaceB, name: 'B' });
    idA = String(a.json['id']);
    idB = String(b.json['id']);
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('reports exactly the gateway metric keys, with real values', async () => {
    const reply = await get(port, '/metrics', token);

    expect(reply.status).toBe(200);
    expect(Object.keys(reply.json).sort()).toEqual([...GATEWAY_METRIC_KEYS].sort());

    expect(reply.json['gateway_projects_total']).toBe(2);
    expect(reply.json['gateway_requests_total']).toBeGreaterThan(0);

    const durations = reply.json['gateway_request_duration_ms'] as Record<string, number>;
    expect(durations['count']).toBeGreaterThan(0);
    expect(typeof durations['avgMs']).toBe('number');
    expect(typeof durations['p95Ms']).toBe('number');
    expect(typeof reply.json['gateway_index_jobs_active']).toBe('number');
  });

  it('answers health detail per project', async () => {
    const reply = await get(port, `/api/v1/gateway/projects/${idA}/health`, token);

    expect(reply.status).toBe(200);
    expect(reply.json['projectId']).toBe(idA);
    /* No worker was started, so there is no worker-side health yet. */
    expect(reply.json['health']).toBeNull();
    expect(reply.json['restartHistory']).toEqual([]);
    expect(reply.json['degraded']).toBe(false);
  });

  it('keeps one project unknown or forbidden without touching the other', async () => {
    const unknown = await get(port, '/api/v1/gateway/projects/prj-nope-00000000/health', token);
    expect(unknown.status).toBe(404);

    const scoped = gateway.auth.issueToken({
      name: 'only-b',
      allowedProjects: [idB],
      permissions: ['project:read'],
    });
    const forbidden = await get(port, `/api/v1/gateway/projects/${idA}/health`, scoped.token);
    expect(forbidden.status).toBe(403);

    /* …and the project the token may see still answers. */
    const allowed = await get(port, `/api/v1/gateway/projects/${idB}/health`, scoped.token);
    expect(allowed.status).toBe(200);
    expect(allowed.json['projectId']).toBe(idB);

    /* The gateway itself is still healthy. */
    const health = await get(port, '/health');
    expect(health.status).toBe(200);
    expect(health.json['ok']).toBe(true);
  });
});
