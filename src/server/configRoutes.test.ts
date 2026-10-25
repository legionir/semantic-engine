/**
 * Phase 2 / step 2: PATCH /api/v1/config must really change the runtime
 * config (or reject the request), never report a success that did nothing.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';

const TOKEN = 'test-config-token';

describe('PATCH /api/v1/config', () => {
  let server: HttpServer;
  let serverUrl: string;
  let base: string;

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-config-http-')));
    server = new HttpServer({ port: 0, host: '127.0.0.1', token: TOKEN, projectsRoot: base });
    serverUrl = (await server.start()).url;
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function request(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { Authorization: `Bearer ${TOKEN}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request(new URL(urlPath, serverUrl), { method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('applies maxBodyBytes to the runtime and GET reflects it', async () => {
    const patched = await request('PATCH', '/api/v1/config', { maxBodyBytes: 2048 });
    expect(patched.status).toBe(200);
    expect(patched.json.config.maxBodyBytes).toBe(2048);
    expect(patched.json.persisted).toBe(false);

    expect((await request('GET', '/api/v1/config')).json.maxBodyBytes).toBe(2048);

    // The server either answers 4xx or drops the socket when the body exceeds the limit.
    const oversized = await request('POST', '/api/v1/projects', { path: base, name: 'x'.repeat(4096) })
      .catch(() => ({ status: 0 }));
    expect(oversized.status === 0 || oversized.status >= 400).toBe(true);

    await request('PATCH', '/api/v1/config', { maxBodyBytes: 5 * 1024 * 1024 });
    const ok = await request('POST', '/api/v1/projects', { path: base, name: 'x'.repeat(4096) });
    expect(ok.status).toBeLessThan(400);
  });

  it('rejects 0, non-integers and wrong types instead of falling back to the default', async () => {
    for (const bad of [0, -1, 1.5, '10', null]) {
      const res = await request('PATCH', '/api/v1/config', { maxBodyBytes: bad });
      expect(res.status).toBe(400);
    }
    expect((await request('GET', '/api/v1/config')).json.maxBodyBytes).toBe(5 * 1024 * 1024);
  });

  it('rejects startup-only and unknown keys explicitly', async () => {
    expect((await request('PATCH', '/api/v1/config', { port: 1234 })).status).toBe(409);
    expect((await request('PATCH', '/api/v1/config', { nope: 1 })).status).toBe(400);
  });
});
