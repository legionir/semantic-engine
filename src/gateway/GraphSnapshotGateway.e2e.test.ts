/**
 * Persisted graph-snapshot lifecycle through the real Gateway — D-0021
 * criterion 7 at GATEWAY VERIFIED evidence level.
 *
 * One project, one real worker process (the built CLI), one public port.
 * The scenarios are the same ones executed against the direct MCP server in
 * `src/ai/mcp/GraphSnapshotMcp.test.ts`; here they run over
 * `POST /mcp/:projectId` through the Gateway proxy, across a real worker
 * process restart:
 *
 *   - tools/call `symbol_references` publishes a snapshot and returns a handle;
 *   - after the worker process is restarted, the persisted snapshot is reused
 *     (`snapshotReused: true`) and the durable handle resolves identically;
 *   - a handle whose generation has been cleaned up fails closed
 *     (`SNAPSHOT_STALE_HANDLE`) — the cache cannot mask it, and the Gateway
 *     never falls back to a rebuild behind the caller's back.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { GatewayServer } from './GatewayServer';
import { GraphSnapshotStore } from '../core/codeintel/GraphSnapshotStore';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

interface RpcReply {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

function rpc(port: number, urlPath: string, body: Record<string, unknown>, token?: string): Promise<RpcReply> {
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
          resolve({ status: res.statusCode ?? 0, json: parseMaybeSse(text), text });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseMaybeSse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { return null; }
  }
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.slice(5).trim()) as Record<string, unknown>; } catch { /* next frame */ }
    }
  }
  return null;
}

function toolPayload(reply: RpcReply): { isError?: boolean; structuredContent?: Record<string, unknown> } {
  return (reply.json?.['result'] ?? {}) as { isError?: boolean; structuredContent?: Record<string, unknown> };
}

/** Tool metadata (`snapshotHandle`, `snapshotReused`, …) lives under structuredContent.metadata. */
function toolMeta(payload: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  return (payload.structuredContent?.['metadata'] as Record<string, unknown> | undefined) ?? {};
}

describeIfBuilt('Phase 3 persisted snapshot lifecycle through the Gateway (D-0021)', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;
  let projectId: string;
  let projectRoot: string;

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-graph-store-gateway-')));
    projectRoot = path.join(base, 'app');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    fs.writeFileSync(path.join(projectRoot, 'src', 'use.ts'), "import { add } from './math';\nexport const total = add(1, 2);\n");

    // Workers inherit the gateway process env: opt the experimental Phase 3
    // tools in for this worker (same allowlist as the standalone MCP CLI).
    process.env['SEMANTIC_ENGINE_EXPERIMENTAL'] = 'semantic-graph';

    gateway = new GatewayServer({ dataRoot: path.join(base, 'data'), port: 0, host: '127.0.0.1', token: 'graph-store-gateway-token' });
    const info = await gateway.start();
    port = info.port;
    token = info.token;

    const registered = gateway.registry.register({ rootPath: projectRoot });
    projectId = registered.id;
    await gateway.supervisor.start(gateway.configForProject(registered.id, registered.rootPath, registered.name));
  }, 300_000);

  afterAll(async () => {
    delete process.env['SEMANTIC_ENGINE_EXPERIMENTAL'];
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('publishes a snapshot over tools/call and returns a durable handle', async () => {
    const reply = await rpc(port, `/mcp/${projectId}`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'symbol_references', arguments: { name: 'add' } },
    }, token);
    expect(reply.status).toBe(200);
    const result = toolPayload(reply);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    expect(structured?.['success']).toBe(true);
    const meta = toolMeta(result);
    expect(meta['snapshotReused']).toBe(false);
    const handle = meta['snapshotHandle'] as string;
    expect(handle).toMatch(/^gen-000001@[0-9a-f]{12}$/u);
  }, 120_000);

  it('reuses the persisted snapshot and resolves the durable handle after a real worker restart', async () => {
    const first = toolPayload(await rpc(port, `/mcp/${projectId}`, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'symbol_references', arguments: { name: 'add' } },
    }, token));
    const handle = toolMeta(first)['snapshotHandle'] as string;
    const items = first.structuredContent?.['items'];
    expect(handle).toMatch(/^gen-000\d+@[0-9a-f]{12}$/u);

    // Real process restart of the worker: the store on disk survives.
    await gateway.supervisor.restart(projectId);

    const reused = toolPayload(await rpc(port, `/mcp/${projectId}`, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'symbol_references', arguments: { name: 'add' } },
    }, token));
    expect(reused.structuredContent?.['success']).toBe(true);
    expect(toolMeta(reused)['snapshotReused']).toBe(true);
    expect(toolMeta(reused)['snapshotHandle']).toBe(handle);
    expect(reused.structuredContent?.['items']).toEqual(items);

    const byHandle = toolPayload(await rpc(port, `/mcp/${projectId}`, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'symbol_references', arguments: { name: 'add', snapshotHandle: handle } },
    }, token));
    expect(byHandle.structuredContent?.['success']).toBe(true);
    expect(byHandle.structuredContent?.['items']).toEqual(items);
  }, 180_000);

  it('fails closed on a stale handle — no rebuild fallback, no cache masking, through the Gateway', async () => {
    const current = toolPayload(await rpc(port, `/mcp/${projectId}`, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'symbol_references', arguments: { name: 'add' } },
    }, token));
    const handle = toolMeta(current)['snapshotHandle'] as string;

    // Publish a new generation directly on disk and keep only it.
    const storeDir = path.join(projectRoot, '.semantic-engine', 'graph-snapshots');
    const store = new GraphSnapshotStore(storeDir);
    const snapshot = await store.current();
    expect(snapshot).not.toBeNull();
    await store.publish(snapshot!.graph, `manual-${Date.now()}`, '0.1.0', { keep: 1 });
    expect((await store.listGenerations()).includes(1)).toBe(false);

    const stale = toolPayload(await rpc(port, `/mcp/${projectId}`, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'symbol_references', arguments: { name: 'add', snapshotHandle: handle } },
    }, token));
    expect(stale.structuredContent?.['success']).toBe(false);
    expect(String(stale.structuredContent?.['error'])).toContain('SNAPSHOT_STALE_HANDLE');
  }, 120_000);
});
