/**
 * MCP through the Gateway — فاز ۱۰, measured end to end.
 *
 * Two projects whose directories share a name, two workers, one public port.
 * The criteria: `tools/list` and `tools/call` answer per project, the answers
 * carry `projectId` and `indexGeneration`, and nothing crosses over.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { GatewayServer } from './GatewayServer';
import { PROJECT_ID_HEADER } from './GatewayProxy';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

interface RpcReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: Record<string, unknown> | null;
  text: string;
}

function rpc(
  port: number,
  urlPath: string,
  body: Record<string, unknown>,
  token?: string
): Promise<RpcReply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json, text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: parseMaybeSse(text),
            text,
          });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** پاسخ ممکن است JSON باشد یا یک فریم SSE؛ هر دو یک payload دارند. */
function parseMaybeSse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) {
      try {
        return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      } catch {
        /* فریم بعدی */
      }
    }
  }
  return null;
}

describeIfBuilt('MCP through the Gateway', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;
  let idA: string;
  let idB: string;

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-mcp-gateway-')));

    /* دو پروژه با basename یکسان و symbolهای متفاوت. */
    const make = (client: string, symbol: string): string => {
      const root = path.join(base, client, 'app');
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'src', 'a.ts'),
        `export function ${symbol}(): number { return 1; }\n`
      );
      return root;
    };
    const rootA = make('client-a', 'alphaOnly');
    const rootB = make('client-b', 'betaOnly');

    gateway = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'gateway-mcp-token',
    });
    const info = await gateway.start();
    port = info.port;
    token = info.token;

    for (const root of [rootA, rootB]) {
      const registered = gateway.registry.register({ rootPath: root });
      await gateway.supervisor.start(
        gateway.configForProject(registered.id, registered.rootPath, registered.name)
      );
      if (root === rootA) idA = registered.id;
      else idB = registered.id;
    }
  }, 300_000);

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('lists tools for each project', async () => {
    const reply = await rpc(port, `/mcp/${idA}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }, token);

    expect(reply.status).toBe(200);
    const result = reply.json?.['result'] as { tools?: { name: string }[] };
    expect(Array.isArray(result?.tools)).toBe(true);
    const names = (result?.tools ?? []).map(tool => tool.name);
    expect(names).toContain('find_symbol');
    expect(reply.headers[PROJECT_ID_HEADER]).toBe(idA);
  });

  it('answers a tool call with that project’s own symbols', async () => {
    const callA = await rpc(
      port,
      `/mcp/${idA}`,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'find_symbol', arguments: { name: 'alphaOnly' } },
      },
      token
    );
    const callB = await rpc(
      port,
      `/mcp/${idB}`,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'find_symbol', arguments: { name: 'betaOnly' } },
      },
      token
    );

    expect(callA.status).toBe(200);
    expect(callB.status).toBe(200);

    const structuredA = callA.json?.['result'] as { structuredContent?: Record<string, unknown> };
    const structuredB = callB.json?.['result'] as { structuredContent?: Record<string, unknown> };

    expect(structuredA?.structuredContent?.['projectId']).toBe(idA);
    expect(structuredB?.structuredContent?.['projectId']).toBe(idB);
    expect(typeof structuredA?.structuredContent?.['indexGeneration']).toBe('number');

    /* آلودگی متقاطع: symbol پروژهٔ B در پاسخ A نیست و برعکس. */
    expect(callA.text).toContain('alphaOnly');
    expect(callA.text).not.toContain('betaOnly');
    expect(callB.text).toContain('betaOnly');
    expect(callB.text).not.toContain('alphaOnly');

    expect(callA.headers[PROJECT_ID_HEADER]).toBe(idA);
    expect(callB.headers[PROJECT_ID_HEADER]).toBe(idB);
  });

  it('refuses an unknown project and a missing token', async () => {
    const unknown = await rpc(port, '/mcp/prj-nope-00000000', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: {},
    }, token);
    expect(unknown.status).toBe(404);

    const anonymous = await rpc(port, `/mcp/${idA}`, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
      params: {},
    });
    expect(anonymous.status).toBe(401);
  });
});
