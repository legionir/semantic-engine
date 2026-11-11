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

  it('serves the shared fetch wrapper every page loads', async () => {
    const script = await get(port, '/api.js');
    expect(script.status).toBe(200);
    expect(script.text).toContain('makeApi');
    for (const page of ['/gateway', '/open']) {
      expect((await get(port, page)).text).toContain('/api.js');
    }
  });

  describe('POST /api/v1/gateway/command-preview', () => {
    const post = (body: unknown, bearer?: string) =>
      fetch(`http://127.0.0.1:${port}/api/v1/gateway/command-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      });

    const config = {
      projectId: 'prj-app-12345678',
      rootPath: '/srv/my app',
      dataDir: '/srv/data',
      indexing: { vectors: true },
      watchOptions: { debounceMs: 250, blueprintMode: 'threshold' },
      security: { gatewayManaged: true, tokenEnvVar: 'SE_TOKEN' },
      embedding: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'm' },
    };

    it('returns the command the supervisor would spawn', async () => {
      const reply = await post(config, token);
      expect(reply.status).toBe(200);
      const { preview } = (await reply.json()) as { preview: string };

      expect(preview.startsWith('semantic-engine worker ')).toBe(true);
      expect(preview).toContain('--project-id prj-app-12345678');
      expect(preview).toContain("--root '/srv/my app'");
      expect(preview).toContain('--data-dir /srv/data');
      expect(preview).toContain('--vectors');
      expect(preview).toContain('--debounce 250');
      expect(preview).toContain('--blueprint-mode threshold');
      expect(preview).toContain('--gateway-managed');
      expect(preview).toContain('--embedding-provider ollama');
      /* a secret is never part of it, only flags */
      expect(preview).not.toContain('SE_TOKEN');
      for (const part of preview.split(' ')) {
        if (part.startsWith('--')) expect(part).toMatch(/^--[a-z0-9-]+$/);
      }
    });

    it('sends no embedding flags while vectors are off', async () => {
      const reply = await post({ ...config, indexing: { vectors: false } }, token);
      const { preview } = (await reply.json()) as { preview: string };
      expect(preview).toContain('--no-vectors');
      expect(preview).not.toContain('--embedding-');
    });

    it('answers 400 for a config that cannot be a command, and 401 without a token', async () => {
      expect((await post({ projectId: '../etc', rootPath: '/srv/app' }, token)).status).toBe(400);
      expect((await post(config)).status).toBe(401);
    });
  });
});
