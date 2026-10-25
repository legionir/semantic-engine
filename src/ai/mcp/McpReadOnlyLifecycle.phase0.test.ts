/**
 * Phase 0 — read-only enforcement and lifecycle on the *real* MCP path.
 *
 * The other MCP suites use hand-built indexes. This one drives the shipped
 * three-step path end to end:
 *
 *   `runIndex` (CLI, real artifact + manifest + generation)
 *     → `SemanticEngineMcpServer` over an in-memory transport
 *     → `tools/list`, `tools/call`, `close`, and a second server on the same
 *       artifact (a restart, as another process would see it).
 *
 * What is asserted, and why it is not a tautology:
 *
 *   - **read-only**: a recursive digest of the workspace *and* the artifact
 *     directory is taken before and after every tool call. A tool that wrote
 *     anything — a cache file, a rewritten index, a stray temp file — changes
 *     the digest. `simulate_mutation` is called on purpose: its name says
 *     "mutation" and its contract says it writes nothing, so it is the tool
 *     most worth measuring rather than trusting.
 *   - **lifecycle**: after `close()`, a fresh server built from the same
 *     artifact answers the same query with the same content, and its
 *     `indexGeneration` comes from the manifest rather than from memory.
 *   - **no writes on reload**: `reload()` swaps the in-memory snapshot; the
 *     artifact bytes must not move.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemanticEngineMcpServer } from './SemanticEngineMcpServer';
import { ProjectIndex } from '../../core/types/project-index.types';
import { parseArgs } from '../../cli/args';
import { runIndex } from '../../cli/commands/index-command';
import { createLoggerFromEnv } from '../../host/Logger';
import { MANIFEST_FILE_NAME } from '../../pipeline/OutputWriter';
import { parseIndexGeneration } from '../../core/config/indexGeneration';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Minimal in-memory transport pair, the same shape the MCP suite uses. */
class InMemoryTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  peer?: InMemoryTransport;

  async start(): Promise<void> {
    /* nothing to open */
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.peer?.onmessage?.(message);
  }
}

interface Client {
  request(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

/**
 * Drives the server over the real JSON-RPC protocol rather than a test-only
 * shortcut, so `tools/list` and `tools/call` are exercised as a client sees
 * them.
 */
async function openClient(server: SemanticEngineMcpServer): Promise<Client> {
  const serverSide = new InMemoryTransport();
  const clientSide = new InMemoryTransport();
  serverSide.peer = clientSide;
  clientSide.peer = serverSide;

  const waiters = new Map<number, (message: any) => void>();
  clientSide.onmessage = message => {
    if (message && typeof message === 'object' && 'id' in message) {
      const waiter = waiters.get((message as { id: number }).id);
      if (waiter) {
        waiters.delete((message as { id: number }).id);
        waiter(message);
      }
    }
  };

  await server.connectTransport(serverSide);
  await clientSide.start();

  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = nextId++;
    const answer = new Promise<any>(resolve => waiters.set(id, resolve));
    void clientSide.send({ jsonrpc: '2.0', id, method, params } as unknown as JSONRPCMessage);
    return answer;
  };

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'phase0-test', version: '1.0.0' },
  });

  return { request, close: () => server.close() };
}

let base: string;
let workspace: string;
let dataDir: string;
let artifactRoot: string;
let indexPath: string;

async function indexOnce(): Promise<void> {
  const result = await runIndex(
    parseArgs(['index', '--root', workspace, '--no-git', '--data-dir', dataDir, '--project-id', 'prj-app-12345678']),
    { cwd: workspace, logger: createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true }) }
  );
  if (result.code !== 0) throw new Error(`index failed: ${result.error ?? result.code}`);
}

function loadIndex(): ProjectIndex {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex;
}

/** Recursive content digest of a tree: paths and bytes, nothing else. */
function treeDigest(root: string): string {
  const hash = crypto.createHash('sha256');
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = path.join(directory, entry.name);
      hash.update(path.relative(root, absolute));
      if (entry.isDirectory()) walk(absolute);
      else hash.update(fs.readFileSync(absolute));
    }
  };
  walk(root);
  return hash.digest('hex');
}

