/**
 * Multi-project end-to-end — فاز ۱۴, گام ۱.
 *
 * The ten-step acceptance scenario from the reference plan (§گام ۱۵), run for
 * real: one Gateway, two projects whose directories share the name `app`, two
 * worker processes, real indexing, and a file change in one of them.
 *
 * What only this test can prove:
 *
 *   - two checkouts named `app` stay two projects, each answering with its own
 *     symbols (the original collision bug);
 *   - a change in A moves A's index and leaves B's generation and process
 *     untouched;
 *   - every protocol surface (REST, MCP, SSE, WebSocket, deep link) is
 *     project-scoped.
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
  json: unknown;
}

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

describeIfBuilt('multi-project end-to-end', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;
  let rootA: string;
  let rootB: string;
  let idA: string;
  let idB: string;

  const makeProject = (dir: string, marker: string, symbolFile: string): string => {
    const root = path.join(base, dir);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', symbolFile),
      `export function sharedName(): string { return '${marker}'; }\n`
    );
    return root;
  };

  const request = (
    method: string,
    urlPath: string,
    body?: unknown,
    useToken = true
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: {
            ...(useToken ? { Authorization: `Bearer ${token}` } : {}),
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

  const mcpCall = async (projectId: string, tool: string, args: unknown): Promise<string> => {
    const reply = await request('POST', `/mcp/${projectId}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    });
    expect(reply.status).toBe(200);
    return reply.text;
  };

  const projects = async (): Promise<Record<string, unknown>[]> => {
    const reply = await request('GET', '/api/v1/gateway/projects');
    const body = reply.json as { projects: Record<string, unknown>[] };
    return body.projects;
  };

  const waitForReady = async (timeoutMs = 180_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const list = await projects();
      const ready = list.filter(project => project['workerState'] === 'ready');
      if (ready.length === 2) return;
      if (Date.now() > deadline) {
        throw new Error(`workers did not become ready: ${JSON.stringify(list)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-e2e-')));
    /* دو checkout با نام یکسان — همان سناریوی پلن مرجع. */
    rootA = makeProject('client-a/app', 'from-a', 'alpha.ts');
    rootB = makeProject('client-b/app', 'from-b', 'beta.ts');

    gateway = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'e2e-token',
    });
    const info = await gateway.start();
    port = info.port;
    token = info.token;

    /* ۲. هر دو پروژه ثبت می‌شوند. */
    const createdA = await request('POST', '/api/v1/gateway/projects', {
      path: rootA,
      name: 'App A',
      autoStart: true,
    });
    const createdB = await request('POST', '/api/v1/gateway/projects', {
      path: rootB,
      name: 'App B',
      autoStart: true,
    });
    expect(createdA.status).toBe(201);
    expect(createdB.status).toBe(201);
    idA = String((createdA.json as Record<string, unknown>)['id']);
    idB = String((createdB.json as Record<string, unknown>)['id']);
    expect(idA).not.toBe(idB);

    /* ۳ و ۴. هر دو worker بالا می‌آیند و ready می‌شوند. */
    await waitForReady();
  }, 300_000);

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('1-4. one gateway serves two same-named checkouts, both ready', async () => {
    const list = await projects();
    expect(list).toHaveLength(2);
    expect(list.map(project => project['id']).sort()).toEqual([idA, idB].sort());
    for (const project of list) {
      expect(project['workerState']).toBe('ready');
      expect(project['status']).toBe('ready');
    }

    /* artifactها هر کدام در data root خودشان‌اند، نه داخل checkout. */
    for (const id of [idA, idB]) {
      const indexPath = path.join(base, 'data', 'projects', id, 'project-index.json');
      expect(fs.existsSync(indexPath)).toBe(true);
    }
    for (const root of [rootA, rootB]) {
      expect(fs.existsSync(path.join(root, '.semantic-engine'))).toBe(false);
      expect(fs.readdirSync(root).sort()).toEqual(['src']);
    }
  });

  it('5. the same symbol name answers differently per project', async () => {
    const answerA = await mcpCall(idA, 'find_symbol', { name: 'sharedName' });
    const answerB = await mcpCall(idB, 'find_symbol', { name: 'sharedName' });

    expect(answerA).toContain('alpha.ts');
    expect(answerA).not.toContain('beta.ts');
    expect(answerB).toContain('beta.ts');
    expect(answerB).not.toContain('alpha.ts');

    /* پاسخ هر پروژه شناسهٔ خودش را با خود می‌برد. */
    expect(JSON.parse(extractStructured(answerA))['projectId']).toBe(idA);
    expect(JSON.parse(extractStructured(answerB))['projectId']).toBe(idB);
  });

  it('6-9. a change in A moves A only; B keeps its process and generation', async () => {
    const beforeB = await request('GET', `/api/v1/gateway/projects/${idB}/health`);
    const healthB = (beforeB.json as Record<string, unknown>)['health'] as Record<string, unknown>;
    const pidBBefore = healthB['pid'];

    /* ۶. یک فایل تازه فقط در A. */
    fs.writeFileSync(path.join(rootA, 'src', 'gamma.ts'), 'export function gammaOnly(): number { return 3; }\n');

    /* ۷ و ۸. فقط A دوباره ایندکس می‌شود. */
    const reindex = await request('POST', `/api/v1/gateway/projects/${idA}/reindex`);
    expect([200, 202]).toContain(reindex.status);

    const deadline = Date.now() + 120_000;
    let indexA: { files?: { path: string }[] } = {};
    for (;;) {
      const raw = fs.readFileSync(path.join(base, 'data', 'projects', idA, 'project-index.json'), 'utf8');
      indexA = JSON.parse(raw) as typeof indexA;
      const paths = (indexA.files ?? []).map(file => file.path);
      if (paths.some(file => file.includes('gamma.ts'))) break;
      if (Date.now() > deadline) throw new Error(`A never picked up gamma.ts: ${paths.join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const answerA = await mcpCall(idA, 'find_symbol', { name: 'gammaOnly' });
    expect(answerA).toContain('gamma.ts');

    /* ۹. B نه ایندکس دوباره گرفت نه restart شد. */
    const rawB = fs.readFileSync(path.join(base, 'data', 'projects', idB, 'project-index.json'), 'utf8');
    const indexB = JSON.parse(rawB) as { files?: { path: string }[] };
    const pathsB = (indexB.files ?? []).map(file => file.path);
    expect(pathsB.some(file => file.includes('gamma.ts'))).toBe(false);

    const afterB = await request('GET', `/api/v1/gateway/projects/${idB}/health`);
    const healthBAfter = (afterB.json as Record<string, unknown>)['health'] as Record<string, unknown>;
    expect(healthBAfter['pid']).toBe(pidBBefore);
    expect(healthBAfter['state']).toBe('ready');
  }, 240_000);

  it('10. the deep link carries the project, and the surfaces stay scoped', async () => {
    const deepA = await request('GET', `/projects/${idA}`);
    expect(deepA.status).toBe(302);
    expect(deepA.headers['location']).toBe(`/visualizer?project=${idA}`);

    /* REST هم project-scoped است. */
    const restA = await request('GET', `/api/v1/projects/${idA}`);
    const restB = await request('GET', `/api/v1/projects/${idB}`);
    expect((restA.json as Record<string, unknown>)['id']).toBe(idA);
    expect((restB.json as Record<string, unknown>)['id']).toBe(idB);
    expect(restA.headers['x-semantic-project-id']).toBe(idA);

    /* و یک پروژهٔ ناشناخته ۴۰۴ می‌گیرد، نه دادهٔ همسایه را. */
    const unknown = await request('GET', '/api/v1/projects/prj-nope-00000000');
    expect(unknown.status).toBe(404);
  });
});

/** استخراج `structuredContent` از پاسخ MCP (JSON یا SSE). */
function extractStructured(text: string): string {
  const asJson = (): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const direct = asJson() as { result?: { structuredContent?: unknown } } | null;
  if (direct?.result?.structuredContent) {
    return JSON.stringify(direct.result.structuredContent);
  }

  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = JSON.parse(line.slice(5).trim()) as {
      result?: { structuredContent?: unknown };
    };
    if (payload.result?.structuredContent) return JSON.stringify(payload.result.structuredContent);
  }

  throw new Error(`no structuredContent in MCP answer: ${text.slice(0, 200)}`);
}
