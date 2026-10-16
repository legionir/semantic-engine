/**
 * فاز ۲ acceptance over the real HTTP server: registering two checkouts with
 * the same directory name must yield two projects through
 * `GET /api/v1/projects`, and the registry must live in the data root rather
 * than in either checkout.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';
import { REGISTRY_FILE } from '../core/config/ProjectRegistry';

const TOKEN = 'test-registry-token';

function makeProject(base: string, ...parts: string[]): string {
  const root = path.join(base, ...parts);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return fs.realpathSync(root);
}

describe('project registration over HTTP — no id collisions', () => {
  let server: HttpServer;
  let serverUrl: string;
  let base: string;
  let dataRoot: string;

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-registry-http-')));
    dataRoot = path.join(base, 'data');

    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      projectsRoot: base,
      dataRoot,
    });
    serverUrl = (await server.start()).url;
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function request(
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const u = new URL(urlPath, serverUrl);
      const headers: http.OutgoingHttpHeaders = { Authorization: `Bearer ${TOKEN}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const req = http.request(u, { method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: text === '' ? null : JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('lists two projects whose directories share a name', async () => {
    const clientA = makeProject(base, 'client-a', 'app');
    const clientB = makeProject(base, 'client-b', 'app');

    const createdA = await request('POST', '/api/v1/projects', { path: clientA, name: 'app' });
    const createdB = await request('POST', '/api/v1/projects', { path: clientB, name: 'app' });

    expect(createdA.status).toBe(201);
    expect(createdB.status).toBe(201);
    expect(createdA.json.id).not.toBe(createdB.json.id);

    const listed = await request('GET', '/api/v1/projects');
    expect(listed.status).toBe(200);
    expect(listed.json.total).toBe(2);

    const ids = (listed.json.projects as { id: string }[]).map(project => project.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(expect.arrayContaining([createdA.json.id, createdB.json.id]));
  });

  it('returns the same project when the same root is registered again', async () => {
    const clientA = makeProject(base, 'client-a', 'app');
    const again = await request('POST', '/api/v1/projects', { path: clientA, name: 'app' });
    const listed = await request('GET', '/api/v1/projects');

    expect(again.status).toBe(201);
    expect(listed.json.total).toBe(2);
  });

  it('PATCH persists name/autoStart and DELETE removes the project durably', async () => {
    const root = makeProject(base, 'patch-delete', 'proj');
    const created = await request('POST', '/api/v1/projects', { path: root, name: 'before' });
    expect(created.status).toBe(201);
    const id = created.json.id as string;

    expect((await request('PATCH', `/api/v1/projects/${id}`, { autoStart: 'yes' })).status).toBe(400);

    const patched = await request('PATCH', `/api/v1/projects/${id}`, { name: 'after', autoStart: true });
    expect(patched.status).toBe(200);
    expect(patched.json.name).toBe('after');
    expect((await request('GET', `/api/v1/projects/${id}`)).json.name).toBe('after');

    const persisted = JSON.parse(fs.readFileSync(path.join(dataRoot, REGISTRY_FILE), 'utf8'));
    const list = Array.isArray(persisted) ? persisted : persisted.projects;
    const record = list.find((r: { id: string }) => r.id === id);
    expect(record.name).toBe('after');
    expect(record.autoStart).toBe(true);

    expect((await request('DELETE', `/api/v1/projects/${id}`)).status).toBe(200);
    expect((await request('GET', `/api/v1/projects/${id}`)).status).toBe(404);
    expect((await request('DELETE', `/api/v1/projects/${id}`)).status).toBe(404);
    const listed = await request('GET', '/api/v1/projects');
    expect((listed.json.projects as { id: string }[]).some(x => x.id === id)).toBe(false);
    expect(fs.readFileSync(path.join(dataRoot, REGISTRY_FILE), 'utf8')).not.toContain(id);
  });

  it('keeps the registry in the data root and the checkouts clean', async () => {
    expect(fs.existsSync(path.join(dataRoot, REGISTRY_FILE))).toBe(true);

    for (const workspace of [path.join(base, 'client-a', 'app'), path.join(base, 'client-b', 'app')]) {
      expect(fs.readdirSync(fs.realpathSync(workspace))).toEqual(['src']);
    }
  });

  it('answers 404 for an unknown project id', async () => {
    const missing = await request('GET', '/api/v1/projects/prj-does-not-exist-00000000');
    expect(missing.status).toBe(404);
  });
});
