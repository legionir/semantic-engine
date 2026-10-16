/**
 * Gateway console over HTTP — فاز ۱۲, measured.
 *
 * The console is served by the Gateway itself: the page, its assets, and the
 * project deep link. No worker is needed, which keeps this suite fast — the
 * data it renders comes from the same `/api/v1/gateway/*` routes tested in
 * فاز ۹.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { GatewayServer } from './GatewayServer';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
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
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Gateway console', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gw-ui-')));
    gateway = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'gateway-ui-token',
    });
    const info = await gateway.start();
    port = info.port;
    token = info.token;
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('serves the console page and its assets without a token', async () => {
    const page = await get(port, '/gateway');
    expect(page.status).toBe(200);
    expect(String(page.headers['content-type'])).toContain('text/html');
    expect(page.text).toContain('Semantic Gateway');
    expect(page.text).toContain('/gateway.js');

    const script = await get(port, '/gateway.js');
    expect(script.status).toBe(200);
    expect(String(script.headers['content-type'])).toContain('application/javascript');
    expect(script.text).toContain('WORKER_FORM_FIELDS');

    const style = await get(port, '/gateway.css');
    expect(style.status).toBe(200);
    expect(String(style.headers['content-type'])).toContain('text/css');
  });

  it('serves the project dashboard the console links to', async () => {
    const visualizer = await get(port, '/visualizer');
    expect(visualizer.status).toBe(200);
    expect(String(visualizer.headers['content-type'])).toContain('text/html');

    const visualizerScript = await get(port, '/visualizer.js');
    expect(visualizerScript.status).toBe(200);
    expect(visualizerScript.text).toContain('projectId');
  });

  it('redirects the deep link so a refresh keeps the project', async () => {
    const reply = await get(port, '/projects/prj-app-12345678');

    expect(reply.status).toBe(302);
    expect(reply.headers['location']).toBe('/visualizer?project=prj-app-12345678');
  });

  it('does not serve anything outside the asset directory', async () => {
    /* Neither the alias map nor the resolver reaches outside `public/`. */
    for (const urlPath of ['/package.json', '/../package.json', '/..%2fpackage.json', '/gateway.js/../../package.json']) {
      const reply = await get(port, urlPath, token);
      expect(`${urlPath} → ${reply.status}`).not.toContain('200');
      expect(reply.text).not.toContain('"@aicoder/semantic-engine"');
    }
  });

  it('keeps the data endpoints behind the token', async () => {
    const anonymous = await get(port, '/api/v1/gateway/projects');
    expect(anonymous.status).toBe(401);

    const authorized = await get(port, '/api/v1/gateway/projects', token);
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.text)).toHaveProperty('projects');
  });
});