function digestOfEverything(): { workspace: string; artifacts: string } {
  return { workspace: treeDigest(workspace), artifacts: treeDigest(artifactRoot) };
}

function serverOn(projectIndex: ProjectIndex): SemanticEngineMcpServer {
  return new SemanticEngineMcpServer({
    projectIndex,
    workspaceRoot: workspace,
    projectId: 'prj-app-12345678',
    indexPath,
  });
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-mcp-phase0-')));
  workspace = path.join(base, 'workspace');
  dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
  fs.writeFileSync(
    path.join(workspace, 'src', 'b.ts'),
    "import { alpha } from './a';\nexport function beta(): number { return alpha(); }\n"
  );
  artifactRoot = path.join(dataDir, 'projects', 'prj-app-12345678');
  indexPath = path.join(artifactRoot, 'project-index.json');

  await indexOnce();
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('Phase 0 — MCP tool lifecycle on a real artifact', () => {
  test('the index is published with a manifest and a generation', () => {
    expect(fs.existsSync(indexPath)).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, MANIFEST_FILE_NAME), 'utf8')
    ) as Record<string, unknown>;
    expect(parseIndexGeneration(manifest)).toBe(1);
  });

  test('tools/list exposes the registry and no tool writes to disk when called', async () => {
    const server = serverOn(loadIndex());
    const client = await openClient(server);
    const before = digestOfEverything();

    const listResponse = await client.request('tools/list', {});
    const listed = listResponse.result.tools as Array<{ name: string; description: string }>;
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.map(tool => tool.name)).toContain('find_symbol');
    for (const tool of listed) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(typeof tool.description).toBe('string');
    }

    const calls: Array<[string, Record<string, unknown>]> = [
      ['find_symbol', { name: 'alpha' }],
      /* The schemas are the shipped ones: `path` for a file summary, and
         `id` + `direction` for dependencies. */
      ['get_file_summary', { path: 'src/a.ts' }],
      ['get_dependencies', { id: 'src/b.ts', direction: 'forward' }],
    ];
    if (listed.some(tool => tool.name === 'simulate_mutation')) {
      const alpha = loadIndex().symbols.find(symbol => symbol.name === 'alpha');
      calls.push([
        'simulate_mutation',
        { actionType: 'rename_symbol', targetSymbolId: alpha?.id, newName: 'alphaRenamed' },
      ]);
    }

    for (const [name, args] of calls) {
      const response = await client.request('tools/call', { name, arguments: args });
      const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text) as { success: boolean };
      expect(parsed.success).toBe(true);
    }

    /* Nothing anywhere changed: not the workspace, not the artifact set. */
    expect(digestOfEverything()).toEqual(before);
    await client.close();
  });

  test('a restart on the same artifact answers identically and re-reads the generation', async () => {
    const first = serverOn(loadIndex());
    expect(first.indexGeneration).toBe(1);
    const firstAnswer = await first.callTool('find_symbol', { name: 'alpha' });
    await first.close();

    /* A second publish, then a fresh server — what a restarted client sees. */
    await indexOnce();
    const second = serverOn(loadIndex());

    expect(second.indexGeneration).toBe(2);
    const secondAnswer = await second.callTool('find_symbol', { name: 'alpha' });
    expect(JSON.parse((secondAnswer.content[0] as { text: string }).text)).toEqual(
      JSON.parse((firstAnswer.content[0] as { text: string }).text)
    );
    await second.close();
  });

  test('reload swaps the snapshot without touching the artifact', async () => {
    const server = serverOn(loadIndex());
    const before = digestOfEverything();

    server.reload(loadIndex());
    await server.callTool('find_symbol', { name: 'beta' });

    expect(digestOfEverything()).toEqual(before);
    await server.close();
  });

  test('an unknown tool is answered as an error, not by creating anything', async () => {
    const server = serverOn(loadIndex());
    const before = digestOfEverything();

    const client = await openClient(server);
    const response = await client.request('tools/call', { name: 'edit_apply', arguments: { path: 'src/a.ts' } });
    const result = response.result as { isError?: boolean } | undefined;
    expect(result === undefined || result.isError === true).toBe(true);
    expect(digestOfEverything()).toEqual(before);
    await client.close();
  });
});
