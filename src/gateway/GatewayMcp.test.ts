/**
 * The single all-projects MCP endpoint, the stable token, and the dashboard
 * routes added with it (logs, events, info, settings page).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { GatewayServer } from './GatewayServer';
import { parseRpcReply, resolveProject } from './GatewayMcp';
import { gatewayTokenPath, resolveGatewayToken } from './GatewayTokenStore';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

describe('resolveProject', () => {
  const projects = [
    { id: 'prj-app-1', name: 'App', rootPath: '/srv/client-a/app' },
    { id: 'prj-app-2', name: 'App', rootPath: '/srv/client-b/app' },
    { id: 'prj-site-3', name: 'Marketing', rootPath: '/srv/www' },
  ];

  it('matches an id, a name and a folder name, ignoring case', () => {
    expect(resolveProject(projects, 'PRJ-SITE-3')).toMatchObject({ id: 'prj-site-3' });
    expect(resolveProject(projects, 'marketing')).toMatchObject({ id: 'prj-site-3' });
    expect(resolveProject(projects, 'www')).toMatchObject({ id: 'prj-site-3' });
  });

  it('refuses an ambiguous name and lists the ids to use instead', () => {
    const result = resolveProject(projects, 'app');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('prj-app-1');
    expect((result as { error: string }).error).toContain('prj-app-2');
  });

  it('names the known projects when nothing matches', () => {
    const result = resolveProject(projects, 'nope') as { error: string };
    expect(result.error).toContain('unknown project "nope"');
    expect(result.error).toContain('prj-site-3');
  });
});

describe('parseRpcReply', () => {
  it('reads a plain JSON body and an SSE frame alike', () => {
    expect(parseRpcReply('{"id":1}')).toEqual({ id: 1 });
    expect(parseRpcReply('event: message\ndata: {"id":2}\n\n')).toEqual({ id: 2 });
    expect(parseRpcReply('')).toBeUndefined();
  });
});

describe('resolveGatewayToken', () => {
  let dataRoot: string;
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-gw-token-'));
  });
  afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

  it('generates once, then reuses the stored token', () => {
    const first = resolveGatewayToken({ dataRoot });
    const second = resolveGatewayToken({ dataRoot });
    expect(first.source).toBe('generated');
    expect(second.source).toBe('stored');
    expect(second.token).toBe(first.token);
    expect(fs.readFileSync(gatewayTokenPath(dataRoot), 'utf8').trim()).toBe(first.token);
  });

  it('prefers a provided token and does not store it', () => {
    const resolved = resolveGatewayToken({ dataRoot, provided: 'pinned-token-value' });
    expect(resolved).toEqual({ token: 'pinned-token-value', source: 'provided' });
    expect(fs.existsSync(gatewayTokenPath(dataRoot))).toBe(false);
  });

  it('replaces the stored token only when asked to rotate', () => {
    const first = resolveGatewayToken({ dataRoot });
    const rotated = resolveGatewayToken({ dataRoot, rotate: true });
    expect(rotated.source).toBe('rotated');
    expect(rotated.token).not.toBe(first.token);
    expect(resolveGatewayToken({ dataRoot }).token).toBe(rotated.token);
  });
});

interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

function request(port: number, method: string, urlPath: string, token?: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          Accept: 'application/json, text/event-stream',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null = null;
          try {
            json = parseRpcReply(text) ?? null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describeIfBuilt('all-projects MCP endpoint through the Gateway', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;
  let idAlpha: string;
  let idBeta: string;

  const call = (name: string, args: Record<string, unknown>, auth: string | undefined = token) =>
    request(port, 'POST', '/mcp', auth, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name, arguments: args },
    });

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gw-all-mcp-')));
    const make = (folder: string, symbol: string): string => {
      const root = path.join(base, folder);
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), `export function ${symbol}(): number { return 1; }\n`);
      return root;
    };
    const rootAlpha = make('alpha-shop', 'alphaOnly');
    const rootBeta = make('beta-blog', 'betaOnly');

    gateway = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'gateway-all-mcp-token',
    });
    const info = await gateway.start();
    port = info.port;
    token = info.token;

    for (const [root, name] of [[rootAlpha, 'Alpha Shop'], [rootBeta, 'Beta Blog']] as const) {
      const registered = gateway.registry.register({ rootPath: root, name });
      await gateway.supervisor.start(
        gateway.configForProject(registered.id, registered.rootPath, registered.name)
      );
      if (root === rootAlpha) idAlpha = registered.id;
      else idBeta = registered.id;
    }
  }, 300_000);

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('answers initialize as the gateway, with a version', async () => {
    const reply = await request(port, 'POST', '/mcp', token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    expect(reply.status).toBe(200);
    const result = reply.json?.['result'] as { serverInfo: { name: string; version: string } };
    expect(result.serverInfo.name).toBe('semantic-gateway');
    expect(result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists list_projects plus every project tool with a project argument', async () => {
    const reply = await request(port, 'POST', '/mcp', token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (reply.json?.['result'] as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
    const names = tools.map(tool => tool.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('find_symbol');
    const find = tools.find(tool => tool.name === 'find_symbol')!;
    expect(find.inputSchema.properties).toHaveProperty('project');
  });

  it('lists the projects through list_projects', async () => {
    const reply = await call('list_projects', {});
    const text = (reply.json?.['result'] as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain(idAlpha);
    expect(text).toContain('Beta Blog');
  });

  it('routes a call by project name, id or folder name and keeps the projects apart', async () => {
    const byName = await call('find_symbol', { project: 'Alpha Shop', name: 'alphaOnly' });
    const byId = await call('find_symbol', { project: idBeta, name: 'betaOnly' });
    const byFolder = await call('find_symbol', { project: 'beta-blog', name: 'betaOnly' });

    expect(byName.text).toContain('alphaOnly');
    expect(byName.text).not.toContain('betaOnly');
    expect(byId.text).toContain('betaOnly');
    expect(byFolder.text).toContain('betaOnly');
    expect(byFolder.text).not.toContain('alphaOnly');
  });

  it('asks for a project when several exist, and says which are unknown', async () => {
    const missing = await call('find_symbol', { name: 'alphaOnly' });
    expect(JSON.stringify(missing.json)).toContain('is required because this gateway serves 2 projects');

    const unknown = await call('find_symbol', { project: 'nothing', name: 'x' });
    expect(JSON.stringify(unknown.json)).toContain('unknown project');
  });

  it('accepts ?token= and refuses a missing token', async () => {
    const viaQuery = await request(port, 'POST', `/mcp?token=${token}`, undefined, {
      jsonrpc: '2.0',
      id: 3,
      method: 'ping',
    });
    expect(viaQuery.status).toBe(200);

    const anonymous = await request(port, 'POST', '/mcp', undefined, { jsonrpc: '2.0', id: 4, method: 'ping' });
    expect(anonymous.status).toBe(401);
  });

  it('opens /mcp/<name> as well as /mcp/<id>', async () => {
    const reply = await request(port, 'POST', '/mcp/beta-blog', token, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('find_symbol');
  });

  it('serves the settings page without a token, like the dashboard', async () => {
    const page = await request(port, 'GET', '/open.html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<html');
  });

  it('reports version and endpoints, but no secret, on /api/v1/gateway/info', async () => {
    const info = await request(port, 'GET', '/api/v1/gateway/info', token);
    expect(info.status).toBe(200);
    expect((info.json as { mcp: { url: string } }).mcp.url).toMatch(/\/mcp$/);
    expect(info.text).not.toContain(token);
  });

  it('serves a worker log tail and the recorded events', async () => {
    const logs = await request(port, 'GET', `/api/v1/gateway/projects/${idAlpha}/logs?lines=50`, token);
    expect(logs.status).toBe(200);
    expect(Array.isArray((logs.json as { lines: unknown[] }).lines)).toBe(true);

    const events = await request(port, 'GET', `/api/v1/gateway/projects/${idAlpha}/events`, token);
    expect(events.status).toBe(200);
    expect(Array.isArray((events.json as { events: unknown[] }).events)).toBe(true);

    const unknown = await request(port, 'GET', '/api/v1/gateway/projects/nope/logs', token);
    expect(unknown.status).toBe(404);
  });
});
