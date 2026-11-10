/**
 * F-04 / F-05 — an unexpected failure is answered with a generic body (the
 * detail goes to stderr), a malformed %-escape is a 404 rather than a 500, and
 * every answer carries `Referrer-Policy: no-referrer`.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';

function rawGet(port: number, target: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method: 'GET', headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('platform server — failure bodies and headers', () => {
  let base: string;
  let server: HttpServer;
  let port: number;
  let stderr: jest.SpyInstance;

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-harden-')));
    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: 'hard-token',
      projectsRoot: base,
      dataRoot: path.join(base, 'data'),
    });
    server.addRoute({
      method: 'GET',
      pattern: '/api/v1/test/boom',
      requireAuth: false,
      handler: async () => {
        throw new Error(`cannot open ${base}/secret/file.txt`);
      },
    });
    server.addRoute({
      method: 'GET',
      pattern: '/api/v1/test/echo/:name',
      requireAuth: false,
      handler: async ctx => ({ status: 200, json: { name: ctx.params.name } }),
    });
    ({ port } = await server.start());
  });

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => stderr.mockRestore());

  afterAll(async () => {
    await server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('does not put the thrown message (a file path) into the 500 body, and logs it instead', async () => {
    const res = await rawGet(port, '/api/v1/test/boom');
    expect(res.status).toBe(500);
    const json = JSON.parse(res.body) as { error: string; requestId: string };
    expect(json.error).toBe('internal error');
    expect(json.requestId).toMatch(/^[0-9a-f]{12}$/);
    expect(res.body).not.toContain(base);

    const logged = stderr.mock.calls.map(call => String(call[0])).join('');
    expect(logged).toContain(json.requestId);
    expect(logged).toContain('secret/file.txt');
  });

  it('answers a malformed %-escape in a path parameter with 404, not 500', async () => {
    const res = await rawGet(port, '/api/v1/test/echo/%E0%A4%A');
    expect(res.status).toBe(404);
  });

  it('sets Referrer-Policy and no-store on API answers', async () => {
    const res = await rawGet(port, '/api/v1/test/echo/abc');
    expect(res.status).toBe(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-xss-protection']).toBeUndefined();
  });
});
